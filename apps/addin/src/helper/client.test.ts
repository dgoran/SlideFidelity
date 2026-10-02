/**
 * SlideCheck Helper client (U12): parallel port probe with a timeout, health validation, and the
 * flattened font list. Fake fetch only; nothing here talks to a real helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHelperFonts, HELPER_PORTS, parseHealth, probeHelper, type FetchLike } from "./client";
import { fakeFetch, hang, health, jsonResponse } from "./testing";

const url = (port: number, path: string) => `https://localhost:${port}${path}`;

describe("probeHelper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("probes the three ports, with no-store and an abort signal", async () => {
    const f = fakeFetch({});
    await probeHelper({ fetch: f });
    expect(HELPER_PORTS).toEqual([47317, 47318, 47319]);
    expect(f.mock.calls.map((c) => c[0]).sort()).toEqual(HELPER_PORTS.map((p) => url(p, "/v1/health")));
    for (const [, init] of f.mock.calls) {
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("health on 47318 only → connected on 47318", async () => {
    const f = fakeFetch({ [url(47318, "/v1/health")]: jsonResponse(health()) });
    const r = await probeHelper({ fetch: f });
    expect(r).toMatchObject({ kind: "connected", port: 47318, health: { version: "0.1.0", apiVersion: 1, platform: "mac" } });
  });

  it("an incompatible apiVersion → outdated, with the reported version", async () => {
    const f = fakeFetch({ [url(47317, "/v1/health")]: jsonResponse(health({ apiVersion: 2, version: "0.9.0" })) });
    const r = await probeHelper({ fetch: f });
    expect(r).toMatchObject({ kind: "outdated", port: 47317, health: { version: "0.9.0", apiVersion: 2 } });
  });

  it("prefers a compatible helper over an outdated answer on another port", async () => {
    const f = fakeFetch({
      [url(47317, "/v1/health")]: jsonResponse(health({ apiVersion: 0 })),
      [url(47319, "/v1/health")]: jsonResponse(health()),
    });
    expect(await probeHelper({ fetch: f })).toMatchObject({ kind: "connected", port: 47319 });
  });

  it("all ports time out → absent within the timeout, without throwing", async () => {
    const f = fakeFetch({ [url(47317, "/v1/health")]: hang, [url(47318, "/v1/health")]: hang, [url(47319, "/v1/health")]: hang });
    let done: unknown;
    void probeHelper({ fetch: f }).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual({ kind: "absent" });
  });

  it("times out even when fetch ignores the abort signal", async () => {
    const never = () => new Promise(() => {});
    const f = fakeFetch({ [url(47317, "/v1/health")]: never, [url(47318, "/v1/health")]: never, [url(47319, "/v1/health")]: never });
    const p = probeHelper({ fetch: f, timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toEqual({ kind: "absent" });
  });

  it("mixed network errors → absent, never throws", async () => {
    const f = fakeFetch({
      [url(47317, "/v1/health")]: () => Promise.reject(new TypeError("Failed to fetch")),
      [url(47318, "/v1/health")]: () => {
        throw new Error("synchronous boom");
      },
      [url(47319, "/v1/health")]: jsonResponse({ error: "forbidden" }, 403),
    });
    await expect(probeHelper({ fetch: f })).resolves.toEqual({ kind: "absent" });
  });

  it("a fetch that is not a function at all → absent", async () => {
    await expect(probeHelper({ fetch: undefined as unknown as FetchLike })).resolves.toEqual({ kind: "absent" });
  });

  it("malformed JSON → absent", async () => {
    const f = fakeFetch({
      [url(47317, "/v1/health")]: { ok: true, status: 200, json: async () => JSON.parse("{not json") },
      [url(47318, "/v1/health")]: jsonResponse("hello"),
      [url(47319, "/v1/health")]: jsonResponse({ apiVersion: "1", version: "0.1.0" }),
    });
    await expect(probeHelper({ fetch: f })).resolves.toEqual({ kind: "absent" });
  });
});

describe("parseHealth", () => {
  it("accepts the documented shape", () => {
    const h = parseHealth(health({ platform: "windows", certDaysRemaining: null, update: { version: "0.2.0", page: "https://slidecheck.io/helper", notes: "Faster" } }));
    expect(h).toEqual({
      version: "0.1.0",
      apiVersion: 1,
      platform: "windows",
      certDaysRemaining: null,
      update: { version: "0.2.0", page: "https://slidecheck.io/helper", notes: "Faster" },
    });
  });

  it("rejects missing or non-integer fields", () => {
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth([])).toBeNull();
    expect(parseHealth(health({ apiVersion: 1.5 }))).toBeNull();
    expect(parseHealth(health({ version: 3 }))).toBeNull();
    expect(parseHealth(health({ version: "x".repeat(65) }))).toBeNull();
  });

  it("drops an update that isn't an https page, and an unusable certDaysRemaining", () => {
    expect(parseHealth(health({ update: { version: "0.2.0", page: "http://evil.example/" } }))?.update).toBeNull();
    expect(parseHealth(health({ update: { version: "0.2.0", page: "javascript:alert(1)" } }))?.update).toBeNull();
    expect(parseHealth(health({ update: "yes" }))?.update).toBeNull();
    expect(parseHealth(health({ certDaysRemaining: "soon" }))?.certDaysRemaining).toBeNull();
    expect(parseHealth(health({ certDaysRemaining: Number.NaN }))?.certDaysRemaining).toBeNull();
  });
});

describe("fetchHelperFonts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flattens every family's names, deduped case-insensitively, falling back to the family name", async () => {
    const f = fakeFetch({
      [url(47318, "/v1/fonts")]: jsonResponse({
        families: [
          { name: "Segoe UI", names: ["Segoe UI", "Segoe UI Semibold", "segoe ui"], sources: ["os"] },
          { name: "Gotham", sources: ["user"] },
          { name: "Avenir Next", names: [], sources: ["os"] },
          { name: 5, names: [7, "  Futura  ", ""] },
        ],
        generatedAt: "2026-10-01T10:00:00Z",
      }),
    });
    const fonts = await fetchHelperFonts(47318, f);
    expect(fonts).toEqual(["Segoe UI", "Segoe UI Semibold", "Gotham", "Avenir Next", "Futura"]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]?.cache).toBe("no-store");
  });

  it("caps name length and count", async () => {
    const many = Array.from({ length: 25_000 }, (_, i) => `Font ${i}`);
    const f = fakeFetch({
      [url(47317, "/v1/fonts")]: jsonResponse({ families: [{ name: "Big", names: ["x".repeat(201), ...many] }] }),
    });
    const fonts = await fetchHelperFonts(47317, f);
    expect(fonts).not.toBeNull();
    expect(fonts!.length).toBe(20_000);
    expect(fonts![0]).toBe("Font 0");
  });

  it("returns null when the list is malformed or the request fails", async () => {
    expect(await fetchHelperFonts(47317, fakeFetch({ [url(47317, "/v1/fonts")]: jsonResponse({ families: "no" }) }))).toBeNull();
    expect(await fetchHelperFonts(47317, fakeFetch({ [url(47317, "/v1/fonts")]: jsonResponse({}, 500) }))).toBeNull();
    expect(await fetchHelperFonts(47317, fakeFetch({}))).toBeNull();
    const p = fetchHelperFonts(47317, fakeFetch({ [url(47317, "/v1/fonts")]: hang }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeNull();
  });
});
