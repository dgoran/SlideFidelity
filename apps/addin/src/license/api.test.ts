import { describe, expect, it, vi } from "vitest";
import { ApiError, createLicenseApi } from "./api";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}));
  const api = createLicenseApi({ baseUrl: "https://api.test/", fetch: fetchFn as unknown as typeof fetch });
  return { api, fetchFn };
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected rejection");
}

describe("license api client", () => {
  it("startAuth posts the email and maps the response", async () => {
    const { api, fetchFn } = setup(() => json(200, { ok: true, resend_after_seconds: 30, expires_in_seconds: 600 }));
    await expect(api.startAuth("a@b.co")).resolves.toEqual({ resendAfterSeconds: 30, expiresInSeconds: 600 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.test/auth/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "a@b.co" });
  });

  it("verifyAuth returns the session and account", async () => {
    const { api } = setup(() =>
      json(200, { session_token: "s.t.x", expires_at: 5, account: { id: "acct", email: "a@b.co", trial_ends_at: 9 } }),
    );
    await expect(api.verifyAuth("a@b.co", "123456")).resolves.toEqual({
      sessionToken: "s.t.x",
      expiresAt: 5,
      account: { id: "acct", email: "a@b.co", trial_ends_at: 9 },
    });
  });

  it("sends the bearer token on authenticated routes", async () => {
    const { api, fetchFn } = setup(() =>
      json(200, { token: "t", plan: "pro", expires_at: 1, grace_until: 2, trial_ends_at: 3 }),
    );
    await expect(api.getEntitlement("sess")).resolves.toEqual({
      token: "t",
      plan: "pro",
      expiresAt: 1,
      graceUntil: 2,
      trialEndsAt: 3,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.test/entitlement");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sess");
  });

  it("maps billing links, including a null portal", async () => {
    const { api } = setup(() => json(200, { checkout_url: "https://s/account.html", portal_url: null }));
    await expect(api.getBillingLinks("s")).resolves.toEqual({ checkoutUrl: "https://s/account.html", portalUrl: null });
  });

  it("signOut and deleteAccount use the right methods", async () => {
    const { api, fetchFn } = setup(() => json(200, { ok: true }));
    await api.signOut("s");
    await api.deleteAccount("s");
    expect(fetchFn.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      "POST https://api.test/auth/signout",
      "DELETE https://api.test/account",
    ]);
  });

  it.each([
    [400, "invalid_code"],
    [400, "code_expired"],
    [400, "code_locked"],
    [503, "email_unavailable"],
    [401, "unauthorized"],
    [502, "billing_cancel_failed"],
  ])("maps HTTP %i {error:%s} to ApiError", async (status, code) => {
    const { api } = setup(() => json(status, { error: code }));
    const err = await caught(api.verifyAuth("a@b.co", "1"));
    expect(err).toMatchObject({ code, status });
  });

  it("reads Retry-After on 429", async () => {
    const { api } = setup(() => json(429, { error: "resend_too_soon", retry_after_seconds: 12 }, { "Retry-After": "12" }));
    const err = await caught(api.startAuth("a@b.co"));
    expect(err).toMatchObject({ code: "resend_too_soon", status: 429, retryAfterSeconds: 12 });
  });

  it("falls back to the body retry_after_seconds when the header is absent", async () => {
    const { api } = setup(() => json(429, { error: "rate_limited", retry_after_seconds: 7 }));
    expect(await caught(api.startAuth("a@b.co"))).toMatchObject({ code: "rate_limited", retryAfterSeconds: 7 });
  });

  it("maps a fetch rejection to a network error with status 0", async () => {
    const { api } = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await caught(api.getEntitlement("s"))).toMatchObject({ code: "network", status: 0 });
  });

  it("maps a timeout to a network error", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(
        (_u: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))),
      );
      const api = createLicenseApi({ baseUrl: "https://api.test", fetch: fetchFn as unknown as typeof fetch, timeoutMs: 1000 });
      const p = caught(api.getEntitlement("s"));
      await vi.advanceTimersByTimeAsync(1001);
      expect(await p).toMatchObject({ code: "network", status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps unknown error codes and non-JSON bodies", async () => {
    const { api } = setup(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await caught(api.getEntitlement("s"))).toMatchObject({ code: "unknown", status: 502 });
    const { api: api2 } = setup(() => json(418, { error: "teapot" }));
    expect(await caught(api2.getEntitlement("s"))).toMatchObject({ code: "unknown", status: 418 });
  });

  it("rejects a 200 with the wrong shape as bad_response", async () => {
    const { api } = setup(() => json(200, { token: 5 }));
    expect(await caught(api.getEntitlement("s"))).toMatchObject({ code: "bad_response", status: 200 });
  });
});
