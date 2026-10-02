/**
 * Slide-space rectangle math for the layout checks (partly off-slide objects, text touching
 * other objects). Everything is in EMU on axis-aligned `Bounds`.
 *
 * `ShapeRef.bounds` ignores rotation and flips (its own and its ancestor groups'), so
 * `visualBounds` re-applies them to get the axis-aligned box the shape actually covers.
 */
import type { Bounds, ShapeRef, Xfrm } from "./package/shapes";

export const EMU_PER_INCH = 914400;
export const EMU_PER_PT = 12700;
/** One full turn in OOXML angle units (60,000ths of a degree). */
const FULL_TURN = 21600000;
const HALF_TURN = 10800000;

export function right(b: Bounds): number {
  return b.x + b.cx;
}

export function bottom(b: Bounds): number {
  return b.y + b.cy;
}

export function area(b: Bounds): number {
  return Math.max(0, b.cx) * Math.max(0, b.cy);
}

/** The overlapping rectangle of `a` and `b`, or undefined when they share no positive area. */
export function intersection(a: Bounds, b: Bounds): Bounds | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(right(a), right(b));
  const btm = Math.min(bottom(a), bottom(b));
  if (r <= x || btm <= y) return undefined;
  return { x, y, cx: r - x, cy: btm - y };
}

/**
 * Shortest distance between the two rectangles' edges (0 when they touch or overlap). Diagonal
 * separations use the corner-to-corner distance.
 */
export function gap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, b.x - right(a), a.x - right(b));
  const dy = Math.max(0, b.y - bottom(a), a.y - bottom(b));
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

/** True when `inner` lies entirely inside `outer`, allowing `tolerance` EMU of slack per edge. */
export function contains(outer: Bounds, inner: Bounds, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    right(inner) <= right(outer) + tolerance &&
    bottom(inner) <= bottom(outer) + tolerance
  );
}

export type Side = "left" | "right" | "top" | "bottom";

export interface Overflow {
  side: Side;
  /** How far the bounds extend past that slide edge, in EMU (> 0). */
  emu: number;
}

/** Slide edges the bounds extend past by more than `tolerance` EMU. */
export function overflow(b: Bounds, slideW: number, slideH: number, tolerance = 0): Overflow[] {
  const out: Overflow[] = [];
  const add = (side: Side, emu: number): void => {
    if (emu > tolerance) out.push({ side, emu });
  };
  add("left", -b.x);
  add("right", right(b) - slideW);
  add("top", -b.y);
  add("bottom", bottom(b) - slideH);
  return out;
}

/** True when the bounds share no area with the slide (same rule as the `off-slide-shape` check). */
export function fullyOutside(b: Bounds, slideW: number, slideH: number): boolean {
  return b.x >= slideW || right(b) <= 0 || b.y >= slideH || bottom(b) <= 0;
}

/**
 * Fraction (0–1) of the shape's area outside the slide. Zero-width / zero-height shapes (lines)
 * are measured as 1-EMU-thick strips so a line half off the slide reports 0.5.
 */
export function offSlideFraction(b: Bounds, slideW: number, slideH: number): number {
  const solid: Bounds = { x: b.x, y: b.y, cx: Math.max(1, b.cx), cy: Math.max(1, b.cy) };
  const on = intersection(solid, { x: 0, y: 0, cx: slideW, cy: slideH });
  return 1 - (on ? area(on) : 0) / area(solid);
}

/** True for a rotation (60,000ths of a degree) that changes the box, i.e. not a multiple of 180°. */
export function isRotated(rot: number | undefined): boolean {
  if (!rot) return false;
  return ((rot % HALF_TURN) + HALF_TURN) % HALF_TURN !== 0;
}

type Pt = [number, number];

function corners(b: Bounds): Pt[] {
  return [
    [b.x, b.y],
    [right(b), b.y],
    [right(b), bottom(b)],
    [b.x, bottom(b)],
  ];
}

function center(b: Bounds): Pt {
  return [b.x + b.cx / 2, b.y + b.cy / 2];
}

/** Applies an xfrm's flips then rotation about the centre of `frame` (slide space) to `pts`. */
function applyXfrm(pts: Pt[], frame: Bounds, x: Pick<Xfrm, "rot" | "flipH" | "flipV">): Pt[] {
  const [cx, cy] = center(frame);
  let out = pts;
  if (x.flipH) out = out.map(([px, py]) => [2 * cx - px, py]);
  if (x.flipV) out = out.map(([px, py]) => [px, 2 * cy - py]);
  const rot = (x.rot ?? 0) % FULL_TURN;
  if (rot !== 0) {
    const rad = (rot / 60000) * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    out = out.map(([px, py]) => {
      const dx = px - cx;
      const dy = py - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    });
  }
  return out;
}

function boxOf(pts: Pt[]): Bounds {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, cx: Math.max(...xs) - x, cy: Math.max(...ys) - y };
}

/** Axis-aligned bounding box of `b` rotated by `rot` (60,000ths of a degree) about its centre. */
export function rotatedBounds(b: Bounds, rot: number | undefined): Bounds {
  if (!isRotated(rot)) return b;
  return round(boxOf(applyXfrm(corners(b), b, { rot: rot ?? 0 })));
}

function round(b: Bounds): Bounds {
  const x = Math.round(b.x) + 0; // + 0 normalizes -0
  const y = Math.round(b.y) + 0;
  return { x, y, cx: Math.round(b.x + b.cx) - x + 0, cy: Math.round(b.y + b.cy) - y + 0 };
}

export interface VisualBounds {
  bounds: Bounds;
  /** The shape or one of its ancestor groups is rotated (not a multiple of 180°). */
  rotated: boolean;
}

/**
 * The axis-aligned slide-space box a shape covers once its own rotation and its ancestor groups'
 * flips / rotations are applied. `base` is the shape's slide-space bounds (its own, or inherited
 * from a layout / master placeholder); `byId` maps the container's shape ids to refs so ancestors
 * can be found through `ref.path`.
 */
export function visualBounds(ref: ShapeRef, base: Bounds, byId: ReadonlyMap<number, ShapeRef>): VisualBounds {
  let rotated = isRotated(ref.xfrm?.rot);
  let pts = corners(base);
  let changed = false;
  if (ref.xfrm && (ref.xfrm.rot || ref.xfrm.flipH || ref.xfrm.flipV)) {
    // A shape's own flip does not move its box; only rotation does.
    if (ref.xfrm.rot) {
      pts = applyXfrm(pts, base, { rot: ref.xfrm.rot });
      changed = true;
    }
  }
  // Innermost ancestor first: each group's transform acts in its parent's (unrotated) space.
  for (let i = ref.path.length - 1; i >= 0; i--) {
    const anc = byId.get(ref.path[i]!);
    if (!anc || anc.kind !== "grpSp" || !anc.xfrm || !anc.bounds) continue;
    const { rot, flipH, flipV } = anc.xfrm;
    if (!rot && !flipH && !flipV) continue;
    if (isRotated(rot)) rotated = true;
    pts = applyXfrm(pts, anc.bounds, { ...(rot !== undefined ? { rot } : {}), ...(flipH ? { flipH } : {}), ...(flipV ? { flipV } : {}) });
    changed = true;
  }
  return { bounds: changed ? round(boxOf(pts)) : base, rotated };
}

export function emuToInches(emu: number): number {
  return Math.round((emu / EMU_PER_INCH) * 1000) / 1000;
}

export function emuToPoints(emu: number): number {
  return Math.round((emu / EMU_PER_PT) * 10) / 10;
}
