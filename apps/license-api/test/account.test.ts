import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { count, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function subscribe(h: ReturnType<typeof makeHarness>, accountId: string, id: string, status: string) {
  const body = JSON.stringify({
    event_id: `evt_${id}_${status}`,
    event_type: status === "canceled" ? "subscription.canceled" : "subscription.activated",
    occurred_at: new Date(h.clock.t).toISOString(),
    data: { id, status, customer_id: "ctm_9", custom_data: { account_id: accountId }, current_billing_period: null },
  });
  const ts = Math.floor(h.clock.t / 1000);
  const sig = await hmacHex(env.PADDLE_WEBHOOK_SECRET, `${ts}:${body}`);
  const res = await h.request("/paddle/webhook", { method: "POST", body, headers: { "Paddle-Signature": `ts=${ts};h1=${sig}` } });
  expect(res.status).toBe(200);
}

describe("DELETE /account", () => {
  it("removes the account, sessions, OTP rows, and subscriptions, and cancels the active Paddle subscription", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("gone@example.com");
    h.clock.advance(31_000);
    await h.json("/auth/start", { email: "gone@example.com" }); // leaves a pending OTP row
    await subscribe(h, accountId, "sub_live", "active");
    await subscribe(h, accountId, "sub_old", "canceled");
    await h.signIn("other@example.com");

    const res = await h.request("/account", { method: "DELETE", token });
    expect(res.status).toBe(200);
    expect(h.paddle.canceled).toEqual(["sub_live"]);
    expect(await count("accounts", "id = ?", accountId)).toBe(0);
    expect(await count("sessions", "account_id = ?", accountId)).toBe(0);
    expect(await count("otp_codes", "email = ?", "gone@example.com")).toBe(0);
    expect(await count("subscriptions", "account_id = ?", accountId)).toBe(0);
    expect(await count("accounts")).toBe(1);

    // The old session belongs to a deleted account.
    expect((await h.request("/entitlement", { token })).status).toBe(401);
    expect((await h.request("/account", { method: "DELETE", token })).status).toBe(401);
  });

  it("keeps the account and returns 502 when Paddle cancellation fails", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("keep@example.com");
    await subscribe(h, accountId, "sub_x", "active");
    h.paddle.fail = true;
    const res = await h.request("/account", { method: "DELETE", token });
    expect(res.status).toBe(502);
    expect(await count("accounts", "id = ?", accountId)).toBe(1);
    expect((await h.request("/entitlement", { token })).status).toBe(200);
  });

  it("requires a session", async () => {
    const h = makeHarness();
    expect((await h.request("/account", { method: "DELETE" })).status).toBe(401);
  });
});

describe("GET /billing/links", () => {
  it("returns an account-bound checkout link and a portal link once a customer exists", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("bill@example.com");
    const before = await (await h.request("/billing/links", { token })).json<{ checkout_url: string; portal_url: string | null }>();
    expect(new URL(before.checkout_url).searchParams.get("account_id")).toBe(accountId);
    expect(before.checkout_url.startsWith(env.SITE_URL)).toBe(true);
    expect(before.portal_url).toBeNull();
    await subscribe(h, accountId, "sub_b", "active");
    const after = await (await h.request("/billing/links", { token })).json<{ portal_url: string | null }>();
    expect(after.portal_url).toContain("ctm_9");
    expect((await h.request("/billing/links")).status).toBe(401);
  });
});
