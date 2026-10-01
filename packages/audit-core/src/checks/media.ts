/**
 * Media & size checks (U7, R7, R19).
 *
 * Two checks, isolated by the runner so a failure in image analysis never hides the Free-tier
 * size list:
 * - `media-size`: one `file-size-breakdown` finding (bytes by category — media / fonts / XML /
 *   other — summing exactly to the package's uncompressed size, plus per-slide media totals) and
 *   one `media-size` finding per media part (bytes, format, native size, slides using it, shared).
 * - `media-images`: `image-issue` warnings, one per image part per issue type: oversized, too
 *   small, distorted, cropped-retained, low-compression, auto-generated.
 *
 * Uses of an image are found by scanning every slide, layout, and master: pictures (`p:pic`),
 * picture fills on shapes (`p:spPr/a:blipFill`), and backgrounds (`p:bg/p:bgPr/a:blipFill`).
 *
 * Geometry. The displayed size is the shape's slide-space extent (group scaling applied; for a
 * placeholder without its own `a:xfrm` it is inherited from the layout, then the master), shrunk
 * by any `a:stretch/a:fillRect` insets; backgrounds use the slide size. The visible native pixels
 * are the image's pixels times the `a:srcRect` visible fraction (1 − (l + r) / 100000 per axis).
 * PPI per axis = visible pixels / displayed inches (914400 EMU per inch). The scale per axis is
 * displayed inches per visible pixel, reported normalized so the larger axis is 1. Tiled fills
 * and vector / unknown formats get no dimension-based flags.
 *
 * No v1 in-place fix exists for images: every `image-issue` is `reachable: false` with no fixes.
 * Per-slide attribution counts media related directly from the slide part (layout / master media
 * is reported as not on slides); a part used by several slides is attributed to each and marked
 * shared, but counted once in totals.
 */
import {
  containerTarget,
  makeFinding,
  partTarget,
  shapeTarget,
  slideTarget,
  type Finding,
  type FindingTarget,
  type TargetLocator,
} from "../findings";
import { readImageHeader, type ImageFormat, type ImageHeader } from "../imageHeader";
import { getShapes, shapeContainers, type MediaKind, type Presentation, type SlideInfo } from "../package/model";
import { placeholderClass, type ContainerKind, type ShapeContainer, type ShapeRef } from "../package/shapes";
import { child, childPath, descendants, intAttr, relAttr, type XmlElement } from "../package/xml";
import type { Check } from "../runner";

// ---------------------------------------------------------------------------------------------
// Thresholds

export const EMU_PER_INCH = 914400;
/** Oversized: every use shows the image above this density… */
export const OVERSIZED_PPI = 300;
/** …and the part is larger than this (200 KB). */
export const OVERSIZED_MIN_BYTES = 200 * 1024;
/** Too small: some use shows the image below this density on either axis. */
export const TOO_SMALL_PPI = 96;
/** Distorted: the width and height scales differ by more than this fraction (2%). */
export const DISTORTION_TOLERANCE = 0.02;
/**
 * Low compression, PNG: a truecolor (color type 2 or 6) PNG of at least this many bytes per pixel
 * looks like a photo (flat graphics and screenshots compress far below 1 B/px; photos stored as
 * PNG typically land at 1.5–3 B/px).
 */
export const PNG_LOW_COMPRESSION_BYTES_PER_PIXEL = 1.0;
/**
 * Low compression, JPEG: above this many bytes per pixel (4 bits/px) the JPEG was saved at a very
 * high quality (≈ q95+); typical photos land at 0.1–0.35 B/px.
 */
export const JPEG_LOW_COMPRESSION_BYTES_PER_PIXEL = 0.5;
/** Low-compression flags ignore images smaller than this (100 KB) — not worth the user's time. */
export const LOW_COMPRESSION_MIN_BYTES = 100 * 1024;
/** …and PNGs with fewer pixels than this (icons). */
export const PNG_LOW_COMPRESSION_MIN_PIXELS = 256 * 256;

// ---------------------------------------------------------------------------------------------
// Finding data

export type ImageIssueType =
  | "oversized"
  | "too-small"
  | "distorted"
  | "cropped-retained"
  | "low-compression"
  | "auto-generated";

/** Where an image is used from. */
export type ImageUseSource = "picture" | "shape-fill" | "background";
/**
 * `image`: the displayed raster/vector. `svg`: an `asvg:svgBlip` (the real image); `svg-fallback`:
 * the PNG a blip carries next to an SVG; `hdphoto`: the WDP original kept for picture effects.
 */
export type ImageUseRole = "image" | "svg" | "svg-fallback" | "hdphoto";

export interface CropData {
  /** `a:srcRect` insets in 1/1000 of a percent (100000 = the full side). */
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface ImageUseData {
  source: ImageUseSource;
  role: ImageUseRole;
  containerKind: ContainerKind;
  containerPart: string;
  slideNumber?: number;
  shapeId?: number;
  shapeName?: string;
  relId: string;
  tiled?: boolean;
  crop?: CropData;
  /** Displayed size of the image area in inches (after fillRect insets). */
  displayed?: { widthIn: number; heightIn: number };
  /** Native pixels inside the crop. */
  visiblePixels?: { width: number; height: number };
  ppi?: { x: number; y: number };
  /** min(ppi.x, ppi.y). */
  effectivePpi?: number;
  /** Displayed inches per visible pixel per axis, normalized so the larger is 1. */
  scale?: { x: number; y: number };
  /** 1 − min(scale)/max(scale). */
  distortion?: number;
}

export interface ImageIssueData {
  issue: ImageIssueType;
  partName: string;
  format: ImageFormat;
  bytes: number;
  width?: number;
  height?: number;
  /** The uses this issue applies to (the finding's targets, same order). */
  uses: ImageUseData[];
  /** Low compression: bytes / native pixel, and the threshold it exceeded. */
  bytesPerPixel?: number;
  threshold?: number;
  /** Auto-generated: why. */
  reason?: "svg-fallback" | "hdphoto-companion";
}

export interface MediaSlideRef {
  slideId: number;
  slideIndex: number;
  slideNumber: number;
  partName: string;
}

export interface MediaSizeData {
  partName: string;
  contentType?: string;
  mediaKind: MediaKind;
  /** Sniffed format for images; undefined for video / audio / other. */
  format?: ImageFormat;
  width?: number;
  height?: number;
  bytes: number;
  compressedBytes?: number;
  /** Used by more than one slide. */
  shared: boolean;
  slides: MediaSlideRef[];
  /** Non-slide parts referencing it (layouts, masters, notes, charts…). */
  otherSources: string[];
  /** No relationship targets it. */
  orphan: boolean;
}

export interface SizeCategories {
  media: number;
  fonts: number;
  xml: number;
  other: number;
}

export interface SlideMediaTotal extends MediaSlideRef {
  /** Bytes of every media part the slide references (shared parts included in full). */
  mediaBytes: number;
  /** The portion of `mediaBytes` from parts shared with other slides. */
  sharedMediaBytes: number;
  mediaParts: string[];
}

export interface FileSizeBreakdownData {
  /** Sum of every part's uncompressed size (= categories summed). */
  totalBytes: number;
  categories: SizeCategories;
  partCounts: SizeCategories;
  slides: SlideMediaTotal[];
  /** Media bytes not referenced from any slide (layouts, masters, orphans, charts…). */
  mediaNotOnSlidesBytes: number;
}

declare module "../findings" {
  interface FindingDataMap {
    "image-issue": ImageIssueData;
    "media-size": MediaSizeData;
    "file-size-breakdown": FileSizeBreakdownData;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function baseName(partName: string): string {
  return partName.slice(partName.lastIndexOf("/") + 1);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function slideRef(s: SlideInfo): MediaSlideRef {
  return { slideId: s.slideId, slideIndex: s.index, slideNumber: s.number, partName: s.partName };
}

/** Image headers per presentation, shared by both checks. */
const headerCache = new WeakMap<Presentation, Promise<Map<string, ImageHeader>>>();

function imageHeaders(pres: Presentation): Promise<Map<string, ImageHeader>> {
  let p = headerCache.get(pres);
  if (!p) {
    p = (async () => {
      const out = new Map<string, ImageHeader>();
      for (const m of pres.media) {
        if (m.kind !== "image") continue;
        try {
          const bytes = await pres.pkg.readBytes(m.partName);
          if (bytes) out.set(m.partName, readImageHeader(bytes));
        } catch {
          // Unreadable entry: listed by size only.
        }
      }
      return out;
    })();
    headerCache.set(pres, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Use scanning

interface ImageUse {
  partName: string;
  role: ImageUseRole;
  source: ImageUseSource;
  target: FindingTarget;
  container: ShapeContainer;
  slideNumber?: number;
  shapeId?: number;
  shapeName?: string;
  relId: string;
  tiled: boolean;
  crop?: CropData;
  /** Displayed image area in EMU (after fillRect insets), when known. */
  displayed?: { cx: number; cy: number };
}

function readInsets(el: XmlElement | undefined): CropData | undefined {
  if (!el) return undefined;
  const l = intAttr(el, "l") ?? 0;
  const t = intAttr(el, "t") ?? 0;
  const r = intAttr(el, "r") ?? 0;
  const b = intAttr(el, "b") ?? 0;
  return l || t || r || b ? { l, t, r, b } : undefined;
}

/** Size of a placeholder without its own xfrm, from the layout, then the master. */
async function inheritedExtent(pres: Presentation, ref: ShapeRef): Promise<{ cx: number; cy: number } | undefined> {
  const ph = ref.placeholder;
  if (!ph) return undefined;
  const chain: ShapeContainer[] = [];
  if (ref.container.kind === "slide") {
    const slide = pres.slides.find((s) => s.partName === ref.container.partName);
    if (slide?.layoutPart) chain.push({ kind: "layout", partName: slide.layoutPart });
    if (slide?.masterPart) chain.push({ kind: "master", partName: slide.masterPart });
  } else if (ref.container.kind === "layout") {
    const layout = pres.layouts.find((l) => l.partName === ref.container.partName);
    if (layout?.masterPart) chain.push({ kind: "master", partName: layout.masterPart });
  }
  for (const c of chain) {
    const shapes = await getShapes(pres, c);
    const match =
      c.kind === "layout"
        ? shapes.find((s) =>
            s.placeholder === undefined
              ? false
              : ph.idx !== undefined
                ? s.placeholder.idx === ph.idx
                : s.placeholder.type === ph.type,
          )
        : shapes.find((s) => s.placeholder !== undefined && placeholderClass(s.placeholder.type) === placeholderClass(ph.type));
    if (match?.bounds) return { cx: match.bounds.cx, cy: match.bounds.cy };
  }
  return undefined;
}

interface BlipContext {
  pres: Presentation;
  relTargets: Map<string, string>;
  container: ShapeContainer;
  slide?: SlideInfo;
  source: ImageUseSource;
  frame?: { cx: number; cy: number };
  makeTarget: (locator: TargetLocator) => FindingTarget;
  shape?: ShapeRef;
}

function usesFromBlipFill(blipFill: XmlElement, ctx: BlipContext): ImageUse[] {
  const blip = child(blipFill, "blip");
  if (!blip) return [];
  const tiled = child(blipFill, "tile") !== undefined;
  const crop = readInsets(child(blipFill, "srcRect"));
  const fill = readInsets(childPath(blipFill, "stretch", "fillRect"));
  let displayed: { cx: number; cy: number } | undefined;
  if (ctx.frame && !tiled) {
    const fx = 1 - ((fill?.l ?? 0) + (fill?.r ?? 0)) / 100000;
    const fy = 1 - ((fill?.t ?? 0) + (fill?.b ?? 0)) / 100000;
    if (fx > 0 && fy > 0) displayed = { cx: ctx.frame.cx * fx, cy: ctx.frame.cy * fy };
  }
  const svgRel = descendants(blip, "svgBlip").map((e) => relAttr(e, "embed")).find((v) => v !== undefined);
  const out: ImageUse[] = [];
  const add = (relId: string | undefined, role: ImageUseRole): void => {
    if (relId === undefined) return;
    const partName = ctx.relTargets.get(relId);
    if (partName === undefined) return;
    const use: ImageUse = {
      partName,
      role,
      source: ctx.source,
      target: ctx.makeTarget({ property: ctx.source === "picture" ? "image" : "fill", relId }),
      container: ctx.container,
      relId,
      tiled,
    };
    if (ctx.slide) use.slideNumber = ctx.slide.number;
    if (ctx.shape) {
      use.shapeId = ctx.shape.shapeId;
      use.shapeName = ctx.shape.name;
    }
    if (crop) use.crop = crop;
    if (displayed) use.displayed = displayed;
    out.push(use);
  };
  add(relAttr(blip, "embed"), svgRel !== undefined ? "svg-fallback" : "image");
  add(svgRel, "svg");
  for (const layer of descendants(blip, "imgLayer")) add(relAttr(layer, "embed"), "hdphoto");
  return out;
}

async function scanUses(pres: Presentation): Promise<ImageUse[]> {
  const out: ImageUse[] = [];
  for (const container of shapeContainers(pres)) {
    const relTargets = new Map<string, string>();
    for (const r of await pres.pkg.rels(container.partName)) {
      if (r.targetMode !== "External" && r.targetPart !== undefined) relTargets.set(r.id, r.targetPart);
    }
    if (relTargets.size === 0) continue;
    const slide = container.kind === "slide" ? pres.slides.find((s) => s.partName === container.partName) : undefined;

    // Background.
    const root = await pres.pkg.xml(container.partName).catch(() => undefined);
    const bgFill = root ? childPath(root, "cSld", "bg", "bgPr", "blipFill") : undefined;
    if (bgFill) {
      out.push(
        ...usesFromBlipFill(bgFill, {
          pres,
          relTargets,
          container,
          ...(slide ? { slide } : {}),
          source: "background",
          ...(pres.slideSize ? { frame: { cx: pres.slideSize.cx, cy: pres.slideSize.cy } } : {}),
          makeTarget: (locator) => containerTarget(pres, container, locator),
        }),
      );
    }

    // Pictures and picture fills.
    for (const ref of await getShapes(pres, container)) {
      let blipFill: XmlElement | undefined;
      let source: ImageUseSource;
      if (ref.kind === "pic") {
        blipFill = child(ref.node, "blipFill");
        source = "picture";
      } else if (ref.kind === "sp") {
        blipFill = childPath(ref.node, "spPr", "blipFill");
        source = "shape-fill";
      } else continue;
      if (!blipFill) continue;
      const frame = ref.bounds ? { cx: ref.bounds.cx, cy: ref.bounds.cy } : await inheritedExtent(pres, ref);
      out.push(
        ...usesFromBlipFill(blipFill, {
          pres,
          relTargets,
          container,
          ...(slide ? { slide } : {}),
          source,
          ...(frame ? { frame } : {}),
          shape: ref,
          makeTarget: (locator) => shapeTarget(ref, pres, locator),
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Metrics

function measure(use: ImageUse, header: ImageHeader | undefined): ImageUseData {
  const d: ImageUseData = {
    source: use.source,
    role: use.role,
    containerKind: use.container.kind,
    containerPart: use.container.partName,
    relId: use.relId,
  };
  if (use.slideNumber !== undefined) d.slideNumber = use.slideNumber;
  if (use.shapeId !== undefined) d.shapeId = use.shapeId;
  if (use.shapeName !== undefined) d.shapeName = use.shapeName;
  if (use.tiled) d.tiled = true;
  if (use.crop) d.crop = { ...use.crop };
  if (use.displayed) {
    d.displayed = { widthIn: use.displayed.cx / EMU_PER_INCH, heightIn: use.displayed.cy / EMU_PER_INCH };
  }
  const w = header?.width;
  const h = header?.height;
  if (!header || header.vector || w === undefined || h === undefined || !d.displayed) return d;
  const fx = 1 - ((use.crop?.l ?? 0) + (use.crop?.r ?? 0)) / 100000;
  const fy = 1 - ((use.crop?.t ?? 0) + (use.crop?.b ?? 0)) / 100000;
  const vw = w * fx;
  const vh = h * fy;
  const { widthIn, heightIn } = d.displayed;
  if (vw <= 0 || vh <= 0 || widthIn <= 0 || heightIn <= 0) return d;
  d.visiblePixels = { width: vw, height: vh };
  d.ppi = { x: vw / widthIn, y: vh / heightIn };
  d.effectivePpi = Math.min(d.ppi.x, d.ppi.y);
  const sx = widthIn / vw;
  const sy = heightIn / vh;
  const max = Math.max(sx, sy);
  d.scale = { x: sx / max, y: sy / max };
  d.distortion = 1 - Math.min(sx, sy) / max;
  return d;
}

function hasPositiveCrop(c: CropData | undefined): boolean {
  return !!c && (c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

// ---------------------------------------------------------------------------------------------
// Checks

async function runImages(pres: Presentation): Promise<Finding[]> {
  const headers = await imageHeaders(pres);
  const uses = await scanUses(pres);
  const byPart = new Map<string, ImageUse[]>();
  for (const u of uses) {
    const list = byPart.get(u.partName) ?? [];
    list.push(u);
    byPart.set(u.partName, list);
  }

  const findings: Finding[] = [];
  for (const media of pres.media) {
    const partUses = byPart.get(media.partName);
    if (!partUses || partUses.length === 0) continue;
    const header = headers.get(media.partName);
    const format: ImageFormat = header?.format ?? "unknown";
    const name = baseName(media.partName);
    const base = { partName: media.partName, format, bytes: media.size } as const;
    const dims: { width?: number; height?: number } = {};
    if (header?.width !== undefined && header.height !== undefined) {
      dims.width = header.width;
      dims.height = header.height;
    }

    const emit = (
      issue: ImageIssueType,
      picked: ImageUse[],
      title: string,
      detail: string,
      extra: Partial<ImageIssueData> = {},
    ): void => {
      const targets: FindingTarget[] = [];
      const measured: ImageUseData[] = [];
      for (const u of picked) {
        targets.push(u.target);
        measured.push(measure(u, header));
      }
      findings.push(
        makeFinding({
          area: "media",
          kind: "image-issue",
          severity: "warning",
          title,
          detail,
          group: issue,
          groupLabel: ISSUE_LABELS[issue],
          targets,
          fixes: [],
          reachable: false,
          key: `${issue}\u0000${media.partName}`,
          data: { issue, ...base, ...dims, uses: measured, ...extra },
        }),
      );
    };

    const imageUses = partUses.filter((u) => u.role === "image");
    const measured = imageUses.map((u) => ({ use: u, m: measure(u, header) }));
    const withPpi = measured.filter((x) => x.m.effectivePpi !== undefined);

    // Oversized: even the largest display of the image is above 300 PPI, and it is heavy.
    if (
      withPpi.length > 0 &&
      media.size > OVERSIZED_MIN_BYTES &&
      withPpi.every((x) => (x.m.effectivePpi ?? 0) > OVERSIZED_PPI)
    ) {
      const need = Math.min(...withPpi.map((x) => x.m.effectivePpi ?? 0));
      emit(
        "oversized",
        withPpi.map((x) => x.use),
        `Oversized image: ${name} at ${Math.round(need)} PPI`,
        `${dims.width}×${dims.height} px (${formatBytes(media.size)}) is shown at ${Math.round(need)} PPI; ${OVERSIZED_PPI} PPI is enough for display and print.`,
      );
    }

    const small = withPpi.filter((x) => (x.m.effectivePpi ?? Infinity) < TOO_SMALL_PPI);
    if (small.length > 0) {
      const worst = Math.min(...small.map((x) => x.m.effectivePpi ?? 0));
      emit(
        "too-small",
        small.map((x) => x.use),
        `Low-resolution image: ${name} at ${Math.round(worst)} PPI`,
        `${dims.width}×${dims.height} px is stretched to ${Math.round(worst)} PPI; below ${TOO_SMALL_PPI} PPI it looks soft or pixelated.`,
      );
    }

    const distorted = withPpi.filter((x) => (x.m.distortion ?? 0) > DISTORTION_TOLERANCE);
    if (distorted.length > 0) {
      const s = distorted[0]?.m.scale ?? { x: 1, y: 1 };
      emit(
        "distorted",
        distorted.map((x) => x.use),
        `Distorted image: ${name} (${pct(s.x)} × ${pct(s.y)})`,
        `The width and height are scaled unequally, so the picture is stretched or squashed.`,
      );
    }

    // Cropped retained: every displayed use crops the image, so the cropped-away pixels are
    // stored but never shown.
    if (imageUses.length > 0 && imageUses.every((u) => hasPositiveCrop(u.crop))) {
      emit(
        "cropped-retained",
        imageUses,
        `Cropped image keeps hidden pixels: ${name}`,
        `The cropped-away area is still stored in the file (${formatBytes(media.size)} in total).`,
      );
    }

    // Low compression.
    const pixels = (dims.width ?? 0) * (dims.height ?? 0);
    if (imageUses.length > 0 && pixels > 0 && media.size >= LOW_COMPRESSION_MIN_BYTES) {
      const bpp = media.size / pixels;
      let threshold: number | undefined;
      if (
        format === "png" &&
        (header?.png?.colorType === 2 || header?.png?.colorType === 6) &&
        pixels >= PNG_LOW_COMPRESSION_MIN_PIXELS &&
        bpp >= PNG_LOW_COMPRESSION_BYTES_PER_PIXEL
      ) {
        threshold = PNG_LOW_COMPRESSION_BYTES_PER_PIXEL;
      } else if (format === "jpeg" && bpp > JPEG_LOW_COMPRESSION_BYTES_PER_PIXEL) {
        threshold = JPEG_LOW_COMPRESSION_BYTES_PER_PIXEL;
      }
      if (threshold !== undefined) {
        emit(
          "low-compression",
          imageUses,
          `Poorly compressed image: ${name} (${bpp.toFixed(2)} bytes/pixel)`,
          format === "png"
            ? `This looks like a photo stored as PNG (${formatBytes(media.size)}); JPEG would be much smaller.`
            : `This JPEG was saved at a very high quality (${formatBytes(media.size)}); a standard quality would be much smaller.`,
          { bytesPerPixel: bpp, threshold },
        );
      }
    }

    // Auto-generated companions.
    if (partUses.every((u) => u.role === "svg-fallback")) {
      emit(
        "auto-generated",
        partUses,
        `Auto-generated fallback image: ${name}`,
        `PowerPoint stores this PNG next to an SVG for older versions; it adds ${formatBytes(media.size)}.`,
        { reason: "svg-fallback" },
      );
    } else if (partUses.every((u) => u.role === "hdphoto")) {
      emit(
        "auto-generated",
        partUses,
        `Hidden original kept for picture effects: ${name}`,
        `An HD Photo copy of the original is stored for artistic effects or color changes; it adds ${formatBytes(media.size)}.`,
        { reason: "hdphoto-companion" },
      );
    }
  }
  return findings;
}

const ISSUE_LABELS: Readonly<Record<ImageIssueType, string>> = {
  oversized: "Oversized images",
  "too-small": "Low-resolution images",
  distorted: "Distorted images",
  "cropped-retained": "Cropped images with hidden pixels",
  "low-compression": "Poorly compressed images",
  "auto-generated": "Auto-generated images",
};

function isFontPart(pres: Presentation, partName: string, fontParts: ReadonlySet<string>): boolean {
  if (fontParts.has(partName) || /^ppt\/fonts\//i.test(partName)) return true;
  const ct = pres.pkg.contentTypeOf(partName) ?? "";
  return /font/i.test(ct);
}

async function runSizes(pres: Presentation): Promise<Finding[]> {
  const headers = await imageHeaders(pres).catch(() => new Map<string, ImageHeader>());
  const mediaParts = new Set(pres.media.map((m) => m.partName));
  const fontParts = new Set(
    pres.embeddedFonts.flatMap((f) => f.styles.map((s) => s.partName)).filter((p): p is string => p !== undefined),
  );

  // ---- Breakdown ----------------------------------------------------------------------------
  const categories: SizeCategories = { media: 0, fonts: 0, xml: 0, other: 0 };
  const partCounts: SizeCategories = { media: 0, fonts: 0, xml: 0, other: 0 };
  let totalBytes = 0;
  for (const p of pres.pkg.partNames) {
    const size = (await pres.pkg.size(p)) ?? 0;
    totalBytes += size;
    const cat: keyof SizeCategories = mediaParts.has(p)
      ? "media"
      : isFontPart(pres, p, fontParts)
        ? "fonts"
        : /\.(xml|rels)$/i.test(p) || /[+/]xml$/i.test(pres.pkg.contentTypeOf(p) ?? "")
          ? "xml"
          : "other";
    categories[cat] += size;
    partCounts[cat] += 1;
  }

  const sizeOf = new Map(pres.media.map((m) => [m.partName, m.size]));
  const slidesByPart = new Map<string, SlideInfo[]>();
  for (const s of pres.slides) {
    for (const p of s.mediaParts) {
      if (!sizeOf.has(p)) continue;
      const list = slidesByPart.get(p) ?? [];
      list.push(s);
      slidesByPart.set(p, list);
    }
  }
  const isShared = (p: string): boolean => (slidesByPart.get(p)?.length ?? 0) > 1;

  const slides: SlideMediaTotal[] = pres.slides.map((s) => {
    const parts = s.mediaParts.filter((p) => sizeOf.has(p));
    let mediaBytes = 0;
    let sharedMediaBytes = 0;
    for (const p of parts) {
      const n = sizeOf.get(p) ?? 0;
      mediaBytes += n;
      if (isShared(p)) sharedMediaBytes += n;
    }
    return { ...slideRef(s), mediaBytes, sharedMediaBytes, mediaParts: parts };
  });
  let mediaNotOnSlidesBytes = 0;
  for (const m of pres.media) if (!slidesByPart.has(m.partName)) mediaNotOnSlidesBytes += m.size;

  const findings: Finding[] = [
    makeFinding({
      area: "media",
      kind: "file-size-breakdown",
      severity: "info",
      title: `File size: ${formatBytes(totalBytes)}`,
      detail: `Media ${formatBytes(categories.media)}, fonts ${formatBytes(categories.fonts)}, XML ${formatBytes(categories.xml)}, other ${formatBytes(categories.other)} (uncompressed).`,
      group: "file-size",
      groupLabel: "File size",
      targets: [],
      fixes: [],
      key: "file-size-breakdown",
      data: { totalBytes, categories, partCounts, slides, mediaNotOnSlidesBytes },
    }),
  ];

  // ---- Per media part -----------------------------------------------------------------------
  const ordered = [...pres.media].sort((a, b) => b.size - a.size || (a.partName < b.partName ? -1 : 1));
  for (const m of ordered) {
    const using = slidesByPart.get(m.partName) ?? [];
    const slideParts = new Set(pres.slides.map((s) => s.partName));
    const otherSources = [...new Set(m.usedBy.map((u) => u.sourcePart).filter((p) => !slideParts.has(p)))].sort();
    const header = headers.get(m.partName);
    const data: MediaSizeData = {
      partName: m.partName,
      mediaKind: m.kind,
      bytes: m.size,
      shared: using.length > 1,
      slides: using.map(slideRef),
      otherSources,
      orphan: m.usedBy.length === 0,
    };
    if (m.contentType !== undefined) data.contentType = m.contentType;
    if (m.compressedSize !== undefined) data.compressedBytes = m.compressedSize;
    if (header) {
      data.format = header.format;
      if (header.width !== undefined && header.height !== undefined) {
        data.width = header.width;
        data.height = header.height;
      }
    }
    const name = baseName(m.partName);
    const where =
      using.length > 0
        ? `slide${using.length > 1 ? "s" : ""} ${using.map((s) => s.number).join(", ")}`
        : otherSources.length > 0
          ? "layouts, masters, or other parts"
          : "no slide (unused)";
    findings.push(
      makeFinding({
        area: "media",
        kind: "media-size",
        severity: "info",
        title: `${name} · ${formatBytes(m.size)}`,
        detail: `${data.width !== undefined ? `${Math.round(data.width)}×${Math.round(data.height ?? 0)} px, ` : ""}used on ${where}${data.shared ? " (shared)" : ""}.`,
        group: m.partName,
        groupLabel: name,
        ...(using.length > 1 ? { count: using.length } : {}),
        targets: using.length > 0 ? using.map((s) => slideTarget(s)) : [partTarget("media", m.partName)],
        fixes: [],
        key: m.partName,
        data,
      }),
    );
  }
  return findings;
}

export const mediaChecks: Check[] = [
  { id: "media-size", area: "media", run: ({ pres }) => runSizes(pres) },
  { id: "media-images", area: "media", run: ({ pres }) => runImages(pres) },
];
