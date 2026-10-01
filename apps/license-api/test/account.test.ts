import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { PaddleApiClient } from "../src/paddle";
import { count, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function subscribe(h: ReturnType<typeof makeHarness>, accountId: string, id: string, status: string, customerId: string | null = "ctm_9") {
  const body = JSON.stringify({
    event_id: `evt_${id}_${status}_${h.clock.t}`,
    event_type: status === "canceled" ? "subscription.canceled" : status === "active" ? "subscription.activated" : "subscription.updated",
    occurred_at: new Date(h.clock.t).toISOString(),
    data: { id, status, customer_id: customerId, custom_data: { account_id: accountId }, current_billing_period: null },
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
  it("points checkout at the site account page and returns no portal link without a Paddle customer", async () => {
    const h = makeHarness();
    const { token } = await h.signIn("bill@example.com");
    const res = await h.request("/billing/links", { token });
    expect(res.status).toBe(200);
    const body = await res.json<{ checkout_url: string; portal_url: string | null }>();
    expect(body.checkout_url).toBe(new URL("/account.html", env.SITE_URL).toString());
    expect(body.portal_url).toBeNull();
    expect(h.paddle.portalCalls).toEqual([]);
  });

  it("returns a fresh portal session URL for a subscribed account", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("bill@example.com");
    await subscribe(h, accountId, "sub_b", "active");
    const first = await (await h.request("/billing/links", { token })).json<{ portal_url: string | null }>();
    const second = await (await h.request("/billing/links", { token })).json<{ portal_url: string | null }>();
    expect(first.portal_url).toContain("ctm_9");
    expect(second.portal_url).toContain("ctm_9");
    // A new portal session is created on every request (portal links are short-lived).
    expect(h.paddle.portalCalls).toEqual(["ctm_9", "ctm_9"]);
  });

  it("returns portal_url null, not a 5xx, when Paddle fails", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("bill@example.com");
    await subscribe(h, accountId, "sub_b", "active");
    h.paddle.portalFail = true;
    const res = await h.request("/billing/links", { token });
    expect(res.status).toBe(200);
    const body = await res.json<{ checkout_url: string; portal_url: string | null }>();
    expect(body.portal_url).toBeNull();
    expect(body.checkout_url).toContain("/account.html");
  });

  it("keeps the customer id when a later event omits it", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("bill@example.com");
    await subscribe(h, accountId, "sub_b", "active");
    h.clock.advance(1000);
    await subscribe(h, accountId, "sub_b", "past_due", null);
    const body = await (await h.request("/billing/links", { token })).json<{ portal_url: string | null }>();
    expect(body.portal_url).toContain("ctm_9");
  });

  it("requires a session", async () => {
    const h = makeHarness();
    expect((await h.request("/billing/links")).status).toBe(401);
  });
});

describe("PaddleApiClient.createPortalSession", () => {
  it("posts to the customer portal-sessions endpoint with the API key and returns the overview URL", async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, auth: req.headers.get("Authorization"), method: req.method });
      return Response.json({ data: { id: "cpls_1", urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1?action=overview&token=t" } } } });
    };
    const client = new PaddleApiClient("pdl_live_key", "production", fetcher);
    await expect(client.createPortalSession("ctm_42")).resolves.toBe("https://customer-portal.paddle.com/cpl_1?action=overview&token=t");
    expect(calls).toEqual([{ url: "https://api.paddle.com/customers/ctm_42/portal-sessions", auth: "Bearer pdl_live_key", method: "POST" }]);
  });

  it("uses the sandbox host outside production", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(new Request(input, init).url);
      return Response.json({ data: { urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/x" } } } });
    };
    await new PaddleApiClient("k", "sandbox", fetcher).createPortalSession("ctm_1");
    expect(urls).toEqual(["https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions"]);
  });

  it("throws on an error response or a missing URL", async () => {
    const failing = new PaddleApiClient("k", "sandbox", async () => Response.json({ error: { code: "not_found" } }, { status: 404 }));
    await expect(failing.createPortalSession("ctm_1")).rejects.toThrow();
    const empty = new PaddleApiClient("k", "sandbox", async () => Response.json({ data: {} }));
    await expect(empty.createPortalSession("ctm_1")).rejects.toThrow();
  });
});

describe("PaddleApiClient.cancelSubscription", () => {
  it("posts an immediate cancel to the subscription endpoint with the API key", async () => {
    const calls: { url: string; auth: string | null; method: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, auth: req.headers.get("Authorization"), method: req.method, body: await req.json() });
      return Response.json({ data: { id: "sub_1", status: "canceled" } });
    };
    await expect(new PaddleApiClient("pdl_live_key", "production", fetcher).cancelSubscription("sub_1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        url: "https://api.paddle.com/subscriptions/sub_1/cancel",
        auth: "Bearer pdl_live_key",
        method: "POST",
        body: { effective_from: "immediately" },
      },
    ]);
  });

  it("uses the sandbox host when PADDLE_ENV is sandbox", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(new Request(input, init).url);
      return Response.json({ data: { id: "sub_1" } });
    };
    await new PaddleApiClient("k", "sandbox", fetcher).cancelSubscription("sub_1");
    expect(urls).toEqual(["https://sandbox-api.paddle.com/subscriptions/sub_1/cancel"]);
  });

  it("treats an already-canceled 4xx as success", async () => {
    const client = new PaddleApiClient("k", "sandbox", async () =>
      Response.json({ error: { type: "request_error", code: "subscription_is_canceled_action_invalid" } }, { status: 400 }),
    );
    await expect(client.cancelSubscription("sub_1")).resolves.toBeUndefined();
  });

  it("rejects on a 500 and on any other 4xx", async () => {
    const serverError = new PaddleApiClient("k", "sandbox", async () => new Response("oops", { status: 500 }));
    await expect(serverError.cancelSubscription("sub_1")).rejects.toThrow(/500/);
    const notFound = new PaddleApiClient("k", "sandbox", async () => Response.json({ error: { code: "not_found" } }, { status: 404 }));
    await expect(notFound.cancelSubscription("sub_1")).rejects.toThrow(/404/);
    const forbidden = new PaddleApiClient("k", "sandbox", async () => Response.json({ error: { code: "forbidden" } }, { status: 403 }));
    await expect(forbidden.cancelSubscription("sub_1")).rejects.toThrow(/403/);
  });
});
