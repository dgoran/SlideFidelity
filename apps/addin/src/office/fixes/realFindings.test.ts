// @vitest-environment node
/**
 * Seam tests between real audit-core scan output and the fix planners (code-review finding #6).
 *
 * Every other fix test builds findings with hand-written factories (fakePowerPoint.ts). These scan
 * the audit-core corpus decks with `runChecks` and feed the real findings to `previewFix` /
 * `runFix`, so a change in audit-core's locator shape, reachable semantics, group path, or
 * hyperlink occurrence numbering shows up here instead of silently producing zero or wrong fix
 * targets in the add-in.
 */
import { describe, expect, it } from "vitest";
import { runChecks, type AuditResult, type Finding } from "@slidecheck/audit-core";
import { corpusDeck, SEEDS, type CorpusName } from "../../../../../packages/audit-core/test/helpers/corpus";
import { emuToPoints } from "../ids";
import { previewFix, runFix } from "./engine";
import { deleteShapesKind } from "./deleteShapes";
import { removeHyperlinkKind } from "./hyperlinks";
import { FIXED_COLOR_NOTE, replaceColorsKind, TEXT_COLOR_NOTE } from "./replaceColors";
import { replaceFontsKind } from "./replaceFonts";
import type { FixKindDef, FixKindId, FixParamsMap, FixPlan, RunFixDeps } from "./types";
import { createFakePowerPoint, run, supportsUpTo, type FakeDeck, type FakePowerPoint } from "./testing/fakePowerPoint";

const env = { isSetSupported: supportsUpTo("1.10") };

const scans = new Map<CorpusName, Promise<AuditResult>>();
function scan(name: CorpusName): Promise<AuditResult> {
  let p = scans.get(name);
  if (!p) {
    p = corpusDeck(name).then((bytes) => runChecks(bytes));
    scans.set(name, p);
  }
  return p;
}

function plan<K extends FixKindId>(kind: FixKindDef<K>, findings: readonly Finding[], params: FixParamsMap[K]): FixPlan<K> {
  const p = previewFix(kind, findings, params, env);
  if (p.status !== "ready") throw new Error(`expected ready, got ${p.status}: ${p.reason}`);
  return p.plan;
}

function deps(fake: FakePowerPoint, findings: readonly Finding[]): RunFixDeps {
  return {
    rescanForFix: async () => ({ changed: false, hash: "h", bytes: new Uint8Array(), result: { findings } }),
    run: fake.run,
    isSetSupported: supportsUpTo("1.10"),
  };
}

async function completed<K extends FixKindId>(p: ReturnType<typeof runFix<K>>) {
  const r = await p;
  if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`);
  return r.summary;
}

/** Inches (corpus spec units) to points, via EMU like the planner does. */
const inPt = (inches: number): number => emuToPoints(inches * 914400);

/** `slideId:shapeId:op` per planned target, sorted. */
const ids = (p: FixPlan): string[] => p.targets.map((t) => `${t.slideId}:${t.shapeId}:${t.op.type}`).sort();

describe("real findings: replace-font (fonts-hidden)", () => {
  const seed = SEEDS["fonts-hidden"];
  const everyFont = ["Calibri", "MS Gothic", "Wingdings", "Consolas", "Arial Narrow", "Segoe UI", "Georgia"];

  it("plans the direct latin Calibri run as the only reachable target", async () => {
    const { findings } = await scan("fonts-hidden");
    const p = plan(replaceFontsKind, findings, { from: ["Calibri"], to: "Arial" });
    expect(ids(p)).toEqual([`256:${seed.ae1.shapeId}:font-text`]);
    const t = p.targets[0]!;
    expect(t.slideNumber).toBe(seed.ae1.slide);
    expect(t.shapeName).toBe("TextBox 3");
    expect(t.path).toEqual([]);
    expect(t.left).toBe(inPt(1));
    expect(t.top).toBe(inPt(2));
    expect(t.sources.every((s) => s.locator?.script === "latin" && s.locator.property === "text")).toBe(true);
    // Calibri is the theme minor font: the theme-inheritance caveat is disclosed.
    expect(p.notes.some((n) => /Calibri is also a theme font/.test(n))).toBe(true);
  });

  it("lists ea, bullet, hidden list style, theme, master, chart, and SmartArt usages as unreachable, never as targets", async () => {
    const { findings } = await scan("fonts-hidden");
    const p = plan(replaceFontsKind, findings, { from: everyFont, to: "Arial" });
    expect(ids(p)).toEqual([`256:${seed.ae1.shapeId}:font-text`]);

    const reasonFor = (pred: (u: FixPlan["unreachable"][number]) => boolean): string[] => p.unreachable.filter(pred).map((u) => u.reason);
    const onSlideShape = (shapeId: number, script: string) => (u: FixPlan["unreachable"][number]) =>
      u.target.container.kind === "slide" && u.target.shapeId === shapeId && u.target.locator?.script === script;

    // AE1: MS Gothic (ea) and Wingdings (bullet, hidden list style) on the same shape as the target.
    expect(reasonFor(onSlideShape(seed.ae1.shapeId, "ea"))).toEqual([expect.stringMatching(/East Asian/)]);
    expect(reasonFor(onSlideShape(seed.ae1.shapeId, "bu"))).toEqual([expect.stringMatching(/hidden list style/i)]);
    // Theme reference (+mn-lt) on shape 5.
    expect(reasonFor((u) => u.target.shapeId === seed.themeReference.shapeId)).toEqual([expect.stringMatching(/Theme font reference \(\+mn-lt\)/)]);
    // Consolas in an empty shape's list style.
    expect(reasonFor((u) => u.target.shapeId === seed.emptyShapeListStyleFont.shapeId)).toEqual([expect.stringMatching(/hidden list style/i)]);
    // Chart and SmartArt parts.
    expect(reasonFor((u) => u.target.container.partName === seed.chartOnlyFont.part)).toEqual([expect.stringMatching(/chart/i)]);
    for (const part of seed.smartArtFont.parts) {
      expect(reasonFor((u) => u.target.container.partName === part)).toEqual([expect.stringMatching(/SmartArt/)]);
    }
    // Georgia (and the theme refs) in the master text styles.
    const master = p.unreachable.filter((u) => u.target.container.partName === seed.masterTextStyleFont.master);
    expect(master.length).toBeGreaterThan(0);
    for (const u of master) expect(u.reason).toMatch(/layout or master|Theme font reference/);
    expect(master.some((u) => u.reason.startsWith("On a slide layout or master"))).toBe(true);

    // Nothing unreachable leaked into the targets, and every target source is a reachable slide run.
    for (const t of p.targets) for (const s of t.sources) expect(s.reachable).toBe(true);
    const targetSources = new Set(p.targets.flatMap((t) => t.sources));
    for (const u of p.unreachable) expect(targetSources.has(u.target)).toBe(false);
  });

  it("applies to the live shape the planned ids resolve to, leaving the theme-reference shape alone", async () => {
    const { findings } = await scan("fonts-hidden");
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            { id: "4", name: "TextBox 3", left: inPt(1), top: inPt(2), runs: [run("Mixed script text", "Calibri")] },
            // Theme reference: PowerPoint reports the resolved name, so it also reads "Calibri".
            { id: "5", name: "TextBox 4", left: inPt(1), top: inPt(3.5), runs: [run("Theme minor", "Calibri")] },
            { id: "6", name: "Rectangle 5", left: inPt(1), top: inPt(5) },
          ],
        },
        { id: "257#", shapes: [] },
      ],
    };
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Calibri"], to: "Arial" }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    expect(summary.skipped).toEqual([]);
    const [ae1, themeRef] = fake.deck.slides[0]!.shapes;
    expect(ae1!.runs!.map((r) => r.font.name)).toEqual(["Arial"]);
    expect(themeRef!.runs!.map((r) => r.font.name)).toEqual(["Calibri"]);
  });
});

describe("real findings: replace-color (colors-literal)", () => {
  const seed = SEEDS["colors-literal"];

  it("plans the solid fill, line, and run color literals as reachable targets", async () => {
    const { findings } = await scan("colors-literal");
    const p = plan(replaceColorsKind, findings, { from: ["#4472c4", "FF0000", "7030A0"], to: "#1F4E79" });
    expect(ids(p)).toEqual(["256:2:color-fill", "256:3:color-text", "256:4:color-line", "258:2:color-fill"]);
    expect(p.unreachable).toEqual([]);
    expect(p.notes).toEqual(expect.arrayContaining([FIXED_COLOR_NOTE, TEXT_COLOR_NOTE]));
    expect(p.perSlide).toEqual([
      { slideId: 256, slideNumber: 1, count: 3 },
      { slideId: 258, slideNumber: 3, count: 1 },
    ]);
  });

  it("D1: a literal equal to a theme slot is still a literal and reachable", async () => {
    const { findings } = await scan("colors-literal");
    const p = plan(replaceColorsKind, findings, { from: [seed.autoMatchable.hex], to: "#1F4E79" });
    expect(ids(p)).toEqual(["256:2:color-fill"]);
  });

  it("D2: a gradient stop is unreachable; a theme color with modifiers is not a literal at all", async () => {
    const { findings } = await scan("colors-literal");
    const p = plan(replaceColorsKind, findings, { from: [seed.gradientLiteral.hex], to: "#1F4E79" });
    expect(p.targets).toEqual([]);
    expect(p.unreachable).toHaveLength(1);
    expect(p.unreachable[0]!.target.shapeName).toBe("Gradient");
    expect(p.unreachable[0]!.reason).toMatch(/gradient/i);

    // accent2 + lumMod/lumOff on slide 2 shape 2 never appears in any replace-color plan.
    const all = plan(replaceColorsKind, findings, { from: ["4472C4", "FF0000", "00B050", "7030A0", "ED7D31"], to: "#1F4E79" });
    const onThemeTinted = (s: { container: { slideId?: number }; shapeId?: number }) =>
      s.container.slideId === 257 && s.shapeId === seed.themeWithModifiers.shapeId;
    expect(all.targets.flatMap((t) => t.sources).some(onThemeTinted)).toBe(false);
    expect(all.unreachable.map((u) => u.target).some(onThemeTinted)).toBe(false);
  });

  it("applies each planned unit to exactly the property it names on the live shape", async () => {
    const { findings } = await scan("colors-literal");
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            { id: "2", name: "Accent literal", left: inPt(1), top: inPt(1), fill: { type: "Solid", foregroundColor: "#4472C4" } },
            { id: "3", name: "Red text", left: inPt(3), top: inPt(1), runs: [run("Alert", "Calibri", "#FF0000")] },
            { id: "4", name: "Red line", left: inPt(7), top: inPt(1), fill: { type: "NoFill", foregroundColor: "" }, line: { color: "#FF0000" } },
          ],
        },
        {
          id: "257#",
          shapes: [
            { id: "2", name: "Theme tinted", left: inPt(1), top: inPt(1), fill: { type: "Solid", foregroundColor: "#F4B183" } },
            { id: "3", name: "Gradient", left: inPt(3), top: inPt(1), fill: { type: "Gradient", foregroundColor: "#00B050" } },
          ],
        },
        { id: "258#", shapes: [{ id: "2", name: "Purple", left: inPt(1), top: inPt(1), fill: { type: "Solid", foregroundColor: "#7030A0" } }] },
      ],
    };
    const fake = createFakePowerPoint(deck);
    const summary = await completed(
      runFix(replaceColorsKind, { from: ["4472C4", "FF0000", "7030A0", "00B050"], to: "#1F4E79" }, deps(fake, findings)),
    );
    expect(summary.changed).toBe(4);
    expect(summary.skipped).toEqual([]);
    expect(summary.unreachable).toHaveLength(1);
    const [s1, s2, s3] = fake.deck.slides;
    expect(s1!.shapes[0]!.fill!.foregroundColor.toUpperCase()).toBe("#1F4E79");
    expect(s1!.shapes[1]!.runs![0]!.font.color.toUpperCase()).toBe("#1F4E79");
    expect(s1!.shapes[2]!.line!.color.toUpperCase()).toBe("#1F4E79");
    expect(s3!.shapes[0]!.fill!.foregroundColor.toUpperCase()).toBe("#1F4E79");
    expect(s2!.shapes.map((s) => s.fill!.foregroundColor)).toEqual(["#F4B183", "#00B050"]);
  });
});

describe("real findings: delete-shapes (review-leaks)", () => {
  const seed = SEEDS["review-leaks"];

  it("targets only the hidden, off-slide, and empty-placeholder slide shapes", async () => {
    const { findings } = await scan("review-leaks");
    const p = plan(deleteShapesKind, findings, { all: true });
    expect(ids(p)).toEqual(
      [
        `258:${seed.hiddenShape.shapeId}:delete-shape`,
        `258:${seed.offSlideShape.shapeId}:delete-shape`,
        ...seed.emptyPlaceholders.map((e) => `259:${e.shapeId}:delete-shape`),
      ].sort(),
    );
    // Not the partly-off shape, the picture-only placeholder, or anything on the hidden slide.
    expect(p.targets.some((t) => t.slideId === 258 && t.shapeId === seed.partlyOffSlideShape.shapeId)).toBe(false);
    expect(p.targets.some((t) => t.slideId === 259 && t.shapeId === seed.pictureOnlyPlaceholder.shapeId)).toBe(false);
    expect(p.targets.some((t) => t.slideId === seed.hiddenSlide.slideId)).toBe(false);
    expect(p.targets.every((t) => t.sources.every((s) => s.container.kind === "slide"))).toBe(true);
    // The corpus has no deletable layout/master shapes, so nothing is unreachable here; the
    // layout/master branch is covered by the factory-based test in deleteShapes.test.ts.
    expect(p.unreachable).toEqual([]);
    expect(p.destructive).toBe(true);
  });

  it("deletes exactly the planned shape ids from the live slides", async () => {
    const { findings } = await scan("review-leaks");
    const deck: FakeDeck = {
      slides: [
        { id: "256#", shapes: [{ id: "2", name: "Title 1" }] },
        { id: "257#", shapes: [{ id: "2", name: "Title 1" }] },
        {
          id: "258#",
          shapes: [
            { id: "2", name: "Hidden note", left: inPt(1), top: inPt(1), visible: false, runs: [run("draft", "Calibri")] },
            { id: "3", name: "Off slide", left: inPt(14), top: inPt(1), runs: [run("parked", "Calibri")] },
            { id: "4", name: "Partly off", left: inPt(12), top: inPt(1), runs: [run("edge", "Calibri")] },
          ],
        },
        {
          id: "259#",
          shapes: [
            { id: "2", name: "Title 1", left: emuToPoints(838200), top: emuToPoints(365125) },
            { id: "3", name: "Content Placeholder 2", left: emuToPoints(838200), top: emuToPoints(1825625) },
            { id: "4", name: "Picture Placeholder 3", left: inPt(7), top: inPt(2) },
          ],
        },
        { id: "260#", shapes: [{ id: "2", name: "Bilingual" }] },
      ],
    };
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(deleteShapesKind, { all: true }, deps(fake, findings)));
    expect(summary.changed).toBe(4);
    expect(summary.skipped).toEqual([]);
    expect(fake.deck.slides.map((s) => s.shapes.map((sh) => sh.id))).toEqual([["2"], ["2"], ["4"], ["4"], ["2"]]);
  });
});

describe("real findings: remove-hyperlink (links)", () => {
  const seed = SEEDS.links;

  it("targets only slide click links; the layout link is unreachable; local paths and slide jumps are not offered", async () => {
    const { findings } = await scan("links");
    const p = plan(removeHyperlinkKind, findings, { all: true });
    const keys = p.targets.map((t) => (t.op.type === "hyperlink" ? `${t.slideId}|${t.op.address}|${t.op.occurrence}/${t.op.sameAddressCount}` : "?")).sort();
    expect(keys).toEqual(
      [
        `256|${seed.webHyperlinks[0].url}|0/1`,
        `256|${seed.webHyperlinks[1].url}|0/1`,
        `257|${seed.webHyperlinks[2].url}|0/1`,
      ].sort(),
    );
    // Links with one address on one slide share a batch.
    for (const t of p.targets) expect(t.batchKey).toBe(`${t.slideId}|${t.op.type === "hyperlink" ? t.op.address : ""}`);

    expect(p.unreachable).toHaveLength(1);
    const layout = p.unreachable[0]!;
    expect(layout.target.container.partName).toBe(seed.layoutLink.layout);
    expect(layout.target.locator?.hyperlink).toBeUndefined();
    expect(layout.reason).toMatch(/layout or master/);

    // The local-path OLE link and the internal slide jump are reported elsewhere but never planned.
    const everything = [...p.targets.flatMap((t) => t.sources), ...p.unreachable.map((u) => u.target)];
    expect(everything.some((s) => s.locator?.relId === "rIdOle" || s.locator?.relId === "rIdJump")).toBe(false);
    expect(findings.some((f) => f.kind === "local-path-link")).toBe(true);
    for (const f of findings) if (f.kind === "local-path-link") expect(f.fixes).not.toContain("remove-hyperlink");
  });

  it("removes the planned links from the live slides by address + occurrence", async () => {
    const { findings } = await scan("links");
    const [a, b, c] = seed.webHyperlinks;
    const deck: FakeDeck = {
      slides: [
        { id: "256#", shapes: [], hyperlinks: [{ address: a.url }, { address: b.url }] },
        { id: "257#", shapes: [], hyperlinks: [{ address: c.url }] },
      ],
    };
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(removeHyperlinkKind, { all: true }, deps(fake, findings)));
    expect(summary.changed).toBe(3);
    expect(summary.skipped).toEqual([]);
    expect(fake.deck.slides.map((s) => s.hyperlinks)).toEqual([[], []]);
  });
});
