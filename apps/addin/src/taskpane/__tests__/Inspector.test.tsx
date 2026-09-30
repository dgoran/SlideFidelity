import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPresentation, runChecks, type AuditResult } from "@slidecheck/audit-core";
import { corpusDeck, type CorpusName } from "../../../../../packages/audit-core/test/helpers/corpus";
import { buildScanInventory, type ScanInventory } from "../../inspector/model";
import type { NavigateResult } from "../../office/navigate";
import type { SelectedShape, SelectionResult, SelectionWatcher, SelectionWatcherDeps } from "../../office/selection";
import { Inspector, InspectorView, isOpenableUrl } from "../components/Inspector";
import { all, button, cleanup, click, flush, one, render, renderPane } from "../testing/render";
import { deckResult } from "./deck";

afterEach(cleanup);

const scans = new Map<CorpusName, Promise<{ audit: AuditResult; inventory: ScanInventory }>>();
function scan(name: CorpusName) {
  let p = scans.get(name);
  if (!p) {
    p = (async () => {
      const bytes = await corpusDeck(name);
      return { audit: await runChecks(bytes), inventory: await buildScanInventory(await loadPresentation(bytes)) };
    })();
    scans.set(name, p);
  }
  return p;
}

const PT = 72;
function shape(liveId: string, name: string, leftIn: number, topIn: number, type = "GeometricShape"): SelectedShape {
  return { liveId, name, left: leftIn * PT, top: topIn * PT, width: 100, height: 50, type };
}
function sel(slideId: number | string, index: number, shapes: SelectedShape[] = []): SelectionResult {
  return { status: "ok", unsupported: false, slides: [{ liveId: typeof slideId === "number" ? `${slideId}#` : slideId, index }], shapes };
}

function fakeWatcher(initial: SelectionResult, log: string[] = []) {
  let onChange: ((s: SelectionResult) => void) | undefined;
  const watcher: SelectionWatcher = {
    start: vi.fn(async () => {
      log.push("start");
      return { ok: true as const };
    }),
    read: vi.fn(async () => {
      log.push("read");
      return initial;
    }),
    ignoreNext: vi.fn(() => {
      log.push("ignoreNext");
    }),
    dispose: vi.fn(async () => {
      log.push("dispose");
    }),
  };
  const factory = vi.fn((deps: SelectionWatcherDeps) => {
    onChange = deps.onChange;
    return watcher;
  });
  return { factory, watcher, log, emit: (s: SelectionResult) => act(() => onChange?.(s)) };
}

async function renderInspector(name: CorpusName, selection: SelectionResult, opts: { plan?: "anonymous" | "pro"; openBrowserWindow?: (u: string) => void } = {}) {
  const { audit, inventory } = await scan(name);
  const w = fakeWatcher(selection);
  const r = renderPane({
    plan: opts.plan ?? "pro",
    state: { scan: { status: "ready", result: audit, scannedAt: 0, possiblyOutdated: false, inventory } },
    slots: { inspectorSlot: <Inspector createWatcher={w.factory} {...(opts.openBrowserWindow ? { openBrowserWindow: opts.openBrowserWindow } : {})} /> },
  });
  await flush();
  return { ...r, w, inspector: one(r.container, "[data-inspector]") };
}

describe("Inspector (U11)", () => {
  it("starts the watcher, then reads the selection; disposes on unmount", async () => {
    const { w, unmount } = await renderInspector("fonts-hidden", sel(256, 0));
    expect(w.factory).toHaveBeenCalledTimes(1);
    expect(w.log).toEqual(["start", "read"]);
    unmount();
    expect(w.watcher.dispose).toHaveBeenCalled();
  });

  it("AE1 text box: fonts with script and source labels and a Hidden list styles node", async () => {
    const { inspector } = await renderInspector("fonts-hidden", sel(256, 0, [shape("4", "TextBox 3", 1, 2)]));
    const rows = all(inspector, "[data-font-row]");
    expect(rows.map((r) => r.getAttribute("data-font-row"))).toEqual(["latin", "ea", "bu"]);
    expect(rows[0]!.textContent).toContain("Calibri");
    expect(rows[0]!.textContent).toContain("Latin · Direct formatting");
    expect(rows[1]!.textContent).toContain("MS Gothic");
    expect(rows[1]!.textContent).toContain("East Asian");
    expect(rows[2]!.textContent).toContain("Wingdings");
    expect(rows[2]!.textContent).toContain("Bullet · Hidden list style");
    const hidden = one(inspector, "[data-hidden-list-styles]");
    expect(hidden.textContent).toContain("Hidden list styles");
    expect(hidden.textContent).toContain("Wingdings");
    expect(inspector.querySelector('[data-inspector-finding="hidden-list-style"]')).not.toBeNull();
    expect(inspector.querySelector("[data-may-be-outdated]")).toBeNull();
  });

  it("rebuilds the model when the selection changes", async () => {
    const { inspector, w } = await renderInspector("fonts-hidden", sel(256, 0));
    expect(one(inspector, "[data-inspector-kind]").getAttribute("data-inspector-kind")).toBe("slides");
    w.emit(sel(256, 0, [shape("4", "TextBox 3", 1, 2)]));
    expect(one(inspector, "[data-inspector-kind]").getAttribute("data-inspector-kind")).toBe("shape");
  });

  it("image details: native size, effective PPI, and scale", async () => {
    const { inspector } = await renderInspector("media-bloat", sel(256, 0, [shape("2", "Oversized photo", 1, 1, "Image")]));
    expect(one(inspector, "[data-image-native]").textContent).toBe("4000 × 3000 px");
    expect(one(inspector, "[data-image-ppi]").textContent).toBe("2000");
    expect(one(inspector, "[data-image-scale]").textContent).toBe("100% × 100%");
  });

  it("a shape created after the scan shows not-in-scan and the out-of-date hint", async () => {
    const { inspector } = await renderInspector("fonts-hidden", sel(256, 0, [shape("999", "New shape", 5, 5)]));
    expect(inspector.querySelector("[data-not-in-scan]")?.textContent).toBe("Not in last scan — rescan");
    expect(inspector.querySelector("[data-may-be-outdated]")).not.toBeNull();
  });

  it("marks a fallback match as approximate", async () => {
    const { inspector } = await renderInspector("fonts-hidden", sel(256, 0, [shape("not-a-number", "TextBox 3", 1, 2)]));
    expect(inspector.querySelector("[data-approximate]")?.textContent).toBe("approximate match");
  });

  it("links render as text; only a checkable http(s) link gets an Open button that uses openBrowserWindow", async () => {
    const open = vi.fn();
    const { inspector } = await renderInspector("links", sel(256, 0, [shape("2", "Text links", 1, 1)]), { openBrowserWindow: open });
    expect(inspector.querySelector("a")).toBeNull();
    expect(one(inspector, "[data-link-address]").textContent).toBe("https://example.com/a");
    click(button(inspector, "Open link in browser"));
    expect(open).toHaveBeenCalledWith("https://example.com/a");
  });

  it("a linked local file is never openable", async () => {
    const { inspector } = await renderInspector("links", sel(257, 1, [shape("3", "Linked Worksheet", 1, 3, "Unsupported")]));
    expect(inspector.querySelector("a")).toBeNull();
    expect(inspector.textContent).toContain("points to a local file");
    expect(all(inspector, "button").some((b) => b.getAttribute("aria-label") === "Open link in browser")).toBe(false);
  });

  it("is locked for anonymous users and never starts a watcher", async () => {
    const { inspector, w } = await renderInspector("fonts-hidden", sel(256, 0), { plan: "anonymous" });
    expect(one(inspector, "[data-locked-section]").getAttribute("aria-label")).toBe("Inspector (Pro)");
    expect(one(inspector, "[data-lock-action]").textContent).toBe("Sign in to start your 30-day free trial");
    expect(w.factory).not.toHaveBeenCalled();
  });

  it("collapses (disposing the watcher) and expands with the keyboard-operable toggle", async () => {
    const { inspector, w } = await renderInspector("fonts-hidden", sel(256, 0));
    const toggle = button(inspector, "Collapse Inspector");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    click(toggle);
    expect(w.watcher.dispose).toHaveBeenCalled();
    expect(button(inspector, "Expand Inspector").getAttribute("aria-expanded")).toBe("false");
  });

  it("Show in PowerPoint tells the watcher to ignore the next selection change before navigating", async () => {
    const log: string[] = [];
    const w = fakeWatcher(sel(256, 0), log);
    const { container } = renderPane({
      result: deckResult(),
      state: { area: "fonts" },
      navigate: async (): Promise<NavigateResult> => {
        log.push("navigate");
        return { kind: "not-found" };
      },
      slots: { inspectorSlot: <Inspector createWatcher={w.factory} /> },
    });
    await flush();
    const show = all(container, '[role="treeitem"] button').find((b) => b.getAttribute("aria-label") === "Show in PowerPoint")!;
    click(show);
    await flush();
    expect(log.slice(-2)).toEqual(["ignoreNext", "navigate"]);
  });
});

describe("InspectorView states", () => {
  it.each([
    [{ kind: "unsupported" } as const, "needs a newer version of PowerPoint"],
    [{ kind: "no-scan" } as const, "Scan the presentation"],
    [{ kind: "empty" } as const, "Select a slide or shape"],
    [{ kind: "error", message: "boom" } as const, "couldn't report the current selection"],
  ])("%o", (model, text) => {
    const { container } = render(<InspectorView model={model} />);
    expect(container.textContent).toContain(text);
  });

  it("multi-selection shows a count and the not-in-scan count", () => {
    const { container } = render(
      <InspectorView
        model={{
          kind: "multi",
          count: 2,
          shapes: [
            { liveId: "1", name: "A", type: "Image", status: "matched" },
            { liveId: "2", name: "B", type: "Image", status: "not-in-scan", message: "Not in last scan — rescan" },
          ],
          findings: [],
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          notInScanCount: 1,
          mayBeOutOfDate: true,
        }}
      />,
    );
    expect(container.textContent).toContain("2 shapes selected");
    expect(container.textContent).toContain("1 of them is not in the last scan");
    expect(container.querySelector("[data-may-be-outdated]")).not.toBeNull();
  });
});

describe("isOpenableUrl", () => {
  it("accepts only absolute http(s) URLs", () => {
    expect(isOpenableUrl("https://example.com")).toBe(true);
    expect(isOpenableUrl("http://example.com/x")).toBe(true);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///C:/x")).toBe(false);
    expect(isOpenableUrl("//example.com")).toBe(false);
    expect(isOpenableUrl("https://")).toBe(false);
  });
});
