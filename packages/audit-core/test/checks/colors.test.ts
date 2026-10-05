import { describe, expect, it } from "vitest";
import {
  colorChecks,
  type ColorMatchesThemeData,
  type ColorUsageData,
  type RecentColorsData,
  type ThemeColorsData,
} from "../../src/checks/colors";
import { ciede2000, colorDistance, hexToLab, hslToHex, presetHex, scrgbToHex } from "../../src/color";
import type { Finding, FindingOf, FindingTarget } from "../../src/findings";
import { runChecks, type AuditOptions } from "../../src/runner";
import { corpusDeck, SEEDS } from "../helpers/corpus";
import {
  backgroundDeck,
  chartSmartArtDeck,
  propertiesDeck,
  sysPresetDeck,
  tableGroupDeck,
  twoMastersDeck,
} from "./colors.fixtures";

async function scan(bytes: Uint8Array, options: AuditOptions = {}): Promise<Finding[]> {
  const res = await runChecks(bytes, options, { checks: colorChecks });
  expect(res.errors).toEqual([]);
  return res.findings;
}

function usages(fs: Finding[]): FindingOf<"color-usage">[] {
  return fs.filter((f): f is FindingOf<"color-usage"> => f.kind === "color-usage");
}
function usage(fs: Finding[], group: string): FindingOf<"color-usage"> {
  const f = usages(fs).find((u) => u.group === group);
  if (!f) throw new Error(`no color-usage for ${group}; have ${usages(fs).map((u) => u.group).join(",")}`);
  return f;
}
function matches(fs: Finding[]): FindingOf<"color-matches-theme">[] {
  return fs.filter((f): f is FindingOf<"color-matches-theme"> => f.kind === "color-matches-theme");
}
const brief = (t: FindingTarget): string =>
  [
    t.container.kind,
    t.shapeId ?? "-",
    t.locator?.property ?? "",
    t.locator?.cell ? `c${t.locator.cell.row}.${t.locator.cell.col}` : "",
    t.locator?.paragraphIndex ?? "",
    t.locator?.runIndex ?? "",
    t.reachable ? "R" : "U",
  ].join(":");

// ---------------------------------------------------------------------------------------------
// Color math

describe("color math", () => {
  // Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula", Table 1.
  const SHARMA: [number[], number[], number][] = [
    [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
    [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
    [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
    [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
    [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
    [[50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977],
    [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
    [[50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  it.each(SHARMA)("CIEDE2000 %j vs %j = %f", (a, b, want) => {
    const lab = (v: number[]) => ({ L: v[0] ?? 0, a: v[1] ?? 0, b: v[2] ?? 0 });
    expect(ciede2000(lab(a), lab(b))).toBeCloseTo(want, 4);
    expect(ciede2000(lab(b), lab(a))).toBeCloseTo(want, 4);
  });

  it("converts sRGB to Lab (D65)", () => {
    const red = hexToLab("FF0000");
    expect(red.L).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 1);
    expect(red.b).toBeCloseTo(67.2, 1);
    const white = hexToLab("FFFFFF");
    expect(white.L).toBeCloseTo(100, 2);
    expect(Math.abs(white.a)).toBeLessThan(0.01);
    expect(colorDistance("4472C4", "4472C4")).toBe(0);
    expect(colorDistance("FF0000", "FE0101")).toBeLessThan(1);
  });

  it("resolves presets, HSL, and scRGB", () => {
    expect(presetHex("red")).toBe("FF0000");
    expect(presetHex("dkBlue")).toBe("00008B");
    expect(presetHex("nope")).toBeUndefined();
    expect(hslToHex(0, 100000, 50000)).toBe("FF0000");
    expect(hslToHex(120 * 60000, 100000, 25000)).toBe("008000");
    expect(scrgbToHex(0, 100000, 0)).toBe("00FF00");
    expect(scrgbToHex(21586, 21586, 21586)).toBe("808080");
  });
});

// ---------------------------------------------------------------------------------------------
// colors-literal corpus deck

describe("colors-literal corpus", () => {
  const seeds = SEEDS["colors-literal"];

  it("lists the seeded literal colors with correct counts per master", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const got: Record<string, Record<string, number>> = {};
    for (const u of usages(fs)) {
      for (const m of u.data.byMaster) (got[m.masterPart] ??= {})[u.group] = m.count;
      expect(u.count).toBe(u.data.byMaster.reduce((n, m) => n + m.count, 0));
      expect(u.area).toBe("colors");
    }
    expect(got).toEqual(seeds.literalByMaster);
  });

  it("flags a literal equal to accent1 as matching the theme, with no fix", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const m = matches(fs);
    expect(m).toHaveLength(1);
    const f = m[0] as FindingOf<"color-matches-theme">;
    expect(f.severity).toBe("info");
    expect(f.group).toBe(seeds.autoMatchable.hex);
    expect(f.data).toMatchObject({ hex: "4472C4", slot: "accent1", masterPart: "ppt/slideMasters/slideMaster1.xml" } satisfies Partial<ColorMatchesThemeData>);
    expect(f.title).toContain("accent1");
    expect(f.fixes).toEqual([]);
    expect(f.reachable).toBeUndefined();
    expect(f.targets.map(brief)).toEqual(["slide:2:fill::::R"]);
    // The usage itself is in the (theme-derived) brand, so it is info with a replace fix.
    const u = usage(fs, "4472C4");
    expect(u.severity).toBe("info");
    expect(u.fixes).toEqual(["replace-color"]);
    expect(u.data.byMaster[0]?.nearestTheme).toEqual({ slot: "accent1", hex: "4472C4", distance: 0 });
  });

  it("warns on literals outside the theme palette and targets exact properties", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const red = usage(fs, "FF0000");
    expect(red.severity).toBe("warning");
    expect(red.count).toBe(2);
    expect(red.reachable).toBe(true);
    expect(red.fixes).toEqual(["replace-color"]);
    expect(red.targets.map(brief).sort()).toEqual(["slide:3:text::0:0:R", "slide:4:line::::R"]);
    expect(red.data.contexts).toEqual(["line", "text"]);
    expect(red.data.inBrand).toBe(false);
    expect(red.data.brandSource).toBe("theme");
    expect(usage(fs, "7030A0").severity).toBe("warning");
  });

  it("counts schemeClr with lumMod/lumOff as theme, never as a literal target", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const { slide, shapeId } = seeds.themeWithModifiers;
    for (const u of usages(fs)) {
      for (const t of u.targets) {
        expect(t.container.slideNumber === slide && t.shapeId === shapeId).toBe(false);
      }
    }
  });

  it("lists a gradient stop literal as unreachable", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const g = usage(fs, seeds.gradientLiteral.hex);
    expect(g.reachable).toBe(seeds.gradientLiteral.reachable);
    expect(g.fixes).toEqual(["replace-color"]);
    expect(g.targets.map(brief)).toEqual(["slide:3:fill::::U"]);
    expect(g.data.contexts).toEqual(["gradient"]);
    expect(g.data.reachableCount).toBe(0);
  });

  it("lists recent colors as info", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const r = fs.filter((f): f is FindingOf<"recent-colors"> => f.kind === "recent-colors");
    expect(r).toHaveLength(1);
    expect(r[0]?.severity).toBe("info");
    expect(r[0]?.count).toBe(3);
    expect((r[0]?.data as RecentColorsData).colors.map((c) => c.hex)).toEqual([...seeds.recentColors]);
  });

  it("lists the theme palette per master", async () => {
    const fs = await scan(await corpusDeck("colors-literal"));
    const t = fs.filter((f): f is FindingOf<"theme-colors"> => f.kind === "theme-colors");
    expect(t.map((f) => f.data.masterPart)).toEqual(["ppt/slideMasters/slideMaster1.xml", "ppt/slideMasters/slideMaster2.xml"]);
    const d = t[1]?.data as ThemeColorsData;
    expect(d.themeName).toBe("Second Theme");
    expect(d.colors).toHaveLength(12);
    expect(d.colors[4]).toEqual({ slot: "accent1", hex: "4472C4", kind: "srgb" });
    expect(t.every((f) => f.severity === "info" && f.fixes.length === 0)).toBe(true);
  });

  it("is deterministic and structured-clone safe", async () => {
    const a = await scan(await corpusDeck("colors-literal"));
    const b = await scan(await corpusDeck("colors-literal"));
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    expect(structuredClone(a)).toEqual(a);
    expect(a.every((f) => f.severity !== "error")).toBe(true);
  });

  it("the clean deck has no literal colors", async () => {
    const fs = await scan(await corpusDeck("clean"));
    expect(usages(fs)).toEqual([]);
    expect(matches(fs)).toEqual([]);
    expect(fs.filter((f) => f.kind === "theme-colors")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Property targeting

describe("property targets", () => {
  it("targets fill, line, and each text run; pattern, effect, modified, and bullet are unreachable", async () => {
    const fs = await scan(await propertiesDeck());
    expect(usages(fs).map((u) => u.group)).toEqual(["FF0000"]);
    const red = usage(fs, "FF0000");
    expect(red.count).toBe(8);
    expect(red.targets.map(brief).sort()).toEqual(
      [
        "slide:2:fill::::R",
        "slide:2:line::::R",
        "slide:2:text::0:1:R",
        "slide:2:text::1:0:R",
        "slide:3:fill::::U",
        "slide:4:effect::::U",
        "slide:5:fill::::U",
        "slide:6:bullet::0::U",
      ].sort(),
    );
    expect(red.data.contexts).toEqual(["bullet", "effect", "fill", "line", "pattern", "text"]);
    expect(red.data.reachableCount).toBe(4);
    expect(red.reachable).toBe(true);
  });

  it("targets table cell fills and runs in cells; borders unreachable; group children reachable", async () => {
    const fs = await scan(await tableGroupDeck());
    const u = usage(fs, "00B0F0");
    expect(u.count).toBe(4);
    expect(u.targets.map(brief).sort()).toEqual(
      ["slide:2:table-cell:c0.1:::R", "slide:2:line:c1.0:::U", "slide:2:text:c1.1:0:1:R", "slide:4:fill::::R"].sort(),
    );
    const grouped = u.targets.find((t) => t.shapeId === 4);
    expect(grouped?.path).toEqual([3]);
    expect(u.data.contexts).toEqual(["fill", "table-border", "table-cell", "text"]);
  });

  it("lists chart and SmartArt literals unreachable without double-counting the drawing cache", async () => {
    const fs = await scan(await chartSmartArtDeck());
    const u = usage(fs, "C00000");
    expect(u.count).toBe(2);
    expect(u.reachable).toBe(false);
    expect(u.targets.map((t) => `${t.container.kind}:${t.container.partName}:${t.container.slideNumber}:${String(t.reachable)}`).sort()).toEqual([
      "chart:ppt/charts/chart1.xml:1:false",
      "diagram:ppt/diagrams/data1.xml:1:false",
    ]);
    expect(u.data.contexts).toEqual(["chart", "smartart"]);
    expect(u.data.byMaster[0]?.masterPart).toBe("ppt/slideMasters/slideMaster1.xml");
  });

  it("treats sysClr, prstClr, hslClr and scrgbClr as literal", async () => {
    const fs = await scan(await sysPresetDeck());
    expect(usages(fs).map((u) => u.group).sort()).toEqual(["000000", "00FF00", "FF0000", "notARealPreset"]);
    const black = usage(fs, "000000");
    expect(black.data).toMatchObject({ hex: "000000", kinds: ["sys"], names: ["windowText"] });
    expect(matches(fs).map((m) => `${m.group}:${m.data.slot}`)).toEqual(["000000:dk1"]);
    const red = usage(fs, "FF0000");
    expect(red.count).toBe(2);
    expect(red.data.kinds).toEqual(["hsl", "preset"]);
    expect(red.data.names).toEqual(["red"]);
    const odd = usage(fs, "notARealPreset");
    expect(odd.data.hex).toBeUndefined();
    expect(odd.severity).toBe("info");
    expect(odd.fixes).toEqual([]);
    expect(odd.reachable).toBeUndefined();
    expect(odd.targets.every((t) => t.reachable === false)).toBe(true);
  });

  it("lists a literal slide background as unreachable", async () => {
    const fs = await scan(await backgroundDeck());
    const bg = usage(fs, "FFFF00");
    expect(bg.targets).toHaveLength(1);
    expect(bg.targets[0]).toMatchObject({ container: { kind: "slide", slideNumber: 1 }, locator: { property: "fill" }, reachable: false });
    expect(bg.targets[0]?.shapeId).toBeUndefined();
    expect(bg.data.contexts).toEqual(["background"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Masters and brand

describe("per-master grouping and brand", () => {
  it("groups usage by master and judges each against that master's theme", async () => {
    const fs = await scan(await twoMastersDeck());
    const purple = usage(fs, "7030A0");
    const byMaster = Object.fromEntries(purple.data.byMaster.map((m) => [m.masterPart, m]));
    expect(byMaster["ppt/slideMasters/slideMaster1.xml"]).toMatchObject({ count: 1, inBrand: false });
    expect(byMaster["ppt/slideMasters/slideMaster2.xml"]).toMatchObject({
      count: 1,
      inBrand: true,
      themeName: "Purple Theme",
      nearestTheme: { slot: "accent1", hex: "7030A0", distance: 0 },
    });
    expect(purple.severity).toBe("warning");
    expect(matches(fs).map((m) => `${m.group}:${m.data.masterPart}`)).toEqual(["7030A0:ppt/slideMasters/slideMaster2.xml"]);
    // No clrMru entries → no recent-colors finding.
    expect(fs.some((f) => f.kind === "recent-colors")).toBe(false);
  });

  it("lists layout, master, and master text-style literals as unreachable", async () => {
    const fs = await scan(await twoMastersDeck());
    const u = usage(fs, "ABCDEF");
    expect(u.count).toBe(3);
    expect(u.reachable).toBe(false);
    expect(u.targets.map((t) => `${t.container.kind}:${t.locator?.property ?? ""}:${String(t.reachable)}`).sort()).toEqual([
      "layout:fill:false",
      "master:fill:false",
      "master:list-style:false",
    ]);
    expect(u.data.byMaster.map((m) => m.masterPart)).toEqual(["ppt/slideMasters/slideMaster1.xml"]);
  });

  it("uses options.brand when given", async () => {
    const fs = await scan(await twoMastersDeck(), { brand: { fonts: [], colors: ["7030A0"], tolerance: 2 } });
    const purple = usage(fs, "7030A0");
    expect(purple.severity).toBe("info");
    expect(purple.data).toMatchObject({ brandSource: "profile", inBrand: true, nearestBrand: { hex: "7030A0", distance: 0 } });
    expect(usage(fs, "ABCDEF").severity).toBe("warning");
  });

  it("accepts near colors within the brand tolerance", async () => {
    const bytes = await backgroundDeck();
    const within = usage(await scan(bytes, { brand: { fonts: [], colors: ["FF0000", "FFFF00"], tolerance: 2 } }), "FE0101");
    expect(within.severity).toBe("info");
    expect(within.data.nearestBrand?.hex).toBe("FF0000");
    const strict = usage(await scan(bytes, { brand: { fonts: [], colors: ["FF0000"], tolerance: 0 } }), "FE0101");
    expect(strict.severity).toBe("warning");
    expect((strict.data as ColorUsageData).inBrand).toBe(false);
  });
});
