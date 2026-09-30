import { attr, childrenNamed, parseXml } from "./xml";

/**
 * A relationship from one part (or the package root) to a target.
 *
 * Part names throughout the model are ZIP entry paths WITHOUT a leading
 * slash (`ppt/slides/slide1.xml`), exactly as JSZip lists them.
 */
export interface Relationship {
  /** `Id` attribute, unique within the source part's rels. */
  readonly id: string;
  /** Full relationship type URI. */
  readonly type: string;
  /** Last path segment of the type URI, e.g. `slideLayout`, `hyperlink`, `image`. */
  readonly shortType: RelShortType;
  /** `Target` exactly as written. */
  readonly target: string;
  readonly targetMode: "Internal" | "External";
  /** Part that owns this relationship; `""` for package-level `_rels/.rels`. */
  readonly sourcePart: string;
  /**
   * For internal relationships, the resolved target part name. `undefined` for
   * external relationships: they are never resolved as parts. An internal
   * target that resolves to a missing part still has a value here; check
   * `OpcPackage.has()` before reading it.
   */
  readonly targetPart: string | undefined;
}

/** Well-known short relationship types; any other type URI keeps its last segment. */
export type RelShortType =
  | "officeDocument"
  | "core-properties"
  | "extended-properties"
  | "custom-properties"
  | "thumbnail"
  | "slide"
  | "slideLayout"
  | "slideMaster"
  | "notesMaster"
  | "notesSlide"
  | "handoutMaster"
  | "theme"
  | "presProps"
  | "viewProps"
  | "tableStyles"
  | "commentAuthors"
  | "authors"
  | "comments"
  | "image"
  | "video"
  | "audio"
  | "media"
  | "hdphoto"
  | "chart"
  | "chartUserShapes"
  | "diagramData"
  | "diagramLayout"
  | "diagramColors"
  | "diagramQuickStyle"
  | "diagramDrawing"
  | "hyperlink"
  | "oleObject"
  | "package"
  | "font"
  | "tags"
  | "customXml"
  | "vmlDrawing"
  | (string & {});

export const EXTERNAL = "External";

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`; `""` → `_rels/.rels`. */
export function relsPartFor(partName: string): string {
  if (partName === "") return "_rels/.rels";
  const slash = partName.lastIndexOf("/");
  const dir = slash < 0 ? "" : partName.slice(0, slash + 1);
  const file = slash < 0 ? partName : partName.slice(slash + 1);
  return `${dir}_rels/${file}.rels`;
}

export function shortRelType(type: string): RelShortType {
  const trimmed = type.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolves an internal relationship target against its source part, per OPC:
 * relative to the source part's folder, `..` segments collapse, a leading `/`
 * is package-absolute, percent-escapes are decoded, and any fragment or query
 * is dropped.
 */
export function resolveTarget(sourcePart: string, target: string): string {
  let t = target.split("#")[0] ?? "";
  t = t.split("?")[0] ?? "";
  t = safeDecode(t.replace(/\\/g, "/"));
  let segments: string[];
  if (t.startsWith("/")) {
    segments = [];
    t = t.slice(1);
  } else {
    const slash = sourcePart.lastIndexOf("/");
    segments = slash < 0 ? [] : sourcePart.slice(0, slash).split("/");
  }
  for (const seg of t.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return segments.join("/");
}

/** Parses a `.rels` part. Unparseable rels yield an empty list rather than failing the whole load. */
export function parseRelationships(sourcePart: string, xmlText: string): Relationship[] {
  let root;
  try {
    root = parseXml(xmlText);
  } catch {
    return [];
  }
  const out: Relationship[] = [];
  for (const el of childrenNamed(root, "Relationship")) {
    const id = attr(el, "Id");
    const type = attr(el, "Type");
    const target = attr(el, "Target");
    if (id === undefined || type === undefined || target === undefined) continue;
    const external = (attr(el, "TargetMode") ?? "").toLowerCase() === "external";
    out.push({
      id,
      type,
      shortType: shortRelType(type),
      target,
      targetMode: external ? "External" : "Internal",
      sourcePart,
      targetPart: external ? undefined : resolveTarget(sourcePart, target),
    });
  }
  return out;
}
