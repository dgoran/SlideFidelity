import { describe, expect, it } from "vitest";
import { fontAvailabilityChecks } from "../../src/checks/fontAvailability";
import { CHECKS, loadPresentation, runChecks, type AuditOptions, type Finding, type FindingOf } from "../../src/index";
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
    const res = await runChecks(await corpusDeck("clean"), {}, { checks: [...CHECKS, ...fontAvailabilityChecks] });
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
