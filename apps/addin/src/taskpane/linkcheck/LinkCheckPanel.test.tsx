/**
 * Link reachability UI (U9 UI, R11, R18): Pro gating (D8), the one-time privacy disclosure, only
 * http/https addresses sent, progress + cancel, the summary, per-row statuses by icon shape and
 * text (D15), rate limits, an expired session, and results cleared by a new scan.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding } from "@slidefidelity/audit-core";
import type { Plan } from "../../license/gate";
import { hyperlinkFinding, target } from "../../office/fixes/testing/fakePowerPoint";
import type { LinkCheckDeps, LinkCheckReport, LinkCheckResult } from "../../office/linkCheck";
import { composeSlots } from "../context";
import { createFixSlots } from "../fixes";
import { fakeResult } from "../testing/fixtures";
import { all, button, cleanup, click, flush, one, renderPane } from "../testing/render";
import { createLinkCheckSlots, DISCLOSURE_TEXT, type LinkCheckSlotDeps } from "./index";

afterEach(cleanup);

const A = "https://a.example/";
const B = "http://b.example/x";
const C = "https://c.example/";
const D = "https://d.example/";

function link(address: string, slideNumber = 1, shapeId = 10): Finding {
  return hyperlinkFinding(address, target({ slideNumber, shapeId, shapeName: `Link ${shapeId}`, reachable: true }));
}

function deckFindings(): Finding[] {
  return [
    link(A, 1, 10),
    link(B, 1, 11),
    link(C, 2, 12),
    link(D, 2, 13),
    link("mailto:someone@example.com", 3, 14),
    link("file:///C:/Users/me/report.xlsx", 3, 15),
    link(A, 4, 16), // duplicate address
  ];
}

function report(results: LinkCheckResult[], error?: LinkCheckReport["error"]): LinkCheckReport {
  return { results, byUrl: Object.fromEntries(results.map((r) => [r.url, r])), requests: 1, ...(error ? { error } : {}) };
}

const MIXED = report([
  { url: A, status: "ok", httpStatus: 200 },
  { url: B, status: "broken", httpStatus: 404, reason: "not_found" },
  { url: C, status: "unverified", httpStatus: 403, reason: "access_denied" },
  { url: D, status: "not-checked", reason: "network-error" },
]);

interface Pending {
  urls: readonly string[];
  deps: LinkCheckDeps;
  resolve: (r: LinkCheckReport) => void;
}

/** A fake `checkLinks` that records calls and settles when the test says so (or rejects on abort). */
function fakeCheck() {
  const calls: Pending[] = [];
  const fn = vi.fn(
    (urls: readonly string[], deps: LinkCheckDeps) =>
      new Promise<LinkCheckReport>((resolve, reject) => {
        calls.push({ urls, deps, resolve });
        deps.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
  return { fn, calls };
}

function setup(o: { plan?: Plan; findings?: Finding[]; withFixes?: boolean; onSignIn?: () => void } = {}) {
  const check = fakeCheck();
  const onUnauthorized = vi.fn();
  const deps: LinkCheckSlotDeps = {
    baseUrl: "https://api.test",
    getToken: () => "sess_1",
    checkLinks: check.fn as unknown as NonNullable<LinkCheckSlotDeps["checkLinks"]>,
    onUnauthorized,
  };
  const linkSlots = createLinkCheckSlots(deps);
  const slots = o.withFixes
    ? composeSlots(
        createFixSlots({ run: () => Promise.reject(new Error("unused")), createPresentation: async () => {}, isSetSupported: () => true }),
        linkSlots,
      )
    : linkSlots;
  const pane = renderPane({
    result: fakeResult(o.findings ?? deckFindings()),
    plan: o.plan ?? "pro",
    state: { area: "links" },
    slots,
    ...(o.onSignIn ? { onSignIn: o.onSignIn } : {}),
  });
  return { ...pane, check, onUnauthorized };
}

const panel = (root: ParentNode) => one(root, "[data-linkcheck-panel]");

/** Click "Check links" and accept the disclosure when it shows. */
function startCheck(root: ParentNode) {
  click(button(panel(root), "Check links"));
  const disclosure = panel(root).querySelector("[data-linkcheck-disclosure]");
  if (disclosure) click(button(disclosure, "Continue"));
}

async function finish(check: ReturnType<typeof fakeCheck>, r: LinkCheckReport, i = check.calls.length - 1) {
  await act(async () => check.calls[i]!.resolve(r));
  await flush();
}

describe("gating (D8, KTD7)", () => {
  it.each([
    ["anonymous", "Sign in to start your 30-day free trial"],
    ["free", "Manage subscription"],
    ["expired", "Manage subscription"],
  ] as const)("%s gets no link-check panel or Check links button (the Links area lock already carries the %s call to action)", (plan, _cta) => {
    const { container, check } = setup({ plan });
    expect(container.querySelector("[data-linkcheck-panel]")).toBeNull();
    expect(all(container, "button").some((b) => b.textContent?.trim() === "Check links")).toBe(false);
    expect(check.fn).not.toHaveBeenCalled();
  });

  it("trial users can check links", () => {
    const { container } = setup({ plan: "trial" });
    expect(button(panel(container), "Check links").disabled).toBe(false);
  });

  it("is not offered outside the Links area or when the deck has no web links", () => {
    const { container } = setup({ findings: [link("mailto:x@example.com")] });
    expect(container.querySelector("[data-linkcheck-panel]")).toBeNull();
  });
});

describe("privacy disclosure (R18)", () => {
  it("is shown before the first check, and Cancel sends nothing", () => {
    const { container, check } = setup();
    click(button(panel(container), "Check links"));
    const d = one(panel(container), "[data-linkcheck-disclosure]");
    expect(d.textContent).toContain(DISCLOSURE_TEXT);
    expect(DISCLOSURE_TEXT).toBe(
      "Checking sends the web addresses (http/https only) in this deck to the SlideFidelity service. Nothing else from the deck is sent.",
    );
    click(button(d, "Cancel"));
    expect(container.querySelector("[data-linkcheck-disclosure]")).toBeNull();
    expect(check.fn).not.toHaveBeenCalled();
  });

  it("is remembered for the session once accepted", async () => {
    const { container, check } = setup();
    click(button(panel(container), "Check links"));
    click(button(one(container, "[data-linkcheck-disclosure]"), "Continue"));
    expect(check.fn).toHaveBeenCalledTimes(1);
    await finish(check, MIXED);
    click(button(panel(container), "Check links"));
    expect(container.querySelector("[data-linkcheck-disclosure]")).toBeNull();
    expect(check.fn).toHaveBeenCalledTimes(2);
  });
});

describe("checking", () => {
  it("sends only the deck's distinct http/https addresses, with the API base and the session token", async () => {
    const { container, check } = setup();
    startCheck(container);
    expect(check.calls).toHaveLength(1);
    const { urls, deps } = check.calls[0]!;
    expect([...urls].sort()).toEqual([A, B, C, D].sort());
    expect(urls.every((u) => /^https?:\/\//.test(u))).toBe(true);
    expect(deps.baseUrl).toBe("https://api.test");
    expect(await deps.getToken()).toBe("sess_1");
    expect(deps.signal).toBeInstanceOf(AbortSignal);
  });

  it("shows progress while checking, then the summary counts", async () => {
    const { container, check } = setup();
    startCheck(container);
    const progress = one(panel(container), "[data-linkcheck-progress]");
    expect(progress.textContent).toContain("Checking 4 links");
    expect(button(panel(container), "Check links").disabled).toBe(true);
    await finish(check, MIXED);
    expect(container.querySelector("[data-linkcheck-progress]")).toBeNull();
    expect(one(panel(container), "[data-linkcheck-summary]").textContent).toBe("1 OK, 1 broken, 1 could not verify, 1 not checked");
  });

  it("per-row statuses are text with a shape-coded icon, never links; addresses stay plain text", async () => {
    const { container, check } = setup();
    startCheck(container);
    await finish(check, MIXED);
    const statuses = all(container, "[role=tree] [data-link-status]");
    const byText = Object.fromEntries(statuses.map((s) => [s.textContent?.trim(), s.getAttribute("data-link-status")]));
    expect(byText).toMatchObject({
      OK: "ok",
      "Broken (404)": "broken",
      "Could not verify (access denied)": "unverified",
      "Not checked (no connection)": "not-checked",
    });
    // Both rows for the duplicated address show its status.
    expect(statuses.filter((s) => s.textContent?.trim() === "OK")).toHaveLength(2);
    for (const s of statuses) {
      expect(s.closest("a")).toBeNull();
      expect(s.querySelector("[data-link-status-icon]")).not.toBeNull();
    }
    const shapes = new Set(statuses.map((s) => s.querySelector("[data-link-status-icon]")!.getAttribute("data-link-status-icon")));
    expect(shapes.size).toBe(4);
    expect(container.querySelector("a[href]")).toBeNull();
    // Non-web links get no status.
    const mailRow = all(container, "[role=treeitem]").find((r) => r.textContent?.includes("mailto:") && r.getAttribute("aria-level") === "2");
    expect(mailRow?.querySelector("[data-link-status]")).toBeNull();
  });

  it("composes with the fix slots: both panels and both row entries render", async () => {
    const { container, check } = setup({ withFixes: true });
    expect(container.querySelector("[data-fix-panel=links]")).not.toBeNull();
    startCheck(container);
    await finish(check, MIXED);
    expect(all(container, "[role=tree] [data-row-fix]").length).toBeGreaterThan(0);
    expect(all(container, "[role=tree] [data-link-status]").length).toBeGreaterThan(0);
  });

  it("rate limited: says roughly how many minutes to wait", async () => {
    const { container, check } = setup();
    startCheck(container);
    await finish(
      check,
      report(
        [A, B, C, D].map((url) => ({ url, status: "not-checked" as const, reason: "rate-limited", retryAfterSeconds: 540 })),
        { code: "rate_limited", retryAfterSeconds: 540 },
      ),
    );
    const msg = one(panel(container), "[data-linkcheck-message]").textContent ?? "";
    expect(msg).toContain("Try again in about 9 minutes");
    expect(one(panel(container), "[data-linkcheck-summary]").textContent).toBe("0 OK, 0 broken, 0 could not verify, 4 not checked");
  });

  it("Cancel aborts the request and keeps no partial results", async () => {
    const { container, check } = setup();
    startCheck(container);
    click(button(panel(container), "Cancel"));
    await flush();
    expect(check.calls[0]!.deps.signal?.aborted).toBe(true);
    expect(container.querySelector("[data-linkcheck-progress]")).toBeNull();
    expect(one(panel(container), "[data-linkcheck-message]").textContent).toContain("Link check cancelled");
    expect(container.querySelector("[data-link-status]")).toBeNull();
  });

  it("an expired session (401) suggests signing in again and lets the license state catch up", async () => {
    const onSignIn = vi.fn();
    const { container, check, onUnauthorized } = setup({ onSignIn });
    startCheck(container);
    await finish(
      check,
      report([A, B, C, D].map((url) => ({ url, status: "not-checked" as const, reason: "unauthorized" })), { code: "unauthorized" }),
    );
    const msg = one(panel(container), "[data-linkcheck-message]");
    expect(msg.textContent).toContain("Sign in again");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    click(button(panel(container), "Sign in"));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("a new scan clears the results", async () => {
    const { container, check, scan } = setup();
    startCheck(container);
    await finish(check, MIXED);
    expect(container.querySelector("[data-link-status]")).not.toBeNull();
    click(button(container, "Rescan"));
    await act(async () => scan.resolve(fakeResult(deckFindings(), "hash2")));
    await flush();
    expect(container.querySelector("[data-link-status]")).toBeNull();
    expect(container.querySelector("[data-linkcheck-summary]")).toBeNull();
    // The disclosure stays accepted for the session.
    click(button(panel(container), "Check links"));
    expect(container.querySelector("[data-linkcheck-disclosure]")).toBeNull();
    expect(check.fn).toHaveBeenCalledTimes(2);
  });

  it("a new scan during a check aborts it and ignores its late answer", async () => {
    const { container, check, scan } = setup();
    startCheck(container);
    const first = check.calls[0]!;
    click(button(container, "Rescan"));
    await act(async () => scan.resolve(fakeResult(deckFindings(), "hash2")));
    await flush();
    expect(first.deps.signal?.aborted).toBe(true);
    await act(async () => first.resolve(MIXED));
    await flush();
    expect(container.querySelector("[data-link-status]")).toBeNull();
    expect(container.querySelector("[data-linkcheck-progress]")).toBeNull();
  });
});
