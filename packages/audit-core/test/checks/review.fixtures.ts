/**
 * Deck variants for the File Review checks (U8), built on the shared test helpers.
 */
import { buildDeck, DEFAULT_LAYOUTS, grpSp, NS, para, run, sp } from "../helpers/buildDeck";
import { EMU_PER_INCH } from "../helpers/corpus";

const IN = EMU_PER_INCH;

/**
 * Placeholders whose positions are inherited:
 * - slide 1 shape 2 (title, no xfrm) → layout title (no xfrm) → master title at x = -5in (fully off-slide);
 * - slide 1 shape 3 (body idx 5, no xfrm) → layout placeholder at x = 14in (fully off-slide);
 * - slide 1 shape 4 (body idx 6, no xfrm) → layout placeholder on the slide (not flagged);
 * - slide 1 shape 5 (body idx 7, no xfrm) → no matching layout placeholder, falls back to master body (on-slide).
 */
export function inheritedOffSlideDeck(): Promise<Uint8Array> {
  const master =
    sp({ id: 2, name: "Title Placeholder 1", ph: { type: "title" }, x: -5 * IN, y: IN, cx: 3 * IN, cy: IN, text: "Master title" }) +
    sp({ id: 3, name: "Text Placeholder 2", ph: { type: "body", idx: 1 }, x: IN, y: 2 * IN, cx: 8 * IN, cy: 4 * IN, text: "Master text" });
  const layout =
    sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Layout title" }) +
    sp({ id: 3, name: "Parked 2", ph: { type: "body", idx: 5 }, x: 14 * IN, y: IN, cx: 2 * IN, cy: IN, text: "Parked" }) +
    sp({ id: 4, name: "Visible 3", ph: { type: "body", idx: 6 }, x: IN, y: IN, cx: 2 * IN, cy: IN, text: "Visible" });
  return buildDeck({
    masters: [{ shapes: master, layouts: [{ name: "Parked", type: "obj", shapes: layout }] }],
    slides: [
      {
        layout: "Parked",
        shapes:
          sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Title" }) +
          sp({ id: 3, name: "Parked 2", ph: { type: "body", idx: 5 }, noXfrm: true, text: "Inherited parked" }) +
          sp({ id: 4, name: "Visible 3", ph: { type: "body", idx: 6 }, noXfrm: true, text: "Inherited visible" }) +
          sp({ id: 5, name: "Orphan 4", ph: { type: "body", idx: 7 }, noXfrm: true, text: "Orphan" }),
      },
    ],
  });
}

/**
 * Hidden shapes in groups and on a layout:
 * - slide 1: visible group 2 { hidden child 3, visible child 4 };
 * - slide 1: hidden group 10 { visible child 11 } — only the group is reported;
 * - slide 1: group 20 entirely off-slide { child 21 } — only the group is reported as off-slide;
 * - layout "Title Slide" carries a hidden shape 9.
 */
export function hiddenGroupDeck(): Promise<Uint8Array> {
  const visibleGroup = grpSp({
    id: 2,
    name: "Group 1",
    x: IN,
    y: IN,
    cx: 4 * IN,
    cy: 2 * IN,
    children: [
      sp({ id: 3, name: "Hidden child", hidden: true, x: IN, y: IN, cx: IN, cy: IN, text: "secret" }),
      sp({ id: 4, name: "Visible child", x: 3 * IN, y: IN, cx: IN, cy: IN, text: "shown" }),
    ],
  });
  const hiddenGroup = grpSp({
    id: 10,
    name: "Hidden group",
    hidden: true,
    x: IN,
    y: 4 * IN,
    cx: 2 * IN,
    cy: IN,
    children: [sp({ id: 11, name: "Child of hidden", x: IN, y: 4 * IN, cx: IN, cy: IN, text: "x" })],
  });
  const offGroup = grpSp({
    id: 20,
    name: "Off group",
    x: 20 * IN,
    y: IN,
    cx: 2 * IN,
    cy: IN,
    children: [sp({ id: 21, name: "Off child", x: 20 * IN, y: IN, cx: IN, cy: IN, text: "y" })],
  });
  const [first, ...rest] = DEFAULT_LAYOUTS;
  return buildDeck({
    masters: [
      {
        layouts: [
          { ...first!, shapes: sp({ id: 9, name: "Layout hidden", hidden: true, x: IN, y: IN, cx: IN, cy: IN, text: "draft" }) },
          ...rest,
        ],
      },
    ],
    slides: [{ layout: "Blank", shapes: visibleGroup + hiddenGroup + offGroup }],
  });
}

/**
 * Placeholder emptiness edge cases (slide 1, layout "Title and Content"):
 * - 2: title with whitespace-only text → empty;
 * - 3: body with a field (slide number) → not empty;
 * - 4: body with a picture fill → not empty;
 * - 5: plain non-placeholder empty text box → not a placeholder, not reported.
 */
export function placeholderEdgeDeck(): Promise<Uint8Array> {
  return buildDeck({
    slides: [
      {
        layout: "Title and Content",
        shapes:
          sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "   " }) +
          sp({
            id: 3,
            name: "Content Placeholder 2",
            ph: { idx: 1 },
            noXfrm: true,
            paragraphs: `<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>1</a:t></a:fld></a:p>`,
          }) +
          sp({ id: 4, name: "Picture fill", ph: { type: "body", idx: 13 }, x: IN, y: IN, cx: IN, cy: IN, spPr: `<a:blipFill><a:blip r:embed="rIdX"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>` }) +
          sp({ id: 5, name: "TextBox 4", x: IN, y: 3 * IN, cx: IN, cy: IN }),
      },
    ],
  });
}

/**
 * Text settings: autofit modes (explicit and inherited) and alternate languages; a transition written
 * PowerPoint-2010-style inside mc:AlternateContent; a p:timing with real effects.
 * Slide 1:
 * - 2: spAutoFit (resize), lang en-GB
 * - 3: noAutofit, lang fr-FR with altLang ja-JP
 * - 4: body placeholder without bodyPr autofit → inherits normAutofit from the layout placeholder
 * - 5: plain text box, no autofit element → none
 */
export function textSettingsDeck(): Promise<Uint8Array> {
  const layoutShapes =
    sp({ id: 2, name: "Title 1", ph: { type: "title" }, noXfrm: true, text: "Title" }) +
    sp({ id: 3, name: "Content Placeholder 2", ph: { idx: 1 }, noXfrm: true, bodyPr: `<a:normAutofit/>`, text: "Body" });
  const timing =
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>` +
    `<p:par><p:cTn id="3" fill="hold"><p:childTnLst><p:par><p:cTn id="4" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="5" dur="500"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>` +
    `</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  const transition =
    `<mc:AlternateContent xmlns:mc="${NS.mc}"><mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:transition spd="slow" p14:dur="2000" advTm="3000"><p14:vortex dir="r"/></p:transition></mc:Choice>` +
    `<mc:Fallback><p:transition spd="slow" advTm="3000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
  return buildDeck({
    masters: [{ layouts: [{ name: "Title and Content", type: "obj", shapes: layoutShapes }, { name: "Blank", type: "blank" }] }],
    slides: [
      {
        layout: "Title and Content",
        tail: transition + timing,
        shapes:
          sp({ id: 2, name: "Resize", x: IN, y: IN, cx: 2 * IN, cy: IN, bodyPr: `<a:spAutoFit/>`, paragraphs: para(run("Colour", { attrs: `lang="en-GB"` })) }) +
          sp({
            id: 3,
            name: "Fixed",
            x: 4 * IN,
            y: IN,
            cx: 2 * IN,
            cy: IN,
            bodyPr: `<a:noAutofit/>`,
            paragraphs: para(run("Bonjour", { attrs: `lang="fr-FR" altLang="ja-JP"` }) + run(" encore", { attrs: `lang="fr-FR"` })),
          }) +
          sp({ id: 4, name: "Content Placeholder 2", ph: { idx: 1 }, noXfrm: true, text: "Inherits shrink" }) +
          sp({ id: 5, name: "Plain", x: IN, y: 4 * IN, cx: 2 * IN, cy: IN, text: "Plain" }),
      },
      { layout: "Blank", tail: `<p:transition/>` },
    ],
  });
}
