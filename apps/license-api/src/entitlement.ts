/**
 * Ed25519-signed entitlement tokens (KTD7, R21).
 *
 * Format: compact JWS (JWT), `b64url(header).b64url(payload).b64url(signature)`.
 *   header  = { alg: "EdDSA", typ: "JWT", kid }
 *   payload = { sub, plan, iat, exp, grace_until, kid, trial_ends_at? }  (times in epoch SECONDS)
 * The signature is Ed25519 over the ASCII bytes of `header.payload`.
 *
 * The add-in embeds the public key as the base64url raw 32-byte key (the JWK `x` value) published at
 * GET /.well-known/entitlement-keys, and verifies with WebCrypto:
 *   importKey("raw", b64urlDecode(x), { name: "Ed25519" }, false, ["verify"]).
 * `verifyEntitlementToken` + `entitlementState` below are the reference implementation.
 */
import type { Context } from "hono";
import { isReviewerEmail } from "./auth";
import { listSubscriptions, type Account, type Subscription } from "./db";
import type { AppBindings, HonoEnv } from "./env";
import { b64urlDecode, b64urlEncode, decodeJsonSegment, utf8 } from "./util";

export type Plan = "free" | "trial" | "pro";

export interface EntitlementClaims {
  sub: string;
  plan: Plan;
  iat: number;
  exp: number;
  grace_until: number;
  kid: string;
  trial_ends_at?: number;
}

export const TOKEN_TTL_MS = 86_400_000;
export const GRACE_MS = 7 * 86_400_000;

const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Plan for an account at `now`, plus the instant the plan lapses (null = open-ended). */
export function computePlan(
  account: Account,
  subscriptions: Subscription[],
  now: number,
  env: Pick<AppBindings, "REVIEWER_EMAIL" | "REVIEWER_CODE">,
): { plan: Plan; until: number | null } {
  if (isReviewerEmail(account.email, env)) return { plan: "pro", until: null };
  let paidUntil = 0;
  for (const s of subscriptions) {
    if (PRO_STATUSES.has(s.status)) return { plan: "pro", until: null };
    // canceled/paused keep Pro until the end of the period already paid for.
    if (s.current_period_end && s.current_period_end > now) paidUntil = Math.max(paidUntil, s.current_period_end);
  }
  if (paidUntil > now) return { plan: "pro", until: paidUntil };
  if (account.trial_ends_at > now) return { plan: "trial", until: account.trial_ends_at };
  return { plan: "free", until: null };
}

export async function planFor(c: Context<HonoEnv>, account: Account): Promise<{ plan: Plan; until: number | null }> {
  return computePlan(account, await listSubscriptions(c.env.DB, account.id), c.var.deps.now(), c.env);
}

// --- keys ---

interface PrivateJwk extends JsonWebKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
}

let cachedKey: { source: string; key: Promise<CryptoKey>; jwk: PrivateJwk } | null = null;

function loadPrivateKey(env: AppBindings): { key: Promise<CryptoKey>; jwk: PrivateJwk } {
  if (cachedKey?.source !== env.ENTITLEMENT_PRIVATE_KEY) {
    const jwk = JSON.parse(env.ENTITLEMENT_PRIVATE_KEY) as PrivateJwk;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new Error("ENTITLEMENT_PRIVATE_KEY is not an Ed25519 private JWK");
    const key = crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, { name: "Ed25519" }, false, ["sign"]);
    cachedKey = { source: env.ENTITLEMENT_PRIVATE_KEY, key, jwk };
  }
  return cachedKey;
}

export function publicJwks(env: AppBindings) {
  const { jwk } = loadPrivateKey(env);
  return { keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: env.ENTITLEMENT_KID, x: jwk.x }] };
}

export async function signEntitlement(env: AppBindings, claims: EntitlementClaims): Promise<string> {
  const header = { alg: "EdDSA", typ: "JWT", kid: claims.kid };
  const input = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await loadPrivateKey(env).key, utf8(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

// --- client-side reference verification ---

/** Verifies signature and shape only. Use `entitlementState` for time checks. Returns null if invalid. */
export async function verifyEntitlementToken(token: string, publicKeyX: string): Promise<EntitlementClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonSegment(h) as { alg?: unknown; kid?: unknown } | null;
  if (header?.alg !== "EdDSA") return null;
  const raw = b64urlDecode(publicKeyX);
  const sig = b64urlDecode(s);
  if (!raw || raw.byteLength !== 32 || !sig || sig.byteLength !== 64) return null;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, sig, utf8(`${h}.${p}`)))) return null;
  } catch {
    return null;
  }
  const c = decodeJsonSegment(p) as Partial<EntitlementClaims> | null;
  if (
    !c ||
    typeof c.sub !== "string" ||
    (c.plan !== "free" && c.plan !== "trial" && c.plan !== "pro") ||
    typeof c.exp !== "number" ||
    typeof c.grace_until !== "number" ||
    typeof c.kid !== "string" ||
    c.kid !== header.kid
  ) {
    return null;
  }
  return c as EntitlementClaims;
}

/** fresh: before exp. grace: offline allowance until grace_until (R21). expired: fall back to free. */
export function entitlementState(claims: EntitlementClaims, nowMs: number): "fresh" | "grace" | "expired" {
  const now = nowMs / 1000;
  if (now < claims.exp) return "fresh";
  if (now < claims.grace_until) return "grace";
  return "expired";
}

// --- handler ---

export async function handleEntitlement(c: Context<HonoEnv>) {
  const account = c.var.account;
  const now = c.var.deps.now();
  const { plan, until } = await planFor(c, account);
  const cap = (t: number) => (until === null ? t : Math.min(t, until));
  const exp = cap(now + TOKEN_TTL_MS);
  const grace = cap(now + GRACE_MS);
  const claims: EntitlementClaims = {
    sub: account.id,
    plan,
    iat: Math.floor(now / 1000),
    exp: Math.floor(exp / 1000),
    grace_until: Math.floor(grace / 1000),
    kid: c.env.ENTITLEMENT_KID,
    ...(plan === "trial" ? { trial_ends_at: Math.floor(account.trial_ends_at / 1000) } : {}),
  };
  const token = await signEntitlement(c.env, claims);
  return c.json({ token, plan, expires_at: exp, grace_until: grace, trial_ends_at: account.trial_ends_at });
}
