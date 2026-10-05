/**
 * Deck variants for the link checks (U9). The seeded `links` corpus deck covers the headline
 * scenarios; these generated decks cover occurrence keys, unsafe schemes, local paths, linked
 * media/images, and malformed references.
 */
import { buildDeck, graphicFrame, GRAPHIC_URI, grpSp, para, pic, run, sp, type DeckSpec } from "../helpers/buildDeck";
import { EMU_PER_INCH } from "../helpers/corpus";
import { pngBytes } from "../helpers/media";

const IN = EMU_PER_INCH;

/** A text run carrying `a:hlinkClick` (or `a:hlinkHover` when `hover`). */
export function linkRun(text: string, rid: string, opts: { action?: string; hover?: boolean } = {}): string {
  const tag = opts.hover ? "a:hlinkHover" : "a:hlinkClick";
  const action = opts.action ? ` action="${opts.action}"` : "";
  return run(text, { inner: `<${tag} r:id="${rid}"${action}/>` });
}

/**
 * Slide 1: the same URL twice in one text box (runs 0 and 2 of paragraph 0), a third time as a
 * hover link (not counted), a different URL on a shape's cNvPr, and a mailto link inside a group.
 * Slide 2: the same URL once more (occurrence restarts per slide).
 */
export const DUPLICATE_URL = "https://dup.example.com/page";

export function duplicateLinksSpec(): DeckSpec {
  return {
    slides: [
      {
        layout: "Blank",
        shapes:
          sp({
            id: 2,
            name: "Twice",
            x: IN,
            y: IN,
            cx: 6 * IN,
            cy: IN,
            paragraphs: para(linkRun("first", "rIdD1") + run(" and ") + linkRun("second", "rIdD2")) + para(linkRun("hover me", "rIdD3", { hover: true })),
          }) +
          sp({ id: 3, name: "Other", x: IN, y: 3 * IN, cx: 2 * IN, cy: IN, cNvPrInner: `<a:hlinkClick r:id="rIdO1"/>` }) +
          grpSp({
            id: 4,
            name: "Group",
            x: IN,
            y: 5 * IN,
            cx: 4 * IN,
            cy: IN,
            children: [sp({ id: 5, name: "Mail", x: IN, y: 5 * IN, cx: 2 * IN, cy: IN, paragraphs: para(linkRun("mail us", "rIdM1")) })],
          }),
        rels: [
          { id: "rIdD1", type: "hyperlink", target: DUPLICATE_URL, external: true },
          { id: "rIdD2", type: "hyperlink", target: DUPLICATE_URL, external: true },
          { id: "rIdD3", type: "hyperlink", target: DUPLICATE_URL, external: true },
          { id: "rIdO1", type: "hyperlink", target: "https://other.example.com/", external: true },
          { id: "rIdM1", type: "hyperlink", target: "mailto:team@example.com", external: true },
        ],
      },
      {
        layout: "Blank",
        shapes: sp({ id: 2, name: "Again", x: IN, y: IN, cx: 6 * IN, cy: IN, paragraphs: para(linkRun("again", "rIdA1")) }),
        rels: [{ id: "rIdA1", type: "hyperlink", target: DUPLICATE_URL, external: true }],
      },
    ],
  };
}

export const RISKY = {
  javascript: "javascript:alert(document.cookie)",
  vbscript: "VBScript:MsgBox(1)",
  data: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  obfuscatedJs: "  java\tscript:alert(1)",
  unc: "\\\\fileserver\\share\\deck.pptx",
  drive: "D:\\Projects\\notes.docx",
  relative: "../reports/q3.xlsx",
  fileUrl: "file:///C:/Users/bob/plan.pdf",
  linkedImage: "https://images.example.com/logo.png",
  linkedVideo: "\\\\media01\\videos\\intro.mp4",
  linkedBackground: "C:\\Images\\bg.jpg",
} as const;

/**
 * Slide 1: one text box with javascript:, vbscript:, data:, obfuscated javascript:, a UNC path,
 * a drive path, a relative path, and a file: URL, one paragraph each.
 * Slide 2: a linked (not embedded) picture, a picture with a linked video, a table cell link,
 * an internal `hlinkshowjump`, a `ppaction://hlinkfile` link, a dangling r:id, and a background
 * image linked to a local path (outside the shape tree).
 */
export function riskyLinksSpec(): DeckSpec {
  const order = ["javascript", "vbscript", "data", "obfuscatedJs", "unc", "drive", "relative", "fileUrl"] as const;
  const tbl =
    `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="914400"/><a:gridCol w="914400"/></a:tblGrid>` +
    `<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>` +
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>` +
    `<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>C</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>` +
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${linkRun("D", "rIdT1")}</a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>`;
  return {
    media: { "image1.png": pngBytes(8, 8) },
    slides: [
      {
        layout: "Blank",
        shapes: sp({
          id: 2,
          name: "Risky",
          x: IN,
          y: IN,
          cx: 6 * IN,
          cy: 4 * IN,
          paragraphs: order.map((k, i) => para(linkRun(k, `rIdR${i}`))).join(""),
        }),
        rels: order.map((k, i) => ({ id: `rIdR${i}`, type: "hyperlink", target: RISKY[k], external: true })),
      },
      {
        layout: "Blank",
        shapes:
          `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Linked Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:link="rIdImgL"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
          `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Intro Video"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rIdVid"/></p:nvPr></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="rIdPoster"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="914400" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
          graphicFrame({ id: 4, name: "Table", x: IN, y: 2 * IN, cx: 2 * IN, cy: IN, uri: GRAPHIC_URI.table, data: tbl }) +
          sp({
            id: 5,
            name: "Misc",
            x: IN,
            y: 4 * IN,
            cx: 4 * IN,
            cy: IN,
            paragraphs: para(
              linkRun("show", "rIdShow", { action: "ppaction://hlinkshowjump?jump=nextslide" }) +
                linkRun("file", "rIdFile", { action: "ppaction://hlinkfile" }) +
                linkRun("dangling", "rIdMissing") +
                linkRun("empty", "", { action: "ppaction://hlinkshowjump?jump=firstslide" }),
            ),
          }) +
          pic({ id: 6, name: "Embedded", embed: "rIdPoster", x: 0, y: 5 * IN, cx: IN, cy: IN }),
        rels: [
          { id: "rIdImgL", type: "image", target: RISKY.linkedImage, external: true },
          { id: "rIdVid", type: "video", target: RISKY.linkedVideo, external: true },
          { id: "rIdPoster", type: "image", target: "../media/image1.png" },
          { id: "rIdT1", type: "hyperlink", target: "https://table.example.com/", external: true },
          { id: "rIdShow", type: "hyperlink", target: "https://should-not-appear.example.com/", external: true },
          { id: "rIdFile", type: "hyperlink", target: "file:///C:/Shared/handout.pdf", external: true },
          { id: "rIdBg", type: "image", target: RISKY.linkedBackground, external: true },
        ],
      },
    ],
  };
}

/** The background link sits outside the shape tree: inject a `p:bg` into slide 2. */
export const BACKGROUND_XML = `<p:bg><p:bgPr><a:blipFill><a:blip r:link="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;

export const duplicateLinksDeck = (): Promise<Uint8Array> => buildDeck(duplicateLinksSpec());
export const riskyLinksDeck = (): Promise<Uint8Array> => buildDeck(riskyLinksSpec());
