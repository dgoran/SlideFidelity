/**
 * The named fixture corpus (KTD10), generated in memory by `buildDeck`.
 *
 * Each deck seeds known problems and documents them in `SEEDS` so later units
 * (U5 fonts, U6 colors, U7 media, U8 masters/review, U9 links) can assert
 * against the same facts. Decks are memoised per test process.
 *
 * Deviations: decks are generated rather than saved from PowerPoint, and
 * `media-bloat` carries ~5 MB of media (not ~50 MB); the 50 MB memory/time
 * budget check is deferred to integration.
 */
import {
  buildDeck,
  DEFAULT_LAYOUTS,
  graphicFrame,
  GRAPHIC_URI,
  grpSp,
  NS,
  para,
  pic,
  run,
  sp,
  type DeckSpec,
} from "./buildDeck";
import { jpegBytes, noiseBytes, pngBytes, svgBytes } from "./media";

export const CORPUS_NAMES = [
  "clean",
  "fonts-hidden",
  "colors-literal",
  "media-bloat",
  "masters-messy",
  "links",
  "review-leaks",
] as const;
export type CorpusName = (typeof CORPUS_NAMES)[number];

/** EMU per inch. */
export const EMU_PER_INCH = 914400;
const IN = EMU_PER_INCH;

const title = (id: number, text: string, type = "title"): string =>
  sp({ id, name: `Title ${id - 1}`, ph: { type }, noXfrm: true, text });
const body = (id: number, text: string, idx = 1): string =>
  sp({ id, name: `Content Placeholder ${id - 1}`, ph: { idx }, noXfrm: true, text });

// ---------------------------------------------------------------------------
// clean: 3 slides, 1 master, 3 layouts all used, theme fonts and colors only.

function cleanSpec(): DeckSpec {
  return {
    slides: [
      { layout: "Title Slide", shapes: title(2, "Welcome", "ctrTitle") + sp({ id: 3, name: "Subtitle 2", ph: { type: "subTitle", idx: 1 }, noXfrm: true, text: "A clean deck" }) },
      { layout: "Title and Content", shapes: title(2, "Agenda") + body(3, "First point\nSecond point") },
      {
        layout: "Blank",
        shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: 4 * IN, cy: IN, text: "Theme colored", spPr: `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>` }),
      },
    ],
    presProps: {},
  };
}

// ---------------------------------------------------------------------------
// fonts-hidden: AE1 plus fonts PowerPoint's Replace Fonts dialog never shows.

const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart>` +
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:latin typeface="Arial Narrow"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;

const DGM_CT = "application/vnd.openxmlformats-officedocument.drawingml.";

function fontsHiddenSpec(): DeckSpec {
  const ae1 = sp({
    id: 4,
    name: "TextBox 3",
    x: IN,
    y: 2 * IN,
    cx: 6 * IN,
    cy: IN,
    lstStyle: `<a:lvl1pPr marL="285750" indent="-285750"><a:buFont typeface="Wingdings" pitchFamily="2" charset="2"/><a:buChar char="&#167;"/></a:lvl1pPr>`,
    paragraphs: para(run("Mixed script text", { inner: `<a:latin typeface="Calibri"/><a:ea typeface="MS Gothic"/>` })),
  });
  const themeRef = sp({
    id: 5,
    name: "TextBox 4",
    x: IN,
    y: 3.5 * IN,
    cx: 6 * IN,
    cy: IN,
    paragraphs: para(run("Theme minor", { inner: `<a:latin typeface="+mn-lt"/>` })),
  });
  const emptyWithLstStyle = sp({
    id: 6,
    name: "Rectangle 5",
    x: IN,
    y: 5 * IN,
    cx: 2 * IN,
    cy: IN,
    lstStyle: `<a:lvl1pPr><a:defRPr><a:latin typeface="Consolas"/></a:defRPr></a:lvl1pPr>`,
  });
  const chart = graphicFrame({
    id: 2,
    name: "Chart 1",
    x: IN,
    y: IN,
    cx: 6 * IN,
    cy: 4 * IN,
    uri: GRAPHIC_URI.chart,
    data: `<c:chart xmlns:c="${NS.c}" r:id="rIdChart"/>`,
  });
  const smartArt = graphicFrame({
    id: 3,
    name: "Diagram 2",
    x: 7 * IN,
    y: IN,
    cx: 4 * IN,
    cy: 4 * IN,
    uri: GRAPHIC_URI.diagram,
    data: `<dgm:relIds xmlns:dgm="${NS.dgm}" r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>`,
  });
  return {
    saveSubsetFonts: true,
    embeddedFonts: [{ typeface: "Calibri", styles: ["regular", "bold"] }],
    masters: [
      {
        layouts: DEFAULT_LAYOUTS,
        txStyles:
          `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
          `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2400"><a:latin typeface="Georgia"/></a:defRPr></a:lvl2pPr></p:bodyStyle>` +
          `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>`,
      },
    ],
    slides: [
      { layout: "Blank", shapes: ae1 + themeRef + emptyWithLstStyle },
      {
        layout: "Blank",
        shapes: chart + smartArt,
        rels: [
          { id: "rIdChart", type: "chart", target: "../charts/chart1.xml" },
          { id: "rIdDm", type: "diagramData", target: "../diagrams/data1.xml" },
          { id: "rIdLo", type: "diagramLayout", target: "../diagrams/layout1.xml" },
          { id: "rIdQs", type: "diagramQuickStyle", target: "../diagrams/quickStyle1.xml" },
          { id: "rIdCs", type: "diagramColors", target: "../diagrams/colors1.xml" },
          { id: "rIdDd", type: "diagramDrawing", target: "../diagrams/drawing1.xml" },
        ],
      },
    ],
    parts: [
      { path: "ppt/charts/chart1.xml", content: CHART_XML, contentType: `${DGM_CT}chart+xml` },
      {
        path: "ppt/diagrams/data1.xml",
        contentType: `${DGM_CT}diagramData+xml`,
        content: `<dgm:dataModel xmlns:dgm="${NS.dgm}" xmlns:a="${NS.a}"><dgm:ptLst><dgm:pt modelId="{1}" type="doc"><dgm:t><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"><a:latin typeface="Segoe UI"/></a:rPr><a:t>Step</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
      },
      { path: "ppt/diagrams/layout1.xml", contentType: `${DGM_CT}diagramLayout+xml`, content: `<dgm:layoutDef xmlns:dgm="${NS.dgm}"/>` },
      { path: "ppt/diagrams/quickStyle1.xml", contentType: `${DGM_CT}diagramStyle+xml`, content: `<dgm:styleDef xmlns:dgm="${NS.dgm}"/>` },
      { path: "ppt/diagrams/colors1.xml", contentType: `${DGM_CT}diagramColors+xml`, content: `<dgm:colorsDef xmlns:dgm="${NS.dgm}"/>` },
      {
        path: "ppt/diagrams/drawing1.xml",
        contentType: "application/vnd.ms-office.drawingml.diagramDrawing+xml",
        content: `<dsp:drawing xmlns:dsp="${NS.dsp}" xmlns:a="${NS.a}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/><dsp:sp modelId="{2}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr/><dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"><a:latin typeface="Segoe UI"/></a:rPr><a:t>Step</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// colors-literal: literal colors across two masters, recent colors.

function colorsLiteralSpec(): DeckSpec {
  const fill = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
  return {
    masters: [{ layouts: DEFAULT_LAYOUTS }, { layouts: [{ name: "Blank", type: "blank" }], theme: { name: "Second Theme" } }],
    presProps: { recentColors: ["FF0000", "7030A0", "123456"] },
    slides: [
      {
        layout: { master: 0, layout: 2 },
        shapes:
          sp({ id: 2, name: "Accent literal", x: IN, y: IN, cx: IN, cy: IN, spPr: fill("4472C4") }) +
          sp({ id: 3, name: "Red text", x: 3 * IN, y: IN, cx: 3 * IN, cy: IN, paragraphs: para(run("Alert", { inner: fill("FF0000") })) }) +
          sp({ id: 4, name: "Red line", x: 7 * IN, y: IN, cx: IN, cy: IN, spPr: `<a:noFill/><a:ln w="12700">${fill("FF0000")}</a:ln>` }),
      },
      {
        layout: { master: 0, layout: 2 },
        shapes:
          sp({
            id: 2,
            name: "Theme tinted",
            x: IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `<a:solidFill><a:schemeClr val="accent2"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr></a:solidFill>`,
          }) +
          sp({
            id: 3,
            name: "Gradient",
            x: 3 * IN,
            y: IN,
            cx: 2 * IN,
            cy: IN,
            spPr: `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="00B050"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>`,
          }),
      },
      {
        layout: { master: 1, layout: 0 },
        shapes: sp({ id: 2, name: "Purple", x: IN, y: IN, cx: IN, cy: IN, spPr: fill("7030A0") }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// media-bloat

export const MEDIA_BLOAT_BIG_BYTES = 5 * 1024 * 1024;

function mediaBloatSpec(): DeckSpec {
  const img = (id: number, name: string, embed: string, x: number, cx: number, cy: number, extra: Partial<Parameters<typeof pic>[0]> = {}): string =>
    pic({ id, name, embed, x, y: IN, cx, cy, ...extra });
  const shared = (n: number): { layout: string; shapes: string; rels: { id: string; type: string; target: string }[] } => ({
    layout: "Blank",
    shapes: img(2, `Shared ${n}`, "rIdShared", IN, 2 * IN, 1.5 * IN),
    rels: [{ id: "rIdShared", type: "image", target: "../media/image2.png" }],
  });
  const s2 = shared(2);
  const s3 = shared(3);
  const s4 = shared(4);
  const s5 = shared(5);
  const s6 = shared(6);
  return {
    media: {
      "image1.jpeg": jpegBytes(4000, 3000, MEDIA_BLOAT_BIG_BYTES, 11),
      "image2.png": pngBytes(800, 600, 20_000, 12),
      "image3.png": pngBytes(1000, 1000, 8_000, 13),
      "image4.jpeg": jpegBytes(1200, 800, 40_000, 14),
      "image5.svg": svgBytes(200, 100),
      "image6.png": pngBytes(400, 200, 4_000, 15),
      "image7.xyz": noiseBytes(3_000, 16),
      "image8.png": pngBytes(100, 100, 500, 17),
      "media1.mp4": noiseBytes(200_000, 18),
      "image9.png": pngBytes(640, 360, 2_000, 19),
    },
    slides: [
      {
        layout: "Blank",
        shapes: img(2, "Oversized photo", "rIdBig", IN, 2 * IN, 1.5 * IN),
        rels: [{ id: "rIdBig", type: "image", target: "../media/image1.jpeg" }],
      },
      {
        ...s2,
        shapes:
          s2.shapes +
          img(3, "Distorted", "rIdDist", 4 * IN, 2 * IN, 1.2 * IN) +
          img(4, "Cropped", "rIdCrop", 7 * IN, 2 * IN, 1.5 * IN, { srcRect: `l="10000" r="5000"` }),
        rels: [
          ...s2.rels,
          { id: "rIdDist", type: "image", target: "../media/image3.png" },
          { id: "rIdCrop", type: "image", target: "../media/image4.jpeg" },
        ],
      },
      {
        ...s3,
        shapes:
          s3.shapes +
          img(3, "Icon SVG", "rIdSvgPng", 4 * IN, 2 * IN, IN, {
            blipInner: `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="${NS.asvg}" r:embed="rIdSvg"/></a:ext></a:extLst>`,
          }),
        rels: [
          ...s3.rels,
          { id: "rIdSvgPng", type: "image", target: "../media/image6.png" },
          { id: "rIdSvg", type: "image", target: "../media/image5.svg" },
        ],
      },
      {
        ...s4,
        shapes: s4.shapes + img(3, "Unknown format", "rIdUnk", 4 * IN, IN, IN),
        rels: [...s4.rels, { id: "rIdUnk", type: "image", target: "../media/image7.xyz" }],
      },
      {
        ...s5,
        shapes: s5.shapes + img(3, "Too small", "rIdSmall", 4 * IN, 5 * IN, 5 * IN),
        rels: [...s5.rels, { id: "rIdSmall", type: "image", target: "../media/image8.png" }],
      },
      {
        ...s6,
        shapes: s6.shapes + img(3, "Video", "rIdPoster", 4 * IN, 4 * IN, 2.25 * IN),
        rels: [
          ...s6.rels,
          { id: "rIdPoster", type: "image", target: "../media/image9.png" },
          { id: "rIdVid", type: "video", target: "../media/media1.mp4" },
          { id: "rIdMedia", type: "media", target: "../media/media1.mp4" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// masters-messy

function mastersMessySpec(): DeckSpec {
  return {
    masters: [
      {
        layouts: [
          { name: "Title Slide", type: "title" },
          { name: "Title and Content", type: "obj" },
          { name: "Two Content", type: "twoObj" },
          { name: "Comparison", type: "twoTxTwoObj" },
        ],
      },
      {
        preserve: true,
        theme: { name: "Legacy Theme" },
        layouts: [
          { name: "Old Title", type: "title" },
          { name: "Old Content", type: "obj" },
        ],
      },
      {
        theme: { name: "Imported Theme" },
        layouts: [
          { name: "Title and Content", type: "obj" },
          { name: "Section Header", type: "secHead" },
        ],
      },
    ],
    slides: [
      { layout: { master: 0, layout: 0 }, shapes: title(2, "One", "ctrTitle") },
      { layout: { master: 0, layout: 1 }, shapes: title(2, "Two") },
      { layout: { master: 0, layout: 1 }, shapes: title(2, "Three") },
      { layout: { master: 2, layout: 0 }, shapes: title(2, "Four (pasted)") },
      { layout: { master: 2, layout: 1 }, shapes: title(2, "Five (pasted)") },
    ],
  };
}

// ---------------------------------------------------------------------------
// links

function linksSpec(): DeckSpec {
  const linkRun = (text: string, rid: string, action = ""): string =>
    run(text, { inner: `<a:hlinkClick r:id="${rid}"${action ? ` action="${action}"` : ""}/>` });
  return {
    masters: [
      {
        layouts: [
          { name: "Title Slide", type: "title" },
          {
            name: "Title and Content",
            type: "obj",
            shapes:
              title(2, "Click to edit Master title style") +
              sp({ id: 4, name: "Brand link", x: IN, y: 6.5 * IN, cx: 3 * IN, cy: 0.5 * IN, paragraphs: para(linkRun("Brand portal", "rIdL1")) }),
            rels: [{ id: "rIdL1", type: "hyperlink", target: "https://intranet.example.com/brand", external: true }],
          },
          { name: "Blank", type: "blank" },
        ],
      },
    ],
    slides: [
      {
        layout: "Title and Content",
        shapes:
          sp({ id: 2, name: "Text links", x: IN, y: IN, cx: 6 * IN, cy: IN, paragraphs: para(linkRun("Site A", "rIdH1")) }) +
          sp({ id: 3, name: "Shape link", x: IN, y: 3 * IN, cx: 2 * IN, cy: IN, cNvPrInner: `<a:hlinkClick r:id="rIdH2"/>` }),
        rels: [
          { id: "rIdH1", type: "hyperlink", target: "https://example.com/a", external: true },
          { id: "rIdH2", type: "hyperlink", target: "https://example.org/b", external: true },
        ],
      },
      {
        layout: "Blank",
        shapes:
          sp({ id: 2, name: "More links", x: IN, y: IN, cx: 6 * IN, cy: IN, paragraphs: para(linkRun("Site C", "rIdH3") + linkRun(" back to start", "rIdJump", "ppaction://hlinksldjump")) }) +
          graphicFrame({
            id: 3,
            name: "Linked Worksheet",
            x: IN,
            y: 3 * IN,
            cx: 4 * IN,
            cy: 2 * IN,
            uri: GRAPHIC_URI.ole,
            data: `<p:oleObj name="Worksheet" r:id="rIdOle" progId="Excel.Sheet.12"><p:link updateAutomatic="1"/></p:oleObj>`,
          }),
        rels: [
          { id: "rIdH3", type: "hyperlink", target: "https://example.net/c", external: true },
          { id: "rIdJump", type: "slide", target: "slide1.xml" },
          { id: "rIdOle", type: "oleObject", target: "file:///C:\\Users\\alice\\Documents\\budget.xlsx", external: true },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// review-leaks

export const REVIEW_AUTHOR_GUID = "{A1B2C3D4-0000-4000-8000-000000000001}";

function reviewLeaksSpec(): DeckSpec {
  const tail =
    `<p:transition spd="med"><p:fade/></p:transition>` +
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>`;
  return {
    core: { "dc:title": "Confidential pitch", "dc:creator": "Alice Example", "cp:lastModifiedBy": "Bob Example" },
    app: { Company: "Contoso Ltd", Manager: "Carol Example" },
    custom: { Client: "Contoso" },
    commentAuthors: [{ id: 0, name: "Alice Example" }],
    authors: [{ id: REVIEW_AUTHOR_GUID, name: "Bob Example" }],
    sections: [
      { name: "Intro", slides: [0, 1] },
      { name: "Empty", slides: [] },
      { name: "Main", slides: [2, 3, 4] },
    ],
    slides: [
      { layout: "Title Slide", shapes: title(2, "Pitch", "ctrTitle"), notes: "Remember to mention pricing", tail },
      { layout: "Title and Content", hidden: true, shapes: title(2, "Backup slide") },
      {
        layout: "Blank",
        shapes:
          sp({ id: 2, name: "Hidden note", hidden: true, x: IN, y: IN, cx: 2 * IN, cy: IN, text: "draft" }) +
          sp({ id: 3, name: "Off slide", x: 14 * IN, y: IN, cx: 2 * IN, cy: IN, text: "parked" }) +
          sp({ id: 4, name: "Partly off", x: 12 * IN, y: IN, cx: 2 * IN, cy: IN, text: "edge" }),
      },
      {
        layout: "Title and Content",
        shapes:
          sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true }) +
          sp({ id: 3, name: "Content Placeholder 2", ph: { idx: 1 }, noXfrm: true }) +
          pic({ id: 4, name: "Picture Placeholder 3", ph: { type: "pic", idx: 2 }, embed: "rIdPic", x: 7 * IN, y: 2 * IN, cx: 3 * IN, cy: 2 * IN }),
        rels: [{ id: "rIdPic", type: "image", target: "../media/image1.png" }],
      },
      {
        layout: "Blank",
        shapes: sp({
          id: 2,
          name: "Bilingual",
          x: IN,
          y: IN,
          cx: 6 * IN,
          cy: 2 * IN,
          bodyPr: `<a:normAutofit/>`,
          paragraphs: para(run("Hello", { attrs: `lang="en-US"` })) + para(run("Hallo", { attrs: `lang="de-DE"` })),
        }),
        legacyComments: [{ authorId: 0, text: "Check this number" }],
        modernComments: [
          {
            id: "{C0000000-0000-4000-8000-000000000001}",
            authorId: REVIEW_AUTHOR_GUID,
            text: "Is the client OK with this?",
            replies: [{ id: "{C0000000-0000-4000-8000-000000000002}", authorId: REVIEW_AUTHOR_GUID, text: "Yes, confirmed" }],
          },
        ],
      },
    ],
    media: { "image1.png": pngBytes(300, 200, 1_000, 21) },
  };
}

// ---------------------------------------------------------------------------

const SPECS: Record<CorpusName, () => DeckSpec> = {
  clean: cleanSpec,
  "fonts-hidden": fontsHiddenSpec,
  "colors-literal": colorsLiteralSpec,
  "media-bloat": mediaBloatSpec,
  "masters-messy": mastersMessySpec,
  links: linksSpec,
  "review-leaks": reviewLeaksSpec,
};

export function corpusSpec(name: CorpusName): DeckSpec {
  return SPECS[name]();
}

const built = new Map<CorpusName, Promise<Uint8Array>>();

/** Builds (once per process) and returns a corpus deck's bytes. Callers must not mutate the result. */
export function corpusDeck(name: CorpusName): Promise<Uint8Array> {
  let p = built.get(name);
  if (!p) {
    p = buildDeck(corpusSpec(name));
    built.set(name, p);
  }
  return p;
}

/** Group-in-group-in-graphic-frame edge case (U3), reused by later units. */
export function nestedGroupShapes(): string {
  const inner = grpSp({
    id: 12,
    name: "Inner Group",
    x: 0,
    y: 0,
    cx: IN,
    cy: IN,
    children: [sp({ id: 13, name: "Deep Shape", x: 0, y: 0, cx: IN / 2, cy: IN / 2, text: "deep" })],
  });
  const outer = grpSp({ id: 11, name: "Outer Group", x: 0, y: 0, cx: 2 * IN, cy: 2 * IN, children: [inner] });
  return graphicFrame({
    id: 10,
    name: "Frame",
    x: IN,
    y: IN,
    cx: 2 * IN,
    cy: 2 * IN,
    uri: "urn:slidefidelity:test-container",
    data: outer,
  });
}

/**
 * Seeded facts per deck. Part names follow `buildDeck` numbering
 * (`ppt/slides/slideN.xml`, `ppt/slideLayouts/slideLayoutN.xml` numbered
 * across masters in order, `ppt/slideMasters/slideMasterN.xml`).
 */
export const SEEDS = {
  clean: {
    slideCount: 3,
    masterCount: 1,
    layoutCount: 3,
    themeColors: 12,
    majorFont: "Calibri Light",
    minorFont: "Calibri",
  },
  "fonts-hidden": {
    ae1: { slide: 1, shapeId: 4, fonts: [{ typeface: "Calibri", script: "latin", source: "direct" }, { typeface: "MS Gothic", script: "ea", source: "direct" }, { typeface: "Wingdings", script: "bu", source: "hidden-list-style" }] },
    themeReference: { slide: 1, shapeId: 5, ref: "+mn-lt", resolvesTo: "Calibri" },
    emptyShapeListStyleFont: { slide: 1, shapeId: 6, typeface: "Consolas" },
    chartOnlyFont: { part: "ppt/charts/chart1.xml", typeface: "Arial Narrow" },
    smartArtFont: { parts: ["ppt/diagrams/data1.xml", "ppt/diagrams/drawing1.xml"], typeface: "Segoe UI" },
    masterTextStyleFont: { master: "ppt/slideMasters/slideMaster1.xml", typeface: "Georgia" },
    embedded: { typeface: "Calibri", styles: ["regular", "bold"], subset: true },
  },
  "colors-literal": {
    literalByMaster: {
      "ppt/slideMasters/slideMaster1.xml": { "4472C4": 1, FF0000: 2, "00B050": 1 },
      "ppt/slideMasters/slideMaster2.xml": { "7030A0": 1 },
    },
    autoMatchable: { hex: "4472C4", slot: "accent1" },
    gradientLiteral: { hex: "00B050", reachable: false },
    themeWithModifiers: { slide: 2, shapeId: 2, slot: "accent2" },
    recentColors: ["FF0000", "7030A0", "123456"],
  },
  "media-bloat": {
    oversized: { part: "ppt/media/image1.jpeg", pixels: [4000, 3000], displayInches: [2, 1.5], bytes: MEDIA_BLOAT_BIG_BYTES },
    shared: { part: "ppt/media/image2.png", slides: [2, 3, 4, 5, 6] },
    distorted: { part: "ppt/media/image3.png", scale: [1, 0.6] },
    cropped: { part: "ppt/media/image4.jpeg", srcRect: { l: 10000, r: 5000 } },
    svgFallback: { svg: "ppt/media/image5.svg", fallback: "ppt/media/image6.png" },
    unknownFormat: { part: "ppt/media/image7.xyz" },
    tooSmall: { part: "ppt/media/image8.png", pixels: [100, 100], displayInches: [5, 5] },
    video: { part: "ppt/media/media1.mp4", poster: "ppt/media/image9.png" },
  },
  "masters-messy": {
    usage: {
      "ppt/slideLayouts/slideLayout1.xml": [256],
      "ppt/slideLayouts/slideLayout2.xml": [257, 258],
      "ppt/slideLayouts/slideLayout3.xml": [],
      "ppt/slideLayouts/slideLayout4.xml": [],
      "ppt/slideLayouts/slideLayout5.xml": [],
      "ppt/slideLayouts/slideLayout6.xml": [],
      "ppt/slideLayouts/slideLayout7.xml": [259],
      "ppt/slideLayouts/slideLayout8.xml": [260],
    } as Record<string, number[]>,
    unusedLayouts: [
      "ppt/slideLayouts/slideLayout3.xml",
      "ppt/slideLayouts/slideLayout4.xml",
      "ppt/slideLayouts/slideLayout5.xml",
      "ppt/slideLayouts/slideLayout6.xml",
    ],
    preservedUnusedMaster: "ppt/slideMasters/slideMaster2.xml",
    nearDuplicateLayoutName: "Title and Content",
  },
  links: {
    webHyperlinks: [
      { slide: 1, url: "https://example.com/a" },
      { slide: 1, url: "https://example.org/b" },
      { slide: 2, url: "https://example.net/c" },
    ],
    linkedOle: { slide: 2, target: "file:///C:\\Users\\alice\\Documents\\budget.xlsx", localPath: true },
    layoutLink: { layout: "ppt/slideLayouts/slideLayout2.xml", url: "https://intranet.example.com/brand" },
    internalJump: { slide: 2, relId: "rIdJump", excluded: true },
  },
  "review-leaks": {
    hiddenSlide: { slide: 2, slideId: 257 },
    hiddenShape: { slide: 3, shapeId: 2 },
    offSlideShape: { slide: 3, shapeId: 3 },
    partlyOffSlideShape: { slide: 3, shapeId: 4 },
    emptyPlaceholders: [{ slide: 4, shapeId: 2 }, { slide: 4, shapeId: 3 }],
    pictureOnlyPlaceholder: { slide: 4, shapeId: 4 },
    emptySection: "Empty",
    notes: { slide: 1, text: "Remember to mention pricing" },
    legacyComment: { slide: 5, text: "Check this number", author: "Alice Example" },
    threadedComment: { slide: 5, text: "Is the client OK with this?", replies: 1, author: "Bob Example" },
    customProperty: { name: "Client", value: "Contoso" },
    animatedSlide: 1,
    languages: ["en-US", "de-DE"],
    autofit: { slide: 5, shapeId: 2, mode: "normAutofit" },
  },
} as const;
