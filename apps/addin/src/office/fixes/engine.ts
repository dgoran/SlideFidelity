/**
 * Fix engine (U12): plan → preview → rescan-check → batched apply → summary.
 *
 * - Capability first (KTD4): a kind whose requirement set the host lacks is blocked with a reason.
 * - D4: every run re-reads the file via the injected `rescanForFix()`. If the file changed since
 *   the preview, the plan is rebuilt from the new findings and returned for re-preview; nothing is
 *   written. Otherwise the plan is rebuilt from those (cached) findings and applied.
 * - Apply runs in batches of ~25 units, one `PowerPoint.run` per batch. Each unit is re-resolved in
 *   the live model (KTD5, ids.ts). Destructive kinds refuse name+position fallbacks.
 * - Office.js batches are not atomic: when the commit sync of a batch throws, that batch's queued
 *   units are reported `unknown`, and the engine moves on to the next batch.
 * - Cancellation is checked between batches.
 */
import type { Finding, FindingTarget } from "@slidecheck/audit-core";
import { targetKey } from "@slidecheck/audit-core";
import { emuToPoints, isSafeForDestructiveFix, resolveShape, resolveSlide, type Resolution } from "../ids";
import type {
  ApplyIO,
  FixKindDef,
  FixKindId,
  FixOp,
  FixParamsMap,
  FixPlan,
  FixSummary,
  IsSetSupported,
  PlanEnv,
  PlannedTarget,
  PreviewResult,
  RunFixDeps,
  RunFixResult,
  SlideCount,
  TargetOutcome,
  TargetResult,
  TargetSelection,
  UnreachableTarget,
} from "./types";

export const BATCH_SIZE = 25;

export const UNDO_NOTE =
  "PowerPoint's undo history may not capture changes made by add-ins. Save a copy first if you may want to go back.";

export function requiresReason(version: string): string {
  return `Requires a newer version of PowerPoint (PowerPointApi ${version})`;
}

// ---------------------------------------------------------------------------------------------
// Preview

export function previewFix<K extends FixKindId>(
  kind: FixKindDef<K>,
  findings: readonly Finding[],
  params: FixParamsMap[K],
  env: PlanEnv,
): PreviewResult<K> {
  if (!supported(env.isSetSupported, kind.requiredSet)) {
    return { status: "blocked", reason: requiresReason(kind.requiredSet), requiredSet: kind.requiredSet };
  }
  const invalid = kind.validate(params);
  if (invalid !== null) return { status: "invalid", reason: invalid };
  return { status: "ready", plan: buildPlan(kind, findings, params, env) };
}

function supported(isSetSupported: IsSetSupported, version: string): boolean {
  try {
    return isSetSupported(version);
  } catch {
    return false;
  }
}

function buildPlan<K extends FixKindId>(kind: FixKindDef<K>, findings: readonly Finding[], params: FixParamsMap[K], env: PlanEnv): FixPlan<K> {
  const kp = kind.plan(findings, params, env);
  return {
    kind: kind.id,
    params,
    destructive: kind.destructive,
    targets: kp.targets,
    unreachable: kp.unreachable,
    perSlide: perSlide(kp.targets),
    notes: [UNDO_NOTE, ...(kp.notes ?? [])],
  };
}

function perSlide(targets: readonly PlannedTarget[]): SlideCount[] {
  const by = new Map<number, SlideCount & { order: number }>();
  for (const t of targets) {
    const c = by.get(t.slideId);
    if (c) c.count += 1;
    else {
      const entry: SlideCount & { order: number } = { slideId: t.slideId, count: 1, order: t.slideNumber ?? t.slideIndex ?? Number.MAX_SAFE_INTEGER };
      if (t.slideNumber !== undefined) entry.slideNumber = t.slideNumber;
      by.set(t.slideId, entry);
    }
  }
  return [...by.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...c }) => c);
}

// ---------------------------------------------------------------------------------------------
// Batching

/**
 * Split units into batches of about `size`. Units sharing a `batchKey` always land in the same
 * batch (a batch may exceed `size` for that). Order follows each group's first unit.
 */
export function makeBatches(targets: readonly PlannedTarget[], size = BATCH_SIZE): PlannedTarget[][] {
  const groups: PlannedTarget[][] = [];
  const byKey = new Map<string, PlannedTarget[]>();
  for (const t of targets) {
    if (t.batchKey === undefined) {
      groups.push([t]);
      continue;
    }
    const g = byKey.get(t.batchKey);
    if (g) g.push(t);
    else {
      const ng = [t];
      byKey.set(t.batchKey, ng);
      groups.push(ng);
    }
  }
  const batches: PlannedTarget[][] = [];
  let cur: PlannedTarget[] = [];
  for (const g of groups) {
    if (cur.length > 0 && cur.length + g.length > size) {
      batches.push(cur);
      cur = [];
    }
    cur.push(...g);
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

// ---------------------------------------------------------------------------------------------
// Run

export async function runFix<K extends FixKindId>(kind: FixKindDef<K>, params: FixParamsMap[K], deps: RunFixDeps): Promise<RunFixResult<K>> {
  const env: PlanEnv = { isSetSupported: deps.isSetSupported };
  if (!supported(deps.isSetSupported, kind.requiredSet)) {
    return { status: "blocked", reason: requiresReason(kind.requiredSet), requiredSet: kind.requiredSet };
  }
  const invalid = kind.validate(params);
  if (invalid !== null) return { status: "invalid", reason: invalid };

  const rescan = await deps.rescanForFix();
  const plan = buildPlan(kind, rescan.result.findings, params, env);
  if (rescan.changed) return { status: "replanned", plan, hash: rescan.hash };

  const batches = makeBatches(plan.targets, deps.batchSize ?? BATCH_SIZE);
  const results: TargetResult[] = [];
  const notRun: PlannedTarget[] = [];
  let completedBatches = 0;
  let cancelled = false;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    if (deps.signal?.aborted) {
      cancelled = true;
      for (const rest of batches.slice(b)) notRun.push(...rest);
      break;
    }
    const outcomes = await applyBatch(kind, batch, params, deps);
    batch.forEach((target, i) => results.push({ target, ...outcomes[i]! }));
    completedBatches += 1;
    deps.onProgress?.({ batch: b + 1, batches: batches.length, done: results.length, total: plan.targets.length });
  }
  if (completedBatches > 0) deps.onApplied?.();

  const pick = (s: TargetOutcome["status"]) => results.filter((r) => r.status === s);
  const summary: FixSummary<K> = {
    plan,
    results,
    changed: pick("changed").length,
    skipped: pick("skipped"),
    failed: pick("failed"),
    unknown: pick("unknown"),
    notRun,
    unreachable: plan.unreachable,
    batches: batches.length,
    completedBatches,
    preFixBytes: rescan.bytes,
    preFixHash: rescan.hash,
  };
  return { status: cancelled ? "cancelled" : "completed", summary };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function applyBatch<K extends FixKindId>(
  kind: FixKindDef<K>,
  batch: readonly PlannedTarget[],
  params: FixParamsMap[K],
  deps: RunFixDeps,
): Promise<TargetOutcome[]> {
  let planned: TargetOutcome[] | undefined;
  try {
    await deps.run(async (context) => {
      const io: ApplyIO = { sync: () => context.sync(), isSetSupported: deps.isSetSupported };
      const out = await kind.apply(context, batch, io, params);
      if (out.length !== batch.length) throw new Error(`fix ${kind.id} returned ${out.length} outcomes for ${batch.length} targets`);
      planned = out;
      await context.sync(); // commit
    });
    return planned!;
  } catch (e) {
    const msg = errorMessage(e);
    if (!planned) {
      return batch.map(() => ({ status: "failed", reason: `Nothing was changed: ${msg}` }));
    }
    return planned.map((o) =>
      o.status === "changed"
        ? { status: "unknown", reason: `PowerPoint reported an error while applying this batch; this item may or may not have changed (${msg}). Rescan to check.` }
        : o,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Plan helpers for kinds

/** Whether a finding target is reachable by in-place fixes (per-target override, else finding). */
export function isReachable(f: Finding, t: FindingTarget): boolean {
  return t.reachable === true || (t.reachable === undefined && f.reachable === true);
}

/** "Slide 3 · Title 1 (cell 2,1)" / "Layout "Title Slide" · Rectangle 4". */
export function targetLabel(t: FindingTarget): string {
  const c = t.container;
  let where: string;
  switch (c.kind) {
    case "slide":
      where = `Slide ${c.slideNumber ?? "?"}`;
      break;
    case "layout":
      where = c.name ? `Layout "${c.name}"` : "Slide layout";
      break;
    case "master":
      where = c.name ? `Master "${c.name}"` : "Slide master";
      break;
    case "theme":
      where = c.name ? `Theme "${c.name}"` : "Theme";
      break;
    case "chart":
    case "diagram":
      where = c.slideNumber !== undefined ? `Slide ${c.slideNumber}` : c.kind === "chart" ? "Chart" : "SmartArt";
      break;
    default:
      where = c.slideNumber !== undefined ? `Slide ${c.slideNumber}` : c.partName;
  }
  const parts = [where];
  if (t.shapeName) parts.push(t.shapeName);
  let label = parts.join(" · ");
  const cell = t.locator?.cell;
  if (cell) label += ` (cell ${cell.row + 1},${cell.col + 1})`;
  return label;
}

/** Reason for a target outside slide shapes, else null. */
export function containerReason(t: FindingTarget): string | null {
  switch (t.container.kind) {
    case "slide":
      return null;
    case "layout":
    case "master":
      return "On a slide layout or master; only slide content can be changed in place";
    case "chart":
      return "Inside a chart; PowerPoint's API can't change chart text or colors";
    case "diagram":
      return "Inside SmartArt; PowerPoint's API can't change SmartArt content";
    case "theme":
      return "Theme default; change the theme instead";
    case "presentation":
      return "Presentation default text style; not reachable in place";
    default:
      return "Not on a slide; can't be changed in place";
  }
}

export function unreachable(f: Finding, t: FindingTarget, reason: string): UnreachableTarget {
  return { target: t, findingId: f.id, label: targetLabel(t), reason };
}

/**
 * Build a planned unit for a slide shape target, or null when the target is not a slide shape
 * (the caller reports it unreachable).
 */
export function plannedUnit(f: Finding, t: FindingTarget, key: string, op: FixOp): PlannedTarget | null {
  const c = t.container;
  if (c.kind !== "slide" || c.slideId === undefined || t.shapeId === undefined) return null;
  const u: PlannedTarget = {
    key,
    slideId: c.slideId,
    shapeId: t.shapeId,
    shapeName: t.shapeName ?? "",
    left: t.bounds ? emuToPoints(t.bounds.x) : Number.NaN,
    top: t.bounds ? emuToPoints(t.bounds.y) : Number.NaN,
    path: [...(t.path ?? [])],
    label: targetLabel(t),
    op,
    sources: [t],
    findingIds: [f.id],
  };
  if (c.slideIndex !== undefined) u.slideIndex = c.slideIndex;
  if (c.slideNumber !== undefined) u.slideNumber = c.slideNumber;
  return u;
}

/** Shape identity key: slide + ancestor path + shape id. */
export function shapeKey(t: FindingTarget): string {
  return `${t.container.slideId ?? t.container.partName}|${(t.path ?? []).join("/")}|${t.shapeId ?? ""}`;
}

/** Merge a unit into `units` by key (adds its source and finding id to an existing unit). */
export function mergeUnit(units: Map<string, PlannedTarget>, u: PlannedTarget): void {
  const existing = units.get(u.key);
  if (!existing) {
    units.set(u.key, u);
    return;
  }
  existing.sources.push(...u.sources);
  for (const id of u.findingIds) if (!existing.findingIds.includes(id)) existing.findingIds.push(id);
}

/**
 * Requirement sets for reaching a unit beyond the kind's base set: groups need 1.8
 * (`Shape.group`), table cells need 1.9 (`TableCell.font` / `fill`). Returns a reason or null.
 */
export function unitRequirement(u: PlannedTarget, isSetSupported: IsSetSupported): string | null {
  const cell = "cell" in u.op;
  if (cell && !supported(isSetSupported, "1.9")) return `Table cell; ${requiresReason("1.9")}`;
  if (u.path.length > 0 && !supported(isSetSupported, "1.8")) return `Inside a group; ${requiresReason("1.8")}`;
  return null;
}

/** Filter (finding, target) pairs by a `TargetSelection`. */
export function selected(selection: TargetSelection | Partial<{ findingIds: string[]; targetKeys: string[] }>, f: Finding, t: FindingTarget): boolean {
  if ("all" in selection && selection.all) return true;
  if ("findingIds" in selection && selection.findingIds) return selection.findingIds.includes(f.id);
  if ("targetKeys" in selection && selection.targetKeys) return selection.targetKeys.includes(targetKey(t));
  return true;
}

// ---------------------------------------------------------------------------------------------
// Live resolution helpers for kinds (KTD5)

export type SlideLookup = { status: "ok"; slide: PowerPoint.Slide } | { status: "skipped"; reason: string };
export type ShapeLookup = { status: "ok"; shape: PowerPoint.Shape; slide: PowerPoint.Slide } | { status: "skipped"; reason: string };

export const IDENTITY_UNCERTAIN = "Skipped: identity uncertain (matched only by name and position, not by id)";

function lookupFailure(r: Resolution<unknown>, what: "slide" | "shape"): string {
  if (r.status === "ambiguous") return `Skipped: more than one ${what} matches`;
  return what === "slide" ? "Skipped: the slide no longer exists" : "Skipped: the shape no longer exists";
}

/** Resolve each unit's slide. One sync. */
export async function resolveSlides(
  context: PowerPoint.RequestContext,
  io: ApplyIO,
  units: readonly PlannedTarget[],
  opts: { destructive: boolean },
): Promise<SlideLookup[]> {
  const slides = context.presentation.slides;
  slides.load("items/id");
  await io.sync();
  const live = slides.items;
  return units.map((u) => {
    const r = resolveSlide({ slideId: u.slideId, ...(u.slideIndex !== undefined ? { index: u.slideIndex } : {}) }, live);
    if (r.status !== "matched") return { status: "skipped", reason: lookupFailure(r, "slide") };
    if (opts.destructive && !isSafeForDestructiveFix(r)) return { status: "skipped", reason: IDENTITY_UNCERTAIN };
    return { status: "ok", slide: r.item };
  });
}

const SHAPE_LOAD = "items/id,items/name,items/left,items/top";

/**
 * Resolve each unit's shape: the slide, then each ancestor group by exact id (1.8), then the shape
 * by id with the name + position fallback. Destructive kinds get `IDENTITY_UNCERTAIN` for any
 * fallback match. One sync per nesting level (plus one for slides).
 */
export async function resolveShapes(
  context: PowerPoint.RequestContext,
  io: ApplyIO,
  units: readonly PlannedTarget[],
  opts: { destructive: boolean },
): Promise<ShapeLookup[]> {
  const slideLookups = await resolveSlides(context, io, units, opts);
  const out: (ShapeLookup | undefined)[] = units.map(() => undefined);
  type LiveShapes = PowerPoint.ShapeCollection | PowerPoint.ShapeScopedCollection;
  interface Pending {
    i: number;
    slide: PowerPoint.Slide;
    collection: LiveShapes;
    depth: number;
  }
  let pending: Pending[] = [];
  const slideCollections = new Map<PowerPoint.Slide, PowerPoint.ShapeCollection>();
  slideLookups.forEach((s, i) => {
    if (s.status !== "ok") {
      out[i] = s;
      return;
    }
    let col = slideCollections.get(s.slide);
    if (!col) {
      col = s.slide.shapes;
      col.load(SHAPE_LOAD);
      slideCollections.set(s.slide, col);
    }
    pending.push({ i, slide: s.slide, collection: col, depth: 0 });
  });

  while (pending.length > 0) {
    await io.sync();
    const next: Pending[] = [];
    const groupCollections = new Map<PowerPoint.Shape, LiveShapes>();
    for (const p of pending) {
      const u = units[p.i]!;
      const chain = [...u.path, u.shapeId];
      const last = p.depth === chain.length - 1;
      const wanted = chain[p.depth]!;
      // Ancestors carry no name/position: they match by exact id only.
      const r = resolveShape(
        last ? { shapeId: wanted, name: u.shapeName, left: u.left, top: u.top } : { shapeId: wanted, name: "", left: Number.NaN, top: Number.NaN },
        p.collection.items,
      );
      if (r.status !== "matched") {
        out[p.i] = { status: "skipped", reason: last ? lookupFailure(r, "shape") : "Skipped: the containing group no longer exists" };
        continue;
      }
      if (opts.destructive && !isSafeForDestructiveFix(r)) {
        out[p.i] = { status: "skipped", reason: IDENTITY_UNCERTAIN };
        continue;
      }
      if (last) {
        out[p.i] = { status: "ok", shape: r.item, slide: p.slide };
        continue;
      }
      let col = groupCollections.get(r.item);
      if (!col) {
        col = r.item.group.shapes;
        col.load(SHAPE_LOAD);
        groupCollections.set(r.item, col);
      }
      next.push({ i: p.i, slide: p.slide, collection: col, depth: p.depth + 1 });
    }
    pending = next;
  }
  return out.map((o) => o ?? { status: "skipped", reason: "Skipped: the shape could not be resolved" });
}

// ---------------------------------------------------------------------------------------------
// Mixed-range bisection (fonts and text colors)

export interface MatchedRanges {
  /** The whole range has one value and it matches: set the property on the root range. */
  whole: boolean;
  /** Maximal matching [start, length] ranges when the root is mixed. */
  ranges: Array<[number, number]>;
}

const MAX_BISECT_ROUNDS = 48;

/**
 * For each root text range, find where `font[prop]` satisfies `match`. A uniform root is decided
 * from one read; a mixed one (`null`/`""`) is split in halves with `getSubstring` until each piece
 * is uniform. Loads for all roots go into the same syncs (one per bisection depth). Reads only.
 */
export async function findFontRanges(
  io: ApplyIO,
  roots: readonly PowerPoint.TextRange[],
  prop: "name" | "color",
  match: (value: string) => boolean,
): Promise<MatchedRanges[]> {
  const results: MatchedRanges[] = roots.map(() => ({ whole: false, ranges: [] }));
  if (roots.length === 0) return results;
  for (const r of roots) {
    r.load("text");
    r.font.load(prop);
  }
  await io.sync();

  interface Seg {
    root: number;
    start: number;
    length: number;
    range?: PowerPoint.TextRange;
  }
  let frontier: Seg[] = [];
  const halves = (root: number, start: number, length: number): Seg[] => {
    const h = Math.ceil(length / 2);
    return [
      { root, start, length: h },
      { root, start: start + h, length: length - h },
    ];
  };
  roots.forEach((r, i) => {
    const v = r.font[prop];
    if (v) {
      if (match(v)) results[i]!.whole = true;
    } else if (r.text.length > 1) {
      frontier.push(...halves(i, 0, r.text.length));
    }
  });

  for (let round = 0; frontier.length > 0; round++) {
    if (round >= MAX_BISECT_ROUNDS) throw new Error("text formatting bisection did not converge");
    for (const s of frontier) {
      s.range = roots[s.root]!.getSubstring(s.start, s.length);
      s.range.font.load(prop);
    }
    await io.sync();
    const next: Seg[] = [];
    for (const s of frontier) {
      const v = s.range!.font[prop];
      if (v) {
        if (match(v)) results[s.root]!.ranges.push([s.start, s.length]);
      } else if (s.length > 1) {
        next.push(...halves(s.root, s.start, s.length));
      }
    }
    frontier = next;
  }

  for (const r of results) {
    r.ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [s, l] of r.ranges) {
      const prev = merged[merged.length - 1];
      if (prev && prev[0] + prev[1] === s) prev[1] += l;
      else merged.push([s, l]);
    }
    r.ranges = merged;
  }
  return results;
}
