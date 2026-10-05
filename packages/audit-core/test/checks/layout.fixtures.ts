/**
 * Deck variants for the layout checks (partly off-slide objects, text touching other objects).
 * Default slide size: 13.333 in × 7.5 in (12192000 × 6858000 EMU).
 */
import { buildDeck as rawBuildDeck, type DeckSpec, graphicFrame, GRAPHIC_URI, grpSp, pic, sp } from "../helpers/buildDeck";
import { EMU_PER_INCH } from "../helpers/corpus";

export const IN = EMU_PER_INCH;

/** Rounds fractional numeric attributes (e.g. `0.1 * IN`) so every coordinate is an integer EMU. */
function roundNums(xml: string): string {
  return xml.replace(/="(-?\d+\.\d+)"/g, (_m, n: string) => `="${Math.round(Number(n))}"`);
}

function buildDeck(spec: DeckSpec): Promise<Uint8Array> {
  return rawBuildDeck({
    ...spec,
    ...(spec.masters
      ? {
          masters: spec.masters.map((m) => ({
            ...m,
            ...(m.shapes !== undefined ? { shapes: roundNums(m.shapes) } : {}),
            ...(m.layouts ? { layouts: m.layouts.map((l) => (l.shapes !== undefined ? { ...l, shapes: roundNums(l.shapes) } : l)) } : {}),
          })),
        }
      : {}),
    ...(spec.slides ? { slides: spec.slides.map((s) => (s.shapes !== undefined ? { ...s, shapes: roundNums(s.shapes) } : s)) } : {}),
  });
}
export const PT = 12700;

/** Adds `rot` (60,000ths of a degree) to the first `a:xfrm` of a shape snippet. */
export function rotate(shape: string, rot: number): string {
  return shape.replace("<a:xfrm>", `<a:xfrm rot="${rot}">`);
}

/** Marks an `sp` snippet as a text box (`cNvSpPr txBox="1"`). */
export function textBox(shape: string): string {
  return shape.replace("<p:cNvSpPr/>", `<p:cNvSpPr txBox="1"/>`);
}

const NO_FILL = `<a:noFill/>`;
const SOLID = `<a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill>`;

/** A text box with no fill and no outline (as PowerPoint inserts them). */
export function text(id: number, name: string, x: number, y: number, cx: number, cy: number, t = "Hello"): string {
  return textBox(sp({ id, name, x, y, cx, cy, text: t, spPr: NO_FILL }));
}

export function table(id: number, name: string, x: number, y: number, cx: number, cy: number, cellText = "Q3"): string {
  const tbl =
    `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="${cx}"/></a:tblGrid>` +
    `<a:tr h="${cy}"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${cellText}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>`;
  return graphicFrame({ id, name, x, y, cx, cy, uri: GRAPHIC_URI.table, data: tbl });
}

export function chart(id: number, name: string, x: number, y: number, cx: number, cy: number): string {
  return graphicFrame({ id, name, x, y, cx, cy, uri: GRAPHIC_URI.chart, data: `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdC"/>` });
}

export function video(id: number, name: string, x: number, y: number, cx: number, cy: number): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>` +
    `<p:nvPr><a:videoFile r:link="rIdV"/></p:nvPr></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rIdP"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

export function image(id: number, name: string, x: number, y: number, cx: number, cy: number, hidden = false): string {
  return pic({ id, name, embed: "rIdImg", x, y, cx, cy, ...(hidden ? { hidden } : {}) });
}

/** Master + layout whose body placeholder (idx 5) sits partly off the right edge. */
function parkedMaster(): { shapes: string; layouts: { name: string; type: string; shapes: string }[] } {
  return {
    shapes:
      sp({ id: 2, name: "Title Placeholder 1", ph: { type: "title" }, x: IN, y: 0.3 * IN, cx: 11 * IN, cy: 1.2 * IN, text: "Master title" }) +
      sp({ id: 3, name: "Text Placeholder 2", ph: { type: "body", idx: 1 }, x: IN, y: 2 * IN, cx: 11 * IN, cy: 4 * IN, text: "Master text" }),
    layouts: [
      {
        name: "Overhang",
        type: "obj",
        shapes:
          sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Layout title" }) +
          sp({ id: 3, name: "Side note 2", ph: { type: "body", idx: 5 }, x: 12 * IN, y: 3 * IN, cx: 2 * IN, cy: IN, text: "Side" }),
      },
    ],
  };
}

/**
 * Partly-off-slide cases:
 * 1. text box 'Overhang' 0.667 in past the right edge (warning) + full-bleed picture 'Bleed'
 *    0.1 in past every edge (info);
 * 2. 'Nudged' 0.04 in past the left edge (within tolerance), 'Gone' fully off (review's case),
 *    hidden 'Secret' partly off — all silent;
 * 3. inherited placeholder 'Side note 2' (no xfrm) partly off via its layout (warning, inherited);
 * 4. group 'Callout group' with a partly-off text child (warning, outermost only) and group
 *    'Photo group' of pictures (info);
 * 5. table 'Results' partly off the bottom (warning), video 'Clip' (warning), chart 'Sales'
 *    (warning), and shape 'Bar' that only overhangs once rotated 90° (info, rotated).
 */
export function partlyOffDeck(): Promise<Uint8Array> {
  return buildDeck({
    masters: [parkedMaster()],
    slides: [
      {
        layout: "Overhang",
        shapes:
          image(2, "Bleed", -0.1 * IN, -0.1 * IN, 13.533 * IN, 7.7 * IN) + text(3, "Overhang", 12 * IN, 5 * IN, 2 * IN, 0.5 * IN, "Cut off"),
      },
      {
        layout: "Overhang",
        shapes:
          sp({ id: 2, name: "Nudged", x: -0.04 * IN, y: IN, cx: 2 * IN, cy: IN, text: "Edge" }) +
          sp({ id: 3, name: "Gone", x: 14 * IN, y: IN, cx: 2 * IN, cy: IN, text: "Parked" }) +
          sp({ id: 4, name: "Secret", hidden: true, x: 12 * IN, y: IN, cx: 2 * IN, cy: IN, text: "Hidden" }),
      },
      {
        layout: "Overhang",
        shapes: sp({ id: 3, name: "Side note 2", ph: { type: "body", idx: 5 }, noXfrm: true, text: "Inherited overhang" }),
      },
      {
        layout: "Overhang",
        shapes:
          grpSp({
            id: 2,
            name: "Callout group",
            x: 11 * IN,
            y: IN,
            cx: 3 * IN,
            cy: IN,
            children: [
              sp({ id: 3, name: "Callout box", x: 11 * IN, y: IN, cx: IN, cy: IN, spPr: SOLID, noTxBody: true }),
              text(4, "Callout text", 12 * IN, IN, 2 * IN, IN, "Cut"),
            ],
          }) +
          grpSp({
            id: 10,
            name: "Photo group",
            x: -IN,
            y: 4 * IN,
            cx: 3 * IN,
            cy: IN,
            children: [image(11, "Left photo", -IN, 4 * IN, 1.5 * IN, IN), image(12, "Right photo", 0.5 * IN, 4 * IN, 1.5 * IN, IN)],
          }),
      },
      {
        layout: "Overhang",
        shapes:
          table(2, "Results", IN, 7 * IN, 4 * IN, IN) +
          video(3, "Clip", -IN, IN, 3 * IN, 2 * IN) +
          chart(4, "Sales", 11 * IN, -0.5 * IN, 3 * IN, 2 * IN) +
          rotate(sp({ id: 5, name: "Bar", x: 4 * IN, y: 6.75 * IN, cx: 4 * IN, cy: 0.5 * IN, spPr: SOLID, noTxBody: true }), 5400000),
      },
    ],
  });
}

/**
 * Text-collision cases (one slide each, numbered in slide order):
 * 1. text 'Title 1' overlaps picture 'Photo 3' (warning);
 * 2. text 'Label' 1 pt above picture 'Chart image' (warning, touching) and 3 pt from 'Far image' (none);
 * 3. caption 'Caption' fully inside picture 'Hero' (info);
 * 4. text boxes 'Left' and 'Right' overlap (warning, one finding on 'Left');
 * 5. text vs full-slide filled 'Background' rectangle and an unfilled outline-less shape (none);
 * 6. text 'Tilted' rotated 45° over picture 'Photo' (info, rotated);
 * 7. group children: text 'Group text' overlaps picture 'Group pic' inside one group (warning);
 * 8. hidden picture over text, and a hidden group's text over a picture (none);
 * 9. table 'Table 1' overlaps picture 'Logo' (warning);
 * 10. video poster 'Clip' overlapping title placeholder 'Title 1' with inherited bounds (warning),
 *     and a style-filled rectangle 'Badge' touching text 'Note' (warning).
 */
export function collisionDeck(): Promise<Uint8Array> {
  const styled = (id: number, name: string, x: number, y: number, cx: number, cy: number): string =>
    sp({ id, name, x, y, cx, cy, noTxBody: true }).replace(
      "</p:spPr>",
      `</p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`,
    );
  return buildDeck({
    slides: [
      { layout: "Blank", shapes: text(2, "Title 1", IN, IN, 4 * IN, IN) + image(3, "Photo 3", 4 * IN, 1.5 * IN, 3 * IN, 2 * IN) },
      {
        layout: "Blank",
        shapes:
          text(2, "Label", IN, IN, 4 * IN, IN) +
          image(3, "Chart image", IN, 2 * IN + PT, 4 * IN, 2 * IN) +
          image(4, "Far image", 5 * IN + 3 * PT, IN, 2 * IN, IN),
      },
      { layout: "Blank", shapes: image(2, "Hero", IN, IN, 8 * IN, 5 * IN) + text(3, "Caption", 2 * IN, 5 * IN, 4 * IN, 0.5 * IN) },
      { layout: "Blank", shapes: text(2, "Left", IN, IN, 4 * IN, IN) + text(3, "Right", 4.5 * IN, 1.2 * IN, 4 * IN, IN) },
      {
        layout: "Blank",
        shapes:
          sp({ id: 2, name: "Background", x: 0, y: 0, cx: 12192000, cy: 6858000, spPr: SOLID, noTxBody: true }) +
          sp({ id: 3, name: "Invisible frame", x: 0.5 * IN, y: 0.5 * IN, cx: 6 * IN, cy: 3 * IN, spPr: `${NO_FILL}<a:ln><a:noFill/></a:ln>`, noTxBody: true }) +
          text(4, "On background", IN, IN, 4 * IN, IN),
      },
      { layout: "Blank", shapes: rotate(text(2, "Tilted", IN, IN, 4 * IN, IN), 2700000) + image(3, "Photo", 4.5 * IN, IN, 3 * IN, 2 * IN) },
      {
        layout: "Blank",
        shapes: grpSp({
          id: 2,
          name: "Group 1",
          x: IN,
          y: IN,
          cx: 6 * IN,
          cy: 3 * IN,
          children: [text(3, "Group text", IN, IN, 4 * IN, IN), image(4, "Group pic", 4 * IN, IN, 3 * IN, 3 * IN)],
        }),
      },
      {
        layout: "Blank",
        shapes:
          text(2, "Visible text", IN, IN, 4 * IN, IN) +
          image(3, "Hidden photo", 2 * IN, IN, 3 * IN, 2 * IN, true) +
          image(4, "Shown photo", 8 * IN, 4 * IN, 3 * IN, 2 * IN) +
          grpSp({ id: 5, name: "Hidden group", hidden: true, x: 8 * IN, y: 4 * IN, cx: 2 * IN, cy: IN, children: [text(6, "Hidden text", 8 * IN, 4 * IN, 2 * IN, IN)] }),
      },
      { layout: "Blank", shapes: table(2, "Table 1", IN, IN, 4 * IN, IN) + image(3, "Logo", 4.5 * IN, 1.5 * IN, 2 * IN, IN) },
      {
        layout: "Title and Content",
        shapes:
          sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Quarterly update" }) +
          video(3, "Clip", 8 * IN, 0.5 * IN, 3 * IN, 2 * IN) +
          text(4, "Note", IN, 6 * IN, 3 * IN, 0.5 * IN) +
          styled(5, "Badge", 4 * IN, 6 * IN, IN, 0.5 * IN),
      },
    ],
  });
}

/**
 * Cap behaviour: slide 1 holds text 'Crowded' (z 0), an overlapping picture 'Early' (z 1),
 * `fillers` small pictures far from the text, then an overlapping picture 'Late' after them.
 */
export function crowdedDeck(fillers: number): Promise<Uint8Array> {
  const parts = [text(2, "Crowded", IN, IN, 2 * IN, IN), image(3, "Early", 2.5 * IN, 1.5 * IN, IN, IN)];
  for (let i = 0; i < fillers; i++) {
    const col = i % 40;
    const row = Math.floor(i / 40);
    parts.push(image(10 + i, `Filler ${i + 1}`, 4 * IN + col * 0.2 * IN, 3 * IN + row * 0.3 * IN, 0.1 * IN, 0.1 * IN));
  }
  parts.push(image(10 + fillers, "Late", 1.5 * IN, 1.5 * IN, IN, IN));
  return buildDeck({ slides: [{ layout: "Blank", shapes: parts.join("") }] });
}
