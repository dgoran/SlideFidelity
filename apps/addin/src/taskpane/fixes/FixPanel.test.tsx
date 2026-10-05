/**
 * Fix panel UI (U12/U13 UI): gating, capability, pickers (D11), preview (R16, AE2), destructive
 * confirmation, D4 re-plan, progress + cancel, summary buckets, pre-fix copy (D16), row actions,
 * focus (D15), and untrusted deck strings rendered as text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditResult, Finding } from "@slidefidelity/audit-core";
import type { RescanForFixResult } from "../../office/scan";
import {
  colorUsageFinding,
  createFakePowerPoint,
  fontUsageFinding,
  hyperlinkFinding,
  run as fakeRun,
  shapeReviewFinding,
  target,
  type FakeDeck,
  type FakePowerPoint,
} from "../../office/fixes/testing/fakePowerPoint";
import { fakeFinding, fakeResult } from "../testing/fixtures";
import { slideNumbersFinding, TITLE_LEFT, TITLE_TOP, titleFindings, type TitleSpec } from "../testing/problemFindings";
import { all, button, changeValue, cleanup, click, flush, one, renderPane } from "../testing/render";
import { createFixSlots, type FixDeps } from "./index";

afterEach(cleanup);

// ---------------------------------------------------------------------------------------------
// Fixtures

const textLoc = { property: "text" as const, paragraphIndex: 0, runIndex: 0, script: "latin" as const };

function setFontData(f: Finding, patch: { inBrand?: boolean | null; themeRole?: "major" | "minor" | "both" }): Finding {
  if (f.kind === "font-usage") Object.assign(f.data, patch);
  if (patch.inBrand === false) f.severity = "warning";
  return f;
}

/** "Arial" in `n` text boxes over 4 slides plus one chart usage (AE2), and the fake deck for it. */
function arialDeck(n: number, opts: { chart?: boolean } = {}): { deck: FakeDeck; arial: Finding } {
  const deck: FakeDeck = { slides: [] };
  const entries: Parameters<typeof fontUsageFinding>[1] = [];
  for (let i = 0; i < n; i++) {
    const slideNumber = (i % 4) + 1;
    if (!deck.slides[slideNumber - 1]) deck.slides[slideNumber - 1] = { id: `${255 + slideNumber}#`, shapes: [] };
    deck.slides[slideNumber - 1]!.shapes.push({ id: String(10 + i), name: `TextBox ${i}`, runs: [fakeRun("Body", "Arial")] });
    entries.push({ target: target({ slideNumber, shapeId: 10 + i, shapeName: `TextBox ${i}`, reachable: true, locator: textLoc }) });
  }
  if (opts.chart !== false) {
    entries.push({
      target: target({
        slideNumber: 3,
        shapeId: 99,
        shapeName: "Chart 5",
        containerKind: "chart",
        partName: "ppt/charts/chart1.xml",
        reachable: false,
        locator: { script: "latin" },
      }),
      usage: { source: "chart" },
    });
  }
  const arial = setFontData(fontUsageFinding("Arial", entries), { inBrand: false });
  return { deck, arial };
}

function calibriTheme(): Finding {
  return setFontData(
    fontUsageFinding("Calibri", [{ target: target({ slideNumber: 1, shapeId: 500, shapeName: "Title 1", reachable: true, locator: textLoc }) }]),
    { inBrand: true, themeRole: "minor" },
  );
}

function fontsResult(n = 40, extra: Finding[] = []): { deck: FakeDeck; result: AuditResult; arial: Finding } {
  const { deck, arial } = arialDeck(n);
  const georgia = setFontData(
    fontUsageFinding("Georgia", [{ target: target({ slideNumber: 2, shapeId: 600, shapeName: "Quote", reachable: true, locator: textLoc }) }]),
    { inBrand: true },
  );
  return { deck, arial, result: fakeResult([arial, calibriTheme(), georgia, ...extra]) };
}

function themeColors(): Finding {
  return fakeFinding({
    area: "colors",
    kind: "theme-colors",
    group: "theme",
    title: "Theme colors",
    data: { masterPart: "m", masterName: "Office", colors: [{ slot: "accent1", hex: "4472C4", kind: "srgb" }], slideCount: 1 },
  });
}

interface Harness {
  deps: FixDeps;
  fake: FakePowerPoint;
  createPresentation: ReturnType<typeof vi.fn>;
}

function harness(deck: FakeDeck, extra: Partial<FixDeps> = {}): Harness {
  const fake = createFakePowerPoint(deck);
  const createPresentation = vi.fn(async (_b64: string) => {});
  return { fake, createPresentation, deps: { run: fake.run, createPresentation, ...extra } };
}

function rescanWith(result: AuditResult, changed = false, bytes = new Uint8Array([1, 2, 3])) {
  return vi.fn(async (): Promise<RescanForFixResult> => ({ result, changed, hash: changed ? "h2" : "h1", bytes }));
}

/** The checkbox input whose label text equals `text`. */
function checkbox(root: ParentNode, text: string | RegExp): HTMLInputElement {
  const label = all(root, "label").find((l) => {
    const t = (l.textContent ?? "").trim();
    return typeof text === "string" ? t === text : text.test(t);
  });
  if (!label) throw new Error(`no label ${String(text)}`);
  const input = document.getElementById((label as HTMLLabelElement).htmlFor) as HTMLInputElement | null;
  if (!input || input.type !== "checkbox") throw new Error(`label ${String(text)} is not a checkbox label`);
  return input;
}

function fieldControl<T extends HTMLElement>(root: ParentNode, labelText: string): T {
  const label = all(root, "label").find((l) => (l.textContent ?? "").trim().startsWith(labelText));
  if (!label) throw new Error(`no label ${labelText}`);
  const el = document.getElementById((label as HTMLLabelElement).htmlFor);
  if (!el) throw new Error(`no control for ${labelText}`);
  return el as T;
}

const panel = (root: ParentNode) => one(root, "[data-fix-panel]");

// ---------------------------------------------------------------------------------------------

describe("gating (D13) and capability (KTD4)", () => {
  it("anonymous sees a locked fixes section and no fix actions; the font list stays visible", () => {
    const { deck, result } = fontsResult(4);
    const { container } = renderPane({ result, plan: "anonymous", state: { area: "fonts" }, slots: createFixSlots(harness(deck).deps) });
    expect(container.querySelector('[data-locked-section][aria-label="Font fixes (Pro)"]')).not.toBeNull();
    expect(all(container, "button").some((b) => b.textContent === "Replace fonts…")).toBe(false);
    expect(container.querySelectorAll("[data-row-fix]").length).toBe(0);
    expect(container.textContent).toContain("Arial");
  });

  it("pro sees the bulk action", () => {
    const { deck, result } = fontsResult(4);
    const { container } = renderPane({ result, plan: "pro", state: { area: "fonts" }, slots: createFixSlots(harness(deck).deps) });
    expect(button(container, "Replace fonts…").disabled).toBe(false);
    expect(container.querySelector("[data-locked-section]")).toBeNull();
  });

  it("below PowerPointApi 1.10, Remove links is disabled with the reason; Edit stays available", () => {
    const link = hyperlinkFinding(
      "https://example.com",
      target({ shapeId: 4, shapeName: "Box", reachable: true, locator: { property: "hyperlink", hyperlink: { address: "https://example.com", occurrence: 0, sameAddressCount: 1 } } }),
    );
    const { container } = renderPane({ result: fakeResult([link]), api: "1.8", state: { area: "links" }, slots: createFixSlots(harness({ slides: [] }).deps) });
    const remove = button(panel(container), "Remove links…");
    expect(remove.disabled).toBe(true);
    expect(document.getElementById(remove.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Requires a newer version of PowerPoint (PowerPointApi 1.10)",
    );
    expect(button(panel(container), "Edit a link…").disabled).toBe(false);
  });
});

describe("pickers (D11)", () => {
  it("the font picker defaults to the out-of-brand fonts and the theme font, and accepts a typed name", () => {
    const { deck, result } = fontsResult(4);
    const { container } = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(deck).deps) });
    click(button(container, "Replace fonts…"));
    const p = panel(container);
    expect(checkbox(p, "Arial").checked).toBe(true);
    expect(checkbox(p, "Calibri").checked).toBe(false);
    expect(checkbox(p, "Georgia").checked).toBe(false);
    const select = fieldControl<HTMLSelectElement>(p, "Replace with");
    expect(select.value).toBe("theme:Calibri");
    // The heading of the picker takes focus (D15).
    expect(document.activeElement?.textContent).toBe("Replace fonts");

    changeValue(select, "custom");
    expect(p.textContent).toContain("PowerPoint substitutes fonts that aren't installed");
    const name = fieldControl<HTMLInputElement>(p, "Font name");
    changeValue(name, "Garamond");
    click(button(p, "Preview changes"));
    const preview = one(p, "[data-fix-preview]");
    expect(preview.textContent).toContain("4 changes on 4 slides");
    expect(button(p, "Replace in 4 places").disabled).toBe(false);
  });

  it("the color picker validates the hex input", () => {
    const red = colorUsageFinding("FF0000", [target({ shapeId: 3, reachable: true, locator: { property: "fill" } })]);
    if (red.kind === "color-usage") red.data.inBrand = false;
    const { container } = renderPane({
      result: fakeResult([red, themeColors()]),
      state: { area: "colors" },
      slots: createFixSlots(harness({ slides: [] }).deps),
    });
    click(button(container, "Replace colors…"));
    const p = panel(container);
    expect(checkbox(p, "#FF0000").checked).toBe(true);
    const select = fieldControl<HTMLSelectElement>(p, "Replace with");
    expect(select.value).toBe("theme:4472C4");
    changeValue(select, "custom");
    const hex = fieldControl<HTMLInputElement>(p, "Hex color");
    changeValue(hex, "12345");
    expect(p.textContent).toContain("Enter a 6-digit hex color, like #1F4E79.");
    expect(button(p, "Preview changes").disabled).toBe(true);
    changeValue(hex, "#1f4e79");
    expect(p.textContent).not.toContain("Enter a 6-digit hex color");
    expect(button(p, "Preview changes").disabled).toBe(false);
    click(button(p, "Preview changes"));
    expect(one(p, "[data-fix-preview]").textContent).toContain("1 change on 1 slide");
    expect(p.textContent).toContain("fixed color");
  });

  it("the link editor validates the new address with a reason", () => {
    const link = hyperlinkFinding(
      "https://old.example",
      target({ shapeId: 4, shapeName: "Box", reachable: true, locator: { property: "hyperlink", hyperlink: { address: "https://old.example", occurrence: 0, sameAddressCount: 1 } } }),
    );
    const { container } = renderPane({ result: fakeResult([link]), state: { area: "links" }, slots: createFixSlots(harness({ slides: [] }).deps) });
    click(button(container, "Edit a link…"));
    const p = panel(container);
    click(button(p, "Edit link https://old.example"));
    const input = fieldControl<HTMLInputElement>(p, "New address");
    changeValue(input, "javascript:alert(1)");
    expect(p.textContent).toContain("Only http, https, and mailto addresses are allowed.");
    expect(button(p, "Preview changes").disabled).toBe(true);
    changeValue(input, "https://new.example");
    expect(button(p, "Preview changes").disabled).toBe(false);
  });
});

describe("preview (R16, AE2)", () => {
  it("AE2: replacing Arial with the theme body font previews 40 changes and 1 unreachable chart, with the notes", () => {
    const { deck, result } = fontsResult(40);
    const { container } = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(deck).deps) });
    click(button(container, "Replace fonts…"));
    const p = panel(container);
    click(button(p, "Preview changes"));
    const preview = one(p, "[data-fix-preview]");
    expect(preview.textContent).toContain("40 changes on 4 slides");
    const perSlide = all(preview, "[data-per-slide] li").map((li) => li.textContent);
    expect(perSlide).toEqual(["Slide 1: 10 changes", "Slide 2: 10 changes", "Slide 3: 10 changes", "Slide 4: 10 changes"]);
    const unreachable = one(preview, "[data-unreachable]");
    expect(unreachable.textContent).toContain("Can't be changed in place (1)");
    expect(unreachable.textContent).toMatch(/Inside a chart/);
    expect(unreachable.textContent).toContain("Slide 3 · Chart 5");
    expect(preview.textContent).toContain("PowerPoint's undo history may not capture changes made by add-ins");
  });
});

describe("apply", () => {
  it("destructive fixes need an explicit confirmation; identity-uncertain targets are skipped", async () => {
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            { id: "3", name: "Hidden 1", left: 0, top: 0 },
            { id: "900", name: "Hidden 2", left: 10, top: 10 },
          ],
        },
      ],
    };
    const findings = [
      shapeReviewFinding("hidden-shape", target({ shapeId: 3, shapeName: "Hidden 1", reachable: true })),
      shapeReviewFinding("hidden-shape", target({ shapeId: 7, shapeName: "Hidden 2", left: 10, top: 10, reachable: true })),
    ];
    const result = fakeResult(findings);
    const h = harness(deck);
    const r = renderPane({ result, state: { area: "review" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Delete hidden shapes…"));
    const p = panel(r.container);
    expect(checkbox(p, "Slide 1 · Hidden 1").checked).toBe(true);
    expect(checkbox(p, "Select all").checked).toBe(true);
    click(button(p, "Preview changes"));
    const apply = button(p, "Delete 2 shapes");
    expect(apply.disabled).toBe(true);
    click(apply);
    expect(h.fake.runCount).toBe(0);
    click(checkbox(p, /^Yes, delete 2 shapes/));
    expect(button(p, "Delete 2 shapes").disabled).toBe(false);
    click(button(p, "Delete 2 shapes"));
    await flush(6);
    const summary = one(p, "[data-fix-summary]");
    expect(summary.textContent).toContain("1 changed");
    expect(summary.textContent).toMatch(/Skipped \(1\)/);
    expect(summary.textContent).toMatch(/identity uncertain/);
    expect(h.fake.deck.slides[0]!.shapes.map((s) => s.name)).toEqual(["Hidden 2"]);
  });

  it("D4: when the file changed, shows the updated preview and needs another confirmation", async () => {
    const { deck, result } = fontsResult(4);
    const newer = fontsResult(6);
    const h = harness(newer.deck);
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(newer.result, true);
    void deck;
    click(button(r.container, "Replace fonts…"));
    const p = panel(r.container);
    click(button(p, "Preview changes"));
    click(button(p, "Replace in 4 places"));
    await flush(6);
    expect(p.textContent).toContain("The presentation changed since the last scan. Review the updated preview.");
    expect(h.fake.runCount).toBe(0);
    expect(one(p, "[data-fix-preview]").textContent).toContain("6 changes");
    // The tree reflects the new scan.
    expect(r.container.querySelector('[role="tree"]')?.textContent).toContain("Arial");

    r.scan.service.rescanForFix = rescanWith(newer.result, false);
    click(button(p, "Replace in 6 places"));
    await flush(6);
    expect(one(p, "[data-fix-summary]").textContent).toContain("6 changed");
    expect(h.fake.writes.length).toBeGreaterThan(0);
  });

  it("shows progress per batch and cancels between batches", async () => {
    const { deck, result } = fontsResult(60);
    const fake = createFakePowerPoint(deck);
    const gates: Array<() => void> = [];
    const gatedRun: FixDeps["run"] = (batch) =>
      new Promise((resolve, reject) => {
        gates.push(() => {
          fake.run(batch).then(resolve, reject);
        });
      });
    const createPresentation = vi.fn(async () => {});
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots({ run: gatedRun, createPresentation, batchSize: 25 }) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Replace fonts…"));
    const p = panel(r.container);
    click(button(p, "Preview changes"));
    click(button(p, "Replace in 60 places"));
    await flush(4);
    expect(p.querySelector("[data-fix-progress]")).not.toBeNull();
    expect(gates).toHaveLength(1);
    gates[0]!();
    await flush(6);
    const progress = one(p, "[data-fix-progress]");
    expect(progress.textContent).toContain("Batch 1 of 3");
    expect(progress.textContent).toContain("25 of 60");
    expect(gates).toHaveLength(2);
    click(button(p, "Cancel"));
    expect(button(p, "Cancelling…").disabled).toBe(true);
    gates[1]!();
    await flush(6);
    const summary = one(p, "[data-fix-summary]");
    expect(summary.textContent).toContain("Cancelled");
    expect(summary.textContent).toContain("50 changed");
    expect(summary.textContent).toMatch(/Not run \(10\)/);
    expect(gates).toHaveLength(2);
  });

  it("summarizes changed, skipped, unknown, and unreachable; rescans; opens the pre-fix copy; focuses the heading", async () => {
    const { deck, result } = fontsResult(3);
    // One text box was deleted after the scan: skipped.
    deck.slides[1]!.shapes = [];
    const h = harness(deck, { batchSize: 1 });
    // The second batch's commit fails: unknown.
    h.fake.failSync({ onWriteSync: 2, message: "boom" });
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result, false, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    click(button(r.container, "Replace fonts…"));
    const p = panel(r.container);
    click(button(p, "Preview changes"));
    click(button(p, "Replace in 3 places"));
    await flush(8);
    const summary = one(p, "[data-fix-summary]");
    const text = summary.textContent ?? "";
    expect(text).toMatch(/1 changed/);
    expect(text).toMatch(/Skipped \(1\)/);
    expect(text).toContain("the shape no longer exists");
    expect(text).toMatch(/May or may not have changed \(1\)/);
    expect(text).toContain("rescan to check");
    expect(text).toMatch(/Not reachable \(1\)/);
    expect(text).toContain("Slide 3 · Chart 5");
    expect(document.activeElement).toBe(one(summary, "h3"));
    expect(document.activeElement?.textContent).toBe("Fix results");

    // The post-fix rescan runs through the scan service and updates the tree.
    expect(r.scan.calls()).toBe(1);
    expect(text).toContain("Updating results");
    const after = fakeResult([calibriTheme(), setFontData(fontUsageFinding("Garamond Updated", []), { inBrand: true })]);
    r.scan.resolve(after);
    await flush(4);
    expect(one(p, "[data-fix-summary]").textContent).toContain("Results updated.");
    expect(r.container.querySelector('[role="tree"]')?.textContent).toContain("Garamond Updated");

    // D16: open the pre-fix copy.
    expect(p.textContent).toContain("new, unsaved presentation");
    click(button(p, "Open pre-fix copy"));
    await flush(3);
    expect(h.createPresentation).toHaveBeenCalledWith("UEsDBA==");
  });
});

describe("row actions (D11, D15)", () => {
  it("appear only on fixable, reachable findings and follow the roving tab index", () => {
    const { deck, arial } = arialDeck(2, { chart: false });
    const unreachable = setFontData(
      fontUsageFinding("Wingdings", [{ target: target({ shapeId: 70, reachable: false, locator: { script: "bu" } }), usage: { script: "bu" } }]),
      { inBrand: null },
    );
    const flag = fakeFinding({ area: "fonts", kind: "hidden-list-style", group: "hls", title: "Hidden list style", severity: "warning" });
    const result = fakeResult([arial, unreachable, flag, calibriTheme()]);
    const { container } = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(deck).deps) });
    const rowsWithFix = all(container, '[role="treeitem"]').filter((row) => row.querySelector("[data-row-fix]"));
    const titles = rowsWithFix.map((row) => row.getAttribute("data-row-key"));
    expect(titles.some((k) => k?.includes(arial.id))).toBe(true);
    expect(titles.some((k) => k?.includes(unreachable.id))).toBe(false);
    expect(titles.some((k) => k?.includes(flag.id))).toBe(false);
    for (const row of rowsWithFix) {
      const b = row.querySelector<HTMLButtonElement>("[data-row-fix]")!;
      expect(b.tabIndex).toBe(row.getAttribute("aria-selected") === "true" ? 0 : -1);
    }

    // Launching from the row preselects only that font.
    const arialRow = rowsWithFix.find((row) => row.getAttribute("data-row-key")?.includes(arial.id))!;
    click(arialRow.querySelector("[data-row-fix]")!);
    const p = panel(container);
    expect(checkbox(p, "Arial").checked).toBe(true);
    expect(checkbox(p, "Calibri").checked).toBe(false);
  });
});

describe("untrusted deck strings", () => {
  it("renders a malicious font name and link address as text", () => {
    const evilFont = '<img src=x onerror="window.__pwned=1">';
    const evilAddress = 'https://x.example/"><script>window.__pwned=1</script>';
    const font = setFontData(
      fontUsageFinding(evilFont, [
        { target: target({ shapeId: 5, shapeName: "Box", reachable: true, locator: textLoc }) },
        {
          target: target({ shapeId: 6, shapeName: "<b>Box</b>", containerKind: "chart", partName: "ppt/charts/chart1.xml", reachable: false }),
          usage: { source: "chart" },
        },
      ]),
      { inBrand: false },
    );
    const link = hyperlinkFinding(
      evilAddress,
      target({ shapeId: 4, shapeName: "Box", reachable: true, locator: { property: "hyperlink", hyperlink: { address: evilAddress, occurrence: 0, sameAddressCount: 1 } } }),
    );
    const fonts = renderPane({ result: fakeResult([font, calibriTheme(), link]), state: { area: "fonts" }, slots: createFixSlots(harness({ slides: [] }).deps) });
    click(button(fonts.container, "Replace fonts…"));
    const p = panel(fonts.container);
    expect(checkbox(p, evilFont).checked).toBe(true);
    click(button(p, "Preview changes"));
    expect(p.textContent).toContain("<b>Box</b>");
    expect(fonts.container.querySelector("[onerror], b, script")).toBeNull();

    const links = renderPane({ result: fakeResult([link]), state: { area: "links" }, slots: createFixSlots(harness({ slides: [] }).deps) });
    click(button(links.container, "Remove links…"));
    const lp = panel(links.container);
    expect(checkbox(lp, evilAddress)).toBeTruthy();
    expect(links.container.querySelector("script, [onerror]")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Graphics Ops bulk fixes: slide title size and slide numbers

const TITLES: TitleSpec[] = [
  { slide: 1, size: 54, type: "ctrTitle", text: "Welcome" },
  { slide: 2, size: 32, text: "Agenda" },
  { slide: 3, size: 40, text: "Numbers" },
  { slide: 4, size: 40, text: "Long title", shrink: true },
];

function titlesDeck(specs: readonly TitleSpec[] = TITLES): FakeDeck {
  return {
    slides: specs.map((t) => ({
      id: `${255 + t.slide}#`,
      shapes: [
        {
          id: "2",
          name: "Title 1",
          left: TITLE_LEFT,
          top: TITLE_TOP,
          placeholderType: t.type === "ctrTitle" ? "CenterTitle" : "Title",
          runs: [{ text: t.text ?? "T", font: { name: "Calibri", color: "#000000", size: t.size } }],
        },
      ],
    })),
    masters: [
      {
        id: "m1",
        name: "Office Theme",
        shapes: [{ id: "2", name: "Title 1", placeholderType: "Title", runs: [{ text: "Master", font: { name: "Calibri", color: "#000000", size: 44 } }] }],
        layouts: [
          { id: "l2", name: "Title and Content", shapes: [{ id: "2", name: "Title 1", placeholderType: "Title", runs: [{ text: "Layout", font: { name: "Calibri", color: "#000000", size: 44 } }] }] },
        ],
      },
    ],
  };
}

const sizeInput = (p: ParentNode) => fieldControl<HTMLInputElement>(p, "New size (pt)");
const liveSizes = (h: Harness) => h.fake.deck.slides.map((s) => s.shapes[0]!.runs![0]!.font.size);

describe("set title size", () => {
  it("Fonts bulk action: defaults to the most common slide-title size, previews current → new, and applies", async () => {
    const result = fakeResult(titleFindings(TITLES));
    const h = harness(titlesDeck());
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Set title size…"));
    const p = panel(r.container);
    expect(document.activeElement?.textContent).toBe("Set title size");
    expect(sizeInput(p).value).toBe("40");
    expect(checkbox(p, "Slide titles").checked).toBe(true);
    expect(checkbox(p, "Title slides").checked).toBe(false);
    expect(checkbox(p, "Also update layouts and master so new slides match").checked).toBe(false);
    // Quick chips for the sizes of the chosen titles.
    const chips = all(one(p, '[aria-label="Sizes in this presentation"]'), "button").map((b) => b.textContent);
    expect(chips).toEqual(["32 pt", "40 pt"]);
    click(button(p, "32 pt"));
    expect(sizeInput(p).value).toBe("32");
    changeValue(sizeInput(p), "36");
    expect(checkbox(p, "All slides").checked).toBe(true);
    expect(checkbox(p, "Slide 2: Agenda").checked).toBe(true);

    click(button(p, "Preview changes"));
    const preview = one(p, "[data-fix-preview]");
    expect(document.activeElement?.textContent).toBe("Preview");
    expect(all(preview, "[data-title-changes] li").map((li) => li.textContent)).toEqual([
      "Slide 2 · Title 1: 32 pt → 36 pt",
      "Slide 3 · Title 1: 40 pt → 36 pt",
      "Slide 4 · Title 1: 40 pt → 36 pt",
    ]);
    expect(preview.textContent).toContain("PowerPoint may shrink these titles to fit");
    expect(preview.textContent).toContain("PowerPoint's undo history may not capture changes made by add-ins");
    // Not destructive: no confirmation.
    expect(preview.querySelector('input[type="checkbox"]')).toBeNull();
    click(button(p, "Change 3 titles"));
    await flush(6);
    expect(one(p, "[data-fix-summary]").textContent).toContain("3 changed");
    expect(document.activeElement?.textContent).toBe("Fix results");
    expect(liveSizes(h)).toEqual([54, 36, 36, 36]);
  });

  it("validates the size inline and blocks the preview", () => {
    const result = fakeResult(titleFindings(TITLES));
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(titlesDeck()).deps) });
    click(button(r.container, "Set title size…"));
    const p = panel(r.container);
    changeValue(sizeInput(p), "300");
    expect(p.textContent).toContain("Enter a size from 6 to 200 pt.");
    expect(button(p, "Preview changes").disabled).toBe(true);
    changeValue(sizeInput(p), "");
    expect(button(p, "Preview changes").disabled).toBe(true);
    changeValue(sizeInput(p), "28");
    expect(button(p, "Preview changes").disabled).toBe(false);
  });

  it("per-slide selection and title slides narrow the preview; layouts and master can follow", async () => {
    const result = fakeResult(titleFindings(TITLES));
    const h = harness(titlesDeck());
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Set title size…"));
    const p = panel(r.container);
    click(checkbox(p, "Slide 3: Numbers"));
    expect(checkbox(p, "All slides").indeterminate || checkbox(p, "All slides").getAttribute("aria-checked") === "mixed").toBe(true);
    click(button(p, "Preview changes"));
    expect(all(p, "[data-title-changes] li").map((li) => li.textContent)).toEqual(["Slide 2 · Title 1: 32 pt → 40 pt", "Slide 4 · Title 1: 40 pt → 40 pt"]);

    click(checkbox(p, "Title slides"));
    click(checkbox(p, "Also update layouts and master so new slides match"));
    click(button(p, "Preview changes"));
    const lines = all(p, "[data-title-changes] li").map((li) => li.textContent);
    expect(lines).toContain("Slide 1 · Title 1: 54 pt → 40 pt");
    expect(lines).toContain('Layout "Title and Content" · title: 44 pt → 40 pt');
    expect(lines).toContain("Slide master · title: 44 pt → 40 pt");
    expect(one(p, "[data-fix-preview]").textContent).toContain("6 changes on 4 slides");
    click(button(p, "Change 6 titles"));
    await flush(8);
    expect(liveSizes(h)).toEqual([40, 40, 40, 40]);
    expect(h.fake.deck.masters![0]!.layouts[0]!.shapes[0]!.runs![0]!.font.size).toBe(40);
    expect(h.fake.deck.masters![0]!.shapes[0]!.runs![0]!.font.size).toBe(40);
  });

  it("the title-sizes-inconsistent row action opens the picker for that placeholder type", () => {
    const specs: TitleSpec[] = [...TITLES, { slide: 5, size: 60, type: "ctrTitle", text: "Part two" }];
    const result = fakeResult(titleFindings(specs));
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(titlesDeck(specs)).deps) });
    const rows = all(r.container, "[data-row-fix]");
    const ctr = rows.find((b) => /Title-slide titles use 2 different sizes/.test(b.getAttribute("aria-label") ?? ""));
    expect(ctr?.getAttribute("aria-label")).toBe("Set title size: Title-slide titles use 2 different sizes");
    click(ctr!);
    const p = panel(r.container);
    expect(checkbox(p, "Title slides").checked).toBe(true);
    expect(checkbox(p, "Slide titles").checked).toBe(false);
    expect(sizeInput(p).value).toBe("60");
  });

  it("is disabled with the reason below PowerPointApi 1.4", () => {
    const result = fakeResult(titleFindings(TITLES));
    const r = renderPane({ result, api: "1.3", state: { area: "fonts" }, slots: createFixSlots(harness(titlesDeck()).deps) });
    const b = button(r.container, "Set title size…");
    expect(b.disabled).toBe(true);
    expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe("Requires a newer version of PowerPoint (PowerPointApi 1.4)");
  });

  it("renders title text from the deck as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const result = fakeResult(titleFindings([{ slide: 1, size: 32, text: evil }, { slide: 2, size: 40 }]));
    const r = renderPane({ result, state: { area: "fonts" }, slots: createFixSlots(harness(titlesDeck()).deps) });
    click(button(r.container, "Set title size…"));
    const p = panel(r.container);
    expect(p.querySelector("img")).toBeNull();
    expect(checkbox(p, `Slide 1: ${evil}`).checked).toBe(true);
  });
});

function numbersDeck(): FakeDeck {
  const box = (id: string, name: string, text: string) => ({ id, name, left: 720, top: 504, runs: [fakeRun(text, "Calibri")] });
  return {
    slides: [
      { id: "256#", shapes: [box("3", "Slide Number Placeholder 2", "1")] },
      { id: "257#", shapes: [box("3", "Number Box", "2")] },
      { id: "258#", shapes: [box("3", "Page Box", "Page 3 of 10")] },
    ],
  };
}

describe("remove slide numbers", () => {
  const finding = () =>
    slideNumbersFinding(
      [
        { slide: 1, kind: "placeholder" },
        { slide: 2, kind: "field-only-textbox" },
        { slide: 3, kind: "field-in-text" },
      ],
      { flagOn: true },
    );

  it("Review bulk action: checklist, kept items, Header & Footer note, destructive confirm, delete", async () => {
    const result = fakeResult([finding()]);
    const h = harness(numbersDeck());
    const r = renderPane({ result, state: { area: "review" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Remove slide numbers…"));
    const p = panel(r.container);
    expect(document.activeElement?.textContent).toBe("Remove slide numbers");
    expect(checkbox(p, "Select all").checked).toBe(true);
    expect(checkbox(p, "Slide 1").checked).toBe(true);
    expect(checkbox(p, "Slide 2").checked).toBe(true);
    expect(one(p, "[data-slide-numbers-kept]").textContent).toContain("Slide 3 · Page Box");
    expect(one(p, "[data-header-footer-note]").textContent).toContain("Insert > Header & Footer");

    click(button(p, "Preview changes"));
    const preview = one(p, "[data-fix-preview]");
    expect(all(preview, "[data-deleted] li").map((li) => li.textContent)).toEqual(["Slide 1 · Slide Number Placeholder 2", "Slide 2 · Number Box"]);
    const kept = one(preview, "[data-unreachable]");
    expect(kept.textContent).toContain("Left in place (1)");
    expect(kept.textContent).toContain("Slide number is part of other text — edit it by hand");
    expect(preview.textContent).toContain("add-ins can't change that setting");

    const apply = button(p, "Delete 2 slide numbers");
    expect(apply.disabled).toBe(true);
    click(checkbox(p, /^Yes, delete 2 slide numbers/));
    click(button(p, "Delete 2 slide numbers"));
    await flush(6);
    expect(one(p, "[data-fix-summary]").textContent).toContain("2 changed");
    expect(h.fake.deck.slides.map((s) => s.shapes.length)).toEqual([0, 0, 1]);
  });

  it("scopes to the chosen slides", async () => {
    const result = fakeResult([finding()]);
    const h = harness(numbersDeck());
    const r = renderPane({ result, state: { area: "review" }, slots: createFixSlots(h.deps) });
    r.scan.service.rescanForFix = rescanWith(result);
    click(button(r.container, "Remove slide numbers…"));
    const p = panel(r.container);
    click(checkbox(p, "Slide 1"));
    expect(checkbox(p, "Select all").checked).toBe(false);
    click(button(p, "Preview changes"));
    expect(all(p, "[data-deleted] li").map((li) => li.textContent)).toEqual(["Slide 2 · Number Box"]);
    click(checkbox(p, /^Yes, delete 1 slide number/));
    click(button(p, "Delete 1 slide number"));
    await flush(6);
    expect(h.fake.deck.slides.map((s) => s.shapes.length)).toEqual([1, 0, 1]);
  });

  it("the slide-numbers row offers Remove slide numbers", () => {
    const result = fakeResult([finding()]);
    const r = renderPane({ result, state: { area: "review" }, slots: createFixSlots(harness(numbersDeck()).deps) });
    const row = all(r.container, "[data-row-fix]").find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Remove slide numbers"));
    expect(row).toBeDefined();
    click(row!);
    expect(checkbox(panel(r.container), "Slide 2").checked).toBe(true);
  });
});
