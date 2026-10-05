import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/ratelimit";
import { DAY, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

type Result = { url: string; status: "ok" | "broken" | "unverified"; reason?: string; http_status?: number };

async function proHarness(overrides = {}, opts: { linkTimeoutMs?: number } = {}) {
  const h = makeHarness(overrides, opts);
  const s = await h.signIn("links@example.com"); // trial counts as Pro
  return { ...h, token: s.token, accountId: s.accountId };
}

async function check(h: Awaited<ReturnType<typeof proHarness>>, urls: unknown, ip?: string) {
  const res = await h.json("/linkcheck", { urls }, { token: h.token, ip });
  return res;
}

async function results(h: Awaited<ReturnType<typeof proHarness>>, urls: string[]): Promise<Result[]> {
  const res = await check(h, urls);
  expect(res.status).toBe(200);
  return (await res.json<{ results: Result[] }>()).results;
}

describe("POST /linkcheck access", () => {
  it("requires a session", async () => {
    const h = makeHarness();
    const res = await h.json("/linkcheck", { urls: ["https://example.com/"] });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a free account", async () => {
    const h = makeHarness();
    await h.signIn("free@example.com");
    h.clock.advance(31 * DAY);
    const { token } = await h.signIn("free@example.com");
    const res = await h.json("/linkcheck", { urls: ["https://example.com/"] }, { token });
    expect(res.status).toBe(403);
    expect(h.fetcher.calls).toHaveLength(0);
  });

  it("returns 400 for more than 50 URLs or a malformed body", async () => {
    const h = await proHarness();
    const many = Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`);
    expect((await check(h, many)).status).toBe(400);
    expect((await check(h, [])).status).toBe(400);
    expect((await check(h, "https://example.com/")).status).toBe(400);
    expect((await check(h, [42])).status).toBe(400);
    expect((await check(h, [`https://example.com/${"a".repeat(2100)}`])).status).toBe(400);
    expect(h.fetcher.calls).toHaveLength(0);
  });
});

describe("POST /linkcheck SSRF guard (KTD9)", () => {
  it("rejects metadata, localhost, private IPs, and hostnames resolving to private IPs without fetching", async () => {
    const h = await proHarness();
    h.resolver.records["intranet.example.com"] = { status: "ok", addresses: ["10.1.2.3"] };
    h.resolver.records["sneaky.example.com"] = { status: "ok", addresses: ["::ffff:192.168.0.1"] };
    const urls = [
      "http://169.254.169.254/",
      "http://localhost",
      "http://10.0.0.5",
      "http://intranet.example.com/",
      "http://sneaky.example.com/",
      "http://[fd00::1]/",
      "gopher://example.com/",
    ];
    const r = await results(h, urls);
    expect(r.map((x) => x.url)).toEqual(urls);
    for (const x of r) expect(x).toMatchObject({ status: "unverified", reason: "blocked" });
    expect(h.fetcher.calls).toHaveLength(0);
  });

  it("a public URL redirecting to http://169.254.169.254/ is blocked and the target is never fetched", async () => {
    const h = await proHarness();
    h.fetcher.on("https://public.example.com/r", () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }));
    const [r] = await results(h, ["https://public.example.com/r"]);
    expect(r).toMatchObject({ status: "unverified", reason: "blocked" });
    expect(h.fetcher.urls()).toEqual(["https://public.example.com/r"]);
  });

  it("re-validates DNS on every hop", async () => {
    const h = await proHarness();
    h.resolver.records["evil.example.com"] = { status: "ok", addresses: ["127.0.0.1"] };
    h.fetcher.on("https://public.example.com/r", () => new Response(null, { status: 301, headers: { Location: "https://evil.example.com/x" } }));
    const [r] = await results(h, ["https://public.example.com/r"]);
    expect(r).toMatchObject({ status: "unverified", reason: "blocked" });
    expect(h.fetcher.urls()).toEqual(["https://public.example.com/r"]);
    expect(h.resolver.lookups).toContain("evil.example.com");
  });

  it("resolves each hostname once per request while still checking every URL and hop", async () => {
    const h = await proHarness();
    h.resolver.records["evil.example.com"] = { status: "ok", addresses: ["127.0.0.1"] };
    const urls: string[] = [];
    for (let i = 0; i < 20; i++) {
      h.fetcher.on(`https://same.example.com/${i}`, 200);
      urls.push(`https://same.example.com/${i}`);
    }
    for (let i = 0; i < 3; i++) {
      h.fetcher.on(`https://same.example.com/r${i}`, () => new Response(null, { status: 302, headers: { Location: "https://evil.example.com/x" } }));
      urls.push(`https://same.example.com/r${i}`);
    }
    urls.push("https://evil.example.com/direct");
    const res = await results(h, urls);
    expect(res.slice(0, 20).every((r) => r.status === "ok")).toBe(true);
    for (const r of res.slice(20)) expect(r).toMatchObject({ status: "unverified", reason: "blocked" });
    expect(h.fetcher.urls().some((u) => u.startsWith("https://evil.example.com/"))).toBe(false);
    expect(h.resolver.lookups.filter((n) => n === "same.example.com")).toHaveLength(1);
    expect(h.resolver.lookups.filter((n) => n === "evil.example.com")).toHaveLength(1);

    // The memo lives for one request only: a second request resolves again.
    await results(h, ["https://same.example.com/0"]);
    expect(h.resolver.lookups.filter((n) => n === "same.example.com")).toHaveLength(2);
  });

  it("follows at most 5 redirects", async () => {
    const h = await proHarness();
    for (let i = 0; i < 7; i++) {
      h.fetcher.on(`https://hop.example.com/${i}`, () => new Response(null, { status: 302, headers: { Location: `/${i + 1}` } }));
    }
    const [r] = await results(h, ["https://hop.example.com/0"]);
    expect(r).toMatchObject({ status: "unverified", reason: "too_many_redirects" });
    expect(h.fetcher.urls()).toHaveLength(6);

    const h2 = await proHarness();
    for (let i = 0; i < 5; i++) {
      h2.fetcher.on(`https://hop.example.com/${i}`, () => new Response(null, { status: 302, headers: { Location: `/${i + 1}` } }));
    }
    h2.fetcher.on("https://hop.example.com/5", 200);
    const [ok] = await results(h2, ["https://hop.example.com/0"]);
    expect(ok).toMatchObject({ status: "ok", http_status: 200 });
  });

  it("uses manual redirects", async () => {
    const h = await proHarness();
    const seen: (string | undefined)[] = [];
    h.fetcher.on("https://m.example.com/", (req) => {
      seen.push(req.redirect);
      return new Response(null, { status: 200 });
    });
    await results(h, ["https://m.example.com/"]);
    expect(seen).toEqual(["manual"]);
  });
});

describe("POST /linkcheck statuses", () => {
  it("classifies results three ways", async () => {
    const h = await proHarness();
    h.resolver.records["nx.example.com"] = { status: "nxdomain" };
    h.fetcher
      .on("https://a.example.com/ok", 200)
      .on("https://a.example.com/moved", () => new Response(null, { status: 301, headers: { Location: "https://a.example.com/ok" } }))
      .on("https://a.example.com/notmod", 304)
      .on("https://a.example.com/404", 404)
      .on("https://a.example.com/410", 410)
      .on("https://a.example.com/401", 401)
      .on("https://a.example.com/403", 403)
      .on("https://a.example.com/429", 429)
      .on("https://a.example.com/999", 999)
      .on("https://a.example.com/400", 400)
      .on("https://a.example.com/503", 503);
    const urls = [
      "https://a.example.com/ok",
      "https://a.example.com/moved",
      "https://a.example.com/notmod",
      "https://a.example.com/404",
      "https://a.example.com/410",
      "https://nx.example.com/",
      "https://a.example.com/401",
      "https://a.example.com/403",
      "https://a.example.com/429",
      "https://a.example.com/999",
      "https://a.example.com/400",
      "https://a.example.com/503",
      "https://a.example.com/network-error",
    ];
    const r = await results(h, urls);
    expect(r.map((x) => x.status)).toEqual([
      "ok", "ok", "ok", "broken", "broken", "broken",
      "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified",
    ]);
    expect(r[3]).toMatchObject({ http_status: 404 });
    expect(r[5]).toMatchObject({ reason: "nxdomain" });
    expect(r[11]).toMatchObject({ http_status: 503 });
  });

  it("times out slow servers as unverified", async () => {
    const h = await proHarness({}, { linkTimeoutMs: 50 });
    h.fetcher.on(
      "https://slow.example.com/",
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const [r] = await results(h, ["https://slow.example.com/"]);
    expect(r).toMatchObject({ status: "unverified", reason: "timeout" });
  });

  it("falls back to GET when HEAD fails and reads at most the byte cap", async () => {
    const h = await proHarness();
    let pulled = 0;
    h.fetcher.on("https://nohead.example.com/", (req) => {
      if (req.method === "HEAD") return new Response(null, { status: 405 });
      const chunk = new Uint8Array(16 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          if (pulled > 10 * 1024 * 1024) controller.close();
          else controller.enqueue(chunk);
        },
      });
      return new Response(stream, { status: 200 });
    });
    const [r] = await results(h, ["https://nohead.example.com/"]);
    expect(r).toMatchObject({ status: "ok", http_status: 200 });
    expect(h.fetcher.calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
    expect(pulled).toBeLessThan(256 * 1024);
  });

  it("a HEAD 404 that GET confirms is broken", async () => {
    const h = await proHarness();
    h.fetcher.on("https://b.example.com/x", 404);
    const [r] = await results(h, ["https://b.example.com/x"]);
    expect(r).toMatchObject({ status: "broken", http_status: 404 });
  });

  it("never persists submitted URLs", async () => {
    const h = await proHarness();
    h.fetcher.on("https://secret-host.example.com/private/path", 200);
    await results(h, ["https://secret-host.example.com/private/path"]);
    for (const table of ["accounts", "otp_codes", "sessions", "subscriptions", "webhook_events", "rate_limits"]) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows.results)).not.toContain("secret-host");
    }
  });
});

describe("POST /linkcheck abuse limits", () => {
  it("rate-limits per account", async () => {
    const h = await proHarness();
    h.fetcher.on("https://a.example.com/", 200);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await check(h, ["https://a.example.com/"], `198.51.100.${i}`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("rate-limits per IP across accounts", async () => {
    const h = makeHarness();
    h.fetcher.on("https://a.example.com/", 200);
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      tokens.push((await h.signIn(`ip${i}@example.com`, `192.0.2.${i + 1}`)).token);
      h.clock.advance(31_000);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await h.json("/linkcheck", { urls: ["https://a.example.com/"] }, { token: tokens[i % 3], ip: "203.0.113.99" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("charges each account a daily URL budget so one account cannot starve others", async () => {
    const h = await proHarness();
    h.fetcher.on("https://a.example.com/", 200);
    const batch = Array(50).fill("https://a.example.com/");
    const perRequest = batch.length;
    const allowedRequests = LIMITS.linkcheckUrlsPerAccountPerDay.limit / perRequest;
    expect(allowedRequests).toBeLessThan(LIMITS.linkcheckPerAccount.limit); // budget, not the hourly limit, bites
    for (let i = 0; i < allowedRequests; i++) {
      // Spread across IPs so only the account budget applies.
      expect((await check(h, batch, `198.51.100.${i}`)).status).toBe(200);
    }
    const over = await check(h, batch, "198.51.100.200");
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "rate_limited" });

    const other = await h.signIn("other-links@example.com", "192.0.2.77");
    const res = await h.json("/linkcheck", { urls: batch }, { token: other.token, ip: "192.0.2.77" });
    expect(res.status).toBe(200);
  });

  it("enforces a global daily URL cap", async () => {
    const h = await proHarness({ LINKCHECK_GLOBAL_DAILY_URL_CAP: "5" });
    h.fetcher.on("https://a.example.com/", 200);
    expect((await check(h, Array(3).fill("https://a.example.com/"))).status).toBe(200);
    expect((await check(h, Array(3).fill("https://a.example.com/"))).status).toBe(429);
    h.clock.advance(DAY);
    const s = await h.signIn("links@example.com");
    const res = await h.json("/linkcheck", { urls: Array(3).fill("https://a.example.com/") }, { token: s.token });
    expect(res.status).toBe(200);
  });
});
