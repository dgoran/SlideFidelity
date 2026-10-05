// @vitest-environment node
/**
 * set-title-size and remove-slide-numbers, planned from real audit-core findings (a buildDeck deck
 * scanned with `runChecks`) and applied to the fake PowerPoint model.
 */
import { describe, expect, it } from "vitest";
import { runChecks, type Finding } from "@slidefidelity/audit-core";
import { buildDeck, para, run as xmlRun, sp } from "../../../../../packages/audit-core/test/helpers/buildDeck";
import { emuToPoints } from "../ids";
import { previewFix, runFix } from "./engine";
import { EXACT_ID_NOTE, HEADER_FOOTER_NOTE, MIXED_NUMBER_REASON, removeSlideNumbersKind } from "./slideNumbers";
import { LAYOUTS_REASON, setTitleSizeKind, SHRINK_NOTE } from "./titleSize";
import type { FixKindDef, FixKindId, FixParamsMap, FixPlan, RunFixDeps, SetTitleSizeParams } from "./types";
import { createFakePowerPoint, supportsUpTo, type FakeDeck, type FakePowerPoint, type FakeShape } from "./testing/fakePowerPoint";

const IN = 914400;
const env = { isSetSupported: supportsUpTo("1.10") };

const fld = (text: string): string => `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>${text}</a:t></a:fld>`;
const sized = (text: string, pt: number): string => para(xmlRun(text, { attrs: `lang="en-US" sz="${pt * 100}"` }));
const title = (text: string, pt: number, type = "title", bodyPr?: string): string =>
  sp({ id: 2, name: "Title 1", ph: { type }, noXfrm: true, paragraphs: sized(text, pt), ...(bodyPr ? { bodyPr } : {}) });
const sldNum = (n: number): string =>
  sp({ id: 3, name: "Slide Number Placeholder 2", ph: { type: "sldNum", idx: 12 }, noXfrm: true, paragraphs: para(fld(String(n))) });

/**
 * Slides (ids 256–260):
 *  1 ctrTitle 54 pt
 *  2 title 32 pt + sldNum placeholder
 *  3 title 40 pt + sldNum placeholder
 *  4 title 40 pt (shrink to fit, 80%) + field-only text box "Number Box"
 *  5 title 32 pt + "Page <n> of 10" text box (mixed)
 */
function deckBytes(): Promise<Uint8Array> {
  return buildDeck({
    masters: [
      {
        shapes:
          sp({ id: 2, name: "Title Placeholder 1", ph: { type: "title" }, x: IN, y: IN / 2, cx: 10 * IN, cy: IN, text: "Master title" }) +
          sp({ id: 4, name: "Slide Number Placeholder 3", ph: { type: "sldNum", idx: 12 }, x: 10 * IN, y: 7 * IN, cx: IN, cy: IN / 2, text: "‹#›" }),
        layouts: [
          { name: "Title Slide", type: "title", shapes: sp({ id: 2, name: "Title 1", ph: { type: "ctrTitle" }, noXfrm: true, text: "Layout ctr" }) },
          {
            name: "Content",
            type: "obj",
            shapes:
              sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Layout title" }) +
              sp({ id: 3, name: "Slide Number Placeholder 2", ph: { type: "sldNum", idx: 12 }, x: 10 * IN, y: 7 * IN, cx: IN, cy: IN / 2, text: "‹#›" }),
          },
        ],
      },
    ],
    slides: [
      { layout: "Title Slide", shapes: title("Welcome", 54, "ctrTitle") },
      { layout: "Content", shapes: title("Agenda", 32) + sldNum(2) },
      { layout: "Content", shapes: title("Numbers", 40) + sldNum(3) },
      {
        layout: "Content",
        shapes:
          title("A long title", 40, "title", `<a:normAutofit fontScale="80000"/>`) +
          sp({ id: 3, name: "Number Box", x: IN, y: 7 * IN, cx: IN, cy: IN / 2, paragraphs: para(xmlRun("  ") + fld("4")) }),
      },
      {
        layout: "Content",
        shapes: title("Wrap-up", 32) + sp({ id: 3, name: "Page Box", x: IN, y: 7 * IN, cx: 2 * IN, cy: IN / 2, paragraphs: para(xmlRun("Page ") + fld("5") + xmlRun(" of 10")) }),
      },
    ],
  });
}

let scanned: Promise<Finding[]> | undefined;
function findings(): Promise<Finding[]> {
  scanned ??= deckBytes().then(async (b) => (await runChecks(b)).findings);
  return scanned;
}

const pt = (inches: number) => emuToPoints(inches * IN);
const titleShape = (text: string, size: number, placeholderType = "Title"): FakeShape => ({
  id: "2",
  name: "Title 1",
  placeholderType,
  runs: [{ text, font: { name: "Calibri", color: "#000000", size } }],
});
const sldNumShape = (n: number): FakeShape => ({
  id: "3",
  name: "Slide Number Placeholder 2",
  left: pt(10),
  top: pt(7),
  placeholderType: "SlideNumber",
  runs: [{ text: String(n), font: { name: "Calibri", color: "#000000" } }],
});

function liveDeck(): FakeDeck {
  return {
    slides: [
      { id: "256#", shapes: [titleShape("Welcome", 54, "CenterTitle")] },
      { id: "257#", shapes: [titleShape("Agenda", 32), sldNumShape(2)] },
      { id: "258#", shapes: [titleShape("Numbers", 40), sldNumShape(3)] },
      {
        id: "259#",
        shapes: [titleShape("A long title", 40), { id: "3", name: "Number Box", left: pt(1), top: pt(7), runs: [{ text: "  4", font: { name: "Calibri", color: "#000000" } }] }],
      },
      {
        id: "260#",
        shapes: [titleShape("Wrap-up", 32), { id: "3", name: "Page Box", left: pt(1), top: pt(7), runs: [{ text: "Page 5 of 10", font: { name: "Calibri", color: "#000000" } }] }],
      },
    ],
    masters: [
      {
        id: "2147483648",
        name: "Office Theme",
        shapes: [titleShape("Master title", 44), { id: "4", name: "Slide Number Placeholder 3", placeholderType: "SlideNumber", runs: [] }],
        layouts: [
          { id: "2147483649", name: "Title Slide", shapes: [titleShape("Layout ctr", 60, "CenterTitle")] },
          { id: "2147483650", name: "Content", shapes: [titleShape("Layout title", 44), sldNumShape(0)] },
        ],
      },
    ],
  };
}

function plan<K extends FixKindId>(kind: FixKindDef<K>, fs: readonly Finding[], params: FixParamsMap[K], isSetSupported = env.isSetSupported): FixPlan<K> {
  const p = previewFix(kind, fs, params, { isSetSupported });
  if (p.status !== "ready") throw new Error(`expected ready, got ${p.status}: ${p.reason}`);
  return p.plan;
}

function deps(fake: FakePowerPoint, fs: readonly Finding[], opts: { changed?: boolean; max?: string } = {}): RunFixDeps {
  return {
    rescanForFix: async () => ({ changed: opts.changed ?? false, hash: "h2", bytes: new Uint8Array([1]), result: { findings: fs } }),
    run: fake.run,
    isSetSupported: supportsUpTo(opts.max ?? "1.10"),
  };
}

async function completed<K extends FixKindId>(p: ReturnType<typeof runFix<K>>) {
  const r = await p;
  if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`);
  return r.summary;
}

const sizes = (deck: FakeDeck) => deck.slides.map((s) => s.shapes[0]!.runs![0]!.font.size);
const ALL: SetTitleSizeParams = { sizePt: 36, scope: "all" };

describe("set-title-size", () => {
  it("plans every slide title from the slide-titles finding with current and new size", async () => {
    const fs = await findings();
    const p = plan(setTitleSizeKind, fs, ALL);
    expect(p.destructive).toBe(false);
    expect(p.targets.map((t) => `${t.slideNumber}:${t.shapeId}`)).toEqual(["1:2", "2:2", "3:2", "4:2", "5:2"]);
    expect(p.targets.map((t) => (t.op.type === "title-size" ? t.op.fromPt : null))).toEqual([[54], [32], [40], [40], [32]]);
    expect(p.targets.every((t) => t.op.type === "title-size" && t.op.sizePt === 36)).toBe(true);
    expect(p.unreachable).toEqual([]);
    expect(p.perSlide).toHaveLength(5);
    expect(p.notes).toContain(SHRINK_NOTE);
    expect(p.notes.some((n) => /undo/i.test(n))).toBe(true);
  });

  it("sets the size on all titles", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(setTitleSizeKind, ALL, deps(fake, fs)));
    expect(summary.changed).toBe(5);
    expect(sizes(fake.deck)).toEqual([36, 36, 36, 36, 36]);
    // Layouts untouched without alsoLayouts.
    expect(fake.deck.masters![0]!.layouts[1]!.shapes[0]!.runs![0]!.font.size).toBe(44);
  });

  it("scopes by slide ids", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(setTitleSizeKind, { sizePt: 28, scope: { slideIds: [257, 260] } }, deps(fake, fs)));
    expect(summary.changed).toBe(2);
    expect(sizes(fake.deck)).toEqual([54, 28, 40, 40, 28]);
  });

  it("leaves title slides alone when only slide titles are chosen", async () => {
    const fs = await findings();
    const p = plan(setTitleSizeKind, fs, { ...ALL, placeholderTypes: ["title"] });
    expect(p.targets.map((t) => t.slideNumber)).toEqual([2, 3, 4, 5]);
    const fake = createFakePowerPoint(liveDeck());
    await completed(runFix(setTitleSizeKind, { ...ALL, placeholderTypes: ["title"] }, deps(fake, fs)));
    expect(sizes(fake.deck)).toEqual([54, 36, 36, 36, 36]);
    expect(plan(setTitleSizeKind, fs, { ...ALL, placeholderTypes: ["ctrTitle"] }).targets.map((t) => t.slideNumber)).toEqual([1]);
  });

  it("also updates layout and master titles (1.8), outside the per-slide counts", async () => {
    const fs = await findings();
    const params: SetTitleSizeParams = { ...ALL, alsoLayouts: true };
    const p = plan(setTitleSizeKind, fs, params);
    const layoutUnits = p.targets.filter((t) => t.op.type === "title-size-layout");
    expect(layoutUnits.map((t) => t.label)).toEqual(['Layout "Title Slide" · title', 'Layout "Content" · title', "Slide master · title"]);
    expect(p.perSlide).toHaveLength(5);

    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(setTitleSizeKind, params, deps(fake, fs)));
    expect(summary.changed).toBe(8);
    const m = fake.deck.masters![0]!;
    expect(m.shapes[0]!.runs![0]!.font.size).toBe(36);
    expect(m.layouts[0]!.shapes[0]!.runs![0]!.font.size).toBe(36);
    expect(m.layouts[1]!.shapes[0]!.runs![0]!.font.size).toBe(36);
    // The layout slide-number placeholder is not a title.
    expect(m.layouts[1]!.shapes[1]!.runs![0]!.font.size).toBeUndefined();
  });

  it("only the ctrTitle layout follows when only title slides are chosen", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    await completed(runFix(setTitleSizeKind, { ...ALL, placeholderTypes: ["ctrTitle"], alsoLayouts: true }, deps(fake, fs)));
    const m = fake.deck.masters![0]!;
    expect(m.layouts[0]!.shapes[0]!.runs![0]!.font.size).toBe(36);
    expect(m.layouts[1]!.shapes[0]!.runs![0]!.font.size).toBe(44);
    expect(m.shapes[0]!.runs![0]!.font.size).toBe(44);
  });

  it("lists layouts and masters as unreachable below 1.8, still sizing slide titles", async () => {
    const fs = await findings();
    const params: SetTitleSizeParams = { ...ALL, alsoLayouts: true };
    const p = plan(setTitleSizeKind, fs, params, supportsUpTo("1.7"));
    expect(p.targets).toHaveLength(5);
    expect(p.unreachable.map((u) => u.reason)).toEqual([LAYOUTS_REASON, LAYOUTS_REASON, LAYOUTS_REASON]);
    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(setTitleSizeKind, params, deps(fake, fs, { max: "1.7" })));
    expect(summary.changed).toBe(5);
    expect(fake.deck.masters![0]!.layouts[1]!.shapes[0]!.runs![0]!.font.size).toBe(44);
  });

  it("allows a name + position fallback match (not destructive), using the inherited position", async () => {
    const fs = await findings();
    const t = plan(setTitleSizeKind, fs, ALL).targets[1]!;
    expect([t.left, t.top]).toEqual([pt(1), pt(0.5)]); // from the master title placeholder
    const deck = liveDeck();
    Object.assign(deck.slides[1]!.shapes[0]!, { id: "99", left: pt(1), top: pt(0.5) });
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(setTitleSizeKind, ALL, deps(fake, fs)));
    expect(summary.changed).toBe(5);
    expect(sizes(fake.deck)).toEqual([36, 36, 36, 36, 36]);
  });

  it("rejects sizes outside 6–200 pt and empty choices", async () => {
    const fs = await findings();
    for (const sizePt of [0, 5.5, 201, Number.NaN]) {
      expect(previewFix(setTitleSizeKind, fs, { sizePt, scope: "all" }, env).status).toBe("invalid");
    }
    expect(previewFix(setTitleSizeKind, fs, { sizePt: 6, scope: "all" }, env).status).toBe("ready");
    expect(previewFix(setTitleSizeKind, fs, { sizePt: 200, scope: "all" }, env).status).toBe("ready");
    expect(previewFix(setTitleSizeKind, fs, { sizePt: 30, scope: { slideIds: [] } }, env).status).toBe("invalid");
    expect(previewFix(setTitleSizeKind, fs, { sizePt: 30, scope: "all", placeholderTypes: [] }, env).status).toBe("invalid");
    expect(previewFix(setTitleSizeKind, fs, { sizePt: 30, scope: "all" }, { isSetSupported: supportsUpTo("1.3") }).status).toBe("blocked");
  });

  it("D4: re-plans without writing when the file changed", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    const r = await runFix(setTitleSizeKind, ALL, deps(fake, fs, { changed: true }));
    expect(r.status).toBe("replanned");
    if (r.status === "replanned") {
      expect(r.hash).toBe("h2");
      expect(r.plan.targets).toHaveLength(5);
    }
    expect(fake.writes).toEqual([]);
  });
});

describe("remove-slide-numbers", () => {
  it("plans the sldNum placeholders and the field-only box; the mixed box is unreachable", async () => {
    const fs = await findings();
    const p = plan(removeSlideNumbersKind, fs, { scope: "all" });
    expect(p.destructive).toBe(true);
    expect(p.targets.map((t) => `${t.slideNumber}:${t.shapeName}`)).toEqual(["2:Slide Number Placeholder 2", "3:Slide Number Placeholder 2", "4:Number Box"]);
    expect(p.unreachable.map((u) => `${u.target.container.slideNumber}:${u.reason}`)).toEqual([`5:${MIXED_NUMBER_REASON}`]);
    expect(p.notes).toEqual(expect.arrayContaining([HEADER_FOOTER_NOTE, EXACT_ID_NOTE]));
  });

  it("deletes exactly the reachable shapes", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(removeSlideNumbersKind, { scope: "all" }, deps(fake, fs)));
    expect(summary.changed).toBe(3);
    expect(fake.deck.slides.map((s) => s.shapes.map((x) => x.name))).toEqual([
      ["Title 1"],
      ["Title 1"],
      ["Title 1"],
      ["Title 1"],
      ["Title 1", "Page Box"],
    ]);
    // Layout and master slide-number placeholders stay.
    expect(fake.deck.masters![0]!.layouts[1]!.shapes).toHaveLength(2);
  });

  it("scopes by slide ids", async () => {
    const fs = await findings();
    const fake = createFakePowerPoint(liveDeck());
    const summary = await completed(runFix(removeSlideNumbersKind, { scope: { slideIds: [258] } }, deps(fake, fs)));
    expect(summary.changed).toBe(1);
    expect(fake.deck.slides[1]!.shapes).toHaveLength(2);
    expect(fake.deck.slides[2]!.shapes).toHaveLength(1);
  });

  it("skips a shape matched only by name and position (identity uncertain)", async () => {
    const fs = await findings();
    const deck = liveDeck();
    deck.slides[3]!.shapes[1]!.id = "77"; // the Number Box: same name and position, new id
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(removeSlideNumbersKind, { scope: "all" }, deps(fake, fs)));
    expect(summary.changed).toBe(2);
    expect(summary.skipped.map((s) => s.target.shapeName)).toEqual(["Number Box"]);
    expect(summary.skipped[0]!.reason).toMatch(/identity uncertain/i);
    expect(fake.deck.slides[3]!.shapes.map((s) => s.name)).toEqual(["Title 1", "Number Box"]);
  });

  it("requires a slide choice and re-plans on a changed file", async () => {
    const fs = await findings();
    expect(previewFix(removeSlideNumbersKind, fs, { scope: { slideIds: [] } }, env).status).toBe("invalid");
    const fake = createFakePowerPoint(liveDeck());
    const r = await runFix(removeSlideNumbersKind, { scope: "all" }, deps(fake, fs, { changed: true }));
    expect(r.status).toBe("replanned");
    expect(fake.writes).toEqual([]);
  });
});
