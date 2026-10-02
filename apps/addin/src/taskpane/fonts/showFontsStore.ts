/**
 * Show-machine fonts store (G3): the fonts the team has confirmed are installed on the presenting
 * computer, persisted in `localStorage` (scoped to the add-in's origin) with a memory fallback when
 * storage is unavailable. Mirrors `brand/brandStore.ts`.
 *
 * The list feeds `AuditOptions.availableFonts`, so fonts on it are not reported as possibly
 * missing. Stored and imported values are untrusted: every load goes through `normalizeFontList`
 * (strings only, trimmed, length-capped, de-duplicated case-insensitively, count-capped).
 */
import { MAX_FONT_NAME_LENGTH, type AuditOptions } from "@slidecheck/audit-core";
import type { BrandStore, StorageLike } from "../brand/brandStore";

export const SHOW_FONTS_STORAGE_KEY = "slidecheck:showFonts";
/** Upper bound on the list (a show machine's installed families, with room to spare). */
export const MAX_SHOW_FONTS = 2000;

export interface ShowFontsStore {
  /** The list (empty when none is set). Stable between changes. */
  get(): readonly string[];
  /** Replace the list; the value is normalized first. */
  set(fonts: readonly string[]): void;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Audit options for the next scan (`{}` when the list is empty). */
  auditOptions(): Pick<AuditOptions, "availableFonts">;
  /** False when storage is unavailable: the list lasts for this pane session only. */
  readonly persistent: boolean;
}

export interface ShowFontsStoreOptions {
  /** Defaults to `globalThis.localStorage` (guarded). Pass `null` for memory only. */
  storage?: StorageLike | null;
  key?: string;
}

function defaultStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Some hosts expose localStorage but throw on use (privacy modes).
    const probe = "slidecheck:probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Clean a list of font names: non-strings, blanks, `#` comment lines, over-long names, and
 * case-insensitive duplicates are dropped; at most `MAX_SHOW_FONTS` are kept.
 */
export function normalizeFontList(items: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || name.startsWith("#") || name.length > MAX_FONT_NAME_LENGTH) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_SHOW_FONTS) break;
  }
  return out;
}

/** One font per line. */
export function parseFontLines(text: string): string[] {
  return normalizeFontList(text.split(/\r?\n/));
}

export type FontListParse = { ok: true; fonts: string[] } | { ok: false; error: string };

/** A `.json` file (an array of names, or `{ "fonts": [...] }`) or a text file with one font per line. */
export function parseFontListFile(fileName: string, text: string): FontListParse {
  const json = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text);
  if (!json) return { ok: true, fonts: parseFontLines(text) };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file isn't valid JSON." };
  }
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { fonts?: unknown }).fonts : undefined;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
    return { ok: false, error: 'Expected a list of font names, like ["Gotham", "Avenir Next"] or {"fonts": [...]}.' };
  }
  return { ok: true, fonts: normalizeFontList(list) };
}

export function serializeFontList(fonts: readonly string[], format: "txt" | "json"): string {
  return format === "json" ? JSON.stringify({ fonts: [...fonts] }, null, 2) : fonts.map((f) => `${f}\n`).join("");
}

export function createShowFontsStore(options: ShowFontsStoreOptions = {}): ShowFontsStore {
  const key = options.key ?? SHOW_FONTS_STORAGE_KEY;
  let storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set<() => void>();

  let current: readonly string[] = [];
  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (Array.isArray(parsed)) current = normalizeFontList(parsed);
        else storage.removeItem(key);
      }
    } catch {
      storage = null;
    }
  }

  return {
    get: () => current,
    set(fonts) {
      current = normalizeFontList(fonts);
      if (storage) {
        try {
          if (current.length) storage.setItem(key, JSON.stringify(current));
          else storage.removeItem(key);
        } catch {
          storage = null; // keep working in memory for this session
        }
      }
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    auditOptions: () => (current.length ? { availableFonts: [...current] } : {}),
    get persistent() {
      return storage !== null;
    },
  };
}

/** The scan service's `getOptions`: the brand profile (D9) plus the show-machine fonts (G3). */
export function composeAuditOptions(brand: Pick<BrandStore, "auditOptions">, showFonts: Pick<ShowFontsStore, "auditOptions">): () => AuditOptions {
  return () => ({ ...brand.auditOptions(), ...showFonts.auditOptions() });
}
