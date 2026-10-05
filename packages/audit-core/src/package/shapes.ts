import { attr, boolAttr, child, childPath, elements, intAttr, localName, type XmlElement } from "./xml";

export type ContainerKind = "slide" | "layout" | "master";

/** The slide, layout, or master part that holds a shape tree. */
export interface ShapeContainer {
  readonly kind: ContainerKind;
  readonly partName: string;
  /** `p:sldId/@id` for slides; undefined for layouts and masters. */
  readonly slideId?: number;
}

/** Local names of PresentationML shape elements that carry a `cNvPr`. */
export type ShapeKind = "sp" | "pic" | "grpSp" | "graphicFrame" | "cxnSp" | "contentPart";

const SHAPE_KINDS: ReadonlySet<string> = new Set<ShapeKind>([
  "sp",
  "pic",
  "grpSp",
  "graphicFrame",
  "cxnSp",
  "contentPart",
]);

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly cx: number;
  readonly cy: number;
}

/** Transform as written on the shape, in its parent's coordinate space (EMU). */
export interface Xfrm {
  readonly off: Point;
  readonly ext: Size;
  /** Rotation in 60,000ths of a degree. */
  readonly rot?: number;
  readonly flipH?: boolean;
  readonly flipV?: boolean;
  /** Groups only: child coordinate space origin and extent. */
  readonly chOff?: Point;
  readonly chExt?: Size;
}

/** Axis-aligned rectangle in slide space (EMU). Rotation is ignored. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
}

export interface PlaceholderInfo {
  /** `p:ph/@type`; OOXML defaults an absent type to `obj` (body content). */
  readonly type: string;
  readonly idx?: number;
  readonly orient?: string;
  readonly sz?: string;
  readonly hasCustomPrompt?: boolean;
}

/** Placeholder types that are titles (`title` / `ctrTitle` share one master placeholder). */
export const TITLE_TYPES: ReadonlySet<string> = new Set(["title", "ctrTitle"]);
const OWN_CLASS_TYPES: ReadonlySet<string> = new Set(["dt", "ftr", "sldNum", "hdr"]);

/**
 * Master placeholder class a slide / layout placeholder type inherits from: `title` for titles,
 * `dt` / `ftr` / `sldNum` / `hdr` keep their own type, anything else is `body`.
 */
export function placeholderClass(type: string): string {
  if (TITLE_TYPES.has(type)) return "title";
  if (OWN_CLASS_TYPES.has(type)) return type;
  return "body";
}

/**
 * Stable reference to one shape in a slide, layout, or master. `container`
 * plus `shapeId` identifies the shape (cNvPr ids are unique per part); `path`
 * holds the ids of every ancestor group / graphic frame, outermost first,
 * so KTD5 joins and the Inspector can locate nested shapes.
 */
export interface ShapeRef {
  readonly container: ShapeContainer;
  /** `cNvPr/@id`; NaN is never produced — shapes without a numeric id get -1. */
  readonly shapeId: number;
  readonly name: string;
  readonly kind: ShapeKind;
  /** Qualified element name as written, e.g. `p:sp`. */
  readonly element: string;
  /** Ancestor shape ids (groups / graphic frames), outermost first. */
  readonly path: readonly number[];
  /** Position in document (z) order within the container, 0-based. */
  readonly order: number;
  /** `cNvPr hidden="1"` on this shape. */
  readonly hidden: boolean;
  /** True when this shape or any ancestor group is hidden. */
  readonly effectivelyHidden: boolean;
  readonly descr?: string;
  readonly title?: string;
  readonly placeholder?: PlaceholderInfo;
  readonly xfrm?: Xfrm;
  /**
   * Slide-space bounds after applying ancestor group transforms. Undefined
   * when the shape has no xfrm (e.g. a placeholder inheriting its position).
   */
  readonly bounds?: Bounds;
  /** `a:graphicData/@uri` for graphic frames (table, chart, diagram, OLE). */
  readonly graphicDataUri?: string;
  /** The raw parsed shape element. */
  readonly node: XmlElement;
}

function point(el: XmlElement | undefined, xName: string, yName: string): Point | undefined {
  const x = intAttr(el, xName);
  const y = intAttr(el, yName);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readXfrm(el: XmlElement | undefined): Xfrm | undefined {
  if (!el) return undefined;
  const off = point(child(el, "off"), "x", "y");
  const extPt = point(child(el, "ext"), "cx", "cy");
  if (!off || !extPt) return undefined;
  const chOff = point(child(el, "chOff"), "x", "y");
  const chExtPt = point(child(el, "chExt"), "cx", "cy");
  const rot = intAttr(el, "rot");
  const flipH = boolAttr(el, "flipH");
  const flipV = boolAttr(el, "flipV");
  return {
    off,
    ext: { cx: extPt.x, cy: extPt.y },
    ...(rot !== undefined ? { rot } : {}),
    ...(flipH !== undefined ? { flipH } : {}),
    ...(flipV !== undefined ? { flipV } : {}),
    ...(chOff ? { chOff } : {}),
    ...(chExtPt ? { chExt: { cx: chExtPt.x, cy: chExtPt.y } } : {}),
  };
}

/** Maps a point/extent from a group's child space into its parent space. */
type Transform = (b: Bounds) => Bounds;

const identity: Transform = (b) => b;

function groupTransform(parent: Transform, x: Xfrm | undefined): Transform {
  if (!x) return parent;
  const chOff = x.chOff ?? x.off;
  const chExt = x.chExt ?? x.ext;
  const sx = chExt.cx === 0 ? 1 : x.ext.cx / chExt.cx;
  const sy = chExt.cy === 0 ? 1 : x.ext.cy / chExt.cy;
  return (b) =>
    parent({
      x: x.off.x + (b.x - chOff.x) * sx,
      y: x.off.y + (b.y - chOff.y) * sy,
      cx: b.cx * sx,
      cy: b.cy * sy,
    });
}

function nonVisualProps(shape: XmlElement): XmlElement | undefined {
  // nvSpPr / nvPicPr / nvGrpSpPr / nvGraphicFramePr / nvCxnSpPr / nvContentPartPr
  return elements(shape).find((c) => /^nv.*Pr$/.test(localName(c.name)));
}

function shapeXfrm(shape: XmlElement, kind: ShapeKind): Xfrm | undefined {
  switch (kind) {
    case "graphicFrame":
      return readXfrm(child(shape, "xfrm"));
    case "grpSp":
      return readXfrm(childPath(shape, "grpSpPr", "xfrm"));
    case "contentPart":
      return readXfrm(childPath(shape, "xfrm"));
    default:
      return readXfrm(childPath(shape, "spPr", "xfrm"));
  }
}

function placeholderOf(nv: XmlElement | undefined): PlaceholderInfo | undefined {
  const ph = childPath(nv, "nvPr", "ph");
  if (!ph) return undefined;
  const idx = intAttr(ph, "idx");
  const orient = attr(ph, "orient");
  const sz = attr(ph, "sz");
  const custom = boolAttr(ph, "hasCustomPrompt");
  return {
    type: attr(ph, "type") ?? "obj",
    ...(idx !== undefined ? { idx } : {}),
    ...(orient !== undefined ? { orient } : {}),
    ...(sz !== undefined ? { sz } : {}),
    ...(custom !== undefined ? { hasCustomPrompt: custom } : {}),
  };
}

/**
 * Picks the branch of `mc:AlternateContent` to walk. PowerPoint writes the
 * real content in the first `mc:Choice` and a legacy rendition in
 * `mc:Fallback`; walking both would double-count shapes with the same ids.
 */
function alternateBranch(ac: XmlElement): XmlElement | undefined {
  return child(ac, "mc:Choice") ?? child(ac, "Choice") ?? child(ac, "mc:Fallback") ?? child(ac, "Fallback");
}

/**
 * Walks every shape in a shape tree recursively, in document (z) order:
 * into group shapes (`p:grpSp`), into graphic frames (any shapes nested
 * under `a:graphic/a:graphicData`), and through `mc:AlternateContent`.
 */
export function walkShapeTree(spTree: XmlElement, container: ShapeContainer): ShapeRef[] {
  const out: ShapeRef[] = [];

  const visitChildren = (
    parent: XmlElement,
    path: readonly number[],
    transform: Transform,
    ancestorHidden: boolean,
  ): void => {
    for (const el of elements(parent)) {
      const local = localName(el.name);
      if (local === "AlternateContent") {
        const branch = alternateBranch(el);
        if (branch) visitChildren(branch, path, transform, ancestorHidden);
        continue;
      }
      if (!SHAPE_KINDS.has(local)) continue;
      const kind = local as ShapeKind;
      const nv = nonVisualProps(el);
      const cNvPr = child(nv, "cNvPr");
      const shapeId = intAttr(cNvPr, "id") ?? -1;
      const hidden = boolAttr(cNvPr, "hidden") ?? false;
      const xfrm = shapeXfrm(el, kind);
      const placeholder = placeholderOf(nv);
      const descr = attr(cNvPr, "descr");
      const title = attr(cNvPr, "title");
      const graphicData = kind === "graphicFrame" ? childPath(el, "graphic", "graphicData") : undefined;
      const graphicDataUri = attr(graphicData, "uri");
      out.push({
        container,
        shapeId,
        name: attr(cNvPr, "name") ?? "",
        kind,
        element: el.name,
        path,
        order: out.length,
        hidden,
        effectivelyHidden: hidden || ancestorHidden,
        ...(descr !== undefined ? { descr } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(xfrm ? { xfrm, bounds: transform({ x: xfrm.off.x, y: xfrm.off.y, cx: xfrm.ext.cx, cy: xfrm.ext.cy }) } : {}),
        ...(graphicDataUri !== undefined ? { graphicDataUri } : {}),
        node: el,
      });
      const childPathIds = [...path, shapeId];
      if (kind === "grpSp") {
        visitChildren(el, childPathIds, groupTransform(transform, xfrm), hidden || ancestorHidden);
      } else if (kind === "graphicFrame" && graphicData) {
        // Shapes nested inside a graphic frame's payload live in the frame's
        // own space: offset them by the frame's position.
        const frameTransform: Transform = xfrm
          ? (b) => transform({ ...b, x: xfrm.off.x + b.x, y: xfrm.off.y + b.y })
          : transform;
        visitNested(graphicData, childPathIds, frameTransform, hidden || ancestorHidden);
      }
    }
  };

  /** Descends through non-shape wrapper elements looking for shape elements. */
  const visitNested = (
    el: XmlElement,
    path: readonly number[],
    transform: Transform,
    ancestorHidden: boolean,
  ): void => {
    const direct = elements(el);
    if (direct.some((c) => SHAPE_KINDS.has(localName(c.name)) || localName(c.name) === "AlternateContent")) {
      visitChildren(el, path, transform, ancestorHidden);
      // Also descend into non-shape siblings that may wrap further shapes.
      for (const c of direct) {
        if (!SHAPE_KINDS.has(localName(c.name)) && localName(c.name) !== "AlternateContent") {
          visitNested(c, path, transform, ancestorHidden);
        }
      }
      return;
    }
    for (const c of direct) visitNested(c, path, transform, ancestorHidden);
  };

  visitChildren(spTree, [], identity, false);
  return out;
}
