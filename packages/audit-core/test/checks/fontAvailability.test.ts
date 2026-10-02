import { describe, expect, it } from "vitest";
import { fontAvailabilityChecks } from "../../src/checks/fontAvailability";
import { CHECKS, createAuditCache, loadPresentation, runChecks, runChecksCached, type AuditOptions, type Finding, type FindingOf } from "../../src/index";
import { officeCrossPlatformFont, platformOnlyFont } from "../../src/officeFonts";
import { buildDeck, para, run, sp, type DeckSpec } from "../helpers/buildDeck";
import { corpusDeck } from "../helpers/corpus";

const IN = 914400;

const latin = (typeface: string): { inner: string } => ({ inner: `<a:latin typeface="${typeface}"/>` });

/** One slide per entry; each slide holds one text box whose single run uses the given rPr. */
function deck(runs: { inner: string }[], extra: Partial<DeckSpec> = {}): Promise<Uint8Array> {
  return buildDeck({
    slides: runs.map((rPr, i) => ({
      layout: "Blank",
      shapes: sp({ id: 2, name: `TextBox ${i + 1}`, x: IN, y: IN, cx: IN, cy: IN, paragraphs: para(run("Text", rPr)) }),
    })),
    ...extra,
  });
}

async function scan(bytes: Uint8Array, options: AuditOptions = {}): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of fontAvailabilityChecks) out.push(...(await c.run({ pres, options })));
  return out;
}

function missing(findings: Finding[]): FindingOf<"font-maybe-missing">[] {
  return findings.filter((f): f is FindingOf<"font-maybe-missing"> => f.kind === "font-maybe-missing");
}

function summary(findings: Finding[]): FindingOf<"font-availability-summary"> {
  const s = findings.filter((f): f is FindingOf<"font-availability-summary"> => f.kind === "font-availability-summary");
  expect(s).toHaveLength(1);
  const first = s[0];
  if (!first) throw new Error("no summary");
  return first;
}

describe("officeFonts lists", () => {
  it("matches case-insensitively and excludes Windows-only Segoe UI", () => {
    expect(officeCrossPlatformFont("calibri")?.name).toBe("Calibri");
    expect(officeCrossPlatformFont(" Times New Roman ")).toBeDefined();
    expect(officeCrossPlatformFont("Aptos")?.cloud).toBe(true);
    expect(officeCrossPlatformFont("Segoe UI")).toBeUndefined();
    expect(platformOnlyFont("Segoe UI")?.platform).toBe("windows");
    expect(platformOnlyFont("MS Gothic")?.platform).toBe("windows");
    expect(platformOnlyFont("ヒラギノ角ゴ ProN W3")?.platform).toBe("mac");
    expect(platformOnlyFont("Arial")).toBeUndefined();
  });
});

describe("font availability check", () => {
  it("exports fonts-area checks", () => {
    expect(fontAvailabilityChecks.length).toBeGreaterThan(0);
    for (const c of fontAvailabilityChecks) expect(c.area).toBe("fonts");
  });

  it("Calibri + Arial only: no warnings", async () => {
    const findings = await scan(await deck([latin("Arial"), latin("Calibri")]));
    expect(missing(findings)).toEqual([]);
    expect(findings.filter((f) => f.severity === "warning")).toEqual([]);
    const s = summary(findings);
    expect(s.severity).toBe("info");
    expect(s.data.maybeMissing).toBe(0);
    expect(s.data.safeByOffice).toBeGreaterThanOrEqual(2);
  });

  it("custom font not embedded: warning whose targets the replace-font fix can use", async () => {
    const findings = await scan(await deck([latin("Gotham"), latin("Arial"), latin("Gotham")]));
    const m = missing(findings);
    expect(m).toHaveLength(1);
    const f = m[0];
    if (!f) throw new Error("missing finding");
    expect(f.severity).toBe("warning");
    expect(f.area).toBe("fonts");
    expect(f.title).toBe("Font 'Gotham' may be missing on the presenting computer (not embedded, not a standard Office font)");
    expect(f.fixes).toEqual(["replace-font"]);
    expect(f.reachable).toBe(true);
    expect(f.targets).toHaveLength(2);
    for (const t of f.targets) {
      expect(t.reachable).toBe(true);
      expect(t.shapeId).toBe(2);
      expect(t.locator).toEqual({ property: "text", paragraphIndex: 0, runIndex: 0, script: "latin" });
    }
    expect(f.data).toMatchObject({
      typeface: "Gotham",
      usageCount: 2,
      slideNumbers: [1, 3],
      sources: ["direct"],
      embedded: "none",
      onTeamList: false,
      replacement: "Arial",
    });
    expect(f.data.suggestion).toMatch(/embed/i);
    expect(f.detail).toMatch(/slides 1, 3/);
    // Same targets as the font-usage finding, so the existing fix applies unchanged.
    expect(() => structuredClone(f)).not.toThrow();
  });

  it("same font fully embedded: safe", async () => {
    const findings = await scan(await deck([latin("Gotham")], { embeddedFonts: [{ typeface: "Gotham", styles: ["regular"] }] }));
    expect(missing(findings)).toEqual([]);
    const s = summary(findings);
    expect(s.data.safeByEmbedding).toBe(1);
    expect(s.data.fonts.find((x) => x.typeface === "Gotham")?.status).toBe("embedded");
  });

  it("on the show-machine list (different case): safe", async () => {
    const findings = await scan(await deck([latin("Gotham")]), { availableFonts: ["  gOTHAM "] });
    expect(missing(findings)).toEqual([]);
    const s = summary(findings);
    expect(s.data.safeByTeamList).toBe(1);
    expect(s.data.teamListProvided).toBe(true);
  });

  it("subset embedded: safe, with a note", async () => {
    const findings = await scan(
      await deck([latin("Gotham")], { embeddedFonts: [{ typeface: "Gotham", styles: ["regular"] }], saveSubsetFonts: true }),
    );
    expect(missing(findings)).toEqual([]);
    const s = summary(findings);
    expect(s.data.safeByEmbedding).toBe(1);
    expect(s.data.subsetEmbedded).toBe(1);
    const g = s.data.fonts.find((x) => x.typeface === "Gotham");
    expect(g?.status).toBe("embedded-subset");
    expect(g?.note).toMatch(/subset/i);
    expect(s.detail).toMatch(/subset/i);
  });

  it("theme font reference to a custom theme font: warning (not offered as an in-place fix target)", async () => {
    const bytes = await buildDeck({
      masters: [{ theme: { majorLatin: "Brand Display", minorLatin: "Brand Sans" }, layouts: [{ name: "Blank", type: "blank" }] }],
      slides: [{ shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: IN, cy: IN, paragraphs: para(run("Theme", latin("+mn-lt"))) }) }],
    });
    const m = missing(await scan(bytes));
    const sans = m.find((f) => f.data.typeface === "Brand Sans");
    expect(sans?.severity).toBe("warning");
    expect(sans?.data.slideNumbers).toEqual([1]);
    const slideTarget = sans?.targets.find((t) => t.container.kind === "slide");
    expect(slideTarget?.reachable).toBe(false);
    expect(sans?.reachable).toBe(false);
    expect(m.some((f) => f.data.typeface === "Brand Display")).toBe(true);
  });

  it("Segoe UI: warning with a Windows-only platform note", async () => {
    const f = missing(await scan(await deck([latin("Segoe UI")])))[0];
    expect(f?.severity).toBe("warning");
    expect(f?.data.platform).toBe("windows");
    expect(f?.data.platformNote).toMatch(/Mac/);
    expect(f?.detail).toMatch(/Mac/);
  });

  it("East Asian fonts standard on one platform: warning with platform note", async () => {
    const findings = await scan(await deck([{ inner: `<a:latin typeface="Arial"/><a:ea typeface="MS Gothic"/>` }, { inner: `<a:ea typeface="Hiragino Sans"/>` }]));
    const gothic = missing(findings).find((f) => f.data.typeface === "MS Gothic");
    expect(gothic?.severity).toBe("warning");
    expect(gothic?.data.platform).toBe("windows");
    expect(gothic?.data.scripts).toEqual(["ea"]);
    expect(gothic?.reachable).toBe(false);
    const hira = missing(findings).find((f) => f.data.typeface === "Hiragino Sans");
    expect(hira?.data.platform).toBe("mac");
    expect(hira?.data.platformNote).toMatch(/Windows/);
  });

  it("font used only as a symbol/bullet glyph font: info, not warning", async () => {
    const paragraphs =
      para(run("Item", latin("Arial")), `<a:pPr><a:buFont typeface="Wingdings 2"/><a:buChar char="P"/></a:pPr>`) +
      para(run("x", { inner: `<a:latin typeface="Arial"/><a:sym typeface="Marlett"/>` }));
    const bytes = await buildDeck({ slides: [{ layout: "Blank", shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: IN, cy: IN, paragraphs }) }] });
    const findings = await scan(bytes);
    const w2 = missing(findings).find((f) => f.data.typeface === "Wingdings 2");
    expect(w2?.severity).toBe("info");
    expect(w2?.data.symbolOnly).toBe(true);
    expect(missing(findings).find((f) => f.data.typeface === "Marlett")?.severity).toBe("info");
    expect(summary(findings).data.maybeMissing).toBe(2);
  });

  it("summary counts each category and whether a team list was set", async () => {
    const bytes = await deck([latin("Gotham"), latin("Futura PT"), latin("Brand Serif"), latin("Segoe UI"), latin("Verdana")], {
      embeddedFonts: [{ typeface: "Futura PT", styles: ["regular"] }],
    });
    const noList = summary(await scan(bytes));
    expect(noList.data).toMatchObject({ safeByEmbedding: 1, safeByTeamList: 0, maybeMissing: 3, teamListProvided: false });
    // Theme Calibri / Calibri Light, master bullet Arial, and Verdana.
    expect(noList.data.safeByOffice).toBe(4);
    expect(noList.title).toMatch(/3 fonts may be missing/);
    expect(noList.detail).toMatch(/No show-machine font list set/);

    const withList = summary(await scan(bytes, { availableFonts: ["Gotham", "brand serif"] }));
    expect(withList.data).toMatchObject({ safeByEmbedding: 1, safeByOffice: 4, safeByTeamList: 2, maybeMissing: 1, teamListProvided: true });
    expect(withList.detail).not.toMatch(/No show-machine font list set/);

    expect(summary(await scan(bytes, { availableFonts: [] })).data.teamListProvided).toBe(false);
  });

  it("is deterministic and structured-clone safe", async () => {
    const bytes = await deck([latin("Gotham"), latin("Segoe UI")]);
    const a = await scan(bytes);
    const b = await scan(bytes);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    expect(structuredClone(a)).toEqual(a);
  });

  it("clean corpus deck: no warnings with the check registered alongside CHECKS", async () => {
    const res = await runChecks(await corpusDeck("clean"), {}, { checks: CHECKS });
    expect(res.errors).toEqual([]);
    expect(res.findings.filter((f) => f.severity === "warning")).toEqual([]);
    expect(res.findings.filter((f) => f.kind === "font-maybe-missing")).toEqual([]);
    expect(res.findings.filter((f) => f.kind === "font-availability-summary")).toHaveLength(1);
  });

  it("fonts-hidden corpus deck: flags MS Gothic (Windows only), keeps Calibri / Wingdings safe", async () => {
    const m = missing(await scan(await corpusDeck("fonts-hidden")));
    const names = m.map((f) => f.data.typeface);
    expect(names).toContain("MS Gothic");
    expect(names).not.toContain("Calibri");
    expect(names).not.toContain("Wingdings");
  });
});

// ---------------------------------------------------------------------------------------------
// U11: fonts the SlideCheck Helper reports as installed on this computer (`AuditOptions.localFonts`).

function missingHere(findings: Finding[]): FindingOf<"font-missing-here">[] {
  return findings.filter((f): f is FindingOf<"font-missing-here"> => f.kind === "font-missing-here");
}

/** A deck whose theme fonts are Aptos (headings) and Calibri (body); master bullets use Arial. */
function themedDeck(runs: { inner: string }[], extra: Partial<DeckSpec> = {}): Promise<Uint8Array> {
  return deck(runs, {
    masters: [{ theme: { majorLatin: "Aptos", minorLatin: "Calibri" }, layouts: [{ name: "Blank", type: "blank" }] }],
    ...extra,
  });
}

describe("font availability with the helper's local font list", () => {
  it("AE1: only the font the helper did not report is missing here", async () => {
    const bytes = await themedDeck([latin("Gotham"), latin("Aptos"), latin("Futura PT"), latin("Futura PT")]);
    const findings = await scan(bytes, { localFonts: ["Gotham", "Aptos", "Calibri", "Arial"] });
    const here = missingHere(findings);
    expect(here.map((f) => f.data.typeface)).toEqual(["Futura PT"]);
    const f = here[0];
    if (!f) throw new Error("no finding");
    expect(f.severity).toBe("warning");
    expect(f.area).toBe("fonts");
    expect(f.title).toBe("Font missing on this computer: Futura PT");
    expect(f.fixes).toEqual(["replace-font"]);
    expect(f.targets).toHaveLength(2);
    expect(f.data).toMatchObject({ typeface: "Futura PT", usageCount: 2, slideNumbers: [3, 4], cloud: false });
    // Same targets as the show-machine finding for the same family.
    const show = missing(findings).find((m) => m.data.typeface === "Futura PT");
    expect(show?.targets).toEqual(f.targets);
    expect(show?.fixes).toEqual(f.fixes);
    expect(() => structuredClone(findings)).not.toThrow();
  });

  it("a font used only for bullet/symbol glyphs that is missing here is info, like the show-machine finding", async () => {
    const paragraphs = para(run("Item", latin("Arial")), `<a:pPr><a:buFont typeface="Wingdings 2"/><a:buChar char="P"/></a:pPr>`);
    const bytes = await buildDeck({ slides: [{ layout: "Blank", shapes: sp({ id: 2, name: "TextBox 1", x: IN, y: IN, cx: IN, cy: IN, paragraphs }) }] });
    const findings = await scan(bytes, { localFonts: ["Arial"] });
    const w2 = missingHere(findings).find((f) => f.data.typeface === "Wingdings 2");
    expect(w2?.severity).toBe("info");
    expect(w2?.data.symbolOnly).toBe(true);
  });

  it("matches legacy / localized family names case-insensitively, trimming and collapsing whitespace", async () => {
    const bytes = await themedDeck([latin("Segoe UI Semibold"), latin("ＭＳ ゴシック"), latin("Gotham Book")]);
    const findings = await scan(bytes, {
      localFonts: ["segoe ui  SEMIBOLD", "ＭＳ ゴシック", "  gotham\tbook ", "Aptos", "Calibri", "Arial"],
    });
    expect(missingHere(findings)).toEqual([]);
  });

  it("theme font references resolve to the theme font", async () => {
    const bytes = await deck([latin("+mn-lt")], {
      masters: [{ theme: { majorLatin: "Aptos", minorLatin: "Brand Sans" }, layouts: [{ name: "Blank", type: "blank" }] }],
    });
    const here = missingHere(await scan(bytes, { localFonts: ["Aptos", "Arial"] }));
    expect(here.map((f) => f.data.typeface)).toEqual(["Brand Sans"]);
    expect(here[0]?.reachable).toBe(false);
  });

  it("embedded fonts (full or subset) are never missing here", async () => {
    const opts: AuditOptions = { localFonts: ["Aptos", "Calibri", "Arial"] };
    const full = await scan(await themedDeck([latin("Gotham")], { embeddedFonts: [{ typeface: "Gotham", styles: ["regular"] }] }), opts);
    expect(missingHere(full)).toEqual([]);
    const subset = await scan(
      await themedDeck([latin("Gotham")], { embeddedFonts: [{ typeface: "Gotham", styles: ["regular"] }], saveSubsetFonts: true }),
      opts,
    );
    expect(missingHere(subset)).toEqual([]);
  });

  it("a font that ships with Office but is not on the helper list is missing here", async () => {
    const findings = await scan(await themedDeck([latin("Verdana")]), { localFonts: ["Aptos", "Calibri", "Arial"] });
    const here = missingHere(findings);
    expect(here.map((f) => f.data.typeface)).toEqual(["Verdana"]);
    expect(here[0]?.data.cloud).toBe(false);
    // Still safe for the show machine (ships with Office), so no show-machine finding.
    expect(missing(findings)).toEqual([]);
  });

  it("an empty helper list means the helper is present and found nothing", async () => {
    const findings = await scan(await themedDeck([latin("Arial")]), { localFonts: [] });
    const names = missingHere(findings).map((f) => f.data.typeface).sort();
    expect(names).toEqual(["Aptos", "Arial", "Calibri"]);
    const s = summary(findings);
    expect(s.data.localListProvided).toBe(true);
    expect(s.data.missingHere).toBe(3);
  });

  it("Office cloud font not downloaded here: detail says so and data.cloud is set", async () => {
    const findings = await scan(await themedDeck([latin("Gotham")]), { localFonts: ["Calibri", "Arial", "Gotham"] });
    const aptos = missingHere(findings).find((f) => f.data.typeface === "Aptos");
    expect(aptos?.severity).toBe("warning");
    expect(aptos?.data.cloud).toBe(true);
    expect(aptos?.detail).toMatch(/Office cloud font/);
    expect(aptos?.detail).toMatch(/not downloaded on this computer/);
    expect(aptos?.detail).toMatch(/online/);
  });

  it("helper says present but show-machine list does not: show-machine finding drops to info", async () => {
    const findings = await scan(await themedDeck([latin("Gotham")]), {
      localFonts: ["Gotham", "Aptos", "Calibri", "Arial"],
      availableFonts: ["Brand Serif"],
    });
    expect(missingHere(findings)).toEqual([]);
    const g = missing(findings).find((f) => f.data.typeface === "Gotham");
    expect(g?.severity).toBe("info");
    expect(g?.data.missingHere).toBe(false);
    expect(findings.filter((f) => f.severity === "warning")).toEqual([]);
  });

  it("helper says missing: the warning is font-missing-here; the show-machine finding is info", async () => {
    const findings = await scan(await themedDeck([latin("Gotham")]), { localFonts: ["Aptos", "Calibri", "Arial"] });
    const warnings = findings.filter((f) => f.severity === "warning");
    expect(warnings.map((f) => f.kind)).toEqual(["font-missing-here"]);
    const g = missing(findings).find((f) => f.data.typeface === "Gotham");
    expect(g?.severity).toBe("info");
    expect(g?.data.missingHere).toBe(true);
  });

  it("without a helper list: no font-missing-here, missingHere is null, summary says no list", async () => {
    const findings = await scan(await themedDeck([latin("Gotham")]));
    expect(missingHere(findings)).toEqual([]);
    const g = missing(findings).find((f) => f.data.typeface === "Gotham");
    expect(g?.severity).toBe("warning");
    expect(g?.data.missingHere).toBeNull();
    const s = summary(findings);
    expect(s.data.localListProvided).toBe(false);
    expect(s.data.missingHere).toBe(0);
  });

  it("summary counts fonts missing here and marks each font entry", async () => {
    const findings = await scan(await themedDeck([latin("Gotham"), latin("Futura PT")]), { localFonts: ["Gotham", "Aptos", "Calibri", "Arial"] });
    const s = summary(findings);
    expect(s.data.localListProvided).toBe(true);
    expect(s.data.missingHere).toBe(1);
    expect(s.data.fonts.find((x) => x.typeface === "Futura PT")?.missingHere).toBe(true);
    expect(s.data.fonts.find((x) => x.typeface === "Gotham")?.missingHere).toBe(false);
    expect(s.detail).toMatch(/1 missing on this computer/);
  });

  it("clean corpus deck with every font it uses installed here: no warnings", async () => {
    const bytes = await corpusDeck("clean");
    const used = summary(await scan(bytes)).data.fonts.map((f) => f.typeface);
    expect(used.length).toBeGreaterThan(0);
    const res = await runChecks(bytes, { localFonts: used }, { checks: CHECKS });
    expect(res.errors).toEqual([]);
    expect(res.findings.filter((f) => f.severity === "warning")).toEqual([]);
    expect(res.findings.filter((f) => f.kind === "font-missing-here")).toEqual([]);
  });

  it("localFonts is part of the runner cache key ([] differs from absent)", async () => {
    const bytes = await themedDeck([latin("Gotham")]);
    const run = { checks: fontAvailabilityChecks, cache: createAuditCache() };
    const a = await runChecksCached(bytes, "u11", { localFonts: ["Gotham", "Aptos", "Calibri", "Arial"] }, run);
    const b = await runChecksCached(bytes, "u11", { localFonts: ["Aptos", "Calibri", "Arial"] }, run);
    const c = await runChecksCached(bytes, "u11", { localFonts: [] }, run);
    const d = await runChecksCached(bytes, "u11", {}, run);
    const e = await runChecksCached(bytes, "u11", { localFonts: ["Aptos", "Calibri", "Arial"] }, run);
    expect([a, b, c, d].map((r) => r.fromCache === true)).toEqual([false, false, false, false]);
    expect(e.fromCache).toBe(true);
    expect(a.findings.some((f) => f.kind === "font-missing-here")).toBe(false);
    expect(b.findings.some((f) => f.kind === "font-missing-here")).toBe(true);
    expect(d.findings.some((f) => f.kind === "font-missing-here")).toBe(false);
  });
});
