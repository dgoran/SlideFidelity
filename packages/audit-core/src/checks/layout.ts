/**
 * Layout checks for show-ready decks (File Review area): objects that hang partly off the slide
 * (the part outside is cut off in the slide show) and text that touches or overlaps other objects.
 *
 * Slides only; hidden shapes (and children of hidden groups) are ignored. Geometry is slide-space
 * EMU; placeholders without their own `a:xfrm` use the layout / master bounds they inherit
 * (`PlaceholderResolver` from review.ts). Rotation and group flips are applied via `geometry.ts`.
 * Shapes fully outside the slide are left to review.ts `off-slide-shape`.
 *
 * Neither finding has an in-place fix (fixes [], reachable false): moving objects is a design call.
 */
import { makeFinding, shapeTarget, type Finding, type FindingTarget } from "../findings";
import {
  area as rectArea,
  contains,
  emuToInches,
  emuToPoints,
  EMU_PER_PT,
  fullyOutside,
  gap,
  intersection,
  offSlideFraction,
  overflow,
  visualBounds,
  type Side,
} from "../geometry";
import { getShapes, type Presentation, type SlideInfo } from "../package/model";
import type { Bounds, ShapeRef } from "../package/shapes";
import { attr, child, childPath, descendants, elements, localName, type XmlElement } from "../package/xml";
import type { Check } from "../runner";
import { PlaceholderResolver } from "./review";

// ---------------------------------------------------------------------------------------------
// Thresholds

/** Edge overhang ignored by `partly-off-slide` (0.05 in): rounding and nudges, not a real bleed. */
export const PARTLY_OFF_TOLERANCE_EMU = 45720;
/** Text closer than this to another object counts as touching it (2 pt). */
export const TEXT_TOUCH_GAP_EMU = 2 * EMU_PER_PT;
/** Objects covering at least this share of the slide are backgrounds, not collision partners. */
export const BACKGROUND_AREA_RATIO = 0.95;
/** At most this many objects per slide take part in text-collision pairing (z-order first). */
export const MAX_COLLISION_SHAPES_PER_SLIDE = 400;

// ---------------------------------------------------------------------------------------------
// Data types

/** What a shape is, in the words the UI shows. */
export type LayoutObjectKind =
  | "text-box"
  | "placeholder"
  | "shape"
  | "line"
  | "picture"
  | "video"
  | "audio"
  | "chart"
  | "table"
  | "smartart"
  | "embedded-object"
  | "graphic"
  | "group"
  | "ink";

export interface OverflowSide {
  side: Side;
  emu: number;
  inches: number;
}

export interface PartlyOffSlideData {
  shapeName: string;
  shapeKind: ShapeRef["kind"];
  objectKind: LayoutObjectKind;
  slideNumber: number;
  /** Slide edges exceeded by more than the tolerance, with the overhang. */
  sides: OverflowSide[];
  /** Share of the object's area outside the slide, 0–100 (one decimal). */
  offSlidePercent: number;
  /** Text, a table, chart, SmartArt, or video gets cut off (the reason for `warning`). */
  hasContent: boolean;
  /** For groups: names of the partly-off children that carry content. */
  contentShapes?: string[];
  /** The object or an ancestor group is rotated; `bounds` is the rotated box. */
  rotated: boolean;
  /** Axis-aligned slide-space box used for the measurement (EMU). */
  bounds: Bounds;
  slideSize: { cx: number; cy: number };
  /** Position inherited from the layout / master placeholder. */
  inherited: boolean;
  inheritedFrom?: "layout" | "master";
  toleranceEmu: number;
}

export type CollisionRelation =
  /** The two boxes partly overlap. */
  | "overlap"
  /** No overlap, but the gap is under 2 pt (or the edges touch). */
  | "touching"
  /** The text lies entirely inside the other object (caption / overlay). */
  | "text-inside"
  /** The other object lies entirely inside the text's box. */
  | "object-inside";

export interface TextCollision {
  shapeId: number;
  shapeName: string;
  shapeKind: ShapeRef["kind"];
  objectKind: LayoutObjectKind;
  relation: CollisionRelation;
  severity: "warning" | "info";
  /** Overlapping rectangle (slide-space EMU) when the boxes overlap. */
  overlap?: Bounds;
  /** Edge-to-edge distance; 0 when touching or overlapping. */
  gapEmu: number;
  gapPt: number;
  /** Either object is rotated (boxes are approximate; lowered to info). */
  rotated: boolean;
}

export interface TextCollisionData {
  shapeName: string;
  shapeKind: ShapeRef["kind"];
  /** `text-box`, `placeholder`, `shape`, or `table`. */
  objectKind: LayoutObjectKind;
  slideNumber: number;
  rotated: boolean;
  inherited: boolean;
  inheritedFrom?: "layout" | "master";
  /** Index-aligned with `targets.slice(1)`; warnings first, then z-order. */
  collisions: TextCollision[];
  /** The slide had more objects than `MAX_COLLISION_SHAPES_PER_SLIDE`; later ones were skipped. */
  truncated: boolean;
  shapesConsidered: number;
  shapesOnSlide: number;
}

declare module "../findings" {
  interface FindingDataMap {
    "partly-off-slide": PartlyOffSlideData;
    "text-collision": TextCollisionData;
  }
}

const area = "review" as const;

// ---------------------------------------------------------------------------------------------
// Shape classification

const LABELS: Record<LayoutObjectKind, string> = {
  "text-box": "text box",
  placeholder: "placeholder",
  shape: "shape",
  line: "line",
  picture: "picture",
  video: "video",
  audio: "audio icon",
  chart: "chart",
  table: "table",
  smartart: "SmartArt graphic",
  "embedded-object": "embedded object",
  graphic: "graphic",
  group: "group",
  ink: "ink drawing",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hasNonBlankText(root: XmlElement | undefined): boolean {
  if (!root) return false;
  return descendants(root, "a:t").some((t) => t.children.some((c) => c.type === "text" && c.text.trim() !== ""));
}

const FILL_LOCALS = new Set(["solidFill", "gradFill", "blipFill", "pattFill", "grpFill"]);
const LINE_FILL_LOCALS = new Set(["solidFill", "gradFill", "pattFill"]);

function styleRefUsed(node: XmlElement, ref: "fillRef" | "lnRef"): boolean {
  const idx = attr(childPath(node, "style", ref), "idx");
  return idx !== undefined && idx !== "0";
}

/** `p:sp` with a visible fill or outline (own `spPr`, else its `p:style` theme reference). */
function isFilledOrLined(node: XmlElement): boolean {
  const spPr = child(node, "spPr");
  const kids = spPr ? elements(spPr) : [];
  const fill = kids.find((k) => FILL_LOCALS.has(localName(k.name)) || localName(k.name) === "noFill");
  if (fill ? localName(fill.name) !== "noFill" : styleRefUsed(node, "fillRef")) return true;
  const ln = child(spPr, "ln");
  const lnFill = ln ? elements(ln).find((k) => LINE_FILL_LOCALS.has(localName(k.name)) || localName(k.name) === "noFill") : undefined;
  if (lnFill) return localName(lnFill.name) !== "noFill";
  return styleRefUsed(node, "lnRef");
}

function isLineGeometry(node: XmlElement): boolean {
  const prst = attr(childPath(node, "spPr", "prstGeom"), "prst");
  return prst !== undefined && /^(line|straightConnector\d*)$/.test(prst);
}

interface Classified {
  objectKind: LayoutObjectKind;
  /** Non-whitespace text (sp text body or table cells). */
  hasText: boolean;
  /** `p:sp` with a fill or outline. */
  filled: boolean;
  /** Content whose overhang gets cut off: text, table, chart, SmartArt, video. */
  content: boolean;
  /** Takes part in text-collision pairing as the "other" object. */
  collides: boolean;
}

function classify(ref: ShapeRef): Classified {
  const node = ref.node;
  switch (ref.kind) {
    case "sp": {
      const hasText = hasNonBlankText(child(node, "txBody"));
      const filled = isFilledOrLined(node);
      const txBox = attr(childPath(node, "nvSpPr", "cNvSpPr"), "txBox") === "1";
      const objectKind: LayoutObjectKind = ref.placeholder ? "placeholder" : txBox ? "text-box" : isLineGeometry(node) ? "line" : "shape";
      return { objectKind, hasText, filled, content: hasText, collides: hasText || filled };
    }
    case "pic": {
      const nvPr = childPath(node, "nvPicPr", "nvPr");
      const video = !!(child(nvPr, "videoFile") ?? child(nvPr, "quickTimeFile"));
      const audio = !video && !!child(nvPr, "audioFile");
      return { objectKind: video ? "video" : audio ? "audio" : "picture", hasText: false, filled: false, content: video, collides: true };
    }
    case "graphicFrame": {
      const uri = ref.graphicDataUri ?? "";
      if (uri.endsWith("/table")) {
        const hasText = hasNonBlankText(childPath(node, "graphic", "graphicData", "tbl"));
        return { objectKind: "table", hasText, filled: false, content: true, collides: true };
      }
      const objectKind: LayoutObjectKind = /chart/i.test(uri)
        ? "chart"
        : uri.endsWith("/diagram")
          ? "smartart"
          : uri.endsWith("/ole")
            ? "embedded-object"
            : "graphic";
      return { objectKind, hasText: false, filled: false, content: objectKind === "chart" || objectKind === "smartart", collides: true };
    }
    case "grpSp":
      return { objectKind: "group", hasText: false, filled: false, content: false, collides: false };
    case "cxnSp":
      return { objectKind: "line", hasText: false, filled: false, content: false, collides: false };
    default:
      return { objectKind: "ink", hasText: false, filled: false, content: false, collides: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Slide items

interface Item {
  ref: ShapeRef;
  cls: Classified;
  /** Unrotated slide-space bounds (own or inherited); what targets carry. */
  base: Bounds;
  /** Rotated / flipped axis-aligned box. */
  vis: Bounds;
  rotated: boolean;
  from?: "layout" | "master";
}

interface SlideItems {
  slide: SlideInfo;
  items: Item[];
}

async function collectSlides(pres: Presentation): Promise<SlideItems[]> {
  const resolver = new PlaceholderResolver(pres);
  const out: SlideItems[] = [];
  for (const slide of pres.slides) {
    const shapes = await getShapes(pres, { kind: "slide", partName: slide.partName, slideId: slide.slideId });
    const byId = new Map(shapes.map((s) => [s.shapeId, s]));
    const items: Item[] = [];
    for (const ref of shapes) {
      if (ref.effectivelyHidden) continue;
      // Shapes inside a graphic frame's payload (OLE fallback pictures) belong to the frame.
      if (ref.path.some((id) => byId.get(id)?.kind === "graphicFrame")) continue;
      const resolved = await resolver.bounds(ref);
      if (!resolved) continue;
      const vb = visualBounds(ref, resolved.bounds, byId);
      items.push({
        ref,
        cls: classify(ref),
        base: resolved.bounds,
        vis: vb.bounds,
        rotated: vb.rotated,
        ...(resolved.from ? { from: resolved.from } : {}),
      });
    }
    out.push({ slide, items });
  }
  return out;
}

function target(item: Item, pres: Presentation): FindingTarget {
  const t = shapeTarget(item.ref, pres);
  t.bounds = { x: item.base.x, y: item.base.y, cx: item.base.cx, cy: item.base.cy };
  t.reachable = false;
  return t;
}

function plainBounds(b: Bounds): Bounds {
  return { x: b.x, y: b.y, cx: b.cx, cy: b.cy };
}

function joinList(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]!}`;
}

// ---------------------------------------------------------------------------------------------
// partly-off-slide

const SIDE_WORDS: Record<Side, string> = { left: "left", right: "right", top: "top", bottom: "bottom" };

async function runPartlyOff(pres: Presentation): Promise<Finding[]> {
  const size = pres.slideSize;
  if (!size || size.cx <= 0 || size.cy <= 0) return [];
  const out: Finding[] = [];
  for (const { slide, items } of await collectSlides(pres)) {
    // Outermost only: once a group is reported (or fully off-slide), its children are covered.
    const handled = new Set<number>();
    for (const item of items) {
      const { ref } = item;
      if (ref.path.some((id) => handled.has(id))) continue;
      if (fullyOutside(item.base, size.cx, size.cy) || fullyOutside(item.vis, size.cx, size.cy)) {
        handled.add(ref.shapeId);
        continue;
      }
      const sides = overflow(item.vis, size.cx, size.cy, PARTLY_OFF_TOLERANCE_EMU);
      if (sides.length === 0) continue;
      handled.add(ref.shapeId);

      let contentShapes: string[] | undefined;
      let hasContent = item.cls.content;
      if (ref.kind === "grpSp") {
        contentShapes = items
          .filter(
            (d) =>
              d.ref.path.includes(ref.shapeId) &&
              d.cls.content &&
              overflow(d.vis, size.cx, size.cy, PARTLY_OFF_TOLERANCE_EMU).length > 0,
          )
          .map((d) => d.ref.name);
        hasContent = contentShapes.length > 0;
      }
      const severity = hasContent ? "warning" : "info";
      const label = item.cls.hasText && ref.kind === "sp" ? "Text" : capitalize(LABELS[item.cls.objectKind]);
      const sideWords = sides.map((s) => SIDE_WORDS[s.side]);
      out.push(
        makeFinding({
          area,
          kind: "partly-off-slide",
          severity,
          title: `${label} '${ref.name}' extends past the ${joinList(sideWords)} edge${sides.length > 1 ? "s" : ""} of slide ${slide.number}`,
          detail:
            severity === "warning"
              ? "The part outside the slide is cut off in the slide show. Move or resize it so its content fits on the slide."
              : "Pictures and shapes that bleed past the edge are often intentional; check that nothing important is cut off.",
          group: "partly-off-slide",
          groupLabel: "Partly off the slide",
          targets: [target(item, pres)],
          fixes: [],
          reachable: false,
          key: `${slide.partName}|${ref.shapeId}`,
          data: {
            shapeName: ref.name,
            shapeKind: ref.kind,
            objectKind: item.cls.objectKind,
            slideNumber: slide.number,
            sides: sides.map((s) => ({ side: s.side, emu: Math.round(s.emu), inches: emuToInches(s.emu) })),
            offSlidePercent: Math.round(offSlideFraction(item.vis, size.cx, size.cy) * 1000) / 10,
            hasContent,
            ...(contentShapes && contentShapes.length > 0 ? { contentShapes } : {}),
            rotated: item.rotated,
            bounds: plainBounds(item.vis),
            slideSize: { cx: size.cx, cy: size.cy },
            inherited: item.from !== undefined,
            ...(item.from ? { inheritedFrom: item.from } : {}),
            toleranceEmu: PARTLY_OFF_TOLERANCE_EMU,
          },
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// text-collision

function isTextItem(item: Item): boolean {
  return item.cls.hasText && (item.ref.kind === "sp" || item.cls.objectKind === "table");
}

function relate(text: Item, other: Item): { relation: CollisionRelation; overlap?: Bounds; gapEmu: number } | undefined {
  const g = gap(text.vis, other.vis);
  if (g >= TEXT_TOUCH_GAP_EMU) return undefined;
  const overlap = intersection(text.vis, other.vis);
  if (!overlap) return { relation: "touching", gapEmu: g };
  const otherIsText = isTextItem(other);
  // Text on text is only "by design" when the container is a filled card behind the other text.
  if (contains(other.vis, text.vis) && (!otherIsText || other.cls.filled)) return { relation: "text-inside", overlap, gapEmu: 0 };
  if (contains(text.vis, other.vis) && (!otherIsText || text.cls.filled)) return { relation: "object-inside", overlap, gapEmu: 0 };
  return { relation: "overlap", overlap, gapEmu: 0 };
}

async function runTextCollisions(pres: Presentation): Promise<Finding[]> {
  const size = pres.slideSize;
  const slideArea = size ? size.cx * size.cy : 0;
  const out: Finding[] = [];
  for (const { slide, items } of await collectSlides(pres)) {
    // Objects entirely off the slide are never seen in the show (review.ts reports them).
    const all = items.filter((i) => i.cls.collides && !(size && fullyOutside(i.vis, size.cx, size.cy)));
    const truncated = all.length > MAX_COLLISION_SHAPES_PER_SLIDE;
    const pool = truncated ? all.slice(0, MAX_COLLISION_SHAPES_PER_SLIDE) : all;
    const isBackground = (i: Item): boolean => slideArea > 0 && rectArea(i.vis) >= BACKGROUND_AREA_RATIO * slideArea;

    for (const text of pool) {
      if (!isTextItem(text)) continue;
      const hits: { other: Item; c: TextCollision }[] = [];
      for (const other of pool) {
        if (other === text || isBackground(other)) continue;
        // A text/text pair is reported once, on the shape further back in z-order.
        if (isTextItem(other) && other.ref.order < text.ref.order) continue;
        const r = relate(text, other);
        if (!r) continue;
        const rotated = text.rotated || other.rotated;
        const contained = r.relation === "text-inside" || r.relation === "object-inside";
        hits.push({
          other,
          c: {
            shapeId: other.ref.shapeId,
            shapeName: other.ref.name,
            shapeKind: other.ref.kind,
            objectKind: other.cls.objectKind,
            relation: r.relation,
            severity: contained || rotated ? "info" : "warning",
            ...(r.overlap ? { overlap: plainBounds(r.overlap) } : {}),
            gapEmu: Math.round(r.gapEmu),
            gapPt: emuToPoints(r.gapEmu),
            rotated,
          },
        });
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => (a.c.severity === b.c.severity ? a.other.ref.order - b.other.ref.order : a.c.severity === "warning" ? -1 : 1));
      const severity = hits.some((h) => h.c.severity === "warning") ? "warning" : "info";
      const first = hits[0]!;
      const verb = first.c.relation === "touching" ? "touches" : "overlaps";
      const more = hits.length - 1;
      const textLabel = text.cls.objectKind === "table" ? "Table" : "Text";
      out.push(
        makeFinding({
          area,
          kind: "text-collision",
          severity,
          title:
            `${textLabel} '${text.ref.name}' ${verb} ${LABELS[first.other.cls.objectKind]} '${first.other.ref.name}'` +
            `${more > 0 ? ` and ${more} more object${more > 1 ? "s" : ""}` : ""} on slide ${slide.number}`,
          detail:
            severity === "warning"
              ? "Text that touches or overlaps other objects can look broken on the show screen. Leave at least 2 pt of space or move one of them."
              : "The text sits fully inside or around another object (a caption or overlay); check that it reads well on the show screen.",
          group: "text-collision",
          groupLabel: "Text touching objects",
          count: hits.length,
          targets: [target(text, pres), ...hits.map((h) => target(h.other, pres))],
          fixes: [],
          reachable: false,
          key: `${slide.partName}|${text.ref.shapeId}`,
          data: {
            shapeName: text.ref.name,
            shapeKind: text.ref.kind,
            objectKind: text.cls.objectKind,
            slideNumber: slide.number,
            rotated: text.rotated,
            inherited: text.from !== undefined,
            ...(text.from ? { inheritedFrom: text.from } : {}),
            collisions: hits.map((h) => h.c),
            truncated,
            shapesConsidered: pool.length,
            shapesOnSlide: all.length,
          },
        }),
      );
    }
  }
  return out;
}

export const layoutChecks: Check[] = [
  { id: "layout-partly-off", area, run: ({ pres }) => runPartlyOff(pres) },
  { id: "layout-text-collision", area, run: ({ pres }) => runTextCollisions(pres) },
];
