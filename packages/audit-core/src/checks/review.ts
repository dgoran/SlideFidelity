/**
 * File Review area (U8, R10): content that should not ship (hidden slides and shapes, off-slide
 * shapes, empty placeholders, empty sections), things that leak (notes, comments, properties),
 * and settings worth knowing (animations, transitions, autofit, proofing languages).
 *
 * Hidden shapes, off-slide shapes, and empty placeholders on slides offer the `delete-shapes`
 * fix (R14, U13 "Delete"). Their targets always carry slide-space bounds; placeholders without
 * their own `a:xfrm` inherit bounds from the matching layout placeholder, then the master.
 */
import { makeFinding, partTarget, shapeTarget, slideTarget, type Finding, type FindingTarget } from "../findings";
import { getShapes, shapeContainers, type Presentation, type SlideInfo } from "../package/model";
import { TITLE_TYPES, placeholderClass, type Bounds, type ContainerKind, type PlaceholderInfo, type ShapeRef } from "../package/shapes";
import { attr, boolAttr, child, childPath, descendants, elements, intAttr, localName, type XmlElement } from "../package/xml";
import type { Check } from "../runner";

// ---------------------------------------------------------------------------------------------
// Data types

export interface HiddenSlideData {
  slideId: number;
  slideNumber: number;
}

export interface ShapeFindingData {
  shapeName: string;
  shapeKind: ShapeRef["kind"];
  containerKind: ContainerKind;
  slideNumber?: number;
}

export type OffSlideDirection = "left" | "right" | "above" | "below";

export interface OffSlideShapeData extends ShapeFindingData {
  direction: OffSlideDirection;
  /** True when the bounds come from the layout / master placeholder rather than the shape. */
  inherited: boolean;
  inheritedFrom?: "layout" | "master";
}

export interface EmptyPlaceholderData extends ShapeFindingData {
  placeholderType: string;
  placeholderIdx?: number;
}

export interface EmptySectionData {
  sectionId: string;
  name: string;
}

export interface SpeakerNotesData {
  slideId: number;
  slideNumber: number;
  text: string;
  characters: number;
}

export interface CommentData {
  commentKind: "legacy" | "modern";
  author?: string;
  authorId?: string;
  text: string;
  created?: string;
  /** Modern comments: the comment's own id. */
  commentId?: string;
  /** Modern replies: the id of the comment they answer. */
  parentId?: string;
  isReply: boolean;
  /** Modern top-level comments: number of replies in the thread. */
  replyCount: number;
  slideId?: number;
  slideNumber?: number;
}

export interface DocumentPropertyData {
  source: "core" | "app" | "custom";
  /** Qualified name for core (`dc:creator`), local name for app (`Company`), property name for custom. */
  name: string;
  value: string;
  /** Custom properties: value element type (`lpwstr`, `i4`, `bool`, …). */
  valueType?: string;
}

export interface AnimationData {
  slideId: number;
  slideNumber: number;
  /** Number of preset effects (`p:cTn` with `presetClass`); 0 when the timing tree has none. */
  effectCount: number;
}

export interface TransitionData {
  slideId: number;
  slideNumber: number;
  /** Effect element local name (`fade`, `push`, `vortex`, …); absent for a transition with no effect. */
  type?: string;
  /** `spd`: `slow` | `med` | `fast`. */
  speed?: string;
  /** `p14:dur` in ms. */
  durationMs?: number;
  /** `advTm`: auto-advance after N ms. */
  advanceAfterMs?: number;
  /** `advClick` (defaults to true). */
  advanceOnClick: boolean;
}

export type AutofitMode = "none" | "shrink" | "resize";

export interface AutofitData {
  mode: AutofitMode;
  /** The DrawingML element for the mode. */
  element: "noAutofit" | "normAutofit" | "spAutoFit";
  shapeCount: number;
  slideCount: number;
  /** Shapes whose mode is inherited from a layout / master placeholder (or the default). */
  inheritedCount: number;
}

export interface ProofingLanguageData {
  lang: string;
  /** Shapes with at least one run using the tag as `lang` or `altLang`. */
  shapeCount: number;
  /** Runs with `lang` = tag. */
  runCount: number;
  /** Runs with `altLang` = tag. */
  altLangRunCount: number;
  slideNumbers: number[];
}

declare module "../findings" {
  interface FindingDataMap {
    "hidden-slide": HiddenSlideData;
    "hidden-shape": ShapeFindingData;
    "off-slide-shape": OffSlideShapeData;
    "empty-placeholder": EmptyPlaceholderData;
    "empty-section": EmptySectionData;
    "speaker-notes": SpeakerNotesData;
    comment: CommentData;
    "document-property": DocumentPropertyData;
    animation: AnimationData;
    transition: TransitionData;
    autofit: AutofitData;
    "proofing-language": ProofingLanguageData;
  }
}

const area = "review" as const;

// ---------------------------------------------------------------------------------------------
// Shared helpers

const SHAPE_LOCALS: ReadonlySet<string> = new Set(["sp", "pic", "grpSp", "graphicFrame", "cxnSp", "contentPart"]);

function slideByPart(pres: Presentation, partName: string | undefined): SlideInfo | undefined {
  return partName === undefined ? undefined : pres.slides.find((s) => s.partName === partName);
}

/**
 * Visits `root`'s descendants in document order without entering nested shape elements (so a
 * group's own text is not double-counted with its children's).
 */
function visitOwn(root: XmlElement, fn: (el: XmlElement) => void): void {
  const visit = (el: XmlElement): void => {
    for (const c of elements(el)) {
      if (SHAPE_LOCALS.has(localName(c.name))) continue;
      fn(c);
      visit(c);
    }
  };
  visit(root);
}

function hasVisibleText(node: XmlElement): boolean {
  let found = false;
  visitOwn(node, (el) => {
    if (!found && localName(el.name) === "t") {
      const text = el.children.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (text.trim() !== "") found = true;
    }
  });
  return found;
}

function shapeData(ref: ShapeRef, pres: Presentation): ShapeFindingData {
  const slide = ref.container.kind === "slide" ? slideByPart(pres, ref.container.partName) : undefined;
  return {
    shapeName: ref.name,
    shapeKind: ref.kind,
    containerKind: ref.container.kind,
    ...(slide ? { slideNumber: slide.number } : {}),
  };
}

function where(ref: ShapeRef, pres: Presentation): string {
  const c = ref.container;
  if (c.kind === "slide") return `slide ${slideByPart(pres, c.partName)?.number ?? "?"}`;
  if (c.kind === "layout") return `layout "${pres.layouts.find((l) => l.partName === c.partName)?.name ?? c.partName}"`;
  return `master ${pres.masters.findIndex((m) => m.partName === c.partName) + 1}`;
}

/** Shape ids of `ref`'s ancestors that are graphic frames (Office.js cannot delete inside those). */
function insideGraphicFrame(ref: ShapeRef, byId: ReadonlyMap<number, ShapeRef>): boolean {
  return ref.path.some((id) => byId.get(id)?.kind === "graphicFrame");
}

// ---------------------------------------------------------------------------------------------
// Placeholder inheritance

function sameTypeFamily(a: string, b: string): boolean {
  return a === b || (TITLE_TYPES.has(a) && TITLE_TYPES.has(b));
}

/** The layout placeholder a slide placeholder inherits from (idx first, then type). */
function matchLayoutPh(shapes: readonly ShapeRef[], ph: PlaceholderInfo): ShapeRef | undefined {
  const candidates = shapes.filter((s) => s.path.length === 0 && s.placeholder);
  if (ph.idx !== undefined && !TITLE_TYPES.has(ph.type)) {
    const byIdx = candidates.filter((s) => s.placeholder?.idx === ph.idx);
    // An idx without a layout counterpart is orphaned: it inherits from the master by type.
    return byIdx.find((s) => sameTypeFamily(s.placeholder!.type, ph.type)) ?? byIdx[0];
  }
  return candidates.find((s) => sameTypeFamily(s.placeholder!.type, ph.type));
}

function matchMasterPh(shapes: readonly ShapeRef[], ph: PlaceholderInfo): ShapeRef | undefined {
  const want = placeholderClass(ph.type);
  return shapes.find((s) => s.path.length === 0 && s.placeholder !== undefined && placeholderClass(s.placeholder.type) === want);
}

interface Inheritance {
  layout?: ShapeRef;
  master?: ShapeRef;
}

class PlaceholderResolver {
  constructor(private readonly pres: Presentation) {}

  private shapes(kind: ContainerKind, partName: string | undefined): Promise<ShapeRef[]> {
    if (partName === undefined) return Promise.resolve([]);
    return getShapes(this.pres, { kind, partName });
  }

  /** The layout and master placeholders `ref` inherits from (slide or layout placeholders). */
  async chain(ref: ShapeRef): Promise<Inheritance> {
    const ph = ref.placeholder;
    if (!ph || ref.path.length > 0) return {};
    const c = ref.container;
    if (c.kind === "slide") {
      const slide = slideByPart(this.pres, c.partName);
      const layout = matchLayoutPh(await this.shapes("layout", slide?.layoutPart), ph);
      const master = matchMasterPh(await this.shapes("master", slide?.masterPart), layout?.placeholder ?? ph);
      return { ...(layout ? { layout } : {}), ...(master ? { master } : {}) };
    }
    if (c.kind === "layout") {
      const l = this.pres.layouts.find((x) => x.partName === c.partName);
      const master = matchMasterPh(await this.shapes("master", l?.masterPart), ph);
      return master ? { master } : {};
    }
    return {};
  }

  /** Own bounds, else inherited bounds with their source. */
  async bounds(ref: ShapeRef): Promise<{ bounds: Bounds; from?: "layout" | "master" } | undefined> {
    if (ref.bounds) return { bounds: ref.bounds };
    const { layout, master } = await this.chain(ref);
    if (layout?.bounds) return { bounds: layout.bounds, from: "layout" };
    if (master?.bounds) return { bounds: master.bounds, from: "master" };
    return undefined;
  }
}

function withBounds(t: FindingTarget, b: Bounds | undefined): FindingTarget {
  if (b) t.bounds = { x: b.x, y: b.y, cx: b.cx, cy: b.cy };
  return t;
}

// ---------------------------------------------------------------------------------------------
// Slides and sections

function runSlides(pres: Presentation): Finding[] {
  const out: Finding[] = [];
  for (const s of pres.slides) {
    if (!s.hidden) continue;
    out.push(
      makeFinding({
        area,
        kind: "hidden-slide",
        severity: "warning",
        title: `Slide ${s.number} is hidden`,
        detail: "Hidden slides are skipped in the slide show but still travel with the file.",
        group: "hidden-slides",
        groupLabel: "Hidden slides",
        targets: [slideTarget(s)],
        fixes: [],
        data: { slideId: s.slideId, slideNumber: s.number },
      }),
    );
  }
  for (const sec of pres.sections) {
    if (sec.slideIds.length > 0) continue;
    out.push(
      makeFinding({
        area,
        kind: "empty-section",
        severity: "warning",
        title: `Section "${sec.name}" is empty`,
        group: "empty-sections",
        groupLabel: "Empty sections",
        targets: [partTarget("presentation", pres.presentationPart, { name: sec.name })],
        fixes: [],
        key: sec.id,
        data: { sectionId: sec.id, name: sec.name },
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shapes: hidden, off-slide, empty placeholders

function offSlideDirection(b: Bounds, w: number, h: number): OffSlideDirection | undefined {
  if (b.x >= w) return "right";
  if (b.x + b.cx <= 0) return "left";
  if (b.y >= h) return "below";
  if (b.y + b.cy <= 0) return "above";
  return undefined;
}

async function runShapes(pres: Presentation): Promise<Finding[]> {
  const hidden: Finding[] = [];
  const offSlide: Finding[] = [];
  const empty: Finding[] = [];
  const resolver = new PlaceholderResolver(pres);
  const size = pres.slideSize;

  for (const container of shapeContainers(pres)) {
    const shapes = await getShapes(pres, container);
    const byId = new Map(shapes.map((s) => [s.shapeId, s]));
    const onSlide = container.kind === "slide";
    const hiddenIds = new Set<number>();
    const offIds = new Set<number>();

    for (const ref of shapes) {
      const reachable = onSlide && !insideGraphicFrame(ref, byId);
      const resolved = await resolver.bounds(ref);

      // Hidden: report the outermost hidden shape only (deleting it removes its children).
      if (ref.hidden) {
        hiddenIds.add(ref.shapeId);
        if (!ref.path.some((id) => hiddenIds.has(id))) {
          const t = withBounds(shapeTarget(ref, pres), resolved?.bounds);
          t.reachable = reachable;
          hidden.push(
            makeFinding({
              area,
              kind: "hidden-shape",
              severity: "warning",
              title: `Hidden shape "${ref.name}" on ${where(ref, pres)}`,
              group: "hidden-shapes",
              groupLabel: "Hidden shapes",
              targets: [t],
              fixes: ["delete-shapes"],
              reachable,
              data: shapeData(ref, pres),
            }),
          );
        }
      }

      // Off-slide: bounding box entirely outside the slide; outermost only.
      if (size && resolved && !ref.path.some((id) => offIds.has(id))) {
        const direction = offSlideDirection(resolved.bounds, size.cx, size.cy);
        if (direction) {
          offIds.add(ref.shapeId);
          const t = withBounds(shapeTarget(ref, pres), resolved.bounds);
          t.reachable = reachable;
          offSlide.push(
            makeFinding({
              area,
              kind: "off-slide-shape",
              severity: "warning",
              title: `"${ref.name}" is off the slide on ${where(ref, pres)}`,
              ...(resolved.from ? { detail: `Position inherited from the ${resolved.from} placeholder.` } : {}),
              group: "off-slide-shapes",
              groupLabel: "Off-slide shapes",
              targets: [t],
              fixes: ["delete-shapes"],
              reachable,
              data: {
                ...shapeData(ref, pres),
                direction,
                inherited: resolved.from !== undefined,
                ...(resolved.from ? { inheritedFrom: resolved.from } : {}),
              },
            }),
          );
        }
      }

      // Empty placeholders (slides only: layout / master placeholders are prompts by design).
      const ph = ref.placeholder;
      if (onSlide && ph && ref.kind === "sp" && !hasVisibleText(ref.node) && !child(child(ref.node, "spPr"), "blipFill")) {
        const t = withBounds(shapeTarget(ref, pres), resolved?.bounds);
        t.reachable = reachable;
        empty.push(
          makeFinding({
            area,
            kind: "empty-placeholder",
            severity: "warning",
            title: `Empty placeholder "${ref.name}" on ${where(ref, pres)}`,
            detail: "Empty placeholders show their prompt text while editing and can confuse reviewers.",
            group: "empty-placeholders",
            groupLabel: "Empty placeholders",
            targets: [t],
            fixes: ["delete-shapes"],
            reachable,
            data: {
              ...shapeData(ref, pres),
              placeholderType: ph.type,
              ...(ph.idx !== undefined ? { placeholderIdx: ph.idx } : {}),
            },
          }),
        );
      }
    }
  }
  return [...hidden, ...offSlide, ...empty];
}

// ---------------------------------------------------------------------------------------------
// Text settings: autofit and proofing languages (slides only)

const AUTOFIT: Record<string, { mode: AutofitMode; element: AutofitData["element"] }> = {
  noAutofit: { mode: "none", element: "noAutofit" },
  normAutofit: { mode: "shrink", element: "normAutofit" },
  spAutoFit: { mode: "resize", element: "spAutoFit" },
};
const AUTOFIT_LABEL: Record<AutofitMode, string> = {
  none: "Do not autofit",
  shrink: "Shrink text on overflow",
  resize: "Resize shape to fit text",
};

function explicitAutofit(shape: XmlElement | undefined): AutofitMode | undefined {
  const bodyPr = childPath(shape, "txBody", "bodyPr");
  for (const c of bodyPr ? elements(bodyPr) : []) {
    const m = AUTOFIT[localName(c.name)];
    if (m) return m.mode;
  }
  return undefined;
}

async function runText(pres: Presentation): Promise<Finding[]> {
  const resolver = new PlaceholderResolver(pres);
  const autofit = new Map<AutofitMode, { targets: FindingTarget[]; slides: Set<number>; inherited: number }>();
  const langs = new Map<string, { targets: FindingTarget[]; runs: number; altRuns: number; slides: Set<number> }>();

  for (const s of pres.slides) {
    const shapes = await getShapes(pres, { kind: "slide", partName: s.partName, slideId: s.slideId });
    for (const ref of shapes) {
      if (ref.kind === "sp" && child(ref.node, "txBody")) {
        let mode = explicitAutofit(ref.node);
        let inherited = false;
        if (mode === undefined) {
          inherited = true;
          const { layout, master } = await resolver.chain(ref);
          mode = explicitAutofit(layout?.node) ?? explicitAutofit(master?.node) ?? "none";
        }
        let bucket = autofit.get(mode);
        if (!bucket) {
          bucket = { targets: [], slides: new Set(), inherited: 0 };
          autofit.set(mode, bucket);
        }
        bucket.targets.push(shapeTarget(ref, pres, { property: "text" }));
        bucket.slides.add(s.number);
        if (inherited) bucket.inherited++;
      }

      if (ref.kind === "grpSp") continue;
      const perShape = new Map<string, { runs: number; altRuns: number }>();
      visitOwn(ref.node, (el) => {
        const l = localName(el.name);
        if (l !== "r" && l !== "fld") return;
        const rPr = child(el, "rPr");
        const lang = attr(rPr, "lang");
        const alt = attr(rPr, "altLang");
        for (const [tag, isAlt] of [
          [lang, false],
          [alt, true],
        ] as const) {
          if (!tag) continue;
          const e = perShape.get(tag) ?? { runs: 0, altRuns: 0 };
          if (isAlt) e.altRuns++;
          else e.runs++;
          perShape.set(tag, e);
        }
      });
      for (const [tag, e] of perShape) {
        let bucket = langs.get(tag);
        if (!bucket) {
          bucket = { targets: [], runs: 0, altRuns: 0, slides: new Set() };
          langs.set(tag, bucket);
        }
        bucket.targets.push(shapeTarget(ref, pres, { property: "text" }));
        bucket.runs += e.runs;
        bucket.altRuns += e.altRuns;
        bucket.slides.add(s.number);
      }
    }
  }

  const out: Finding[] = [];
  for (const mode of ["none", "shrink", "resize"] as const) {
    const b = autofit.get(mode);
    if (!b) continue;
    const n = b.targets.length;
    out.push(
      makeFinding({
        area,
        kind: "autofit",
        severity: "info",
        title: `${AUTOFIT_LABEL[mode]}: ${n} shape${n === 1 ? "" : "s"}`,
        group: "autofit",
        groupLabel: "Text autofit",
        count: n,
        targets: b.targets,
        fixes: [],
        key: mode,
        data: {
          mode,
          element: mode === "none" ? "noAutofit" : mode === "shrink" ? "normAutofit" : "spAutoFit",
          shapeCount: n,
          slideCount: b.slides.size,
          inheritedCount: b.inherited,
        },
      }),
    );
  }
  for (const [tag, b] of langs) {
    const n = b.targets.length;
    out.push(
      makeFinding({
        area,
        kind: "proofing-language",
        severity: "info",
        title: `${tag}: ${n} shape${n === 1 ? "" : "s"}`,
        group: "languages",
        groupLabel: "Proofing languages",
        count: n,
        targets: b.targets,
        fixes: [],
        key: tag,
        data: {
          lang: tag,
          shapeCount: n,
          runCount: b.runs,
          altLangRunCount: b.altRuns,
          slideNumbers: [...b.slides].sort((x, y) => x - y),
        },
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Notes and comments

function runNotesAndComments(pres: Presentation): Finding[] {
  const out: Finding[] = [];
  for (const n of pres.notes) {
    const text = n.text.trim();
    if (text === "") continue;
    const slide = slideByPart(pres, n.slidePart);
    if (!slide) continue;
    out.push(
      makeFinding({
        area,
        kind: "speaker-notes",
        severity: "info",
        title: `Slide ${slide.number} has speaker notes`,
        group: "speaker-notes",
        groupLabel: "Speaker notes",
        targets: [partTarget("notes", n.partName, { slide })],
        fixes: [],
        data: { slideId: slide.slideId, slideNumber: slide.number, text, characters: text.length },
      }),
    );
  }

  pres.comments.forEach((c, i) => {
    const slide = slideByPart(pres, c.slidePart);
    const isReply = c.parentId !== undefined;
    const replyCount =
      c.kind === "modern" && !isReply && c.id !== undefined
        ? pres.comments.filter((r) => r.partName === c.partName && r.parentId === c.id).length
        : 0;
    const author = c.authorName ?? "Unknown author";
    out.push(
      makeFinding({
        area,
        kind: "comment",
        severity: "info",
        title: `${isReply ? "Reply" : "Comment"} by ${author}${slide ? ` on slide ${slide.number}` : ""}`,
        group: "comments",
        groupLabel: "Comments",
        targets: [partTarget("comments", c.partName, slide ? { slide } : {})],
        fixes: [],
        key: `${c.partName}#${c.id ?? i}`,
        data: {
          commentKind: c.kind,
          text: c.text,
          isReply,
          replyCount,
          ...(c.authorName !== undefined ? { author: c.authorName } : {}),
          ...(c.authorId !== undefined ? { authorId: c.authorId } : {}),
          ...(c.created !== undefined ? { created: c.created } : {}),
          ...(c.id !== undefined ? { commentId: c.id } : {}),
          ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
          ...(slide ? { slideId: slide.slideId, slideNumber: slide.number } : {}),
        },
      }),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Document properties

/** app.xml statistics and producer fields that say nothing about the author or client. */
const APP_STATISTICS: ReadonlySet<string> = new Set([
  "Application",
  "AppVersion",
  "Characters",
  "CharactersWithSpaces",
  "DocSecurity",
  "HiddenSlides",
  "HyperlinksChanged",
  "Lines",
  "LinksUpToDate",
  "MMClips",
  "Notes",
  "Pages",
  "Paragraphs",
  "PresentationFormat",
  "ScaleCrop",
  "SharedDoc",
  "Slides",
  "TotalTime",
  "Words",
]);

async function runProperties(pres: Presentation): Promise<Finding[]> {
  const rootRels = await pres.pkg.rels("").catch(() => []);
  const partOf = (shortType: string, fallback: string): string =>
    rootRels.find((r) => r.shortType === shortType && r.targetPart)?.targetPart ?? fallback;
  const parts = {
    core: partOf("core-properties", "docProps/core.xml"),
    app: partOf("extended-properties", "docProps/app.xml"),
    custom: partOf("custom-properties", "docProps/custom.xml"),
  };
  const out: Finding[] = [];
  const push = (source: DocumentPropertyData["source"], name: string, value: string, valueType?: string): void => {
    const v = value.trim();
    if (v === "") return;
    const custom = source === "custom";
    out.push(
      makeFinding({
        area,
        kind: "document-property",
        severity: custom ? "warning" : "info",
        title: `${custom ? "Custom property" : "Property"} ${name}: ${v}`,
        ...(custom ? { detail: "Custom properties often carry client or project names from a template." } : {}),
        group: `properties-${source}`,
        groupLabel: source === "core" ? "Document properties" : source === "app" ? "Application properties" : "Custom properties",
        targets: [partTarget("properties", parts[source], { name })],
        fixes: [],
        key: `${source}:${name}`,
        data: { source, name, value: v, ...(valueType !== undefined ? { valueType } : {}) },
      }),
    );
  };
  for (const [name, value] of Object.entries(pres.properties.core)) push("core", name, value);
  for (const [name, value] of Object.entries(pres.properties.app)) {
    if (!APP_STATISTICS.has(name)) push("app", name, value);
  }
  for (const p of pres.properties.custom) push("custom", p.name, p.value, p.valueType);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Animations and transitions

/** Direct child `name` of the slide root, looking through `mc:AlternateContent` (Choice first). */
function slideChild(root: XmlElement, name: string): XmlElement | undefined {
  for (const el of elements(root)) {
    const l = localName(el.name);
    if (l === name) return el;
    if (l === "AlternateContent") {
      const branch = child(el, "Choice") ?? child(el, "Fallback");
      const found = branch ? child(branch, name) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

async function runTiming(pres: Presentation): Promise<Finding[]> {
  const anims: Finding[] = [];
  const transitions: Finding[] = [];
  for (const s of pres.slides) {
    const root = await pres.pkg.xml(s.partName);
    if (!root) continue;
    const timing = slideChild(root, "timing");
    const cTns = timing ? descendants(timing, "cTn") : [];
    if (cTns.length > 0) {
      const effectCount = cTns.filter((c) => attr(c, "presetClass") !== undefined).length;
      anims.push(
        makeFinding({
          area,
          kind: "animation",
          severity: "info",
          title: `Slide ${s.number} has animations`,
          group: "animations",
          groupLabel: "Animations",
          ...(effectCount > 0 ? { count: effectCount } : {}),
          targets: [slideTarget(s)],
          fixes: [],
          data: { slideId: s.slideId, slideNumber: s.number, effectCount },
        }),
      );
    }
    const tr = slideChild(root, "transition");
    if (tr) {
      const effect = elements(tr).find((e) => !["sndAc", "extLst"].includes(localName(e.name)));
      const type = effect ? localName(effect.name) : undefined;
      const speed = attr(tr, "spd");
      const durAttr = Object.keys(tr.attrs).find((k) => localName(k) === "dur");
      const durationMs = durAttr ? intAttr(tr, durAttr) : undefined;
      const advanceAfterMs = intAttr(tr, "advTm");
      transitions.push(
        makeFinding({
          area,
          kind: "transition",
          severity: "info",
          title: `Slide ${s.number} has a${type ? ` ${type}` : ""} transition`,
          group: "transitions",
          groupLabel: "Transitions",
          targets: [slideTarget(s)],
          fixes: [],
          data: {
            slideId: s.slideId,
            slideNumber: s.number,
            advanceOnClick: boolAttr(tr, "advClick") ?? true,
            ...(type !== undefined ? { type } : {}),
            ...(speed !== undefined ? { speed } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(advanceAfterMs !== undefined ? { advanceAfterMs } : {}),
          },
        }),
      );
    }
  }
  return [...anims, ...transitions];
}

// ---------------------------------------------------------------------------------------------

export const reviewChecks: Check[] = [
  { id: "review-slides", area: "review", run: ({ pres }) => runSlides(pres) },
  { id: "review-shapes", area: "review", run: ({ pres }) => runShapes(pres) },
  { id: "review-notes-comments", area: "review", run: ({ pres }) => runNotesAndComments(pres) },
  { id: "review-properties", area: "review", run: ({ pres }) => runProperties(pres) },
  { id: "review-timing", area: "review", run: ({ pres }) => runTiming(pres) },
  { id: "review-text", area: "review", run: ({ pres }) => runText(pres) },
];
