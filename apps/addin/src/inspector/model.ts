/**
 * Inspector view model (R4, U11): what the Inspector shows for the current PowerPoint selection.
 *
 * `buildInspectorModel` is pure. It joins live selected objects back to the last scan (KTD5,
 * inverted: live → snapshot) and extracts properties from finding payloads:
 *
 * - 0 shapes: a per-slide summary (hidden, notes, transition, animation, comments, findings).
 * - 1 shape: identity + match quality, that shape's findings by area, and its properties (fonts
 *   by script with source labels, colors by property, links, image details, autofit, hidden
 *   list-style fonts).
 * - >1 shapes: count, per-shape identity, and the combined findings (deduplicated by id).
 * - A shape or slide the last scan never saw: `not-in-scan` ("Not in last scan — rescan").
 *   Per D4 this only drives a "may be out of date" hint; nothing is blocked.
 *
 * Every string in the model comes from the deck or from constants here and is plain data; the UI
 * must render it as text (never as HTML, never as a clickable link unless `checkable`).
 */
import {
  AREAS,
  getShapes,
  shapeContainers,
  type Area,
  type AuditResult,
  type AutofitMode,
  type CropData,
  type FileSizeBreakdownData,
  type Finding,
  type FindingOf,
  type FindingTarget,
  type FontScript,
  type FontSource,
  type ImageFormat,
  type ImageIssueType,
  type ImageUseData,
  type LinkTrigger,
  type Presentation,
  type Severity,
  type TargetProperty,
} from "@slidecheck/audit-core";
import { emuToPoints, parseLiveShapeId, parseLiveSlideId, resolveShape, type MatchMethod } from "../office/ids";
import type { SelectedShape, SelectedSlide, SelectionResult } from "../office/selection";

// ---------------------------------------------------------------------------------------------
// Scan inventory (every slide and shape the scan saw)

export interface InventoryShape {
  shapeId: number;
  name: string;
  /** Ancestor group / graphic-frame ids, outermost first. */
  path: number[];
  /** Slide-space position in points; absent when the shape has no own transform. */
  left?: number;
  top?: number;
}

export interface InventorySlide {
  slideId: number;
  /** 0-based. */
  index: number;
  /** 1-based. */
  number: number;
  partName: string;
  shapes: InventoryShape[];
}

/** Plain-data list of the scanned slides and shapes (build it in the worker next to `runChecks`). */
export interface ScanInventory {
  slides: InventorySlide[];
}

/** Build the inventory from a parsed snapshot. The result is structured-cloneable. */
export async function buildScanInventory(pres: Presentation): Promise<ScanInventory> {
  const slides: InventorySlide[] = [];
  const containers = shapeContainers(pres).filter((c) => c.kind === "slide");
  for (const s of pres.slides) {
    const container = containers.find((c) => c.partName === s.partName);
    const refs = container ? await getShapes(pres, container) : [];
    slides.push({
      slideId: s.slideId,
      index: s.index,
      number: s.number,
      partName: s.partName,
      shapes: refs.map((r) => {
        const out: InventoryShape = { shapeId: r.shapeId, name: r.name, path: [...r.path] };
        if (r.bounds) {
          out.left = emuToPoints(r.bounds.x);
          out.top = emuToPoints(r.bounds.y);
        }
        return out;
      }),
    });
  }
  return { slides };
}

// ---------------------------------------------------------------------------------------------
// Model types

export interface InspectorFinding {
  id: string;
  kind: Finding["kind"];
  area: Area;
  severity: Severity;
  title: string;
  detail?: string;
  group: string;
  groupLabel?: string;
  /** How many of the finding's targets are on the selection. */
  occurrences: number;
}

export interface InspectorAreaGroup {
  area: Area;
  /** Errors, then warnings, then info; stable otherwise. */
  findings: InspectorFinding[];
}

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface FontProperty {
  typeface: string;
  script: FontScript;
  /** "Latin", "East Asian", "Complex script", "Symbol", "Bullet". */
  scriptLabel: string;
  source: FontSource;
  /** "Direct formatting", "Hidden list style", … */
  sourceLabel: string;
  /** Set when the typeface came from a theme reference (`+mn-lt`, …). */
  theme?: "major" | "minor";
  themeRef?: string;
  /** Where on the shape: text, bullet, table-cell, list-style. */
  properties: TargetProperty[];
  occurrences: number;
  /** A font fix can reach at least one occurrence. */
  reachable: boolean;
  inBrand: boolean | null;
  findingId: string;
}

export interface ColorProperty {
  hex?: string;
  names: string[];
  inBrand?: boolean;
  occurrences: number;
  reachable: boolean;
  findingId: string;
}

export interface ColorGroup {
  property: TargetProperty;
  label: string;
  colors: ColorProperty[];
}

export type LinkFlag = "unsafe-scheme" | "local-path";

export interface LinkProperty {
  kind: "hyperlink" | "linked-file";
  /** Untrusted; render as text. Only `checkable` addresses may ever be opened or checked. */
  address: string;
  scheme?: string;
  trigger?: LinkTrigger;
  location?: "shape" | "text";
  text?: string;
  linkType?: string;
  checkable: boolean;
  flags: LinkFlag[];
  findingId: string;
}

export interface ImageProperty {
  partName: string;
  format?: ImageFormat;
  /** Uncompressed part size. */
  bytes?: number;
  compressedBytes?: number;
  /** Native pixels. */
  width?: number;
  height?: number;
  source?: ImageUseData["source"];
  role?: ImageUseData["role"];
  crop?: CropData;
  /** Crop insets as percentages of each side. */
  cropPercent?: { left: number; top: number; right: number; bottom: number };
  displayed?: { widthIn: number; heightIn: number };
  visiblePixels?: { width: number; height: number };
  ppi?: { x: number; y: number };
  effectivePpi?: number;
  scale?: { x: number; y: number };
  distortion?: number;
  shared?: boolean;
  /** Slide numbers that use the image (from the media size data). */
  slideNumbers?: number[];
  issues: ImageIssueType[];
}

export interface ShapeProperties {
  fonts: FontProperty[];
  /** Fonts that exist only in the shape's hidden `a:lstStyle`, or null. */
  hiddenListStyles: { fonts: string[]; levels: number[] } | null;
  colors: ColorGroup[];
  links: LinkProperty[];
  images: ImageProperty[];
  autofit: { mode: AutofitMode; label: string } | null;
}

export type ShapeStatus =
  /** Joined to a scanned shape. */
  | "matched"
  /** The scan provably did not contain it (new shape or new slide). */
  | "not-in-scan"
  /** Several scanned shapes fit the name + position fallback. */
  | "ambiguous"
  /** No inventory was given and no finding mentions it: in the scan with no findings, or new. */
  | "unverified";

export interface ShapeMatch {
  method: MatchMethod;
  /** True for a name + position (or slide position) fallback: show "approximate match". */
  approximate: boolean;
  shapeId: number;
  snapshotName: string;
  slideId: number;
  slideNumber?: number;
}

export interface ShapeIdentity {
  liveId: string;
  name: string;
  type: string;
  status: ShapeStatus;
  match?: ShapeMatch;
  /** User-facing note for non-matched statuses. */
  message?: string;
}

export interface ShapeInspection extends ShapeIdentity {
  findings: InspectorAreaGroup[];
  counts: SeverityCounts;
  properties: ShapeProperties;
  /** D4 hint: the selection is not (provably) part of the last scan. */
  mayBeOutOfDate: boolean;
}

export interface SlideSummary {
  liveId: string;
  index: number;
  status: "matched" | "not-in-scan";
  method?: MatchMethod;
  approximate?: boolean;
  slideId?: number;
  slideNumber?: number;
  hidden: boolean;
  notes: { characters: number } | null;
  transition: {
    type?: string;
    speed?: string;
    durationMs?: number;
    advanceAfterMs?: number;
    advanceOnClick: boolean;
  } | null;
  animation: { effectCount: number } | null;
  commentCount: number;
  findings: InspectorAreaGroup[];
  counts: SeverityCounts;
  message?: string;
}

export type InspectorModel =
  | { kind: "unsupported" }
  | { kind: "no-scan" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "slides"; slides: SlideSummary[]; mayBeOutOfDate: boolean }
  | { kind: "shape"; shape: ShapeInspection }
  | {
      kind: "multi";
      count: number;
      shapes: ShapeIdentity[];
      findings: InspectorAreaGroup[];
      counts: SeverityCounts;
      notInScanCount: number;
      mayBeOutOfDate: boolean;
    };

export interface InspectorIds {
  parseLiveSlideId(live: string): number | null;
  parseLiveShapeId(live: string): number | null;
  resolveShape: typeof resolveShape;
}

export interface InspectorOptions {
  /** Full list of scanned slides/shapes. Without it, "not in scan" can only be proven per slide. */
  inventory?: ScanInventory;
  /** Defaults to `apps/addin/src/office/ids.ts`. */
  ids?: InspectorIds;
  /** Name + position fallback tolerance (points). */
  tolerancePt?: number;
}

// ---------------------------------------------------------------------------------------------
// Labels

export const SCRIPT_LABELS: Record<FontScript, string> = {
  latin: "Latin",
  ea: "East Asian",
  cs: "Complex script",
  sym: "Symbol",
  bu: "Bullet",
};

export const FONT_SOURCE_LABELS: Record<FontSource, string> = {
  direct: "Direct formatting",
  "hidden-list-style": "Hidden list style",
  master: "Master",
  chart: "Chart",
  smartart: "SmartArt",
  "theme-default": "Theme default",
};

export const COLOR_PROPERTY_LABELS: Partial<Record<TargetProperty, string>> = {
  fill: "Fill",
  line: "Line",
  text: "Text",
  bullet: "Bullet",
  "table-cell": "Table cell",
  effect: "Effect",
  other: "Other",
};

export const AUTOFIT_LABELS: Record<AutofitMode, string> = {
  none: "Do not autofit",
  shrink: "Shrink text on overflow",
  resize: "Resize shape to fit text",
};

export const NOT_IN_SCAN_MESSAGE = "Not in last scan — rescan";
const AMBIGUOUS_MESSAGE = "Several shapes in the last scan match this one — rescan";
const UNVERIFIED_MESSAGE = "No findings for this shape in the last scan";

const SCRIPT_ORDER: readonly FontScript[] = ["latin", "ea", "cs", "sym", "bu"];
const SOURCE_ORDER: readonly FontSource[] = ["direct", "hidden-list-style", "master", "chart", "smartart", "theme-default"];
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const COLOR_PROPERTY_ORDER: readonly TargetProperty[] = ["fill", "line", "text", "bullet", "table-cell", "effect", "other"];

const DEFAULT_IDS: InspectorIds = { parseLiveSlideId, parseLiveShapeId, resolveShape };

// ---------------------------------------------------------------------------------------------
// Scan index

interface KnownShape {
  shapeId: number;
  name: string;
  left: number;
  top: number;
}

interface KnownSlide {
  slideId: number;
  index: number;
  number?: number;
  partName?: string;
  /** From the inventory (authoritative) or from finding targets (partial). */
  shapes: Map<number, KnownShape>;
}

interface ScanIndex {
  slides: Map<number, KnownSlide>;
  /** True when `slides[*].shapes` lists every scanned shape. */
  complete: boolean;
}

/** Stands in for "no inventory" as a WeakMap key. */
const NO_INVENTORY = {};
const scanIndexCache = new WeakMap<AuditResult, WeakMap<object, ScanIndex>>();

/**
 * `buildIndex` memoized per (audit, inventory) object pair: selection changes rebuild the
 * Inspector model often, but the scan it is matched against only changes on a rescan. The index
 * is never mutated after it is built.
 */
function indexScan(audit: AuditResult, inventory: ScanInventory | undefined): ScanIndex {
  let byInventory = scanIndexCache.get(audit);
  if (!byInventory) {
    byInventory = new WeakMap();
    scanIndexCache.set(audit, byInventory);
  }
  const key = inventory ?? NO_INVENTORY;
  let index = byInventory.get(key);
  if (!index) {
    index = buildIndex(audit, inventory);
    byInventory.set(key, index);
  }
  return index;
}

function buildIndex(audit: AuditResult, inventory: ScanInventory | undefined): ScanIndex {
  const slides = new Map<number, KnownSlide>();
  if (inventory) {
    for (const s of inventory.slides) {
      const shapes = new Map<number, KnownShape>();
      for (const sh of s.shapes) {
        shapes.set(sh.shapeId, { shapeId: sh.shapeId, name: sh.name, left: sh.left ?? Number.NaN, top: sh.top ?? Number.NaN });
      }
      slides.set(s.slideId, { slideId: s.slideId, index: s.index, number: s.number, partName: s.partName, shapes });
    }
    return { slides, complete: true };
  }

  // Slides: the file-size breakdown lists every scanned slide.
  const fsb = audit.findings.find((f): f is FindingOf<"file-size-breakdown"> => f.kind === "file-size-breakdown");
  const breakdown: FileSizeBreakdownData | undefined = fsb?.data;
  for (const s of breakdown?.slides ?? []) {
    slides.set(s.slideId, { slideId: s.slideId, index: s.slideIndex, number: s.slideNumber, partName: s.partName, shapes: new Map() });
  }
  // Shapes: whatever the findings mention.
  for (const f of audit.findings) {
    for (const t of f.targets) {
      const c = t.container;
      if (c.kind !== "slide" || c.slideId === undefined) continue;
      let slide = slides.get(c.slideId);
      if (!slide) {
        slide = { slideId: c.slideId, index: c.slideIndex ?? -1, shapes: new Map() };
        if (c.slideNumber !== undefined) slide.number = c.slideNumber;
        slide.partName = c.partName;
        slides.set(c.slideId, slide);
      }
      const ids = [...(t.path ?? []), ...(t.shapeId !== undefined ? [t.shapeId] : [])];
      for (const id of ids) {
        const own = id === t.shapeId;
        const prev = slide.shapes.get(id);
        const left = own && t.bounds ? emuToPoints(t.bounds.x) : Number.NaN;
        const top = own && t.bounds ? emuToPoints(t.bounds.y) : Number.NaN;
        if (!prev) {
          slide.shapes.set(id, { shapeId: id, name: own ? (t.shapeName ?? "") : "", left, top });
        } else if (own) {
          if (!prev.name && t.shapeName) prev.name = t.shapeName;
          if (Number.isNaN(prev.left) && !Number.isNaN(left)) {
            prev.left = left;
            prev.top = top;
          }
        }
      }
    }
  }
  return { slides, complete: false };
}

type SlideResolution = { status: "matched"; slide: KnownSlide; method: MatchMethod } | { status: "not-in-scan" };

function resolveLiveSlide(sel: SelectedSlide, scan: ScanIndex, ids: InspectorIds): SlideResolution {
  const parsed = ids.parseLiveSlideId(sel.liveId);
  if (parsed !== null) {
    const hit = scan.slides.get(parsed);
    return hit ? { status: "matched", slide: hit, method: "exact" } : { status: "not-in-scan" };
  }
  // Live id format assumption failed: fall back to slide position (ids.ts `resolveSlide` rule).
  if (sel.index >= 0) {
    for (const s of scan.slides.values()) if (s.index === sel.index) return { status: "matched", slide: s, method: "fallback" };
  }
  return { status: "not-in-scan" };
}

// ---------------------------------------------------------------------------------------------
// Finding selection helpers

type Predicate = (t: FindingTarget) => boolean;

function onSlide(slideId: number): Predicate {
  return (t) => t.container.slideId === slideId && (t.container.kind === "slide" || t.shapeId === undefined);
}

function onShape(slideId: number, shapeId: number): Predicate {
  return (t) =>
    t.container.kind === "slide" &&
    t.container.slideId === slideId &&
    (t.shapeId === shapeId || (t.path ?? []).includes(shapeId));
}

function summarizeFinding(f: Finding, occurrences: number): InspectorFinding {
  const out: InspectorFinding = {
    id: f.id,
    kind: f.kind,
    area: f.area,
    severity: f.severity,
    title: f.title,
    group: f.group,
    occurrences,
  };
  if (f.detail !== undefined) out.detail = f.detail;
  if (f.groupLabel !== undefined) out.groupLabel = f.groupLabel;
  return out;
}

/** Findings with at least one target matching `pred`, merged by id across predicates. */
function collectFindings(findings: readonly Finding[], preds: readonly Predicate[]): InspectorFinding[] {
  const out: InspectorFinding[] = [];
  for (const f of findings) {
    let n = 0;
    for (const t of f.targets) if (preds.some((p) => p(t))) n += 1;
    if (n > 0) out.push(summarizeFinding(f, n));
  }
  return out;
}

function groupByArea(items: readonly InspectorFinding[]): InspectorAreaGroup[] {
  const groups: InspectorAreaGroup[] = [];
  for (const area of AREAS) {
    const list = items
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.area === area)
      .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
      .map(({ f }) => f);
    if (list.length > 0) groups.push({ area, findings: list });
  }
  return groups;
}

function countSeverities(items: readonly InspectorFinding[]): SeverityCounts {
  const c: SeverityCounts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const f of items) {
    c[f.severity] += 1;
    c.total += 1;
  }
  return c;
}

function ofKind<K extends Finding["kind"]>(findings: readonly Finding[], kind: K): FindingOf<K>[] {
  return findings.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

// ---------------------------------------------------------------------------------------------
// Properties

function fontProperties(findings: readonly Finding[], pred: Predicate): FontProperty[] {
  const byKey = new Map<string, FontProperty>();
  for (const f of ofKind(findings, "font-usage")) {
    f.targets.forEach((t, i) => {
      if (!pred(t)) return;
      const u = f.data.usages[i];
      if (!u) return;
      const key = [f.data.typeface.toLowerCase(), u.script, u.source, u.theme ?? ""].join("|");
      let p = byKey.get(key);
      if (!p) {
        p = {
          typeface: f.data.typeface,
          script: u.script,
          scriptLabel: SCRIPT_LABELS[u.script],
          source: u.source,
          sourceLabel: FONT_SOURCE_LABELS[u.source],
          properties: [],
          occurrences: 0,
          reachable: false,
          inBrand: f.data.inBrand,
          findingId: f.id,
        };
        if (u.theme) p.theme = u.theme;
        if (u.ref) p.themeRef = u.ref;
        byKey.set(key, p);
      }
      p.occurrences += 1;
      const reachable = t.reachable ?? f.reachable ?? false;
      if (reachable) p.reachable = true;
      const prop = t.locator?.property;
      if (prop && !p.properties.includes(prop)) p.properties.push(prop);
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      SCRIPT_ORDER.indexOf(a.script) - SCRIPT_ORDER.indexOf(b.script) ||
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.typeface.localeCompare(b.typeface),
  );
}

function hiddenListStyles(findings: readonly Finding[], pred: Predicate): ShapeProperties["hiddenListStyles"] {
  const fonts: string[] = [];
  const levels = new Set<number>();
  let any = false;
  for (const f of ofKind(findings, "hidden-list-style")) {
    if (!f.targets.some(pred)) continue;
    any = true;
    for (const name of f.data.fonts) if (!fonts.some((x) => x.toLowerCase() === name.toLowerCase())) fonts.push(name);
    for (const l of f.data.levels) levels.add(l);
  }
  return any ? { fonts, levels: [...levels].sort((a, b) => a - b) } : null;
}

function colorProperties(findings: readonly Finding[], pred: Predicate): ColorGroup[] {
  const groups = new Map<TargetProperty, Map<string, ColorProperty>>();
  for (const f of ofKind(findings, "color-usage")) {
    for (const t of f.targets) {
      if (!pred(t)) continue;
      const prop: TargetProperty = t.locator?.property ?? "other";
      let g = groups.get(prop);
      if (!g) {
        g = new Map();
        groups.set(prop, g);
      }
      let c = g.get(f.id);
      if (!c) {
        c = { names: [...f.data.names], occurrences: 0, reachable: false, findingId: f.id };
        if (f.data.hex !== undefined) c.hex = f.data.hex;
        if (f.data.inBrand !== undefined) c.inBrand = f.data.inBrand;
        g.set(f.id, c);
      }
      c.occurrences += 1;
      if (t.reachable ?? f.reachable ?? false) c.reachable = true;
    }
  }
  const rank = (p: TargetProperty): number => {
    const i = COLOR_PROPERTY_ORDER.indexOf(p);
    return i < 0 ? COLOR_PROPERTY_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([property, colors]) => ({ property, label: COLOR_PROPERTY_LABELS[property] ?? "Other", colors: [...colors.values()] }));
}

function linkProperties(findings: readonly Finding[], pred: Predicate): LinkProperty[] {
  const unsafe = new Set<string>();
  const local = new Set<string>();
  for (const f of ofKind(findings, "unsafe-link-scheme")) if (f.targets.some(pred)) unsafe.add(f.data.address);
  for (const f of ofKind(findings, "local-path-link")) if (f.targets.some(pred)) local.add(f.data.address);
  const flagsFor = (address: string): LinkFlag[] => {
    const flags: LinkFlag[] = [];
    if (unsafe.has(address)) flags.push("unsafe-scheme");
    if (local.has(address)) flags.push("local-path");
    return flags;
  };

  const out: LinkProperty[] = [];
  for (const f of findings) {
    if (!f.targets.some(pred)) continue;
    if (f.kind === "hyperlink") {
      const d = f.data;
      const flags = flagsFor(d.address);
      const p: LinkProperty = {
        kind: "hyperlink",
        address: d.address,
        scheme: d.scheme,
        trigger: d.trigger,
        location: d.location,
        checkable: d.checkable && !flags.includes("unsafe-scheme"),
        flags,
        findingId: f.id,
      };
      if (d.text !== undefined) p.text = d.text;
      out.push(p);
    } else if (f.kind === "linked-file") {
      out.push({
        kind: "linked-file",
        address: f.data.target,
        linkType: f.data.linkType,
        checkable: false,
        flags: flagsFor(f.data.target),
        findingId: f.id,
      });
    }
  }
  return out;
}

const round = (n: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

function imageProperties(findings: readonly Finding[], pred: Predicate): ImageProperty[] {
  const byPart = new Map<string, ImageProperty>();
  const ensure = (partName: string): ImageProperty => {
    let p = byPart.get(partName);
    if (!p) {
      p = { partName, issues: [] };
      byPart.set(partName, p);
    }
    return p;
  };

  for (const f of ofKind(findings, "image-issue")) {
    f.targets.forEach((t, i) => {
      if (!pred(t)) return;
      const d = f.data;
      const p = ensure(d.partName);
      if (!p.issues.includes(d.issue)) p.issues.push(d.issue);
      p.format ??= d.format;
      p.bytes ??= d.bytes;
      if (p.width === undefined && d.width !== undefined) p.width = d.width;
      if (p.height === undefined && d.height !== undefined) p.height = d.height;
      const u = d.uses[i];
      if (!u || p.role !== undefined) return;
      p.role = u.role;
      p.source = u.source;
      if (u.crop) {
        p.crop = { ...u.crop };
        p.cropPercent = { left: u.crop.l / 1000, top: u.crop.t / 1000, right: u.crop.r / 1000, bottom: u.crop.b / 1000 };
      }
      if (u.displayed) p.displayed = { widthIn: round(u.displayed.widthIn, 3), heightIn: round(u.displayed.heightIn, 3) };
      if (u.visiblePixels) p.visiblePixels = { ...u.visiblePixels };
      if (u.ppi) p.ppi = { x: round(u.ppi.x, 1), y: round(u.ppi.y, 1) };
      if (u.effectivePpi !== undefined) p.effectivePpi = round(u.effectivePpi, 1);
      if (u.scale) p.scale = { x: round(u.scale.x, 4), y: round(u.scale.y, 4) };
      if (u.distortion !== undefined) p.distortion = round(u.distortion, 4);
    });
  }

  // Media size data keyed by part fills native dims, compressed size, and sharing.
  if (byPart.size > 0) {
    for (const f of ofKind(findings, "media-size")) {
      const p = byPart.get(f.data.partName);
      if (!p) continue;
      if (p.width === undefined && f.data.width !== undefined) p.width = f.data.width;
      if (p.height === undefined && f.data.height !== undefined) p.height = f.data.height;
      p.bytes ??= f.data.bytes;
      if (p.format === undefined && f.data.format !== undefined) p.format = f.data.format;
      if (f.data.compressedBytes !== undefined) p.compressedBytes = f.data.compressedBytes;
      p.shared = f.data.shared;
      p.slideNumbers = f.data.slides.map((s) => s.slideNumber);
    }
  }
  return [...byPart.values()];
}

function autofitProperty(findings: readonly Finding[], pred: Predicate): ShapeProperties["autofit"] {
  for (const f of ofKind(findings, "autofit")) {
    if (f.targets.some(pred)) return { mode: f.data.mode, label: AUTOFIT_LABELS[f.data.mode] };
  }
  return null;
}

const EMPTY_PROPERTIES: ShapeProperties = {
  fonts: [],
  hiddenListStyles: null,
  colors: [],
  links: [],
  images: [],
  autofit: null,
};

function shapeProperties(findings: readonly Finding[], pred: Predicate): ShapeProperties {
  return {
    fonts: fontProperties(findings, pred),
    hiddenListStyles: hiddenListStyles(findings, pred),
    colors: colorProperties(findings, pred),
    links: linkProperties(findings, pred),
    images: imageProperties(findings, pred),
    autofit: autofitProperty(findings, pred),
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes

interface ResolvedShape {
  identity: ShapeIdentity;
  pred?: Predicate;
  /** The matched scanned shape (set exactly when `pred` is). */
  at?: { slideId: number; shapeId: number };
}

interface ShapeCandidate {
  id: string;
  name: string;
  left: number;
  top: number;
  known: KnownShape;
}

/** Resolution candidates per scanned slide, built once (the scan index is cached and immutable). */
const candidateCache = new WeakMap<KnownSlide, readonly ShapeCandidate[]>();

function shapeCandidates(slide: KnownSlide): readonly ShapeCandidate[] {
  let candidates = candidateCache.get(slide);
  if (!candidates) {
    // KTD5 inverted: the live shape is the "target", the scanned shapes are the candidates.
    candidates = [...slide.shapes.values()].map((k) => ({ id: String(k.shapeId), name: k.name, left: k.left, top: k.top, known: k }));
    candidateCache.set(slide, candidates);
  }
  return candidates;
}

/** One predicate equivalent to OR-ing `onShape(slideId, shapeId)` over every matched shape. */
function onAnyShape(at: readonly { slideId: number; shapeId: number }[]): Predicate {
  const keys = new Set(at.map((a) => `${a.slideId}|${a.shapeId}`));
  return (t) => {
    const c = t.container;
    if (c.kind !== "slide" || c.slideId === undefined) return false;
    if (t.shapeId !== undefined && keys.has(`${c.slideId}|${t.shapeId}`)) return true;
    return (t.path ?? []).some((id) => keys.has(`${c.slideId}|${id}`));
  };
}

function resolveLiveShape(
  live: SelectedShape,
  slide: SlideResolution,
  scan: ScanIndex,
  ids: InspectorIds,
  tolerancePt: number | undefined,
): ResolvedShape {
  const base = { liveId: live.liveId, name: live.name, type: live.type };
  if (slide.status !== "matched") {
    return { identity: { ...base, status: "not-in-scan", message: NOT_IN_SCAN_MESSAGE } };
  }
  const candidates = shapeCandidates(slide.slide);
  const liveNumeric = ids.parseLiveShapeId(live.liveId) ?? -1;
  const r = ids.resolveShape(
    { shapeId: liveNumeric, name: live.name, left: live.left, top: live.top },
    candidates,
    tolerancePt !== undefined ? { tolerancePt } : {},
  );
  if (r.status === "matched") {
    const k = r.item.known;
    const match: ShapeMatch = {
      method: r.method,
      approximate: r.method !== "exact",
      shapeId: k.shapeId,
      snapshotName: k.name,
      slideId: slide.slide.slideId,
    };
    if (slide.slide.number !== undefined) match.slideNumber = slide.slide.number;
    if (slide.method !== "exact") match.approximate = true;
    return {
      identity: { ...base, status: "matched", match },
      pred: onShape(slide.slide.slideId, k.shapeId),
      at: { slideId: slide.slide.slideId, shapeId: k.shapeId },
    };
  }
  if (r.status === "ambiguous") return { identity: { ...base, status: "ambiguous", message: AMBIGUOUS_MESSAGE } };
  if (scan.complete) return { identity: { ...base, status: "not-in-scan", message: NOT_IN_SCAN_MESSAGE } };
  return { identity: { ...base, status: "unverified", message: UNVERIFIED_MESSAGE } };
}

// ---------------------------------------------------------------------------------------------
// Slides

function slideSummary(sel: SelectedSlide, res: SlideResolution, findings: readonly Finding[]): SlideSummary {
  const base = {
    liveId: sel.liveId,
    index: sel.index,
    hidden: false,
    notes: null,
    transition: null,
    animation: null,
    commentCount: 0,
    findings: [],
    counts: { error: 0, warning: 0, info: 0, total: 0 },
  };
  if (res.status !== "matched") return { ...base, status: "not-in-scan", message: NOT_IN_SCAN_MESSAGE };

  const sid = res.slide.slideId;
  const pred = onSlide(sid);
  const hits = collectFindings(findings, [pred]);
  const out: SlideSummary = {
    ...base,
    status: "matched",
    method: res.method,
    approximate: res.method !== "exact",
    slideId: sid,
    findings: groupByArea(hits),
    counts: countSeverities(hits),
  };
  if (res.slide.number !== undefined) out.slideNumber = res.slide.number;
  for (const f of findings) {
    if (!f.targets.some(pred)) continue;
    switch (f.kind) {
      case "hidden-slide":
        out.hidden = true;
        break;
      case "speaker-notes":
        out.notes = { characters: f.data.characters };
        break;
      case "transition": {
        const t: NonNullable<SlideSummary["transition"]> = { advanceOnClick: f.data.advanceOnClick };
        if (f.data.type !== undefined) t.type = f.data.type;
        if (f.data.speed !== undefined) t.speed = f.data.speed;
        if (f.data.durationMs !== undefined) t.durationMs = f.data.durationMs;
        if (f.data.advanceAfterMs !== undefined) t.advanceAfterMs = f.data.advanceAfterMs;
        out.transition = t;
        break;
      }
      case "animation":
        out.animation = { effectCount: f.data.effectCount };
        break;
      case "comment":
        out.commentCount += 1;
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Entry point

export function buildInspectorModel(
  selection: SelectionResult | null,
  audit: AuditResult | null,
  options: InspectorOptions = {},
): InspectorModel {
  if (selection?.status === "unsupported") return { kind: "unsupported" };
  if (!audit) return { kind: "no-scan" };
  if (!selection) return { kind: "empty" };
  if (selection.status === "error") return { kind: "error", message: selection.message };

  const ids = options.ids ?? DEFAULT_IDS;
  const scan = indexScan(audit, options.inventory);
  const findings = audit.findings;

  if (selection.shapes.length === 0) {
    if (selection.slides.length === 0) return { kind: "empty" };
    const slides = selection.slides.map((s) => slideSummary(s, resolveLiveSlide(s, scan, ids), findings));
    return { kind: "slides", slides, mayBeOutOfDate: slides.some((s) => s.status !== "matched") };
  }

  // Selected shapes live on the current (first selected) slide.
  const first = selection.slides[0];
  const slideRes: SlideResolution = first ? resolveLiveSlide(first, scan, ids) : { status: "not-in-scan" };
  const resolved = selection.shapes.map((s) => resolveLiveShape(s, slideRes, scan, ids, options.tolerancePt));

  if (resolved.length === 1) {
    const r = resolved[0]!;
    const hits = r.pred ? collectFindings(findings, [r.pred]) : [];
    return {
      kind: "shape",
      shape: {
        ...r.identity,
        findings: groupByArea(hits),
        counts: countSeverities(hits),
        properties: r.pred ? shapeProperties(findings, r.pred) : { ...EMPTY_PROPERTIES },
        mayBeOutOfDate: r.identity.status === "not-in-scan" || r.identity.status === "ambiguous",
      },
    };
  }

  const matched = resolved.flatMap((r) => (r.at ? [r.at] : []));
  const hits = matched.length > 0 ? collectFindings(findings, [onAnyShape(matched)]) : [];
  const notInScanCount = resolved.filter((r) => r.identity.status === "not-in-scan").length;
  return {
    kind: "multi",
    count: resolved.length,
    shapes: resolved.map((r) => r.identity),
    findings: groupByArea(hits),
    counts: countSeverities(hits),
    notInScanCount,
    mayBeOutOfDate: resolved.some((r) => r.identity.status === "not-in-scan" || r.identity.status === "ambiguous"),
  };
}
