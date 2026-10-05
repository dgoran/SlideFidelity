import { describe, expect, it } from "vitest";
import {
  getShapes,
  loadPresentation,
  PackageError,
  shapeContainers,
  walkAllShapes,
  type Presentation,
} from "../src/index";
import { buildDeck, buildMinimalDocx, sp, grpSp, graphicFrame, layoutPart, masterPart, slidePart } from "./helpers/buildDeck";
import { corpusDeck, CORPUS_NAMES, nestedGroupShapes, SEEDS, MEDIA_BLOAT_BIG_BYTES, REVIEW_AUTHOR_GUID } from "./helpers/corpus";
import { mutateDeck } from "./helpers/mutateDeck";

async function load(name: (typeof CORPUS_NAMES)[number]): Promise<Presentation> {
  return loadPresentation(await corpusDeck(name));
}

async function rejection(p: Promise<unknown>): Promise<PackageError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PackageError) return e;
    throw new Error(`expected PackageError, got ${String(e)}`);
  }
  throw new Error("expected rejection");
}

describe("U3 package model — happy paths", () => {
  it("clean deck yields slide count, one master, 12 theme colors and 2 theme fonts", async () => {
    const pres = await load("clean");
    expect(pres.slides).toHaveLength(SEEDS.clean.slideCount);
    expect(pres.masters).toHaveLength(1);
    expect(pres.layouts).toHaveLength(SEEDS.clean.layoutCount);
    expect(pres.theme?.colors).toHaveLength(12);
    expect(pres.theme?.colors.map((c) => c.slot)).toEqual([
      "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink",
    ]);
    expect(pres.theme?.colors.find((c) => c.slot === "dk1")).toEqual({ slot: "dk1", kind: "sys", hex: "000000", sysName: "windowText" });
    expect(pres.theme?.colors.find((c) => c.slot === "accent1")?.hex).toBe("4472C4");
    expect(pres.theme?.majorFont.latin).toBe("Calibri Light");
    expect(pres.theme?.minorFont.latin).toBe("Calibri");
    expect(pres.theme?.minorFont.scripts.Jpan).toBe("游ゴシック");
    expect(pres.slideSize).toEqual({ cx: 12192000, cy: 6858000 });
    expect(pres.mainContentType).toContain("presentationml.presentation.main+xml");
  });

  it("clean deck: slide order, ids, layout and master links, no hidden slides", async () => {
    const pres = await load("clean");
    expect(pres.slides.map((s) => [s.number, s.slideId, s.partName, s.hidden])).toEqual([
      [1, 256, slidePart(1), false],
      [2, 257, slidePart(2), false],
      [3, 258, slidePart(3), false],
    ]);
    expect(pres.slides.map((s) => s.layoutPart)).toEqual([layoutPart(1), layoutPart(2), layoutPart(3)]);
    expect(pres.slides.every((s) => s.masterPart === masterPart(1))).toBe(true);
    expect(pres.masters[0]?.layoutParts).toEqual([layoutPart(1), layoutPart(2), layoutPart(3)]);
    expect(pres.masters[0]?.preserve).toBe(false);
    expect(pres.masters[0]?.themePart).toBe("ppt/theme/theme1.xml");
    expect(pres.sections).toEqual([]);
    expect(pres.recentColors).toEqual([]);
    expect(pres.embeddedFonts).toEqual([]);
    expect(pres.comments).toEqual([]);
    expect(pres.externalRelationships).toEqual([]);
    expect(pres.properties.core["dc:creator"]).toBe("");
    expect(pres.properties.app.Application).toBe("Microsoft Office PowerPoint");
    expect(pres.properties.app.HeadingPairs).toBeUndefined();
    expect(pres.properties.custom).toEqual([]);
  });

  it("masters-messy yields per-layout usage lists that match the known slide assignments", async () => {
    const pres = await load("masters-messy");
    const usage = Object.fromEntries(pres.layouts.map((l) => [l.partName, [...l.slideIds]]));
    expect(usage).toEqual(SEEDS["masters-messy"].usage);
    expect(pres.masters.map((m) => [m.partName, m.preserve, m.slideParts.length])).toEqual([
      [masterPart(1), false, 3],
      [masterPart(2), true, 0],
      [masterPart(3), false, 2],
    ]);
    expect(pres.layouts.filter((l) => l.slideParts.length === 0).map((l) => l.partName)).toEqual(
      SEEDS["masters-messy"].unusedLayouts,
    );
    expect(pres.layouts.filter((l) => l.name === "Title and Content").map((l) => l.masterPart)).toEqual([
      masterPart(1),
      masterPart(3),
    ]);
    expect(pres.layouts.find((l) => l.partName === layoutPart(8))?.type).toBe("secHead");
    expect(pres.themes.map((t) => t.name)).toEqual(["Office Theme 1", "Legacy Theme", "Imported Theme"]);
    expect(pres.theme?.name).toBe("Office Theme 1");
  });

  it("review-leaks: hidden slide, sections incl. empty one, notes, legacy + threaded comments, properties", async () => {
    const pres = await load("review-leaks");
    expect(pres.slides.filter((s) => s.hidden).map((s) => s.slideId)).toEqual([257]);
    expect(pres.sections.map((s) => [s.name, s.slideIds])).toEqual([
      ["Intro", [256, 257]],
      ["Empty", []],
      ["Main", [258, 259, 260]],
    ]);
    expect(pres.slides[3]?.sectionId).toBe(pres.sections[2]?.id);
    expect(pres.notes).toEqual([{ partName: "ppt/notesSlides/notesSlide1.xml", slidePart: slidePart(1), text: "Remember to mention pricing" }]);
    expect(pres.slides[0]?.notesPart).toBe("ppt/notesSlides/notesSlide1.xml");

    const legacy = pres.comments.filter((c) => c.kind === "legacy");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ slidePart: slidePart(5), authorName: "Alice Example", text: "Check this number" });
    const modern = pres.comments.filter((c) => c.kind === "modern");
    expect(modern.map((c) => [c.text, c.authorName, c.parentId])).toEqual([
      ["Is the client OK with this?", "Bob Example", undefined],
      ["Yes, confirmed", "Bob Example", "{C0000000-0000-4000-8000-000000000001}"],
    ]);
    expect(modern[0]?.authorId).toBe(REVIEW_AUTHOR_GUID);
    expect(pres.slides[4]?.commentParts).toHaveLength(2);

    expect(pres.properties.core["dc:creator"]).toBe("Alice Example");
    expect(pres.properties.core["cp:lastModifiedBy"]).toBe("Bob Example");
    expect(pres.properties.app.Company).toBe("Contoso Ltd");
    expect(pres.properties.custom).toEqual([{ name: "Client", valueType: "lpwstr", value: "Contoso" }]);
  });

  it("colors-literal: recent colors from p:clrMru", async () => {
    const pres = await load("colors-literal");
    expect(pres.recentColors.map((c) => c.hex)).toEqual(["FF0000", "7030A0", "123456"]);
    expect(pres.recentColors.every((c) => c.kind === "srgb")).toBe(true);
    expect(pres.masters).toHaveLength(2);
    expect(pres.slides[2]?.masterPart).toBe(masterPart(2));
  });

  it("fonts-hidden: embedded font list, subset flag, chart and diagram parts on the slide", async () => {
    const pres = await load("fonts-hidden");
    expect(pres.saveSubsetFonts).toBe(true);
    expect(pres.embedTrueTypeFonts).toBe(true);
    expect(pres.embeddedFonts).toHaveLength(1);
    expect(pres.embeddedFonts[0]?.typeface).toBe("Calibri");
    expect(pres.embeddedFonts[0]?.styles.map((s) => [s.style, s.partName, s.size])).toEqual([
      ["regular", "ppt/fonts/font1.fntdata", 2048],
      ["bold", "ppt/fonts/font2.fntdata", 2048],
    ]);
    expect(pres.slides[1]?.chartParts).toEqual(["ppt/charts/chart1.xml"]);
    expect(pres.slides[1]?.diagramParts).toEqual([
      "ppt/diagrams/data1.xml",
      "ppt/diagrams/layout1.xml",
      "ppt/diagrams/quickStyle1.xml",
      "ppt/diagrams/colors1.xml",
      "ppt/diagrams/drawing1.xml",
    ]);
    const chart = await pres.pkg.xml("ppt/charts/chart1.xml");
    expect(chart?.name).toBe("c:chartSpace");
  });

  it("media-bloat: media parts with uncompressed sizes, kinds, and every use", async () => {
    const pres = await load("media-bloat");
    const byName = new Map(pres.media.map((m) => [m.partName, m]));
    const big = byName.get("ppt/media/image1.jpeg");
    expect(big?.size).toBe(MEDIA_BLOAT_BIG_BYTES);
    expect(big?.kind).toBe("image");
    expect(big?.contentType).toBe("image/jpeg");
    const shared = byName.get("ppt/media/image2.png");
    expect(shared?.usedBy.map((u) => u.sourcePart)).toEqual([2, 3, 4, 5, 6].map(slidePart));
    expect(byName.get("ppt/media/media1.mp4")?.kind).toBe("video");
    expect(byName.get("ppt/media/media1.mp4")?.usedBy.map((u) => u.relType).sort()).toEqual(["media", "video"]);
    expect(byName.get("ppt/media/image7.xyz")).toMatchObject({ kind: "image", size: 3000, contentType: "application/octet-stream" });
    expect(pres.slides[1]?.mediaParts).toEqual(["ppt/media/image2.png", "ppt/media/image3.png", "ppt/media/image4.jpeg"]);
    expect(pres.slides[5]?.mediaParts).toEqual(["ppt/media/image2.png", "ppt/media/image9.png", "ppt/media/media1.mp4"]);
    expect(pres.totalUncompressedSize).toBeGreaterThan(MEDIA_BLOAT_BIG_BYTES);
  });

  it("links: external relationships are modeled on slides and layouts", async () => {
    const pres = await load("links");
    const ext = pres.externalRelationships.map((r) => [r.sourcePart, r.shortType, r.target]);
    expect(ext).toEqual(
      expect.arrayContaining([
        [slidePart(1), "hyperlink", "https://example.com/a"],
        [slidePart(1), "hyperlink", "https://example.org/b"],
        [slidePart(2), "hyperlink", "https://example.net/c"],
        [slidePart(2), "oleObject", "file:///C:\\Users\\alice\\Documents\\budget.xlsx"],
        [layoutPart(2), "hyperlink", "https://intranet.example.com/brand"],
      ]),
    );
    expect(ext).toHaveLength(5);
    const jump = pres.slides[1]?.relationships.find((r) => r.id === "rIdJump");
    expect(jump).toMatchObject({ targetMode: "Internal", shortType: "slide", targetPart: slidePart(1) });
  });

  it("every corpus deck loads", async () => {
    for (const name of CORPUS_NAMES) {
      const pres = await load(name);
      expect(pres.slides.length, name).toBeGreaterThan(0);
      expect(pres.theme, name).toBeDefined();
    }
  });
});

describe("U3 package model — external relationships", () => {
  it("TargetMode=External is modeled as external and never resolved as a part", async () => {
    const pres = await load("links");
    const ole = pres.externalRelationships.find((r) => r.shortType === "oleObject");
    expect(ole?.targetMode).toBe("External");
    expect(ole?.targetPart).toBeUndefined();
    // The link target is not a part and never appears in the media list.
    expect(pres.media).toEqual([]);
    const slide = pres.slides[0];
    expect(slide?.relationships.filter((r) => r.targetMode === "External").every((r) => r.targetPart === undefined)).toBe(true);
  });

  it("an external image link (r:link) whose target looks like a part is not resolved", async () => {
    const bytes = await buildDeck({
      slides: [{ rels: [{ id: "rIdExt", type: "image", target: "../media/image1.png", external: true }] }],
    });
    const pres = await loadPresentation(bytes);
    expect(pres.media).toEqual([]);
    expect(pres.externalRelationships).toHaveLength(1);
    expect(pres.externalRelationships[0]?.targetPart).toBeUndefined();
  });
});

describe("U3 package model — shape walker", () => {
  it("a group inside a group inside a graphic frame is walked with the nested path", async () => {
    const bytes = await buildDeck({ slides: [{ layout: "Blank", shapes: nestedGroupShapes() }] });
    const pres = await loadPresentation(bytes);
    const slide = pres.slides[0];
    if (!slide) throw new Error("no slide");
    const shapes = await getShapes(pres, { kind: "slide", partName: slide.partName, slideId: slide.slideId });
    expect(shapes.map((s) => [s.shapeId, s.kind, s.path])).toEqual([
      [10, "graphicFrame", []],
      [11, "grpSp", [10]],
      [12, "grpSp", [10, 11]],
      [13, "sp", [10, 11, 12]],
    ]);
    const deep = shapes[3];
    expect(deep?.name).toBe("Deep Shape");
    expect(deep?.container).toEqual({ kind: "slide", partName: slidePart(1), slideId: 256 });
    expect(deep?.node.name).toBe("p:sp");
    expect(deep?.xfrm).toEqual({ off: { x: 0, y: 0 }, ext: { cx: 457200, cy: 457200 } });
    // Frame at (1in,1in); groups at identity scale → deep shape sits at the frame origin.
    expect(deep?.bounds).toEqual({ x: 914400, y: 914400, cx: 457200, cy: 457200 });
    expect(shapes[0]?.graphicDataUri).toBe("urn:slidefidelity:test-container");
  });

  it("applies group child-space scaling to bounds and propagates hidden groups", async () => {
    const shapes = grpSp({
      id: 2,
      name: "Scaled",
      hidden: true,
      x: 1000,
      y: 2000,
      cx: 200,
      cy: 200,
      chX: 0,
      chY: 0,
      chCx: 100,
      chCy: 100,
      children: [sp({ id: 3, name: "Child", x: 50, y: 50, cx: 10, cy: 20 })],
    });
    const pres = await loadPresentation(await buildDeck({ slides: [{ layout: "Blank", shapes }] }));
    const all = await walkAllShapes(pres);
    const childShape = all.find((s) => s.shapeId === 3 && s.container.kind === "slide");
    expect(childShape?.bounds).toEqual({ x: 1100, y: 2100, cx: 20, cy: 40 });
    expect(childShape?.hidden).toBe(false);
    expect(childShape?.effectivelyHidden).toBe(true);
  });

  it("review-leaks: hidden flag, placeholders, xfrm, pictures in z-order", async () => {
    const pres = await load("review-leaks");
    const s3 = pres.slides[2];
    const s4 = pres.slides[3];
    if (!s3 || !s4) throw new Error("missing slides");
    const shapes3 = await getShapes(pres, { kind: "slide", partName: s3.partName, slideId: s3.slideId });
    expect(shapes3.map((s) => [s.shapeId, s.hidden, s.order])).toEqual([
      [2, true, 0],
      [3, false, 1],
      [4, false, 2],
    ]);
    expect(shapes3[1]?.bounds?.x).toBe(14 * 914400);
    const shapes4 = await getShapes(pres, { kind: "slide", partName: s4.partName, slideId: s4.slideId });
    expect(shapes4.map((s) => [s.kind, s.placeholder])).toEqual([
      ["sp", { type: "title" }],
      ["sp", { type: "obj", idx: 1 }],
      ["pic", { type: "pic", idx: 2 }],
    ]);
    expect(shapes4[0]?.xfrm).toBeUndefined();
    expect(shapes4[0]?.bounds).toBeUndefined();
  });

  it("walks layouts and masters too, with their own container kinds", async () => {
    const pres = await load("clean");
    const containers = shapeContainers(pres);
    expect(containers.map((c) => c.kind)).toEqual(["slide", "slide", "slide", "layout", "layout", "layout", "master"]);
    const all = await walkAllShapes(pres);
    const master = all.filter((s) => s.container.kind === "master");
    expect(master.map((s) => s.placeholder?.type)).toEqual(["title", "body"]);
    expect(master[0]?.container).toEqual({ kind: "master", partName: masterPart(1) });
    expect(master[0]?.container.slideId).toBeUndefined();
    // Shape trees are cached: the same array is returned on the second call.
    const c0 = containers[0];
    if (!c0) throw new Error("no container");
    expect(await getShapes(pres, c0)).toBe(await getShapes(pres, c0));
  });

  it("walks mc:AlternateContent once (Choice branch), not both branches", async () => {
    const choice = sp({ id: 5, name: "Choice", x: 0, y: 0, cx: 1, cy: 1 });
    const fallback = sp({ id: 5, name: "Fallback", x: 0, y: 0, cx: 1, cy: 1 });
    const ac = `<mc:AlternateContent><mc:Choice Requires="p14">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
    const pres = await loadPresentation(await buildDeck({ slides: [{ layout: "Blank", shapes: ac }] }));
    const s = pres.slides[0];
    if (!s) throw new Error("no slide");
    const shapes = await getShapes(pres, { kind: "slide", partName: s.partName, slideId: s.slideId });
    expect(shapes.map((x) => x.name)).toEqual(["Choice"]);
  });

  it("a graphic frame without nested shapes yields just the frame", async () => {
    const frame = graphicFrame({ id: 7, name: "Table 1", uri: "http://schemas.openxmlformats.org/drawingml/2006/table", data: "<a:tbl/>" });
    const pres = await loadPresentation(await buildDeck({ slides: [{ layout: "Blank", shapes: frame }] }));
    const all = await walkAllShapes(pres);
    expect(all.filter((s) => s.container.kind === "slide").map((s) => [s.shapeId, s.kind, s.path])).toEqual([[7, "graphicFrame", []]]);
  });
});

describe("U3 package model — edge cases", () => {
  it("a deck with no presProps.xml loads with empty recent colors", async () => {
    const bytes = await mutateDeck(await corpusDeck("colors-literal"), (m) => m.removePart("ppt/presProps.xml"));
    const pres = await loadPresentation(bytes);
    expect(pres.pkg.has("ppt/presProps.xml")).toBe(false);
    expect(pres.recentColors).toEqual([]);
    expect(pres.slides).toHaveLength(3);
  });

  it("presProps without clrMru yields empty recent colors", async () => {
    const pres = await loadPresentation(await buildDeck({ presProps: {} }));
    expect(pres.recentColors).toEqual([]);
  });

  it("missing docProps parts load with empty properties", async () => {
    const bytes = await mutateDeck(await corpusDeck("review-leaks"), async (m) => {
      await m.removePart("docProps/core.xml");
      await m.removePart("docProps/app.xml");
      await m.removePart("docProps/custom.xml");
    });
    const pres = await loadPresentation(bytes);
    expect(pres.properties).toEqual({ core: {}, app: {}, custom: [] });
  });

  it("a deck with no sections yields no sections and no section ids", async () => {
    const pres = await load("clean");
    expect(pres.sections).toEqual([]);
    expect(pres.slides.every((s) => s.sectionId === undefined)).toBe(true);
  });

  it("part names match case-insensitively (OPC) and resolve to the stored spelling", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) =>
      m.editXml("ppt/_rels/presentation.xml.rels", (x) => x.replace('Target="slides/slide2.xml"', 'Target="Slides/SLIDE2.xml"')),
    );
    const pres = await loadPresentation(bytes);
    expect(pres.slides[1]?.partName).toBe(slidePart(2));
  });

  it("a %-encoded and ../-relative target resolves", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) =>
      m.editXml("ppt/slides/_rels/slide1.xml.rels", (x) =>
        x.replace('Target="../slideLayouts/slideLayout1.xml"', 'Target="../slides/../slideLayouts/slide%4Cayout1.xml"'),
      ),
    );
    const pres = await loadPresentation(bytes);
    expect(pres.slides[0]?.layoutPart).toBe(layoutPart(1));
  });

  it("a layout listed in rels but missing from sldLayoutIdLst still belongs to its master", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) =>
      m.editXml(masterPart(1), (x) => x.replace(/<p:sldLayoutId id="\d+" r:id="rId3"\/>/, "")),
    );
    const pres = await loadPresentation(bytes);
    expect(pres.masters[0]?.layoutParts).toEqual([layoutPart(1), layoutPart(2), layoutPart(3)]);
  });

  it("modern comments whose rel is missing are still found as orphan comment parts", async () => {
    const bytes = await mutateDeck(await corpusDeck("review-leaks"), (m) =>
      m.editXml("ppt/slides/_rels/slide5.xml.rels", (x) => x.replace(/<Relationship Id="rIdModCmt"[^>]*\/>/, "")),
    );
    const pres = await loadPresentation(bytes);
    const modern = pres.comments.filter((c) => c.kind === "modern");
    expect(modern).toHaveLength(2);
    expect(modern[0]?.slidePart).toBeUndefined();
  });

  it("an orphan media part (no relationship) is listed with no uses", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) => m.writeBytes("ppt/media/orphan.png", new Uint8Array(1234)));
    const pres = await loadPresentation(bytes);
    expect(pres.media).toEqual([
      // clean.pptx declares no png Default, so the content type is unknown; kind falls back to the extension.
      { partName: "ppt/media/orphan.png", contentType: undefined, kind: "image", size: 1234, compressedSize: expect.any(Number), usedBy: [] },
    ]);
  });

  it("text entities and whitespace survive parsing", async () => {
    const pres = await loadPresentation(await buildDeck({ slides: [{ notes: "  a < b & c  " }] }));
    expect(pres.notes[0]?.text).toBe("  a < b & c  ");
  });

  it("a deck with zero slides loads", async () => {
    const pres = await loadPresentation(await buildDeck({ slides: [] }));
    expect(pres.slides).toEqual([]);
    expect(pres.layouts.every((l) => l.slideParts.length === 0)).toBe(true);
  });

  it("the builder is deterministic", async () => {
    const a = await buildDeck({ slides: [{ notes: "x" }, { hidden: true }] });
    const b = await buildDeck({ slides: [{ notes: "x" }, { hidden: true }] });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("U3 package model — errors", () => {
  it("corrupt bytes reject with PackageError not-a-zip", async () => {
    const err = await rejection(loadPresentation(new TextEncoder().encode("this is not a zip file at all")));
    expect(err.code).toBe("not-a-zip");
  });

  it("truncated pptx bytes reject with not-a-zip", async () => {
    const bytes = await corpusDeck("clean");
    const err = await rejection(loadPresentation(bytes.slice(0, Math.floor(bytes.length / 2))));
    expect(err.code).toBe("not-a-zip");
  });

  it("a .docx is rejected with not-a-pptx", async () => {
    const err = await rejection(loadPresentation(await buildMinimalDocx()));
    expect(err.code).toBe("not-a-pptx");
    expect(err.message).toContain("wordprocessingml");
  });

  it("a plain zip without [Content_Types].xml is rejected with not-a-pptx", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const err = await rejection(loadPresentation(await zip.generateAsync({ type: "uint8array" })));
    expect(err.code).toBe("not-a-pptx");
  });

  it("a package whose presentation part is missing is rejected with not-a-pptx", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) => m.remove("ppt/presentation.xml"));
    const err = await rejection(loadPresentation(bytes));
    expect(err.code).toBe("not-a-pptx");
  });

  it("a malformed slide part rejects with malformed-part naming the part", async () => {
    const bytes = await mutateDeck(await corpusDeck("clean"), (m) => m.writeText(slidePart(2), "<p:sld><p:cSld>"));
    const err = await rejection(loadPresentation(bytes));
    expect(err.code).toBe("malformed-part");
    expect(err.partName).toBe(slidePart(2));
  });

  it("accepts an ArrayBuffer as input", async () => {
    const bytes = await corpusDeck("clean");
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const pres = await loadPresentation(ab);
    expect(pres.slides).toHaveLength(3);
  });
});
