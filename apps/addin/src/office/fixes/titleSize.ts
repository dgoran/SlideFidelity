/**
 * Set slide title size (Graphics Ops bulk fix).
 *
 * Targets are the slide title shapes (`p:ph type="title"` / `"ctrTitle"`) listed by the
 * `slide-titles` finding, filtered by placeholder type and slide scope. Apply sets
 * `textFrame.textRange.font.size` on each resolved title (PowerPointApi 1.4). Not destructive: a
 * name + position fallback match is allowed (KTD5).
 *
 * With `alsoLayouts`, the title placeholders of every slide layout (matched by layout name) and
 * slide master (matched by position) are set too, so new slides match. Finding those placeholders
 * needs `Shape.placeholderFormat` (PowerPointApi 1.8); below that they are listed as unreachable.
 */
import type { Finding, FindingOf, FindingTarget } from "@slidefidelity/audit-core";
import {
  containerReason,
  isReachable,
  mergeUnit,
  plannedUnit,
  requiresReason,
  resolveShapes,
  scopeSelector,
  shapeKey,
  supported,
  unitRequirement,
  unitUnreachable,
  unreachable,
  validateScope,
} from "./engine";
import type {
  ApplyIO,
  FixKindDef,
  FixOp,
  PlannedTarget,
  SetTitleSizeParams,
  TargetOutcome,
  TitlePlaceholderType,
  UnreachableTarget,
} from "./types";

export const TITLE_SIZE_MIN = 6;
export const TITLE_SIZE_MAX = 200;
export const TITLE_TYPES: readonly TitlePlaceholderType[] = ["title", "ctrTitle"];

export const SHRINK_NOTE = "PowerPoint may shrink these titles to fit; turn off Shrink text on overflow to see the full size.";
export const LAYOUTS_NOTE = "Slide layouts are matched by name and slide masters by position; new slides use the layout's title size.";
export const LAYOUTS_REASON = `Slide layouts and masters; ${requiresReason("1.8")}`;

/** Office.js `PlaceholderFormat.type` per OOXML `p:ph/@type`. */
const LIVE_TYPE: Record<string, string> = { title: "Title", ctrTitle: "CenterTitle" };

export function validateTitleSize(sizePt: unknown): string | null {
  if (typeof sizePt !== "number" || !Number.isFinite(sizePt)) return "Enter a size in points.";
  if (sizePt < TITLE_SIZE_MIN || sizePt > TITLE_SIZE_MAX) return `Enter a size from ${TITLE_SIZE_MIN} to ${TITLE_SIZE_MAX} pt.`;
  return null;
}

type TitlesFinding = FindingOf<"slide-titles">;
type TitleSizeLayoutOp = Extract<FixOp, { type: "title-size-layout" }>;

function layoutUnit(f: Finding, target: FindingTarget, key: string, op: TitleSizeLayoutOp, label: string): PlannedTarget {
  return {
    key,
    slideId: 0,
    shapeId: 0,
    shapeName: "",
    left: Number.NaN,
    top: Number.NaN,
    path: [],
    label,
    op,
    sources: [target],
    findingIds: [f.id],
    batchKey: "title-size-layouts",
  };
}

function planLayouts(f: TitlesFinding, params: SetTitleSizeParams, types: ReadonlySet<string>): PlannedTarget[] {
  const out: PlannedTarget[] = [];
  const seen = new Set<string>();
  for (const l of f.data.layoutTitles) {
    if (!types.has(l.placeholderType)) continue;
    const key = `layout|${l.name}|${l.placeholderType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target: FindingTarget = { container: { kind: "layout", partName: l.partName, name: l.name } };
    const op: TitleSizeLayoutOp = { type: "title-size-layout", sizePt: params.sizePt, container: "layout", name: l.name, placeholderType: l.placeholderType, fromPt: l.effectiveSizePt };
    out.push(layoutUnit(f, target, key, op, l.name ? `Layout "${l.name}" · title` : "Slide layout · title"));
  }
  // The master title is a "title" placeholder; its size flows to layouts that don't set their own.
  if (types.has("title")) {
    f.data.masterTitles.forEach((m, index) => {
      const target: FindingTarget = { container: { kind: "master", partName: m.partName, ...(m.name ? { name: m.name } : {}) } };
      const op: TitleSizeLayoutOp = {
        type: "title-size-layout",
        sizePt: params.sizePt,
        container: "master",
        name: m.name,
        index,
        count: f.data.masterTitles.length,
        placeholderType: "title",
        fromPt: m.effectiveSizePt,
      };
      const label = m.name ? `Master "${m.name}" · title` : f.data.masterTitles.length > 1 ? `Slide master ${index + 1} · title` : "Slide master · title";
      out.push(layoutUnit(f, target, `master|${index}`, op, label));
    });
  }
  return out;
}

export const setTitleSizeKind: FixKindDef<"set-title-size"> = {
  id: "set-title-size",
  requiredSet: "1.4",
  destructive: false,

  validate(params) {
    const size = validateTitleSize(params.sizePt);
    if (size) return size;
    if (params.placeholderTypes !== undefined) {
      if (params.placeholderTypes.length === 0) return "Choose slide titles, title slides, or both.";
      if (!params.placeholderTypes.every((t) => TITLE_TYPES.includes(t))) return "Choose slide titles, title slides, or both.";
    }
    return validateScope(params.scope, "whose titles to change");
  },

  plan(findings, params, env) {
    const types = new Set<string>(params.placeholderTypes ?? TITLE_TYPES);
    const inScope = scopeSelector(params.scope);
    const units = new Map<string, PlannedTarget>();
    const out: UnreachableTarget[] = [];
    let titles: TitlesFinding | undefined;
    const shrinking = new Set<number>();

    for (const f of findings) {
      if (f.kind !== "slide-titles" || !f.fixes.includes("set-title-size")) continue;
      titles ??= f;
      f.targets.forEach((t, i) => {
        const info = f.data.titles[i];
        const type = info?.placeholderType ?? "title";
        if (!types.has(type) || !inScope(t)) return;
        const op: FixOp = { type: "title-size", sizePt: params.sizePt, fromPt: [...(info?.sizesPt ?? [])], placeholderType: type, autofit: info?.autofit ?? "none" };
        const u = isReachable(f, t) ? plannedUnit(f, t, shapeKey(t), op) : null;
        if (!u) {
          out.push(unreachable(f, t, containerReason(t) ?? "Can't be changed in place"));
          return;
        }
        if (info?.autofit === "shrink") shrinking.add(u.slideNumber ?? u.slideId);
        mergeUnit(units, u);
      });
    }

    const targets: PlannedTarget[] = [];
    for (const u of units.values()) {
      const why = unitRequirement(u, env.isSetSupported);
      if (why) out.push(...unitUnreachable(u, why));
      else targets.push(u);
    }

    const notes: string[] = [];
    if (params.alsoLayouts && titles) {
      const layoutUnits = planLayouts(titles, params, types);
      if (supported(env.isSetSupported, "1.8")) {
        targets.push(...layoutUnits);
        if (layoutUnits.length > 0) notes.push(LAYOUTS_NOTE);
      } else {
        for (const u of layoutUnits) out.push(...unitUnreachable(u, LAYOUTS_REASON));
      }
    }
    if (shrinking.size > 0) notes.push(SHRINK_NOTE);
    return { targets, unreachable: out, notes };
  },

  async apply(context, batch, io, params) {
    const out: TargetOutcome[] = batch.map(() => ({ status: "skipped", reason: "Skipped: not resolved" }));
    const slideIdx: number[] = [];
    const layoutIdx: number[] = [];
    batch.forEach((u, i) => (u.op.type === "title-size-layout" ? layoutIdx : slideIdx).push(i));

    // Reads first (the engine commits the queued writes with its final sync).
    const shapes = slideIdx.length ? await resolveShapes(context, io, slideIdx.map((i) => batch[i]!), { destructive: false }) : [];
    const layouts = layoutIdx.length ? await resolveLayoutTitles(context, io, layoutIdx.map((i) => batch[i]!)) : [];

    shapes.forEach((s, j) => {
      const i = slideIdx[j]!;
      if (s.status !== "ok") {
        out[i] = { status: "skipped", reason: s.reason };
        return;
      }
      s.shape.textFrame.textRange.font.size = params.sizePt;
      out[i] = { status: "changed" };
    });
    layouts.forEach((r, j) => {
      const i = layoutIdx[j]!;
      if (r.status !== "ok") {
        out[i] = { status: "skipped", reason: r.reason };
        return;
      }
      for (const shape of r.shapes) shape.textFrame.textRange.font.size = params.sizePt;
      out[i] = { status: "changed" };
    });
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Layout and master title placeholders (PowerPointApi 1.3 collections, 1.8 placeholderFormat)

type LayoutLookup = { status: "ok"; shapes: PowerPoint.Shape[] } | { status: "skipped"; reason: string };

interface Container {
  shapes: PowerPoint.ShapeCollection;
}

async function resolveLayoutTitles(context: PowerPoint.RequestContext, io: ApplyIO, units: readonly PlannedTarget[]): Promise<LayoutLookup[]> {
  if (!supported(io.isSetSupported, "1.8")) return units.map(() => ({ status: "skipped", reason: `Skipped: ${LAYOUTS_REASON}` }));

  const masters = context.presentation.slideMasters;
  masters.load("items/id,items/name");
  await io.sync();
  const layoutCols = masters.items.map((m) => {
    const c = m.layouts;
    c.load("items/id,items/name");
    return c;
  });
  await io.sync();

  // Containers per unit.
  const perUnit: (Container[] | string)[] = units.map((u) => {
    const op = u.op as TitleSizeLayoutOp;
    if (op.container === "master") {
      if (op.count !== undefined && op.count !== masters.items.length) return "Skipped: the slide masters changed since the scan";
      const m = op.index !== undefined ? masters.items[op.index] : undefined;
      return m ? [m] : "Skipped: the slide master no longer exists";
    }
    const matches = layoutCols.flatMap((c) => c.items.filter((l) => l.name === op.name));
    return matches.length ? matches : "Skipped: no slide layout with this name";
  });

  // Shapes of every distinct container, then placeholder types of placeholder shapes.
  const shapeCols = new Map<Container, PowerPoint.ShapeCollection>();
  for (const list of perUnit) {
    if (typeof list === "string") continue;
    for (const c of list) {
      if (shapeCols.has(c)) continue;
      const col = c.shapes;
      col.load("items/id,items/name,items/type");
      shapeCols.set(c, col);
    }
  }
  if (shapeCols.size === 0) return perUnit.map((p) => ({ status: "skipped", reason: typeof p === "string" ? p : "Skipped" }));
  await io.sync();
  const placeholders = new Map<Container, { shape: PowerPoint.Shape; format: PowerPoint.PlaceholderFormat }[]>();
  for (const [c, col] of shapeCols) {
    const list = col.items
      .filter((s) => s.type === "Placeholder")
      .map((shape) => {
        const format = shape.placeholderFormat;
        format.load("type");
        return { shape, format };
      });
    placeholders.set(c, list);
  }
  await io.sync();

  return perUnit.map((p, i): LayoutLookup => {
    if (typeof p === "string") return { status: "skipped", reason: p };
    const op = units[i]!.op as TitleSizeLayoutOp;
    const want = LIVE_TYPE[op.placeholderType] ?? "Title";
    const shapes = p.flatMap((c) => (placeholders.get(c) ?? []).filter((x) => x.format.type === want).map((x) => x.shape));
    return shapes.length ? { status: "ok", shapes } : { status: "skipped", reason: "Skipped: the title placeholder no longer exists" };
  });
}
