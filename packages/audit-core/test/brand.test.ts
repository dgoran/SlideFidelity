import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR_TOLERANCE,
  defaultBrandFromTheme,
  matchBrandColor,
  normalizeHex,
  parseBrandJson,
  serializeBrand,
  themeForMaster,
  type BrandProfile,
} from "../src/brand";
import { loadPresentation } from "../src/package/model";
import type { BrandProfile as RunnerBrandProfile } from "../src/runner";
import { corpusDeck } from "./helpers/corpus";
import { twoMastersDeck } from "./checks/colors.fixtures";

describe("normalizeHex", () => {
  it("accepts #RRGGBB, RRGGBB, #RGB and mixed case", () => {
    expect(normalizeHex("#4472c4")).toBe("4472C4");
    expect(normalizeHex("4472C4")).toBe("4472C4");
    expect(normalizeHex("  #fa0 ")).toBe("FFAA00");
  });
  it("rejects anything else", () => {
    for (const bad of ["", "#", "12345", "1234567", "GGGGGG", "#12 456", "rgb(1,2,3)"]) {
      expect(normalizeHex(bad)).toBeUndefined();
    }
  });
});

describe("defaultBrandFromTheme", () => {
  it("derives the 12 theme colors and the theme fonts of the first master", async () => {
    const pres = await loadPresentation(await corpusDeck("clean"));
    const brand = defaultBrandFromTheme(pres);
    expect(brand.colors).toHaveLength(12);
    expect(brand.colors).toContain("4472C4");
    expect(brand.colors.every((c) => /^[0-9A-F]{6}$/.test(c))).toBe(true);
    expect(brand.fonts).toEqual(["Calibri Light", "Calibri"]);
    expect(brand.tolerance).toBe(DEFAULT_COLOR_TOLERANCE);
    // Structurally compatible with the runner's placeholder type.
    const asRunner: RunnerBrandProfile = brand;
    expect(asRunner.colors).toBe(brand.colors);
  });

  it("uses the theme of the given master", async () => {
    const pres = await loadPresentation(await twoMastersDeck());
    const second = pres.masters[1]?.partName ?? "";
    expect(themeForMaster(pres, second)?.name).toBe("Purple Theme");
    expect(defaultBrandFromTheme(pres, second).colors).toContain("7030A0");
    expect(defaultBrandFromTheme(pres).colors).not.toContain("7030A0");
  });
});

describe("brand JSON", () => {
  const brand: BrandProfile = { name: "Acme", fonts: ["Georgia", "Segoe UI"], colors: ["4472C4", "FF0000"], tolerance: 3 };

  it("round-trips", () => {
    const json = serializeBrand(brand);
    expect(JSON.parse(json)).toMatchObject({ version: 1, colors: ["#4472C4", "#FF0000"] });
    const back = parseBrandJson(json);
    expect(back).toEqual({ ok: true, brand });
  });

  it("round-trips the theme-derived default", async () => {
    const pres = await loadPresentation(await corpusDeck("clean"));
    const d = defaultBrandFromTheme(pres);
    expect(parseBrandJson(serializeBrand(d))).toEqual({ ok: true, brand: d });
  });

  it("normalizes colors, dedupes, and defaults missing fields", () => {
    const r = parseBrandJson({ colors: ["#ff0000", "FF0000", "#0f0"] });
    expect(r).toEqual({ ok: true, brand: { fonts: [], colors: ["FF0000", "00FF00"], tolerance: DEFAULT_COLOR_TOLERANCE } });
  });

  it("rejects an invalid hex with a field-level error", () => {
    const r = parseBrandJson(JSON.stringify({ fonts: ["Arial"], colors: ["#4472C4", "#12ZZ56"], tolerance: 2 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ field: "colors[1]", message: expect.stringContaining("#12ZZ56") }]);
  });

  it("reports every bad field", () => {
    const r = parseBrandJson({ fonts: ["Arial", 42, ""], colors: "red", tolerance: -1, name: 7, version: 9 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(["colors", "fonts[1]", "fonts[2]", "name", "tolerance", "version"]);
  });

  it("rejects malformed JSON and non-objects", () => {
    const bad = parseBrandJson("{not json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.field).toBe("");
    const arr = parseBrandJson("[]");
    expect(arr.ok).toBe(false);
  });

  it("caps list sizes from untrusted input", () => {
    const r = parseBrandJson({ colors: Array.from({ length: 1000 }, () => "#000000") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("colors");
  });
});

describe("matchBrandColor", () => {
  const brand: BrandProfile = { fonts: [], colors: ["FF0000", "0000FF"], tolerance: 2 };
  it("matches exactly and within tolerance", () => {
    expect(matchBrandColor("FF0000", brand)).toMatchObject({ inBrand: true, nearest: { hex: "FF0000", distance: 0 } });
    expect(matchBrandColor("FE0101", brand).inBrand).toBe(true);
  });
  it("rejects colors outside tolerance and reports the nearest", () => {
    const m = matchBrandColor("00FF00", brand);
    expect(m.inBrand).toBe(false);
    expect(m.nearest?.distance).toBeGreaterThan(2);
  });
  it("treats an empty palette as nothing allowed", () => {
    expect(matchBrandColor("FF0000", { fonts: [], colors: [], tolerance: 2 })).toEqual({ inBrand: false });
  });
});
