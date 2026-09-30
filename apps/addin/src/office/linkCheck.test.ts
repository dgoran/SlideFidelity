import { describe, expect, it, vi } from "vitest";
import { checkableUrls, checkLinks, isHttpUrl, MAX_URLS_PER_REQUEST, type LinkCheckDeps } from "./linkCheck";

interface Call {
  url: string;
  auth: string | null;
  urls: string[];
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Fake backend: `ok` for everything except URLs containing "404" (broken). */
function fakeApi(handler?: (urls: string[], n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urls = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("Authorization"), urls });
    if (handler) return handler(urls, calls.length);
    return jsonResponse(200, {
      results: urls.map((u) => (u.includes("404") ? { url: u, status: "broken", http_status: 404, reason: "not_found" } : { url: u, status: "ok", http_status: 200 })),
    });
  });
  const deps: LinkCheckDeps = { fetch: fetchFn as unknown as typeof fetch, baseUrl: "https://api.test/", getToken: () => "tok-1" };
  return { calls, fetchFn, deps };
}

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `https://site${i}.example.com/${i % 7 === 0 ? "404" : "ok"}`);

describe("checkLinks", () => {
  it("batches 120 URLs into 3 requests of ≤50 and merges statuses by URL", async () => {
    const { calls, deps } = fakeApi();
    const urls = many(120);
    const report = await checkLinks(urls, deps);

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.urls.length)).toEqual([50, 50, 20]);
    for (const c of calls) {
      expect(c.url).toBe("https://api.test/linkcheck");
      expect(c.auth).toBe("Bearer tok-1");
      expect(c.urls.length).toBeLessThanOrEqual(MAX_URLS_PER_REQUEST);
    }
    expect(report.requests).toBe(3);
    expect(report.results.map((r) => r.url)).toEqual(urls);
    expect(report.byUrl["https://site0.example.com/404"]).toEqual({ url: "https://site0.example.com/404", status: "broken", httpStatus: 404, reason: "not_found" });
    expect(report.byUrl["https://site1.example.com/ok"]).toMatchObject({ status: "ok", httpStatus: 200 });
    expect(report.error).toBeUndefined();
  });

  it("deduplicates URLs before sending", async () => {
    const { calls, deps } = fakeApi();
    const report = await checkLinks(["https://a.example.com/", "https://a.example.com/", "https://b.example.com/"], deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.urls).toEqual(["https://a.example.com/", "https://b.example.com/"]);
    expect(report.results).toHaveLength(2);
  });

  it("never sends non-http(s) URLs (R18)", async () => {
    const { calls, fetchFn, deps } = fakeApi();
    const local = [
      "mailto:someone@example.com",
      "file:///C:/Users/alice/budget.xlsx",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "\\\\server\\share\\x.pptx",
      "C:\\x.docx",
      "ftp://example.com/x",
      "../relative.xlsx",
      "http:/malformed",
    ];
    const report = await checkLinks([...local, "https://ok.example.com/"], deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls[0]!.urls).toEqual(["https://ok.example.com/"]);
    for (const u of local) expect(report.byUrl[u]).toEqual({ url: u, status: "not-checked", reason: "not-http" });

    const none = await checkLinks(local, deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(none.requests).toBe(0);
  });

  it("does not send URLs longer than 2048 characters", async () => {
    const { calls, deps } = fakeApi();
    const long = `https://example.com/${"a".repeat(2100)}`;
    const report = await checkLinks([long, "https://ok.example.com/"], deps);
    expect(calls[0]!.urls).toEqual(["https://ok.example.com/"]);
    expect(report.byUrl[long]).toMatchObject({ status: "not-checked", reason: "too-long" });
  });

  it("treats 429 as rate limited without failing: remaining URLs are not-checked with a retry hint", async () => {
    const { calls, deps } = fakeApi((urls, n) =>
      n === 1
        ? jsonResponse(200, { results: urls.map((u) => ({ url: u, status: "ok" })) })
        : jsonResponse(429, { error: "rate_limited", retry_after_seconds: 120 }, { "Retry-After": "120" }),
    );
    const urls = many(120);
    const report = await checkLinks(urls, deps);
    expect(calls).toHaveLength(2); // stops after the 429
    expect(report.error).toEqual({ code: "rate_limited", retryAfterSeconds: 120 });
    expect(report.results).toHaveLength(120);
    expect(report.results.slice(0, 50).every((r) => r.status === "ok")).toBe(true);
    for (const r of report.results.slice(50)) expect(r).toMatchObject({ status: "not-checked", reason: "rate-limited", retryAfterSeconds: 120 });
  });

  it("reports daily capacity 429s and falls back to the body retry hint", async () => {
    const { deps } = fakeApi(() => jsonResponse(429, { error: "daily_capacity_reached", retry_after_seconds: 3600 }));
    const report = await checkLinks(["https://a.example.com/"], deps);
    expect(report.error).toEqual({ code: "daily_capacity_reached", retryAfterSeconds: 3600 });
    expect(report.results[0]).toMatchObject({ status: "not-checked", reason: "rate-limited", retryAfterSeconds: 3600 });
  });

  it("marks URLs not-checked when the API is unreachable, and keeps going", async () => {
    const { deps } = fakeApi((_urls, n) => {
      if (n === 1) throw new TypeError("Failed to fetch");
      return jsonResponse(200, { results: _urls.map((u) => ({ url: u, status: "ok" })) });
    });
    const urls = many(60);
    const report = await checkLinks(urls, deps);
    expect(report.error).toEqual({ code: "network_error" });
    expect(report.results).toHaveLength(60);
    expect(report.results.slice(0, 50).every((r) => r.status === "not-checked" && r.reason === "network-error")).toBe(true);
    expect(report.results.slice(50).every((r) => r.status === "ok")).toBe(true);
  });

  it("handles 401 and 403 pro_required without throwing", async () => {
    const unauth = fakeApi(() => jsonResponse(401, { error: "unauthorized" }));
    const r1 = await checkLinks(many(60), unauth.deps);
    expect(unauth.calls).toHaveLength(1);
    expect(r1.error).toEqual({ code: "unauthorized" });
    expect(r1.results.every((r) => r.reason === "unauthorized")).toBe(true);

    const free = fakeApi(() => jsonResponse(403, { error: "pro_required" }));
    const r2 = await checkLinks(["https://a.example.com/"], free.deps);
    expect(r2.error).toEqual({ code: "pro_required" });
    expect(r2.results[0]).toMatchObject({ status: "not-checked", reason: "pro-required" });
  });

  it("does not call the API without a session token", async () => {
    const { fetchFn, deps } = fakeApi();
    const report = await checkLinks(["https://a.example.com/"], { ...deps, getToken: async () => null });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(report.error).toEqual({ code: "unauthorized" });
    expect(report.results[0]).toMatchObject({ status: "not-checked", reason: "unauthorized" });
  });

  it("handles 400, 5xx, malformed bodies, and missing or foreign result entries", async () => {
    const bad = fakeApi(() => jsonResponse(400, { error: "invalid_urls" }));
    expect((await checkLinks(["https://a.example.com/"], bad.deps)).results[0]).toMatchObject({ reason: "invalid-request" });

    const down = fakeApi(() => new Response("oops", { status: 502 }));
    const r = await checkLinks(["https://a.example.com/"], down.deps);
    expect(r.error).toEqual({ code: "server_error" });
    expect(r.results[0]).toMatchObject({ status: "not-checked", reason: "server-error" });

    const odd = fakeApi(() =>
      jsonResponse(200, {
        results: [
          { url: "https://evil.example.com/", status: "ok" },
          { url: "https://a.example.com/", status: "weird" },
          null,
        ],
      }),
    );
    const r2 = await checkLinks(["https://a.example.com/"], odd.deps);
    expect(r2.results).toEqual([{ url: "https://a.example.com/", status: "not-checked", reason: "no-result" }]);
    expect(r2.byUrl["https://evil.example.com/"]).toBeUndefined();

    const garbage = fakeApi(() => new Response("not json", { status: 200 }));
    expect((await checkLinks(["https://a.example.com/"], garbage.deps)).results[0]).toMatchObject({ status: "not-checked", reason: "no-result" });
  });

  it("propagates aborts", async () => {
    const ctrl = new AbortController();
    const { deps } = fakeApi(() => {
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(checkLinks(["https://a.example.com/"], { ...deps, signal: ctrl.signal })).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("isHttpUrl accepts only absolute http(s) URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("HTTP://EXAMPLE.COM/x")).toBe(true);
    expect(isHttpUrl("mailto:a@b.c")).toBe(false);
    expect(isHttpUrl("//example.com")).toBe(false);
    expect(isHttpUrl(" https://example.com")).toBe(false);
  });

  it("checkableUrls picks deduped checkable hyperlink addresses only", () => {
    const urls = checkableUrls([
      { kind: "hyperlink", data: { address: "https://a.example.com/", checkable: true } },
      { kind: "hyperlink", data: { address: "https://a.example.com/", checkable: true } },
      { kind: "hyperlink", data: { address: "mailto:x@y.z", checkable: false } },
      { kind: "hyperlink", data: { address: "javascript:alert(1)", checkable: true } },
      { kind: "local-path-link", data: { address: "https://b.example.com/" } },
    ]);
    expect(urls).toEqual(["https://a.example.com/"]);
  });
});
