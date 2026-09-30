/**
 * Links area (U9, R9): external hyperlinks and linked files on slides, layouts, and masters.
 *
 * - `hyperlink` (info): one finding per external `a:hlinkClick` / `a:hlinkHover` (text runs and
 *   shape-level `p:cNvPr`). Slide click links carry a `HyperlinkLocator` built with the same
 *   semantics as `apps/addin/src/office/ids.ts` `buildHyperlinkKeys` (click links only, in
 *   document order, per slide) and are fixable (edit / remove, R15). Hover links and layout /
 *   master links are listed but `reachable: false`.
 * - `linked-file` (warning): OLE objects, images, video, and audio whose relationship is
 *   `TargetMode="External"` (`r:id` / `r:link` / `r:embed`), including backgrounds.
 * - `local-path-link` (warning): `file:` URLs, drive letters, UNC and relative paths; they break
 *   on any other machine.
 * - `unsafe-link-scheme` (warning): `javascript:`, `vbscript:`, `data:` targets. The UI must never
 *   make these clickable.
 *
 * Internal jumps (`ppaction://hlinksldjump`, `hlinkshowjump`, internal relationships to slides)
 * are excluded. Every deck string here is untrusted and carried as plain data.
 */
import {
  makeFinding,
  partTarget,
  shapeTarget,
  slideTarget,
  type Finding,
  type FindingTarget,
  type FixKind,
  type HyperlinkLocator,
  type TargetLocator,
} from "../findings";
import type { Presentation } from "../package/model";
import { getShapes, relationshipsOf, shapeContainers } from "../package/model";
import type { Relationship } from "../package/rels";
import type { ContainerKind, ShapeContainer, ShapeRef } from "../package/shapes";
import { attr, child, elements, localName, relAttr, textContent, type XmlElement } from "../package/xml";
import type { Check } from "../runner";

// ---------------------------------------------------------------------------------------------
// Data types

export type LinkTrigger = "click" | "hover";
export type LinkedFileType = "ole" | "image" | "video" | "audio" | "media" | "other";
export type LocalPathKind = "file-url" | "drive" | "unc" | "relative";
export type UnsafeScheme = "javascript" | "vbscript" | "data";
export type LinkKind = "hyperlink" | "linked-file";

export interface HyperlinkData {
  /** Relationship target exactly as written (untrusted). */
  address: string;
  /** Lower-case URI scheme (`https`, `mailto`, …); `""` for paths without one. */
  scheme: string;
  trigger: LinkTrigger;
  /** `shape`: on the shape itself (`p:cNvPr`); `text`: on a text run / paragraph. */
  location: "shape" | "text";
  /** Display text of the linked run, when the link is on a run. */
  text?: string;
  relId: string;
  containerKind: ContainerKind;
  /** True only for `http`/`https`: the only URLs ever sent to the link checker (R11, R18). */
  checkable: boolean;
}

export interface LinkedFileData {
  /** Relationship target exactly as written (untrusted). */
  target: string;
  linkType: LinkedFileType;
  /** Short relationship type (`oleObject`, `image`, `video`, …). */
  relType: string;
  relId: string;
  /** `p:oleObj/@progId` (e.g. `Excel.Sheet.12`). */
  progId?: string;
  containerKind: ContainerKind;
}

export interface LocalPathLinkData {
  address: string;
  pathKind: LocalPathKind;
  linkKind: LinkKind;
}

export interface UnsafeLinkSchemeData {
  address: string;
  scheme: UnsafeScheme;
  linkKind: LinkKind;
}

declare module "../findings" {
  interface FindingDataMap {
    hyperlink: HyperlinkData;
    "linked-file": LinkedFileData;
    "local-path-link": LocalPathLinkData;
    "unsafe-link-scheme": UnsafeLinkSchemeData;
  }
}

// ---------------------------------------------------------------------------------------------
// Address classification

export type AddressClass = "web" | "local" | "unsafe" | "other";

export interface AddressInfo {
  class: AddressClass;
  /** Lower-case scheme, `""` when none. */
  scheme: string;
  pathKind?: LocalPathKind;
  unsafeScheme?: UnsafeScheme;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/;

/**
 * Classify a link target. ASCII whitespace and control characters are ignored for
 * classification (browsers strip them, so `java\tscript:` is still `javascript:`); the original
 * string is never rewritten.
 */
export function classifyAddress(address: string): AddressInfo {
  // eslint-disable-next-line no-control-regex
  const norm = address.replace(/[\u0000- \u007f]/g, "").toLowerCase();
  if (norm === "" || norm.startsWith("#")) return { class: "other", scheme: "" };
  const unsafe = /^(javascript|vbscript|data):/.exec(norm);
  if (unsafe) return { class: "unsafe", scheme: unsafe[1]!, unsafeScheme: unsafe[1] as UnsafeScheme };
  if (/^[a-z]:([\\/]|$)/.test(norm)) return { class: "local", scheme: "", pathKind: "drive" };
  if (norm.startsWith("\\\\") || norm.startsWith("//")) return { class: "local", scheme: "", pathKind: "unc" };
  const m = SCHEME.exec(norm);
  if (!m) return { class: "local", scheme: "", pathKind: "relative" };
  const scheme = m[1]!;
  if (scheme === "file") return { class: "local", scheme, pathKind: "file-url" };
  if (scheme === "http" || scheme === "https") return { class: "web", scheme };
  return { class: "other", scheme };
}

// ---------------------------------------------------------------------------------------------
// Collection

const SHAPE_KINDS: ReadonlySet<string> = new Set(["sp", "pic", "grpSp", "graphicFrame", "cxnSp", "contentPart"]);
const HLINK = new Set(["hlinkClick", "hlinkHover"]);
const REL_ATTRS = ["id", "embed", "link", "pict"] as const;
/** Actions that jump inside the presentation even when a relationship is present. */
const INTERNAL_ACTION = /^ppaction:\/\/(hlinksldjump|hlinkshowjump|customshow|noaction|macro)/i;

interface TextPos {
  paragraphIndex?: number;
  runIndex?: number;
  cell?: { row: number; col: number };
  text?: string;
}

interface RawHyperlink extends TextPos {
  type: "hyperlink";
  trigger: LinkTrigger;
  relId: string;
  action?: string;
  location: "shape" | "text";
}

interface RawRef {
  type: "ref";
  relId: string;
  progId?: string;
}

type RawLink = RawHyperlink | RawRef;

function alternateBranch(ac: XmlElement): XmlElement | undefined {
  return child(ac, "Choice") ?? child(ac, "Fallback");
}

/** Links in a shape's own XML (nested shapes are separate `ShapeRef`s), in document order. */
function collectShapeLinks(root: XmlElement): RawLink[] {
  const out: RawLink[] = [];
  const visit = (el: XmlElement, pos: TextPos, inCNvPr: boolean): void => {
    const counters = new Map<string, number>();
    for (const c of elements(el)) {
      const local = localName(c.name);
      const index = counters.get(local) ?? 0;
      counters.set(local, index + 1);
      if (SHAPE_KINDS.has(local)) continue;
      if (local === "AlternateContent") {
        const branch = alternateBranch(c);
        if (branch) visit(branch, pos, inCNvPr);
        continue;
      }
      if (HLINK.has(local)) {
        const action = attr(c, "action");
        out.push({
          type: "hyperlink",
          trigger: local === "hlinkHover" ? "hover" : "click",
          relId: relAttr(c, "id") ?? "",
          ...(action !== undefined ? { action } : {}),
          location: inCNvPr ? "shape" : "text",
          ...(inCNvPr ? {} : pos),
        });
        continue;
      }
      for (const a of REL_ATTRS) {
        const relId = relAttr(c, a);
        if (relId) {
          const progId = local === "oleObj" ? attr(c, "progId") : undefined;
          out.push({ type: "ref", relId, ...(progId !== undefined ? { progId } : {}) });
        }
      }
      let next = pos;
      if (local === "tr") next = { cell: { row: index, col: pos.cell?.col ?? 0 } };
      else if (local === "tc") next = { cell: { row: pos.cell?.row ?? 0, col: index } };
      else if (local === "p") next = { ...(pos.cell ? { cell: pos.cell } : {}), paragraphIndex: index };
      else if (local === "r") next = { ...pos, runIndex: index, text: textContent(child(c, "t")) };
      else if (local === "fld") next = { ...pos, text: textContent(child(c, "t")) };
      visit(c, next, inCNvPr || local === "cNvPr");
    }
  };
  visit(root, {}, false);
  return out;
}

/** Links in a container part outside its shape tree (e.g. a linked background image). */
function collectOutsideShapeTree(root: XmlElement): RawRef[] {
  const out: RawRef[] = [];
  const visit = (el: XmlElement): void => {
    for (const c of elements(el)) {
      const local = localName(c.name);
      if (local === "spTree" || HLINK.has(local)) continue;
      if (local === "AlternateContent") {
        const b = alternateBranch(c);
        if (b) visit(b);
        continue;
      }
      for (const a of REL_ATTRS) {
        const relId = relAttr(c, a);
        if (relId) out.push({ type: "ref", relId });
      }
      visit(c);
    }
  };
  visit(root);
  return out;
}

function linkedFileType(rel: Relationship): LinkedFileType {
  switch (rel.shortType) {
    case "oleObject":
      return "ole";
    case "image":
    case "hdphoto":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "media":
      return "media";
    default:
      return "other";
  }
}

const FILE_TITLES: Record<LinkedFileType, string> = {
  ole: "Linked object",
  image: "Linked image",
  video: "Linked video",
  audio: "Linked audio",
  media: "Linked media",
  other: "Linked file",
};

const HYPERLINK_FIXES: FixKind[] = ["edit-hyperlink", "remove-hyperlink"];

// ---------------------------------------------------------------------------------------------
// The check

interface Located {
  target: FindingTarget;
  reachable: boolean;
  fixes: FixKind[];
  key: string;
  containerLabel?: string;
}

function warningsFor(address: string, linkKind: LinkKind, loc: Located): Finding[] {
  const info = classifyAddress(address);
  const common = {
    area: "links" as const,
    severity: "warning" as const,
    group: address,
    targets: [loc.target],
    fixes: loc.fixes,
    ...(loc.fixes.length > 0 ? { reachable: loc.reachable } : {}),
  };
  if (info.class === "unsafe" && info.unsafeScheme) {
    return [
      makeFinding({
        ...common,
        kind: "unsafe-link-scheme",
        key: loc.key,
        title: `Link uses an unsafe ${info.unsafeScheme}: address`,
        detail: "Script and data addresses can run code or hide content. SlideCheck never opens them.",
        data: { address, scheme: info.unsafeScheme, linkKind },
      }),
    ];
  }
  if (info.class === "local" && info.pathKind) {
    return [
      makeFinding({
        ...common,
        kind: "local-path-link",
        key: loc.key,
        title: "Link to a local file path",
        detail: "Links to files on this computer or a network share break when the deck is opened on another machine.",
        data: { address, pathKind: info.pathKind, linkKind },
      }),
    ];
  }
  return [];
}

async function containerFindings(pres: Presentation, container: ShapeContainer): Promise<Finding[]> {
  const rels = await relationshipsOf(pres, container.partName);
  const relById = new Map(rels.map((r) => [r.id, r]));
  const consumed = new Set<string>();
  const shapes = await getShapes(pres, container);
  const isSlide = container.kind === "slide";
  const slide = isSlide ? pres.slides.find((s) => s.partName === container.partName) : undefined;
  const containerName =
    container.kind === "layout"
      ? pres.layouts.find((l) => l.partName === container.partName)?.name
      : container.kind === "master"
        ? pres.masters.find((m) => m.partName === container.partName)?.name
        : undefined;

  type Hl = { shape: ShapeRef; raw: RawHyperlink; rel: Relationship };
  type File = { shape?: ShapeRef; raw: RawRef; rel: Relationship };
  const links: Hl[] = [];
  const files: File[] = [];

  for (const shape of shapes) {
    const seenFiles = new Set<string>();
    for (const raw of collectShapeLinks(shape.node)) {
      const rel = relById.get(raw.relId);
      if (!rel) continue;
      consumed.add(rel.id);
      if (rel.targetMode !== "External" || rel.target.trim() === "") continue;
      if (raw.type === "hyperlink") {
        if (raw.action && INTERNAL_ACTION.test(raw.action)) continue;
        links.push({ shape, raw, rel });
      } else if (rel.shortType !== "hyperlink" && !seenFiles.has(rel.id)) {
        seenFiles.add(rel.id);
        files.push({ shape, raw, rel });
      }
    }
  }

  // References outside the shape tree (backgrounds), then any unreferenced external file rels.
  const root = await pres.pkg.xml(container.partName);
  const outside: File[] = [];
  const seenOutside = new Set<string>();
  for (const raw of root ? collectOutsideShapeTree(root) : []) {
    const rel = relById.get(raw.relId);
    if (!rel || consumed.has(rel.id) || seenOutside.has(rel.id)) continue;
    seenOutside.add(rel.id);
    if (rel.targetMode === "External" && rel.shortType !== "hyperlink" && rel.target.trim() !== "") outside.push({ raw, rel });
  }
  for (const rel of rels) {
    if (consumed.has(rel.id) || seenOutside.has(rel.id)) continue;
    if (rel.targetMode === "External" && rel.shortType !== "hyperlink" && rel.target.trim() !== "") {
      outside.push({ raw: { type: "ref", relId: rel.id }, rel });
    }
  }
  files.push(...outside);

  // Hyperlink join keys: slide click links only (what `slide.hyperlinks` exposes), document order.
  const keys = new Map<Hl, HyperlinkLocator>();
  if (isSlide) {
    const clicks = links.filter((l) => l.raw.trigger === "click");
    const totals = new Map<string, number>();
    for (const l of clicks) totals.set(l.rel.target, (totals.get(l.rel.target) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const l of clicks) {
      const address = l.rel.target;
      const occurrence = seen.get(address) ?? 0;
      seen.set(address, occurrence + 1);
      keys.set(l, { address, occurrence, sameAddressCount: totals.get(address)! });
    }
  }

  const out: Finding[] = [];
  links.forEach((l, i) => {
    const address = l.rel.target;
    const info = classifyAddress(address);
    const hyperlink = keys.get(l);
    const locator: TargetLocator = { property: "hyperlink", relId: l.rel.id };
    if (l.raw.paragraphIndex !== undefined) locator.paragraphIndex = l.raw.paragraphIndex;
    if (l.raw.runIndex !== undefined) locator.runIndex = l.raw.runIndex;
    if (l.raw.cell) locator.cell = { ...l.raw.cell };
    if (hyperlink) locator.hyperlink = hyperlink;
    const reachable = hyperlink !== undefined;
    const target = shapeTarget(l.shape, pres, locator);
    target.reachable = reachable;
    const loc: Located = {
      target,
      reachable,
      fixes: HYPERLINK_FIXES,
      key: `${container.partName}|${l.shape.shapeId}|h${i}|${l.raw.trigger}|${address}`,
    };
    const details: string[] = [];
    if (l.raw.trigger === "hover") details.push("Activates when the pointer moves over it; it can't be edited from the add-in.");
    if (!isSlide) {
      details.push(
        `On ${container.kind} "${containerName ?? container.partName}". Edit it in Slide Master view; it appears on every slide that uses this ${container.kind}.`,
      );
    }
    out.push(
      makeFinding({
        area: "links",
        kind: "hyperlink",
        severity: "info",
        key: loc.key,
        title: info.class === "web" ? "Web link" : info.scheme === "mailto" ? "Email link" : "Hyperlink",
        ...(details.length ? { detail: details.join(" ") } : {}),
        group: address,
        targets: [target],
        fixes: HYPERLINK_FIXES,
        reachable,
        data: {
          address,
          scheme: info.scheme,
          trigger: l.raw.trigger,
          location: l.raw.location,
          ...(l.raw.text !== undefined && l.raw.location === "text" ? { text: l.raw.text } : {}),
          relId: l.rel.id,
          containerKind: container.kind,
          checkable: info.class === "web",
        },
      }),
      ...warningsFor(address, "hyperlink", loc),
    );
  });

  files.forEach((f, i) => {
    const locator: TargetLocator = { relId: f.rel.id };
    let target: FindingTarget;
    if (f.shape) target = shapeTarget(f.shape, pres, locator);
    else if (slide) target = slideTarget(slide, locator);
    else target = partTarget(container.kind, container.partName, { ...(containerName !== undefined ? { name: containerName } : {}), locator });
    const linkType = linkedFileType(f.rel);
    const loc: Located = { target, reachable: false, fixes: [], key: `${container.partName}|${f.shape?.shapeId ?? ""}|f${i}|${f.rel.id}` };
    out.push(
      makeFinding({
        area: "links",
        kind: "linked-file",
        severity: "warning",
        key: loc.key,
        title: FILE_TITLES[linkType],
        detail: "This content is linked to an external file, not embedded. It won't display or update if that file moves or the deck is shared.",
        group: f.rel.target,
        targets: [target],
        fixes: [],
        data: {
          target: f.rel.target,
          linkType,
          relType: f.rel.shortType,
          relId: f.rel.id,
          ...(f.raw.progId !== undefined ? { progId: f.raw.progId } : {}),
          containerKind: container.kind,
        },
      }),
      ...warningsFor(f.rel.target, "linked-file", loc),
    );
  });
  return out;
}

export const linkChecks: Check[] = [
  {
    id: "links",
    area: "links",
    async run({ pres }) {
      const out: Finding[] = [];
      for (const container of shapeContainers(pres)) out.push(...(await containerFindings(pres, container)));
      return out;
    },
  },
];
