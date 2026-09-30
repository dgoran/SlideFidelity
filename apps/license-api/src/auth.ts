import type { Context, MiddlewareHandler } from "hono";
import {
  consumeOtp,
  createSession,
  getAccountByEmail,
  getLiveSessionAccount,
  getOrCreateAccount,
  incrementOtpAttempts,
  latestOtp,
  replaceOtp,
  revokeSession,
} from "./db";
import { EmailNotConfiguredError, signInCodeEmail } from "./email";
import type { AppBindings, HonoEnv } from "./env";
import { LIMITS, hashedKey } from "./ratelimit";
import { b64urlDecode, b64urlEncode, decodeJsonSegment, hmacSha256, sha256Hex, timingSafeEqual, utf8 } from "./util";

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_MS = 30_000;
export const SESSION_TTL_MS = 30 * 86_400_000;

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const LOCAL_RE = /^[a-z0-9!#$%&'*/=?^_`{|}~.-]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Canonical form used for account lookup/creation: trimmed, lowercased, `+tag` removed, and dots
 * removed for Gmail. Returns null for anything that is not a plausible address.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s.length > 254) return null;
  const parts = s.split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1]!;
  let local = parts[0]!;
  if (!DOMAIN_RE.test(domain)) return null;
  local = local.split("+")[0] ?? "";
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  if (!local || local.length > 64 || !LOCAL_RE.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return `${local}@${domain}`;
}

export function isReviewerEmail(email: string, env: Pick<AppBindings, "REVIEWER_EMAIL" | "REVIEWER_CODE">): boolean {
  if (!env.REVIEWER_CODE || !env.REVIEWER_EMAIL) return false;
  return normalizeEmail(env.REVIEWER_EMAIL) === email;
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function generateCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0]!;
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
  }
}

function hashCode(env: AppBindings, email: string, code: string): Promise<string> {
  return sha256Hex(`${env.SESSION_SECRET}:otp:${email}:${code}`);
}

// --- session JWT (HS256) ---

interface SessionClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

export async function signSession(secret: string, claims: SessionClaims): Promise<string> {
  const input = `${b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64urlEncode(JSON.stringify(claims))}`;
  return `${input}.${b64urlEncode(await hmacSha256(secret, input))}`;
}

export async function verifySessionJwt(secret: string, token: string, now: number): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonSegment(h) as { alg?: unknown } | null;
  if (header?.alg !== "HS256") return null;
  const sig = b64urlDecode(s);
  if (!sig || !timingSafeEqual(sig, await hmacSha256(secret, `${h}.${p}`))) return null;
  const c = decodeJsonSegment(p) as Partial<SessionClaims> | null;
  if (!c || typeof c.sub !== "string" || typeof c.sid !== "string" || typeof c.exp !== "number") return null;
  if (c.exp * 1000 <= now) return null;
  return c as SessionClaims;
}

export const requireSession: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const now = c.var.deps.now();
  const claims = token ? await verifySessionJwt(c.env.SESSION_SECRET, token, now) : null;
  const account = claims ? await getLiveSessionAccount(c.env.DB, claims.sid, claims.sub, now) : null;
  if (!claims || !account) return c.json({ error: "unauthorized" }, 401);
  c.set("account", account);
  c.set("sessionId", claims.sid);
  return next();
};

// --- helpers ---

export function clientIp(c: Context<HonoEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

export async function readJson(c: Context<HonoEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tooMany(c: Context<HonoEnv>, retryAfterMs: number, error = "rate_limited") {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  c.header("Retry-After", String(seconds));
  return c.json({ error, retry_after_seconds: seconds }, 429);
}

async function limit(c: Context<HonoEnv>, scope: string, id: string, rule: { limit: number; windowMs: number }) {
  const { limiter, now } = c.var.deps;
  return limiter.consume(await hashedKey(scope, id), rule.limit, rule.windowMs, now());
}

// --- handlers ---

export async function handleStart(c: Context<HonoEnv>) {
  const body = await readJson(c);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);
  const { deps } = c.var;
  const now = deps.now();
  const ip = clientIp(c);

  const perIp = await limit(c, "auth_start_ip", ip, LIMITS.authStartPerIp);
  if (!perIp.allowed) return tooMany(c, perIp.retryAfterMs);

  const ok = { ok: true, resend_after_seconds: OTP_RESEND_MS / 1000, expires_in_seconds: OTP_TTL_MS / 1000 };
  // AppSource reviewer: static code from a secret, no email, no OTP row.
  if (isReviewerEmail(email, c.env)) return c.json(ok);

  const perEmail = await limit(c, "auth_start_email", email, LIMITS.authStartPerEmail);
  if (!perEmail.allowed) return tooMany(c, perEmail.retryAfterMs);

  const previous = await latestOtp(c.env.DB, email);
  if (previous && now - previous.created_at < OTP_RESEND_MS) {
    return tooMany(c, previous.created_at + OTP_RESEND_MS - now, "resend_too_soon");
  }

  if (!(await getAccountByEmail(c.env.DB, email))) {
    const signups = await limit(c, "new_account_ip", ip, LIMITS.newAccountPerIp);
    if (!signups.allowed) return tooMany(c, signups.retryAfterMs, "too_many_signups");
  }

  const code = generateCode();
  await replaceOtp(c.env.DB, email, await hashCode(c.env, email, code), now, OTP_TTL_MS);
  try {
    await deps.email.send(signInCodeEmail(email, code));
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();
    console.error("sign-in email failed", err instanceof EmailNotConfiguredError ? "not configured" : "send error");
    return c.json({ error: "email_unavailable" }, 503);
  }
  return c.json(ok);
}

export async function handleVerify(c: Context<HonoEnv>) {
  const { deps } = c.var;
  const now = deps.now();
  const perIp = await limit(c, "auth_verify_ip", clientIp(c), LIMITS.authVerifyPerIp);
  if (!perIp.allowed) return tooMany(c, perIp.retryAfterMs);

  const body = await readJson(c);
  const email = normalizeEmail(body?.email);
  const code = body?.code;
  if (!email) return c.json({ error: "invalid_email" }, 400);
  if (typeof code !== "string" || code.length === 0 || code.length > 128) return c.json({ error: "invalid_code" }, 400);

  if (isReviewerEmail(email, c.env)) {
    const match = timingSafeEqual(utf8(await sha256Hex(code)), utf8(await sha256Hex(c.env.REVIEWER_CODE)));
    if (!match) return c.json({ error: "invalid_code" }, 400);
    return issueSession(c, email, now);
  }

  if (!/^\d{6}$/.test(code)) return c.json({ error: "invalid_code" }, 400);
  const otp = await latestOtp(c.env.DB, email);
  if (!otp) return c.json({ error: "invalid_code" }, 400);
  if (otp.expires_at <= now) return c.json({ error: "code_expired" }, 400);
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: "code_locked" }, 400);

  if (!timingSafeEqual(otp.code_hash, await hashCode(c.env, email, code))) {
    const attempts = await incrementOtpAttempts(c.env.DB, otp.id);
    return c.json({ error: attempts >= OTP_MAX_ATTEMPTS ? "code_locked" : "invalid_code" }, 400);
  }
  if (!(await consumeOtp(c.env.DB, otp.id))) return c.json({ error: "invalid_code" }, 400);
  return issueSession(c, email, now);
}

async function issueSession(c: Context<HonoEnv>, email: string, now: number) {
  const account = await getOrCreateAccount(c.env.DB, email, now);
  const session = await createSession(c.env.DB, account.id, now, SESSION_TTL_MS);
  const token = await signSession(c.env.SESSION_SECRET, {
    sub: account.id,
    sid: session.id,
    iat: Math.floor(now / 1000),
    exp: Math.floor(session.expires_at / 1000),
  });
  return c.json({
    session_token: token,
    expires_at: session.expires_at,
    account: { id: account.id, email: account.email, trial_ends_at: account.trial_ends_at },
  });
}

export async function handleSignout(c: Context<HonoEnv>) {
  await revokeSession(c.env.DB, c.var.sessionId, c.var.deps.now());
  return c.json({ ok: true });
}
