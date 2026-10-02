/**
 * Show-machine fonts setting (G3): editor (add / remove / paste / import / export / deck fonts),
 * reachable from settings and from Problems, and wired into the scan options with a rescan hint.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarize, type AuditOptions, type AuditResult } from "@slidecheck/audit-core";
import { createScanService } from "../../office/scan";
import { createBrandStore } from "../brand/brandStore";
import { BrandSettingsEntry } from "../components/BrandEditor";
import { ShowFontsEditor } from "../components/ShowFontsEditor";
import { composeAuditOptions, createShowFontsStore, type ShowFontsStore } from "../fonts/showFontsStore";
import { fakeFinding, fakeResult, slideShape } from "../testing/fixtures";
import { fontMaybeMissing, fontSummary } from "../testing/problemFindings";
import { all, button, cleanup, click, flush, one, renderPane } from "../testing/render";

afterEach(cleanup);

function deck(): AuditResult {
  return fakeResult([
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Calibri", data: { typeface: "Calibri" } }),
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Gotham", data: { typeface: "Gotham" } }),
    fakeFinding({ area: "fonts", kind: "font-usage", title: "MS Gothic", data: { typeface: "MS Gothic" } }),
    fontMaybeMissing("Gotham", [slideShape(1, 2)]),
    fontMaybeMissing("MS Gothic", [slideShape(1, 3)]),
    fontSummary(false, 2),
  ]);
}

function setup(opts: { store?: ShowFontsStore; plan?: "pro" | "anonymous" } = {}) {
  const store = opts.store ?? createShowFontsStore({ storage: null });
  const download = vi.fn();
  const r = renderPane({
    result: deck(),
    plan: opts.plan ?? "pro",
    slots: {
      settingsSlot: (
        <BrandSettingsEntry store={createBrandStore({ storage: null })}>
          <ShowFontsEditor store={store} placement="settings" download={download} />
        </BrandSettingsEntry>
      ),
      showFontsSlot: ({ placement }) => <ShowFontsEditor store={store} placement={placement} download={download} />,
    },
  });
  click(button(r.container, "Settings"));
  const editor = () => one(r.container, '[data-show-fonts-editor="settings"]');
  return { ...r, store, download, editor };
}

function field(root: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = all(root, "label").find((x) => (x.textContent ?? "").trim().startsWith(label));
  if (!l) throw new Error(`no label ${label}`);
  return document.getElementById(l.getAttribute("for")!) as HTMLInputElement;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const chips = (root: HTMLElement) => all(root, "[data-show-font]").map((li) => li.textContent);

describe("show-machine fonts editor", () => {
  it("is reachable from settings, free, and starts with an empty list", () => {
    const t = setup({ plan: "anonymous" });
    expect(t.editor().textContent).toContain("No fonts yet");
    expect(t.editor().querySelector("[data-locked-section]")).toBeNull();
  });

  it("adds typed fonts (Enter or button), rejects duplicates, and removes them", () => {
    const t = setup();
    type(field(t.editor(), "Add a font"), "Helvetica Neue");
    click(button(t.editor(), "Add font"));
    expect(t.store.get()).toEqual(["Helvetica Neue"]);
    type(field(t.editor(), "Add a font"), "helvetica neue");
    click(button(t.editor(), "Add font"));
    expect(t.editor().textContent).toContain("That font is already in the list.");
    expect(t.store.get()).toEqual(["Helvetica Neue"]);
    expect(chips(t.editor())).toEqual(["Helvetica Neue"]);
    click(button(t.editor(), "Remove font Helvetica Neue"));
    expect(t.store.get()).toEqual([]);
  });

  it("pastes a list, one font per line", () => {
    const t = setup();
    t.store.set(["Avenir"]);
    type(field(t.editor(), "Paste a list"), "Gotham\n\n  Avenir \nDIN Pro\n");
    click(button(t.editor(), "Add pasted fonts"));
    expect(t.store.get()).toEqual(["Avenir", "Gotham", "DIN Pro"]);
    expect(t.editor().textContent).toContain("Added 2 fonts.");
  });

  it("imports a .txt or .json file and exports both", async () => {
    const t = setup();
    const input = field(t.editor(), "Import a .txt or .json file") as HTMLInputElement;
    // jsdom's File has no text(); the editor only needs name, size, and text().
    const fakeFile = (name: string, content: string) => ({ name, size: content.length, text: async () => content });
    const file = fakeFile("fonts.txt", "Gotham\nAvenir\n");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(t.store.get()).toEqual(["Gotham", "Avenir"]);

    const bad = fakeFile("fonts.json", '{"fonts": 3}');
    Object.defineProperty(input, "files", { value: [bad], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(one(t.editor(), "[role=alert]").textContent).toContain("wasn't imported");
    expect(t.store.get()).toEqual(["Gotham", "Avenir"]);

    click(button(t.editor(), "Export .txt"));
    click(button(t.editor(), "Export .json"));
    expect(t.download.mock.calls).toEqual([
      ["show-machine-fonts.txt", "Gotham\nAvenir\n", "text/plain"],
      ["show-machine-fonts.json", JSON.stringify({ fonts: ["Gotham", "Avenir"] }, null, 2), "application/json"],
    ]);
  });

  it("'Add fonts used in this deck' adds only the fonts the user confirms are installed", () => {
    const t = setup();
    click(button(t.editor(), "Add fonts used in this deck…"));
    const box = one(t.editor(), "[data-deck-fonts]");
    const labels = all(box, "label").map((l) => l.textContent);
    // Fonts that may be missing first; nothing pre-checked.
    expect(labels).toEqual(["Gotham (may be missing)", "MS Gothic (may be missing)", "Calibri"]);
    const add = button(box, /^Add \d+ checked fonts?$|^Add checked fonts$/);
    expect(add.disabled).toBe(true);
    const gotham = document.getElementById((all(box, "label")[0] as HTMLLabelElement).htmlFor) as HTMLInputElement;
    click(gotham);
    click(button(box, "Add 1 checked font"));
    expect(t.store.get()).toEqual(["Gotham"]);
  });

  it("a change updates the scan options and shows the rescan hint", async () => {
    const t = setup();
    expect(t.container.querySelector("[data-options-changed]")).toBeNull();
    type(field(t.editor(), "Add a font"), "Gotham");
    click(button(t.editor(), "Add font"));
    expect(one(t.container, "[data-options-changed]").textContent).toContain("Show-machine fonts changed. Rescan to apply them.");

    const brand = createBrandStore({ storage: null });
    const clientScan = vi.fn(async (_b: unknown, hash: string, _o: AuditOptions) => ({
      result: { findings: [], hash, stats: { slides: 0, shapes: 0, durationMs: 0, perArea: summarize([]) }, errors: [] },
    }));
    const svc = createScanService({
      readSnapshot: async () => ({ bytes: new Uint8Array([1]), sha256: "h", sliceCount: 1 }),
      client: { scan: clientScan, cancel: () => {}, dispose: () => {} },
      getOptions: composeAuditOptions(brand, t.store),
    });
    await svc.scan();
    expect(clientScan.mock.calls[0]![2]).toEqual({ availableFonts: ["Gotham"] });
  });

  it("is reachable from the Fonts category in Problems", () => {
    const t = setup();
    click(one(t.container, '[data-category="fonts"] [data-category-toggle]'));
    click(button(one(t.container, '[data-category="fonts"]'), "Set show-machine fonts"));
    expect(t.container.querySelector('[data-category="fonts"] [data-show-fonts-editor="problems"]')).not.toBeNull();
  });

  it("notes when settings can't be saved on this device", () => {
    const t = setup();
    expect(t.editor().textContent).toContain("lasts until the pane closes");
  });
});

describe("show-machine fonts editor with the SlideCheck Helper (U12, R15)", () => {
  function helperStub(phase: "connected" | "offered", fonts: string[] | null) {
    const snap = { phase, platform: "mac", health: null, port: 47317, fonts, reason: null, dismissPersistent: true } as const;
    return { getSnapshot: () => snap, subscribe: () => () => {} };
  }

  function setupWithHelper(helper: ReturnType<typeof helperStub>, initial: string[] = []) {
    const store = createShowFontsStore({ storage: null });
    store.set(initial);
    const r = renderPane({
      result: deck(),
      slots: {
        settingsSlot: (
          <BrandSettingsEntry store={createBrandStore({ storage: null })}>
            <ShowFontsEditor store={store} placement="settings" helper={helper} />
          </BrandSettingsEntry>
        ),
      },
    });
    click(button(r.container, "Settings"));
    return { ...r, store, editor: () => one(r.container, '[data-show-fonts-editor="settings"]') };
  }

  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it("is offered only when the helper is Connected", () => {
    const t = setupWithHelper(helperStub("offered", null));
    expect(t.editor().querySelector("[data-machine-fonts]")).toBeNull();
  });

  it("confirms, then merges this computer's fonts: dedupes case-insensitively and keeps existing entries", async () => {
    const t = setupWithHelper(helperStub("connected", ["Segoe UI", "gotham", "Avenir Next", "Segoe UI Semibold", "avenir next"]), ["Gotham", "Brand Sans"]);
    click(button(t.editor(), "This is a show machine: add its fonts to the list"));
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("This adds 3 font names from this computer to the show-machine list. Fonts already on the list are kept.");
    expect(t.store.get()).toEqual(["Gotham", "Brand Sans"]); // nothing yet
    click(button(d!, "Add 3 fonts"));
    await flush();
    expect(t.store.get()).toEqual(["Gotham", "Brand Sans", "Segoe UI", "Avenir Next", "Segoe UI Semibold"]);
    expect(t.editor().textContent).toContain("Added 3 fonts.");
  });

  it("Cancel adds nothing", async () => {
    const t = setupWithHelper(helperStub("connected", ["Segoe UI"]), ["Gotham"]);
    click(button(t.editor(), "This is a show machine: add its fonts to the list"));
    await flush();
    click(button(dialog()!, "Cancel"));
    await flush();
    expect(t.store.get()).toEqual(["Gotham"]);
  });

  it("says so when every font is already listed", () => {
    const t = setupWithHelper(helperStub("connected", ["gotham"]), ["Gotham"]);
    click(button(t.editor(), "This is a show machine: add its fonts to the list"));
    expect(t.editor().textContent).toContain("Every font on this computer is already on the list.");
  });
});
