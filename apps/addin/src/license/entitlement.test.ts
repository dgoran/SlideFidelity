import { beforeAll, describe, expect, it } from "vitest";
import type { EntitlementPublicKey } from "./config";
import { deriveEntitlement, entitlementPhase, verifyEntitlementToken, type EntitlementClaims } from "./entitlement";

// --- test signing helpers (mirror apps/license-api signEntitlement) ---

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKey(kid: string): Promise<{ pub: EntitlementPublicKey; priv: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pub: { kid, x: b64url(raw) }, priv: pair.privateKey };
}

async function sign(priv: CryptoKey, claims: object, header: object = { alg: "EdDSA", typ: "JWT", kid: (claims as { kid: string }).kid }) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

const NOW = Date.UTC(2026, 8, 30, 12);
const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

function claims(over: Partial<EntitlementClaims> = {}): EntitlementClaims {
  return { sub: "acct_1", plan: "pro", iat: S(NOW), exp: S(NOW + DAY), grace_until: S(NOW + 7 * DAY), kid: "k1", ...over };
}

let k1: Awaited<ReturnType<typeof makeKey>>;
let k2: Awaited<ReturnType<typeof makeKey>>;

beforeAll(async () => {
  k1 = await makeKey("k1");
  k2 = await makeKey("k2");
});

describe("verifyEntitlementToken", () => {
  it("accepts a token signed by a known key", async () => {
    const token = await sign(k1.priv, claims());
    const r = await verifyEntitlementToken(token, [k1.pub]);
    expect(r).toEqual({ ok: true, claims: claims() });
  });

  it("accepts a token from any embedded key (rotation)", async () => {
    const token = await sign(k2.priv, claims({ kid: "k2" }));
    const r = await verifyEntitlementToken(token, [k1.pub, k2.pub]);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown kid", async () => {
    const token = await sign(k2.priv, claims({ kid: "k2" }));
    expect(await verifyEntitlementToken(token, [k1.pub])).toEqual({ ok: false, reason: "unknown-kid" });
  });

  it("rejects a tampered payload (plan upgraded locally)", async () => {
    const token = await sign(k1.priv, claims({ plan: "free" }));
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify(claims({ plan: "pro" })))}.${s}`;
    expect(await verifyEntitlementToken(forged, [k1.pub])).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token signed by the wrong key under a known kid", async () => {
    const token = await sign(k2.priv, claims());
    expect((await verifyEntitlementToken(token, [k1.pub])).ok).toBe(false);
  });

  it("rejects a non-EdDSA header", async () => {
    const token = await sign(k1.priv, claims(), { alg: "HS256", kid: "k1" });
    expect((await verifyEntitlementToken(token, [k1.pub])).ok).toBe(false);
  });

  it("rejects a header/payload kid mismatch", async () => {
    const token = await sign(k1.priv, claims({ kid: "k2" }), { alg: "EdDSA", kid: "k1" });
    expect((await verifyEntitlementToken(token, [k1.pub, k2.pub])).ok).toBe(false);
  });

  it.each([
    ["bad plan", { plan: "enterprise" }],
    ["missing exp", { exp: undefined }],
    ["string grace", { grace_until: "soon" }],
    ["missing sub", { sub: undefined }],
    ["bad trial_ends_at", { trial_ends_at: "x" }],
  ])("rejects bad claim shapes: %s", async (_label, over) => {
    const token = await sign(k1.priv, { ...claims(), ...over });
    expect((await verifyEntitlementToken(token, [k1.pub])).ok).toBe(false);
  });

  it.each(["", "a.b", "a.b.c.d", "!!.??.**", "e30.e30.AAAA"])("rejects malformed input %j", async (t) => {
    expect((await verifyEntitlementToken(t, [k1.pub])).ok).toBe(false);
  });

  it("rejects everything when the embedded key is still a placeholder", async () => {
    const token = await sign(k1.priv, claims());
    const r = await verifyEntitlementToken(token, [{ kid: "k1", x: "REPLACE_WITH_BASE64URL_ED25519_PUBLIC_KEY_X" }]);
    expect(r.ok).toBe(false);
  });
});

describe("entitlementPhase / deriveEntitlement", () => {
  it("fresh before exp keeps the plan", () => {
    const c = claims();
    expect(entitlementPhase(c, NOW)).toBe("fresh");
    expect(deriveEntitlement(c, NOW)).toMatchObject({ phase: "fresh", plan: "pro", graceUntil: (NOW + 7 * DAY) });
  });

  it("grace between exp and grace_until keeps the plan and exposes the lapse date", () => {
    const c = claims();
    const at = NOW + 2 * DAY;
    expect(deriveEntitlement(c, at)).toEqual({
      phase: "grace",
      plan: "pro",
      entitledPlan: "pro",
      expiresAt: NOW + DAY,
      graceUntil: NOW + 7 * DAY,
    });
  });

  it("exactly at exp is grace, exactly at grace_until is expired", () => {
    const c = claims();
    expect(entitlementPhase(c, NOW + DAY)).toBe("grace");
    expect(entitlementPhase(c, NOW + 7 * DAY)).toBe("expired");
  });

  it("an expired paid token becomes 'expired' (manage subscription)", () => {
    expect(deriveEntitlement(claims(), NOW + 8 * DAY).plan).toBe("expired");
    expect(deriveEntitlement(claims({ plan: "trial" }), NOW + 8 * DAY).plan).toBe("expired");
  });

  it("an expired free token stays 'free'", () => {
    expect(deriveEntitlement(claims({ plan: "free" }), NOW + 8 * DAY).plan).toBe("free");
  });

  it("exposes trial_ends_at in milliseconds", () => {
    const d = deriveEntitlement(claims({ plan: "trial", trial_ends_at: S(NOW + 5 * DAY) }), NOW);
    expect(d.plan).toBe("trial");
    expect(d.trialEndsAt).toBe(NOW + 5 * DAY);
  });
});
