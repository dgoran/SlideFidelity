/**
 * Deck variants for the slide-title and slide-number checks (Graphics Ops bulk fixes).
 */
import { buildDeck, layoutPart, masterPart, para, run, sp } from "../helpers/buildDeck";
import { EMU_PER_INCH } from "../helpers/corpus";
import { mutateDeck } from "../helpers/mutateDeck";

const IN = EMU_PER_INCH;

const TX_STYLES = (titleSz: string): string =>
  `<p:titleStyle><a:lvl1pPr><a:defRPr${titleSz}><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>`;

const lvl1 = (sz: number): string => `<a:lvl1pPr><a:defRPr sz="${sz}"/></a:lvl1pPr>`;

const masterShapes = (): string =>
  sp({ id: 2, name: "Title Placeholder 1", ph: { type: "title" }, x: IN, y: IN / 2, cx: 10 * IN, cy: IN, text: "Master title" }) +
  sp({ id: 3, name: "Text Placeholder 2", ph: { type: "body", idx: 1 }, x: IN, y: 2 * IN, cx: 10 * IN, cy: 4 * IN, text: "Master text" }) +
  sp({ id: 4, name: "Slide Number Placeholder 3", ph: { type: "sldNum", idx: 12 }, x: 10 * IN, y: 7 * IN, cx: IN, cy: IN / 2, text: "‹#›" });

const titleSp = (id: number, extra: Partial<Parameters<typeof sp>[0]> & { text?: string }, type = "title"): string =>
  sp({ id, name: `Title ${id - 1}`, ph: { type }, noXfrm: true, ...extra });

/**
 * Master titleStyle 40pt; layouts:
 *  1 "Title Slide" (ctrTitle, lstStyle 60pt), 2 "Big Title" (title lstStyle 36pt + normAutofit),
 *  3 "Plain" (title, no size), 4 "Blank" (no title).
 * Slides:
 *  1 ctrTitle inherits 60 (layout)
 *  2 title run sz 32 (shape)
 *  3 Big Title: inherits 36 (layout), autofit shrink inherited from layout
 *  4 Plain: inherits 40 (master)
 *  5 mixed "Q3 " sz 28 + "Results" inherited 40
 *  6 normAutofit fontScale 62.5% lnSpcReduction 20%, run sz 44
 *  7 Blank, no title
 *  8 hidden, title run sz 32
 *  9 shape lstStyle 24
 */
export function titlesDeck(): Promise<Uint8Array> {
  return buildDeck({
    masters: [
      {
        shapes: masterShapes(),
        txStyles: TX_STYLES(` sz="4000"`),
        layouts: [
          { name: "Title Slide", type: "title", shapes: titleSp(2, { text: "Layout ctr", lstStyle: lvl1(6000) }, "ctrTitle") },
          { name: "Big Title", type: "obj", shapes: titleSp(2, { text: "Layout big", lstStyle: lvl1(3600), bodyPr: `<a:normAutofit/>` }) },
          { name: "Plain", type: "obj", shapes: titleSp(2, { text: "Layout plain" }) },
          { name: "Blank", type: "blank", shapes: "" },
        ],
      },
    ],
    slides: [
      { layout: "Title Slide", shapes: titleSp(2, { text: "Welcome" }, "ctrTitle") },
      { layout: "Plain", shapes: titleSp(2, { paragraphs: para(run("Explicit", { attrs: `lang="en-US" sz="3200"` })) }) },
      { layout: "Big Title", shapes: titleSp(2, { text: "From layout" }) },
      { layout: "Plain", shapes: titleSp(2, { text: "From master" }) },
      { layout: "Plain", shapes: titleSp(2, { paragraphs: para(run("Q3 ", { attrs: `lang="en-US" sz="2800"` }) + run("Results")) }) },
      {
        layout: "Plain",
        shapes: titleSp(2, {
          bodyPr: `<a:normAutofit fontScale="62500" lnSpcReduction="20000"/>`,
          paragraphs: para(run("A very long title that is being shrunk to fit", { attrs: `lang="en-US" sz="4400"` })),
        }),
      },
      { layout: "Blank", shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: 4 * IN, cy: IN, text: "No title here" }) },
      { layout: "Plain", hidden: true, shapes: titleSp(2, { paragraphs: para(run("Hidden", { attrs: `lang="en-US" sz="3200"` })) }) },
      { layout: "Plain", shapes: titleSp(2, { text: "Shape list style", lstStyle: lvl1(2400) }) },
    ],
  });
}

/** Master titleStyle has no size: titles fall back to the 18pt default. */
export function defaultSizeDeck(): Promise<Uint8Array> {
  return buildDeck({
    masters: [
      {
        shapes: masterShapes(),
        txStyles: TX_STYLES(""),
        layouts: [{ name: "Plain", type: "obj", shapes: titleSp(2, { text: "Layout plain" }) }],
      },
    ],
    slides: [{ layout: "Plain", shapes: titleSp(2, { text: "Default size" }) }],
  });
}

/** Title slide (ctrTitle 60) + two content slides (title 40): consistent per placeholder type. */
export function consistentTitlesDeck(): Promise<Uint8Array> {
  return buildDeck({
    masters: [
      {
        shapes: masterShapes(),
        txStyles: TX_STYLES(` sz="4000"`),
        layouts: [
          { name: "Title Slide", type: "title", shapes: titleSp(2, { text: "Layout ctr", lstStyle: lvl1(6000) }, "ctrTitle") },
          { name: "Plain", type: "obj", shapes: titleSp(2, { text: "Layout plain" }) },
        ],
      },
    ],
    slides: [
      { layout: "Title Slide", shapes: titleSp(2, { text: "Welcome" }, "ctrTitle") },
      { layout: "Plain", shapes: titleSp(2, { text: "One" }) },
      { layout: "Plain", shapes: titleSp(2, { text: "Two" }) },
    ],
  });
}

const fld = (type: string, text: string, id = "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}"): string =>
  `<a:fld id="${id}" type="${type}"><a:rPr lang="en-US"/><a:t>${text}</a:t></a:fld>`;

const sldNumPh = (id: number, n: number): string =>
  sp({ id, name: `Slide Number Placeholder ${id - 1}`, ph: { type: "sldNum", idx: 12 }, noXfrm: true, paragraphs: para(fld("slidenum", String(n))) });

/**
 * Slide numbers:
 *  layout 1 "Numbered" has a sldNum placeholder and `p:hf sldNum="0"`; layout 2 "Title Slide" has none.
 *  master has a sldNum placeholder and `p:hf hdr="0"` (sldNum defaults on).
 *  1 sldNum placeholder (shape 3)
 *  2 hidden, sldNum placeholder (shape 3)
 *  3 field-only text box (shape 2, whitespace run + field)
 *  4 "Page <fld> of 10" text box (shape 2) → unreachable
 *  5 date field only, no numbers
 */
export async function slideNumbersDeck(): Promise<Uint8Array> {
  const bytes = await buildDeck({
    masters: [
      {
        shapes: masterShapes(),
        layouts: [
          { name: "Numbered", type: "obj", shapes: titleSp(2, { text: "Layout title" }) + sldNumPh(3, 0) },
          { name: "Title Slide", type: "title", shapes: titleSp(2, { text: "Layout ctr" }, "ctrTitle") },
        ],
      },
    ],
    slides: [
      { layout: "Numbered", shapes: titleSp(2, { text: "One" }) + sldNumPh(3, 1) },
      { layout: "Numbered", hidden: true, shapes: titleSp(2, { text: "Two" }) + sldNumPh(3, 2) },
      {
        layout: "Title Slide",
        shapes: sp({ id: 2, name: "Number Box", x: IN, y: 7 * IN, cx: IN, cy: IN / 2, paragraphs: para(run("  ") + fld("slidenum", "3")) }),
      },
      {
        layout: "Title Slide",
        shapes: sp({ id: 2, name: "Page Box", x: IN, y: 7 * IN, cx: 2 * IN, cy: IN / 2, paragraphs: para(run("Page ") + fld("slidenum", "4") + run(" of 10")) }),
      },
      {
        layout: "Title Slide",
        shapes: sp({ id: 2, name: "Date Box", x: IN, y: 7 * IN, cx: 2 * IN, cy: IN / 2, paragraphs: para(fld("datetime1", "1/1/2024")) }),
      },
    ],
  });
  return mutateDeck(bytes, async (m) => {
    await m.editXml(layoutPart(1), (x) => x.replace("</p:sldLayout>", `<p:hf sldNum="0" hdr="0" ftr="0" dt="0"/></p:sldLayout>`));
    await m.editXml(masterPart(1), (x) => x.replace("<p:txStyles>", `<p:hf hdr="0"/><p:txStyles>`));
  });
}
