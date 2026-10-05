/**
 * Test-only builders for the Graphics Ops "Problems" finding kinds (playback, font availability,
 * layout). Loosely typed like `fakeFinding`; data carries only the fields the UI reads.
 */
import type { Finding, FindingTarget, Severity } from "@slidefidelity/audit-core";
import { fakeFinding, slideShape } from "./fixtures";

type MediaKind = "media-missing" | "media-linked" | "media-online" | "media-format" | "media-poster-missing" | "media-playback-settings";

export function mediaFinding(kind: MediaKind, opts: { severity?: Severity; title?: string; slide?: number; data?: Record<string, unknown> } = {}): Finding {
  const slide = opts.slide ?? 2;
  const severity: Severity =
    opts.severity ?? (kind === "media-poster-missing" || kind === "media-playback-settings" ? "info" : "warning");
  return fakeFinding({
    area: "media",
    kind,
    severity,
    title: opts.title ?? `Video 'Clip' on slide ${slide}: ${kind}`,
    detail: `${kind} detail`,
    group: kind,
    targets: [slideShape(slide, 40, "Clip")],
    data: { mediaKind: "video", shapeName: "Clip", location: `slide ${slide}`, ...opts.data },
  });
}

export function fontMaybeMissing(typeface: string, targets: FindingTarget[], opts: { severity?: Severity; reachable?: boolean } = {}): Finding {
  const f = fakeFinding({
    area: "fonts",
    kind: "font-maybe-missing",
    severity: opts.severity ?? "warning",
    title: `Font '${typeface}' may be missing on the presenting computer (not embedded, not a standard Office font)`,
    detail: "Embed it, or replace it.",
    group: typeface,
    count: targets.length,
    targets,
    data: { typeface, usageCount: targets.length, slideNumbers: [1], sources: ["direct"], scripts: ["latin"], embedded: "none", onTeamList: false, symbolOnly: false, suggestion: "Embed it" },
  });
  (f as { fixes: string[] }).fixes = ["replace-font"];
  const reachable = opts.reachable ?? targets.some((t) => t.reachable === true);
  (f as { reachable?: boolean }).reachable = reachable;
  return f;
}

export function fontSummary(teamListProvided: boolean, maybeMissing = 0, local?: { missingHere: number }): Finding {
  return fakeFinding({
    area: "fonts",
    kind: "font-availability-summary",
    title: "Font availability",
    group: "font-availability",
    data: {
      safeByEmbedding: 0,
      subsetEmbedded: 0,
      safeByOffice: 2,
      safeByTeamList: 0,
      maybeMissing,
      teamListProvided,
      localListProvided: local !== undefined,
      missingHere: local?.missingHere ?? 0,
      fonts: [],
    },
  });
}

/** `font-missing-here` (helper plan U11/U12): not installed on this computer, per the helper. */
export function fontMissingHere(typeface: string, targets: FindingTarget[], opts: { severity?: Severity; reachable?: boolean } = {}): Finding {
  const f = fakeFinding({
    area: "fonts",
    kind: "font-missing-here",
    severity: opts.severity ?? "warning",
    title: `Font '${typeface}' is not installed on this computer`,
    detail: "Install it, embed it, or replace it.",
    group: typeface,
    count: targets.length,
    targets,
    data: { typeface, usageCount: targets.length, slideNumbers: [1], sources: ["direct"], scripts: ["latin"], symbolOnly: false, cloud: false, officeFont: false, onTeamList: false, suggestion: "Install it" },
  });
  (f as { fixes: string[] }).fixes = ["replace-font"];
  (f as { reachable?: boolean }).reachable = opts.reachable ?? targets.some((t) => t.reachable === true);
  return f;
}

export function partlyOff(slide: number, severity: Severity = "warning"): Finding {
  return fakeFinding({
    area: "review",
    kind: "partly-off-slide",
    severity,
    title: `Text box 'Box' extends past the right edge of slide ${slide}`,
    group: "partly-off-slide",
    targets: [slideShape(slide, 7, "Box")],
    data: { shapeName: "Box", slideNumber: slide, sides: [], offSlidePercent: 20, hasContent: severity === "warning" },
  });
}

export function offSlide(slide: number): Finding {
  return fakeFinding({
    area: "review",
    kind: "off-slide-shape",
    severity: "warning",
    title: `Shape 'Far' is off slide ${slide}`,
    group: "off-slide-shape",
    targets: [slideShape(slide, 8, "Far")],
    data: { shapeName: "Far", shapeKind: "sp", containerKind: "slide", direction: "right", inherited: false },
  });
}

export function textCollision(slide: number, severity: Severity = "warning"): Finding {
  return fakeFinding({
    area: "review",
    kind: "text-collision",
    severity,
    title: `Text box 'Caption' ${severity === "warning" ? "overlaps" : "sits inside"} picture 'Photo' on slide ${slide}`,
    group: "text-collision",
    count: 1,
    targets: [slideShape(slide, 9, "Caption"), slideShape(slide, 10, "Photo")],
    data: { shapeName: "Caption", slideNumber: slide, collisions: [], truncated: false },
  });
}

export function imageIssue(issue: string, bytes = 3_000_000, severity: Severity = "warning"): Finding {
  return fakeFinding({
    area: "media",
    kind: "image-issue",
    severity,
    title: `Image ${issue}`,
    group: issue,
    data: { issue, partName: `ppt/media/${issue}.png`, bytes },
  });
}

export function fileSize(totalBytes: number, media: number): Finding {
  return fakeFinding({
    area: "media",
    kind: "file-size-breakdown",
    title: "File size",
    group: "file-size",
    data: { totalBytes, categories: { media, fonts: 0, xml: totalBytes - media, other: 0 } },
  });
}

export function mediaSize(partName: string, bytes: number, mediaKind = "image"): Finding {
  return fakeFinding({ area: "media", kind: "media-size", title: partName, group: "media-size", data: { partName, bytes, mediaKind } });
}

// ---------------------------------------------------------------------------------------------
// Slide titles and slide numbers (set-title-size / remove-slide-numbers)

export interface TitleSpec {
  slide: number;
  size: number;
  type?: "title" | "ctrTitle";
  text?: string;
  shrink?: boolean;
}

/** Title placeholders inherit their position from the master: (1in, 0.5in) in points. */
export const TITLE_LEFT = 72;
export const TITLE_TOP = 36;

function titleTarget(slide: number): FindingTarget {
  return { ...slideShape(slide, 2, "Title 1"), path: [], bounds: { x: TITLE_LEFT * 12700, y: TITLE_TOP * 12700, cx: 100, cy: 100 }, locator: { property: "text" }, reachable: true };
}

/** `slide-titles` (info) plus one `title-sizes-inconsistent` warning per placeholder type with 2+ sizes. */
export function titleFindings(specs: readonly TitleSpec[]): Finding[] {
  const titles = specs.map((t) => ({
    slideNumber: t.slide,
    slideId: 255 + t.slide,
    shapeId: 2,
    shapeName: "Title 1",
    placeholderType: t.type ?? "title",
    hidden: false,
    text: t.text ?? `Title ${t.slide}`,
    sizesPt: [t.size],
    inheritedFrom: "shape",
    autofit: t.shrink ? "shrink" : "none",
    autofitFrom: "shape",
  }));
  const distinct = [...new Set(specs.map((t) => t.size))].sort((a, b) => a - b);
  const all = fakeFinding({
    area: "fonts",
    kind: "slide-titles",
    title: `${specs.length} slide titles`,
    group: "slide-titles",
    count: specs.length,
    targets: specs.map((t) => titleTarget(t.slide)),
    data: {
      titles,
      distinctSizesPt: distinct,
      slidesWithoutTitle: [],
      layoutTitles: [{ partName: "ppt/slideLayouts/slideLayout2.xml", name: "Title and Content", placeholderType: "title", effectiveSizePt: 44 }],
      masterTitles: [{ partName: "ppt/slideMasters/slideMaster1.xml", name: "", sizePt: 44, effectiveSizePt: 44 }],
    },
  });
  Object.assign(all, { fixes: ["set-title-size"], reachable: true });
  const out: Finding[] = [all];
  for (const type of ["title", "ctrTitle"] as const) {
    const list = specs.filter((t) => (t.type ?? "title") === type);
    const sizes = [...new Set(list.map((t) => t.size))].sort((a, b) => a - b);
    if (sizes.length < 2) continue;
    const bySize = sizes.map((sizePt) => ({ sizePt, slideNumbers: list.filter((t) => t.size === sizePt).map((t) => t.slide) }));
    const mostCommonPt = bySize.reduce((best, s) => (s.slideNumbers.length >= best.slideNumbers.length ? s : best)).sizePt;
    const f = fakeFinding({
      area: "fonts",
      kind: "title-sizes-inconsistent",
      severity: "warning",
      title: `${type === "ctrTitle" ? "Title-slide titles" : "Slide titles"} use ${sizes.length} different sizes`,
      detail: bySize.map((s) => `${s.sizePt} pt on slides ${s.slideNumbers.join(", ")}`).join("; "),
      group: "slide-titles",
      count: list.length,
      targets: list.map((t) => titleTarget(t.slide)),
      data: { placeholderType: type, sizes: bySize, mostCommonPt },
    });
    Object.assign(f, { fixes: ["set-title-size"], reachable: true });
    out.push(f);
  }
  return out;
}

export interface SlideNumberSpec {
  slide: number;
  kind: "placeholder" | "field-only-textbox" | "field-in-text";
  shapeId?: number;
  name?: string;
}

/** `slide-numbers` (info, Review): field-in-text entries are unreachable. */
export function slideNumbersFinding(specs: readonly SlideNumberSpec[], opts: { flagOn?: boolean } = {}): Finding {
  const name = (s: SlideNumberSpec) => s.name ?? (s.kind === "placeholder" ? "Slide Number Placeholder 2" : s.kind === "field-only-textbox" ? "Number Box" : "Page Box");
  const slides = specs.map((s) => ({
    slideNumber: s.slide,
    slideId: 255 + s.slide,
    shapeId: s.shapeId ?? 3,
    shapeName: name(s),
    kind: s.kind,
    hidden: false,
    text: s.kind === "field-in-text" ? `Page ${s.slide} of 10` : String(s.slide),
    ...(s.kind === "field-in-text" ? { reason: "The slide number is mixed with other text; removing the shape would delete that text too." } : {}),
  }));
  const f = fakeFinding({
    area: "review",
    kind: "slide-numbers",
    title: `Slide numbers on ${specs.length} slides`,
    group: "slide-numbers",
    count: specs.length,
    targets: specs.map((s) => ({
      ...slideShape(s.slide, s.shapeId ?? 3, name(s)),
      path: [],
      bounds: { x: 720 * 12700, y: 504 * 12700, cx: 100, cy: 100 },
      locator: { property: s.kind === "placeholder" ? "placeholder" : "text" },
      reachable: s.kind !== "field-in-text",
    })),
    data: {
      slides,
      slidesWithNumbers: specs.map((s) => s.slide),
      layoutsWithSldNumPlaceholder: [],
      mastersWithSldNumPlaceholder: [],
      ...(opts.flagOn ? { headerFooterFlag: [{ partName: "ppt/slideMasters/slideMaster1.xml", containerKind: "master", sldNum: true }] } : {}),
    },
  });
  Object.assign(f, { fixes: ["remove-slide-numbers"], reachable: specs.some((s) => s.kind !== "field-in-text") });
  return f;
}
