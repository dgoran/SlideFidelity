/**
 * Joins snapshot (OOXML) identities to live Office.js objects (KTD5).
 *
 * ASSUMED live-ID format (UNVERIFIED; see docs/notes/office-js-platform-behavior.md):
 * - `PowerPoint.Slide.id` is documented only as a string. We assume it starts with the OOXML
 *   `p:sldId/@id` integer, optionally followed by `#` and a creation id, e.g. "256#" or
 *   "256#3241234". We parse the leading integer and ignore the rest.
 * - `PowerPoint.Shape.id` is assumed to be the OOXML `p:cNvPr/@id` integer as a decimal string.
 * If host verification disproves this, only the parse/format functions here change.
 *
 * Every resolution reports HOW it matched. `exact` means an id match; `fallback` means a
 * heuristic (name + position for shapes, slide order for slides). Destructive fixes must refuse
 * anything but `exact` (see `isSafeForDestructiveFix`).
 *
 * All functions are pure; callers load live properties (id, name, left, top, hyperlink address)
 * from the PowerPoint API and pass plain objects in.
 */

export type MatchMethod = "exact" | "fallback";

export type Resolution<T> =
  | { status: "matched"; method: MatchMethod; item: T; index: number }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "not-found" };

/** True only for an id-exact match: the one kind of match a destructive fix may act on. */
export function isSafeForDestructiveFix(r: Resolution<unknown>): boolean {
  return r.status === "matched" && r.method === "exact";
}

const LEADING_INT = /^(\d+)(?:#.*)?$/;
const WHOLE_INT = /^\d+$/;

/** Leading OOXML slide id of a live `Slide.id` ("256#", "256#3241234", "256"), else null. */
export function parseLiveSlideId(live: string): number | null {
  const m = LEADING_INT.exec(live);
  return m ? Number(m[1]) : null;
}

/** Canonical live-form prefix for an OOXML slide id: 256 -> "256#". */
export function formatLiveSlideId(ooxmlSlideId: number): string {
  if (!Number.isSafeInteger(ooxmlSlideId) || ooxmlSlideId < 0) {
    throw new RangeError(`invalid OOXML slide id: ${ooxmlSlideId}`);
  }
  return `${ooxmlSlideId}#`;
}

/** OOXML `p:cNvPr/@id` of a live `Shape.id`, else null. */
export function parseLiveShapeId(live: string): number | null {
  return WHOLE_INT.test(live) ? Number(live) : null;
}

/** OOXML offsets are EMU; Office.js `left`/`top` are points. */
export const EMU_PER_POINT = 12700;
export function emuToPoints(emu: number): number {
  return emu / EMU_PER_POINT;
}

function byId<T extends { id: string }>(
  items: readonly T[],
  wanted: number,
  parse: (id: string) => number | null,
): Array<{ item: T; index: number }> {
  const hits: Array<{ item: T; index: number }> = [];
  items.forEach((item, index) => {
    if (parse(item.id) === wanted) hits.push({ item, index });
  });
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Slides

export interface LiveSlide {
  id: string;
}

export interface SlideTarget {
  /** OOXML `p:sldId/@id`. */
  slideId: number;
  /** 0-based position in the snapshot's slide order, for the fallback. */
  index?: number;
}

/**
 * Match by id. If no id matches, fall back to the same position, but only when the live slide
 * there has an id we cannot parse (i.e. the format assumption failed); a parseable, different id
 * means the slide was deleted or reordered, so we refuse to guess.
 */
export function resolveSlide<T extends LiveSlide>(target: SlideTarget, live: readonly T[]): Resolution<T> {
  const hits = byId(live, target.slideId, parseLiveSlideId);
  if (hits.length === 1) return { status: "matched", method: "exact", ...hits[0]! };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.map((h) => h.item) };

  if (target.index !== undefined) {
    const at = live[target.index];
    if (at && parseLiveSlideId(at.id) === null) {
      return { status: "matched", method: "fallback", item: at, index: target.index };
    }
  }
  return { status: "not-found" };
}

// ---------------------------------------------------------------------------------------------
// Shapes

export interface LiveShape {
  id: string;
  name: string;
  /** Points. */
  left: number;
  /** Points. */
  top: number;
}

export interface ShapeTarget {
  /** OOXML `p:cNvPr/@id`. */
  shapeId: number;
  /** OOXML `p:cNvPr/@name`. */
  name: string;
  /** Points (convert OOXML `a:off` with `emuToPoints`). */
  left: number;
  /** Points. */
  top: number;
}

export interface ResolveShapeOptions {
  /** Max |dx| and |dy| in points for the name + position fallback. Default 1 pt. */
  tolerancePt?: number;
}

/** Resolve a snapshot shape among the live shapes of the already-resolved slide. */
export function resolveShape<T extends LiveShape>(
  target: ShapeTarget,
  live: readonly T[],
  options: ResolveShapeOptions = {},
): Resolution<T> {
  const hits = byId(live, target.shapeId, parseLiveShapeId);
  if (hits.length === 1) return { status: "matched", method: "exact", ...hits[0]! };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.map((h) => h.item) };

  if (!target.name) return { status: "not-found" };
  const tol = options.tolerancePt ?? 1;
  const near: Array<{ item: T; index: number }> = [];
  live.forEach((item, index) => {
    if (
      item.name === target.name &&
      Math.abs(item.left - target.left) <= tol &&
      Math.abs(item.top - target.top) <= tol
    ) {
      near.push({ item, index });
    }
  });
  if (near.length === 1) return { status: "matched", method: "fallback", ...near[0]! };
  if (near.length > 1) return { status: "ambiguous", candidates: near.map((h) => h.item) };
  return { status: "not-found" };
}

// ---------------------------------------------------------------------------------------------
// Hyperlinks
//
// Hyperlinks have no stable id in either model. Join key: (slide id, address, occurrence), where
// occurrence is the 0-based order of this address among the slide's hyperlinks in document order.
// `sameAddressCount` records how many links with that address the snapshot saw on the slide; if
// the live slide has a different count we cannot tell which one is which, so we report ambiguous.

export interface HyperlinkKey {
  slideId: number;
  address: string;
  occurrence: number;
  sameAddressCount: number;
}

export interface LiveHyperlink {
  address: string;
}

/** Build keys for one slide's hyperlink addresses, given in document order. */
export function buildHyperlinkKeys(slideId: number, addresses: readonly string[]): HyperlinkKey[] {
  const totals = new Map<string, number>();
  for (const a of addresses) totals.set(a, (totals.get(a) ?? 0) + 1);
  const seen = new Map<string, number>();
  return addresses.map((address) => {
    const occurrence = seen.get(address) ?? 0;
    seen.set(address, occurrence + 1);
    return { slideId, address, occurrence, sameAddressCount: totals.get(address)! };
  });
}

/** Stable string form of the join key (count excluded: it is a check, not identity). */
export function hyperlinkKeyString(key: HyperlinkKey): string {
  return `${key.slideId}|${key.occurrence}|${key.address}`;
}

/** Match a key among the live hyperlinks of the already-resolved slide, in document order. */
export function matchHyperlink<T extends LiveHyperlink>(key: HyperlinkKey, live: readonly T[]): Resolution<T> {
  const same: Array<{ item: T; index: number }> = [];
  live.forEach((item, index) => {
    if (item.address === key.address) same.push({ item, index });
  });
  if (same.length === 0) return { status: "not-found" };
  if (same.length !== key.sameAddressCount) return { status: "ambiguous", candidates: same.map((h) => h.item) };
  const hit = same[key.occurrence];
  if (!hit) return { status: "not-found" };
  return { status: "matched", method: "exact", ...hit };
}
