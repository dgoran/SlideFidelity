import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { entitlementState, verifyEntitlementToken, type EntitlementClaims } from "../src/entitlement";
import { DAY, b64urlEncode, decodeJwtPayload, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

async function publicKey(h: ReturnType<typeof makeHarness>): Promise<{ kid: string; x: string }> {
  const res = await h.request("/.well-known/entitlement-keys");
  expect(res.status).toBe(200);
  const body = await res.json<{ keys: { kid: string; kty: string; crv: string; alg: string; x: string }[] }>();
  expect(body.keys).toHaveLength(1);
  const key = body.keys[0]!;
  expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: env.ENTITLEMENT_KID });
  expect(JSON.stringify(body)).not.toContain('"d"');
  return key;
}

describe("GET /entitlement", () => {
  it("returns a signed trial token for a new account that verifies with the published key", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("ent@example.com");
    const res = await h.request("/entitlement", { token });
    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; plan: string; exp: number; grace_until: number; trial_ends_at: number }>();
    expect(body.plan).toBe("trial");

    const key = await publicKey(h);
    const claims = await verifyEntitlementToken(body.token, key.x);
    expect(claims).not.toBeNull();
    expect(claims).toMatchObject<Partial<EntitlementClaims>>({
      sub: accountId,
      plan: "trial",
      kid: env.ENTITLEMENT_KID,
      exp: Math.floor((h.clock.t + DAY) / 1000),
      grace_until: Math.floor((h.clock.t + 7 * DAY) / 1000),
    });
    const header = JSON.parse(atob(body.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, string>;
    expect(header).toMatchObject({ alg: "EdDSA", kid: env.ENTITLEMENT_KID });
  });

  it("caps trial exp and grace at trial_ends_at", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("cap@example.com");
    const trialEnd = h.clock.t + 30 * DAY;
    h.clock.advance(29.5 * DAY);
    const body = await (await h.request("/entitlement", { token })).json<{ token: string }>();
    const claims = decodeJwtPayload<EntitlementClaims>(body.token);
    expect(claims.plan).toBe("trial");
    expect(claims.exp).toBe(Math.floor(trialEnd / 1000));
    expect(claims.grace_until).toBe(Math.floor(trialEnd / 1000));
  });

  it("returns free after the trial ends", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("expired@example.com");
    h.clock.advance(29 * DAY);
    const s2 = await h.signIn("expired@example.com"); // fresh session so the 30-day session limit is not hit
    h.clock.advance(2 * DAY);
    void token;
    const body = await (await h.request("/entitlement", { token: s2.token })).json<{ plan: string; token: string }>();
    expect(body.plan).toBe("free");
    expect(decodeJwtPayload<EntitlementClaims>(body.token).plan).toBe("free");
  });

  it("a tampered payload or foreign key fails verification", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("tamper@example.com");
    h.clock.advance(31 * DAY - 1);
    const s = await h.signIn("tamper@example.com");
    h.clock.advance(2);
    const body = await (await h.request("/entitlement", { token: s.token })).json<{ token: string }>();
    void token;
    const key = await publicKey(h);
    expect(await verifyEntitlementToken(body.token, key.x)).not.toBeNull();

    const [head, payload, sig] = body.token.split(".") as [string, string, string];
    const claims = decodeJwtPayload<EntitlementClaims>(body.token);
    const forged = `${head}.${b64urlEncode(JSON.stringify({ ...claims, plan: "pro" }))}.${sig}`;
    expect(await verifyEntitlementToken(forged, key.x)).toBeNull();
    expect(await verifyEntitlementToken(`${head}.${payload}.${sig.slice(0, -2)}AA`, key.x)).toBeNull();

    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const otherJwk = (await crypto.subtle.exportKey("jwk", other.publicKey)) as JsonWebKey;
    expect(await verifyEntitlementToken(body.token, otherJwk.x!)).toBeNull();
  });

  it("classifies a verified token as fresh, grace, or expired by time", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("exp@example.com");
    const body = await (await h.request("/entitlement", { token })).json<{ token: string }>();
    const key = await publicKey(h);
    const claims = (await verifyEntitlementToken(body.token, key.x))!;
    expect(entitlementState(claims, h.clock.t)).toBe("fresh");
    expect(entitlementState(claims, h.clock.t + DAY + 1000)).toBe("grace");
    expect(entitlementState(claims, h.clock.t + 7 * DAY + 1000)).toBe("expired");
  });
});
