import { describe, expect, it } from "vitest";
import { layoutChecks, MAX_COLLISION_SHAPES_PER_SLIDE } from "../../src/checks/layout";
import { CHECKS, loadPresentation, runChecks, type Finding, type FindingOf } from "../../src/index";
import { corpusDeck } from "../helpers/corpus";
import { collisionDeck, crowdedDeck, IN, partlyOffDeck, PT } from "./layout.fixtures";

async function run(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of layoutChecks) out.push(...(await c.run({ pres, options: {} })));
  return out;
}

function ofKind<K extends Finding["kind"]>(fs: Finding[], kind: K): FindingOf<K>[] {
  return fs.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

function onSlide<F extends Finding>(fs: F[], n: number): F[] {
  return fs.filter((f) => f.targets[0]?.container.slideNumber === n);
}

describe("layout checks: partly-off-slide", () => {
  it("flags a text box hanging off the right edge as a warning with overhang data", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 1);
    const f = fs.find((x) => x.data.shapeName === "Overhang")!;
    expect(f).toBeDefined();
    expect(f.area).toBe("review");
    expect(f.severity).toBe("warning");
    expect(f.title).toBe("Text 'Overhang' extends past the right edge of slide 1");
    expect(f.fixes).toEqual([]);
    expect(f.reachable).toBe(false);
    expect(f.targets).toHaveLength(1);
    expect(f.targets[0]).toMatchObject({ shapeName: "Overhang", reachable: false, bounds: { x: 12 * IN, cx: 2 * IN } });
    expect(f.data.sides).toEqual([{ side: "right", emu: 14 * IN - 12192000, inches: 0.667 }]);
    expect(f.data.objectKind).toBe("text-box");
    expect(f.data.hasContent).toBe(true);
    expect(f.data.offSlidePercent).toBeCloseTo(33.3, 1);
    expect(f.data.inherited).toBe(false);
    expect(() => structuredClone(f)).not.toThrow();
  });

  it("reports a full-bleed picture slightly larger than the slide as info on all four sides", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 1);
    const f = fs.find((x) => x.data.shapeName === "Bleed")!;
    expect(f.severity).toBe("info");
    expect(f.data.objectKind).toBe("picture");
    expect(f.data.sides.map((s) => s.side)).toEqual(["left", "right", "top", "bottom"]);
    expect(f.title).toBe("Picture 'Bleed' extends past the left, right, top and bottom edges of slide 1");
    expect(fs).toHaveLength(2);
  });

  it("ignores overhang within tolerance, fully off-slide shapes, and hidden shapes", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 2);
    expect(fs).toEqual([]);
  });

  it("uses inherited layout bounds for a placeholder without its own xfrm", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 3);
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.severity).toBe("warning");
    expect(f.data).toMatchObject({ shapeName: "Side note 2", objectKind: "placeholder", inherited: true, inheritedFrom: "layout" });
    expect(f.targets[0]!.bounds).toEqual({ x: 12 * IN, y: 3 * IN, cx: 2 * IN, cy: IN });
  });

  it("reports groups outermost-only, escalating to warning when a child with text is cut off", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 4);
    expect(fs.map((f) => f.data.shapeName).sort()).toEqual(["Callout group", "Photo group"]);
    const callout = fs.find((f) => f.data.shapeName === "Callout group")!;
    expect(callout.severity).toBe("warning");
    expect(callout.data.contentShapes).toEqual(["Callout text"]);
    const photos = fs.find((f) => f.data.shapeName === "Photo group")!;
    expect(photos.severity).toBe("info");
    expect(photos.data.objectKind).toBe("group");
    expect(photos.data.sides).toEqual([{ side: "left", emu: IN, inches: 1 }]);
  });

  it("warns for tables, videos, and charts; rotated plain shapes use the rotated box as info", async () => {
    const fs = onSlide(ofKind(await run(await partlyOffDeck()), "partly-off-slide"), 5);
    const by = new Map(fs.map((f) => [f.data.shapeName, f]));
    expect(by.get("Results")!.severity).toBe("warning");
    expect(by.get("Results")!.data.objectKind).toBe("table");
    expect(by.get("Results")!.title).toBe("Table 'Results' extends past the bottom edge of slide 5");
    expect(by.get("Clip")!.severity).toBe("warning");
    expect(by.get("Clip")!.data.objectKind).toBe("video");
    expect(by.get("Sales")!.severity).toBe("warning");
    expect(by.get("Sales")!.data.sides.map((s) => s.side)).toEqual(["right", "top"]);
    const bar = by.get("Bar")!;
    expect(bar.severity).toBe("info");
    expect(bar.data.rotated).toBe(true);
    expect(bar.data.bounds).toEqual({ x: 5.75 * IN, y: 5 * IN, cx: 0.5 * IN, cy: 4 * IN });
    expect(bar.data.sides).toEqual([{ side: "bottom", emu: 9 * IN - 6858000, inches: 1.5 }]);
    expect(fs).toHaveLength(4);
  });
});

describe("layout checks: text-collision", () => {
  async function collisions(): Promise<FindingOf<"text-collision">[]> {
    return ofKind(await run(await collisionDeck()), "text-collision");
  }

  it("warns when text overlaps a picture, with overlap rect and both targets", async () => {
    const fs = onSlide(await collisions(), 1);
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.severity).toBe("warning");
    expect(f.title).toBe("Text 'Title 1' overlaps picture 'Photo 3' on slide 1");
    expect(f.fixes).toEqual([]);
    expect(f.reachable).toBe(false);
    expect(f.targets.map((t) => t.shapeName)).toEqual(["Title 1", "Photo 3"]);
    expect(f.targets.every((t) => t.bounds && t.reachable === false)).toBe(true);
    expect(f.data.collisions).toEqual([
      {
        shapeId: 3,
        shapeName: "Photo 3",
        shapeKind: "pic",
        objectKind: "picture",
        relation: "overlap",
        severity: "warning",
        overlap: { x: 4 * IN, y: 1.5 * IN, cx: IN, cy: 0.5 * IN },
        gapEmu: 0,
        gapPt: 0,
        rotated: false,
      },
    ]);
    expect(f.data.truncated).toBe(false);
    expect(() => structuredClone(f)).not.toThrow();
  });

  it("warns for a text box 1 pt from an image but not 3 pt away", async () => {
    const fs = onSlide(await collisions(), 2);
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.severity).toBe("warning");
    expect(f.title).toBe("Text 'Label' touches picture 'Chart image' on slide 2");
    expect(f.data.collisions).toHaveLength(1);
    expect(f.data.collisions[0]).toMatchObject({ relation: "touching", gapEmu: PT, gapPt: 1 });
    expect(f.data.collisions[0]!.overlap).toBeUndefined();
  });

  it("reports a caption fully inside an image as info", async () => {
    const fs = onSlide(await collisions(), 3);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("info");
    expect(fs[0]!.data.collisions[0]).toMatchObject({ shapeName: "Hero", relation: "text-inside", severity: "info" });
  });

  it("reports two overlapping text boxes once, on the one further back", async () => {
    const fs = onSlide(await collisions(), 4);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("warning");
    expect(fs[0]!.title).toBe("Text 'Left' overlaps text box 'Right' on slide 4");
    expect(fs[0]!.targets.map((t) => t.shapeName)).toEqual(["Left", "Right"]);
  });

  it("skips background-sized shapes and shapes with no fill or outline", async () => {
    expect(onSlide(await collisions(), 5)).toEqual([]);
  });

  it("lowers rotated text collisions to info using the rotated box", async () => {
    const fs = onSlide(await collisions(), 6);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("info");
    expect(fs[0]!.data.rotated).toBe(true);
    expect(fs[0]!.data.collisions[0]).toMatchObject({ shapeName: "Photo", rotated: true, severity: "info", relation: "overlap" });
  });

  it("compares group children, not the group container", async () => {
    const fs = onSlide(await collisions(), 7);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("warning");
    expect(fs[0]!.targets.map((t) => t.shapeName)).toEqual(["Group text", "Group pic"]);
    expect(fs[0]!.targets[0]!.path).toEqual([2]);
  });

  it("ignores hidden shapes and children of hidden groups", async () => {
    expect(onSlide(await collisions(), 8)).toEqual([]);
  });

  it("treats a table with text as a text object", async () => {
    const fs = onSlide(await collisions(), 9);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.title).toBe("Table 'Table 1' overlaps picture 'Logo' on slide 9");
    expect(fs[0]!.data.objectKind).toBe("table");
    expect(fs[0]!.severity).toBe("warning");
  });

  it("uses inherited placeholder bounds, video posters, and style-filled shapes", async () => {
    const fs = onSlide(await collisions(), 10);
    const by = new Map(fs.map((f) => [f.data.shapeName, f]));
    expect(fs).toHaveLength(2);
    const title = by.get("Title 1")!;
    expect(title.severity).toBe("warning");
    expect(title.data).toMatchObject({ inherited: true, inheritedFrom: "master", objectKind: "placeholder" });
    expect(title.data.collisions[0]).toMatchObject({ shapeName: "Clip", objectKind: "video" });
    expect(title.title).toBe("Text 'Title 1' overlaps video 'Clip' on slide 10");
    const note = by.get("Note")!;
    expect(note.data.collisions[0]).toMatchObject({ shapeName: "Badge", relation: "touching", gapEmu: 0, objectKind: "shape" });
  });

  it("caps the shapes compared per slide and records the truncation", async () => {
    const fillers = MAX_COLLISION_SHAPES_PER_SLIDE + 5;
    const fs = ofKind(await run(await crowdedDeck(fillers)), "text-collision");
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.data.collisions.map((c) => c.shapeName)).toEqual(["Early"]);
    expect(f.data.truncated).toBe(true);
    expect(f.data.shapesConsidered).toBe(MAX_COLLISION_SHAPES_PER_SLIDE);
    expect(f.data.shapesOnSlide).toBe(fillers + 3);
  });

  it("lists every colliding object without the cap on a normal slide", async () => {
    const fs = ofKind(await run(await crowdedDeck(10)), "text-collision");
    expect(fs[0]!.data.collisions.map((c) => c.shapeName)).toEqual(["Early", "Late"]);
    expect(fs[0]!.title).toBe("Text 'Crowded' overlaps picture 'Early' and 1 more object on slide 1");
    expect(fs[0]!.count).toBe(2);
    expect(fs[0]!.data.truncated).toBe(false);
  });
});

describe("layout checks: corpus", () => {
  it("adds no findings to the clean deck through the runner", async () => {
    const bytes = await corpusDeck("clean");
    const base = await runChecks(bytes, {}, { checks: [...CHECKS] });
    const withLayout = await runChecks(bytes, {}, { checks: CHECKS });
    expect(withLayout.errors).toEqual([]);
    expect(withLayout.findings.filter((f) => f.kind === "partly-off-slide" || f.kind === "text-collision")).toEqual([]);
    expect(withLayout.stats.perArea.review.warning).toBe(base.stats.perArea.review.warning);
  });

  it("ignores collisions with fully off-slide shapes in the review-leaks deck", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    expect(ofKind(fs, "text-collision")).toEqual([]);
    expect(ofKind(fs, "partly-off-slide").map((f) => f.data.shapeName)).toEqual(["Partly off"]);
  });

  it("produces deterministic ids", async () => {
    const a = await run(await collisionDeck());
    const b = await run(await collisionDeck());
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
  });
});
