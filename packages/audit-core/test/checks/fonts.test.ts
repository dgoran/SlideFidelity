import { describe, expect, it } from "vitest";
import { fontChecks, type FontUsageData } from "../../src/checks/fonts";
import { loadPresentation, type AuditOptions, type Finding, type FindingOf, type FindingTarget } from "../../src/index";
import { corpusDeck, SEEDS } from "../helpers/corpus";
import { arialDeck, eaOnlyDeck, fullEmbedDeck, mixedDeck, tableDeck, themeRefDeck } from "./fonts.fixtures";

async function scan(bytes: Uint8Array, options: AuditOptions = {}): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of fontChecks) out.push(...(await c.run({ pres, options })));
  return out;
}

function usages(findings: Finding[]): FindingOf<"font-usage">[] {
  return findings.filter((f): f is FindingOf<"font-usage"> => f.kind === "font-usage");
}

function font(findings: Finding[], name: string): FindingOf<"font-usage"> {
  const f = usages(findings).find((u) => u.group.toLowerCase() === name.toLowerCase());
  if (!f) throw new Error(`font ${name} not found; have ${usages(findings).map((u) => u.group).join(", ")}`);
  return f;
}

/** Targets of a finding paired with their usage info. */
function pairs(f: FindingOf<"font-usage">): { t: FindingTarget; u: FontUsageData["usages"][number] }[] {
  return f.targets.map((t, i) => {
    const u = f.data.usages[i];
    if (!u) throw new Error("usages not aligned with targets");
    return { t, u };
  });
}

function onShape(f: FindingOf<"font-usage">, slideNumber: number, shapeId: number) {
  return pairs(f).filter((p) => p.t.container.kind === "slide" && p.t.container.slideNumber === slideNumber && p.t.shapeId === shapeId);
}

describe("font checks", () => {
  it("exports the fonts-area checks", () => {
    expect(fontChecks.length).toBeGreaterThan(0);
    for (const c of fontChecks) expect(c.area).toBe("fonts");
  });

  it("AE1: the seeded text box reports Calibri (latin, direct), MS Gothic (ea, direct), Wingdings (bu, hidden-list-style)", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].ae1;
    const got = seed.fonts.map((sf) => {
      const hits = onShape(font(findings, sf.typeface), seed.slide, seed.shapeId);
      return hits.map((h) => ({ typeface: sf.typeface, script: h.u.script, source: h.u.source }));
    });
    expect(got).toEqual([
      [{ typeface: "Calibri", script: "latin", source: "direct" }],
      [{ typeface: "MS Gothic", script: "ea", source: "direct" }],
      [{ typeface: "Wingdings", script: "bu", source: "hidden-list-style" }],
    ]);
    const calibri = onShape(font(findings, "Calibri"), 1, 4)[0];
    expect(calibri?.t.reachable).toBe(true);
    expect(calibri?.t.locator).toEqual({ property: "text", paragraphIndex: 0, runIndex: 0, script: "latin" });
    const gothic = onShape(font(findings, "MS Gothic"), 1, 4)[0];
    expect(gothic?.t.reachable).toBe(false);
    expect(gothic?.t.locator?.script).toBe("ea");
    const wing = onShape(font(findings, "Wingdings"), 1, 4)[0];
    expect(wing?.t.reachable).toBe(false);
    expect(wing?.t.locator).toEqual({ property: "list-style", level: 1, script: "bu" });
    expect(font(findings, "Wingdings").reachable).toBe(false);
  });

  it("resolves +mn-lt to the theme minor font and labels it as theme usage (never a fix target)", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].themeReference;
    const hits = onShape(font(findings, seed.resolvesTo), seed.slide, seed.shapeId);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.u).toMatchObject({ script: "latin", source: "direct", theme: "minor", ref: "+mn-lt" });
    expect(hits[0]?.t.reachable).toBe(false);
    expect(font(findings, seed.resolvesTo).groupLabel).toBe("Calibri (theme body)");
  });

  it("resolves theme references against the deck's own theme", async () => {
    const findings = await scan(await themeRefDeck());
    const aptos = font(findings, "Aptos");
    expect(onShape(aptos, 1, 2)[0]?.u).toMatchObject({ theme: "minor", ref: "+mn-lt" });
    expect(usages(findings).some((f) => f.group === "+mn-lt")).toBe(false);
    expect(font(findings, "Aptos Display").groupLabel).toBe("Aptos Display (theme headings)");
  });

  it("lists a chart-only font with source chart and reachable=false", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].chartOnlyFont;
    const f = font(findings, seed.typeface);
    expect(f.reachable).toBe(false);
    expect(f.fixes).toEqual(["replace-font"]);
    expect(f.data.usages.map((u) => u.source)).toEqual(["chart"]);
    expect(f.targets[0]?.container).toMatchObject({ kind: "chart", partName: seed.part, slideNumber: 2 });
    expect(f.targets[0]?.locator?.relId).toBe("rIdChart");
  });

  it("lists SmartArt fonts from the diagram data and drawing parts as unreachable", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].smartArtFont;
    const f = font(findings, seed.typeface);
    expect(f.reachable).toBe(false);
    expect(new Set(f.data.usages.map((u) => u.source))).toEqual(new Set(["smartart"]));
    expect(f.targets.map((t) => t.container.partName).sort()).toEqual([...seed.parts].sort());
  });

  it("reports lstStyle defaults on a shape with no text", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].emptyShapeListStyleFont;
    const hits = onShape(font(findings, seed.typeface), seed.slide, seed.shapeId);
    expect(hits.map((h) => h.u)).toEqual([{ script: "latin", source: "hidden-list-style" }]);
    expect(hits[0]?.t.reachable).toBe(false);
  });

  it("emits a hidden-list-style warning per shape whose lstStyle names fonts not otherwise visible", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const hidden = findings.filter((f): f is FindingOf<"hidden-list-style"> => f.kind === "hidden-list-style");
    expect(hidden.map((h) => [h.targets[0]?.shapeId, h.data.fonts])).toEqual([
      [4, ["Wingdings"]],
      [6, ["Consolas"]],
    ]);
    for (const h of hidden) {
      expect(h.severity).toBe("warning");
      expect(h.reachable).toBe(false);
      expect(h.fixes).toEqual([]);
      expect(h.area).toBe("fonts");
    }
  });

  it("reports master text-style fonts with source master, unreachable", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const seed = SEEDS["fonts-hidden"].masterTextStyleFont;
    const f = font(findings, seed.typeface);
    expect(f.reachable).toBe(false);
    expect(pairs(f).map((p) => [p.u.source, p.t.container.kind, p.t.container.partName, p.t.locator?.level])).toEqual([
      ["master", "master", seed.master, 2],
    ]);
  });

  it("reports an ea-only font as unreachable with its script label", async () => {
    const findings = await scan(await eaOnlyDeck());
    const f = font(findings, "SimSun");
    expect(f.reachable).toBe(false);
    expect(f.fixes).toEqual(["replace-font"]);
    expect(f.targets).toHaveLength(1);
    expect(f.targets[0]).toMatchObject({ shapeId: 2, reachable: false, locator: { script: "ea" } });
  });

  it("reports table-cell fonts as reachable with a cell locator", async () => {
    const findings = await scan(await tableDeck());
    const f = font(findings, "Verdana");
    expect(f.reachable).toBe(true);
    expect(f.targets).toEqual([
      expect.objectContaining({
        shapeId: 2,
        reachable: true,
        locator: { property: "table-cell", cell: { row: 1, col: 1 }, paragraphIndex: 0, runIndex: 0, script: "latin" },
      }),
    ]);
  });

  it("covers run, symbol, bullet, and end-of-paragraph fonts with precise locators", async () => {
    const findings = await scan(await mixedDeck());
    const arial = font(findings, "Arial");
    expect(onShape(arial, 1, 7).map((p) => p.t.locator)).toEqual([
      { property: "text", paragraphIndex: 0, runIndex: 0, script: "latin" },
      { property: "text", paragraphIndex: 1, runIndex: 0, script: "latin" },
    ]);
    const symbol = font(findings, "Symbol");
    expect(symbol.reachable).toBe(false);
    expect(symbol.targets[0]?.locator).toEqual({ property: "text", paragraphIndex: 0, runIndex: 2, script: "sym" });
    const courier = onShape(font(findings, "Courier New"), 1, 7);
    expect(courier.map((p) => [p.u.source, p.t.locator, p.t.reachable])).toEqual([
      ["direct", { property: "bullet", paragraphIndex: 1, script: "bu" }, false],
    ]);
    const tahoma = font(findings, "Tahoma");
    expect(tahoma.reachable).toBe(true);
    expect(tahoma.targets[0]?.locator).toEqual({ property: "text", paragraphIndex: 2, script: "latin" });
  });

  it("AE2 data: Arial in 40 text boxes and 1 chart gives 40 reachable and 1 unreachable target", async () => {
    const findings = await scan(await arialDeck(40));
    const f = font(findings, "Arial");
    const slideTargets = f.targets.filter((t) => t.container.kind === "slide");
    expect(slideTargets).toHaveLength(40);
    expect(slideTargets.every((t) => t.reachable === true)).toBe(true);
    const charts = f.targets.filter((t) => t.container.kind === "chart");
    expect(charts).toHaveLength(1);
    expect(charts[0]?.reachable).toBe(false);
    expect(f.reachable).toBe(true);
    expect(f.data.reachableCount).toBe(40);
  });

  it("a brand profile allowing only Calibri warns for every other text font", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"), { brand: { fonts: ["calibri"], colors: [], tolerance: 0 } });
    const fonts = usages(findings);
    for (const f of fonts) {
      const bulletOnly = f.data.usages.every((u) => u.script === "bu" || u.script === "sym");
      const expected = f.group === "Calibri" || bulletOnly ? "info" : "warning";
      expect([f.group, f.severity]).toEqual([f.group, expected]);
      expect(f.data.inBrand).toBe(f.group === "Calibri" ? true : bulletOnly ? null : false);
    }
    expect(fonts.filter((f) => f.severity === "warning").map((f) => f.group)).toEqual(
      expect.arrayContaining(["MS Gothic", "Arial Narrow", "Segoe UI", "Georgia", "Consolas", "Calibri Light"]),
    );
  });

  it("the default profile (theme fonts) produces no warnings on the clean deck", async () => {
    const findings = await scan(await corpusDeck("clean"));
    expect(usages(findings).length).toBeGreaterThan(0);
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(usages(findings).map((f) => f.group)).toEqual(expect.arrayContaining([SEEDS.clean.majorFont, SEEDS.clean.minorFont]));
  });

  it("the default profile warns for non-theme text fonts", async () => {
    const findings = await scan(await eaOnlyDeck());
    expect(font(findings, "SimSun").severity).toBe("warning");
  });

  it("reports embedding status: subset, full, and none", async () => {
    const status = async (bytes: Uint8Array) => {
      const f = (await scan(bytes)).find((x): x is FindingOf<"font-embedding"> => x.kind === "font-embedding");
      expect(f?.severity).toBe("info");
      return f;
    };
    const subset = await status(await corpusDeck("fonts-hidden"));
    expect(subset?.title).toBe("Embedded subset");
    expect(subset?.data.status).toBe("subset");
    expect(subset?.data.fonts).toEqual([{ typeface: "Calibri", styles: ["regular", "bold"] }]);
    expect((await status(await fullEmbedDeck()))?.title).toBe("Fully embedded");
    const none = await status(await corpusDeck("clean"));
    expect(none?.title).toBe("Not embedded");
    expect(none?.data.fonts).toEqual([]);
    // Per-font embedding on the usage finding.
    expect(font(await scan(await corpusDeck("fonts-hidden")), "Calibri").data.embedding).toBe("subset");
    expect(font(await scan(await corpusDeck("fonts-hidden")), "Georgia").data.embedding).toBe("none");
  });

  it("finds every seeded font on fonts-hidden", async () => {
    const findings = await scan(await corpusDeck("fonts-hidden"));
    const names = usages(findings).map((f) => f.group);
    for (const n of ["Calibri", "MS Gothic", "Wingdings", "Consolas", "Arial Narrow", "Segoe UI", "Georgia", "Calibri Light"]) {
      expect(names).toContain(n);
    }
  });

  it("is deterministic and sorted by font name; findings survive structuredClone", async () => {
    const bytes = await corpusDeck("fonts-hidden");
    const a = await scan(bytes);
    const b = await scan(bytes);
    expect(b).toEqual(a);
    const names = usages(a).map((f) => f.group);
    expect(names).toEqual([...names].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0)));
    expect(structuredClone(a)).toEqual(a);
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    for (const f of usages(a)) {
      expect(f.count).toBe(f.targets.length);
      expect(f.data.usages).toHaveLength(f.targets.length);
    }
  });
});
