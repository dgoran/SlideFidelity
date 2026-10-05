import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "@slidefidelity/audit-core";
import { all, button, changeValue, cleanup, click, flush, focus, keyDown, one, renderPane } from "../testing/render";
import { fakeFinding, fakeResult, slideShape } from "../testing/fixtures";
import { ROW_HEIGHT } from "../components/FindingsTree";

afterEach(cleanup);

const rows = (root: HTMLElement) => all(root, '[role="treeitem"]');
const primaryText = (row: HTMLElement) => row.querySelector("span > span")?.textContent ?? "";
const groupLabels = (root: HTMLElement) => rows(root).filter((r) => r.getAttribute("aria-level") === "1").map(primaryText);

function fontFindings(): Finding[] {
  return [
    fakeFinding({ area: "fonts", group: "Calibri", title: "Calibri", count: 40, targets: [slideShape(1, 2), slideShape(2, 3)] }),
    fakeFinding({ area: "fonts", group: "Wingdings", title: "Wingdings", count: 90 }),
    fakeFinding({ area: "fonts", group: "Comic Sans MS", title: "Comic Sans MS", count: 3, severity: "warning", targets: [slideShape(3, 4, "Title 1")] }),
  ];
}

function renderFonts(findings: Finding[] = fontFindings(), extra: Parameters<typeof renderPane>[0] = {}) {
  return renderPane({ result: fakeResult(findings), state: { area: "fonts" }, ...extra });
}

describe("FindingsTree grouping, sorting, filtering (D14)", () => {
  it("groups per area with warnings first, then by count", () => {
    const { container } = renderFonts();
    expect(groupLabels(container)).toEqual(["Comic Sans MS", "Wingdings", "Calibri"]);
  });

  it("colors group by hex, links by address, media issues by type plus a size list", () => {
    const r = renderPane({
      result: fakeResult([
        fakeFinding({ area: "media", kind: "media-size", group: "ppt/media/a.png", title: "a.png", data: { bytes: 1 } }),
        fakeFinding({ area: "media", kind: "media-size", group: "ppt/media/b.png", title: "b.png", data: { bytes: 9 } }),
        fakeFinding({ area: "media", kind: "image-issue", group: "oversized", groupLabel: "Oversized images", severity: "warning" }),
      ]),
      state: { area: "media" },
    });
    expect(groupLabels(r.container)).toEqual(["Oversized images", "Media by size"]);
    const sizeRows = rows(r.container).filter((x) => x.getAttribute("aria-level") === "2").map(primaryText);
    expect(sizeRows.slice(1)).toEqual(["b.png", "a.png"]);
  });

  it("filters by severity", () => {
    const { container } = renderFonts();
    changeValue(one(container, "select:not([data-area-picker])") as HTMLSelectElement, "warning");
    expect(groupLabels(container)).toEqual(["Comic Sans MS"]);
    changeValue(one(container, "select:not([data-area-picker])") as HTMLSelectElement, "info");
    expect(groupLabels(container)).toEqual(["Wingdings", "Calibri"]);
  });

  it("filters by search text", () => {
    const { container } = renderFonts();
    changeValue(one(container, 'input[type="search"]') as HTMLInputElement, "wing");
    expect(groupLabels(container)).toEqual(["Wingdings"]);
    changeValue(one(container, 'input[type="search"]') as HTMLInputElement, "zzz");
    expect(rows(container)).toHaveLength(0);
    expect(container.textContent).toContain("No findings match the current filter.");
  });
});

describe("FindingsTree accessibility and keyboard (D15)", () => {
  it("rows carry tree semantics", () => {
    const { container } = renderFonts();
    expect(one(container, '[role="tree"]').getAttribute("aria-label")).toBe("Fonts findings");
    const [g1, f1] = rows(container);
    expect(g1!.getAttribute("aria-level")).toBe("1");
    expect(g1!.getAttribute("aria-posinset")).toBe("1");
    expect(g1!.getAttribute("aria-setsize")).toBe("3");
    expect(g1!.getAttribute("aria-expanded")).toBe("true");
    expect(f1!.getAttribute("aria-level")).toBe("2");
    expect(f1!.getAttribute("aria-setsize")).toBe("1");
    expect(f1!.hasAttribute("aria-expanded")).toBe(false);
    // Roving tab index: exactly one row in the tab order.
    expect(rows(container).filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("Up/Down/Home/End move focus; Left/Right collapse and expand", () => {
    const { container } = renderFonts();
    const first = rows(container)[0]!;
    focus(first);
    keyDown(first, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Comic Sans MS");
    expect((document.activeElement as HTMLElement).getAttribute("aria-level")).toBe("2");
    keyDown(document.activeElement!, "End");
    expect(document.activeElement?.textContent).toContain("Calibri");
    expect((document.activeElement as HTMLElement).getAttribute("aria-level")).toBe("2");
    const calibri = document.activeElement as HTMLElement;
    expect(calibri.getAttribute("aria-expanded")).toBe("false");
    keyDown(calibri, "ArrowRight");
    const expanded = rows(container).find((r) => r.getAttribute("aria-expanded") === "true" && r.getAttribute("aria-level") === "2");
    expect(expanded).toBeTruthy();
    expect(rows(container).filter((r) => r.getAttribute("aria-level") === "3")).toHaveLength(2);
    keyDown(document.activeElement!, "ArrowRight");
    expect((document.activeElement as HTMLElement).getAttribute("aria-level")).toBe("3");
    expect((document.activeElement as HTMLElement).getAttribute("aria-posinset")).toBe("1");
    keyDown(document.activeElement!, "ArrowLeft");
    expect((document.activeElement as HTMLElement).getAttribute("aria-level")).toBe("2");
    keyDown(document.activeElement!, "ArrowLeft");
    expect(rows(container).filter((r) => r.getAttribute("aria-level") === "3")).toHaveLength(0);
    keyDown(document.activeElement!, "ArrowLeft");
    expect((document.activeElement as HTMLElement).getAttribute("aria-level")).toBe("1");
    keyDown(document.activeElement!, "ArrowLeft");
    expect((document.activeElement as HTMLElement).getAttribute("aria-expanded")).toBe("false");
    keyDown(document.activeElement!, "Home");
    expect(document.activeElement).toBe(rows(container)[0]);
  });

  it("Enter shows the finding in PowerPoint with its slide target", async () => {
    const { container, navigate } = renderFonts(undefined, {
      navigate: async () => ({ kind: "shape", slideId: "259#", shapeId: "4", method: "exact" }),
    });
    const row = rows(container).find((r) => r.textContent?.includes("Comic Sans MS") && r.getAttribute("aria-level") === "2")!;
    focus(row);
    keyDown(row, "Enter");
    await flush();
    expect(navigate).toHaveBeenCalledWith(slideShape(3, 4, "Title 1"));
    expect(one(container, '[role="status"]').textContent).toBe("Selected Slide 3 · Title 1.");
  });

  it("a layout target shows the layout note", async () => {
    const layoutTarget = { container: { kind: "layout" as const, partName: "ppt/slideLayouts/slideLayout2.xml", name: "Title Only" }, shapeId: 3 };
    const { container, navigate } = renderPane({
      result: fakeResult([fakeFinding({ area: "fonts", group: "Arial", title: "Arial", targets: [layoutTarget] })]),
      state: { area: "fonts" },
      navigate: async () => ({ kind: "layout-note", containerKind: "layout", name: "Title Only" }),
    });
    click(button(container, "Show in PowerPoint"));
    await flush();
    expect(navigate).toHaveBeenCalledWith(layoutTarget);
    expect(one(container, '[role="status"]').textContent).toContain("Located on layout “Title Only”");
  });
});

describe("FindingsTree windowing", () => {
  it("5,000 findings mount only the visible rows, with full-tree aria positions", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      fakeFinding({ area: "links", group: "https://example.com", title: `Link ${i}`, id: `l${i}` }),
    );
    const { container } = renderPane({ result: fakeResult(many), state: { area: "links" }, treeViewportHeight: 440 });
    const mounted = rows(container);
    expect(mounted.length).toBeGreaterThan(5);
    expect(mounted.length).toBeLessThanOrEqual(440 / ROW_HEIGHT + 10);
    const spacer = one(container, '[role="tree"] > div');
    expect(spacer.style.height).toBe(`${5001 * ROW_HEIGHT}px`);
    expect(mounted[1]!.getAttribute("aria-setsize")).toBe("5000");
  });

  it("End on a huge tree scrolls and mounts the last row", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      fakeFinding({ area: "links", group: "https://example.com", title: `Link ${i}`, id: `l${i}` }),
    );
    const { container } = renderPane({ result: fakeResult(many), state: { area: "links" }, treeViewportHeight: 440 });
    const first = rows(container)[0]!;
    focus(first);
    keyDown(first, "End");
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("aria-posinset")).toBe("5000");
    expect(active.textContent).toContain("Link 4999");
    expect(rows(container).length).toBeLessThanOrEqual(440 / ROW_HEIGHT + 10);
  });
});

describe("untrusted deck strings render as inert text", () => {
  it("an HTML title and a javascript: address never become elements or links", () => {
    const evilTitle = "<img src=x onerror=alert(1)>";
    const evilAddress = "javascript:alert(document.cookie)";
    const { container } = renderPane({
      result: fakeResult([
        fakeFinding({ area: "links", kind: "unsafe-link-scheme", group: evilAddress, title: evilTitle, detail: `<a href="${evilAddress}">x</a>`, severity: "warning" }),
      ]),
      state: { area: "links" },
    });
    const view = one(container, "[data-area-view]");
    expect(view.textContent).toContain(evilTitle);
    expect(view.textContent).toContain(evilAddress);
    expect(view.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(view.querySelectorAll("[href], [src], [onerror]")).toHaveLength(0);
    // The only image in the pane is our own logo.
    expect(Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual(["assets/logo-filled.png"]);
  });
});
