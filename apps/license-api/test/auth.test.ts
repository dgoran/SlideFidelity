import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OTP_MAX_ATTEMPTS, normalizeEmail } from "../src/auth";
import { DAY, count, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

describe("normalizeEmail", () => {
  it("lowercases, trims, strips +tags, and strips gmail dots", () => {
    expect(normalizeEmail("  Jane.Doe+slides@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("J.o.h.n+x@GMail.com")).toBe("john@gmail.com");
    expect(normalizeEmail("j.ohn@googlemail.com")).toBe("john@googlemail.com");
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "nobody", "a@", "@b.com", "a b@c.com", "a@b", `${"x".repeat(250)}@b.com`, "+tag@x.com"]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe("POST /auth/start + /auth/verify", () => {
  it("emails a 6-digit code and verify returns a session; new account gets a 30-day trial (R20)", async () => {
    const h = makeHarness();
    const start = await h.json("/auth/start", { email: "User@Example.com" });
    expect(start.status).toBe(200);
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]?.to).toBe("user@example.com");
    const code = h.email.lastCodeFor("user@example.com");
    expect(code).toMatch(/^\d{6}$/);

    const verify = await h.json("/auth/verify", { email: "user@example.com", code });
    expect(verify.status).toBe(200);
    const body = await verify.json<{
      session_token: string;
      expires_at: number;
      account: { id: string; email: string; trial_ends_at: number };
    }>();
    expect(body.session_token.split(".")).toHaveLength(3);
    expect(body.expires_at).toBe(h.clock.t + 30 * DAY);
    expect(body.account.email).toBe("user@example.com");
    expect(body.account.trial_ends_at).toBe(h.clock.t + 30 * DAY);
    const row = await env.DB.prepare("SELECT trial_ends_at FROM accounts WHERE id = ?")
      .bind(body.account.id)
      .first<{ trial_ends_at: number }>();
    expect(row?.trial_ends_at).toBe(h.clock.t + 30 * DAY);
    // Code is single use.
    const again = await h.json("/auth/verify", { email: "user@example.com", code });
    expect(again.status).toBe(400);
  });

  it("stores only a SHA-256 hash of the code", async () => {
    const h = makeHarness();
    await h.json("/auth/start", { email: "hash@example.com" });
    const code = h.email.lastCodeFor("hash@example.com");
    const row = await env.DB.prepare("SELECT code_hash FROM otp_codes WHERE email = ?")
      .bind("hash@example.com")
      .first<{ code_hash: string }>();
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(code);
  });

  it("an existing account keeps its original trial end", async () => {
    const h = makeHarness();
    const createdAt = h.clock.t;
    const first = await h.signIn("keep@example.com");
    h.clock.advance(5 * DAY);
    const second = await h.signIn("keep@example.com");
    expect(second.accountId).toBe(first.accountId);
    const row = await env.DB.prepare("SELECT trial_ends_at, created_at FROM accounts WHERE id = ?")
      .bind(first.accountId)
      .first<{ trial_ends_at: number; created_at: number }>();
    expect(row!.trial_ends_at - row!.created_at).toBe(30 * DAY);
    expect(row!.created_at).toBe(createdAt);
  });

  it("normalized aliases resolve to the same account", async () => {
    const h = makeHarness();
    const a = await h.signIn("John.Doe+promo@GMail.com");
    h.clock.advance(60_000);
    const b = await h.signIn("johndoe@gmail.com");
    expect(b.accountId).toBe(a.accountId);
    expect(await count("accounts")).toBe(1);
  });

  it("rejects an invalid email with 400", async () => {
    const h = makeHarness();
    const res = await h.json("/auth/start", { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(h.email.sent).toHaveLength(0);
  });

  it("locks a code after 5 wrong attempts", async () => {
    const h = makeHarness();
    await h.json("/auth/start", { email: "lock@example.com" });
    const code = h.email.lastCodeFor("lock@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await h.json("/auth/verify", { email: "lock@example.com", code: wrong });
      expect(r.status).toBe(400);
    }
    const r = await h.json("/auth/verify", { email: "lock@example.com", code });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "code_locked" });
    expect(await count("accounts")).toBe(0);
  });

  it("caps attempts atomically: 10 concurrent wrong guesses evaluate at most 5", async () => {
    const h = makeHarness();
    await h.json("/auth/start", { email: "burst@example.com" });
    const code = h.email.lastCodeFor("burst@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => h.json("/auth/verify", { email: "burst@example.com", code: wrong })),
    );
    const errors = await Promise.all(responses.map((r) => r.json<{ error: string }>().then((b) => b.error)));
    expect(responses.every((r) => r.status === 400)).toBe(true);
    // Evaluated guesses answer invalid_code (or code_locked on the 5th); everything else is refused unevaluated.
    expect(errors.filter((e) => e === "invalid_code").length).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS - 1);
    expect(errors.filter((e) => e === "code_locked").length).toBeGreaterThanOrEqual(10 - OTP_MAX_ATTEMPTS);
    const row = await env.DB.prepare("SELECT attempts FROM otp_codes WHERE email = ?")
      .bind("burst@example.com")
      .first<{ attempts: number }>();
    expect(row?.attempts).toBe(OTP_MAX_ATTEMPTS);

    const r = await h.json("/auth/verify", { email: "burst@example.com", code });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "code_locked" });
    expect(await count("accounts")).toBe(0);
  });

  it("rejects an expired code", async () => {
    const h = makeHarness();
    await h.json("/auth/start", { email: "late@example.com" });
    const code = h.email.lastCodeFor("late@example.com");
    h.clock.advance(10 * 60_000 + 1);
    const r = await h.json("/auth/verify", { email: "late@example.com", code });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "code_expired" });
  });

  it("allows a resend only after 30 s, and the resend replaces the old code", async () => {
    const h = makeHarness();
    await h.json("/auth/start", { email: "resend@example.com" });
    const first = h.email.lastCodeFor("resend@example.com");
    h.clock.advance(10_000);
    const early = await h.json("/auth/start", { email: "resend@example.com" });
    expect(early.status).toBe(429);
    expect(h.email.sent).toHaveLength(1);
    h.clock.advance(21_000);
    const ok = await h.json("/auth/start", { email: "resend@example.com" });
    expect(ok.status).toBe(200);
    const second = h.email.lastCodeFor("resend@example.com");
    if (first !== second) {
      const old = await h.json("/auth/verify", { email: "resend@example.com", code: first });
      expect(old.status).toBe(400);
    }
    const good = await h.json("/auth/verify", { email: "resend@example.com", code: second });
    expect(good.status).toBe(200);
  });

  it("rate-limits new-account sign-ups per IP but still lets existing accounts sign in", async () => {
    const h = makeHarness();
    await h.signIn("existing@example.com", "198.51.100.200");
    for (let i = 0; i < 5; i++) {
      const r = await h.json("/auth/start", { email: `new${i}@example.com` }, { ip: "198.51.100.9" });
      expect(r.status).toBe(200);
    }
    const blocked = await h.json("/auth/start", { email: "new-extra@example.com" }, { ip: "198.51.100.9" });
    expect(blocked.status).toBe(429);
    h.clock.advance(60_000);
    const existing = await h.json("/auth/start", { email: "existing@example.com" }, { ip: "198.51.100.9" });
    expect(existing.status).toBe(200);
    const otherIp = await h.json("/auth/start", { email: "new-extra@example.com" }, { ip: "198.51.100.10" });
    expect(otherIp.status).toBe(200);
  });

  it("rate-limits verify attempts per IP", async () => {
    const h = makeHarness();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const r = await h.json("/auth/verify", { email: `x${i}@example.com`, code: "123456" }, { ip: "192.0.2.50" });
      last = r.status;
    }
    expect(last).toBe(429);
  });
});

describe("AppSource reviewer account", () => {
  it("uses the static REVIEWER_CODE, sends no email, and is always pro", async () => {
    const h = makeHarness();
    const reviewer = env.REVIEWER_EMAIL;
    const start = await h.json("/auth/start", { email: reviewer });
    expect(start.status).toBe(200);
    expect(h.email.sent).toHaveLength(0);
    expect(await count("otp_codes")).toBe(0);

    const bad = await h.json("/auth/verify", { email: reviewer, code: "123456" });
    expect(bad.status).toBe(400);

    const first = await h.json("/auth/verify", { email: reviewer, code: env.REVIEWER_CODE });
    expect(first.status).toBe(200);
    h.clock.advance(400 * DAY); // long after any trial
    const verify = await h.json("/auth/verify", { email: reviewer, code: env.REVIEWER_CODE });
    expect(verify.status).toBe(200);
    const { session_token } = await verify.json<{ session_token: string }>();
    const ent = await h.request("/entitlement", { token: session_token });
    expect(ent.status).toBe(200);
    expect((await ent.json<{ plan: string }>()).plan).toBe("pro");
  });

  it("is disabled when REVIEWER_CODE is empty", async () => {
    const h = makeHarness({ REVIEWER_CODE: "" });
    const verify = await h.json("/auth/verify", { email: env.REVIEWER_EMAIL, code: "" });
    expect(verify.status).toBe(400);
  });
});

describe("sessions", () => {
  it("rejects missing, malformed, and foreign-signed tokens", async () => {
    const h = makeHarness();
    expect((await h.request("/entitlement")).status).toBe(401);
    expect((await h.request("/entitlement", { token: "garbage" })).status).toBe(401);
    const { token } = await h.signIn("sess@example.com");
    const other = makeHarness({ SESSION_SECRET: "a-completely-different-secret-value-000000" });
    expect((await other.request("/entitlement", { token })).status).toBe(401);
    expect((await h.request("/entitlement", { token })).status).toBe(200);
  });

  it("a revoked (signed-out) session gets 401", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("signout@example.com");
    const out = await h.request("/auth/signout", { method: "POST", token });
    expect(out.status).toBe(200);
    expect((await h.request("/entitlement", { token })).status).toBe(401);
    expect((await h.request("/auth/signout", { method: "POST", token })).status).toBe(401);
  });

  it("a session expires after 30 days", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("old@example.com");
    h.clock.advance(30 * DAY + 1);
    expect((await h.request("/entitlement", { token })).status).toBe(401);
  });

  it("a session whose DB row expired is rejected even if the JWT has not", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("row@example.com");
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await h.request("/entitlement", { token })).status).toBe(401);
  });
});
