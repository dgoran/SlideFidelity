/**
 * Deck variants for the media & size checks (U7), built on the shared fixture helpers.
 */
import { NS, buildDeck, grpSp, pic, slidePart, sp } from "../helpers/buildDeck";
import { corpusDeck } from "../helpers/corpus";
import { jpegBytes, noiseBytes, pngBytes } from "../helpers/media";
import { mutateDeck } from "../helpers/mutateDeck";

export const IN = 914400;
export const HDPHOTO_REL = "http://schemas.microsoft.com/office/2007/relationships/hdphoto";

export function mediaBloatDeck(): Promise<Uint8Array> {
  return corpusDeck("media-bloat");
}

export function cleanDeck(): Promise<Uint8Array> {
  return corpusDeck("clean");
}

/**
 * Two 1000×500 PNGs displayed at 2×1 in: one uncropped (500 PPI), one with the left half cropped
 * away and the frame shape kept at 2:1 aspect by showing half the height too (250 PPI).
 */
export function cropPpiDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "image1.png": pngBytes(1000, 500, 500, 31), "image2.png": pngBytes(1000, 500, 500, 32) },
    slides: [
      {
        layout: "Blank",
        shapes:
          pic({ id: 2, name: "Full", embed: "rIdA", x: IN, y: IN, cx: 2 * IN, cy: IN }) +
          pic({ id: 3, name: "Cropped", embed: "rIdB", x: 4 * IN, y: IN, cx: 2 * IN, cy: IN, srcRect: `l="50000" b="50000"` }),
        rels: [
          { id: "rIdA", type: "image", target: "../media/image1.png" },
          { id: "rIdB", type: "image", target: "../media/image2.png" },
        ],
      },
    ],
  });
}

/** A rectangle with a picture fill (100×100 PNG stretched over 4×4 in → 25 PPI, too small). */
export function pictureFillDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "image1.png": pngBytes(100, 100, 300, 33) },
    slides: [
      {
        layout: "Blank",
        shapes: sp({
          id: 2,
          name: "Filled rect",
          x: IN,
          y: IN,
          cx: 4 * IN,
          cy: 4 * IN,
          noTxBody: true,
          spPr: `<a:blipFill><a:blip r:embed="rIdFill"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`,
        }),
        rels: [{ id: "rIdFill", type: "image", target: "../media/image1.png" }],
      },
    ],
  });
}

/** Slide 1 has a picture background (640×360 over a 13.33×7.5 in slide → 48 PPI). */
export async function backgroundDeck(): Promise<Uint8Array> {
  const bytes = await buildDeck({
    media: { "image1.png": pngBytes(640, 360, 300, 34) },
    slides: [{ layout: "Blank", rels: [{ id: "rIdBg", type: "image", target: "../media/image1.png" }] }, { layout: "Blank" }],
  });
  return mutateDeck(bytes, (m) =>
    m.editXml(slidePart(1), (xml) =>
      xml.replace(
        "<p:cSld>",
        `<p:cSld><p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdBg"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`,
      ),
    ),
  );
}

/** A picture with an artistic effect: rendered PNG + HD Photo (WDP) original companion. */
export function hdphotoDeck(): Promise<Uint8Array> {
  const wdp = new Uint8Array([0x49, 0x49, 0xbc, 0x01, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return buildDeck({
    media: { "image1.png": pngBytes(600, 400, 400, 35), "hdphoto1.wdp": wdp },
    slides: [
      {
        layout: "Blank",
        shapes: pic({
          id: 2,
          name: "Artistic",
          embed: "rIdImg",
          x: IN,
          y: IN,
          cx: 3 * IN,
          cy: 2 * IN,
          blipInner: `<a:extLst><a:ext uri="{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}"><a14:imgProps xmlns:a14="${NS.a14}"><a14:imgLayer r:embed="rIdWdp"/></a14:imgProps></a:ext></a:extLst>`,
        }),
        rels: [
          { id: "rIdImg", type: "image", target: "../media/image1.png" },
          { id: "rIdWdp", type: HDPHOTO_REL, target: "../media/hdphoto1.wdp" },
        ],
      },
    ],
  });
}

/**
 * Low-compression candidates: a photo-like RGBA PNG (600×600, ~450 KB ≈ 1.25 B/px) and a very
 * high-quality JPEG (1000×1000, 700 KB = 0.7 B/px), plus a well-compressed JPEG control.
 * All are displayed at sane PPI so no other flags fire.
 */
export function lowCompressionDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: {
      "image1.png": pngBytes(600, 600, 450_000, 36),
      "image2.jpeg": jpegBytes(1000, 1000, 700_000, 37),
      "image3.jpeg": jpegBytes(1000, 1000, 150_000, 38),
    },
    slides: [
      {
        layout: "Blank",
        shapes:
          pic({ id: 2, name: "Photo PNG", embed: "rIdP", x: 0, y: 0, cx: 3 * IN, cy: 3 * IN }) +
          pic({ id: 3, name: "Heavy JPEG", embed: "rIdJ", x: 4 * IN, y: 0, cx: 4 * IN, cy: 4 * IN }) +
          pic({ id: 4, name: "Normal JPEG", embed: "rIdK", x: 8 * IN, y: 0, cx: 4 * IN, cy: 4 * IN }),
        rels: [
          { id: "rIdP", type: "image", target: "../media/image1.png" },
          { id: "rIdJ", type: "image", target: "../media/image2.jpeg" },
          { id: "rIdK", type: "image", target: "../media/image3.jpeg" },
        ],
      },
    ],
  });
}

/** A 400×400 PNG in a group whose child space is 2× its extent: 4 in on the group → 2 in shown. */
export function groupScaledDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "image1.png": pngBytes(400, 400, 300, 39) },
    slides: [
      {
        layout: "Blank",
        shapes: grpSp({
          id: 2,
          name: "Group",
          x: IN,
          y: IN,
          cx: 2 * IN,
          cy: 2 * IN,
          chX: 0,
          chY: 0,
          chCx: 4 * IN,
          chCy: 4 * IN,
          children: [pic({ id: 3, name: "Grouped", embed: "rIdG", x: 0, y: 0, cx: 4 * IN, cy: 4 * IN })],
        }),
        rels: [{ id: "rIdG", type: "image", target: "../media/image1.png" }],
      },
    ],
  });
}

/**
 * A picture placeholder without its own xfrm: its size comes from the layout (no xfrm either)
 * and then the master's body placeholder (10515600×4351338 EMU).
 */
export async function inheritedPlaceholderDeck(): Promise<Uint8Array> {
  const bytes = await buildDeck({
    media: { "image1.png": pngBytes(200, 100, 300, 40) },
    slides: [
      {
        layout: "Title and Content",
        shapes: pic({ id: 4, name: "Picture Placeholder", ph: { idx: 1 }, embed: "rIdPh", x: 0, y: 0, cx: 1, cy: 1 }),
        rels: [{ id: "rIdPh", type: "image", target: "../media/image1.png" }],
      },
    ],
  });
  return mutateDeck(bytes, (m) =>
    m.editXml(slidePart(1), (xml) => xml.replace(/<a:xfrm><a:off x="0" y="0"\/><a:ext cx="1" cy="1"\/><\/a:xfrm>/, "")),
  );
}

/** An unknown-format blob used as a picture, plus an embedded font and a non-media binary. */
export function unknownAndFontsDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "image1.xyz": noiseBytes(3_000, 41) },
    embeddedFonts: [{ typeface: "Calibri", styles: ["regular", "bold"] }],
    slides: [
      {
        layout: "Blank",
        shapes: pic({ id: 2, name: "Mystery", embed: "rIdU", x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, srcRect: `t="20000"` }),
        rels: [{ id: "rIdU", type: "image", target: "../media/image1.xyz" }],
      },
    ],
    parts: [{ path: "docProps/thumbnail.jpeg", content: jpegBytes(256, 144, 4_000, 42), contentType: "image/jpeg" }],
  });
}

/** Two pictures of the same part: one crops, one shows it whole — the crop is not "retained". */
export function partialCropSharedDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "image1.png": pngBytes(800, 600, 400, 43) },
    slides: [
      {
        layout: "Blank",
        shapes: pic({ id: 2, name: "Whole", embed: "rIdS", x: IN, y: IN, cx: 4 * IN, cy: 3 * IN }),
        rels: [{ id: "rIdS", type: "image", target: "../media/image1.png" }],
      },
      {
        layout: "Blank",
        shapes: pic({ id: 2, name: "Cropped", embed: "rIdS", x: IN, y: IN, cx: 2 * IN, cy: 3 * IN, srcRect: `r="50000"` }),
        rels: [{ id: "rIdS", type: "image", target: "../media/image1.png" }],
      },
    ],
  });
}
