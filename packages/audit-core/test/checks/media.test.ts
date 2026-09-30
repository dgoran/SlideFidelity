import { describe, expect, it } from "vitest";
import {
  JPEG_LOW_COMPRESSION_BYTES_PER_PIXEL,
  OVERSIZED_MIN_BYTES,
  PNG_LOW_COMPRESSION_BYTES_PER_PIXEL,
  mediaChecks,
  type ImageIssueType,
} from "../../src/checks/media";
import type { Finding, FindingOf } from "../../src/findings";
import { loadPresentation, type Presentation } from "../../src/package/model";
import { runChecks } from "../../src/runner";
import { SEEDS } from "../helpers/corpus";
import {
  backgroundDeck,
  cleanDeck,
  cropPpiDeck,
  groupScaledDeck,
  hdphotoDeck,
  inheritedPlaceholderDeck,
  lowCompressionDeck,
  mediaBloatDeck,
  partialCropSharedDeck,
  pictureFillDeck,
  unknownAndFontsDeck,
} from "./media.fixtures";

async function audit(bytes: Uint8Array): Promise<{ pres: Presentation; findings: Finding[] }> {
  const pres = await loadPresentation(bytes);
  const findings: Finding[] = [];
  for (const c of mediaChecks) findings.push(...(await c.run({ pres, options: {} })));
  return { pres, findings };
}

function issues(findings: Finding[], issue?: ImageIssueType): FindingOf<"image-issue">[] {
  return findings.filter(
    (f): f is FindingOf<"image-issue"> => f.kind === "image-issue" && (issue === undefined || f.data.issue === issue),
  );
}

function issueFor(findings: Finding[], issue: ImageIssueType, part: string): FindingOf<"image-issue"> | undefined {
  return issues(findings, issue).find((f) => f.data.partName === part);
}

function breakdown(findings: Finding[]): FindingOf<"file-size-breakdown"> {
  const b = findings.filter((f): f is FindingOf<"file-size-breakdown"> => f.kind === "file-size-breakdown");
  expect(b).toHaveLength(1);
  return b[0] as FindingOf<"file-size-breakdown">;
}

function sizes(findings: Finding[]): FindingOf<"media-size">[] {
  return findings.filter((f): f is FindingOf<"media-size"> => f.kind === "media-size");
}

const seeds = SEEDS["media-bloat"];

describe("media checks on the media-bloat corpus deck", () => {
  it("flags the 4000×3000 JPEG shown at 2×1.5 in as oversized with its effective PPI", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const f = issueFor(findings, "oversized", seeds.oversized.part);
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.area).toBe("media");
    expect(f?.group).toBe("oversized");
    expect(f?.reachable).toBe(false);
    expect(f?.fixes).toEqual([]);
    expect(f?.data).toMatchObject({ format: "jpeg", width: 4000, height: 3000, bytes: seeds.oversized.bytes });
    const use = f?.data.uses[0];
    expect(use?.displayed?.widthIn).toBeCloseTo(2, 5);
    expect(use?.displayed?.heightIn).toBeCloseTo(1.5, 5);
    expect(use?.ppi?.x).toBeCloseTo(2000, 3);
    expect(use?.ppi?.y).toBeCloseTo(2000, 3);
    expect(use?.effectivePpi).toBeCloseTo(2000, 3);
    expect(f?.title).toContain("2000 PPI");
    expect(f?.targets).toHaveLength(1);
    expect(f?.targets[0]).toMatchObject({ shapeId: 2, shapeName: "Oversized photo", container: { kind: "slide", slideNumber: 1 } });
  });

  it("flags the image scaled 100% × 60% as distorted with both scale factors", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const f = issueFor(findings, "distorted", seeds.distorted.part);
    expect(f).toBeDefined();
    const use = f?.data.uses[0];
    expect(use?.scale?.x).toBeCloseTo(seeds.distorted.scale[0] ?? 1, 5);
    expect(use?.scale?.y).toBeCloseTo(seeds.distorted.scale[1] ?? 0.6, 5);
    expect(f?.targets.map((t) => t.shapeName)).toEqual(["Distorted"]);
  });

  it("counts an image reused on 5 slides once in the total, attributes it to all 5, and marks it shared", async () => {
    const { pres, findings } = await audit(await mediaBloatDeck());
    const part = seeds.shared.part;
    const bytes = pres.media.find((m) => m.partName === part)?.size ?? 0;
    expect(bytes).toBeGreaterThan(0);

    const size = sizes(findings).find((f) => f.data.partName === part);
    expect(size?.data.shared).toBe(true);
    expect(size?.data.slides.map((s) => s.slideNumber)).toEqual(seeds.shared.slides);
    expect(size?.severity).toBe("info");

    const b = breakdown(findings);
    const mediaTotal = pres.media.reduce((n, m) => n + m.size, 0);
    expect(b.data.categories.media).toBe(mediaTotal); // counted once
    for (const n of seeds.shared.slides) {
      const s = b.data.slides.find((x) => x.slideNumber === n);
      expect(s?.mediaParts).toContain(part);
      expect(s?.sharedMediaBytes).toBeGreaterThanOrEqual(bytes);
    }
    expect(b.data.slides.find((x) => x.slideNumber === 1)?.mediaParts).not.toContain(part);
    // Shared image shown at 400 PPI but only ~20 KB: not oversized (the 200 KB floor).
    expect(bytes).toBeLessThan(OVERSIZED_MIN_BYTES);
    expect(issueFor(findings, "oversized", part)).toBeUndefined();
  });

  it("reports the SVG's PNG fallback as auto-generated, and the SVG itself without flags", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const f = issueFor(findings, "auto-generated", seeds.svgFallback.fallback);
    expect(f).toBeDefined();
    expect(f?.data.reason).toBe("svg-fallback");
    expect(f?.targets.map((t) => t.shapeName)).toEqual(["Icon SVG"]);
    expect(issues(findings).filter((i) => i.data.partName === seeds.svgFallback.svg)).toEqual([]);
    // The fallback is not what is displayed: no dimension flags on it.
    expect(issues(findings).filter((i) => i.data.partName === seeds.svgFallback.fallback).map((i) => i.data.issue)).toEqual([
      "auto-generated",
    ]);
    const svgSize = sizes(findings).find((s) => s.data.partName === seeds.svgFallback.svg);
    expect(svgSize?.data).toMatchObject({ format: "svg", width: 200, height: 100 });
  });

  it("lists the unknown-format image with its size and no dimension flags", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const size = sizes(findings).find((s) => s.data.partName === seeds.unknownFormat.part);
    expect(size?.data.format).toBe("unknown");
    expect(size?.data.bytes).toBe(3000);
    expect(size?.data.width).toBeUndefined();
    expect(issues(findings).filter((i) => i.data.partName === seeds.unknownFormat.part)).toEqual([]);
  });

  it("flags the cropped image as cropped-retained with its crop values", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const f = issueFor(findings, "cropped-retained", seeds.cropped.part);
    expect(f?.data.uses[0]?.crop).toEqual({ l: 10000, t: 0, r: 5000, b: 0 });
    expect(f?.targets.map((t) => t.shapeName)).toEqual(["Cropped"]);
  });

  it("flags the 100×100 image shown at 5×5 in as too small (20 PPI)", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const f = issueFor(findings, "too-small", seeds.tooSmall.part);
    expect(f?.data.uses[0]?.effectivePpi).toBeCloseTo(20, 5);
  });

  it("lists the video with its size, attributed to its slide, and flags nothing on it", async () => {
    const { findings } = await audit(await mediaBloatDeck());
    const video = sizes(findings).find((s) => s.data.partName === seeds.video.part);
    expect(video?.data.mediaKind).toBe("video");
    expect(video?.data.slides.map((s) => s.slideNumber)).toEqual([6]);
    expect(issues(findings).filter((i) => i.data.partName === seeds.video.part)).toEqual([]);
  });

  it("builds a size breakdown whose categories sum exactly to the uncompressed package size", async () => {
    const { pres, findings } = await audit(await mediaBloatDeck());
    const b = breakdown(findings);
    const c = b.data.categories;
    expect(c.media + c.fonts + c.xml + c.other).toBe(pres.totalUncompressedSize);
    expect(b.data.totalBytes).toBe(pres.totalUncompressedSize);
    expect(b.data.slides).toHaveLength(pres.slides.length);
    expect(b.severity).toBe("info");
    expect(b.area).toBe("media");
    // Slide 1 carries the 5 MB JPEG.
    expect(b.data.slides[0]?.mediaBytes).toBeGreaterThanOrEqual(seeds.oversized.bytes);
  });

  it("emits one media-size finding per media part, largest first", async () => {
    const { pres, findings } = await audit(await mediaBloatDeck());
    const list = sizes(findings);
    expect(list.map((s) => s.data.partName).sort()).toEqual(pres.media.map((m) => m.partName).sort());
    const bytes = list.map((s) => s.data.bytes);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
  });

  it("covers every seeded media problem and runs without check failures through the runner", async () => {
    const result = await runChecks(await mediaBloatDeck(), {}, { checks: mediaChecks });
    expect(result.errors).toEqual([]);
    const f = result.findings;
    expect(issueFor(f, "oversized", seeds.oversized.part)).toBeDefined();
    expect(issueFor(f, "distorted", seeds.distorted.part)).toBeDefined();
    expect(issueFor(f, "cropped-retained", seeds.cropped.part)).toBeDefined();
    expect(issueFor(f, "auto-generated", seeds.svgFallback.fallback)).toBeDefined();
    expect(issueFor(f, "too-small", seeds.tooSmall.part)).toBeDefined();
    expect(sizes(f).find((s) => s.data.partName === seeds.shared.part)?.data.shared).toBe(true);
    // Every finding survives structuredClone (worker boundary).
    expect(structuredClone(f)).toEqual(f);
    // Deterministic ids.
    const again = await runChecks(await mediaBloatDeck(), {}, { checks: mediaChecks });
    expect(again.findings.map((x) => x.id)).toEqual(f.map((x) => x.id));
    expect(new Set(f.map((x) => x.id)).size).toBe(f.length);
  });
});

describe("media checks: clean deck", () => {
  it("raises no warnings on the clean fixture", async () => {
    const { findings } = await audit(await cleanDeck());
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(findings.filter((f) => f.kind === "file-size-breakdown")).toHaveLength(1);
  });
});

describe("media checks: geometry", () => {
  it("uses only the visible (cropped) pixels in the PPI calculation", async () => {
    const { findings } = await audit(await cropPpiDeck());
    // Full image1: 1000×500 px at 2×1 in → 500 PPI; no other flags (small bytes, no distortion).
    expect(issues(findings).filter((i) => i.data.partName === "ppt/media/image1.png")).toEqual([]);
    const cropped = issueFor(findings, "cropped-retained", "ppt/media/image2.png");
    const use = cropped?.data.uses[0];
    expect(use?.visiblePixels).toEqual({ width: 500, height: 250 });
    expect(use?.ppi?.x).toBeCloseTo(250, 5);
    expect(use?.ppi?.y).toBeCloseTo(250, 5);
    expect(issueFor(findings, "distorted", "ppt/media/image2.png")).toBeUndefined();
  });

  it("counts a picture fill on a shape as a use", async () => {
    const { findings } = await audit(await pictureFillDeck());
    const f = issueFor(findings, "too-small", "ppt/media/image1.png");
    expect(f).toBeDefined();
    expect(f?.data.uses[0]).toMatchObject({ source: "shape-fill", shapeName: "Filled rect" });
    expect(f?.data.uses[0]?.effectivePpi).toBeCloseTo(25, 5);
    expect(f?.targets[0]).toMatchObject({ shapeId: 2, container: { kind: "slide" } });
  });

  it("counts a slide background picture as a use sized to the slide", async () => {
    const { findings } = await audit(await backgroundDeck());
    const f = issueFor(findings, "too-small", "ppt/media/image1.png");
    expect(f?.data.uses[0]?.source).toBe("background");
    expect(f?.data.uses[0]?.displayed?.widthIn).toBeCloseTo(12192000 / 914400, 5);
    expect(f?.targets[0]).toMatchObject({ container: { kind: "slide", slideNumber: 1 } });
    expect(f?.targets[0]?.shapeId).toBeUndefined();
  });

  it("applies group scaling to the displayed size", async () => {
    const { findings } = await audit(await groupScaledDeck());
    // 400 px over 2 in (group halves the 4 in child) → 200 PPI → no flags.
    expect(issues(findings)).toEqual([]);
    const size = sizes(findings)[0];
    expect(size?.data).toMatchObject({ width: 400, height: 400 });
  });

  it("resolves a placeholder picture's size from the layout/master when it has no xfrm", async () => {
    const { findings } = await audit(await inheritedPlaceholderDeck());
    const f = issueFor(findings, "too-small", "ppt/media/image1.png");
    expect(f?.data.uses[0]?.displayed?.widthIn).toBeCloseTo(10515600 / 914400, 5);
    expect(f?.data.uses[0]?.displayed?.heightIn).toBeCloseTo(4351338 / 914400, 5);
  });

  it("does not report cropped-retained when another use shows the whole image", async () => {
    const { findings } = await audit(await partialCropSharedDeck());
    expect(issues(findings, "cropped-retained")).toEqual([]);
    const size = sizes(findings)[0];
    expect(size?.data.shared).toBe(true);
  });
});

describe("media checks: formats and compression", () => {
  it("flags a photo-like PNG and a very high-quality JPEG as low-compression, but not a normal JPEG", async () => {
    const { findings } = await audit(await lowCompressionDeck());
    const png = issueFor(findings, "low-compression", "ppt/media/image1.png");
    expect(png?.data.bytesPerPixel).toBeGreaterThan(PNG_LOW_COMPRESSION_BYTES_PER_PIXEL);
    expect(png?.data.threshold).toBe(PNG_LOW_COMPRESSION_BYTES_PER_PIXEL);
    const jpg = issueFor(findings, "low-compression", "ppt/media/image2.jpeg");
    expect(jpg?.data.bytesPerPixel).toBeCloseTo(0.7, 5);
    expect(jpg?.data.threshold).toBe(JPEG_LOW_COMPRESSION_BYTES_PER_PIXEL);
    expect(issueFor(findings, "low-compression", "ppt/media/image3.jpeg")).toBeUndefined();
    expect(issues(findings).map((i) => i.data.issue)).toEqual(["low-compression", "low-compression"]);
  });

  it("reports an HD Photo (WDP) companion as auto-generated", async () => {
    const { findings } = await audit(await hdphotoDeck());
    const f = issueFor(findings, "auto-generated", "ppt/media/hdphoto1.wdp");
    expect(f?.data.reason).toBe("hdphoto-companion");
    expect(f?.data.format).toBe("wdp");
    expect(f?.targets.map((t) => t.shapeName)).toEqual(["Artistic"]);
    expect(issues(findings).filter((i) => i.data.partName === "ppt/media/image1.png")).toEqual([]);
  });

  it("handles an unknown format (cropped) without dimension flags; fonts and other parts are categorized", async () => {
    const { pres, findings } = await audit(await unknownAndFontsDeck());
    const kinds = issues(findings).map((i) => i.data.issue);
    expect(kinds).toEqual(["cropped-retained"]);
    const b = breakdown(findings);
    const c = b.data.categories;
    expect(c.media + c.fonts + c.xml + c.other).toBe(pres.totalUncompressedSize);
    const fontBytes = pres.embeddedFonts.flatMap((f) => f.styles).reduce((n, s) => n + (s.size ?? 0), 0);
    expect(fontBytes).toBeGreaterThan(0);
    expect(c.fonts).toBe(fontBytes);
    expect(c.other).toBeGreaterThan(0); // docProps/thumbnail.jpeg
    expect(c.media).toBe(3000);
  });

  it("does not fail when a media part referenced by a picture is missing from the package", async () => {
    const { mutateDeck } = await import("../helpers/mutateDeck");
    const bytes = await mutateDeck(await pictureFillDeck(), (m) => m.remove("ppt/media/image1.png"));
    const result = await runChecks(bytes, {}, { checks: mediaChecks });
    expect(result.errors).toEqual([]);
  });
});
