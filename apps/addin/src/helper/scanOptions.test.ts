/**
 * Integration (U12, R4): the scan service's options carry the helper's `localFonts` when Connected,
 * and the list is refetched before each user scan, so a rescan after a font install reflects it.
 */
import { describe, expect, it, vi } from "vitest";
import { summarize, type AuditResult } from "@slidefidelity/audit-core";
import { createScanService } from "../office/scan";
import type { AuditClient } from "../worker/client";
import { createBrandStore } from "../taskpane/brand/brandStore";
import { composeAuditOptions, createShowFontsStore } from "../taskpane/fonts/showFontsStore";
import { createHelperStore } from "./state";
import { fakeFetch, health, jsonResponse } from "./testing";

const url = (port: number, path: string) => `https://localhost:${port}${path}`;

function fontsBody(names: string[]) {
  return jsonResponse({ families: names.map((name) => ({ name, names: [name], sources: ["os"] })), generatedAt: "2026-10-01T10:00:00Z" });
}

function result(hash: string): AuditResult {
  return { findings: [], hash, stats: { slides: 1, shapes: 1, durationMs: 1, perArea: summarize([]) }, errors: [] };
}

function setup(routes: Record<string, unknown>) {
  const helper = createHelperStore({ fetch: fakeFetch(routes), platform: "mac", openBrowserWindow: vi.fn(), storage: null });
  const showFonts = createShowFontsStore({ storage: null });
  showFonts.set(["Gotham"]);
  const scan = vi.fn<AuditClient["scan"]>(async (_b, hash) => ({ result: result(hash) }));
  const client = { scan, cancel: vi.fn(), dispose: vi.fn(), busy: false };
  const svc = createScanService({
    readSnapshot: async () => ({ bytes: Uint8Array.from([1]), sha256: "h", sliceCount: 1 }),
    client,
    getOptions: composeAuditOptions(createBrandStore({ storage: null }), showFonts, helper),
    beforeScan: () => helper.beforeScan(),
  });
  return { helper, svc, scan };
}

describe("scan options with the helper", () => {
  it("include localFonts when Connected, and a rescan after a font-list change reflects it", async () => {
    const routes: Record<string, unknown> = {
      [url(47318, "/v1/health")]: jsonResponse(health()),
      [url(47318, "/v1/fonts")]: fontsBody(["Segoe UI"]),
    };
    const { helper, svc, scan } = setup(routes);
    await helper.start();
    await svc.scan();
    expect(scan.mock.calls[0]![2]).toEqual({ availableFonts: ["Gotham"], localFonts: ["Segoe UI"] });

    routes[url(47318, "/v1/fonts")] = fontsBody(["Segoe UI", "Gotham Rounded"]);
    await svc.scan();
    expect(scan.mock.calls[1]![2]).toEqual({ availableFonts: ["Gotham"], localFonts: ["Segoe UI", "Gotham Rounded"] });
  });

  it("omit localFonts without a helper (R3: behaves as today)", async () => {
    const { helper, svc, scan } = setup({});
    await helper.start();
    await svc.scan();
    expect(scan.mock.calls[0]![2]).toEqual({ availableFonts: ["Gotham"] });
  });

  it("drop localFonts when the helper stops answering before a rescan", async () => {
    const routes: Record<string, unknown> = {
      [url(47317, "/v1/health")]: jsonResponse(health()),
      [url(47317, "/v1/fonts")]: fontsBody(["Segoe UI"]),
    };
    const { helper, svc, scan } = setup(routes);
    await helper.start();
    delete routes[url(47317, "/v1/health")];
    delete routes[url(47317, "/v1/fonts")];
    await svc.scan();
    expect(scan.mock.calls[0]![2]).toEqual({ availableFonts: ["Gotham"] });
  });

  it("a failing beforeScan never fails the scan", async () => {
    const scan = vi.fn<AuditClient["scan"]>(async (_b, hash) => ({ result: result(hash) }));
    const svc = createScanService({
      readSnapshot: async () => ({ bytes: Uint8Array.from([1]), sha256: "h", sliceCount: 1 }),
      client: { scan, cancel: vi.fn(), dispose: vi.fn() },
      beforeScan: () => Promise.reject(new Error("boom")),
    });
    await expect(svc.scan()).resolves.toMatchObject({ hash: "h" });
  });
});
