import { describe, expect, it } from "vitest";
import { createBrandStore, type StorageLike } from "../brand/brandStore";
import { composeAuditOptions, createShowFontsStore, normalizeFontList, parseFontListFile, SHOW_FONTS_STORAGE_KEY } from "./showFontsStore";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("show-machine fonts store", () => {
  it("starts empty and gives no scan options", () => {
    const store = createShowFontsStore({ storage: memoryStorage() });
    expect(store.get()).toEqual([]);
    expect(store.auditOptions()).toEqual({});
    expect(store.persistent).toBe(true);
  });

  it("persists under slidecheck:showFonts and reloads", () => {
    const storage = memoryStorage();
    const a = createShowFontsStore({ storage });
    a.set(["Helvetica Neue", "Gotham"]);
    expect(SHOW_FONTS_STORAGE_KEY).toBe("slidecheck:showFonts");
    expect(JSON.parse(storage.data.get("slidecheck:showFonts")!)).toEqual(["Helvetica Neue", "Gotham"]);
    const b = createShowFontsStore({ storage });
    expect(b.get()).toEqual(["Helvetica Neue", "Gotham"]);
    expect(b.auditOptions()).toEqual({ availableFonts: ["Helvetica Neue", "Gotham"] });
    b.set([]);
    expect(storage.data.has("slidecheck:showFonts")).toBe(false);
  });

  it("normalizes: trims, drops blanks and case-insensitive duplicates, caps the length", () => {
    const store = createShowFontsStore({ storage: memoryStorage() });
    store.set(["  Gotham ", "", "gotham", "Avenir", "x".repeat(200)]);
    expect(store.get()).toEqual(["Gotham", "Avenir"]);
  });

  it("drops a corrupt stored value", () => {
    const storage = memoryStorage();
    storage.data.set(SHOW_FONTS_STORAGE_KEY, "{not json");
    expect(createShowFontsStore({ storage }).get()).toEqual([]);
    expect(storage.data.has(SHOW_FONTS_STORAGE_KEY)).toBe(false);
    storage.data.set(SHOW_FONTS_STORAGE_KEY, JSON.stringify({ evil: true }));
    expect(createShowFontsStore({ storage }).get()).toEqual([]);
  });

  it("falls back to memory when storage is unavailable or throws", () => {
    const mem = createShowFontsStore({ storage: null });
    mem.set(["Gotham"]);
    expect(mem.get()).toEqual(["Gotham"]);
    expect(mem.persistent).toBe(false);

    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    const t = createShowFontsStore({ storage: throwing });
    expect(t.persistent).toBe(true);
    t.set(["Avenir"]);
    expect(t.get()).toEqual(["Avenir"]);
    expect(t.persistent).toBe(false);

    const brokenRead: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(createShowFontsStore({ storage: brokenRead }).persistent).toBe(false);
  });

  it("notifies subscribers on change", () => {
    const store = createShowFontsStore({ storage: null });
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.set(["A"]);
    off();
    store.set(["B"]);
    expect(calls).toBe(1);
  });

  it("composes with the brand store into the scan's options", () => {
    const brand = createBrandStore({ storage: null });
    const fonts = createShowFontsStore({ storage: null });
    const getOptions = composeAuditOptions(brand, fonts);
    expect(getOptions()).toEqual({});
    fonts.set(["Gotham"]);
    expect(getOptions()).toEqual({ availableFonts: ["Gotham"] });
    brand.set({ fonts: ["Inter"], colors: [], tolerance: 2 });
    expect(getOptions()).toEqual({ brand: { fonts: ["Inter"], colors: [], tolerance: 2 }, availableFonts: ["Gotham"] });
  });
});

describe("font list parsing", () => {
  it("one font per line, ignoring blanks, comments, and duplicates", () => {
    expect(normalizeFontList("Gotham\r\n\n  Avenir Next \n# comment\ngotham\n".split(/\r?\n/))).toEqual(["Gotham", "Avenir Next"]);
    expect(parseFontListFile("a.txt", "Gotham\nAvenir\n")).toEqual({ ok: true, fonts: ["Gotham", "Avenir"] });
  });

  it("JSON: an array of names or { fonts: [...] }", () => {
    expect(parseFontListFile("f.json", '["Gotham", "Avenir"]')).toEqual({ ok: true, fonts: ["Gotham", "Avenir"] });
    expect(parseFontListFile("f.json", '{"fonts": ["Gotham"]}')).toEqual({ ok: true, fonts: ["Gotham"] });
    expect(parseFontListFile("f.json", '{"fonts": [1]}').ok).toBe(false);
    expect(parseFontListFile("f.json", "nope").ok).toBe(false);
  });
});
