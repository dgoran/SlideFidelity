/**
 * Deterministic PresentationML fixture builder (KTD10 deviation).
 *
 * KTD10 asks for hand-authored decks saved from PowerPoint. PowerPoint is not
 * available in this environment, so the corpus is generated: this builder
 * emits a minimal but valid package (content types, package + part rels,
 * presentation.xml, masters, layouts, slides, themes, docProps, presProps,
 * notes, comments) whose XML mirrors what PowerPoint 365 writes. Same spec →
 * byte-identical output (fixed ZIP dates, fixed ids). Replace or supplement
 * with real PowerPoint saves when available.
 */
import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Namespaces and relationship types

export const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  p14: "http://schemas.microsoft.com/office/powerpoint/2010/main",
  p188: "http://schemas.microsoft.com/office/powerpoint/2018/8/main",
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
  asvg: "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  dgm: "http://schemas.openxmlformats.org/drawingml/2006/diagram",
  dsp: "http://schemas.microsoft.com/office/drawing/2008/diagram",
} as const;

const ROOT_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" xmlns:p14="${NS.p14}" xmlns:a14="${NS.a14}" xmlns:asvg="${NS.asvg}" xmlns:mc="${NS.mc}"`;

const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const SPECIAL_REL_TYPES: Record<string, string> = {
  "core-properties": "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  "modern-comments": "http://schemas.microsoft.com/office/2018/10/relationships/comments",
  authors: "http://schemas.microsoft.com/office/2018/10/relationships/authors",
  media: "http://schemas.microsoft.com/office/2007/relationships/media",
  hdphoto: "http://schemas.microsoft.com/office/2007/relationships/hdphoto",
  diagramDrawing: "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
};

/** Full relationship type URI from a short name (`slideLayout`, `hyperlink`, …) or a URI. */
export function relTypeUri(type: string): string {
  if (type.includes("://")) return type;
  return SPECIAL_REL_TYPES[type] ?? REL_BASE + type;
}

const CT = {
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  notes: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
  notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
  presProps: "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  custom: "application/vnd.openxmlformats-officedocument.custom-properties+xml",
  comments: "application/vnd.openxmlformats-officedocument.presentationml.comments+xml",
  commentAuthors: "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml",
  modernComments: "application/vnd.ms-powerpoint.comments+xml",
  authors: "application/vnd.ms-powerpoint.authors+xml",
} as const;

const DEFAULT_EXT_TYPES: Record<string, string> = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  xml: "application/xml",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  wdp: "image/vnd.ms-photo",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  fntdata: "application/x-fontdata",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  bin: "application/vnd.openxmlformats-officedocument.oleObject",
};

// ---------------------------------------------------------------------------
// Spec types

export interface RelSpec {
  id: string;
  /** Short name (`hyperlink`, `image`, `chart`, `oleObject`…) or full URI. */
  type: string;
  /** Relative to the source part, or an absolute URL for external targets. */
  target: string;
  external?: boolean;
}

export interface ThemeSpec {
  name?: string;
  /** Slot → RRGGBB overrides of the Office 2013–2022 palette. */
  colors?: Partial<Record<ThemeSlot, string>>;
  majorLatin?: string;
  minorLatin?: string;
  majorEa?: string;
  minorEa?: string;
  majorCs?: string;
  minorCs?: string;
}

export type ThemeSlot =
  | "dk1"
  | "lt1"
  | "dk2"
  | "lt2"
  | "accent1"
  | "accent2"
  | "accent3"
  | "accent4"
  | "accent5"
  | "accent6"
  | "hlink"
  | "folHlink";

export interface LayoutSpec {
  name: string;
  /** `p:sldLayout/@type`; omitted means custom. */
  type?: string;
  preserve?: boolean;
  /** Raw `p:spTree` children. */
  shapes?: string;
  rels?: RelSpec[];
}

export interface MasterSpec {
  preserve?: boolean;
  theme?: ThemeSpec;
  layouts: LayoutSpec[];
  shapes?: string;
  rels?: RelSpec[];
  /** Raw `p:txStyles` inner XML; a minimal default is used otherwise. */
  txStyles?: string;
}

export interface LegacyCommentSpec {
  authorId: number;
  text: string;
  dt?: string;
}

export interface ModernCommentSpec {
  id: string;
  authorId: string;
  text: string;
  created?: string;
  replies?: { id: string; authorId: string; text: string; created?: string }[];
}

export interface SlideSpec {
  /** Layout by name (first match across masters) or by indices. Default: master 0, layout 0. */
  layout?: string | { master: number; layout: number };
  hidden?: boolean;
  name?: string;
  shapes?: string;
  /** Notes body text; paragraphs split on "\n". */
  notes?: string;
  rels?: RelSpec[];
  legacyComments?: LegacyCommentSpec[];
  modernComments?: ModernCommentSpec[];
  /** Raw XML appended after `p:clrMapOvr` (e.g. `p:transition`, `p:timing`). */
  tail?: string;
}

export interface SectionSpec {
  name: string;
  /** 0-based slide indices. */
  slides: number[];
}

export interface ExtraPart {
  /** ZIP path, no leading slash. */
  path: string;
  content: string | Uint8Array;
  /** Override content type; omit to rely on the extension default. */
  contentType?: string;
  rels?: RelSpec[];
}

export interface DeckSpec {
  slideSize?: { cx: number; cy: number; type?: string };
  masters?: MasterSpec[];
  slides?: SlideSpec[];
  sections?: SectionSpec[];
  /** `false` omits presProps.xml entirely. */
  presProps?: false | { recentColors?: string[] };
  /** Core properties by qualified name (`dc:creator`, `cp:lastModifiedBy`, …). */
  core?: Record<string, string>;
  /** Extended (app.xml) properties by element name (`Company`, `Manager`, …). */
  app?: Record<string, string>;
  /** Custom string properties. `undefined` → no custom.xml. */
  custom?: Record<string, string>;
  embeddedFonts?: { typeface: string; styles: ("regular" | "bold" | "italic" | "boldItalic")[] }[];
  saveSubsetFonts?: boolean;
  /** Files placed under `ppt/media/`. */
  media?: Record<string, Uint8Array>;
  parts?: ExtraPart[];
  /** Legacy comment authors (`ppt/commentAuthors.xml`). */
  commentAuthors?: { id: number; name: string }[];
  /** Modern comment authors (`ppt/authors.xml`). */
  authors?: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// XML snippets

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

export const OFFICE_THEME_COLORS: Record<ThemeSlot, string> = {
  dk1: "000000",
  lt1: "FFFFFF",
  dk2: "44546A",
  lt2: "E7E6E6",
  accent1: "4472C4",
  accent2: "ED7D31",
  accent3: "A5A5A5",
  accent4: "FFC000",
  accent5: "5B9BD5",
  accent6: "70AD47",
  hlink: "0563C1",
  folHlink: "954F72",
};

export interface XfrmSpec {
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
}

function xfrmXml(tag: string, s: XfrmSpec, extra = ""): string {
  return `<${tag}><a:off x="${s.x ?? 0}" y="${s.y ?? 0}"/><a:ext cx="${s.cx ?? 914400}" cy="${s.cy ?? 914400}"/>${extra}</${tag}>`;
}

export interface PhSpec {
  type?: string;
  idx?: number;
}

function phXml(ph: PhSpec | undefined): string {
  if (!ph) return "<p:nvPr/>";
  const t = ph.type !== undefined ? ` type="${ph.type}"` : "";
  const i = ph.idx !== undefined ? ` idx="${ph.idx}"` : "";
  return `<p:nvPr><p:ph${t}${i}/></p:nvPr>`;
}

function cNvPr(id: number, name: string, opts: { hidden?: boolean; descr?: string; inner?: string }): string {
  const hidden = opts.hidden ? ` hidden="1"` : "";
  const descr = opts.descr !== undefined ? ` descr="${esc(opts.descr)}"` : "";
  return `<p:cNvPr id="${id}" name="${esc(name)}"${descr}${hidden}>${opts.inner ?? ""}</p:cNvPr>`;
}

/** A text run with optional raw `a:rPr` attributes and children. */
export function run(text: string, rPr: { attrs?: string; inner?: string } = {}): string {
  const attrs = rPr.attrs ?? `lang="en-US"`;
  const props = rPr.inner ? `<a:rPr ${attrs}>${rPr.inner}</a:rPr>` : `<a:rPr ${attrs} dirty="0"/>`;
  return `<a:r>${props}<a:t>${esc(text)}</a:t></a:r>`;
}

export function para(inner: string, pPr = ""): string {
  return `<a:p>${pPr}${inner}</a:p>`;
}

export interface SpSpec extends XfrmSpec {
  id: number;
  name: string;
  hidden?: boolean;
  descr?: string;
  ph?: PhSpec;
  /** Plain text → one paragraph per line. */
  text?: string;
  /** Raw paragraphs (`a:p` elements); wins over `text`. */
  paragraphs?: string;
  /** Raw `a:lstStyle` inner XML. */
  lstStyle?: string;
  /** Raw `a:bodyPr` inner XML (e.g. `<a:normAutofit/>`). */
  bodyPr?: string;
  /** Raw fill / line XML placed in `p:spPr` after the geometry. */
  spPr?: string;
  /** Omit `a:xfrm` (placeholders inheriting position). */
  noXfrm?: boolean;
  /** Omit `p:txBody`. */
  noTxBody?: boolean;
  /** Raw `a:hlinkClick`/`a:hlinkHover` inside cNvPr. */
  cNvPrInner?: string;
}

export function sp(s: SpSpec): string {
  const geom = s.ph ? "" : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  const xfrm = s.noXfrm ? "" : xfrmXml("a:xfrm", s);
  const paragraphs =
    s.paragraphs ??
    (s.text !== undefined ? s.text.split("\n").map((l) => para(run(l))).join("") : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`);
  const tx = s.noTxBody
    ? ""
    : `<p:txBody><a:bodyPr${s.bodyPr ? `>${s.bodyPr}</a:bodyPr>` : "/>"}<a:lstStyle${s.lstStyle ? `>${s.lstStyle}</a:lstStyle>` : "/>"}${paragraphs}</p:txBody>`;
  return (
    `<p:sp><p:nvSpPr>${cNvPr(s.id, s.name, { ...(s.hidden !== undefined ? { hidden: s.hidden } : {}), ...(s.descr !== undefined ? { descr: s.descr } : {}), ...(s.cNvPrInner !== undefined ? { inner: s.cNvPrInner } : {}) })}` +
    `<p:cNvSpPr${s.ph ? `><a:spLocks noGrp="1"/></p:cNvSpPr>` : "/>"}${phXml(s.ph)}</p:nvSpPr>` +
    `<p:spPr>${xfrm}${geom}${s.spPr ?? ""}</p:spPr>${tx}</p:sp>`
  );
}

export interface PicSpec extends XfrmSpec {
  id: number;
  name: string;
  /** Relationship id of the image. */
  embed: string;
  hidden?: boolean;
  descr?: string;
  ph?: PhSpec;
  /** `a:srcRect` attributes, e.g. `l="10000" r="5000"`. */
  srcRect?: string;
  /** Raw `a:blip` children (e.g. an `a:extLst` with `asvg:svgBlip`). */
  blipInner?: string;
}

export function pic(s: PicSpec): string {
  const blip = s.blipInner ? `<a:blip r:embed="${s.embed}">${s.blipInner}</a:blip>` : `<a:blip r:embed="${s.embed}"/>`;
  const src = s.srcRect !== undefined ? `<a:srcRect ${s.srcRect}/>` : "";
  return (
    `<p:pic><p:nvPicPr>${cNvPr(s.id, s.name, { ...(s.hidden !== undefined ? { hidden: s.hidden } : {}), ...(s.descr !== undefined ? { descr: s.descr } : {}) })}` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${phXml(s.ph)}</p:nvPicPr>` +
    `<p:blipFill>${blip}${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrmXml("a:xfrm", s)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

export interface GrpSpSpec extends XfrmSpec {
  id: number;
  name: string;
  hidden?: boolean;
  /** Child space; defaults to the group's own off/ext (scale 1). */
  chX?: number;
  chY?: number;
  chCx?: number;
  chCy?: number;
  children: string[];
}

export function grpSp(s: GrpSpSpec): string {
  const ch = `<a:chOff x="${s.chX ?? s.x ?? 0}" y="${s.chY ?? s.y ?? 0}"/><a:chExt cx="${s.chCx ?? s.cx ?? 914400}" cy="${s.chCy ?? s.cy ?? 914400}"/>`;
  return (
    `<p:grpSp><p:nvGrpSpPr>${cNvPr(s.id, s.name, s.hidden !== undefined ? { hidden: s.hidden } : {})}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr>${xfrmXml("a:xfrm", s, ch)}</p:grpSpPr>${s.children.join("")}</p:grpSp>`
  );
}

export interface GraphicFrameSpec extends XfrmSpec {
  id: number;
  name: string;
  hidden?: boolean;
  uri: string;
  /** Raw `a:graphicData` children. */
  data: string;
}

export function graphicFrame(s: GraphicFrameSpec): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr>${cNvPr(s.id, s.name, s.hidden !== undefined ? { hidden: s.hidden } : {})}<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrmXml("p:xfrm", s)}<a:graphic><a:graphicData uri="${esc(s.uri)}">${s.data}</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

export const GRAPHIC_URI = {
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  diagram: "http://schemas.openxmlformats.org/drawingml/2006/diagram",
  table: "http://schemas.openxmlformats.org/drawingml/2006/table",
  ole: "http://schemas.openxmlformats.org/presentationml/2006/ole",
} as const;

function spTree(shapes: string): string {
  return (
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes}</p:spTree>`
  );
}

function relsXml(rels: readonly RelSpec[]): string {
  return (
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels
      .map(
        (r) =>
          `<Relationship Id="${esc(r.id)}" Type="${esc(relTypeUri(r.type))}" Target="${esc(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`,
      )
      .join("") +
    `</Relationships>`
  );
}

function themeXml(spec: ThemeSpec | undefined, index: number): string {
  const colors = { ...OFFICE_THEME_COLORS, ...(spec?.colors ?? {}) };
  const slot = (s: ThemeSlot): string => {
    const v = colors[s];
    if (s === "dk1" && v === "000000") return `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>`;
    if (s === "lt1" && v === "FFFFFF") return `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>`;
    return `<a:${s}><a:srgbClr val="${v}"/></a:${s}>`;
  };
  const slots: ThemeSlot[] = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const font = (tag: string, latin: string, ea: string, cs: string, extra: string): string =>
    `<a:${tag}><a:latin typeface="${esc(latin)}" panose="020F0302020204030204"/><a:ea typeface="${esc(ea)}"/><a:cs typeface="${esc(cs)}"/>${extra}</a:${tag}>`;
  return (
    XML_DECL +
    `<a:theme xmlns:a="${NS.a}" name="${esc(spec?.name ?? `Office Theme ${index}`)}"><a:themeElements>` +
    `<a:clrScheme name="Office">${slots.map(slot).join("")}</a:clrScheme>` +
    `<a:fontScheme name="Office">` +
    font("majorFont", spec?.majorLatin ?? "Calibri Light", spec?.majorEa ?? "", spec?.majorCs ?? "", `<a:font script="Jpan" typeface="游ゴシック Light"/>`) +
    font("minorFont", spec?.minorLatin ?? "Calibri", spec?.minorEa ?? "", spec?.minorCs ?? "", `<a:font script="Jpan" typeface="游ゴシック"/>`) +
    `</a:fontScheme>` +
    `<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
}

const DEFAULT_TX_STYLES =
  `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial" panose="020B0604020202020204"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>`;

const CLR_MAP = `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;

function defaultMasterShapes(): string {
  return (
    sp({ id: 2, name: "Title Placeholder 1", ph: { type: "title" }, x: 838200, y: 365125, cx: 10515600, cy: 1325563, text: "Click to edit Master title style" }) +
    sp({ id: 3, name: "Text Placeholder 2", ph: { type: "body", idx: 1 }, x: 838200, y: 1825625, cx: 10515600, cy: 4351338, text: "Click to edit Master text styles" })
  );
}

function defaultLayoutShapes(type: string | undefined): string {
  if (type === "blank") return "";
  const title = sp({ id: 2, name: "Title 1", ph: { type: type === "title" ? "ctrTitle" : "title" }, noXfrm: true, text: "Click to edit Master title style" });
  if (type === "title") {
    return title + sp({ id: 3, name: "Subtitle 2", ph: { type: "subTitle", idx: 1 }, noXfrm: true, text: "Click to edit Master subtitle style" });
  }
  return title + sp({ id: 3, name: "Content Placeholder 2", ph: { idx: 1 }, noXfrm: true, text: "Click to edit Master text styles" });
}

export const DEFAULT_LAYOUTS: LayoutSpec[] = [
  { name: "Title Slide", type: "title" },
  { name: "Title and Content", type: "obj" },
  { name: "Blank", type: "blank" },
];

const FIXED_DATE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

// ---------------------------------------------------------------------------
// Builder

class ZipWriter {
  readonly zip = new JSZip();
  readonly overrides = new Map<string, string>();
  readonly extensions = new Set<string>(["rels", "xml"]);

  add(path: string, content: string | Uint8Array, contentType?: string): void {
    this.zip.file(path, content, { date: FIXED_DATE, createFolders: false });
    if (contentType) this.overrides.set(path, contentType);
    const dot = path.lastIndexOf(".");
    if (dot >= 0) this.extensions.add(path.slice(dot + 1).toLowerCase());
  }

  rels(sourcePart: string, rels: readonly RelSpec[]): void {
    if (rels.length === 0) return;
    const slash = sourcePart.lastIndexOf("/");
    const path = `${sourcePart.slice(0, slash + 1)}_rels/${sourcePart.slice(slash + 1)}.rels`;
    this.zip.file(path, relsXml(rels), { date: FIXED_DATE, createFolders: false });
  }

  async finish(): Promise<Uint8Array> {
    const defaults = [...this.extensions]
      .sort()
      .map((e) => `<Default Extension="${e}" ContentType="${DEFAULT_EXT_TYPES[e] ?? "application/octet-stream"}"/>`)
      .join("");
    const overrides = [...this.overrides.entries()]
      .map(([p, ct]) => `<Override PartName="/${p}" ContentType="${ct}"/>`)
      .join("");
    this.zip.file(
      "[Content_Types].xml",
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`,
      { date: FIXED_DATE, createFolders: false },
    );
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }
}

/** Part names the builder assigns, for tests that need to address parts. */
export function slidePart(n: number): string {
  return `ppt/slides/slide${n}.xml`;
}
export function layoutPart(n: number): string {
  return `ppt/slideLayouts/slideLayout${n}.xml`;
}
export function masterPart(n: number): string {
  return `ppt/slideMasters/slideMaster${n}.xml`;
}

function sectionGuid(i: number): string {
  return `{00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}}`;
}

/** Builds a `.pptx` from a spec. Deterministic: same spec → same bytes. */
export async function buildDeck(spec: DeckSpec = {}): Promise<Uint8Array> {
  const w = new ZipWriter();
  const masters = spec.masters ?? [{ layouts: DEFAULT_LAYOUTS }];
  const slides = spec.slides ?? [{}];
  const size = spec.slideSize ?? { cx: 12192000, cy: 6858000, type: undefined };

  // ---- masters, layouts, themes ----
  let idCounter = 2147483648;
  let layoutNo = 0;
  const layoutIndex: { master: number; layout: number; partNo: number; name: string }[] = [];
  const masterIds: number[] = [];
  const presRels: RelSpec[] = [];
  let relNo = 1;
  const nextPresRel = (): string => `rId${relNo++}`;
  const masterRelIds: string[] = [];

  masters.forEach((m, mi) => {
    const mNo = mi + 1;
    const masterId = idCounter++;
    masterIds.push(masterId);
    const mRels: RelSpec[] = [];
    const layoutIdEls: string[] = [];
    m.layouts.forEach((l, li) => {
      layoutNo++;
      const lid = idCounter++;
      const rid = `rId${li + 1}`;
      mRels.push({ id: rid, type: "slideLayout", target: `../slideLayouts/slideLayout${layoutNo}.xml` });
      layoutIdEls.push(`<p:sldLayoutId id="${lid}" r:id="${rid}"/>`);
      layoutIndex.push({ master: mi, layout: li, partNo: layoutNo, name: l.name });
      const lPath = layoutPart(layoutNo);
      const typeAttr = l.type !== undefined ? ` type="${l.type}"` : "";
      const preserveAttr = l.preserve ? ` preserve="1"` : "";
      w.add(
        lPath,
        `${XML_DECL}<p:sldLayout ${ROOT_NS}${typeAttr}${preserveAttr}><p:cSld name="${esc(l.name)}">${spTree(l.shapes ?? defaultLayoutShapes(l.type))}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
        CT.layout,
      );
      w.rels(lPath, [{ id: "rId1", type: "slideMaster", target: `../slideMasters/slideMaster${mNo}.xml` }, ...(l.rels ?? [])]);
    });
    const themeRid = `rId${m.layouts.length + 1}`;
    mRels.push({ id: themeRid, type: "theme", target: `../theme/theme${mNo}.xml` });
    mRels.push(...(m.rels ?? []));
    const mPath = masterPart(mNo);
    w.add(
      mPath,
      `${XML_DECL}<p:sldMaster ${ROOT_NS}${m.preserve ? ` preserve="1"` : ""}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${spTree(m.shapes ?? defaultMasterShapes())}</p:cSld>${CLR_MAP}<p:sldLayoutIdLst>${layoutIdEls.join("")}</p:sldLayoutIdLst><p:txStyles>${m.txStyles ?? DEFAULT_TX_STYLES}</p:txStyles></p:sldMaster>`,
      CT.master,
    );
    w.rels(mPath, mRels);
    w.add(`ppt/theme/theme${mNo}.xml`, themeXml(m.theme, mNo), CT.theme);
    const rid = nextPresRel();
    masterRelIds.push(rid);
    presRels.push({ id: rid, type: "slideMaster", target: `slideMasters/slideMaster${mNo}.xml` });
  });

  const findLayout = (ref: SlideSpec["layout"]): number => {
    if (ref === undefined) return layoutIndex[0]?.partNo ?? 1;
    if (typeof ref === "string") {
      const hit = layoutIndex.find((l) => l.name === ref);
      if (!hit) throw new Error(`buildDeck: no layout named ${ref}`);
      return hit.partNo;
    }
    const hit = layoutIndex.find((l) => l.master === ref.master && l.layout === ref.layout);
    if (!hit) throw new Error(`buildDeck: no layout ${ref.master}/${ref.layout}`);
    return hit.partNo;
  };

  // ---- notes master (only when notes exist) ----
  const hasNotes = slides.some((s) => s.notes !== undefined);
  let notesMasterRid: string | undefined;
  if (hasNotes) {
    const themeNo = masters.length + 1;
    w.add(`ppt/theme/theme${themeNo}.xml`, themeXml({ name: "Notes Theme" }, themeNo), CT.theme);
    w.add(
      "ppt/notesMasters/notesMaster1.xml",
      `${XML_DECL}<p:notesMaster ${ROOT_NS}><p:cSld>${spTree(sp({ id: 2, name: "Notes Placeholder 1", ph: { type: "body", idx: 1 }, x: 685800, y: 4400550, cx: 5486400, cy: 3600450, text: "Click to edit Master text styles" }))}</p:cSld>${CLR_MAP}</p:notesMaster>`,
      CT.notesMaster,
    );
    w.rels("ppt/notesMasters/notesMaster1.xml", [{ id: "rId1", type: "theme", target: `../theme/theme${themeNo}.xml` }]);
    notesMasterRid = nextPresRel();
    presRels.push({ id: notesMasterRid, type: "notesMaster", target: "notesMasters/notesMaster1.xml" });
  }

  // ---- slides ----
  const slideIdEls: string[] = [];
  let legacyCommentNo = 0;
  let modernCommentNo = 0;
  let notesNo = 0;
  slides.forEach((s, si) => {
    const n = si + 1;
    const path = slidePart(n);
    const rels: RelSpec[] = [{ id: "rIdLayout", type: "slideLayout", target: `../slideLayouts/slideLayout${findLayout(s.layout)}.xml` }];
    if (s.notes !== undefined) {
      notesNo++;
      const nPath = `ppt/notesSlides/notesSlide${notesNo}.xml`;
      rels.push({ id: "rIdNotes", type: "notesSlide", target: `../notesSlides/notesSlide${notesNo}.xml` });
      const body = s.notes === "" ? `<a:p><a:endParaRPr lang="en-US"/></a:p>` : s.notes.split("\n").map((l) => para(run(l))).join("");
      w.add(
        nPath,
        `${XML_DECL}<p:notes ${ROOT_NS}><p:cSld>${spTree(
          sp({ id: 2, name: "Slide Image Placeholder 1", ph: { type: "sldImg" }, noXfrm: true, noTxBody: true }) +
            sp({ id: 3, name: "Notes Placeholder 2", ph: { type: "body", idx: 1 }, noXfrm: true, paragraphs: body }) +
            sp({ id: 4, name: "Slide Number Placeholder 3", ph: { type: "sldNum", idx: 5 }, noXfrm: true, text: String(n) }),
        )}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
        CT.notes,
      );
      w.rels(nPath, [
        { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
        { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
      ]);
    }
    if (s.legacyComments?.length) {
      legacyCommentNo++;
      const cPath = `ppt/comments/comment${legacyCommentNo}.xml`;
      rels.push({ id: "rIdCmt", type: "comments", target: `../comments/comment${legacyCommentNo}.xml` });
      w.add(
        cPath,
        `${XML_DECL}<p:cmLst xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">` +
          s.legacyComments
            .map((c, ci) => `<p:cm authorId="${c.authorId}" dt="${c.dt ?? "2024-01-01T00:00:00.000"}" idx="${ci + 1}"><p:pos x="10" y="10"/><p:text>${esc(c.text)}</p:text></p:cm>`)
            .join("") +
          `</p:cmLst>`,
        CT.comments,
      );
    }
    if (s.modernComments?.length) {
      modernCommentNo++;
      const fileName = `modernComment_${(256 + si).toString(16).toUpperCase()}_${String(modernCommentNo).padStart(8, "0")}.xml`;
      rels.push({ id: "rIdModCmt", type: "modern-comments", target: `../comments/${fileName}` });
      const body = (text: string): string => `<p188:txBody><a:bodyPr/><a:lstStyle/>${para(run(text))}</p188:txBody>`;
      w.add(
        `ppt/comments/${fileName}`,
        `${XML_DECL}<p188:cmLst xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p188="${NS.p188}">` +
          s.modernComments
            .map(
              (c) =>
                `<p188:cm id="${c.id}" authorId="${c.authorId}" created="${c.created ?? "2024-01-01T00:00:00.000"}"><p188:pos x="10" y="10"/>` +
                (c.replies?.length
                  ? `<p188:replyLst>${c.replies.map((r) => `<p188:reply id="${r.id}" authorId="${r.authorId}" created="${r.created ?? "2024-01-02T00:00:00.000"}">${body(r.text)}</p188:reply>`).join("")}</p188:replyLst>`
                  : "") +
                `${body(c.text)}</p188:cm>`,
            )
            .join("") +
          `</p188:cmLst>`,
        CT.modernComments,
      );
    }
    rels.push(...(s.rels ?? []));
    w.add(
      path,
      `${XML_DECL}<p:sld ${ROOT_NS}${s.hidden ? ` show="0"` : ""}><p:cSld${s.name !== undefined ? ` name="${esc(s.name)}"` : ""}>${spTree(s.shapes ?? "")}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${s.tail ?? ""}</p:sld>`,
      CT.slide,
    );
    w.rels(path, rels);
    const rid = nextPresRel();
    presRels.push({ id: rid, type: "slide", target: `slides/slide${n}.xml` });
    slideIdEls.push(`<p:sldId id="${256 + si}" r:id="${rid}"/>`);
  });

  // ---- comment authors ----
  if (spec.commentAuthors) {
    w.add(
      "ppt/commentAuthors.xml",
      `${XML_DECL}<p:cmAuthorLst xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">${spec.commentAuthors
        .map((a) => `<p:cmAuthor id="${a.id}" name="${esc(a.name)}" initials="${esc(a.name.slice(0, 1))}" lastIdx="1" clrIdx="${a.id}"/>`)
        .join("")}</p:cmAuthorLst>`,
      CT.commentAuthors,
    );
    presRels.push({ id: nextPresRel(), type: "commentAuthors", target: "commentAuthors.xml" });
  }
  if (spec.authors) {
    w.add(
      "ppt/authors.xml",
      `${XML_DECL}<p188:authorLst xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p188="${NS.p188}">${spec.authors
        .map((a) => `<p188:author id="${a.id}" name="${esc(a.name)}" initials="${esc(a.name.slice(0, 1))}" userId="${esc(a.name)}" providerId="None"/>`)
        .join("")}</p188:authorLst>`,
      CT.authors,
    );
    presRels.push({ id: nextPresRel(), type: "authors", target: "authors.xml" });
  }

  // ---- presProps, themes (presentation-level), fonts ----
  if (spec.presProps !== false) {
    const mru = spec.presProps?.recentColors;
    w.add(
      "ppt/presProps.xml",
      `${XML_DECL}<p:presentationPr ${ROOT_NS}>${mru?.length ? `<p:clrMru>${mru.map((c) => `<a:srgbClr val="${c}"/>`).join("")}</p:clrMru>` : ""}<p:extLst><p:ext uri="{E76CE94A-603C-4142-B9EB-6D1370010A27}"><p14:discardImageEditData val="0"/></p:ext></p:extLst></p:presentationPr>`,
      CT.presProps,
    );
    presRels.push({ id: nextPresRel(), type: "presProps", target: "presProps.xml" });
  }
  presRels.push({ id: nextPresRel(), type: "theme", target: "theme/theme1.xml" });

  const fontEls: string[] = [];
  let fontNo = 0;
  for (const f of spec.embeddedFonts ?? []) {
    const styles = f.styles.map((st) => {
      fontNo++;
      const rid = nextPresRel();
      const path = `ppt/fonts/font${fontNo}.fntdata`;
      w.add(path, new TextEncoder().encode(`fontdata:${f.typeface}:${st}`.padEnd(2048, ".")));
      presRels.push({ id: rid, type: "font", target: `fonts/font${fontNo}.fntdata` });
      return `<p:${st} r:id="${rid}"/>`;
    });
    fontEls.push(`<p:embeddedFont><p:font typeface="${esc(f.typeface)}" pitchFamily="34" charset="0"/>${styles.join("")}</p:embeddedFont>`);
  }

  // ---- presentation.xml ----
  const idToSlide = (i: number): string => `<p14:sldId id="${256 + i}"/>`;
  const sectionsXml = spec.sections?.length
    ? `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${NS.p14}">${spec.sections
        .map((s, i) => `<p14:section name="${esc(s.name)}" id="${sectionGuid(i)}"><p14:sldIdLst>${s.slides.map(idToSlide).join("")}</p14:sldIdLst></p14:section>`)
        .join("")}</p14:sectionLst></p:ext></p:extLst>`
    : "";
  const presAttrs = [spec.saveSubsetFonts ? ` saveSubsetFonts="1"` : "", fontEls.length ? ` embedTrueTypeFonts="1"` : ""].join("");
  w.add(
    "ppt/presentation.xml",
    `${XML_DECL}<p:presentation ${ROOT_NS}${presAttrs}>` +
      `<p:sldMasterIdLst>${masterIds.map((id, i) => `<p:sldMasterId id="${id}" r:id="${masterRelIds[i] ?? ""}"/>`).join("")}</p:sldMasterIdLst>` +
      (notesMasterRid ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRid}"/></p:notesMasterIdLst>` : "") +
      (slideIdEls.length ? `<p:sldIdLst>${slideIdEls.join("")}</p:sldIdLst>` : "") +
      `<p:sldSz cx="${size.cx}" cy="${size.cy}"${size.type ? ` type="${size.type}"` : ""}/><p:notesSz cx="6858000" cy="9144000"/>` +
      (fontEls.length ? `<p:embeddedFontLst>${fontEls.join("")}</p:embeddedFontLst>` : "") +
      `<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>` +
      sectionsXml +
      `</p:presentation>`,
    CT.presentation,
  );
  w.rels("ppt/presentation.xml", presRels);

  // ---- media and extra parts ----
  for (const [name, bytes] of Object.entries(spec.media ?? {})) w.add(`ppt/media/${name}`, bytes);
  for (const p of spec.parts ?? []) {
    w.add(p.path, p.content, p.contentType);
    if (p.rels) w.rels(p.path, p.rels);
  }

  // ---- docProps ----
  const core = { "dc:title": "", "dc:creator": "", "cp:lastModifiedBy": "", "cp:revision": "1", "dcterms:created": "2024-01-01T00:00:00Z", "dcterms:modified": "2024-01-01T00:00:00Z", ...(spec.core ?? {}) };
  w.add(
    "docProps/core.xml",
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      Object.entries(core)
        .map(([k, v]) => (k.startsWith("dcterms:") ? `<${k} xsi:type="dcterms:W3CDTF">${esc(v)}</${k}>` : v === "" ? `<${k}/>` : `<${k}>${esc(v)}</${k}>`))
        .join("") +
      `</cp:coreProperties>`,
    CT.core,
  );
  const app = { TotalTime: "0", Words: "0", Application: "Microsoft Office PowerPoint", PresentationFormat: "Widescreen", Slides: String(slides.length), Notes: String(notesNo), HiddenSlides: String(slides.filter((s) => s.hidden).length), AppVersion: "16.0000", ...(spec.app ?? {}) };
  w.add(
    "docProps/app.xml",
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      Object.entries(app).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("") +
      `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant><vt:variant><vt:i4>${slides.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
      `</Properties>`,
    CT.app,
  );
  const rootRels: RelSpec[] = [
    { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
    { id: "rId2", type: "core-properties", target: "docProps/core.xml" },
    { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
  ];
  if (spec.custom) {
    w.add(
      "docProps/custom.xml",
      `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        Object.entries(spec.custom)
          .map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${esc(k)}"><vt:lpwstr>${esc(v)}</vt:lpwstr></property>`)
          .join("") +
        `</Properties>`,
      CT.custom,
    );
    rootRels.push({ id: "rId4", type: "custom-properties", target: "docProps/custom.xml" });
  }
  w.zip.file("_rels/.rels", relsXml(rootRels), { date: FIXED_DATE, createFolders: false });

  return w.finish();
}

/** A minimal but valid WordprocessingML (.docx) package, for rejection tests. */
export async function buildMinimalDocx(): Promise<Uint8Array> {
  const w = new ZipWriter();
  w.add(
    "word/document.xml",
    `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  );
  w.zip.file("_rels/.rels", relsXml([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]), { date: FIXED_DATE, createFolders: false });
  return w.finish();
}
