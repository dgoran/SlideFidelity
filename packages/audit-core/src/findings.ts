/**
 * The findings contract (U4) shared by every check (U5–U9), the task-pane tree (U10), the
 * Inspector (U11), gating (U15), and the fix engine (U12/U13).
 *
 * Everything here is plain data so a whole `AuditResult` survives `structuredClone` / `postMessage`
 * out of the Web Worker (KTD3): no class instances, functions, Maps, Sets, or `XmlElement` nodes.
 *
 * Per-kind payloads: each check module registers its kinds by augmenting `FindingDataMap`, e.g.
 *
 * ```ts
 * declare module "../findings" {
 *   interface FindingDataMap {
 *     "font-usage": FontUsageData;
 *   }
 * }
 * ```
 *
 * `Finding` is then a discriminated union keyed by `kind`, so `if (f.kind === "font-usage")`
 * narrows `f.data` to `FontUsageData`.
 */
import type { Presentation, SlideInfo } from "./package/model";
import type { Bounds, ContainerKind, ShapeRef } from "./package/shapes";

// ---------------------------------------------------------------------------------------------
// Areas, severities, fixes

/** Audit areas in the fixed display / progress order. */
export const AREAS = ["overview", "fonts", "colors", "media", "masters", "links", "review"] as const;
export type Area = (typeof AREAS)[number];

/**
 * `warning` = a flag (R1), `info` = a dot (R1), `error` = the check itself failed (`check-failed`).
 */
export type Severity = "error" | "warning" | "info";

/** Fix kinds the fix engine (U12/U13) implements. A finding lists the ones that apply to it. */
export type FixKind = "replace-font" | "replace-color" | "delete-shapes" | "remove-hyperlink" | "edit-hyperlink";

// ---------------------------------------------------------------------------------------------
// Targets

/**
 * Where a target lives. Shape-tree containers (`slide`/`layout`/`master`) come from `ShapeRef`;
 * the others point at a non-shape part (a chart, SmartArt drawing, theme, notes, comments,
 * a media part, presentation.xml, or docProps) for findings that are not about a shape.
 */
export type TargetContainerKind =
  | ContainerKind
  | "notes"
  | "comments"
  | "chart"
  | "diagram"
  | "theme"
  | "media"
  | "presentation"
  | "properties"
  | "part";

export interface TargetContainer {
  kind: TargetContainerKind;
  /** Canonical zip path without a leading slash, e.g. `ppt/slides/slide1.xml`. */
  partName: string;
  /** `p:sldId/@id` of the slide (KTD5 join key); set for slides and slide-owned parts. */
  slideId?: number;
  /** 0-based slide position at scan time (fallback for `resolveSlide`). */
  slideIndex?: number;
  /** 1-based slide number as PowerPoint shows it. */
  slideNumber?: number;
  /** Layout / master name, for "located on layout X" notes (U10). */
  name?: string;
}

/** Which formatting property of a shape a target refers to (per-property fixes, U13). */
export type TargetProperty =
  | "fill"
  | "line"
  | "text"
  | "effect"
  | "bullet"
  | "list-style"
  | "table-cell"
  | "hyperlink"
  | "image"
  | "placeholder"
  | "other";

/** Hyperlink join key (see `apps/addin/src/office/ids.ts` `HyperlinkKey`). */
export interface HyperlinkLocator {
  address: string;
  /** 0-based order of this address among the slide's hyperlinks, document order. */
  occurrence: number;
  /** How many hyperlinks with this address the snapshot saw on the slide. */
  sameAddressCount: number;
}

/** Sub-shape locator for run-/property-level findings. All fields optional. */
export interface TargetLocator {
  property?: TargetProperty;
  /** 0-based `a:p` index in the shape's text body (or in the table cell). */
  paragraphIndex?: number;
  /** 0-based `a:r` index within the paragraph. */
  runIndex?: number;
  /** Table cell, 0-based. */
  cell?: { row: number; col: number };
  /** Font script slot for font findings. */
  script?: "latin" | "ea" | "cs" | "sym" | "bu";
  /** List-style level (1–9) for `a:lstStyle` / text-style findings. */
  level?: number;
  /** Relationship id in the container's rels (links, media, charts). */
  relId?: string;
  hyperlink?: HyperlinkLocator;
}

/**
 * A serializable reference to what a finding is about, derived from `ShapeRef` (use
 * `shapeTarget`) or a part (use `slideTarget` / `partTarget`).
 */
export interface FindingTarget {
  container: TargetContainer;
  /** `p:cNvPr/@id` (KTD5). Absent for part-level targets. */
  shapeId?: number;
  /** `p:cNvPr/@name`, for the name + position fallback. */
  shapeName?: string;
  /** Ancestor group / graphic-frame shape ids, outermost first. */
  path?: number[];
  /** Slide-space bounds in EMU (fallback matching, off-slide checks, Inspector). */
  bounds?: Bounds;
  locator?: TargetLocator;
  /** Per-target override of `Finding.reachable` (e.g. one chart usage among 40 direct runs). */
  reachable?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Findings

/** Payload of the runner's own `check-failed` finding. */
export interface CheckFailedData {
  checkId: string;
  message: string;
  /** Error name (e.g. `TypeError`), when available. */
  errorName?: string;
}

/**
 * Registry of finding kinds → `data` payload type. Check modules add their kinds via module
 * augmentation (see the file header). Keys are kebab-case, unique across all areas.
 */
export interface FindingDataMap {
  "check-failed": CheckFailedData;
}

export type FindingKind = keyof FindingDataMap;

interface FindingBase {
  /** Deterministic: `${area}:${kind}:${hash(key)}`. Same deck + options ⇒ same ids. */
  id: string;
  area: Area;
  severity: Severity;
  title: string;
  detail?: string;
  /** UI grouping key within the area: the font name, the color hex, the media part, … */
  group: string;
  /** Display label for the group when it differs from the key (e.g. "Calibri (theme body)"). */
  groupLabel?: string;
  /** Occurrence count to show next to the finding, when it aggregates usages. */
  count?: number;
  targets: FindingTarget[];
  /** Fix kinds applicable to this finding; empty for read-only findings. */
  fixes: FixKind[];
  /**
   * Whether the in-place fix engine can reach this finding's targets at all. `undefined` means
   * "not applicable" (no fixes). Individual targets may override via `FindingTarget.reachable`.
   */
  reachable?: boolean;
}

/** A finding of one specific kind. */
export type FindingOf<K extends FindingKind> = FindingBase & { kind: K; data: FindingDataMap[K] };

/** Discriminated union over every registered kind. */
export type Finding = { [K in FindingKind]: FindingOf<K> }[FindingKind];

/** Input to `makeFinding`: everything but `id`, plus an optional explicit identity key. */
export type FindingInput<K extends FindingKind> = Omit<FindingOf<K>, "id"> & {
  /**
   * Identity key within `area:kind`. Defaults to `group` + the sorted target keys. Pass one when
   * two findings of the same kind would otherwise share group and targets.
   */
  key?: string;
};

// ---------------------------------------------------------------------------------------------
// Ids

/** 53-bit string hash (cyrb53), rendered base-36. Deterministic across runtimes. */
export function hashKey(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Stable identity string for a target (container part + shape + locator). */
export function targetKey(t: FindingTarget): string {
  const parts = [t.container.kind, t.container.partName, t.shapeId ?? ""];
  const l = t.locator;
  if (l) {
    parts.push(
      l.property ?? "",
      l.paragraphIndex ?? "",
      l.runIndex ?? "",
      l.cell ? `${l.cell.row}.${l.cell.col}` : "",
      l.script ?? "",
      l.level ?? "",
      l.relId ?? "",
      l.hyperlink ? `${l.hyperlink.occurrence}@${l.hyperlink.address}` : "",
    );
  }
  return parts.join("|");
}

export function findingId(area: Area, kind: FindingKind, key: string): string {
  return `${area}:${kind}:${hashKey(key)}`;
}

/** Build a finding with its deterministic id. Checks should always construct findings with this. */
export function makeFinding<K extends FindingKind>(input: FindingInput<K>): FindingOf<K> {
  const { key, ...rest } = input;
  const identity = key ?? `${input.group}\u0000${input.targets.map(targetKey).sort().join("\u0001")}`;
  return { id: findingId(input.area, input.kind, identity), ...rest } as FindingOf<K>;
}

// ---------------------------------------------------------------------------------------------
// Target builders

function slideOf(pres: Presentation | undefined, partName: string): SlideInfo | undefined {
  return pres?.slides.find((s) => s.partName === partName);
}

/** Layout / master name of a shape container; undefined for slides (or when `pres` is absent). */
export function containerName(pres: Presentation | undefined, kind: ContainerKind, partName: string): string | undefined {
  if (!pres) return undefined;
  if (kind === "layout") return pres.layouts.find((l) => l.partName === partName)?.name;
  if (kind === "master") return pres.masters.find((m) => m.partName === partName)?.name;
  return undefined;
}

/** Target for a whole slide. */
export function slideTarget(slide: SlideInfo, locator?: TargetLocator): FindingTarget {
  const t: FindingTarget = {
    container: {
      kind: "slide",
      partName: slide.partName,
      slideId: slide.slideId,
      slideIndex: slide.index,
      slideNumber: slide.number,
    },
  };
  if (locator) t.locator = locator;
  return t;
}

/**
 * Target for a part that is not a shape (layout, master, chart, media, …). Pass `slide` to
 * attribute a slide-owned part (notes, comments, a chart on a slide) to its slide.
 */
export function partTarget(
  kind: TargetContainerKind,
  partName: string,
  extra: { slide?: SlideInfo; name?: string; locator?: TargetLocator } = {},
): FindingTarget {
  const container: TargetContainer = { kind, partName };
  if (extra.slide) {
    container.slideId = extra.slide.slideId;
    container.slideIndex = extra.slide.index;
    container.slideNumber = extra.slide.number;
  }
  if (extra.name !== undefined) container.name = extra.name;
  const t: FindingTarget = { container };
  if (extra.locator) t.locator = extra.locator;
  return t;
}

/**
 * Part-level target for a whole shape container: `slideTarget` for a known slide, otherwise
 * `partTarget` carrying the layout / master name when there is one.
 */
export function containerTarget(
  pres: Presentation,
  container: { readonly kind: ContainerKind; readonly partName: string },
  locator?: TargetLocator,
): FindingTarget {
  const slide = container.kind === "slide" ? slideOf(pres, container.partName) : undefined;
  if (slide) return slideTarget(slide, locator);
  const name = containerName(pres, container.kind, container.partName);
  return partTarget(container.kind, container.partName, { ...(name !== undefined ? { name } : {}), ...(locator ? { locator } : {}) });
}

/**
 * Serializable target for a shape. Pass `pres` to fill slide index/number and layout/master
 * names. Copies only plain data out of the `ShapeRef` (never `node`).
 */
export function shapeTarget(ref: ShapeRef, pres?: Presentation, locator?: TargetLocator): FindingTarget {
  const c = ref.container;
  const container: TargetContainer = { kind: c.kind, partName: c.partName };
  if (c.slideId !== undefined) container.slideId = c.slideId;
  if (c.kind === "slide") {
    const s = slideOf(pres, c.partName);
    if (s) {
      container.slideIndex = s.index;
      container.slideNumber = s.number;
    }
  } else {
    const name = containerName(pres, c.kind, c.partName);
    if (name !== undefined) container.name = name;
  }
  const t: FindingTarget = { container, shapeId: ref.shapeId, shapeName: ref.name, path: [...ref.path] };
  if (ref.bounds) t.bounds = { x: ref.bounds.x, y: ref.bounds.y, cx: ref.bounds.cx, cy: ref.bounds.cy };
  if (locator) t.locator = locator;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Summary

export interface AreaCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export type AreaSummary = Record<Area, AreaCounts>;

/** Per-area severity counts for the Overview and the area picker badges (R1). */
export function summarize(findings: readonly Finding[]): AreaSummary {
  const out = Object.fromEntries(AREAS.map((a) => [a, { error: 0, warning: 0, info: 0, total: 0 }])) as AreaSummary;
  for (const f of findings) {
    const c = out[f.area];
    c[f.severity] += 1;
    c.total += 1;
  }
  return out;
}
