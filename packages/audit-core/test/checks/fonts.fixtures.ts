/**
 * Deck variants for the font checks (U5). Built with the shared builder so they stay
 * deterministic; the corpus decks (`clean`, `fonts-hidden`) cover the seeded AE1 facts.
 */
import { buildDeck, graphicFrame, GRAPHIC_URI, NS, para, run, sp, type DeckSpec } from "../helpers/buildDeck";

const IN = 914400;

const latin = (typeface: string): { inner: string } => ({ inner: `<a:latin typeface="${typeface}"/>` });

const CHART_CT = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

function chartXml(typeface: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart>` +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:latin typeface="${typeface}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`
  );
}

/**
 * AE2 shape: "Arial" in `textBoxes` text boxes (spread over slides of 10) and in one chart.
 */
export function arialDeck(textBoxes = 40): Promise<Uint8Array> {
  const slides: NonNullable<DeckSpec["slides"]> = [];
  for (let i = 0; i < textBoxes; i += 10) {
    let shapes = "";
    for (let j = i; j < Math.min(textBoxes, i + 10); j++) {
      shapes += sp({ id: 2 + (j - i), name: `TextBox ${j + 1}`, x: IN, y: IN, cx: IN, cy: IN, paragraphs: para(run(`Box ${j + 1}`, latin("Arial"))) });
    }
    slides.push({ layout: "Blank", shapes });
  }
  slides.push({
    layout: "Blank",
    shapes: graphicFrame({ id: 2, name: "Chart 1", x: IN, y: IN, cx: 4 * IN, cy: 3 * IN, uri: GRAPHIC_URI.chart, data: `<c:chart xmlns:c="${NS.c}" r:id="rIdChart"/>` }),
    rels: [{ id: "rIdChart", type: "chart", target: "../charts/chart1.xml" }],
  });
  return buildDeck({
    slides,
    parts: [{ path: "ppt/charts/chart1.xml", content: chartXml("Arial"), contentType: CHART_CT }],
  });
}

/** A text box whose only non-theme font is set in the East Asian slot. */
export function eaOnlyDeck(): Promise<Uint8Array> {
  return buildDeck({
    slides: [
      {
        layout: "Blank",
        shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: IN, cy: IN, paragraphs: para(run("漢字", { inner: `<a:ea typeface="SimSun"/>` })) }),
      },
    ],
  });
}

/** A 2x2 table whose cell (1,1) run is Verdana. */
export function tableDeck(): Promise<Uint8Array> {
  const cell = (text: string, font?: string): string =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(run(text, font ? latin(font) : {}))}</a:txBody><a:tcPr/></a:tc>`;
  const tbl =
    `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="${IN}"/><a:gridCol w="${IN}"/></a:tblGrid>` +
    `<a:tr h="${IN / 2}">${cell("a")}${cell("b")}</a:tr>` +
    `<a:tr h="${IN / 2}">${cell("c")}${cell("d", "Verdana")}</a:tr></a:tbl>`;
  return buildDeck({
    slides: [{ layout: "Blank", shapes: graphicFrame({ id: 2, name: "Table 1", x: IN, y: IN, cx: 2 * IN, cy: IN, uri: GRAPHIC_URI.table, data: tbl }) }],
  });
}

/** Symbol font set via `a:sym`, a bullet font in the paragraph, and a mixed-font paragraph. */
export function mixedDeck(): Promise<Uint8Array> {
  const paragraphs =
    para(run("Hello ", latin("Arial")) + run("world", latin("Calibri")) + run("∑", { inner: `<a:sym typeface="Symbol"/>` })) +
    para(run("Bullet", latin("Arial")), `<a:pPr><a:buFont typeface="Courier New"/><a:buChar char="o"/></a:pPr>`) +
    `<a:p><a:endParaRPr lang="en-US"><a:latin typeface="Tahoma"/></a:endParaRPr></a:p>`;
  return buildDeck({
    slides: [{ layout: "Blank", shapes: sp({ id: 7, name: "TextBox 6", x: IN, y: IN, cx: IN, cy: IN, paragraphs }) }],
  });
}

/** Theme minor font changed to Aptos and a `+mn-lt` run on a slide. */
export function themeRefDeck(): Promise<Uint8Array> {
  return buildDeck({
    masters: [
      {
        theme: { majorLatin: "Aptos Display", minorLatin: "Aptos" },
        layouts: [{ name: "Blank", type: "blank" }],
      },
    ],
    slides: [
      { shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: IN, cy: IN, paragraphs: para(run("Theme", { inner: `<a:latin typeface="+mn-lt"/>` })) }) },
    ],
  });
}

/** Fully embedded fonts (no subset flag). */
export function fullEmbedDeck(): Promise<Uint8Array> {
  return buildDeck({ embeddedFonts: [{ typeface: "Calibri", styles: ["regular"] }] });
}
