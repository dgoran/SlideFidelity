/**
 * Entitlement token verification and state (KTD7, R21), WebCrypto only.
 *
 * Mirrors `verifyEntitlementToken` / `entitlementState` in apps/license-api/src/entitlement.ts:
 * compact JWS, header `{alg:"EdDSA", kid}`, Ed25519 signature over `header.payload`, payload
 * `{sub, plan, iat, exp, grace_until, kid, trial_ends_at?}` in epoch seconds. Differences: several
 * embedded keys are accepted (rotation), `iat` is checked, and an unknown `kid` is reported
 * separately from an invalid token so the caller can keep the session through a key rotation.
 */
import type { EntitlementPublicKey } from "./config";

export type EntitlementPlan = "free" | "trial" | "pro";

export interface EntitlementClaims {
  sub: string;
  plan: EntitlementPlan;
  iat: number;
  exp: number;
  grace_until: number;
  kid: string;
  trial_ends_at?: number;
}

export type VerifyResult = { ok: true; claims: EntitlementClaims } | { ok: false; reason: "invalid" | "unknown-kid" };

/** Same values as gate.ts `Plan` (U10); kept local so this module does not depend on the React gate. */
export type LicensePlan = "anonymous" | "free" | "trial" | "pro" | "expired";

export type EntitlementPhase = "fresh" | "grace" | "expired";

export interface DerivedEntitlement {
  phase: EntitlementPhase;
  /** Gate plan: the token's plan while fresh or in grace; `expired` for a lapsed paid/trial token. */
  plan: LicensePlan;
  /** The plan the token was issued for. */
  entitledPlan: EntitlementPlan;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms: when offline Pro lapses. */
  graceUntil: number;
  /** Epoch ms, present on trial tokens. */
  trialEndsAt?: number;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeJson(segment: string): unknown {
  const bytes = b64urlDecode(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Verifies signature, kid, and claim shapes. Time checks are `entitlementPhase`'s job. */
export async function verifyEntitlementToken(token: string, keys: readonly EntitlementPublicKey[]): Promise<VerifyResult> {
  const invalid: VerifyResult = { ok: false, reason: "invalid" };
  if (typeof token !== "string") return invalid;
  const parts = token.split(".");
  if (parts.length !== 3) return invalid;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h) as { alg?: unknown; kid?: unknown } | null;
  if (!header || typeof header !== "object" || header.alg !== "EdDSA" || typeof header.kid !== "string") return invalid;
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown-kid" };
  const raw = b64urlDecode(key.x);
  const sig = b64urlDecode(s);
  if (!raw || raw.byteLength !== 32 || !sig || sig.byteLength !== 64) return invalid;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(`${h}.${p}`);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, new Uint8Array(data)))) return invalid;
  } catch {
    return invalid;
  }
  const c = decodeJson(p) as Partial<EntitlementClaims> | null;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.sub !== "string" ||
    c.sub.length === 0 ||
    (c.plan !== "free" && c.plan !== "trial" && c.plan !== "pro") ||
    !isNum(c.iat) ||
    !isNum(c.exp) ||
    !isNum(c.grace_until) ||
    typeof c.kid !== "string" ||
    c.kid !== header.kid ||
    (c.trial_ends_at !== undefined && !isNum(c.trial_ends_at))
  ) {
    return invalid;
  }
  const claims: EntitlementClaims = {
    sub: c.sub,
    plan: c.plan,
    iat: c.iat,
    exp: c.exp,
    grace_until: c.grace_until,
    kid: c.kid,
    ...(c.trial_ends_at !== undefined ? { trial_ends_at: c.trial_ends_at } : {}),
  };
  return { ok: true, claims };
}

/** fresh: before exp. grace: offline allowance until grace_until (R21). expired: fall back. */
export function entitlementPhase(claims: EntitlementClaims, nowMs: number): EntitlementPhase {
  const now = nowMs / 1000;
  if (now < claims.exp) return "fresh";
  if (now < claims.grace_until) return "grace";
  return "expired";
}

export function deriveEntitlement(claims: EntitlementClaims, nowMs: number): DerivedEntitlement {
  const phase = entitlementPhase(claims, nowMs);
  const lapsedPaid = phase === "expired" && claims.plan !== "free";
  return {
    phase,
    plan: phase === "expired" ? (lapsedPaid ? "expired" : "free") : claims.plan,
    entitledPlan: claims.plan,
    expiresAt: claims.exp * 1000,
    graceUntil: claims.grace_until * 1000,
    ...(claims.trial_ends_at !== undefined ? { trialEndsAt: claims.trial_ends_at * 1000 } : {}),
  };
}
