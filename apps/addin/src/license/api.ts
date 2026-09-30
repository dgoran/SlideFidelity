/**
 * Typed client for the license API (apps/license-api, KTD7). Bearer session tokens only; no cookies.
 * Every failure becomes an `ApiError` with a stable `code`, so callers switch on codes, never on text.
 */

export const API_ERROR_CODES = [
  "invalid_email",
  "invalid_code",
  "code_expired",
  "code_locked",
  "resend_too_soon",
  "rate_limited",
  "too_many_signups",
  "email_unavailable",
  "unauthorized",
  "billing_cancel_failed",
  "not_found",
  "internal",
] as const;

/** Server codes plus client-side ones: `network` (no response / timeout), `bad_response` (unexpected shape), `unknown`. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | "network" | "bad_response" | "unknown";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`license api: ${code} (${status})`);
    this.name = "ApiError";
  }
}

export interface ApiAccount {
  id: string;
  email: string;
  /** Epoch milliseconds. */
  trial_ends_at: number;
}

export interface StartAuthResult {
  resendAfterSeconds: number;
  expiresInSeconds: number;
}

export interface VerifyAuthResult {
  sessionToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  account: ApiAccount;
}

export interface EntitlementResponse {
  token: string;
  plan: "free" | "trial" | "pro";
  /** Epoch milliseconds. */
  expiresAt: number;
  graceUntil: number;
  trialEndsAt: number;
}

export interface BillingLinks {
  checkoutUrl: string;
  portalUrl: string | null;
}

export interface LicenseApi {
  startAuth(email: string): Promise<StartAuthResult>;
  verifyAuth(email: string, code: string): Promise<VerifyAuthResult>;
  signOut(sessionToken: string): Promise<void>;
  getEntitlement(sessionToken: string): Promise<EntitlementResponse>;
  getBillingLinks(sessionToken: string): Promise<BillingLinks>;
  deleteAccount(sessionToken: string): Promise<void>;
}

export interface LicenseApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout; a timeout is reported as `network`. Default 15 s. */
  timeoutMs?: number;
}

const KNOWN = new Set<string>(API_ERROR_CODES);

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function retryAfter(res: Response, body: unknown): number | undefined {
  const header = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return header;
  if (isObj(body) && isNum(body.retry_after_seconds) && body.retry_after_seconds > 0) return body.retry_after_seconds;
  return undefined;
}

function parseAccount(v: unknown): ApiAccount | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.email) || !isNum(v.trial_ends_at)) return null;
  return { id: v.id, email: v.email, trial_ends_at: v.trial_ends_at };
}

export function createLicenseApi(options: LicenseApiOptions): LicenseApi {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request(method: string, path: string, init: { body?: unknown; session?: string } = {}): Promise<Json> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.session) headers.Authorization = `Bearer ${init.session}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        credentials: "omit",
      });
    } catch {
      throw new ApiError("network", 0);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const raw = isObj(body) && isStr(body.error) ? body.error : "";
      const code = (KNOWN.has(raw) ? raw : "unknown") as ApiErrorCode;
      throw new ApiError(code, res.status, res.status === 429 ? retryAfter(res, body) : undefined);
    }
    if (!isObj(body)) throw new ApiError("bad_response", res.status);
    return body;
  }

  const bad = (status = 200) => new ApiError("bad_response", status);

  return {
    async startAuth(email) {
      const b = await request("POST", "/auth/start", { body: { email } });
      if (!isNum(b.resend_after_seconds) || !isNum(b.expires_in_seconds)) throw bad();
      return { resendAfterSeconds: b.resend_after_seconds, expiresInSeconds: b.expires_in_seconds };
    },

    async verifyAuth(email, code) {
      const b = await request("POST", "/auth/verify", { body: { email, code } });
      const account = parseAccount(b.account);
      if (!isStr(b.session_token) || !isNum(b.expires_at) || !account) throw bad();
      return { sessionToken: b.session_token, expiresAt: b.expires_at, account };
    },

    async signOut(session) {
      await request("POST", "/auth/signout", { session });
    },

    async getEntitlement(session) {
      const b = await request("GET", "/entitlement", { session });
      if (
        !isStr(b.token) ||
        (b.plan !== "free" && b.plan !== "trial" && b.plan !== "pro") ||
        !isNum(b.expires_at) ||
        !isNum(b.grace_until) ||
        !isNum(b.trial_ends_at)
      ) {
        throw bad();
      }
      return { token: b.token, plan: b.plan, expiresAt: b.expires_at, graceUntil: b.grace_until, trialEndsAt: b.trial_ends_at };
    },

    async getBillingLinks(session) {
      const b = await request("GET", "/billing/links", { session });
      if (!isStr(b.checkout_url) || !(b.portal_url === null || isStr(b.portal_url))) throw bad();
      return { checkoutUrl: b.checkout_url, portalUrl: b.portal_url };
    },

    async deleteAccount(session) {
      await request("DELETE", "/account", { session });
    },
  };
}
