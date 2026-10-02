/**
 * Slide titles and slide numbers (Graphics Ops bulk fixes).
 *
 * Fonts area: every slide title (`p:ph type="title"` / `"ctrTitle"`) with its effective font size
 * and autofit mode, for the `set-title-size` fix; a warning when titles of one placeholder type
 * use more than one size (title slides — `ctrTitle` — are compared only with each other, since
 * they are often intentionally larger); and a note for titles that PowerPoint is shrinking to fit.
 *
 * Review area: slide numbers shown on slides — `sldNum` placeholders and text boxes holding a
 * `slidenum` field — for the `remove-slide-numbers` fix. Layout / master `sldNum` placeholders
 * are listed in the data but are not targets: removing them does not hide numbers on slides.
 *
 * Effective title size, in order: the run's `a:rPr/@sz`, the paragraph's `a:pPr/a:defRPr`, the
 * shape's own `a:lstStyle`, the layout placeholder's `a:lstStyle`, the master placeholder's
 * `a:lstStyle`, the master's `p:titleStyle`, then 18 pt. Sizes are stored in hundredths of a
 * point; findings report points.
 */
import { makeFinding, shapeTarget, type Finding, type FindingTarget } from "../findings";
import { getShapes, type Presentation, type SlideInfo } from "../package/model";
import { TITLE_TYPES, type ContainerKind, type ShapeRef } from "../package/shapes";
import { attr, boolAttr, child, childPath, childrenNamed, descendants, elements, intAttr, localName, textContent, type XmlElement } from "../package/xml";
import type { Check } from "../runner";
import { PlaceholderResolver } from "./review";

// ---------------------------------------------------------------------------------------------
// Data types

/** Where a title's size comes from (the nearest source used by any of its runs). */
export type TitleSizeSource = "shape" | "layout" | "master" | "default";
export type TitleAutofitMode = "none" | "shrink" | "resize";

export interface SlideTitleInfo {
  slideNumber: number;
  slideId: number;
  shapeId: number;
  shapeName: string;
  /** `title` or `ctrTitle`. */
  placeholderType: string;
  hidden: boolean;
  /** Plain text, first 120 characters. */
  text: string;
  /** Distinct effective sizes of the title's runs, ascending, in points. */
  sizesPt: number[];
  inheritedFrom: TitleSizeSource;
  autofit: TitleAutofitMode;
  autofitFrom: TitleSizeSource;
  /** `normAutofit/@fontScale` as a percentage (e.g. 62.5), when set. */
  fontScale?: number;
  /** `normAutofit/@lnSpcReduction` as a percentage, when set. */
  lnSpcReduction?: number;
}

export interface LayoutTitleInfo {
  partName: string;
  name: string;
  placeholderType: string;
  /** Size set on the layout title placeholder itself (lvl 1); absent when it inherits. */
  sizePt?: number;
  effectiveSizePt: number;
}

export interface MasterTitleInfo {
  partName: string;
  name: string;
  /** Size set on the master (title placeholder list style, else `p:titleStyle` lvl 1). */
  sizePt?: number;
  effectiveSizePt: number;
}

export interface SlideTitlesData {
  titles: SlideTitleInfo[];
  distinctSizesPt: number[];
  slidesWithoutTitle: number[];
  layoutTitles: LayoutTitleInfo[];
  masterTitles: MasterTitleInfo[];
}

export interface TitleSizesInconsistentData {
  placeholderType: string;
  sizes: { sizePt: number; slideNumbers: number[] }[];
  /** Size used by the most titles (ties → the larger size). */
  mostCommonPt: number;
}

export interface TitleAutofitShrinksData {
  titles: {
    slideNumber: number;
    slideId: number;
    shapeId: number;
    shapeName: string;
    fontScale: number;
    lnSpcReduction?: number;
    sizesPt: number[];
    /** Sizes after the font scale, rounded to 0.1 pt. */
    renderedSizesPt: number[];
  }[];
}

export type SlideNumberKind = "placeholder" | "field-only-textbox" | "field-in-text";

export interface SlideNumberEntry {
  slideNumber: number;
  slideId: number;
  shapeId: number;
  shapeName: string;
  kind: SlideNumberKind;
  hidden: boolean;
  text: string;
  /** Why the fix cannot remove this one (field mixed with other text). */
  reason?: string;
}

export interface SlideNumbersData {
  slides: SlideNumberEntry[];
  slidesWithNumbers: number[];
  layoutsWithSldNumPlaceholder: { partName: string; name: string }[];
  mastersWithSldNumPlaceholder: { partName: string; name: string }[];
  /** `p:hf` elements on layouts / masters; `sldNum` defaults to true when the attribute is absent. */
  headerFooterFlag?: { partName: string; containerKind: "layout" | "master"; sldNum: boolean }[];
}

declare module "../findings" {
  interface FindingDataMap {
    "slide-titles": SlideTitlesData;
    "title-sizes-inconsistent": TitleSizesInconsistentData;
    "title-autofit-shrinks": TitleAutofitShrinksData;
    "slide-numbers": SlideNumbersData;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const DEFAULT_SZ = 1800;
const TEXT_MAX = 120;
const SOURCE_RANK: Record<TitleSizeSource, number> = { shape: 0, layout: 1, master: 2, default: 3 };

const toPt = (sz: number): number => sz / 100;
const ascending = (a: number, b: number): number => a - b;

function lvlSz(lstStyle: XmlElement | undefined, lvl: number): number | undefined {
  return intAttr(childPath(lstStyle, `lvl${lvl + 1}pPr`, "defRPr"), "sz");
}

function shapeLstStyle(shape: ShapeRef | undefined): XmlElement | undefined {
  return childPath(shape?.node, "txBody", "lstStyle");
}

function paragraphs(shape: XmlElement | undefined): XmlElement[] {
  const tx = child(shape, "txBody");
  return tx ? childrenNamed(tx, "p") : [];
}

function runText(r: XmlElement): string {
  return textContent(child(r, "t"));
}

/** Plain text of a text body: runs and fields, line breaks as spaces, paragraphs joined by spaces. */
function plainText(shape: XmlElement | undefined): string {
  const paras = paragraphs(shape).map((p) =>
    elements(p)
      .map((c) => {
        const n = localName(c.name);
        if (n === "r" || n === "fld") return runText(c);
        if (n === "br") return " ";
        return "";
      })
      .join(""),
  );
  return paras.join(" ").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

function percentAttr(el: XmlElement, name: string): number | undefined {
  const v = attr(el, name)?.trim();
  if (v === undefined || v === "") return undefined;
  const n = v.endsWith("%") ? Number.parseFloat(v) : Number.parseInt(v, 10) / 1000;
  return Number.isFinite(n) ? n : undefined;
}

interface Autofit {
  mode: TitleAutofitMode;
  fontScale?: number;
  lnSpcReduction?: number;
}

const AUTOFIT: Record<string, TitleAutofitMode> = { noAutofit: "none", normAutofit: "shrink", spAutoFit: "resize" };

function explicitAutofit(shape: XmlElement | undefined): Autofit | undefined {
  const bodyPr = childPath(shape, "txBody", "bodyPr");
  for (const c of bodyPr ? elements(bodyPr) : []) {
    const mode = AUTOFIT[localName(c.name)];
    if (!mode) continue;
    const out: Autofit = { mode };
    if (mode === "shrink") {
      const fs = percentAttr(c, "fontScale");
      const ln = percentAttr(c, "lnSpcReduction");
      if (fs !== undefined) out.fontScale = fs;
      if (ln !== undefined) out.lnSpcReduction = ln;
    }
    return out;
  }
  return undefined;
}

function isTitle(ref: ShapeRef): boolean {
  return ref.path.length === 0 && ref.placeholder !== undefined && TITLE_TYPES.has(ref.placeholder.type);
}

function slideContainer(s: SlideInfo): { kind: "slide"; partName: string; slideId: number } {
  return { kind: "slide", partName: s.partName, slideId: s.slideId };
}

/** Per-master `p:titleStyle`, cached. */
class TitleStyles {
  private readonly cache = new Map<string, Promise<XmlElement | undefined>>();
  constructor(private readonly pres: Presentation) {}

  get(masterPart: string | undefined): Promise<XmlElement | undefined> {
    if (masterPart === undefined) return Promise.resolve(undefined);
    let p = this.cache.get(masterPart);
    if (!p) {
      p = this.pres.pkg.xml(masterPart).then((root) => childPath(root, "txStyles", "titleStyle"));
      this.cache.set(masterPart, p);
    }
    return p;
  }
}

interface ResolvedSize {
  sz: number;
  from: TitleSizeSource;
}

/** Inherited (non-run) size at a paragraph level through the shape → layout → master chain. */
function inheritedSize(
  lvl: number,
  chain: { own?: XmlElement; layout?: ShapeRef; master?: ShapeRef; titleStyle?: XmlElement },
  pDefSz?: number,
): ResolvedSize {
  if (pDefSz !== undefined) return { sz: pDefSz, from: "shape" };
  const own = lvlSz(chain.own, lvl);
  if (own !== undefined) return { sz: own, from: "shape" };
  const lay = lvlSz(shapeLstStyle(chain.layout), lvl);
  if (lay !== undefined) return { sz: lay, from: "layout" };
  const mas = lvlSz(shapeLstStyle(chain.master), lvl) ?? lvlSz(chain.titleStyle, lvl);
  if (mas !== undefined) return { sz: mas, from: "master" };
  return { sz: DEFAULT_SZ, from: "default" };
}

/** Effective sizes of every run with text in the title; falls back to the first paragraph's size. */
function runSizes(
  ref: ShapeRef,
  chain: { layout?: ShapeRef; master?: ShapeRef; titleStyle?: XmlElement },
): ResolvedSize[] {
  const own = shapeLstStyle(ref);
  const out: ResolvedSize[] = [];
  const paras = paragraphs(ref.node);
  for (const p of paras) {
    const pPr = child(p, "pPr");
    const lvl = intAttr(pPr, "lvl") ?? 0;
    const pDef = intAttr(child(pPr, "defRPr"), "sz");
    for (const r of elements(p)) {
      const n = localName(r.name);
      if ((n !== "r" && n !== "fld") || runText(r) === "") continue;
      const sz = intAttr(child(r, "rPr"), "sz");
      out.push(sz !== undefined ? { sz, from: "shape" } : inheritedSize(lvl, { ...chain, own }, pDef));
    }
  }
  if (out.length === 0) {
    const p = paras[0];
    const pPr = p ? child(p, "pPr") : undefined;
    const end = intAttr(p ? child(p, "endParaRPr") : undefined, "sz");
    out.push(end !== undefined ? { sz: end, from: "shape" } : inheritedSize(intAttr(pPr, "lvl") ?? 0, { ...chain, own }, intAttr(child(pPr, "defRPr"), "sz")));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Slide titles

interface TitleRow {
  ref: ShapeRef;
  info: SlideTitleInfo;
}

async function runTitles(pres: Presentation): Promise<Finding[]> {
  const resolver = new PlaceholderResolver(pres);
  const styles = new TitleStyles(pres);
  const rows: TitleRow[] = [];
  const withoutTitle: number[] = [];

  for (const s of pres.slides) {
    const shapes = await getShapes(pres, slideContainer(s));
    const titles = shapes.filter((r) => r.kind === "sp" && isTitle(r));
    if (titles.length === 0) withoutTitle.push(s.number);
    for (const ref of titles) {
      const { layout, master } = await resolver.chain(ref);
      const titleStyle = await styles.get(s.masterPart);
      const sizes = runSizes(ref, { ...(layout ? { layout } : {}), ...(master ? { master } : {}), ...(titleStyle ? { titleStyle } : {}) });
      const from = sizes.reduce<TitleSizeSource>((best, x) => (SOURCE_RANK[x.from] < SOURCE_RANK[best] ? x.from : best), "default");

      let autofit = explicitAutofit(ref.node);
      let autofitFrom: TitleSizeSource = "shape";
      if (!autofit) {
        const lay = explicitAutofit(layout?.node);
        const mas = lay ? undefined : explicitAutofit(master?.node);
        autofit = lay ?? mas ?? { mode: "none" };
        autofitFrom = lay ? "layout" : mas ? "master" : "default";
      }

      const info: SlideTitleInfo = {
        slideNumber: s.number,
        slideId: s.slideId,
        shapeId: ref.shapeId,
        shapeName: ref.name,
        placeholderType: ref.placeholder!.type,
        hidden: s.hidden,
        text: plainText(ref.node),
        sizesPt: [...new Set(sizes.map((x) => toPt(x.sz)))].sort(ascending),
        inheritedFrom: from,
        autofit: autofit.mode,
        autofitFrom,
      };
      if (autofit.fontScale !== undefined) info.fontScale = autofit.fontScale;
      if (autofit.lnSpcReduction !== undefined) info.lnSpcReduction = autofit.lnSpcReduction;
      rows.push({ ref, info });
    }
  }

  if (rows.length === 0) return [];

  // Layout and master titles (informational).
  const layoutTitles: LayoutTitleInfo[] = [];
  for (const l of pres.layouts) {
    const ref = (await getShapes(pres, { kind: "layout", partName: l.partName })).find(isTitle);
    if (!ref) continue;
    const { master } = await resolver.chain(ref);
    const titleStyle = await styles.get(l.masterPart);
    const own = lvlSz(shapeLstStyle(ref), 0);
    const eff = own ?? lvlSz(shapeLstStyle(master), 0) ?? lvlSz(titleStyle, 0) ?? DEFAULT_SZ;
    layoutTitles.push({
      partName: l.partName,
      name: l.name,
      placeholderType: ref.placeholder!.type,
      ...(own !== undefined ? { sizePt: toPt(own) } : {}),
      effectiveSizePt: toPt(eff),
    });
  }
  const masterTitles: MasterTitleInfo[] = [];
  for (const m of pres.masters) {
    const ref = (await getShapes(pres, { kind: "master", partName: m.partName })).find(isTitle);
    const sz = lvlSz(shapeLstStyle(ref), 0) ?? lvlSz(await styles.get(m.partName), 0);
    masterTitles.push({ partName: m.partName, name: m.name, ...(sz !== undefined ? { sizePt: toPt(sz) } : {}), effectiveSizePt: toPt(sz ?? DEFAULT_SZ) });
  }

  const target = (r: TitleRow): FindingTarget => {
    const t = shapeTarget(r.ref, pres, { property: "text" });
    t.reachable = true;
    return t;
  };
  const distinct = [...new Set(rows.flatMap((r) => r.info.sizesPt))].sort(ascending);
  const out: Finding[] = [
    makeFinding({
      area: "fonts",
      kind: "slide-titles",
      severity: "info",
      title: `${rows.length} slide title${rows.length === 1 ? "" : "s"} at ${distinct.map((p) => `${p} pt`).join(", ")}`,
      ...(withoutTitle.length ? { detail: `Slides without a title: ${withoutTitle.join(", ")}.` } : {}),
      group: "slide-titles",
      groupLabel: "Slide titles",
      count: rows.length,
      targets: rows.map(target),
      fixes: ["set-title-size"],
      reachable: true,
      data: { titles: rows.map((r) => r.info), distinctSizesPt: distinct, slidesWithoutTitle: withoutTitle, layoutTitles, masterTitles },
    }),
  ];

  // Inconsistent sizes, per placeholder type.
  const byType = new Map<string, TitleRow[]>();
  for (const r of rows) {
    const list = byType.get(r.info.placeholderType) ?? [];
    list.push(r);
    byType.set(r.info.placeholderType, list);
  }
  for (const [type, list] of byType) {
    const bySize = new Map<number, Set<number>>();
    for (const r of list) {
      for (const pt of r.info.sizesPt) {
        const set = bySize.get(pt) ?? new Set<number>();
        set.add(r.info.slideNumber);
        bySize.set(pt, set);
      }
    }
    if (bySize.size < 2) continue;
    const sizes = [...bySize.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sizePt, set]) => ({ sizePt, slideNumbers: [...set].sort(ascending) }));
    const mostCommonPt = sizes.reduce((best, s) => (s.slideNumbers.length >= best.slideNumbers.length ? s : best)).sizePt;
    const label = type === "ctrTitle" ? "Title-slide titles" : "Slide titles";
    out.push(
      makeFinding({
        area: "fonts",
        kind: "title-sizes-inconsistent",
        severity: "warning",
        title: `${label} use ${sizes.length} different sizes`,
        detail: sizes.map((s) => `${s.sizePt} pt on slide${s.slideNumbers.length === 1 ? "" : "s"} ${s.slideNumbers.join(", ")}`).join("; "),
        group: "slide-titles",
        groupLabel: "Slide titles",
        count: list.length,
        targets: list.map(target),
        fixes: ["set-title-size"],
        reachable: true,
        key: type,
        data: { placeholderType: type, sizes, mostCommonPt },
      }),
    );
  }

  // Titles shrunk by autofit.
  const shrunk = rows.filter((r) => r.info.autofit === "shrink" && r.info.fontScale !== undefined && r.info.fontScale < 100);
  if (shrunk.length) {
    out.push(
      makeFinding({
        area: "fonts",
        kind: "title-autofit-shrinks",
        severity: "info",
        title: `${shrunk.length} slide title${shrunk.length === 1 ? " is" : "s are"} shrunk to fit`,
        detail: "PowerPoint scales these titles down so the text fits the placeholder.",
        group: "slide-titles",
        groupLabel: "Slide titles",
        count: shrunk.length,
        targets: shrunk.map(target),
        fixes: [],
        data: {
          titles: shrunk.map((r) => {
            const scale = r.info.fontScale!;
            return {
              slideNumber: r.info.slideNumber,
              slideId: r.info.slideId,
              shapeId: r.info.shapeId,
              shapeName: r.info.shapeName,
              fontScale: scale,
              ...(r.info.lnSpcReduction !== undefined ? { lnSpcReduction: r.info.lnSpcReduction } : {}),
              sizesPt: r.info.sizesPt,
              renderedSizesPt: r.info.sizesPt.map((p) => Math.round(p * scale) / 100),
            };
          }),
        },
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Slide numbers

function isSlideNumField(el: XmlElement): boolean {
  return (attr(el, "type") ?? "").toLowerCase() === "slidenum";
}

/** Text of the shape's own body excluding `slidenum` fields. */
function nonFieldText(shape: XmlElement): string {
  let s = "";
  for (const p of paragraphs(shape)) {
    for (const c of elements(p)) {
      const n = localName(c.name);
      if (n === "r" || (n === "fld" && !isSlideNumField(c))) s += runText(c);
    }
  }
  return s;
}

async function hasSldNumPlaceholder(pres: Presentation, kind: ContainerKind, partName: string): Promise<boolean> {
  return (await getShapes(pres, { kind, partName })).some((r) => r.placeholder?.type === "sldNum");
}

async function runSlideNumbers(pres: Presentation): Promise<Finding[]> {
  const resolver = new PlaceholderResolver(pres);
  const entries: SlideNumberEntry[] = [];
  const targets: FindingTarget[] = [];

  for (const s of pres.slides) {
    for (const ref of await getShapes(pres, slideContainer(s))) {
      let kind: SlideNumberKind | undefined;
      if (ref.placeholder?.type === "sldNum") {
        kind = "placeholder";
      } else if (ref.kind === "sp") {
        const tx = child(ref.node, "txBody");
        if (tx && descendants(tx, "fld").some(isSlideNumField)) kind = nonFieldText(ref.node).trim() === "" ? "field-only-textbox" : "field-in-text";
      } else if (ref.kind === "graphicFrame") {
        if (descendants(ref.node, "fld").some(isSlideNumField)) kind = "field-in-text";
      }
      if (!kind) continue;

      const reachable = kind !== "field-in-text";
      const entry: SlideNumberEntry = {
        slideNumber: s.number,
        slideId: s.slideId,
        shapeId: ref.shapeId,
        shapeName: ref.name,
        kind,
        hidden: s.hidden,
        text: ref.kind === "sp" ? plainText(ref.node) : "",
      };
      if (!reachable) {
        entry.reason =
          ref.kind === "graphicFrame"
            ? "The slide number is inside a table; remove it by hand."
            : "The slide number is mixed with other text; removing the shape would delete that text too.";
      }
      entries.push(entry);

      const t = shapeTarget(ref, pres, { property: kind === "placeholder" ? "placeholder" : "text" });
      if (!t.bounds) {
        const b = await resolver.bounds(ref);
        if (b) t.bounds = { x: b.bounds.x, y: b.bounds.y, cx: b.bounds.cx, cy: b.bounds.cy };
      }
      t.reachable = reachable;
      targets.push(t);
    }
  }
  if (entries.length === 0) return [];

  const layoutsWith: { partName: string; name: string }[] = [];
  for (const l of pres.layouts) if (await hasSldNumPlaceholder(pres, "layout", l.partName)) layoutsWith.push({ partName: l.partName, name: l.name });
  const mastersWith: { partName: string; name: string }[] = [];
  for (const m of pres.masters) if (await hasSldNumPlaceholder(pres, "master", m.partName)) mastersWith.push({ partName: m.partName, name: m.name });

  const hf: NonNullable<SlideNumbersData["headerFooterFlag"]> = [];
  const hfParts: { partName: string; containerKind: "layout" | "master" }[] = [
    ...pres.layouts.map((l) => ({ partName: l.partName, containerKind: "layout" as const })),
    ...pres.masters.map((m) => ({ partName: m.partName, containerKind: "master" as const })),
  ];
  for (const p of hfParts) {
    const el = child(await pres.pkg.xml(p.partName), "hf");
    if (el) hf.push({ ...p, sldNum: boolAttr(el, "sldNum") ?? true });
  }

  const slidesWithNumbers = [...new Set(entries.map((e) => e.slideNumber))].sort(ascending);
  const anyReachable = targets.some((t) => t.reachable);
  return [
    makeFinding({
      area: "review",
      kind: "slide-numbers",
      severity: "info",
      title: `Slide numbers on ${slidesWithNumbers.length} slide${slidesWithNumbers.length === 1 ? "" : "s"}`,
      ...(entries.some((e) => e.reason) ? { detail: "Some slide numbers are mixed with other text and must be removed by hand." } : {}),
      group: "slide-numbers",
      groupLabel: "Slide numbers",
      count: entries.length,
      targets,
      fixes: ["remove-slide-numbers"],
      reachable: anyReachable,
      data: {
        slides: entries,
        slidesWithNumbers,
        layoutsWithSldNumPlaceholder: layoutsWith,
        mastersWithSldNumPlaceholder: mastersWith,
        ...(hf.length ? { headerFooterFlag: hf } : {}),
      },
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Registry

export const titleNumberChecks: Check[] = [
  { id: "slide-titles", area: "fonts", run: ({ pres }) => runTitles(pres) },
  { id: "slide-numbers", area: "review", run: ({ pres }) => runSlideNumbers(pres) },
];
