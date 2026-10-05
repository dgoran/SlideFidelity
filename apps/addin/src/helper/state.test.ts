/**
 * SlideFidelity Helper pane state machine (U12, HTD "Pane helper-state machine"): Probing → Connected |
 * Outdated | Absent; Absent → Offered | Silent; Offered → WaitingForInstall → Connected | Offered;
 * Connected → Absent when a later probe fails. Fake fetch, fake timers, injected storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelperStore, HELPER_DISMISS_KEY, helperDownloadUrl, type HelperStoreOptions } from "./state";
import { fakeFetch, hang, health, jsonResponse } from "./testing";

const url = (port: number, path: string) => `https://localhost:${port}${path}`;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

const throwingStorage = () => ({
  getItem: vi.fn(() => {
    throw new Error("SecurityError");
  }),
  setItem: vi.fn(() => {
    throw new Error("QuotaExceeded");
  }),
  removeItem: vi.fn(() => {
    throw new Error("SecurityError");
  }),
});

/** Routes for a helper answering on `port` with `fonts`. */
function helperRoutes(port: number, fonts: string[] = ["Segoe UI", "Gotham"], over: Record<string, unknown> = {}) {
  return {
    [url(port, "/v1/health")]: jsonResponse(health(over)),
    [url(port, "/v1/fonts")]: jsonResponse({ families: fonts.map((name) => ({ name, names: [name], sources: ["os"] })), generatedAt: "2026-10-01T10:00:00Z" }),
  };
}

function make(o: Partial<Omit<HelperStoreOptions, "fetch">> & { routes?: Record<string, unknown> } = {}) {
  const { routes, ...rest } = o;
  const open = vi.fn();
  const fetch = fakeFetch(routes ?? {});
  const store = createHelperStore({ platform: "mac", openBrowserWindow: open, storage: memoryStorage(), ...rest, fetch });
  return { store, open, fetch };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("helper store: probing", () => {
  it("connects to the helper on 47318 and fetches the font list once", async () => {
    const { store, fetch } = make({ routes: helperRoutes(47318) });
    expect(store.getSnapshot().phase).toBe("probing");
    await store.start();
    const snap = store.getSnapshot();
    expect(snap).toMatchObject({ phase: "connected", port: 47318, health: { version: "0.1.0" } });
    expect(snap.fonts).toEqual(["Segoe UI", "Gotham"]);
    expect(fetch.mock.calls.filter((c) => c[0] === url(47318, "/v1/fonts"))).toHaveLength(1);
    expect(store.auditOptions()).toEqual({ localFonts: ["Segoe UI", "Gotham"] });
  });

  it("start() probes once even when called again", async () => {
    const { store, fetch } = make({ routes: helperRoutes(47317) });
    await Promise.all([store.start(), store.start()]);
    await store.start();
    expect(fetch.mock.calls.filter((c) => String(c[0]).endsWith("/v1/health"))).toHaveLength(3);
  });

  it("an incompatible apiVersion → outdated, with no local fonts", async () => {
    const { store, open } = make({ routes: { [url(47317, "/v1/health")]: jsonResponse(health({ apiVersion: 2, version: "0.9.0" })) } });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ phase: "outdated", health: { version: "0.9.0" } });
    expect(store.auditOptions()).toEqual({});
    store.openDownloadPage();
    expect(open).toHaveBeenCalledWith("https://slidefidelity.com/helper?platform=mac");
  });

  it("no answer within 1.5 s on any port → offered on a desktop host", async () => {
    const routes = { [url(47317, "/v1/health")]: hang, [url(47318, "/v1/health")]: hang, [url(47319, "/v1/health")]: hang };
    const { store } = make({ routes });
    const started = store.start();
    await vi.advanceTimersByTimeAsync(1500);
    await started;
    expect(store.getSnapshot().phase).toBe("offered");
    expect(store.auditOptions()).toEqual({});
  });

  it("health answers but the font list fails → treated as absent (no local list)", async () => {
    const { store } = make({ routes: { [url(47317, "/v1/health")]: jsonResponse(health()), [url(47317, "/v1/fonts")]: jsonResponse({ nope: 1 }) } });
    await store.start();
    expect(store.getSnapshot().phase).toBe("offered");
    expect(store.auditOptions()).toEqual({});
  });
});

describe("helper store: hosts (AE3)", () => {
  it.each(["other"] as const)("on a %s host (web, iPad, mobile) it never probes, offers, or polls", async (platform) => {
    const { store, fetch } = make({ platform, routes: {} });
    expect(store.getSnapshot().phase).toBe("silent");
    await store.start();
    store.install();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(store.getSnapshot()).toMatchObject({ phase: "silent", reason: "host" });
    expect(fetch).not.toHaveBeenCalled();
    await store.beforeScan();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the Windows download URL names the platform", () => {
    expect(helperDownloadUrl("windows")).toBe("https://slidefidelity.com/helper?platform=windows");
    expect(helperDownloadUrl("mac")).toBe("https://slidefidelity.com/helper?platform=mac");
  });
});

describe("helper store: install (AE2, R6)", () => {
  it("Install opens the platform page, polls every 3 s, and flips to connected when health answers", async () => {
    const routes: Record<string, unknown> = {};
    const { store, open, fetch } = make({ platform: "windows", routes });
    // fakeFetch reads routes by reference at call time
    await store.start();
    expect(store.getSnapshot().phase).toBe("offered");
    store.install();
    expect(open).toHaveBeenCalledWith("https://slidefidelity.com/helper?platform=windows");
    expect(store.getSnapshot().phase).toBe("waiting");
    const healthCalls = () => fetch.mock.calls.filter((c) => String(c[0]).endsWith("/v1/health")).length;
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(3000);
    expect(healthCalls()).toBe(before + 3);
    expect(store.getSnapshot().phase).toBe("waiting");
    Object.assign(routes, helperRoutes(47317, ["Calibri"]));
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getSnapshot()).toMatchObject({ phase: "connected", port: 47317, fonts: ["Calibri"] });
    const settled = healthCalls();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(healthCalls()).toBe(settled); // polling stopped
  });

  it("5 minutes without a helper → back to offered, and polling stops", async () => {
    const { store, fetch } = make({ routes: {} });
    await store.start();
    store.install();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 3000);
    expect(store.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getSnapshot().phase).toBe("offered");
    const n = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.mock.calls.length).toBe(n);
  });

  it("Cancel stops waiting and returns to the offer", async () => {
    const { store, fetch } = make({ routes: {} });
    await store.start();
    store.install();
    store.cancelInstall();
    expect(store.getSnapshot().phase).toBe("offered");
    const n = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.mock.calls.length).toBe(n);
  });

  it("an outdated helper can be updated the same way", async () => {
    const routes: Record<string, unknown> = { [url(47317, "/v1/health")]: jsonResponse(health({ apiVersion: 0 })) };
    const { store, open } = make({ routes });
    await store.start();
    expect(store.getSnapshot().phase).toBe("outdated");
    store.install();
    expect(open).toHaveBeenCalledWith("https://slidefidelity.com/helper?platform=mac");
    Object.assign(routes, helperRoutes(47317));
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getSnapshot().phase).toBe("connected");
  });
});

describe("helper store: dismissal", () => {
  it("Not now hides the offer for this session only", async () => {
    const storage = memoryStorage();
    const { store } = make({ storage, routes: {} });
    await store.start();
    store.notNow();
    expect(store.getSnapshot()).toMatchObject({ phase: "silent", reason: "not-now" });
    expect(storage.setItem).not.toHaveBeenCalled();
    const again = make({ storage, routes: {} }).store;
    await again.start();
    expect(again.getSnapshot().phase).toBe("offered");
  });

  it("Don't ask again persists across a new store instance", async () => {
    const storage = memoryStorage();
    const { store } = make({ storage, routes: {} });
    await store.start();
    store.dontAskAgain();
    expect(store.getSnapshot()).toMatchObject({ phase: "silent", reason: "dismissed" });
    expect(storage.data.get(HELPER_DISMISS_KEY)).toBe("1");
    const again = make({ storage, routes: {} }).store;
    await again.start();
    expect(again.getSnapshot()).toMatchObject({ phase: "silent", reason: "dismissed" });
  });

  it("a dismissed user still gets the exact check when the helper is running", async () => {
    const storage = memoryStorage({ [HELPER_DISMISS_KEY]: "1" });
    const { store } = make({ storage, routes: helperRoutes(47319) });
    await store.start();
    expect(store.getSnapshot().phase).toBe("connected");
  });

  it("storage that throws → the dismissal lasts for this session only, no throw", async () => {
    const storage = throwingStorage();
    const { store } = make({ storage, routes: {} });
    await store.start();
    expect(store.getSnapshot().phase).toBe("offered");
    expect(() => store.dontAskAgain()).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({ phase: "silent", reason: "dismissed", dismissPersistent: false });
    const again = make({ storage, routes: {} }).store;
    await again.start();
    expect(again.getSnapshot().phase).toBe("offered");
  });
});

describe("helper store: freshness before a scan (R4)", () => {
  it("refetches the font list before each scan, so a changed list is reflected", async () => {
    const routes: Record<string, unknown> = helperRoutes(47318, ["Segoe UI"]);
    const { store } = make({ routes });
    await store.start();
    expect(store.auditOptions()).toEqual({ localFonts: ["Segoe UI"] });
    Object.assign(routes, helperRoutes(47318, ["Segoe UI", "Gotham"]));
    await store.beforeScan();
    expect(store.auditOptions()).toEqual({ localFonts: ["Segoe UI", "Gotham"] });
  });

  it("when the helper stops answering, the next scan re-probes and falls back (connected → absent)", async () => {
    const routes: Record<string, unknown> = helperRoutes(47318);
    const { store } = make({ routes });
    await store.start();
    for (const k of Object.keys(routes)) delete routes[k];
    await store.beforeScan();
    expect(store.getSnapshot().phase).toBe("offered");
    expect(store.auditOptions()).toEqual({});
  });

  it("when the helper moved ports, the re-probe finds it", async () => {
    const routes: Record<string, unknown> = helperRoutes(47317);
    const { store } = make({ routes });
    await store.start();
    for (const k of Object.keys(routes)) delete routes[k];
    Object.assign(routes, helperRoutes(47319, ["Avenir Next"]));
    await store.beforeScan();
    expect(store.getSnapshot()).toMatchObject({ phase: "connected", port: 47319 });
    expect(store.auditOptions()).toEqual({ localFonts: ["Avenir Next"] });
  });

  it("notifies subscribers on every change", async () => {
    const { store } = make({ routes: helperRoutes(47317) });
    const l = vi.fn();
    const off = store.subscribe(l);
    await store.start();
    expect(l).toHaveBeenCalled();
    off();
    l.mockClear();
    store.notNow(); // not offered: no-op
    expect(l).not.toHaveBeenCalled();
  });
});
