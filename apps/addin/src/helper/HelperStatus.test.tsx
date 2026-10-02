/**
 * SlideCheck Helper status and offer (U12): one test per visible state, the buttons call the store,
 * and the Problems Fonts row renders the status through `helperSlot`.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeResult, slideShape } from "../taskpane/testing/fixtures";
import { fontMissingHere, fontSummary } from "../taskpane/testing/problemFindings";
import { button, cleanup, click, one, render, renderPane } from "../taskpane/testing/render";
import { HelperStatus, type HelperStatusStore } from "./HelperStatus";
import { OFFER_SECONDARY, OFFER_TEXT } from "./HelperOffer";
import { createHelperStore, type HelperSnapshot } from "./state";
import { fakeFetch, health, jsonResponse } from "./testing";

afterEach(cleanup);

function fakeStore(over: Partial<HelperSnapshot>) {
  const snap: HelperSnapshot = { phase: "probing", platform: "mac", health: null, port: null, fonts: null, reason: null, dismissPersistent: true, ...over };
  return {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    install: vi.fn(),
    cancelInstall: vi.fn(),
    notNow: vi.fn(),
    dontAskAgain: vi.fn(),
    openDownloadPage: vi.fn(),
    openUpdatePage: vi.fn(),
  } satisfies HelperStatusStore;
}

const h = (o: Record<string, unknown> = {}) => ({ version: "0.1.0", apiVersion: 1, platform: "mac", certDaysRemaining: 823, update: null, ...o }) as HelperSnapshot["health"];

describe("HelperStatus", () => {
  it("probing", () => {
    const { container } = render(<HelperStatus store={fakeStore({})} placement="problems" />);
    expect(container.textContent).toContain("Checking for SlideCheck Helper");
  });

  it("connected: exact font check on, no notices when current", () => {
    const { container } = render(<HelperStatus store={fakeStore({ phase: "connected", health: h(), fonts: ["Arial"] })} placement="problems" />);
    expect(one(container, "[data-helper-status]").getAttribute("data-helper-status")).toBe("connected");
    expect(container.textContent).toContain("Exact font check: on (SlideCheck Helper v0.1.0)");
    expect(container.querySelector("[data-helper-update]")).toBeNull();
    expect(container.querySelector("[data-helper-cert]")).toBeNull();
  });

  it("connected with an update (H5): notice and a button that opens the update page", () => {
    const store = fakeStore({ phase: "connected", health: h({ update: { version: "0.2.0", page: "https://slidecheck.io/helper", notes: "<b>Faster</b>" } }) });
    const { container } = render(<HelperStatus store={store} placement="settings" />);
    expect(container.textContent).toContain("Helper update available (v0.2.0)");
    expect(container.textContent).toContain("<b>Faster</b>"); // text, not markup
    expect(container.querySelector("b")).toBeNull();
    click(button(container, "Get the update"));
    expect(store.openUpdatePage).toHaveBeenCalledTimes(1);
  });

  it("connected with a certificate expiring within 90 days (H1): note and download", () => {
    const store = fakeStore({ phase: "connected", health: h({ certDaysRemaining: 12 }) });
    const { container } = render(<HelperStatus store={store} placement="problems" />);
    expect(container.textContent).toContain("The helper's certificate expires in 12 days. Reinstall SlideCheck Helper to renew it.");
    click(button(container, "Download SlideCheck Helper"));
    expect(store.openDownloadPage).toHaveBeenCalledTimes(1);
  });

  it("no certificate note at 90 days or more, or when unknown", () => {
    for (const days of [90, null]) {
      const { container, unmount } = render(<HelperStatus store={fakeStore({ phase: "connected", health: h({ certDaysRemaining: days }) })} placement="problems" />);
      expect(container.querySelector("[data-helper-cert]")).toBeNull();
      unmount();
    }
  });

  it("offered: the offer text, the H2 line, and Install / Not now / Don't ask again", () => {
    const store = fakeStore({ phase: "offered" });
    const { container } = render(<HelperStatus store={store} placement="problems" />);
    expect(container.textContent).toContain(OFFER_TEXT);
    expect(OFFER_TEXT).toBe("Install SlideCheck Helper for exact missing-font checks");
    expect(container.textContent).toContain(OFFER_SECONDARY);
    click(button(container, "Install"));
    click(button(container, "Not now"));
    click(button(container, "Don't ask again"));
    expect(store.install).toHaveBeenCalledTimes(1);
    expect(store.notNow).toHaveBeenCalledTimes(1);
    expect(store.dontAskAgain).toHaveBeenCalledTimes(1);
  });

  it("waiting: text and Cancel", () => {
    const store = fakeStore({ phase: "waiting" });
    const { container } = render(<HelperStatus store={store} placement="problems" />);
    expect(container.textContent).toContain("Waiting for SlideCheck Helper…");
    click(button(container, "Cancel"));
    expect(store.cancelInstall).toHaveBeenCalledTimes(1);
  });

  it("silent on the web: show-machine list, no offer, nothing to click", () => {
    const { container } = render(<HelperStatus store={fakeStore({ phase: "silent", platform: "other", reason: "host" })} placement="settings" />);
    expect(container.textContent).toContain("Using show-machine list");
    expect(container.textContent).not.toContain(OFFER_TEXT);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("silent after Don't ask again: Settings can still start the install", () => {
    const store = fakeStore({ phase: "silent", reason: "dismissed" });
    const problems = render(<HelperStatus store={store} placement="problems" />);
    expect(problems.container.querySelectorAll("button")).toHaveLength(0);
    const settings = render(<HelperStatus store={store} placement="settings" />);
    click(button(settings.container, "Install SlideCheck Helper"));
    expect(store.install).toHaveBeenCalledTimes(1);
  });

  it("outdated: too old, with a download that starts the install", () => {
    const store = fakeStore({ phase: "outdated", health: h({ version: "0.0.9", apiVersion: 0 }) });
    const { container } = render(<HelperStatus store={store} placement="problems" />);
    expect(container.textContent).toContain("SlideCheck Helper v0.0.9 is too old for this version of SlideCheck");
    click(button(container, "Download the latest SlideCheck Helper"));
    expect(store.install).toHaveBeenCalledTimes(1);
  });

  it("follows the real store from offered to waiting to connected without a reload (AE2)", async () => {
    vi.useFakeTimers();
    try {
      const routes: Record<string, unknown> = {};
      const open = vi.fn();
      const store = createHelperStore({ fetch: fakeFetch(routes), platform: "mac", openBrowserWindow: open, storage: null });
      const { container } = render(<HelperStatus store={store} placement="problems" />);
      await act(async () => store.start());
      click(button(container, "Install"));
      expect(open).toHaveBeenCalledWith("https://slidecheck.io/helper?platform=mac");
      expect(container.textContent).toContain("Waiting for SlideCheck Helper…");
      routes["https://localhost:47317/v1/health"] = jsonResponse(health({ version: "0.1.0" }));
      routes["https://localhost:47317/v1/fonts"] = jsonResponse({ families: [{ name: "Arial", names: ["Arial"] }] });
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(container.textContent).toContain("Exact font check: on (SlideCheck Helper v0.1.0)");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Problems Fonts row", () => {
  it("shows the helper status through helperSlot, and a missing-here font as the problem", () => {
    const store = fakeStore({ phase: "connected", health: h(), fonts: ["Arial"] });
    const result = fakeResult([fontMissingHere("Gotham", [slideShape(1, 2)]), fontSummary(false, 0, { missingHere: 1 })]);
    const { container } = renderPane({ result, slots: { helperSlot: ({ placement }) => <HelperStatus store={store} placement={placement} /> } });
    const fonts = one(container, '[data-category="fonts"]');
    expect(fonts.getAttribute("data-status")).toBe("warning");
    click(one(fonts, "[data-category-toggle]"));
    expect(fonts.textContent).toContain("Exact font check: on (SlideCheck Helper v0.1.0)");
    expect(fonts.querySelector('[data-problem="font-missing-here"]')).not.toBeNull();
    // The helper list is in use: no "set a show-machine list" nag.
    expect(fonts.querySelector("[data-show-fonts-hint]")).toBeNull();
  });
});
