// @vitest-environment node
/**
 * Seam test: real audit-core scans of the corpus decks feed the Problems model, so a change in the
 * engine's finding kinds or severities shows up here instead of silently emptying a category.
 */
import { describe, expect, it } from "vitest";
import { runChecks, type AuditOptions, type AuditResult } from "@slidecheck/audit-core";
import { corpusDeck, type CorpusName } from "../../../../../packages/audit-core/test/helpers/corpus";
import { buildProblems, type ProblemCategoryId } from "./problems";

const scans = new Map<string, Promise<AuditResult>>();
function scan(name: CorpusName, options?: AuditOptions): Promise<AuditResult> {
  const key = `${name}:${JSON.stringify(options ?? {})}`;
  let p = scans.get(key);
  if (!p) {
    p = corpusDeck(name).then((bytes) => runChecks(bytes, options));
    scans.set(key, p);
  }
  return p;
}

const status = (m: ReturnType<typeof buildProblems>, id: ProblemCategoryId) => m.categories.find((c) => c.id === id)!;

describe("Problems model over real scans", () => {
  it("clean deck: ready for show", async () => {
    const m = buildProblems((await scan("clean")).findings);
    expect(m.headline).toBe("Ready for show");
    expect(m.categories.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(m.fontList).toEqual({ teamListProvided: false });
    expect(m.size?.totalBytes).toBeGreaterThan(0);
  });

  it("fonts-hidden: MS Gothic may be missing", async () => {
    const m = buildProblems((await scan("fonts-hidden")).findings);
    const fonts = status(m, "fonts");
    expect(fonts.status).toBe("warning");
    expect(m.missingFonts).toContain("MS Gothic");
    expect(fonts.findings.map((f) => f.kind)).toEqual(fonts.findings.map(() => "font-maybe-missing"));
    expect(m.ready).toBe(false);
  });

  it("fonts-hidden with MS Gothic on the show-machine list: no longer flagged, list noted as provided", async () => {
    const m = buildProblems((await scan("fonts-hidden", { availableFonts: ["ms gothic"] })).findings);
    expect(m.missingFonts).not.toContain("MS Gothic");
    expect(m.fontList).toEqual({ teamListProvided: true });
  });

  it("review-leaks: off-slide objects", async () => {
    const m = buildProblems((await scan("review-leaks")).findings);
    const off = status(m, "off-slide");
    expect(off.status).toBe("warning");
    expect(off.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["off-slide-shape", "partly-off-slide"]));
  });

  it("media-bloat: image size issues and the largest media", async () => {
    const m = buildProblems((await scan("media-bloat")).findings);
    const size = status(m, "size");
    expect(size.status).toBe("warning");
    expect(size.warnings).toBeGreaterThanOrEqual(5);
    expect(size.findings.every((f) => f.kind === "image-issue")).toBe(true);
    expect(m.size?.largest.length).toBe(3);
    const bytes = m.size!.largest.map((x) => x.bytes);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
  });
});
