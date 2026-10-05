import { describe, expect, it } from "vitest";
import { titleNumberChecks } from "../../src/checks/titlesNumbers";
import { CHECKS, loadPresentation, runChecks, type Finding, type FindingOf } from "../../src/index";
import { buildDeck, layoutPart, masterPart, slidePart } from "../helpers/buildDeck";
import { CORPUS_NAMES, corpusDeck } from "../helpers/corpus";
import { consistentTitlesDeck, defaultSizeDeck, slideNumbersDeck, titlesDeck } from "./titlesNumbers.fixtures";

async function run(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of titleNumberChecks) out.push(...(await c.run({ pres, options: {} })));
  return out;
}

function ofKind<K extends Finding["kind"]>(fs: Finding[], kind: K): FindingOf<K>[] {
  return fs.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

describe("titleNumberChecks: registration", () => {
  it("exports one fonts check and one review check, registered in CHECKS with unique ids", () => {
    expect(titleNumberChecks.map((c) => c.area).sort()).toEqual(["fonts", "review"]);
    for (const c of titleNumberChecks) expect(CHECKS).toContain(c);
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });
});

describe("slide-titles", () => {
  it("emits one info finding per deck listing every title with its effective size and source", async () => {
    const fs = await run(await titlesDeck());
    const titles = ofKind(fs, "slide-titles");
    expect(titles).toHaveLength(1);
    const f = titles[0]!;
    expect(f.area).toBe("fonts");
    expect(f.severity).toBe("info");
    expect(f.group).toBe("slide-titles");
    expect(f.fixes).toEqual(["set-title-size"]);
    expect(f.reachable).toBe(true);
    expect(f.count).toBe(8);

    const by = new Map(f.data.titles.map((t) => [t.slideNumber, t]));
    expect([...by.keys()]).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(by.get(1)).toMatchObject({ placeholderType: "ctrTitle", sizesPt: [60], inheritedFrom: "layout", text: "Welcome", shapeId: 2, shapeName: "Title 1" });
    expect(by.get(2)).toMatchObject({ placeholderType: "title", sizesPt: [32], inheritedFrom: "shape" });
    expect(by.get(3)).toMatchObject({ sizesPt: [36], inheritedFrom: "layout", autofit: "shrink", autofitFrom: "layout" });
    expect(by.get(3)!.fontScale).toBeUndefined();
    expect(by.get(4)).toMatchObject({ sizesPt: [40], inheritedFrom: "master", autofit: "none", autofitFrom: "default" });
    expect(by.get(5)).toMatchObject({ sizesPt: [28, 40], inheritedFrom: "shape", text: "Q3 Results" });
    expect(by.get(6)).toMatchObject({ sizesPt: [44], autofit: "shrink", autofitFrom: "shape", fontScale: 62.5, lnSpcReduction: 20 });
    expect(by.get(8)).toMatchObject({ sizesPt: [32], hidden: true });
    expect(by.get(9)).toMatchObject({ sizesPt: [24], inheritedFrom: "shape" });

    expect(f.data.distinctSizesPt).toEqual([24, 28, 32, 36, 40, 44, 60]);
    expect(f.data.slidesWithoutTitle).toEqual([7]);
  });

  it("targets every slide title shape, reachable, on the text property", async () => {
    const f = ofKind(await run(await titlesDeck()), "slide-titles")[0]!;
    expect(f.targets).toHaveLength(8);
    for (const t of f.targets) {
      expect(t.container.kind).toBe("slide");
      expect(t.shapeId).toBe(2);
      expect(t.reachable).toBe(true);
      expect(t.locator).toEqual({ property: "text" });
    }
    expect(f.targets.map((t) => t.container.partName)).toContain(slidePart(8));
  });

  it("lists layout and master titles with the size defined on each", async () => {
    const f = ofKind(await run(await titlesDeck()), "slide-titles")[0]!;
    expect(f.data.layoutTitles).toEqual([
      { partName: layoutPart(1), name: "Title Slide", placeholderType: "ctrTitle", sizePt: 60, effectiveSizePt: 60 },
      { partName: layoutPart(2), name: "Big Title", placeholderType: "title", sizePt: 36, effectiveSizePt: 36 },
      { partName: layoutPart(3), name: "Plain", placeholderType: "title", effectiveSizePt: 40 },
    ]);
    expect(f.data.masterTitles).toEqual([{ partName: masterPart(1), name: expect.any(String), sizePt: 40, effectiveSizePt: 40 }]);
  });

  it("falls back to 18pt when nothing defines a size", async () => {
    const f = ofKind(await run(await defaultSizeDeck()), "slide-titles")[0]!;
    expect(f.data.titles[0]).toMatchObject({ sizesPt: [18], inheritedFrom: "default" });
    expect(f.data.masterTitles[0]!.sizePt).toBeUndefined();
    expect(f.data.masterTitles[0]!.effectiveSizePt).toBe(18);
  });

  it("emits nothing when no slide has a title", async () => {
    const fs = await run(await buildDeck({ slides: [{ layout: "Blank" }] }));
    expect(fs.filter((f) => f.area === "fonts")).toHaveLength(0);
  });
});

describe("title-sizes-inconsistent", () => {
  it("warns per placeholder type when titles use more than one size", async () => {
    const fs = await run(await titlesDeck());
    const inc = ofKind(fs, "title-sizes-inconsistent");
    expect(inc).toHaveLength(1);
    const f = inc[0]!;
    expect(f.severity).toBe("warning");
    expect(f.area).toBe("fonts");
    expect(f.fixes).toEqual(["set-title-size"]);
    expect(f.reachable).toBe(true);
    expect(f.data.placeholderType).toBe("title");
    expect(f.data.sizes).toEqual([
      { sizePt: 24, slideNumbers: [9] },
      { sizePt: 28, slideNumbers: [5] },
      { sizePt: 32, slideNumbers: [2, 8] },
      { sizePt: 36, slideNumbers: [3] },
      { sizePt: 40, slideNumbers: [4, 5] },
      { sizePt: 44, slideNumbers: [6] },
    ]);
    expect(f.data.mostCommonPt).toBe(40); // 32 and 40 tie at two slides each → the larger
    // the ctrTitle slide is not a target
    expect(f.targets.map((t) => t.container.slideNumber)).not.toContain(1);
  });

  it("does not compare title-slide (ctrTitle) sizes with content titles", async () => {
    const fs = await run(await consistentTitlesDeck());
    expect(ofKind(fs, "title-sizes-inconsistent")).toHaveLength(0);
    const f = ofKind(fs, "slide-titles")[0]!;
    expect(f.data.distinctSizesPt).toEqual([40, 60]);
  });
});

describe("title-autofit-shrinks", () => {
  it("reports titles shrunk by normAutofit fontScale", async () => {
    const fs = await run(await titlesDeck());
    const s = ofKind(fs, "title-autofit-shrinks");
    expect(s).toHaveLength(1);
    const f = s[0]!;
    expect(f.severity).toBe("info");
    expect(f.area).toBe("fonts");
    expect(f.targets).toHaveLength(1);
    expect(f.targets[0]!.container.slideNumber).toBe(6);
    expect(f.data.titles).toEqual([
      expect.objectContaining({ slideNumber: 6, fontScale: 62.5, lnSpcReduction: 20, sizesPt: [44], renderedSizesPt: [27.5] }),
    ]);
  });

  it("is absent when no title is shrunk", async () => {
    expect(ofKind(await run(await consistentTitlesDeck()), "title-autofit-shrinks")).toHaveLength(0);
  });
});

describe("slide-numbers", () => {
  it("lists placeholders, field-only text boxes, and mixed text (unreachable), including hidden slides", async () => {
    const fs = await run(await slideNumbersDeck());
    const nums = ofKind(fs, "slide-numbers");
    expect(nums).toHaveLength(1);
    const f = nums[0]!;
    expect(f.area).toBe("review");
    expect(f.severity).toBe("info");
    expect(f.fixes).toEqual(["remove-slide-numbers"]);
    expect(f.reachable).toBe(true);
    expect(f.data.slidesWithNumbers).toEqual([1, 2, 3, 4]);
    expect(f.data.slides).toEqual([
      expect.objectContaining({ slideNumber: 1, shapeId: 3, kind: "placeholder", text: "1" }),
      expect.objectContaining({ slideNumber: 2, shapeId: 3, kind: "placeholder", hidden: true }),
      expect.objectContaining({ slideNumber: 3, shapeId: 2, shapeName: "Number Box", kind: "field-only-textbox" }),
      expect.objectContaining({ slideNumber: 4, shapeId: 2, shapeName: "Page Box", kind: "field-in-text", text: "Page 4 of 10", reason: expect.any(String) }),
    ]);

    const t = new Map(f.targets.map((x) => [x.container.slideNumber, x]));
    expect(t.get(1)).toMatchObject({ shapeId: 3, reachable: true, locator: { property: "placeholder" } });
    expect(t.get(2)).toMatchObject({ reachable: true, locator: { property: "placeholder" } });
    expect(t.get(3)).toMatchObject({ shapeId: 2, reachable: true, locator: { property: "text" } });
    expect(t.get(4)).toMatchObject({ shapeId: 2, reachable: false, locator: { property: "text" } });
    expect(t.has(5)).toBe(false);
  });

  it("lists layout / master sldNum placeholders and header-footer flags without targeting them", async () => {
    const f = ofKind(await run(await slideNumbersDeck()), "slide-numbers")[0]!;
    expect(f.data.layoutsWithSldNumPlaceholder).toEqual([{ partName: layoutPart(1), name: "Numbered" }]);
    expect(f.data.mastersWithSldNumPlaceholder).toEqual([{ partName: masterPart(1), name: expect.any(String) }]);
    expect(f.data.headerFooterFlag).toEqual([
      { partName: layoutPart(1), containerKind: "layout", sldNum: false },
      { partName: masterPart(1), containerKind: "master", sldNum: true },
    ]);
    expect(f.targets.every((t) => t.container.kind === "slide")).toBe(true);
  });

  it("emits nothing when no slide shows a number", async () => {
    expect(ofKind(await run(await titlesDeck()), "slide-numbers")).toHaveLength(0);
  });
});

describe("integration with the runner", () => {
  it("adds no warnings to the clean corpus deck", async () => {
    const res = await runChecks(await corpusDeck("clean"), {}, { checks: CHECKS });
    const mine = res.findings.filter((f) => ["slide-titles", "title-sizes-inconsistent", "title-autofit-shrinks", "slide-numbers"].includes(f.kind));
    expect(mine.map((f) => f.kind)).toEqual(["slide-titles"]);
    expect(mine.every((f) => f.severity === "info")).toBe(true);
    expect(res.errors).toEqual([]);
    const base = await runChecks(await corpusDeck("clean"), {}, { checks: CHECKS.filter((c) => !titleNumberChecks.includes(c)) });
    expect(res.stats.perArea.fonts.warning).toBe(base.stats.perArea.fonts.warning);
    expect(res.stats.perArea.review.warning).toBe(base.stats.perArea.review.warning);
  });

  it("never fails on any corpus deck and findings are structured-clone safe", async () => {
    for (const name of CORPUS_NAMES) {
      const res = await runChecks(await corpusDeck(name), {}, { checks: titleNumberChecks });
      expect(res.errors, name).toEqual([]);
      expect(structuredClone(res.findings)).toEqual(res.findings);
    }
  });
});
