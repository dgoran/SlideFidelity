/**
 * Fonts area (U5, R5, R22; AE1). Lists every font the deck uses, including the ones PowerPoint's
 * Replace Fonts dialog hides: East Asian / complex-script / symbol / bullet fonts, shape list
 * styles, master and layout text styles, theme defaults, charts, and SmartArt.
 *
 * Reachability (what the in-place "replace fonts" fix can change, KTD4 / U13): only the primary
 * (`a:latin`) font of runs, paragraph defaults, and end-of-paragraph properties in slide shapes and
 * slide table cells. Everything else (ea/cs/sym/bu slots, list styles, masters, layouts, theme,
 * charts, SmartArt, and any `+mj-*` / `+mn-*` theme reference) is reported but unreachable.
 *
 * Installed-font detection is out of scope; only embedding status is reported.
 */
import {
  makeFinding,
  partTarget,
  shapeTarget,
  type Finding,
  type FindingTarget,
  type TargetLocator,
} from "../findings";
import { getShapes, type Presentation, type SlideInfo, type ThemeInfo } from "../package/model";
import type { Relationship } from "../package/rels";
import type { ShapeContainer, ShapeRef } from "../package/shapes";
import { attr, child, childPath, childrenNamed, elements, localName, type XmlElement } from "../package/xml";
import type { Check, CheckContext } from "../runner";

// ---------------------------------------------------------------------------------------------
// Public data types

export type FontScript = "latin" | "ea" | "cs" | "sym" | "bu";
export type FontSource = "direct" | "hidden-list-style" | "master" | "chart" | "smartart" | "theme-default";
/** Deck / per-font embedding status from `p:embeddedFontLst` + `saveSubsetFonts`. */
export type EmbeddingStatus = "none" | "subset" | "full";

/** One usage, aligned by index with the finding's `targets`. */
export interface FontUsageRef {
  script: FontScript;
  source: FontSource;
  /** Set when the usage is a theme font: a `+mj-*`/`+mn-*` reference or the theme font scheme. */
  theme?: "major" | "minor";
  /** The theme reference as written, e.g. `+mn-lt`. */
  ref?: string;
}

export interface FontUsageBreakdown {
  script: FontScript;
  source: FontSource;
  count: number;
  reachable: number;
}

export interface FontUsageData {
  typeface: string;
  /** Aligned with `Finding.targets`. */
  usages: FontUsageRef[];
  /** Counts per script + source, in script then source order. */
  breakdown: FontUsageBreakdown[];
  reachableCount: number;
  unreachableCount: number;
  /** The font is one of the deck's theme fonts (by name). */
  themeRole?: "major" | "minor" | "both";
  /**
   * Brand-profile membership. `null` when not evaluated: the font is used only as a bullet or
   * symbol glyph font (brand profiles govern text typefaces).
   */
  inBrand: boolean | null;
  embedding: EmbeddingStatus;
}

export interface HiddenListStyleData {
  /** Fonts named in the shape's own `a:lstStyle` that its text does not use directly. */
  fonts: string[];
  /** List levels (1–9) that name fonts. */
  levels: number[];
}

export interface FontEmbeddingData {
  status: EmbeddingStatus;
  fonts: { typeface: string; styles: string[] }[];
  saveSubsetFonts: boolean;
  embedTrueTypeFonts: boolean;
  /** Total bytes of embedded font parts, when known. */
  totalBytes: number;
}

declare module "../findings" {
  interface FindingDataMap {
    "font-usage": FontUsageData;
    "hidden-list-style": HiddenListStyleData;
    "font-embedding": FontEmbeddingData;
  }
}

// ---------------------------------------------------------------------------------------------
// Collection

const SCRIPT_ORDER: readonly FontScript[] = ["latin", "ea", "cs", "sym", "bu"];
const SOURCE_ORDER: readonly FontSource[] = ["direct", "hidden-list-style", "master", "chart", "smartart", "theme-default"];
const RPR_SCRIPTS: readonly FontScript[] = ["latin", "ea", "cs", "sym"];

const SOURCE_LABEL: Record<FontSource, string> = {
  direct: "direct",
  "hidden-list-style": "hidden list style",
  master: "master",
  chart: "chart",
  smartart: "SmartArt",
  "theme-default": "theme default",
};

interface Usage {
  typeface: string;
  ref: FontUsageRef;
  target: FindingTarget;
}

/** How to resolve and attribute fonts found in one XML scope. */
interface Scope {
  source: FontSource;
  /** Whether a literal latin font here is reachable by the fix. */
  reachable: boolean;
  theme: ThemeInfo | undefined;
  target: (locator: TargetLocator) => FindingTarget;
}

const lower = (s: string): string => s.toLowerCase();

function cmp(a: string, b: string): number {
  const x = lower(a);
  const y = lower(b);
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveThemeRef(typeface: string, theme: ThemeInfo | undefined): { name: string; role: "major" | "minor" } | undefined {
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(typeface);
  if (!m) return undefined;
  const role = m[1] === "mj" ? "major" : "minor";
  const trio = role === "major" ? theme?.majorFont : theme?.minorFont;
  const slot = m[2] === "lt" ? "latin" : m[2] === "ea" ? "ea" : "cs";
  return { name: trio?.[slot] ?? "", role };
}

class Collector {
  readonly usages: Usage[] = [];

  add(raw: string | undefined, script: FontScript, scope: Scope, locator: TargetLocator): Usage | undefined {
    const typeface = raw?.trim() ?? "";
    if (!typeface) return undefined;
    let name = typeface;
    const ref: FontUsageRef = { script, source: scope.source };
    let reachable = scope.reachable && script === "latin";
    if (typeface.startsWith("+")) {
      const r = resolveThemeRef(typeface, scope.theme);
      if (!r) return undefined;
      if (!r.name) return undefined; // theme leaves this slot unset: no font
      name = r.name;
      ref.theme = r.role;
      ref.ref = typeface;
      reachable = false; // theme-bound: never a fix target
    }
    const target = scope.target({ ...locator, script });
    target.reachable = reachable;
    const u: Usage = { typeface: name, ref, target };
    this.usages.push(u);
    return u;
  }

  /** `a:rPr` / `a:defRPr` / `a:endParaRPr`: latin, ea, cs, sym children. */
  runProps(rPr: XmlElement | undefined, scope: Scope, locator: TargetLocator): Usage[] {
    const out: Usage[] = [];
    if (!rPr) return out;
    for (const script of RPR_SCRIPTS) {
      const u = this.add(attr(child(rPr, script), "typeface"), script, scope, locator);
      if (u) out.push(u);
    }
    return out;
  }

  /** A paragraph-properties / list-level element: `a:buFont` and `a:defRPr`. */
  paraProps(pPr: XmlElement | undefined, scope: Scope, locator: TargetLocator, bulletLocator: TargetLocator): Usage[] {
    const out: Usage[] = [];
    if (!pPr) return out;
    const bu = this.add(attr(child(pPr, "buFont"), "typeface"), "bu", scope, bulletLocator);
    if (bu) out.push(bu);
    out.push(...this.runProps(child(pPr, "defRPr"), scope, locator));
    return out;
  }

  /** `a:lstStyle`, `p:titleStyle`, `p:defaultTextStyle`, …: `a:defPPr` and `a:lvlNpPr`. */
  listStyle(el: XmlElement | undefined, scope: Scope, base: TargetLocator): Usage[] {
    const out: Usage[] = [];
    if (!el) return out;
    for (const lvl of elements(el)) {
      const m = /^lvl([1-9])pPr$/.exec(localName(lvl.name));
      if (!m && localName(lvl.name) !== "defPPr") continue;
      const loc: TargetLocator = { ...base };
      if (m) loc.level = Number(m[1]);
      out.push(...this.paraProps(lvl, scope, loc, loc));
    }
    return out;
  }

  /** Paragraphs of a text body (`a:p`), with per-run locators. */
  paragraphs(txBody: XmlElement, scope: Scope, base: TargetLocator): Usage[] {
    const out: Usage[] = [];
    childrenNamed(txBody, "p").forEach((p, paragraphIndex) => {
      const pLoc: TargetLocator = { ...base, paragraphIndex };
      const buLoc: TargetLocator = base.property === "table-cell" ? pLoc : { ...pLoc, property: "bullet" };
      out.push(...this.paraProps(child(p, "pPr"), scope, pLoc, buLoc));
      let runIndex = 0;
      for (const el of elements(p)) {
        const ln = localName(el.name);
        if (ln === "r") {
          out.push(...this.runProps(child(el, "rPr"), scope, { ...pLoc, runIndex }));
          runIndex++;
        } else if (ln === "fld" || ln === "br") {
          out.push(...this.runProps(child(el, "rPr"), scope, pLoc));
        } else if (ln === "endParaRPr") {
          out.push(...this.runProps(el, scope, pLoc));
        }
      }
    });
    return out;
  }

  /** Every font element anywhere under `root` (charts, SmartArt, theme object defaults). */
  anywhere(root: XmlElement, scope: Scope, base: TargetLocator): void {
    const visit = (el: XmlElement): void => {
      for (const c of elements(el)) {
        const ln = localName(c.name);
        if (ln === "latin" || ln === "ea" || ln === "cs" || ln === "sym") this.add(attr(c, "typeface"), ln, scope, base);
        else if (ln === "buFont") this.add(attr(c, "typeface"), "bu", scope, base);
        else visit(c);
      }
    };
    visit(root);
  }
}

// ---------------------------------------------------------------------------------------------
// Scan

function themeFor(pres: Presentation, masterPart: string | undefined): ThemeInfo | undefined {
  const themePart = pres.masters.find((m) => m.partName === masterPart)?.themePart;
  return pres.themes.find((t) => t.partName === themePart) ?? pres.theme;
}

/** Themes actually used by masters (falls back to the primary theme). */
function masterThemes(pres: Presentation): ThemeInfo[] {
  const out: ThemeInfo[] = [];
  for (const m of pres.masters) {
    const t = pres.themes.find((x) => x.partName === m.themePart);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length === 0 && pres.theme) out.push(pres.theme);
  return out;
}

interface ContainerInfo {
  container: ShapeContainer;
  slide?: SlideInfo;
  name?: string;
  theme: ThemeInfo | undefined;
  relationships: readonly Relationship[];
}

function containers(pres: Presentation): ContainerInfo[] {
  return [
    ...pres.slides.map(
      (s): ContainerInfo => ({
        container: { kind: "slide", partName: s.partName, slideId: s.slideId },
        slide: s,
        theme: themeFor(pres, s.masterPart),
        relationships: s.relationships,
      }),
    ),
    ...pres.layouts.map(
      (l): ContainerInfo => ({
        container: { kind: "layout", partName: l.partName },
        name: l.name,
        theme: themeFor(pres, l.masterPart),
        relationships: l.relationships,
      }),
    ),
    ...pres.masters.map(
      (m): ContainerInfo => ({
        container: { kind: "master", partName: m.partName },
        name: m.name,
        theme: themeFor(pres, m.partName),
        relationships: m.relationships,
      }),
    ),
  ];
}

interface HiddenShape {
  ref: ShapeRef;
  fonts: string[];
  levels: number[];
}

async function scanShape(pres: Presentation, col: Collector, info: ContainerInfo, ref: ShapeRef): Promise<HiddenShape | undefined> {
  const onSlide = info.container.kind === "slide";
  const mk = (source: FontSource, reachable: boolean): Scope => ({
    source,
    reachable,
    theme: info.theme,
    target: (locator) => shapeTarget(ref, pres, locator),
  });
  const textScope = mk(onSlide ? "direct" : "master", onSlide);
  const listScope = mk(onSlide ? "hidden-list-style" : "master", false);

  const listUsages: Usage[] = [];
  const directUsages: Usage[] = [];
  const bodies: { txBody: XmlElement; base: TargetLocator }[] = [];

  const own = child(ref.node, "txBody");
  if (own && (ref.kind === "sp" || ref.kind === "cxnSp")) bodies.push({ txBody: own, base: { property: "text" } });
  if (ref.kind === "graphicFrame") {
    const tbl = childPath(ref.node, "graphic", "graphicData", "tbl");
    if (tbl) {
      childrenNamed(tbl, "tr").forEach((tr, row) => {
        childrenNamed(tr, "tc").forEach((tc, col) => {
          const tx = child(tc, "txBody");
          if (tx) bodies.push({ txBody: tx, base: { property: "table-cell", cell: { row, col } } });
        });
      });
    }
  }
  for (const { txBody, base } of bodies) {
    const listBase: TargetLocator = base.cell ? { property: "list-style", cell: base.cell } : { property: "list-style" };
    listUsages.push(...col.listStyle(child(txBody, "lstStyle"), listScope, listBase));
    directUsages.push(...col.paragraphs(txBody, textScope, base));
  }

  if (!onSlide || listUsages.length === 0) return undefined;
  const visible = new Set(directUsages.map((u) => lower(u.typeface)));
  const fonts: string[] = [];
  const levels = new Set<number>();
  for (const u of listUsages) {
    if (visible.has(lower(u.typeface))) continue;
    if (!fonts.some((f) => lower(f) === lower(u.typeface))) fonts.push(u.typeface);
    if (u.target.locator?.level !== undefined) levels.add(u.target.locator.level);
  }
  if (fonts.length === 0) return undefined;
  return { ref, fonts, levels: [...levels].sort((a, b) => a - b) };
}

async function scanPart(
  pres: Presentation,
  col: Collector,
  info: ContainerInfo,
  rel: Relationship,
  kind: "chart" | "diagram",
): Promise<void> {
  const partName = rel.targetPart;
  if (!partName) return;
  const root = await pres.pkg.xml(partName);
  if (!root) return;
  const extra: { slide?: SlideInfo; name?: string } = {};
  if (info.slide) extra.slide = info.slide;
  if (info.name !== undefined) extra.name = info.name;
  col.anywhere(
    root,
    {
      source: kind === "chart" ? "chart" : "smartart",
      reachable: false,
      theme: info.theme,
      target: (locator) => partTarget(kind, partName, { ...extra, locator }),
    },
    { relId: rel.id },
  );
}

const TEXT_STYLES = ["titleStyle", "bodyStyle", "otherStyle"] as const;

async function collect(pres: Presentation): Promise<{ col: Collector; hidden: HiddenShape[] }> {
  const col = new Collector();
  const hidden: HiddenShape[] = [];
  const seenParts = new Set<string>();

  for (const info of containers(pres)) {
    for (const ref of await getShapes(pres, info.container)) {
      const h = await scanShape(pres, col, info, ref);
      if (h) hidden.push(h);
    }
    for (const rel of info.relationships) {
      const kind = rel.shortType === "chart" ? "chart" : rel.shortType === "diagramData" || rel.shortType === "diagramDrawing" ? "diagram" : undefined;
      if (!kind || !rel.targetPart || seenParts.has(rel.targetPart)) continue;
      seenParts.add(rel.targetPart);
      await scanPart(pres, col, info, rel, kind);
    }
    if (info.container.kind === "master") {
      const txStyles = childPath(await pres.pkg.xml(info.container.partName), "txStyles");
      const partName = info.container.partName;
      const scope: Scope = {
        source: "master",
        reachable: false,
        theme: info.theme,
        target: (locator) => partTarget("master", partName, { ...(info.name ? { name: info.name } : {}), locator }),
      };
      for (const style of TEXT_STYLES) col.listStyle(child(txStyles, style), scope, { property: "list-style" });
    }
  }

  // Presentation-wide default text style.
  const presRoot = await pres.pkg.xml(pres.presentationPart);
  col.listStyle(
    child(presRoot, "defaultTextStyle"),
    {
      source: "theme-default",
      reachable: false,
      theme: pres.theme,
      target: (locator) => partTarget("presentation", pres.presentationPart, { locator }),
    },
    { property: "list-style" },
  );

  // Theme font schemes and object defaults.
  for (const theme of masterThemes(pres)) {
    const target = (locator: TargetLocator): FindingTarget => partTarget("theme", theme.partName, { name: theme.name, locator });
    for (const role of ["major", "minor"] as const) {
      const trio = role === "major" ? theme.majorFont : theme.minorFont;
      for (const script of ["latin", "ea", "cs"] as const) {
        const u = col.add(trio[script], script, { source: "theme-default", reachable: false, theme, target }, {});
        if (u) u.ref.theme = role;
      }
    }
    const objectDefaults = child(await pres.pkg.xml(theme.partName), "objectDefaults");
    if (objectDefaults) col.anywhere(objectDefaults, { source: "theme-default", reachable: false, theme, target }, {});
  }
  return { col, hidden };
}

// ---------------------------------------------------------------------------------------------
// Findings

function embeddingOf(pres: Presentation, typeface: string): EmbeddingStatus {
  if (!pres.embeddedFonts.some((f) => lower(f.typeface) === lower(typeface))) return "none";
  return pres.saveSubsetFonts ? "subset" : "full";
}

function themeRoles(pres: Presentation): Map<string, "major" | "minor" | "both"> {
  const roles = new Map<string, "major" | "minor" | "both">();
  const set = (name: string, role: "major" | "minor"): void => {
    if (!name) return;
    const k = lower(name);
    const prev = roles.get(k);
    roles.set(k, prev && prev !== role ? "both" : role);
  };
  for (const t of masterThemes(pres)) {
    set(t.majorFont.latin, "major");
    set(t.minorFont.latin, "minor");
  }
  return roles;
}

/** Allowed fonts: the brand profile's, or (R22 default) the theme major/minor fonts. */
function allowedFonts(ctx: CheckContext): Set<string> {
  const brand = ctx.options.brand?.fonts?.filter((f) => f.trim() !== "");
  if (brand && brand.length > 0) return new Set(brand.map((f) => lower(f.trim())));
  const out = new Set<string>();
  for (const t of masterThemes(ctx.pres)) {
    for (const trio of [t.majorFont, t.minorFont]) {
      for (const n of [trio.latin, trio.ea, trio.cs]) if (n) out.add(lower(n));
    }
  }
  return out;
}

const ROLE_LABEL = { major: "theme headings", minor: "theme body", both: "theme headings and body" } as const;

function describe(breakdown: FontUsageBreakdown[], unreachable: number): string {
  const byScript = SCRIPT_ORDER.map((script) => {
    const parts = breakdown.filter((b) => b.script === script).map((b) => `${SOURCE_LABEL[b.source]} ${b.count}`);
    return parts.length ? `${script}: ${parts.join(", ")}` : "";
  }).filter(Boolean);
  const tail = unreachable > 0 ? ` ${unreachable} can't be replaced in place.` : "";
  return `${byScript.join("; ")}.${tail}`;
}

async function runFonts(ctx: CheckContext): Promise<Finding[]> {
  const { pres } = ctx;
  const { col, hidden } = await collect(pres);
  const allowed = allowedFonts(ctx);
  const roles = themeRoles(pres);

  const groups = new Map<string, Usage[]>();
  for (const u of col.usages) {
    const k = lower(u.typeface);
    const g = groups.get(k);
    if (g) g.push(u);
    else groups.set(k, [u]);
  }

  const fonts: Finding[] = [];
  for (const [k, list] of [...groups.entries()].sort((a, b) => cmp(a[1][0]?.typeface ?? a[0], b[1][0]?.typeface ?? b[0]))) {
    const typeface = list[0]?.typeface ?? k;
    const breakdown: FontUsageBreakdown[] = [];
    for (const script of SCRIPT_ORDER) {
      for (const source of SOURCE_ORDER) {
        const hits = list.filter((u) => u.ref.script === script && u.ref.source === source);
        if (hits.length) breakdown.push({ script, source, count: hits.length, reachable: hits.filter((u) => u.target.reachable).length });
      }
    }
    const reachableCount = list.filter((u) => u.target.reachable).length;
    const textUse = list.some((u) => u.ref.script !== "bu" && u.ref.script !== "sym");
    const inBrand = textUse ? allowed.has(k) : null;
    const role = roles.get(k);
    const data: FontUsageData = {
      typeface,
      usages: list.map((u) => ({ ...u.ref })),
      breakdown,
      reachableCount,
      unreachableCount: list.length - reachableCount,
      inBrand,
      embedding: embeddingOf(pres, typeface),
    };
    if (role) data.themeRole = role;
    fonts.push(
      makeFinding({
        area: "fonts",
        kind: "font-usage",
        severity: inBrand === false ? "warning" : "info",
        title: inBrand === false ? `${typeface} is not in the brand fonts` : typeface,
        detail: describe(breakdown, list.length - reachableCount),
        group: typeface,
        ...(role ? { groupLabel: `${typeface} (${ROLE_LABEL[role]})` } : {}),
        count: list.length,
        targets: list.map((u) => u.target),
        fixes: ["replace-font"],
        reachable: reachableCount > 0,
        key: k,
        data,
      }),
    );
  }

  const hiddenFindings = hidden.map((h) =>
    makeFinding({
      area: "fonts",
      kind: "hidden-list-style",
      severity: "warning",
      title: "Hidden list style fonts",
      detail: `${h.ref.name || "A shape"} names ${h.fonts.join(", ")} in its list style, which its text doesn't show.`,
      group: "hidden-list-style",
      groupLabel: "Hidden list styles",
      count: h.fonts.length,
      targets: [{ ...shapeTarget(h.ref, pres, { property: "list-style" }), reachable: false }],
      fixes: [],
      reachable: false,
      key: `${h.ref.container.partName}|${[...h.ref.path, h.ref.shapeId].join("/")}`,
      data: { fonts: h.fonts, levels: h.levels },
    }),
  );

  return [...fonts, ...hiddenFindings];
}

const EMBEDDING_TITLE: Record<EmbeddingStatus, string> = {
  none: "Not embedded",
  subset: "Embedded subset",
  full: "Fully embedded",
};

function runEmbedding({ pres }: CheckContext): Finding[] {
  const status: EmbeddingStatus = pres.embeddedFonts.length === 0 ? "none" : pres.saveSubsetFonts ? "subset" : "full";
  const fonts = pres.embeddedFonts.map((f) => ({ typeface: f.typeface, styles: f.styles.map((s) => s.style as string) }));
  const totalBytes = pres.embeddedFonts.reduce((n, f) => n + f.styles.reduce((m, s) => m + (s.size ?? 0), 0), 0);
  const names = fonts.map((f) => f.typeface).join(", ");
  return [
    makeFinding({
      area: "fonts",
      kind: "font-embedding",
      severity: "info",
      title: EMBEDDING_TITLE[status],
      detail:
        status === "none"
          ? "No fonts are embedded in this presentation."
          : `${names} ${fonts.length === 1 ? "is" : "are"} embedded${status === "subset" ? " (only the characters used)" : ""}.`,
      group: "font-embedding",
      groupLabel: "Font embedding",
      targets: [partTarget("presentation", pres.presentationPart)],
      fixes: [],
      key: "deck",
      data: { status, fonts, saveSubsetFonts: pres.saveSubsetFonts, embedTrueTypeFonts: pres.embedTrueTypeFonts, totalBytes },
    }),
  ];
}

export const fontChecks: Check[] = [
  { id: "fonts", area: "fonts", run: runFonts },
  { id: "fonts-embedding", area: "fonts", run: runEmbedding },
];
