import { describe, expect, it } from "vitest";
import { fakeFinding, slideShape } from "../testing/fixtures";
import { describeTarget, filterFindings, flattenTree, groupFindings } from "./tree";

describe("tree model (D14)", () => {
  it("groups by the finding group, warnings first, then by count", () => {
    const groups = groupFindings("fonts", [
      fakeFinding({ area: "fonts", group: "Calibri", count: 40 }),
      fakeFinding({ area: "fonts", group: "Arial", count: 3, severity: "warning" }),
      fakeFinding({ area: "fonts", group: "Wingdings", count: 90 }),
      fakeFinding({ area: "fonts", group: "Calibri", count: 5 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["Arial", "Wingdings", "Calibri"]);
    expect(groups[2]!.count).toBe(45);
    expect(groups[0]!.warnings).toBe(1);
  });

  it("uses the group label when present", () => {
    const [g] = groupFindings("colors", [fakeFinding({ area: "colors", group: "FF0000", groupLabel: "#FF0000" })]);
    expect(g!.label).toBe("#FF0000");
  });

  it("media: issue-type groups, then a size list sorted by bytes", () => {
    const groups = groupFindings("media", [
      fakeFinding({ area: "media", kind: "media-size", group: "a.png", title: "a", data: { bytes: 10 } }),
      fakeFinding({ area: "media", kind: "image-issue", group: "oversized", groupLabel: "Oversized", severity: "warning" }),
      fakeFinding({ area: "media", kind: "media-size", group: "b.png", title: "b", data: { bytes: 900 } }),
      fakeFinding({ area: "media", kind: "file-size-breakdown", group: "file-size", title: "File size: 1 MB" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["oversized", "media-size", "file-size"]);
    expect(groups[1]!.label).toBe("Media by size");
    expect(groups[1]!.findings.map((f) => f.title)).toEqual(["b", "a"]);
  });

  it("review: grouped by kind", () => {
    const groups = groupFindings("review", [
      fakeFinding({ area: "review", kind: "document-property", group: "properties-core", groupLabel: "Document properties" }),
      fakeFinding({ area: "review", kind: "document-property", group: "properties-custom", groupLabel: "Custom properties", severity: "warning" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("document-property");
    expect(groups[0]!.findings[0]!.severity).toBe("warning");
  });

  it("labels review kinds and failed checks in plain language", () => {
    const groups = groupFindings("review", [
      fakeFinding({ area: "review", kind: "animation", group: "animations" }),
      fakeFinding({ area: "review", kind: "check-failed", group: "check-failed", severity: "error" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Checks that could not finish", "Animations"]);
  });

  it("filters by severity and by case-insensitive search over title, detail, and group", () => {
    const fs = [
      fakeFinding({ area: "links", title: "Link A", group: "https://example.com", severity: "info" }),
      fakeFinding({ area: "links", title: "Link B", detail: "Local PATH", group: "C:\\x", severity: "warning" }),
    ];
    expect(filterFindings(fs, { severity: "warning", search: "" }).map((f) => f.title)).toEqual(["Link B"]);
    expect(filterFindings(fs, { severity: "all", search: "EXAMPLE" }).map((f) => f.title)).toEqual(["Link A"]);
    expect(filterFindings(fs, { severity: "all", search: "path" }).map((f) => f.title)).toEqual(["Link B"]);
    expect(filterFindings(fs, { severity: "info", search: "" }).map((f) => f.title)).toEqual(["Link A"]);
  });

  it("flattens with aria level/setsize/posinset; groups open, multi-target findings collapsed", () => {
    const groups = groupFindings("fonts", [
      fakeFinding({ area: "fonts", group: "A", targets: [slideShape(1, 2), slideShape(2, 3)], id: "f1" }),
      fakeFinding({ area: "fonts", group: "A", id: "f2" }),
      fakeFinding({ area: "fonts", group: "B", id: "f3" }),
    ]);
    const rows = flattenTree(groups, new Set());
    expect(rows.map((r) => [r.key, r.level, r.posinset, r.setsize, r.expanded])).toEqual([
      ["g:A", 1, 1, 2, true],
      ["f:f1", 2, 1, 2, false],
      ["f:f2", 2, 2, 2, undefined],
      ["g:B", 1, 2, 2, true],
      ["f:f3", 2, 1, 1, undefined],
    ]);
    const opened = flattenTree(groups, new Set(["f:f1", "g:B"]));
    expect(opened.map((r) => r.key)).toEqual(["g:A", "f:f1", "t:f1:0", "t:f1:1", "f:f2", "g:B"]);
    expect(opened[2]).toMatchObject({ level: 3, posinset: 1, setsize: 2 });
  });

  it("describes targets for people", () => {
    expect(describeTarget(slideShape(3, 4, "Title 1"))).toBe("Slide 3 · Title 1");
    expect(describeTarget({ container: { kind: "layout", partName: "p", name: "Title Slide" } })).toBe("Layout “Title Slide”");
    expect(describeTarget({ container: { kind: "master", partName: "ppt/slideMasters/slideMaster1.xml" } })).toBe(
      "Master “slideMaster1”",
    );
    expect(describeTarget({ container: { kind: "notes", partName: "n", slideNumber: 2 } })).toBe("Notes · slide 2");
  });
});
