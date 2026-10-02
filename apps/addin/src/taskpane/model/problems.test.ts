import { describe, expect, it } from "vitest";
import type { Finding } from "@slidecheck/audit-core";
import { fakeFinding, slideShape } from "../testing/fixtures";
import {
  fileSize,
  fontMaybeMissing,
  fontSummary,
  imageIssue,
  mediaFinding,
  mediaSize,
  offSlide,
  partlyOff,
  textCollision,
} from "../testing/problemFindings";
import { buildProblems, PROBLEM_CATEGORIES, type ProblemCategoryId } from "./problems";

const cat = (findings: Finding[], id: ProblemCategoryId) => {
  const c = buildProblems(findings).categories.find((x) => x.id === id);
  if (!c) throw new Error(`no category ${id}`);
  return c;
};

const reachable = (slide: number, shape: number) => ({ ...slideShape(slide, shape), reachable: true });

describe("buildProblems", () => {
  it("a clean deck is ready for show: every category passes", () => {
    const m = buildProblems([
      fakeFinding({ area: "fonts", kind: "font-usage", title: "Calibri" }),
      fontSummary(true),
      fakeFinding({ area: "review", kind: "hidden-slide", severity: "warning" }),
      mediaFinding("media-playback-settings"),
    ]);
    expect(m.categories.map((c) => c.id)).toEqual([...PROBLEM_CATEGORIES]);
    expect(m.categories.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(m.ready).toBe(true);
    expect(m.problemCount).toBe(0);
    expect(m.headline).toBe("Ready for show");
    expect(m.categories.every((c) => c.findings.length === 0)).toBe(true);
  });

  it("labels the five categories in order", () => {
    expect(buildProblems([]).categories.map((c) => c.label)).toEqual([
      "Videos & audio",
      "Fonts",
      "Off-slide objects",
      "Text touching objects",
      "Media & image size",
    ]);
  });

  it.each([
    ["media-missing", "playback"],
    ["media-linked", "playback"],
    ["media-online", "playback"],
    ["media-format", "playback"],
  ] as const)("%s is a %s problem", (kind, id) => {
    const c = cat([mediaFinding(kind)], id);
    expect(c.status).toBe("warning");
    expect(c.warnings).toBe(1);
    expect(c.findings.map((f) => f.kind)).toEqual([kind]);
  });

  it("an info media format and a missing poster frame are notes, not problems", () => {
    const findings = [mediaFinding("media-format", { severity: "info" }), mediaFinding("media-poster-missing")];
    const c = cat(findings, "playback");
    expect(c.status).toBe("note");
    expect([c.warnings, c.notes]).toEqual([0, 2]);
    expect(buildProblems(findings).headline).toBe("Ready for show");
  });

  it("playback settings and linked-file (Links) are not listed (G6: a linked video shows once, under Videos)", () => {
    const linkedFile = fakeFinding({ area: "links", kind: "linked-file", severity: "warning" });
    const c = cat([mediaFinding("media-playback-settings"), mediaFinding("media-linked"), linkedFile], "playback");
    expect(c.findings.map((f) => f.kind)).toEqual(["media-linked"]);
    expect(buildProblems([linkedFile]).problemCount).toBe(0);
  });

  it("fonts: font-maybe-missing warnings, symbol-only infos, and the show-machine list status", () => {
    const findings = [
      fontMaybeMissing("Wingdings 3", [slideShape(1, 2)], { severity: "info" }),
      fontMaybeMissing("MS Gothic", [reachable(1, 3)]),
      fontMaybeMissing("Segoe UI", [slideShape(2, 4)]),
      fontSummary(false, 3),
    ];
    const m = buildProblems(findings);
    const c = cat(findings, "fonts");
    expect(c.status).toBe("warning");
    expect([c.warnings, c.notes]).toEqual([2, 1]);
    // Warnings first.
    expect(c.findings.map((f) => f.severity)).toEqual(["warning", "warning", "info"]);
    expect(m.fontList).toEqual({ teamListProvided: false });
    expect(m.missingFonts).toEqual(["Wingdings 3", "MS Gothic", "Segoe UI"]);
    expect(m.reachableMissingFonts).toEqual(["MS Gothic"]);
  });

  it("off-slide objects: off-slide-shape and partly-off-slide (bleeding pictures are notes)", () => {
    const findings = [partlyOff(3, "info"), offSlide(2), partlyOff(4)];
    const c = cat(findings, "off-slide");
    expect([c.warnings, c.notes]).toEqual([2, 1]);
    expect(c.findings.map((f) => f.kind)).toEqual(["off-slide-shape", "partly-off-slide", "partly-off-slide"]);
    expect(c.findings[2]!.severity).toBe("info");
  });

  it("text touching objects: warnings listed, infos kept apart as possibly intentional", () => {
    const findings = [textCollision(1, "info"), textCollision(2), textCollision(5, "info")];
    const c = cat(findings, "text-collision");
    expect(c.status).toBe("warning");
    expect(c.findings).toHaveLength(1);
    expect(c.intentional).toHaveLength(2);
    expect([c.warnings, c.notes]).toEqual([1, 2]);
  });

  it("only possibly-intentional text overlaps make a note, not a problem", () => {
    const c = cat([textCollision(1, "info")], "text-collision");
    expect(c.status).toBe("note");
  });

  it("media & image size: image-issue warnings and the file-size headline with the largest media", () => {
    const findings = [
      fileSize(50_000_000, 45_000_000),
      mediaSize("ppt/media/image1.png", 1_000),
      mediaSize("ppt/media/media2.mp4", 30_000_000, "video"),
      mediaSize("ppt/media/image3.jpeg", 9_000_000),
      mediaSize("ppt/media/image4.png", 5_000),
      imageIssue("oversized"),
      imageIssue("distorted"),
    ];
    const m = buildProblems(findings);
    const c = cat(findings, "size");
    expect(c.status).toBe("warning");
    expect(c.warnings).toBe(2);
    expect(m.size).toEqual({
      totalBytes: 50_000_000,
      mediaBytes: 45_000_000,
      largest: [
        { name: "media2.mp4", partName: "ppt/media/media2.mp4", bytes: 30_000_000, mediaKind: "video" },
        { name: "image3.jpeg", partName: "ppt/media/image3.jpeg", bytes: 9_000_000, mediaKind: "image" },
        { name: "image4.png", partName: "ppt/media/image4.png", bytes: 5_000, mediaKind: "image" },
      ],
    });
  });

  it("the headline counts warnings across categories", () => {
    const findings = [mediaFinding("media-missing"), fontMaybeMissing("MS Gothic", []), offSlide(1), textCollision(2), imageIssue("oversized"), mediaFinding("media-poster-missing")];
    const m = buildProblems(findings);
    expect(m.problemCount).toBe(5);
    expect(m.ready).toBe(false);
    expect(m.headline).toBe("5 problems to fix");
    expect(buildProblems([offSlide(1)]).headline).toBe("1 problem to fix");
  });
});
