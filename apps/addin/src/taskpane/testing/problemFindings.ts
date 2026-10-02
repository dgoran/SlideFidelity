/**
 * Test-only builders for the Graphics Ops "Problems" finding kinds (playback, font availability,
 * layout). Loosely typed like `fakeFinding`; data carries only the fields the UI reads.
 */
import type { Finding, FindingTarget, Severity } from "@slidecheck/audit-core";
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

export function fontSummary(teamListProvided: boolean, maybeMissing = 0): Finding {
  return fakeFinding({
    area: "fonts",
    kind: "font-availability-summary",
    title: "Font availability",
    group: "font-availability",
    data: { safeByEmbedding: 0, subsetEmbedded: 0, safeByOffice: 2, safeByTeamList: 0, maybeMissing, teamListProvided, fonts: [] },
  });
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
