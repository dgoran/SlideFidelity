/** A small synthetic scan result touching every area, for component tests. */
import type { AuditResult, Finding } from "@slidecheck/audit-core";
import { fakeFinding, fakeResult, slideShape } from "../testing/fixtures";

export function deckFindings(): Finding[] {
  return [
    fakeFinding({ area: "fonts", kind: "font-usage", group: "Calibri", title: "Calibri", count: 40, targets: [slideShape(1, 2), slideShape(2, 3)] }),
    fakeFinding({ area: "fonts", kind: "font-usage", group: "Comic Sans MS", title: "Comic Sans MS", count: 3, severity: "warning", targets: [slideShape(3, 4, "Title 1")] }),
    fakeFinding({ area: "fonts", kind: "hidden-list-style", group: "hidden-list-style", title: "Hidden list style names Wingdings", severity: "warning" }),
    fakeFinding({ area: "colors", kind: "color-usage", group: "FF0000", title: "#FF0000 used 4 times", severity: "warning" }),
    fakeFinding({ area: "colors", kind: "color-usage", group: "00FF00", title: "#00FF00 used 1 time" }),
    fakeFinding({
      area: "media",
      kind: "file-size-breakdown",
      group: "file-size",
      title: "File size",
      data: { totalBytes: 5 * 1024 * 1024, categories: { media: 4 * 1024 * 1024, fonts: 512 * 1024, xml: 256 * 1024, other: 256 * 1024 } },
    }),
    fakeFinding({ area: "media", kind: "media-size", group: "ppt/media/image1.png", title: "image1.png", data: { bytes: 4000 } }),
    fakeFinding({ area: "media", kind: "image-issue", group: "oversized", title: "Oversized image", severity: "warning" }),
    fakeFinding({ area: "masters", kind: "unused-layout", group: "m1", title: "Unused layout", severity: "warning" }),
    fakeFinding({ area: "links", kind: "hyperlink", group: "https://example.com", title: "Web link" }),
    fakeFinding({ area: "review", kind: "hidden-slide", group: "hidden-slides", title: "Hidden slide", severity: "warning" }),
    fakeFinding({ area: "review", kind: "speaker-notes", group: "speaker-notes", title: "Speaker notes" }),
  ];
}

export function deckResult(): AuditResult {
  return fakeResult(deckFindings());
}
