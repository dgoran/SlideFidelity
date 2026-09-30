import { describe, expect, it } from "vitest";
import { CHECKS, runChecks, type Area } from "../src/index";
import { corpusDeck } from "./helpers/corpus";

const SEEDED: Record<string, Area> = {
  "fonts-hidden": "fonts",
  "colors-literal": "colors",
  "media-bloat": "media",
  "masters-messy": "masters",
  links: "links",
  "review-leaks": "review",
};

describe("all registered checks over the fixture corpus", () => {
  it("registers checks for every audited area", () => {
    const areas = new Set(CHECKS.map((c) => c.area));
    expect([...areas].sort()).toEqual(["colors", "fonts", "links", "masters", "media", "review"]);
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });

  it("finds no warnings on the clean deck", async () => {
    const result = await runChecks(await corpusDeck("clean"));
    expect(result.errors).toEqual([]);
    const warnings = result.findings.filter((f) => f.severity !== "info");
    expect(warnings.map((f) => `${f.area}:${f.kind}:${f.title}`)).toEqual([]);
  });

  it.each(Object.entries(SEEDED))("flags warnings in the seeded area of %s without failing any check", async (name, area) => {
    const result = await runChecks(await corpusDeck(name as Parameters<typeof corpusDeck>[0]));
    expect(result.errors).toEqual([]);
    expect(result.findings.some((f) => f.kind === "check-failed")).toBe(false);
    expect(result.findings.some((f) => f.area === area && f.severity === "warning")).toBe(true);
  });

  it("produces unique ids and structured-clone-safe results for every deck", async () => {
    for (const name of ["clean", ...Object.keys(SEEDED)]) {
      const result = await runChecks(await corpusDeck(name as Parameters<typeof corpusDeck>[0]));
      const ids = result.findings.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(structuredClone(result)).toEqual(result);
    }
  });
});
