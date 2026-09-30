import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBrandJson, serializeBrand, summarize, type AuditOptions, type AuditResult } from "@slidecheck/audit-core";
import { createScanService } from "../../office/scan";
import { BRAND_STORAGE_KEY, createBrandStore, type StorageLike } from "../brand/brandStore";
import { BrandEditor, BrandSettingsEntry } from "../components/BrandEditor";
import { all, button, byText, changeValue, cleanup, click, flush, one, renderPane } from "../testing/render";
import { fakeFinding, fakeResult } from "../testing/fixtures";

afterEach(cleanup);

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function themedResult(): AuditResult {
  return fakeResult([
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Calibri", data: { typeface: "Calibri", themeRole: "minor" } }),
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Calibri Light", data: { typeface: "Calibri Light", themeRole: "major" } }),
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Comic Sans MS", data: { typeface: "Comic Sans MS" } }),
    fakeFinding({
      area: "colors",
      kind: "theme-colors",
      title: "Theme colors: Office",
      data: { colors: [{ slot: "accent1", hex: "4472C4", kind: "srgb" }, { slot: "accent2", hex: "ED7D31", kind: "srgb" }] },
    }),
    fakeFinding({ area: "colors", kind: "color-usage", title: "#FF0000", severity: "warning" }),
  ]);
}

function setup(opts: { plan?: "pro" | "anonymous"; storage?: StorageLike | null } = {}) {
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const store = createBrandStore({ storage });
  const download = vi.fn();
  const r = renderPane({
    plan: opts.plan ?? "pro",
    result: themedResult(),
    slots: { settingsSlot: <BrandSettingsEntry store={store} download={download} /> },
  });
  const open = () => click(button(r.container, "Settings"));
  const editor = () => one(r.container, '[data-brand-editor="settings"]');
  return { ...r, store, storage, download, open, editor };
}

function input(root: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = all(root, "label").find((x) => (x.textContent ?? "").trim().startsWith(label));
  if (!l) throw new Error(`no label ${label}`);
  return document.getElementById(l.getAttribute("for")!) as HTMLInputElement;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  changeValue(el, value);
}

describe("brand store (D9)", () => {
  it("persists the custom profile and re-validates it on load", () => {
    const storage = memoryStorage();
    const a = createBrandStore({ storage });
    expect(a.get()).toBeNull();
    expect(a.auditOptions()).toEqual({});
    a.set({ fonts: ["Inter"], colors: ["112233"], tolerance: 3 });
    expect(parseBrandJson(storage.data.get(BRAND_STORAGE_KEY)!)).toMatchObject({ ok: true, brand: { fonts: ["Inter"] } });
    const b = createBrandStore({ storage });
    expect(b.get()).toEqual({ fonts: ["Inter"], colors: ["112233"], tolerance: 3 });
    expect(b.auditOptions()).toEqual({ brand: { fonts: ["Inter"], colors: ["112233"], tolerance: 3 } });
    b.set(null);
    expect(storage.data.has(BRAND_STORAGE_KEY)).toBe(false);
  });

  it("drops a tampered stored profile", () => {
    const storage = memoryStorage();
    storage.data.set(BRAND_STORAGE_KEY, JSON.stringify({ colors: ["not a color"] }));
    expect(createBrandStore({ storage }).get()).toBeNull();
    expect(storage.data.has(BRAND_STORAGE_KEY)).toBe(false);
  });

  it("falls back to memory when storage throws", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const s = createBrandStore({ storage: throwing });
    expect(s.persistent).toBe(false);
    s.set({ fonts: ["Inter"], colors: [], tolerance: 2 });
    expect(s.get()?.fonts).toEqual(["Inter"]);
  });

  it("notifies subscribers", () => {
    const s = createBrandStore({ storage: null });
    const l = vi.fn();
    const off = s.subscribe(l);
    s.set({ fonts: [], colors: [], tolerance: 1 });
    off();
    s.set(null);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("brand editor (D9)", () => {
  it("defaults to the deck's theme, listing its fonts and colors", () => {
    const t = setup();
    t.open();
    const ed = t.editor();
    expect(one(ed, "[data-brand-status]").textContent).toBe("Using the deck's theme");
    expect(one(ed, 'ul[aria-label="Theme fonts"]').textContent).toBe("CalibriCalibri Light");
    expect(one(ed, 'ul[aria-label="Theme colors"]').textContent).toBe("#4472C4#ED7D31");
  });

  it("customize starts from the theme; fonts and colors can be added and removed", () => {
    const t = setup();
    t.open();
    click(button(t.editor(), "Customize brand"));
    expect(t.store.get()).toEqual({ fonts: ["Calibri", "Calibri Light"], colors: ["4472C4", "ED7D31"], tolerance: 2.3 });

    type(input(t.editor(), "Add a font"), "Inter");
    click(button(t.editor(), "Add font"));
    expect(t.store.get()?.fonts).toEqual(["Calibri", "Calibri Light", "Inter"]);
    type(input(t.editor(), "Add a font"), "inter");
    click(button(t.editor(), "Add font"));
    expect(t.editor().textContent).toContain("That font is already in the list.");

    click(button(t.editor(), "Remove font Calibri Light"));
    expect(t.store.get()?.fonts).toEqual(["Calibri", "Inter"]);

    click(button(t.editor(), "Remove color #ED7D31"));
    expect(t.store.get()?.colors).toEqual(["4472C4"]);
    // The removed theme color is offered back as a swatch.
    click(button(t.editor(), "Add theme color #ED7D31"));
    expect(t.store.get()?.colors).toEqual(["4472C4", "ED7D31"]);

    type(input(t.editor(), "Add a color"), "#abc");
    click(button(t.editor(), "Add color"));
    expect(t.store.get()?.colors).toEqual(["4472C4", "ED7D31", "AABBCC"]);
    type(input(t.editor(), "Add a color"), "blue-ish");
    click(button(t.editor(), "Add color"));
    expect(t.editor().textContent).toContain('Enter a hex color like "#4472C4".');
    expect(t.store.get()?.colors).toHaveLength(3);
  });

  it("tolerance is a bounded number", () => {
    const t = setup();
    t.store.set({ fonts: [], colors: [], tolerance: 2.3 });
    t.open();
    const tol = input(t.editor(), "Color tolerance") as HTMLInputElement;
    changeValue(tol, "5");
    expect(t.store.get()?.tolerance).toBe(5);
    changeValue(tol, "500");
    expect(t.store.get()?.tolerance).toBe(5);
    expect(t.editor().textContent).toContain("Enter a number from 0 to 100.");
  });

  it("export produces serializeBrand JSON", () => {
    const t = setup();
    const profile = { fonts: ["Inter"], colors: ["112233"], tolerance: 4 };
    t.store.set(profile);
    t.open();
    click(button(t.editor(), "Export JSON"));
    expect(t.download).toHaveBeenCalledWith("brand-profile.json", serializeBrand(profile));
  });

  it("invalid JSON import shows the field errors and changes nothing", () => {
    const t = setup();
    t.open();
    type(input(t.editor(), "Or paste brand JSON"), JSON.stringify({ fonts: [""], colors: ["#12345", "#4472C4"], tolerance: -1 }));
    click(button(t.editor(), "Import"));
    const errors = all(one(t.editor(), "[data-import-errors]"), "li").map((li) => li.textContent);
    expect(errors).toEqual([
      "fonts[0]: Font name is empty.",
      'colors[0]: "#12345" is not a hex color like "#4472C4".',
      "tolerance: Tolerance must be a number from 0 to 100.",
    ]);
    expect(t.store.get()).toBeNull();

    type(input(t.editor(), "Or paste brand JSON"), "{nope");
    click(button(t.editor(), "Import"));
    expect(one(t.editor(), "[data-import-errors]").textContent).toContain("Not valid JSON");
  });

  it("valid JSON import replaces the profile", () => {
    const t = setup();
    t.open();
    type(input(t.editor(), "Or paste brand JSON"), serializeBrand({ fonts: ["Inter"], colors: ["112233"], tolerance: 3 }));
    click(button(t.editor(), "Import"));
    expect(t.store.get()).toEqual({ fonts: ["Inter"], colors: ["112233"], tolerance: 3 });
    expect(one(t.editor(), "[data-brand-status]").textContent).toBe("Custom brand: 1 font, 1 color");
  });

  it("reset to theme clears the custom profile", () => {
    const t = setup();
    t.store.set({ fonts: ["Inter"], colors: [], tolerance: 3 });
    t.open();
    click(button(t.editor(), "Reset to theme"));
    expect(t.store.get()).toBeNull();
    expect(one(t.editor(), "[data-brand-status]").textContent).toBe("Using the deck's theme");
  });

  it("a change marks the results as needing a rescan, and the rescan uses the new brand", async () => {
    const t = setup();
    t.open();
    expect(t.container.querySelector("[data-options-changed]")).toBeNull();
    click(button(t.editor(), "Customize brand"));
    expect(t.container.querySelector("[data-options-changed]")?.textContent).toContain("Rescan to apply");

    // The production scan service reads the store through getOptions at the start of each scan.
    const clientScan = vi.fn(async (_b: unknown, hash: string, _options: AuditOptions) => ({
      result: { findings: [], hash, stats: { slides: 0, shapes: 0, durationMs: 0, perArea: summarize([]) }, errors: [] },
    }));
    const svc = createScanService({
      readSnapshot: async () => ({ bytes: new Uint8Array([1]), sha256: "h", sliceCount: 1 }),
      client: { scan: clientScan, cancel: () => {}, dispose: () => {} },
      getOptions: () => t.store.auditOptions(),
    });
    await svc.scan();
    expect(clientScan.mock.calls[0]![2]).toEqual({ brand: { fonts: ["Calibri", "Calibri Light"], colors: ["4472C4", "ED7D31"], tolerance: 2.3 } });
    click(button(t.editor(), "Remove font Calibri"));
    const again = await svc.rescanForFix();
    expect(again.changed).toBe(true);
    expect(clientScan.mock.calls[1]![2]).toMatchObject({ brand: { fonts: ["Calibri Light"] } });
  });

  it("is a Pro feature (locked for anonymous users)", () => {
    const t = setup({ plan: "anonymous" });
    t.open();
    const locked = one(t.container, "[data-locked-section]");
    expect(locked.getAttribute("aria-label")).toBe("Brand profile (Pro)");
    expect(t.container.querySelector("[data-brand-editor]")).toBeNull();
  });

  it("is reachable from the Fonts and Colors areas (collapsed until opened)", async () => {
    const store = createBrandStore({ storage: null });
    const r = renderPane({
      result: themedResult(),
      state: { area: "colors" },
      slots: { brandSlot: ({ area }) => <BrandEditor store={store} placement={area} /> },
    });
    await flush();
    const ed = one(r.container, '[data-brand-editor="colors"]');
    expect(byText(ed, "Using the deck's theme")).toBeTruthy();
    const toggle = button(ed, "Edit brand");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(button(ed, "Customize brand")).toBeTruthy();
  });
});
