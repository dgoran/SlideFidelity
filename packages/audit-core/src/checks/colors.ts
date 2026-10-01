/**
 * Colors area (U6, R6/R13/R22).
 *
 * - `theme-colors`: one info finding per master with its theme palette.
 * - `color-usage`: one finding per literal color (`a:srgbClr`, `a:sysClr`, `a:prstClr`,
 *   `a:hslClr`, `a:scrgbClr`), grouped by hex, with usage contexts and per-master grouping.
 *   Warning when the color is outside the brand (the `options.brand` palette within its tolerance,
 *   or by default the 12 theme colors of the usage's master); info otherwise.
 * - `color-matches-theme`: info when a literal is exactly a theme color of its master ("matches
 *   accent1 but is not linked to the theme"). Not a fix: the in-place API can only write literal
 *   RGB (KTD4), so re-linking to the theme is deferred to the cleaned-copy path.
 * - `recent-colors`: info listing `p:clrMru`.
 *
 * Theme references (`a:schemeClr`, with or without lumMod/lumOff/tint/shade) are never literal
 * and never fix targets. Fix targets (`replace-color`) are per-property literal references on
 * slide shapes only: spPr solid fill, line solid fill, run color, table cell fill, and run color
 * in table cells. Gradients, patterns, effects, bullets, list styles, backgrounds, charts,
 * SmartArt, layouts, and masters are listed with `reachable: false`.
 */
import { defaultBrandFromTheme, matchBrandColor, round4, themeForMaster, type BrandColorMatch } from "../brand";
import { hslToHex, nearestColor, parseHex, presetHex, scrgbToHex } from "../color";
import {
  containerTarget,
  makeFinding,
  partTarget,
  shapeTarget,
  targetKey,
  type Finding,
  type FindingTarget,
  type TargetLocator,
  type TargetProperty,
} from "../findings";
import type { MasterInfo, Presentation, SlideInfo, ThemeColorSlot, ThemeInfo } from "../package/model";
import { getShapes, shapeContainers } from "../package/model";
import { attr, child, childPath, elements, intAttr, localName, type XmlElement } from "../package/xml";
import type { Check, CheckContext } from "../runner";

// ---------------------------------------------------------------------------------------------
// Data types

/** Where a literal color is used. */
export type ColorContext =
  | "fill"
  | "line"
  | "text"
  | "bullet"
  | "table-cell"
  | "table-border"
  | "gradient"
  | "pattern"
  | "effect"
  | "background"
  | "text-style"
  | "chart"
  | "smartart"
  | "other";

/** How the literal was written. */
export type LiteralColorKind = "srgb" | "sys" | "preset" | "hsl" | "scrgb";

export interface ColorMasterUsage {
  masterPart: string;
  /** Master name, else its theme name, else "Master N". */
  masterName: string;
  themeName?: string;
  count: number;
  contexts: ColorContext[];
  /** Nearest color of this master's theme (CIEDE2000, rounded to 4 decimals). */
  nearestTheme?: { slot: ThemeColorSlot; hex: string; distance: number };
  /** Brand verdict for usages under this master; absent when the color has no hex. */
  inBrand?: boolean;
}

export interface ColorUsageData {
  /** Upper-case RRGGBB; absent for an unknown preset (or an unparsable value). */
  hex?: string;
  /** Literal forms seen for this color, sorted. */
  kinds: LiteralColorKind[];
  /** `a:sysClr` / `a:prstClr` names seen, sorted. */
  names: string[];
  count: number;
  reachableCount: number;
  /** Distinct contexts, sorted. */
  contexts: ColorContext[];
  /** In `pres.masters` order. */
  byMaster: ColorMasterUsage[];
  /** `profile` when `options.brand` was given, else each master's theme palette. */
  brandSource: "profile" | "theme";
  /** Overall verdict: in brand under every master. Absent without a hex. */
  inBrand?: boolean;
  /** Nearest profile color (only with `brandSource: "profile"`). */
  nearestBrand?: { hex: string; distance: number };
}

export interface ColorMatchesThemeData {
  hex: string;
  slot: ThemeColorSlot;
  masterPart: string;
  masterName: string;
  themeName?: string;
  count: number;
}

export interface ThemeColorsData {
  masterPart: string;
  masterName: string;
  themePart?: string;
  themeName?: string;
  colorSchemeName?: string;
  colors: { slot: ThemeColorSlot; hex: string; kind: "srgb" | "sys"; sysName?: string }[];
  slideCount: number;
}

export interface RecentColorsData {
  colors: { kind: string; value: string; hex?: string }[];
}

declare module "../findings" {
  interface FindingDataMap {
    "color-usage": ColorUsageData;
    "color-matches-theme": ColorMatchesThemeData;
    "theme-colors": ThemeColorsData;
    "recent-colors": RecentColorsData;
  }
}

// ---------------------------------------------------------------------------------------------
// Literal classification

const COLOR_ELEMENTS = new Set(["srgbClr", "sysClr", "prstClr", "hslClr", "scrgbClr", "schemeClr"]);
const SHAPE_ELEMENTS = new Set(["sp", "pic", "grpSp", "graphicFrame", "cxnSp", "contentPart"]);
/** Subtrees never scanned: extension payloads (a14:hiddenFill etc. are not rendered) and legacy fallbacks. */
const SKIP_ELEMENTS = new Set(["extLst", "Fallback"]);
const EFFECT_ELEMENTS = new Set(["effectLst", "effectDag", "scene3d", "sp3d"]);
const TABLE_BORDERS = new Set(["lnL", "lnR", "lnT", "lnB", "lnTlToBr", "lnBlToTr"]);

interface Literal {
  hex?: string;
  kind: LiteralColorKind;
  name?: string;
  /** Group key: the hex, else the name / raw value. */
  group: string;
}

const num = (el: XmlElement, name: string): number => intAttr(el, name) ?? 0;

function literalOf(el: XmlElement): Literal | undefined {
  const local = localName(el.name);
  const val = attr(el, "val") ?? "";
  const make = (kind: LiteralColorKind, hex: string | undefined, name?: string): Literal => ({
    kind,
    group: hex ?? (name || val || `(${kind})`),
    ...(hex !== undefined ? { hex } : {}),
    ...(name !== undefined ? { name } : {}),
  });
  switch (local) {
    case "srgbClr":
      return make("srgb", /^[0-9a-fA-F]{6}$/.test(val.trim()) ? parseHex(val) : undefined);
    case "sysClr": {
      const last = attr(el, "lastClr") ?? "";
      return make("sys", /^[0-9a-fA-F]{6}$/.test(last.trim()) ? parseHex(last) : undefined, val);
    }
    case "prstClr":
      return make("preset", presetHex(val), val);
    case "hslClr":
      return make("hsl", hslToHex(num(el, "hue"), num(el, "sat"), num(el, "lum")));
    case "scrgbClr":
      return make("scrgb", scrgbToHex(num(el, "r"), num(el, "g"), num(el, "b")));
    default:
      return undefined; // schemeClr: a theme reference
  }
}

/** A literal carrying transforms (other than alpha) renders as a different RGB than written. */
function hasColorTransforms(el: XmlElement): boolean {
  return elements(el).some((c) => localName(c.name) !== "alpha");
}

/**
 * Visits every color element under `root` (root itself is not a color), passing the ancestor
 * chain from `root`'s children down to the color's parent. Nested shapes are not entered (they
 * are separate `ShapeRef`s), nor are `extLst` and `mc:Fallback` subtrees.
 */
function walkColors(root: XmlElement, visit: (color: XmlElement, ancestors: readonly XmlElement[]) => void): void {
  const stack: XmlElement[] = [];
  const rec = (el: XmlElement): void => {
    for (const c of elements(el)) {
      const local = localName(c.name);
      if (SKIP_ELEMENTS.has(local) || SHAPE_ELEMENTS.has(local)) continue;
      if (COLOR_ELEMENTS.has(local)) {
        visit(c, stack);
        continue;
      }
      stack.push(c);
      rec(c);
      stack.pop();
    }
  };
  rec(root);
}

// ---------------------------------------------------------------------------------------------
// Usage classification

interface Placement {
  context: ColorContext;
  locator: TargetLocator;
  /** Before container/shape-kind gating. */
  reachable: boolean;
}

/** Index of `el` among its parent's children with the same local name. */
function indexAmong(parent: XmlElement | undefined, el: XmlElement): number {
  if (!parent) return 0;
  const name = localName(el.name);
  let i = 0;
  for (const c of elements(parent)) {
    if (c === el) return i;
    if (localName(c.name) === name) i++;
  }
  return i;
}

function fillStyleContext(names: readonly string[], base: ColorContext): ColorContext {
  if (names.some((n) => EFFECT_ELEMENTS.has(n))) return "effect";
  if (names.includes("gradFill")) return "gradient";
  if (names.includes("pattFill")) return "pattern";
  return base;
}

/** Classifies a color inside a text body (`p:txBody` / `a:txBody`), from the body's children down. */
function textPlacement(chain: readonly XmlElement[], body: XmlElement, cell?: { row: number; col: number }): Placement {
  const names = chain.map((e) => localName(e.name));
  const withCell = (l: TargetLocator): TargetLocator => (cell ? { ...l, cell } : l);
  const first = names[0];
  if (first === "lstStyle") {
    const lvl = /^lvl(\d)pPr$/.exec(names[1] ?? "");
    const level = lvl ? Number(lvl[1]) : undefined;
    const context: ColorContext = names.includes("buClr") ? "bullet" : fillStyleContext(names, "text-style");
    return { context, locator: withCell({ property: "list-style", ...(level !== undefined ? { level } : {}) }), reachable: false };
  }
  if (first === "p") {
    const p = chain[0] as XmlElement;
    const paragraphIndex = indexAmong(body, p);
    const second = names[1];
    if (second === "pPr") {
      if (names.includes("buClr")) return { context: "bullet", locator: withCell({ property: "bullet", paragraphIndex }), reachable: false };
      return { context: fillStyleContext(names, "text"), locator: withCell({ property: "text", paragraphIndex }), reachable: false };
    }
    if (second === "r" && names[2] === "rPr") {
      const runIndex = indexAmong(p, chain[1] as XmlElement);
      const direct = names.length === 4 && names[3] === "solidFill";
      return {
        context: fillStyleContext(names, "text"),
        locator: withCell({ property: "text", paragraphIndex, runIndex }),
        reachable: direct,
      };
    }
    // fld, br, endParaRPr, math…: not addressable per run by the in-place API.
    return { context: fillStyleContext(names, "text"), locator: withCell({ property: "text", paragraphIndex }), reachable: false };
  }
  return { context: "text", locator: withCell({ property: "text" }), reachable: false };
}

/** Classifies a color inside an `a:tbl`, from the table's children down. */
function tablePlacement(chain: readonly XmlElement[], tbl: XmlElement): Placement {
  const names = chain.map((e) => localName(e.name));
  if (names[0] !== "tr" || names[1] !== "tc") {
    return { context: fillStyleContext(names, "other"), locator: { property: "other" }, reachable: false };
  }
  const tr = chain[0] as XmlElement;
  const tc = chain[1] as XmlElement;
  const cell = { row: indexAmong(tbl, tr), col: indexAmong(tr, tc) };
  const rest = chain.slice(2);
  const restNames = names.slice(2);
  if (restNames[0] === "txBody") return textPlacement(rest.slice(1), rest[0] as XmlElement, cell);
  if (restNames[0] === "tcPr") {
    if (TABLE_BORDERS.has(restNames[1] ?? "")) {
      return { context: fillStyleContext(restNames, "table-border"), locator: { property: "line", cell }, reachable: false };
    }
    const direct = restNames.length === 2 && restNames[1] === "solidFill";
    return { context: fillStyleContext(restNames, "table-cell"), locator: { property: "table-cell", cell }, reachable: direct };
  }
  return { context: fillStyleContext(restNames, "other"), locator: { property: "table-cell", cell }, reachable: false };
}

const STYLE_REF_PROPERTY: Readonly<Record<string, TargetProperty>> = {
  lnRef: "line",
  fillRef: "fill",
  effectRef: "effect",
  fontRef: "text",
};

/** Classifies a color within a shape element, given the ancestors below the shape. */
function shapePlacement(chain: readonly XmlElement[]): Placement {
  const names = chain.map((e) => localName(e.name));
  const tblAt = names.lastIndexOf("tbl");
  if (tblAt >= 0) return tablePlacement(chain.slice(tblAt + 1), chain[tblAt] as XmlElement);
  const bodyAt = names.indexOf("txBody");
  if (bodyAt >= 0) return textPlacement(chain.slice(bodyAt + 1), chain[bodyAt] as XmlElement);
  const first = names[0];
  if (first === "spPr" || first === "grpSpPr") {
    const rest = names.slice(1);
    const group = first === "grpSpPr";
    if (rest.some((n) => EFFECT_ELEMENTS.has(n))) return { context: "effect", locator: { property: "effect" }, reachable: false };
    if (rest[0] === "ln") {
      const direct = rest.length === 2 && rest[1] === "solidFill";
      return { context: fillStyleContext(rest, "line"), locator: { property: "line" }, reachable: direct && !group };
    }
    const direct = rest.length === 1 && rest[0] === "solidFill";
    return { context: fillStyleContext(rest, "fill"), locator: { property: "fill" }, reachable: direct && !group };
  }
  if (first === "style") {
    const property = STYLE_REF_PROPERTY[names[1] ?? ""] ?? "other";
    return { context: "other", locator: { property }, reachable: false };
  }
  if (first === "blipFill") return { context: "other", locator: { property: "image" }, reachable: false };
  return { context: fillStyleContext(names, "other"), locator: { property: "other" }, reachable: false };
}

// ---------------------------------------------------------------------------------------------
// Scan

interface Usage {
  literal: Literal;
  context: ColorContext;
  masterPart: string | undefined;
  target: FindingTarget;
}

const REACHABLE_SHAPE_KINDS = new Set(["sp", "cxnSp", "pic"]);

async function collectUsages(pres: Presentation): Promise<Usage[]> {
  const out: Usage[] = [];
  const slideByPart = new Map(pres.slides.map((s) => [s.partName, s] as const));
  const layoutByPart = new Map(pres.layouts.map((l) => [l.partName, l] as const));
  const masterByPart = new Map(pres.masters.map((m) => [m.partName, m] as const));

  const push = (colorEl: XmlElement, context: ColorContext, masterPart: string | undefined, target: FindingTarget): void => {
    const literal = literalOf(colorEl);
    if (!literal) return;
    if (literal.hex === undefined) target.reachable = false;
    out.push({ literal, context, masterPart, target });
  };

  for (const container of shapeContainers(pres)) {
    const slide = container.kind === "slide" ? slideByPart.get(container.partName) : undefined;
    const layout = container.kind === "layout" ? layoutByPart.get(container.partName) : undefined;
    const master = container.kind === "master" ? masterByPart.get(container.partName) : undefined;
    const masterPart = slide?.masterPart ?? layout?.masterPart ?? master?.partName;

    const shapes = await getShapes(pres, container);
    const kindById = new Map(shapes.map((s) => [s.shapeId, s.kind] as const));
    for (const ref of shapes) {
      const insideFrame = ref.path.some((id) => kindById.get(id) === "graphicFrame");
      const shapeReachable = container.kind === "slide" && !insideFrame;
      walkColors(ref.node, (colorEl, chain) => {
        const pl = shapePlacement(chain);
        const isTableTarget = ref.kind === "graphicFrame" && (pl.context === "table-cell" || pl.locator.cell !== undefined);
        const kindOk = REACHABLE_SHAPE_KINDS.has(ref.kind) || isTableTarget;
        const reachable = pl.reachable && shapeReachable && kindOk && !hasColorTransforms(colorEl);
        const target = shapeTarget(ref, pres, pl.locator);
        target.reachable = reachable;
        push(colorEl, pl.context, masterPart, target);
      });
    }

    // Background (p:cSld/p:bg) and master text styles: never reachable in place.
    const root = await pres.pkg.xml(container.partName);
    const bg = childPath(root, "cSld", "bg");
    if (bg) {
      walkColors(bg, (colorEl, chain) => {
        const names = chain.map((e) => localName(e.name));
        const target = containerTarget(pres, container, { property: "fill" });
        target.reachable = false;
        push(colorEl, fillStyleContext(names, "background"), masterPart, target);
      });
    }
    const txStyles = container.kind === "master" ? child(root, "txStyles") : undefined;
    if (txStyles) {
      walkColors(txStyles, (colorEl, chain) => {
        const names = chain.map((e) => localName(e.name));
        const lvl = /^lvl(\d)pPr$/.exec(names[1] ?? "");
        const locator: TargetLocator = { property: "list-style", ...(lvl ? { level: Number(lvl[1]) } : {}) };
        const target = containerTarget(pres, container, locator);
        target.reachable = false;
        push(colorEl, names.includes("buClr") ? "bullet" : fillStyleContext(names, "text-style"), masterPart, target);
      });
    }
  }

  // Charts and SmartArt on slides: listed, never reachable.
  for (const slide of pres.slides) {
    for (const part of slide.chartParts) await scanPart(pres, part, "chart", "chart", slide, push);
    const data = slide.relationships.filter((r) => r.shortType === "diagramData" && r.targetPart).map((r) => r.targetPart as string);
    const drawing = slide.relationships.filter((r) => r.shortType === "diagramDrawing" && r.targetPart).map((r) => r.targetPart as string);
    // The drawing part is a render cache of the data model; scan it only when there is no data part.
    for (const part of data.length > 0 ? data : drawing) await scanPart(pres, part, "diagram", "smartart", slide, push);
  }
  return out;
}

async function scanPart(
  pres: Presentation,
  partName: string,
  kind: "chart" | "diagram",
  context: ColorContext,
  slide: SlideInfo,
  push: (el: XmlElement, context: ColorContext, masterPart: string | undefined, target: FindingTarget) => void,
): Promise<void> {
  if (!pres.pkg.has(partName)) return;
  const root = await pres.pkg.xml(partName);
  if (!root) return;
  walkColors(root, (colorEl) => {
    const target = partTarget(kind, partName, { slide });
    target.reachable = false;
    push(colorEl, context, slide.masterPart, target);
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers

function masterDisplayName(pres: Presentation, master: MasterInfo): string {
  if (master.name) return master.name;
  const theme = themeForMaster(pres, master.partName);
  if (theme?.name) return theme.name;
  return `Master ${pres.masters.indexOf(master) + 1}`;
}

function nearestThemeColor(hex: string, theme: ThemeInfo | undefined): ColorMasterUsage["nearestTheme"] {
  if (!theme) return undefined;
  const best = nearestColor(hex, theme.colors);
  if (!best) return undefined;
  return { slot: best.item.slot, hex: best.item.hex, distance: round4(best.distance) };
}

function dedupeTargets(targets: readonly FindingTarget[]): FindingTarget[] {
  const seen = new Map<string, FindingTarget>();
  for (const t of targets) {
    const k = targetKey(t);
    const prev = seen.get(k);
    if (!prev) seen.set(k, t);
    else if (t.reachable === false) prev.reachable = false;
  }
  return [...seen.values()];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sortedUnique = <T extends string>(xs: readonly T[]): T[] => [...new Set(xs)].sort();

// ---------------------------------------------------------------------------------------------
// Checks

function themeColorsCheck({ pres }: CheckContext): Finding[] {
  return pres.masters.map((master) => {
    const theme = themeForMaster(pres, master.partName);
    const masterName = masterDisplayName(pres, master);
    const colors = (theme?.colors ?? []).map((c) => ({
      slot: c.slot,
      hex: c.hex,
      kind: c.kind,
      ...(c.sysName !== undefined ? { sysName: c.sysName } : {}),
    }));
    const data: ThemeColorsData = {
      masterPart: master.partName,
      masterName,
      ...(theme ? { themePart: theme.partName, themeName: theme.name, colorSchemeName: theme.colorSchemeName } : {}),
      colors,
      slideCount: master.slideParts.length,
    };
    return makeFinding({
      area: "colors",
      kind: "theme-colors",
      severity: "info",
      title: theme ? `Theme colors: ${theme.name || masterName}` : `No theme colors for ${masterName}`,
      detail: `${plural(colors.length, "theme color")} used by ${plural(master.slideParts.length, "slide")}.`,
      group: master.partName,
      groupLabel: masterName,
      count: colors.length,
      targets: [partTarget("master", master.partName, { name: masterName })],
      fixes: [],
      key: master.partName,
      data,
    });
  });
}

async function literalColorsCheck({ pres, options }: CheckContext): Promise<Finding[]> {
  const usages = await collectUsages(pres);
  const profile = options.brand;
  const groups = new Map<string, Usage[]>();
  for (const u of usages) {
    const list = groups.get(u.literal.group);
    if (list) list.push(u);
    else groups.set(u.literal.group, [u]);
  }

  const masterOrder = new Map(pres.masters.map((m, i) => [m.partName, i] as const));
  const themeBrand = new Map<string, ReturnType<typeof defaultBrandFromTheme>>();
  const brandFor = (masterPart: string): ReturnType<typeof defaultBrandFromTheme> => {
    let b = themeBrand.get(masterPart);
    if (!b) {
      b = defaultBrandFromTheme(pres, masterPart || undefined);
      themeBrand.set(masterPart, b);
    }
    return b;
  };

  const usageFindings: Finding[] = [];
  const matchFindings: Finding[] = [];

  for (const [group, list] of groups) {
    const hex = list[0]?.literal.hex;
    const count = list.length;
    const reachableCount = list.filter((u) => u.target.reachable === true).length;
    const contexts = sortedUnique(list.map((u) => u.context));
    const kinds = sortedUnique(list.map((u) => u.literal.kind));
    const names = sortedUnique(list.flatMap((u) => (u.literal.name !== undefined ? [u.literal.name] : [])));

    const perMaster = new Map<string, Usage[]>();
    for (const u of list) {
      const k = u.masterPart ?? "";
      const l = perMaster.get(k);
      if (l) l.push(u);
      else perMaster.set(k, [u]);
    }
    const profileMatch: BrandColorMatch | undefined = hex !== undefined && profile ? matchBrandColor(hex, profile) : undefined;

    const byMaster: ColorMasterUsage[] = [...perMaster.entries()]
      .sort(([a], [b]) => (masterOrder.get(a) ?? 1e9) - (masterOrder.get(b) ?? 1e9) || a.localeCompare(b))
      .map(([masterPart, mu]) => {
        const master = pres.masters.find((m) => m.partName === masterPart);
        const theme = themeForMaster(pres, masterPart || undefined);
        const entry: ColorMasterUsage = {
          masterPart,
          masterName: master ? masterDisplayName(pres, master) : "(no master)",
          ...(theme?.name ? { themeName: theme.name } : {}),
          count: mu.length,
          contexts: sortedUnique(mu.map((u) => u.context)),
        };
        if (hex !== undefined) {
          const nearest = nearestThemeColor(hex, theme);
          if (nearest) entry.nearestTheme = nearest;
          entry.inBrand = profileMatch ? profileMatch.inBrand : matchBrandColor(hex, brandFor(masterPart)).inBrand;
        }
        return entry;
      });

    const inBrand = hex === undefined ? undefined : byMaster.every((m) => m.inBrand === true);
    const data: ColorUsageData = {
      ...(hex !== undefined ? { hex } : {}),
      kinds,
      names,
      count,
      reachableCount,
      contexts,
      byMaster,
      brandSource: profile ? "profile" : "theme",
      ...(inBrand !== undefined ? { inBrand } : {}),
      ...(profileMatch?.nearest ? { nearestBrand: profileMatch.nearest } : {}),
    };

    const label = hex !== undefined ? `#${hex}` : group;
    const nameNote = names.length > 0 ? ` (${names.join(", ")})` : "";
    const where = byMaster.length > 1 ? ` across ${plural(byMaster.length, "master")}` : "";
    let detail: string;
    if (hex === undefined) detail = `The color value "${group}" could not be resolved to RGB, so it cannot be checked or replaced.`;
    else if (inBrand) detail = profile ? "Within the brand palette." : "Within the theme palette of its master.";
    else {
      const nearest = profile ? profileMatch?.nearest : byMaster.find((m) => m.inBrand === false)?.nearestTheme;
      const near = nearest ? ` Nearest: ${"slot" in nearest ? `${nearest.slot} ` : ""}#${nearest.hex} (ΔE ${nearest.distance.toFixed(1)}).` : "";
      detail = `${profile ? "Not in the brand palette." : "Not in the theme palette."}${near}`;
    }
    if (hex !== undefined && reachableCount < count) {
      detail += ` ${plural(count - reachableCount, "use")} (${contexts.filter((c) => c !== "fill" && c !== "line" && c !== "text" && c !== "table-cell").join(", ") || "layouts, masters, or modified colors"}) cannot be replaced in place.`;
    }

    const targets = dedupeTargets(list.map((u) => u.target));
    usageFindings.push(
      makeFinding({
        area: "colors",
        kind: "color-usage",
        severity: inBrand === false ? "warning" : "info",
        title: `${label}${nameNote} used ${plural(count, "time")}${where}`,
        detail,
        group,
        groupLabel: `${label}${nameNote}`,
        count,
        targets,
        fixes: hex !== undefined ? ["replace-color"] : [],
        ...(hex !== undefined ? { reachable: reachableCount > 0 } : {}),
        key: `literal\u0000${group}`,
        data,
      }),
    );

    // Exact theme matches, per master (the theme depends on the master).
    if (hex === undefined) continue;
    for (const m of byMaster) {
      if (m.nearestTheme?.distance !== 0) continue;
      const mu = perMaster.get(m.masterPart) ?? [];
      const slot = m.nearestTheme.slot;
      matchFindings.push(
        makeFinding({
          area: "colors",
          kind: "color-matches-theme",
          severity: "info",
          title: `#${hex} matches ${slot} but is not linked to the theme`,
          detail:
            `${plural(mu.length, "use")} on ${m.masterName} ${mu.length === 1 ? "is" : "are"} written as a fixed color. ` +
            `If the theme changes, ${mu.length === 1 ? "it" : "they"} will not follow. Linking to the theme color needs a cleaned copy.`,
          group: hex,
          groupLabel: `#${hex} = ${slot}`,
          count: mu.length,
          targets: dedupeTargets(mu.map((u) => ({ ...u.target }))),
          fixes: [],
          key: `${hex}\u0000${m.masterPart}`,
          data: {
            hex,
            slot,
            masterPart: m.masterPart,
            masterName: m.masterName,
            ...(m.themeName !== undefined ? { themeName: m.themeName } : {}),
            count: mu.length,
          },
        }),
      );
    }
  }
  return [...usageFindings, ...matchFindings];
}

function recentColorsCheck({ pres }: CheckContext): Finding[] {
  if (pres.recentColors.length === 0) return [];
  const colors = pres.recentColors.map((c) => ({ kind: c.kind, value: c.value, ...(c.hex !== undefined ? { hex: c.hex } : {}) }));
  return [
    makeFinding({
      area: "colors",
      kind: "recent-colors",
      severity: "info",
      title: `${plural(colors.length, "recent color")}`,
      detail: "Custom colors PowerPoint remembers in this file's color picker.",
      group: "recent-colors",
      count: colors.length,
      targets: [],
      fixes: [],
      data: { colors },
    }),
  ];
}

export const colorChecks: Check[] = [
  { id: "colors-theme", area: "colors", run: themeColorsCheck },
  { id: "colors-literal", area: "colors", run: literalColorsCheck },
  { id: "colors-recent", area: "colors", run: recentColorsCheck },
];
