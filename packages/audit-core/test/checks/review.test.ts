import { describe, expect, it } from "vitest";
import { reviewChecks } from "../../src/checks/review";
import { loadPresentation, type Finding, type FindingOf } from "../../src/index";
import { layoutPart, slidePart } from "../helpers/buildDeck";
import { corpusDeck, EMU_PER_INCH, REVIEW_AUTHOR_GUID, SEEDS } from "../helpers/corpus";
import { mutateDeck } from "../helpers/mutateDeck";
import { hiddenGroupDeck, inheritedOffSlideDeck, placeholderEdgeDeck, textSettingsDeck } from "./review.fixtures";

const IN = EMU_PER_INCH;

async function run(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of reviewChecks) out.push(...(await c.run({ pres, options: {} })));
  return out;
}

function ofKind<K extends Finding["kind"]>(fs: Finding[], kind: K): FindingOf<K>[] {
  return fs.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

const seeds = SEEDS["review-leaks"];

describe("review checks: review-leaks corpus", () => {
  it("reports the hidden slide", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const hidden = ofKind(fs, "hidden-slide");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.severity).toBe("warning");
    expect(hidden[0]!.targets[0]!.container).toMatchObject({ kind: "slide", slideId: seeds.hiddenSlide.slideId, slideNumber: seeds.hiddenSlide.slide });
    expect(hidden[0]!.data).toMatchObject({ slideId: 257, slideNumber: 2 });
  });

  it("reports the hidden shape with a reachable delete fix and bounds", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const hidden = ofKind(fs, "hidden-shape");
    expect(hidden).toHaveLength(1);
    const f = hidden[0]!;
    expect(f.severity).toBe("warning");
    expect(f.fixes).toEqual(["delete-shapes"]);
    expect(f.reachable).toBe(true);
    const t = f.targets[0]!;
    expect(t).toMatchObject({ shapeId: seeds.hiddenShape.shapeId, shapeName: "Hidden note", reachable: true });
    expect(t.container).toMatchObject({ kind: "slide", slideNumber: seeds.hiddenShape.slide });
    expect(t.bounds).toEqual({ x: IN, y: IN, cx: 2 * IN, cy: IN });
  });

  it("flags the fully off-slide shape but not the partly off-slide one", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const off = ofKind(fs, "off-slide-shape");
    expect(off.map((f) => f.targets[0]!.shapeId)).toEqual([seeds.offSlideShape.shapeId]);
    const f = off[0]!;
    expect(f.fixes).toEqual(["delete-shapes"]);
    expect(f.reachable).toBe(true);
    expect(f.targets[0]!.bounds).toEqual({ x: 14 * IN, y: IN, cx: 2 * IN, cy: IN });
    expect(f.data).toMatchObject({ direction: "right", inherited: false });
  });

  it("reports the 2 empty placeholders but not the picture-only placeholder", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const empty = ofKind(fs, "empty-placeholder");
    expect(empty.map((f) => [f.targets[0]!.container.slideNumber, f.targets[0]!.shapeId])).toEqual(
      seeds.emptyPlaceholders.map((p) => [p.slide, p.shapeId]),
    );
    expect(empty.some((f) => f.targets[0]!.shapeId === seeds.pictureOnlyPlaceholder.shapeId)).toBe(false);
    for (const f of empty) {
      expect(f.fixes).toEqual(["delete-shapes"]);
      expect(f.reachable).toBe(true);
      // Placeholder bounds are resolved from the layout / master.
      expect(f.targets[0]!.bounds).toBeDefined();
    }
    expect(empty[0]!.data).toMatchObject({ placeholderType: "title" });
    expect(empty[1]!.data).toMatchObject({ placeholderType: "obj", placeholderIdx: 1 });
  });

  it("reports the empty section", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const sections = ofKind(fs, "empty-section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.data.name).toBe(seeds.emptySection);
    expect(sections[0]!.severity).toBe("warning");
    expect(sections[0]!.targets[0]!.container.kind).toBe("presentation");
  });

  it("reports speaker notes with their text", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const notes = ofKind(fs, "speaker-notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.severity).toBe("info");
    expect(notes[0]!.data).toMatchObject({ slideNumber: seeds.notes.slide, text: seeds.notes.text });
    expect(notes[0]!.targets[0]!.container).toMatchObject({ kind: "notes", slideNumber: 1 });
  });

  it("reports legacy and modern comments, including the threaded reply, with author and text", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const comments = ofKind(fs, "comment");
    expect(comments).toHaveLength(3);
    const legacy = comments.find((f) => f.data.commentKind === "legacy");
    expect(legacy?.data).toMatchObject({ author: seeds.legacyComment.author, text: seeds.legacyComment.text, isReply: false, slideNumber: 5 });
    const modern = comments.filter((f) => f.data.commentKind === "modern");
    const root = modern.find((f) => !f.data.isReply);
    const reply = modern.find((f) => f.data.isReply);
    expect(root?.data).toMatchObject({ author: seeds.threadedComment.author, text: seeds.threadedComment.text, replyCount: 1 });
    expect(reply?.data).toMatchObject({ author: "Bob Example", text: "Yes, confirmed", parentId: root?.data.commentId });
    expect(reply?.data.authorId).toBe(REVIEW_AUTHOR_GUID);
    for (const f of comments) expect(f.targets[0]!.container).toMatchObject({ kind: "comments", slideNumber: 5 });
    expect(new Set(comments.map((f) => f.id)).size).toBe(3);
  });

  it("reports document properties; the custom 'Client' property is a warning", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const props = ofKind(fs, "document-property");
    const byName = Object.fromEntries(props.map((f) => [`${f.data.source}:${f.data.name}`, f]));
    expect(byName["custom:Client"]?.severity).toBe("warning");
    expect(byName["custom:Client"]?.data.value).toBe(seeds.customProperty.value);
    expect(byName["core:dc:creator"]?.data.value).toBe("Alice Example");
    expect(byName["core:cp:lastModifiedBy"]?.severity).toBe("info");
    expect(byName["app:Company"]?.data.value).toBe("Contoso Ltd");
    expect(byName["app:Manager"]).toBeDefined();
    // Statistics are not reported.
    expect(byName["app:Slides"]).toBeUndefined();
    expect(byName["app:TotalTime"]).toBeUndefined();
    for (const f of props) expect(f.targets[0]!.container.kind).toBe("properties");
    expect(byName["custom:Client"]?.targets[0]!.container.partName).toBe("docProps/custom.xml");
  });

  it("reports the animated slide and the transition", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const anim = ofKind(fs, "animation");
    expect(anim.map((f) => f.data.slideNumber)).toEqual([seeds.animatedSlide]);
    const tr = ofKind(fs, "transition");
    expect(tr).toHaveLength(1);
    expect(tr[0]!.data).toMatchObject({ slideNumber: 1, type: "fade", speed: "med" });
  });

  it("lists en-US and de-DE with shape counts", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const langs = ofKind(fs, "proofing-language");
    const byLang = Object.fromEntries(langs.map((f) => [f.data.lang, f]));
    expect(Object.keys(byLang).sort()).toEqual([...seeds.languages].sort());
    expect(byLang["de-DE"]!.data).toMatchObject({ shapeCount: 1, runCount: 1, slideNumbers: [5] });
    expect(byLang["de-DE"]!.count).toBe(1);
    expect(byLang["de-DE"]!.targets[0]!.shapeId).toBe(2);
    expect(byLang["en-US"]!.data.shapeCount).toBeGreaterThanOrEqual(4);
  });

  it("counts the seeded normAutofit shape as shrink", async () => {
    const fs = await run(await corpusDeck("review-leaks"));
    const shrink = ofKind(fs, "autofit").find((f) => f.data.mode === "shrink");
    expect(shrink?.targets.some((t) => t.container.slideNumber === seeds.autofit.slide && t.shapeId === seeds.autofit.shapeId)).toBe(true);
  });

  it("produces deterministic unique ids and structured-clone-safe findings", async () => {
    const bytes = await corpusDeck("review-leaks");
    const a = await run(bytes);
    const b = await run(bytes);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    expect(structuredClone(a)).toEqual(a);
    expect(a.every((f) => f.area === "review" && f.severity !== "error")).toBe(true);
  });
});

describe("review checks: edge cases", () => {
  it("clean deck: no sections → no section findings and no error; nothing to warn about", async () => {
    const fs = await run(await corpusDeck("clean"));
    expect(ofKind(fs, "empty-section")).toEqual([]);
    expect(ofKind(fs, "hidden-slide")).toEqual([]);
    expect(ofKind(fs, "hidden-shape")).toEqual([]);
    expect(ofKind(fs, "off-slide-shape")).toEqual([]);
    expect(ofKind(fs, "empty-placeholder")).toEqual([]);
    expect(ofKind(fs, "comment")).toEqual([]);
    expect(ofKind(fs, "speaker-notes")).toEqual([]);
  });

  it("a placeholder inheriting an off-slide position from its layout or master is flagged", async () => {
    const fs = await run(await inheritedOffSlideDeck());
    const off = ofKind(fs, "off-slide-shape").filter((f) => f.targets[0]!.container.kind === "slide");
    expect(off.map((f) => f.targets[0]!.shapeId).sort()).toEqual([2, 3]);
    const title = off.find((f) => f.targets[0]!.shapeId === 2)!;
    expect(title.data).toMatchObject({ inherited: true, inheritedFrom: "master", direction: "left" });
    expect(title.targets[0]!.bounds).toEqual({ x: -5 * IN, y: IN, cx: 3 * IN, cy: IN });
    expect(title.reachable).toBe(true);
    const parked = off.find((f) => f.targets[0]!.shapeId === 3)!;
    expect(parked.data).toMatchObject({ inherited: true, inheritedFrom: "layout" });
    expect(parked.targets[0]!.bounds).toEqual({ x: 14 * IN, y: IN, cx: 2 * IN, cy: IN });
    // Layout / master copies are reported too, but not reachable.
    const templ = ofKind(fs, "off-slide-shape").filter((f) => f.targets[0]!.container.kind !== "slide");
    expect(templ.length).toBeGreaterThanOrEqual(2);
    for (const f of templ) {
      expect(f.reachable).toBe(false);
      expect(f.targets[0]!.reachable).toBe(false);
    }
  });

  it("hidden group child: reports the hidden child (with path) and the hidden group, not the group's children", async () => {
    const fs = await run(await hiddenGroupDeck());
    const hidden = ofKind(fs, "hidden-shape");
    const onSlide = hidden.filter((f) => f.targets[0]!.container.kind === "slide");
    expect(onSlide.map((f) => f.targets[0]!.shapeId)).toEqual([3, 10]);
    expect(onSlide[0]!.targets[0]!.path).toEqual([2]);
    expect(onSlide[0]!.targets[0]!.bounds).toEqual({ x: IN, y: IN, cx: IN, cy: IN });
    expect(onSlide.every((f) => f.reachable === true)).toBe(true);
    const onLayout = hidden.filter((f) => f.targets[0]!.container.kind === "layout");
    expect(onLayout).toHaveLength(1);
    expect(onLayout[0]!.targets[0]!.container).toMatchObject({ partName: layoutPart(1), name: "Title Slide" });
    expect(onLayout[0]!.reachable).toBe(false);
    expect(onLayout[0]!.fixes).toEqual(["delete-shapes"]);
  });

  it("an off-slide group is reported once, not per child", async () => {
    const fs = await run(await hiddenGroupDeck());
    const off = ofKind(fs, "off-slide-shape");
    expect(off.map((f) => f.targets[0]!.shapeId)).toEqual([20]);
  });

  it("placeholder emptiness: whitespace is empty; fields and picture fills are content", async () => {
    const fs = await run(await placeholderEdgeDeck());
    const empty = ofKind(fs, "empty-placeholder");
    expect(empty.map((f) => f.targets[0]!.shapeId)).toEqual([2]);
  });

  it("modern threaded comment reply without a known author still reports", async () => {
    const bytes = await mutateDeck(await corpusDeck("review-leaks"), async (m) => {
      const path = m.paths().find((p) => /^ppt\/comments\/modernComment_/.test(p))!;
      await m.editXml(path, (x) => x.replace(/(<p188:reply id="[^"]+" authorId=")[^"]+"/, `$1{UNKNOWN}"`));
    });
    const fs = await run(bytes);
    const reply = ofKind(fs, "comment").find((f) => f.data.isReply);
    expect(reply?.data.author).toBeUndefined();
    expect(reply?.data.text).toBe("Yes, confirmed");
  });

  it("autofit modes: explicit, inherited from layout, and default none", async () => {
    const fs = await run(await textSettingsDeck());
    const af = Object.fromEntries(ofKind(fs, "autofit").map((f) => [f.data.mode, f]));
    expect(af.resize?.targets.map((t) => t.shapeId)).toEqual([2]);
    expect(af.shrink?.targets.map((t) => t.shapeId)).toEqual([4]);
    expect(af.shrink?.targets[0]!.locator).toEqual({ property: "text" });
    expect(af.none?.targets.map((t) => t.shapeId)).toEqual([3, 5]);
    expect(af.none?.count).toBe(2);
    expect(af.none?.data).toMatchObject({ shapeCount: 2, slideCount: 1 });
  });

  it("languages: altLang is listed and counted separately", async () => {
    const fs = await run(await textSettingsDeck());
    const byLang = Object.fromEntries(ofKind(fs, "proofing-language").map((f) => [f.data.lang, f.data]));
    expect(byLang["fr-FR"]).toMatchObject({ shapeCount: 1, runCount: 2, altLangRunCount: 0 });
    expect(byLang["ja-JP"]).toMatchObject({ shapeCount: 1, runCount: 0, altLangRunCount: 1 });
    expect(byLang["en-GB"]).toMatchObject({ shapeCount: 1 });
  });

  it("transitions inside mc:AlternateContent and bare transitions; animations with effects", async () => {
    const fs = await run(await textSettingsDeck());
    const tr = ofKind(fs, "transition");
    expect(tr.map((f) => [f.data.slideNumber, f.data.type])).toEqual([
      [1, "vortex"],
      [2, undefined],
    ]);
    expect(tr[0]!.data).toMatchObject({ speed: "slow", advanceAfterMs: 3000 });
    const anim = ofKind(fs, "animation");
    expect(anim).toHaveLength(1);
    expect(anim[0]!.data).toMatchObject({ slideNumber: 1, effectCount: 1 });
    expect(anim[0]!.targets[0]!.container.partName).toBe(slidePart(1));
  });
});
