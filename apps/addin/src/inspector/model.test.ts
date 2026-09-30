// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadPresentation, runChecks, type AuditResult } from "@slidecheck/audit-core";
import { corpusDeck, type CorpusName } from "../../../../packages/audit-core/test/helpers/corpus";
import type { SelectedShape, SelectionResult } from "../office/selection";
import { buildInspectorModel, buildScanInventory, type ScanInventory, type ShapeInspection } from "./model";

const cache = new Map<CorpusName, Promise<{ audit: AuditResult; inventory: ScanInventory }>>();
function scan(name: CorpusName): Promise<{ audit: AuditResult; inventory: ScanInventory }> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const bytes = await corpusDeck(name);
      const audit = await runChecks(bytes);
      const inventory = await buildScanInventory(await loadPresentation(bytes));
      return { audit, inventory };
    })();
    cache.set(name, p);
  }
  return p;
}

const PT = 72; // points per inch

function shape(liveId: string, name: string, leftIn: number, topIn: number, type = "GeometricShape"): SelectedShape {
  return { liveId, name, left: leftIn * PT, top: topIn * PT, width: 100, height: 50, type };
}

function sel(slideId: number | string, index: number, shapes: SelectedShape[] = []): SelectionResult {
  return { status: "ok", unsupported: false, slides: [{ liveId: typeof slideId === "number" ? `${slideId}#` : slideId, index }], shapes };
}

function single(model: ReturnType<typeof buildInspectorModel>): ShapeInspection {
  if (model.kind !== "shape") throw new Error(`expected shape model, got ${model.kind}`);
  return model.shape;
}

describe("buildInspectorModel: states", () => {
  it("unsupported below 1.5", async () => {
    const { audit } = await scan("clean");
    expect(buildInspectorModel({ status: "unsupported", unsupported: true }, audit)).toEqual({ kind: "unsupported" });
  });

  it("no scan yet", () => {
    expect(buildInspectorModel(sel(256, 0), null)).toEqual({ kind: "no-scan" });
  });

  it("selection read error", async () => {
    const { audit } = await scan("clean");
    expect(buildInspectorModel({ status: "error", unsupported: false, message: "boom" }, audit)).toEqual({ kind: "error", message: "boom" });
  });

  it("nothing selected", async () => {
    const { audit } = await scan("clean");
    expect(buildInspectorModel({ status: "ok", unsupported: false, slides: [], shapes: [] }, audit)).toEqual({ kind: "empty" });
  });
});

describe("buildInspectorModel: one shape", () => {
  it("AE1 text box: three fonts with script labels and a hidden list styles node", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(256, 0, [shape("4", "TextBox 3", 1, 2)]), audit, { inventory }));
    expect(s.status).toBe("matched");
    expect(s.match).toMatchObject({ method: "exact", approximate: false, shapeId: 4, slideId: 256, slideNumber: 1 });
    expect(s.name).toBe("TextBox 3");
    expect(s.type).toBe("GeometricShape");
    expect(s.properties.fonts.map((f) => [f.typeface, f.script, f.scriptLabel, f.source, f.sourceLabel])).toEqual([
      ["Calibri", "latin", "Latin", "direct", "Direct formatting"],
      ["MS Gothic", "ea", "East Asian", "direct", "Direct formatting"],
      ["Wingdings", "bu", "Bullet", "hidden-list-style", "Hidden list style"],
    ]);
    expect(s.properties.hiddenListStyles).toEqual({ fonts: ["Wingdings"], levels: [1] });
    const fontsArea = s.findings.find((g) => g.area === "fonts");
    expect(fontsArea?.findings.map((f) => f.kind)).toContain("hidden-list-style");
    // warnings sort first within an area
    expect(fontsArea?.findings[0]?.severity).toBe("warning");
    expect(s.counts.total).toBe(s.findings.reduce((n, g) => n + g.findings.length, 0));
    expect(s.mayBeOutOfDate).toBe(false);
  });

  it("theme-font references are labelled with their theme role", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(256, 0, [shape("5", "TextBox 4", 1, 3.5)]), audit, { inventory }));
    expect(s.properties.fonts).toEqual([
      expect.objectContaining({ typeface: "Calibri", script: "latin", theme: "minor", themeRef: "+mn-lt", reachable: false }),
    ]);
    expect(s.properties.hiddenListStyles).toBeNull();
  });

  it("image: native dimensions, effective PPI, and scale factors", async () => {
    const { audit, inventory } = await scan("media-bloat");
    const s = single(buildInspectorModel(sel(256, 0, [shape("2", "Oversized photo", 1, 1, "Image")]), audit, { inventory }));
    expect(s.status).toBe("matched");
    const img = s.properties.images[0];
    expect(img).toMatchObject({ partName: "ppt/media/image1.jpeg", width: 4000, height: 3000, effectivePpi: 2000, scale: { x: 1, y: 1 } });
    expect(img?.issues).toContain("oversized");
    expect(img?.bytes).toBeGreaterThan(1_000_000);
    expect(img?.displayed).toEqual({ widthIn: 2, heightIn: 1.5 });
  });

  it("image: distorted scale factors and crop percentages", async () => {
    const { audit, inventory } = await scan("media-bloat");
    const d = single(buildInspectorModel(sel(257, 1, [shape("3", "Distorted", 4, 1, "Image")]), audit, { inventory }));
    const img = d.properties.images[0];
    expect(img?.scale?.x).toBeCloseTo(1);
    expect(img?.scale?.y).toBeCloseTo(0.6);
    expect(img?.issues).toContain("distorted");

    const c = single(buildInspectorModel(sel(257, 1, [shape("4", "Cropped", 7, 1, "Image")]), audit, { inventory }));
    expect(c.properties.images[0]?.cropPercent).toEqual({ left: 10, top: 0, right: 5, bottom: 0 });
  });

  it("colors by property", async () => {
    const { audit, inventory } = await scan("colors-literal");
    const fill = single(buildInspectorModel(sel(256, 0, [shape("2", "Accent literal", 1, 1)]), audit, { inventory }));
    expect(fill.properties.colors).toEqual([
      { property: "fill", label: "Fill", colors: [expect.objectContaining({ hex: "4472C4", reachable: true })] },
    ]);
    const text = single(buildInspectorModel(sel(256, 0, [shape("3", "Red text", 3, 1)]), audit, { inventory }));
    expect(text.properties.colors.map((g) => [g.label, g.colors.map((c) => c.hex)])).toEqual([["Text", ["FF0000"]]]);
    const line = single(buildInspectorModel(sel(256, 0, [shape("4", "Red line", 7, 1)]), audit, { inventory }));
    expect(line.properties.colors.map((g) => g.property)).toEqual(["line"]);
  });

  it("links on a shape, including a linked file with a local path", async () => {
    const { audit, inventory } = await scan("links");
    const a = single(buildInspectorModel(sel(256, 0, [shape("2", "Text links", 1, 1)]), audit, { inventory }));
    expect(a.properties.links).toEqual([
      expect.objectContaining({ kind: "hyperlink", address: "https://example.com/a", location: "text", text: "Site A", checkable: true, flags: [] }),
    ]);
    const ole = single(buildInspectorModel(sel(257, 1, [shape("3", "Linked Worksheet", 1, 3, "Unsupported")]), audit, { inventory }));
    expect(ole.properties.links).toEqual([
      expect.objectContaining({ kind: "linked-file", address: "file:///C:\\Users\\alice\\Documents\\budget.xlsx", checkable: false, flags: ["local-path"] }),
    ]);
  });

  it("autofit mode", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const s = single(buildInspectorModel(sel(260, 4, [shape("2", "Bilingual", 1, 1)]), audit, { inventory }));
    expect(s.properties.autofit).toEqual({ mode: "shrink", label: "Shrink text on overflow" });
  });

  it("a selected group includes findings of the shapes inside it", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    // Synthetic: nest shape 4 under a group id 40 in every target.
    const nested: AuditResult = {
      ...audit,
      findings: audit.findings.map((f) => ({
        ...f,
        targets: f.targets.map((t) => (t.shapeId === 4 && t.container.slideId === 256 ? { ...t, path: [40] } : t)),
      })) as AuditResult["findings"],
    };
    const inv: ScanInventory = {
      slides: inventory.slides.map((s) => (s.slideId === 256 ? { ...s, shapes: [...s.shapes, { shapeId: 40, name: "Group 39", path: [], left: 0, top: 0 }] } : s)),
    };
    const g = single(buildInspectorModel(sel(256, 0, [shape("40", "Group 39", 0, 0, "Group")]), nested, { inventory: inv }));
    expect(g.status).toBe("matched");
    expect(g.properties.fonts.map((f) => f.typeface)).toEqual(["Calibri", "MS Gothic", "Wingdings"]);
  });

  it("fallback-matched shape (unparseable live id) is flagged as approximate", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(256, 0, [shape("{0A1B-guid}", "TextBox 3", 1, 2)]), audit, { inventory }));
    expect(s.status).toBe("matched");
    expect(s.match).toMatchObject({ method: "fallback", approximate: true, shapeId: 4 });
    expect(s.properties.fonts).toHaveLength(3);
  });

  it("a shape created after the scan shows not-in-scan (may be out of date)", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const m = buildInspectorModel(sel(256, 0, [shape("99", "TextBox 98", 8, 6)]), audit, { inventory });
    const s = single(m);
    expect(s.status).toBe("not-in-scan");
    expect(s.findings).toEqual([]);
    expect(s.mayBeOutOfDate).toBe(true);
    expect(s.message).toBe("Not in last scan — rescan");
  });

  it("a shape on a slide created after the scan is not-in-scan even without an inventory", async () => {
    const { audit } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(999, 5, [shape("2", "TextBox 1", 1, 1)]), audit));
    expect(s.status).toBe("not-in-scan");
  });

  it("without an inventory, an unreferenced shape on a scanned slide is unverified, not not-in-scan", async () => {
    const { audit } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(256, 0, [shape("99", "TextBox 98", 8, 6)]), audit));
    expect(s.status).toBe("unverified");
    expect(s.mayBeOutOfDate).toBe(false);
  });

  it("without an inventory, shapes referenced by findings still match", async () => {
    const { audit } = await scan("fonts-hidden");
    const s = single(buildInspectorModel(sel(256, 0, [shape("4", "TextBox 3", 1, 2)]), audit));
    expect(s.status).toBe("matched");
    expect(s.properties.fonts).toHaveLength(3);
  });
});

describe("buildInspectorModel: multi-selection", () => {
  it("shows a count and the combined, deduplicated findings", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const m = buildInspectorModel(sel(256, 0, [shape("4", "TextBox 3", 1, 2), shape("5", "TextBox 4", 1, 3.5)]), audit, { inventory });
    if (m.kind !== "multi") throw new Error(m.kind);
    expect(m.count).toBe(2);
    expect(m.shapes.map((s) => [s.name, s.status])).toEqual([
      ["TextBox 3", "matched"],
      ["TextBox 4", "matched"],
    ]);
    const all = m.findings.flatMap((g) => g.findings);
    const ids = all.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Calibri is on both shapes but appears once, with both occurrences counted.
    const calibri = all.filter((f) => f.kind === "font-usage" && f.group.toLowerCase() === "calibri");
    expect(calibri).toHaveLength(1);
    expect(calibri[0]?.occurrences).toBe(2);
    expect(all.map((f) => f.group)).toEqual(expect.arrayContaining(["MS Gothic", "Wingdings"]));
    expect(m.counts.total).toBe(all.length);
    expect(m.notInScanCount).toBe(0);
    expect(m.mayBeOutOfDate).toBe(false);
  });

  it("counts shapes that are not in the scan", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const m = buildInspectorModel(sel(256, 0, [shape("4", "TextBox 3", 1, 2), shape("77", "New", 9, 9)]), audit, { inventory });
    if (m.kind !== "multi") throw new Error(m.kind);
    expect(m.notInScanCount).toBe(1);
    expect(m.mayBeOutOfDate).toBe(true);
  });
});

describe("buildInspectorModel: slide summary (no shapes)", () => {
  it("summarizes notes, transition, and animation for a slide", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const m = buildInspectorModel(sel(256, 0), audit, { inventory });
    if (m.kind !== "slides") throw new Error(m.kind);
    const s = m.slides[0];
    expect(s).toMatchObject({ status: "matched", method: "exact", slideId: 256, slideNumber: 1, hidden: false });
    expect(s?.notes).toEqual({ characters: "Remember to mention pricing".length });
    expect(s?.transition).toMatchObject({ type: "fade", speed: "med", advanceOnClick: true });
    expect(s?.animation).not.toBeNull();
    expect(s?.counts.total).toBeGreaterThan(0);
    expect(s?.findings.flatMap((g) => g.findings).map((f) => f.kind)).toEqual(expect.arrayContaining(["speaker-notes", "transition"]));
  });

  it("flags a hidden slide", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const m = buildInspectorModel(sel(257, 1), audit, { inventory });
    if (m.kind !== "slides") throw new Error(m.kind);
    expect(m.slides[0]).toMatchObject({ hidden: true, notes: null, transition: null, animation: null });
  });

  it("counts comments on a slide", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const m = buildInspectorModel(sel(260, 4), audit, { inventory });
    if (m.kind !== "slides") throw new Error(m.kind);
    expect(m.slides[0]?.commentCount).toBeGreaterThanOrEqual(2);
  });

  it("a slide added after the scan is not-in-scan", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const m = buildInspectorModel(sel(4000, 9), audit, { inventory });
    if (m.kind !== "slides") throw new Error(m.kind);
    expect(m.slides[0]?.status).toBe("not-in-scan");
    expect(m.mayBeOutOfDate).toBe(true);
  });

  it("falls back to slide position when the live slide id cannot be parsed", async () => {
    const { audit, inventory } = await scan("review-leaks");
    const m = buildInspectorModel(sel("opaque-id", 1), audit, { inventory });
    if (m.kind !== "slides") throw new Error(m.kind);
    expect(m.slides[0]).toMatchObject({ status: "matched", method: "fallback", approximate: true, slideId: 257, hidden: true });
  });

  it("returns plain, structured-cloneable data", async () => {
    const { audit, inventory } = await scan("fonts-hidden");
    const m = buildInspectorModel(sel(256, 0, [shape("4", "TextBox 3", 1, 2)]), audit, { inventory });
    expect(structuredClone(m)).toEqual(m);
  });
});

describe("buildScanInventory", () => {
  it("lists every slide with its shapes and positions in points", async () => {
    const { inventory } = await scan("fonts-hidden");
    const s1 = inventory.slides[0];
    expect(s1).toMatchObject({ slideId: 256, index: 0, number: 1 });
    expect(s1?.shapes.find((s) => s.shapeId === 4)).toEqual({ shapeId: 4, name: "TextBox 3", path: [], left: 72, top: 144 });
  });
});
