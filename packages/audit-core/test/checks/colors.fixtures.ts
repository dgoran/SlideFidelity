/**
 * Deck variants for the Colors area (U6). Built with `buildDeck` so each deck isolates one
 * color-reference shape: tables, groups, charts, SmartArt, sys/preset colors, modifiers,
 * effects, backgrounds, layout/master literals, and two masters with different themes.
 */
import { buildDeck, DEFAULT_LAYOUTS, graphicFrame, GRAPHIC_URI, grpSp, NS, para, run, slidePart, sp } from "../helpers/buildDeck";
import { mutateDeck } from "../helpers/mutateDeck";
import { EMU_PER_INCH } from "../helpers/corpus";

const IN = EMU_PER_INCH;

export const solid = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;

/** One shape per reachable property plus unreachable variants on a single slide. */
export function propertiesDeck(): Promise<Uint8Array> {
  return buildDeck({
    presProps: false,
    slides: [
      {
        layout: "Blank",
        shapes:
          // 2: fill + line + two runs (second run red) in one shape
          sp({
            id: 2,
            name: "Mixed",
            x: IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `${solid("FF0000")}<a:ln w="12700">${solid("FF0000")}</a:ln>`,
            paragraphs:
              para(run("plain ") + run("red", { inner: solid("FF0000") })) +
              para(run("second para", { inner: solid("FF0000") })),
          }) +
          // 3: pattern fill (fg literal) → unreachable
          sp({
            id: 3,
            name: "Pattern",
            x: 2 * IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `<a:pattFill prst="pct5"><a:fgClr><a:srgbClr val="FF0000"/></a:fgClr><a:bgClr><a:schemeClr val="bg1"/></a:bgClr></a:pattFill>`,
          }) +
          // 4: effect shadow literal → unreachable
          sp({
            id: 4,
            name: "Shadow",
            x: 3 * IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `<a:noFill/><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000"><a:srgbClr val="FF0000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst>`,
          }) +
          // 5: literal with lumMod → listed, unreachable (resolved RGB differs from the base hex)
          sp({
            id: 5,
            name: "Darkened",
            x: 4 * IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `<a:solidFill><a:srgbClr val="FF0000"><a:lumMod val="75000"/></a:srgbClr></a:solidFill>`,
          }) +
          // 6: bullet color literal → unreachable
          sp({
            id: 6,
            name: "Bullets",
            x: 5 * IN,
            y: IN,
            cx: IN,
            cy: IN,
            paragraphs: para(run("item"), `<a:pPr><a:buClr><a:srgbClr val="FF0000"/></a:buClr><a:buChar char="&#8226;"/></a:pPr>`),
          }) +
          // 7: theme reference with modifiers → never a literal
          sp({
            id: 7,
            name: "Theme mod",
            x: 6 * IN,
            y: IN,
            cx: IN,
            cy: IN,
            spPr: `<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>`,
            paragraphs: para(run("theme text", { inner: `<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>` })),
          }),
      },
    ],
  });
}

/** A table with a literal cell fill and a literal run color, plus a group child fill. */
export function tableGroupDeck(): Promise<Uint8Array> {
  const cell = (inner: string, tcPr: string): string =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${inner}</a:txBody><a:tcPr>${tcPr}</a:tcPr></a:tc>`;
  const tbl =
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="914400"/><a:gridCol w="914400"/></a:tblGrid>` +
    `<a:tr h="370840">${cell(para(run("a")), "")}${cell(para(run("b")), solid("00B0F0"))}</a:tr>` +
    `<a:tr h="370840">${cell(para(run("c")), `<a:lnL w="12700">${solid("00B0F0")}</a:lnL>`)}${cell(para(run("x") + run("d", { inner: solid("00B0F0") })), "")}</a:tr>` +
    `</a:tbl>`;
  return buildDeck({
    presProps: false,
    slides: [
      {
        layout: "Blank",
        shapes:
          graphicFrame({ id: 2, name: "Table 1", x: IN, y: IN, cx: 2 * IN, cy: IN, uri: GRAPHIC_URI.table, data: tbl }) +
          grpSp({
            id: 3,
            name: "Group 2",
            x: 4 * IN,
            y: IN,
            cx: 2 * IN,
            cy: IN,
            children: [sp({ id: 4, name: "Grouped", x: 4 * IN, y: IN, cx: IN, cy: IN, spPr: solid("00B0F0") })],
          }),
      },
    ],
  });
}

const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:plotArea><c:layout/>` +
  `<c:barChart><c:ser><c:idx val="0"/><c:spPr>${solid("C00000")}</c:spPr></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

const DGM_CT = "application/vnd.openxmlformats-officedocument.drawingml.";

/** Literal colors only inside a chart and a SmartArt diagram (data + drawing cache). */
export function chartSmartArtDeck(): Promise<Uint8Array> {
  const spPrDgm = `<dgm:spPr>${solid("C00000")}</dgm:spPr>`;
  return buildDeck({
    presProps: false,
    slides: [
      {
        layout: "Blank",
        shapes:
          graphicFrame({ id: 2, name: "Chart 1", x: IN, y: IN, cx: 4 * IN, cy: 3 * IN, uri: GRAPHIC_URI.chart, data: `<c:chart xmlns:c="${NS.c}" r:id="rIdChart"/>` }) +
          graphicFrame({
            id: 3,
            name: "Diagram 2",
            x: 6 * IN,
            y: IN,
            cx: 4 * IN,
            cy: 3 * IN,
            uri: GRAPHIC_URI.diagram,
            data: `<dgm:relIds xmlns:dgm="${NS.dgm}" r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>`,
          }),
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
        content: `<dgm:dataModel xmlns:dgm="${NS.dgm}" xmlns:a="${NS.a}"><dgm:ptLst><dgm:pt modelId="{1}">${spPrDgm}</dgm:pt></dgm:ptLst></dgm:dataModel>`,
      },
      { path: "ppt/diagrams/layout1.xml", contentType: `${DGM_CT}diagramLayout+xml`, content: `<dgm:layoutDef xmlns:dgm="${NS.dgm}"/>` },
      { path: "ppt/diagrams/quickStyle1.xml", contentType: `${DGM_CT}diagramStyle+xml`, content: `<dgm:styleDef xmlns:dgm="${NS.dgm}"/>` },
      { path: "ppt/diagrams/colors1.xml", contentType: `${DGM_CT}diagramColors+xml`, content: `<dgm:colorsDef xmlns:dgm="${NS.dgm}"/>` },
      {
        path: "ppt/diagrams/drawing1.xml",
        contentType: "application/vnd.ms-office.drawingml.diagramDrawing+xml",
        // The drawing is a render cache of the data model: it must not double-count.
        content: `<dsp:drawing xmlns:dsp="${NS.dsp}" xmlns:a="${NS.a}"><dsp:spTree><dsp:sp modelId="{2}"><dsp:spPr>${solid("C00000")}</dsp:spPr></dsp:sp></dsp:spTree></dsp:drawing>`,
      },
    ],
  });
}

/** sysClr, known prstClr, unknown prstClr, hslClr, scrgbClr literals. */
export function sysPresetDeck(): Promise<Uint8Array> {
  return buildDeck({
    presProps: false,
    slides: [
      {
        layout: "Blank",
        shapes:
          sp({ id: 2, name: "Sys", x: IN, y: IN, cx: IN, cy: IN, spPr: `<a:solidFill><a:sysClr val="windowText" lastClr="000000"/></a:solidFill>` }) +
          sp({ id: 3, name: "Preset red", x: 2 * IN, y: IN, cx: IN, cy: IN, spPr: `<a:solidFill><a:prstClr val="red"/></a:solidFill>` }) +
          sp({ id: 4, name: "Preset odd", x: 3 * IN, y: IN, cx: IN, cy: IN, spPr: `<a:solidFill><a:prstClr val="notARealPreset"/></a:solidFill>` }) +
          sp({ id: 5, name: "Hsl", x: 4 * IN, y: IN, cx: IN, cy: IN, spPr: `<a:solidFill><a:hslClr hue="0" sat="100000" lum="50000"/></a:solidFill>` }) +
          sp({ id: 6, name: "ScRgb", x: 5 * IN, y: IN, cx: IN, cy: IN, spPr: `<a:solidFill><a:scrgbClr r="0" g="100000" b="0"/></a:solidFill>` }),
      },
    ],
  });
}

/**
 * Two masters with different themes. Master 2's accent1 is 7030A0. Purple is used on both
 * masters: in-theme on master 2, out of theme on master 1. Also a literal on a layout, on a
 * master, in master text styles, and as a slide background.
 */
export function twoMastersDeck(): Promise<Uint8Array> {
  return buildDeck({
    presProps: { recentColors: [] },
    masters: [
      {
        layouts: DEFAULT_LAYOUTS.map((l) =>
          l.name === "Blank"
            ? { ...l, shapes: sp({ id: 9, name: "Layout band", x: 0, y: 0, cx: IN, cy: IN, spPr: solid("ABCDEF") }) }
            : l,
        ),
        shapes: sp({ id: 9, name: "Master logo", x: 0, y: 0, cx: IN, cy: IN, spPr: solid("ABCDEF") }),
        txStyles: `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle/><p:otherStyle/>`,
      },
      { layouts: [{ name: "Blank 2", type: "blank" }], theme: { name: "Purple Theme", colors: { accent1: "7030A0" } } },
    ],
    slides: [
      { layout: { master: 0, layout: 2 }, shapes: sp({ id: 2, name: "Purple A", x: IN, y: IN, cx: IN, cy: IN, spPr: solid("7030A0") }) },
      {
        layout: { master: 1, layout: 0 },
        shapes: sp({ id: 2, name: "Purple B", x: IN, y: IN, cx: IN, cy: IN, spPr: solid("7030A0") }),
      },
      { layout: { master: 0, layout: 2 }, shapes: "" },
    ],
  });
}

/** A slide with a literal background (p:bg/p:bgPr) and a near-red shape fill (FE0101). */
export async function backgroundDeck(): Promise<Uint8Array> {
  const bytes = await buildDeck({
    presProps: false,
    slides: [{ layout: "Blank", shapes: sp({ id: 2, name: "Near red", x: IN, y: IN, cx: IN, cy: IN, spPr: solid("FE0101") }) }],
  });
  return mutateDeck(bytes, (m) =>
    m.editXml(slidePart(1), (xml) => xml.replace("<p:cSld>", `<p:cSld><p:bg><p:bgPr>${solid("FFFF00")}<a:effectLst/></p:bgPr></p:bg>`)),
  );
}
