import { PackageError } from "./errors";
import type { Relationship } from "./rels";
import { walkShapeTree, type ShapeContainer, type ShapeRef } from "./shapes";
import {
  attr,
  boolAttr,
  child,
  childPath,
  childrenNamed,
  descendants,
  elements,
  intAttr,
  localName,
  relAttr,
  textContent,
  type XmlElement,
} from "./xml";
import { OpcPackage, type PackageInput } from "./zip";

/** Content types of a PresentationML main part (.pptx/.pptm/.ppsx/.ppsm/.potx/.potm). */
export const PRESENTATION_MAIN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
]);

export interface SlideSize {
  /** Width in EMU. */
  readonly cx: number;
  /** Height in EMU. */
  readonly cy: number;
  /** `p:sldSz/@type` (e.g. `screen16x9`), when present. */
  readonly type?: string;
}

export interface SlideInfo {
  /** 0-based position in `p:sldIdLst`. */
  readonly index: number;
  /** 1-based slide number as shown in PowerPoint. */
  readonly number: number;
  /** `p:sldId/@id` — stable across saves; the KTD5 join key. */
  readonly slideId: number;
  /** `p:sldId/@r:id` in presentation.xml.rels. */
  readonly relId: string;
  readonly partName: string;
  /** `p:sld show="0"`. */
  readonly hidden: boolean;
  /** `p:cSld/@name`, usually empty. */
  readonly name: string;
  readonly layoutPart: string | undefined;
  /** Master of this slide's layout. */
  readonly masterPart: string | undefined;
  readonly notesPart: string | undefined;
  /** Legacy (`ppt/comments/commentN.xml`) and modern comment parts. */
  readonly commentParts: readonly string[];
  readonly mediaParts: readonly string[];
  readonly chartParts: readonly string[];
  /** diagramData / Layout / Colors / QuickStyle / Drawing parts (SmartArt). */
  readonly diagramParts: readonly string[];
  /** Section this slide belongs to, when the deck has sections. */
  readonly sectionId?: string;
  /** Every relationship of the slide part, internal and external. */
  readonly relationships: readonly Relationship[];
}

export interface LayoutInfo {
  readonly partName: string;
  /** `p:cSld/@name`. */
  readonly name: string;
  /** `p:sldLayout/@type` (e.g. `title`, `obj`, `blank`); `cust` when absent. */
  readonly type: string;
  readonly masterPart: string | undefined;
  /** `p:sldLayout preserve="1"`. */
  readonly preserve: boolean;
  readonly userDrawn: boolean;
  /** Slides using this layout, in slide order. */
  readonly slideParts: readonly string[];
  readonly slideIds: readonly number[];
  readonly relationships: readonly Relationship[];
}

export interface MasterInfo {
  readonly partName: string;
  /** `p:sldMasterId/@id` in presentation.xml. */
  readonly masterId: number | undefined;
  readonly relId: string;
  /** `p:cSld/@name`, usually empty for masters; see also the theme name. */
  readonly name: string;
  /** `p:sldMaster preserve="1"`. */
  readonly preserve: boolean;
  readonly themePart: string | undefined;
  /** Layouts in `p:sldLayoutIdLst` order. */
  readonly layoutParts: readonly string[];
  /** Slides using any of this master's layouts, in slide order. */
  readonly slideParts: readonly string[];
  readonly relationships: readonly Relationship[];
}

export const THEME_COLOR_SLOTS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;
export type ThemeColorSlot = (typeof THEME_COLOR_SLOTS)[number];

export interface ThemeColor {
  readonly slot: ThemeColorSlot;
  /** Upper-case RRGGBB. For `a:sysClr` this is `lastClr` (the rendered value). */
  readonly hex: string;
  readonly kind: "srgb" | "sys";
  /** `a:sysClr/@val` (e.g. `windowText`) for system colors. */
  readonly sysName?: string;
}

export interface FontTrio {
  /** Empty string when the theme leaves the script unset. */
  readonly latin: string;
  readonly ea: string;
  readonly cs: string;
  /** Per-script overrides from `a:font script=… typeface=…`. */
  readonly scripts: Readonly<Record<string, string>>;
}

export interface ThemeInfo {
  readonly partName: string;
  readonly name: string;
  readonly colorSchemeName: string;
  /** Exactly the 12 `a:clrScheme` slots that are present, in slot order. */
  readonly colors: readonly ThemeColor[];
  readonly fontSchemeName: string;
  readonly majorFont: FontTrio;
  readonly minorFont: FontTrio;
}

export interface SectionInfo {
  readonly id: string;
  readonly name: string;
  /** `p:sldId/@id` values in section order; empty for an empty section. */
  readonly slideIds: readonly number[];
}

export type MediaKind = "image" | "video" | "audio" | "other";

export interface MediaUse {
  /** Part that references the media (slide, layout, master, notes, chart…). */
  readonly sourcePart: string;
  readonly relId: string;
  readonly relType: string;
}

export interface MediaPart {
  readonly partName: string;
  readonly contentType: string | undefined;
  readonly kind: MediaKind;
  /** Uncompressed byte size. */
  readonly size: number;
  /** Compressed size inside the ZIP, when known. */
  readonly compressedSize?: number;
  /** Every internal relationship targeting this part; empty for orphans. */
  readonly usedBy: readonly MediaUse[];
}

export type EmbeddedFontStyle = "regular" | "bold" | "italic" | "boldItalic";

export interface EmbeddedFont {
  readonly typeface: string;
  readonly panose?: string;
  readonly pitchFamily?: string;
  readonly charset?: string;
  readonly styles: readonly { style: EmbeddedFontStyle; relId: string; partName?: string; size?: number }[];
}

export type ColorValueKind = "srgb" | "scheme" | "sys" | "preset" | "hsl" | "scrgb";

/** One color entry from `p:clrMru`. */
export interface RecentColor {
  readonly kind: ColorValueKind;
  /** `val` as written (hex for srgb, slot name for scheme, name for preset/sys). */
  readonly value: string;
  /** Upper-case RRGGBB when determinable (srgb, sys lastClr). */
  readonly hex?: string;
}

export interface CustomProperty {
  readonly name: string;
  /** Local name of the value element, e.g. `lpwstr`, `i4`, `bool`, `filetime`. */
  readonly valueType: string;
  readonly value: string;
}

export interface DocumentProperties {
  /** Core properties keyed by qualified element name (`dc:creator`, `cp:lastModifiedBy`). Empty elements are kept with "". */
  readonly core: Readonly<Record<string, string>>;
  /** Simple-valued extended (app.xml) properties by local name (`Company`, `Manager`, `Application`). */
  readonly app: Readonly<Record<string, string>>;
  readonly custom: readonly CustomProperty[];
}

export interface NotesInfo {
  readonly partName: string;
  readonly slidePart: string;
  /** Text of the notes body placeholder(s); paragraphs joined by "\n". */
  readonly text: string;
}

export interface CommentInfo {
  readonly kind: "legacy" | "modern";
  readonly partName: string;
  /** Slide the comment is attached to, when known. */
  readonly slidePart: string | undefined;
  readonly authorId: string | undefined;
  readonly authorName: string | undefined;
  readonly text: string;
  readonly created: string | undefined;
  /** Modern comments: id of the comment; replies carry `parentId`. */
  readonly id?: string;
  readonly parentId?: string;
}

/** The typed, lazily parsed presentation model (U3). */
export interface Presentation {
  /** Underlying package for raw part access (cached XML, rels, sizes). */
  readonly pkg: OpcPackage;
  readonly presentationPart: string;
  readonly mainContentType: string;
  readonly slideSize: SlideSize | undefined;
  readonly notesSize: SlideSize | undefined;
  /** In `p:sldIdLst` order. */
  readonly slides: readonly SlideInfo[];
  /** In `p:sldMasterIdLst` order. */
  readonly masters: readonly MasterInfo[];
  /** Grouped by master, in each master's `p:sldLayoutIdLst` order. */
  readonly layouts: readonly LayoutInfo[];
  readonly themes: readonly ThemeInfo[];
  /** Theme of the first master (the deck's primary theme). */
  readonly theme: ThemeInfo | undefined;
  /** Empty when the deck has no sections. */
  readonly sections: readonly SectionInfo[];
  readonly media: readonly MediaPart[];
  readonly embeddedFonts: readonly EmbeddedFont[];
  /** `p:presentation saveSubsetFonts="1"`. */
  readonly saveSubsetFonts: boolean;
  readonly embedTrueTypeFonts: boolean;
  /** `presProps.xml` `p:clrMru`; empty when presProps is missing. */
  readonly recentColors: readonly RecentColor[];
  readonly properties: DocumentProperties;
  readonly notes: readonly NotesInfo[];
  readonly comments: readonly CommentInfo[];
  /** Every `TargetMode="External"` relationship in the package, by source part. */
  readonly externalRelationships: readonly Relationship[];
  /** Sum of uncompressed sizes of all parts. */
  readonly totalUncompressedSize: number;
}

const MEDIA_REL_TYPES = new Set(["image", "video", "audio", "media", "hdphoto"]);
const DIAGRAM_REL_TYPES = new Set([
  "diagramData",
  "diagramLayout",
  "diagramColors",
  "diagramQuickStyle",
  "diagramDrawing",
]);

function hexOf(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const h = v.trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(h) ? h : undefined;
}

function sizeOf(el: XmlElement | undefined): SlideSize | undefined {
  const cx = intAttr(el, "cx");
  const cy = intAttr(el, "cy");
  if (cx === undefined || cy === undefined) return undefined;
  const type = attr(el, "type");
  return { cx, cy, ...(type !== undefined ? { type } : {}) };
}

function readFontTrio(el: XmlElement | undefined): FontTrio {
  const scripts: Record<string, string> = {};
  for (const f of el ? childrenNamed(el, "font") : []) {
    const script = attr(f, "script");
    const tf = attr(f, "typeface");
    if (script !== undefined && tf !== undefined) scripts[script] = tf;
  }
  return {
    latin: attr(child(el, "latin"), "typeface") ?? "",
    ea: attr(child(el, "ea"), "typeface") ?? "",
    cs: attr(child(el, "cs"), "typeface") ?? "",
    scripts,
  };
}

/** Reads a color element (`a:srgbClr`, `a:sysClr`, …) into a RecentColor-like value. */
export function readColorValue(el: XmlElement): RecentColor | undefined {
  const local = localName(el.name);
  const val = attr(el, "val") ?? "";
  switch (local) {
    case "srgbClr": {
      const hex = hexOf(val);
      return { kind: "srgb", value: val, ...(hex ? { hex } : {}) };
    }
    case "sysClr": {
      const hex = hexOf(attr(el, "lastClr"));
      return { kind: "sys", value: val, ...(hex ? { hex } : {}) };
    }
    case "schemeClr":
      return { kind: "scheme", value: val };
    case "prstClr":
      return { kind: "preset", value: val };
    case "hslClr":
      return { kind: "hsl", value: `${attr(el, "hue") ?? ""},${attr(el, "sat") ?? ""},${attr(el, "lum") ?? ""}` };
    case "scrgbClr":
      return { kind: "scrgb", value: `${attr(el, "r") ?? ""},${attr(el, "g") ?? ""},${attr(el, "b") ?? ""}` };
    default:
      return undefined;
  }
}

function readTheme(partName: string, root: XmlElement): ThemeInfo {
  const elementsEl = child(root, "themeElements");
  const clrScheme = child(elementsEl, "clrScheme");
  const colors: ThemeColor[] = [];
  for (const slot of THEME_COLOR_SLOTS) {
    const slotEl = child(clrScheme, slot);
    const valueEl = slotEl ? elements(slotEl)[0] : undefined;
    if (!valueEl) continue;
    const local = localName(valueEl.name);
    if (local === "sysClr") {
      colors.push({
        slot,
        kind: "sys",
        hex: hexOf(attr(valueEl, "lastClr")) ?? "",
        sysName: attr(valueEl, "val") ?? "",
      });
    } else if (local === "srgbClr") {
      colors.push({ slot, kind: "srgb", hex: hexOf(attr(valueEl, "val")) ?? "" });
    }
  }
  const fontScheme = child(elementsEl, "fontScheme");
  return {
    partName,
    name: attr(root, "name") ?? "",
    colorSchemeName: attr(clrScheme, "name") ?? "",
    colors,
    fontSchemeName: attr(fontScheme, "name") ?? "",
    majorFont: readFontTrio(child(fontScheme, "majorFont")),
    minorFont: readFontTrio(child(fontScheme, "minorFont")),
  };
}

function paragraphsText(txBody: XmlElement | undefined): string {
  if (!txBody) return "";
  return childrenNamed(txBody, "p")
    .map((p) =>
      elements(p)
        .map((r) => {
          const l = localName(r.name);
          if (l === "r" || l === "fld") return textContent(child(r, "t"));
          if (l === "br") return "\n";
          return "";
        })
        .join(""),
    )
    .join("\n");
}

function notesText(root: XmlElement): string {
  const spTree = childPath(root, "cSld", "spTree");
  if (!spTree) return "";
  const parts: string[] = [];
  for (const sp of descendants(spTree, "sp")) {
    const ph = childPath(sp, "nvSpPr", "nvPr", "ph");
    // The notes text lives in the body placeholder; skip slide image, number, header…
    if (!ph || (attr(ph, "type") ?? "obj") !== "body") continue;
    const t = paragraphsText(child(sp, "txBody"));
    if (t.trim() !== "") parts.push(t);
  }
  return parts.join("\n");
}

function relsOfType(rels: readonly Relationship[], ...types: string[]): Relationship[] {
  return rels.filter((r) => r.targetMode === "Internal" && types.includes(r.shortType));
}

function firstTarget(rels: readonly Relationship[], type: string): string | undefined {
  return relsOfType(rels, type)[0]?.targetPart;
}

const EXT_KIND: Readonly<Record<string, MediaKind>> = {
  png: "image", jpg: "image", jpeg: "image", jpe: "image", gif: "image", bmp: "image", tif: "image",
  tiff: "image", wdp: "image", jxr: "image", svg: "image", emf: "image", wmf: "image", webp: "image",
  mp4: "video", m4v: "video", mov: "video", wmv: "video", avi: "video", mpg: "video", mpeg: "video",
  mp3: "audio", m4a: "audio", wav: "audio", wma: "audio", aac: "audio",
};

function mediaKind(partName: string, contentType: string | undefined, relTypes: readonly string[]): MediaKind {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  if (relTypes.includes("image") || relTypes.includes("hdphoto")) return "image";
  if (relTypes.includes("video")) return "video";
  if (relTypes.includes("audio")) return "audio";
  // Orphans with no content type: fall back to the file extension.
  const ext = partName.slice(partName.lastIndexOf(".") + 1).toLowerCase();
  return EXT_KIND[ext] ?? "other";
}

async function requireXml(pkg: OpcPackage, partName: string): Promise<XmlElement> {
  const root = await pkg.xml(partName);
  if (!root) throw new PackageError("malformed-part", `Required part ${partName} is missing.`, { partName });
  return root;
}

async function readProperties(pkg: OpcPackage, rootRels: readonly Relationship[]): Promise<DocumentProperties> {
  const core: Record<string, string> = {};
  const app: Record<string, string> = {};
  const custom: CustomProperty[] = [];
  const corePart = firstTarget(rootRels, "core-properties") ?? "docProps/core.xml";
  const appPart = firstTarget(rootRels, "extended-properties") ?? "docProps/app.xml";
  const customPart = firstTarget(rootRels, "custom-properties") ?? "docProps/custom.xml";

  const coreRoot = await pkg.xml(corePart).catch(() => undefined);
  for (const el of coreRoot ? elements(coreRoot) : []) core[el.name] = textContent(el);

  const appRoot = await pkg.xml(appPart).catch(() => undefined);
  for (const el of appRoot ? elements(appRoot) : []) {
    // Vector-valued entries (HeadingPairs, TitlesOfParts) are not simple properties.
    if (elements(el).length === 0) app[localName(el.name)] = textContent(el);
  }

  const customRoot = await pkg.xml(customPart).catch(() => undefined);
  for (const prop of customRoot ? childrenNamed(customRoot, "property") : []) {
    const valueEl = elements(prop)[0];
    custom.push({
      name: attr(prop, "name") ?? "",
      valueType: valueEl ? localName(valueEl.name) : "",
      value: textContent(valueEl),
    });
  }
  return { core, app, custom };
}

async function readAuthors(pkg: OpcPackage, presRels: readonly Relationship[]): Promise<Map<string, string>> {
  const authors = new Map<string, string>();
  for (const type of ["commentAuthors", "authors"]) {
    for (const r of relsOfType(presRels, type)) {
      if (!r.targetPart) continue;
      const root = await pkg.xml(r.targetPart).catch(() => undefined);
      if (!root) continue;
      for (const a of elements(root)) {
        const id = attr(a, "id");
        const name = attr(a, "name");
        if (id !== undefined && name !== undefined) authors.set(id, name);
      }
    }
  }
  return authors;
}

function readComments(
  partName: string,
  slidePart: string | undefined,
  root: XmlElement,
  authors: ReadonlyMap<string, string>,
): CommentInfo[] {
  const out: CommentInfo[] = [];
  // Legacy comments use the PresentationML main namespace; modern (threaded)
  // comments use http://schemas.microsoft.com/office/powerpoint/2018/8/main.
  const prefix = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":")) : "";
  const ns = root.attrs[prefix ? `xmlns:${prefix}` : "xmlns"] ?? "";
  const modern = ns.includes("/office/powerpoint/2018/");
  for (const cm of childrenNamed(root, "cm")) {
    if (!modern) {
      const authorId = attr(cm, "authorId");
      out.push({
        kind: "legacy",
        partName,
        slidePart,
        authorId,
        authorName: authorId === undefined ? undefined : authors.get(authorId),
        text: textContent(child(cm, "text")),
        created: attr(cm, "dt"),
      });
      continue;
    }
    const push = (el: XmlElement, parentId: string | undefined): void => {
      const authorId = attr(el, "authorId");
      const id = attr(el, "id");
      out.push({
        kind: "modern",
        partName,
        slidePart,
        authorId,
        authorName: authorId === undefined ? undefined : authors.get(authorId),
        text: paragraphsText(child(el, "txBody")),
        created: attr(el, "created"),
        ...(id !== undefined ? { id } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
      });
    };
    push(cm, undefined);
    for (const reply of descendants(cm, "reply")) push(reply, attr(cm, "id"));
  }
  return out;
}

/**
 * Opens `.pptx` bytes and builds the presentation model.
 *
 * Structure (part graph, slide order, layouts, masters, themes, properties,
 * media sizes) is read eagerly; shape trees are parsed only when requested via
 * `getShapes` / `walkAllShapes`, and media bytes are never inflated.
 *
 * Rejects with `PackageError`:
 * - `not-a-zip` for non-ZIP bytes;
 * - `not-a-pptx` for any other OPC/ZIP document (e.g. .docx);
 * - `malformed-part` when a required part is missing or not XML.
 */
export async function loadPresentation(bytes: PackageInput): Promise<Presentation> {
  const pkg = await OpcPackage.open(bytes);
  const rootRels = await pkg.rels("");
  const officeDoc = rootRels.find((r) => r.shortType === "officeDocument" && r.targetMode === "Internal");
  const presentationPart = officeDoc?.targetPart;
  const mainContentType = presentationPart ? pkg.contentTypeOf(presentationPart) : undefined;
  if (
    !presentationPart ||
    mainContentType === undefined ||
    !PRESENTATION_MAIN_CONTENT_TYPES.has(mainContentType) ||
    !pkg.has(presentationPart)
  ) {
    throw new PackageError(
      "not-a-pptx",
      mainContentType
        ? `The document is not a PowerPoint presentation (main part is ${mainContentType}).`
        : "The document has no PowerPoint presentation part.",
      presentationPart ? { partName: presentationPart } : undefined,
    );
  }

  const presRoot = await requireXml(pkg, presentationPart);
  const presRels = await pkg.rels(presentationPart);
  const presRelById = new Map(presRels.map((r) => [r.id, r]));

  // ---- Masters, layouts, themes -------------------------------------------
  const masters: MasterInfo[] = [];
  const layoutRecords = new Map<
    string,
    { name: string; type: string; masterPart: string | undefined; preserve: boolean; userDrawn: boolean; rels: Relationship[] }
  >();
  const layoutOrder: string[] = [];
  const themeParts: string[] = [];
  const masterRecords: { partName: string; masterId: number | undefined; relId: string; name: string; preserve: boolean; themePart: string | undefined; layoutParts: string[]; rels: Relationship[] }[] = [];

  for (const idEl of childrenNamed(child(presRoot, "sldMasterIdLst") ?? presRoot, "sldMasterId")) {
    const relId = relAttr(idEl, "id") ?? "";
    const target = presRelById.get(relId)?.targetPart;
    if (!target) continue;
    const root = await requireXml(pkg, target);
    const rels = await pkg.rels(target);
    const relById = new Map(rels.map((r) => [r.id, r]));
    const themePart = firstTarget(rels, "theme");
    if (themePart && !themeParts.includes(themePart)) themeParts.push(themePart);
    const layoutParts: string[] = [];
    for (const lid of childrenNamed(child(root, "sldLayoutIdLst") ?? root, "sldLayoutId")) {
      const lp = relById.get(relAttr(lid, "id") ?? "")?.targetPart;
      if (lp && !layoutParts.includes(lp)) layoutParts.push(lp);
    }
    // Layouts referenced by rels but missing from sldLayoutIdLst still belong to the master.
    for (const r of relsOfType(rels, "slideLayout")) {
      if (r.targetPart && !layoutParts.includes(r.targetPart)) layoutParts.push(r.targetPart);
    }
    masterRecords.push({
      partName: target,
      masterId: intAttr(idEl, "id"),
      relId,
      name: attr(child(root, "cSld"), "name") ?? "",
      preserve: boolAttr(root, "preserve") ?? false,
      themePart,
      layoutParts,
      rels,
    });
    for (const lp of layoutParts) {
      if (layoutRecords.has(lp)) continue;
      const lroot = await requireXml(pkg, lp);
      const lrels = await pkg.rels(lp);
      layoutRecords.set(lp, {
        name: attr(child(lroot, "cSld"), "name") ?? "",
        type: attr(lroot, "type") ?? "cust",
        masterPart: firstTarget(lrels, "slideMaster") ?? target,
        preserve: boolAttr(lroot, "preserve") ?? false,
        userDrawn: boolAttr(lroot, "userDrawn") ?? false,
        rels: lrels,
      });
      layoutOrder.push(lp);
    }
  }

  // ---- Slides -------------------------------------------------------------
  const sectionOfSlide = new Map<number, string>();
  const sections: SectionInfo[] = [];
  for (const sectionLst of descendants(child(presRoot, "extLst") ?? presRoot, "sectionLst")) {
    for (const s of childrenNamed(sectionLst, "section")) {
      const id = attr(s, "id") ?? "";
      const slideIds = childrenNamed(child(s, "sldIdLst") ?? s, "sldId")
        .map((e) => intAttr(e, "id"))
        .filter((n): n is number => n !== undefined);
      for (const sid of slideIds) sectionOfSlide.set(sid, id);
      sections.push({ id, name: attr(s, "name") ?? "", slideIds });
    }
    break; // only one section list is meaningful
  }

  const slides: SlideInfo[] = [];
  const notes: NotesInfo[] = [];
  const commentSources: { part: string; slidePart: string }[] = [];
  const slideIdEls = childrenNamed(child(presRoot, "sldIdLst") ?? presRoot, "sldId");
  for (const idEl of slideIdEls) {
    const relId = relAttr(idEl, "id") ?? "";
    const partName = presRelById.get(relId)?.targetPart;
    const slideId = intAttr(idEl, "id");
    if (!partName || slideId === undefined) continue;
    const root = await requireXml(pkg, partName);
    const rels = await pkg.rels(partName);
    const layoutPart = firstTarget(rels, "slideLayout");
    const notesPart = firstTarget(rels, "notesSlide");
    const commentParts = relsOfType(rels, "comments")
      .map((r) => r.targetPart)
      .filter((p): p is string => p !== undefined);
    for (const cp of commentParts) commentSources.push({ part: cp, slidePart: partName });
    if (notesPart && pkg.has(notesPart)) {
      const nroot = await pkg.xml(notesPart).catch(() => undefined);
      notes.push({ partName: notesPart, slidePart: partName, text: nroot ? notesText(nroot) : "" });
    }
    const sectionId = sectionOfSlide.get(slideId);
    slides.push({
      index: slides.length,
      number: slides.length + 1,
      slideId,
      relId,
      partName,
      hidden: boolAttr(root, "show") === false,
      name: attr(child(root, "cSld"), "name") ?? "",
      layoutPart,
      masterPart: layoutPart ? layoutRecords.get(layoutPart)?.masterPart : undefined,
      notesPart,
      commentParts,
      mediaParts: [
        ...new Set(relsOfType(rels, ...MEDIA_REL_TYPES).map((r) => r.targetPart).filter((p): p is string => !!p)),
      ],
      chartParts: relsOfType(rels, "chart").map((r) => r.targetPart).filter((p): p is string => !!p),
      diagramParts: relsOfType(rels, ...DIAGRAM_REL_TYPES).map((r) => r.targetPart).filter((p): p is string => !!p),
      ...(sectionId !== undefined ? { sectionId } : {}),
      relationships: rels,
    });
  }

  // ---- Usage --------------------------------------------------------------
  const layouts: LayoutInfo[] = layoutOrder.map((lp) => {
    const rec = layoutRecords.get(lp);
    const using = slides.filter((s) => s.layoutPart === lp);
    return {
      partName: lp,
      name: rec?.name ?? "",
      type: rec?.type ?? "cust",
      masterPart: rec?.masterPart,
      preserve: rec?.preserve ?? false,
      userDrawn: rec?.userDrawn ?? false,
      slideParts: using.map((s) => s.partName),
      slideIds: using.map((s) => s.slideId),
      relationships: rec?.rels ?? [],
    };
  });
  for (const m of masterRecords) {
    masters.push({
      partName: m.partName,
      masterId: m.masterId,
      relId: m.relId,
      name: m.name,
      preserve: m.preserve,
      themePart: m.themePart,
      layoutParts: m.layoutParts,
      slideParts: slides.filter((s) => s.layoutPart && m.layoutParts.includes(s.layoutPart)).map((s) => s.partName),
      relationships: m.rels,
    });
  }

  // ---- Themes -------------------------------------------------------------
  for (const r of relsOfType(presRels, "theme")) {
    if (r.targetPart && !themeParts.includes(r.targetPart)) themeParts.push(r.targetPart);
  }
  const themes: ThemeInfo[] = [];
  for (const tp of themeParts) {
    const root = await pkg.xml(tp);
    if (root) themes.push(readTheme(tp, root));
  }
  const primaryThemePart = masters[0]?.themePart ?? themeParts[0];
  const theme = themes.find((t) => t.partName === primaryThemePart);

  // ---- Presentation-level facts --------------------------------------------
  const embeddedFonts: EmbeddedFont[] = [];
  for (const ef of childrenNamed(child(presRoot, "embeddedFontLst") ?? presRoot, "embeddedFont")) {
    const font = child(ef, "font");
    const styles: { style: EmbeddedFontStyle; relId: string; partName?: string; size?: number }[] = [];
    for (const style of ["regular", "bold", "italic", "boldItalic"] as const) {
      const relId = relAttr(child(ef, style), "id");
      if (relId === undefined) continue;
      const partName = presRelById.get(relId)?.targetPart;
      const size = partName ? await pkg.size(partName) : undefined;
      styles.push({
        style,
        relId,
        ...(partName !== undefined ? { partName } : {}),
        ...(size !== undefined ? { size } : {}),
      });
    }
    const panose = attr(font, "panose");
    const pitchFamily = attr(font, "pitchFamily");
    const charset = attr(font, "charset");
    embeddedFonts.push({
      typeface: attr(font, "typeface") ?? "",
      ...(panose !== undefined ? { panose } : {}),
      ...(pitchFamily !== undefined ? { pitchFamily } : {}),
      ...(charset !== undefined ? { charset } : {}),
      styles,
    });
  }

  const recentColors: RecentColor[] = [];
  const presPropsPart = firstTarget(presRels, "presProps");
  const presPropsRoot = presPropsPart ? await pkg.xml(presPropsPart).catch(() => undefined) : undefined;
  const clrMru = presPropsRoot ? child(presPropsRoot, "clrMru") : undefined;
  for (const c of clrMru ? elements(clrMru) : []) {
    const v = readColorValue(c);
    if (v) recentColors.push(v);
  }

  const properties = await readProperties(pkg, rootRels);

  // ---- Comments -------------------------------------------------------------
  const authors = await readAuthors(pkg, presRels);
  const comments: CommentInfo[] = [];
  const seenCommentParts = new Set<string>();
  for (const { part, slidePart } of commentSources) {
    if (seenCommentParts.has(part)) continue;
    seenCommentParts.add(part);
    const root = await pkg.xml(part).catch(() => undefined);
    if (root) comments.push(...readComments(part, slidePart, root, authors));
  }
  // Orphan comment parts not linked from any slide still leak review data.
  for (const p of pkg.partNames) {
    if (!/^ppt\/comments\/.*\.xml$/i.test(p) || seenCommentParts.has(p)) continue;
    seenCommentParts.add(p);
    const root = await pkg.xml(p).catch(() => undefined);
    if (root) comments.push(...readComments(p, undefined, root, authors));
  }

  // ---- Media & externals (whole package) ---------------------------------
  const relsParts = pkg.partNames.filter((p) => /(^|\/)_rels\/[^/]*\.rels$/i.test(p));
  const mediaUses = new Map<string, MediaUse[]>();
  const externalRelationships: Relationship[] = [];
  for (const rp of relsParts) {
    const source = rp.replace(/(^|\/)_rels\/([^/]*)\.rels$/i, "$1$2");
    const sourcePart = source === "" || rp.toLowerCase() === "_rels/.rels" ? "" : source;
    for (const r of await pkg.rels(sourcePart)) {
      if (r.targetMode === "External") {
        externalRelationships.push(r);
        continue;
      }
      if (!r.targetPart || !MEDIA_REL_TYPES.has(r.shortType)) continue;
      const list = mediaUses.get(r.targetPart) ?? [];
      list.push({ sourcePart: r.sourcePart, relId: r.id, relType: r.shortType });
      mediaUses.set(r.targetPart, list);
    }
  }
  const mediaNames = new Set<string>([...mediaUses.keys()].filter((p) => pkg.has(p)));
  for (const p of pkg.partNames) if (/^ppt\/media\//i.test(p)) mediaNames.add(p);
  const media: MediaPart[] = [];
  for (const p of [...mediaNames].sort()) {
    const uses = mediaUses.get(p) ?? [];
    const contentType = pkg.contentTypeOf(p);
    const compressedSize = pkg.compressedSize(p);
    media.push({
      partName: p,
      contentType,
      kind: mediaKind(p, contentType, uses.map((u) => u.relType)),
      size: (await pkg.size(p)) ?? 0,
      ...(compressedSize !== undefined ? { compressedSize } : {}),
      usedBy: uses,
    });
  }

  let totalUncompressedSize = 0;
  for (const p of pkg.partNames) totalUncompressedSize += (await pkg.size(p)) ?? 0;

  return {
    pkg,
    presentationPart,
    mainContentType,
    slideSize: sizeOf(child(presRoot, "sldSz")),
    notesSize: sizeOf(child(presRoot, "notesSz")),
    slides,
    masters,
    layouts,
    themes,
    theme,
    sections,
    media,
    embeddedFonts,
    saveSubsetFonts: boolAttr(presRoot, "saveSubsetFonts") ?? false,
    embedTrueTypeFonts: boolAttr(presRoot, "embedTrueTypeFonts") ?? false,
    recentColors,
    properties,
    notes,
    comments,
    externalRelationships,
    totalUncompressedSize,
  };
}

/** Every shape container in the deck: slides (in order), then layouts, then masters. */
export function shapeContainers(pres: Presentation): ShapeContainer[] {
  return [
    ...pres.slides.map((s): ShapeContainer => ({ kind: "slide", partName: s.partName, slideId: s.slideId })),
    ...pres.layouts.map((l): ShapeContainer => ({ kind: "layout", partName: l.partName })),
    ...pres.masters.map((m): ShapeContainer => ({ kind: "master", partName: m.partName })),
  ];
}

const shapeCache = new WeakMap<OpcPackage, Map<string, Promise<ShapeRef[]>>>();

/** Shapes of one container, walked recursively in z-order. Parsed on first use and cached. */
export function getShapes(pres: Presentation, container: ShapeContainer): Promise<ShapeRef[]> {
  let perPkg = shapeCache.get(pres.pkg);
  if (!perPkg) {
    perPkg = new Map();
    shapeCache.set(pres.pkg, perPkg);
  }
  let cached = perPkg.get(container.partName);
  if (!cached) {
    cached = (async () => {
      const root = await pres.pkg.xml(container.partName);
      const spTree = childPath(root, "cSld", "spTree");
      return spTree ? walkShapeTree(spTree, container) : [];
    })();
    perPkg.set(container.partName, cached);
  }
  return cached;
}

/** Shapes across every slide, layout, and master (see `shapeContainers` for order). */
export async function walkAllShapes(pres: Presentation): Promise<ShapeRef[]> {
  const out: ShapeRef[] = [];
  for (const c of shapeContainers(pres)) out.push(...(await getShapes(pres, c)));
  return out;
}

/** Relationships of any part (slide, layout, master, chart…), cached. */
export function relationshipsOf(pres: Presentation, partName: string): Promise<Relationship[]> {
  return pres.pkg.rels(partName);
}
