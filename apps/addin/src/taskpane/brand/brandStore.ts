/**
 * Brand profile store (D9, R22): the user's custom brand profile, persisted in `localStorage`
 * (which is scoped to the add-in's origin), with a memory fallback when storage is unavailable.
 *
 * `null` means "no custom profile": the audit derives the brand from the deck's theme. The stored
 * value is re-validated with `parseBrandJson` on load, because storage is not trusted either.
 * `auditOptions()` is what the scan service's `getOptions` reads at the start of every scan.
 */
import { parseBrandJson, serializeBrand, type AuditOptions, type BrandProfile } from "@slidefidelity/audit-core";

export const BRAND_STORAGE_KEY = "slidefidelity:brand";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrandStore {
  /** The custom profile, or null when the deck's theme is used. Stable between changes. */
  get(): BrandProfile | null;
  /** Save a custom profile, or `null` to go back to the deck's theme. */
  set(profile: BrandProfile | null): void;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Audit options for the next scan (`{}` when using the theme). */
  auditOptions(): AuditOptions;
  /** False when storage is unavailable: the profile lasts for this pane session only. */
  readonly persistent: boolean;
}

export interface BrandStoreOptions {
  /** Defaults to `globalThis.localStorage` (guarded). Pass `null` for memory only. */
  storage?: StorageLike | null;
  key?: string;
}

function defaultStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Some hosts expose localStorage but throw on use (privacy modes).
    const probe = "slidefidelity:probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function createBrandStore(options: BrandStoreOptions = {}): BrandStore {
  const key = options.key ?? BRAND_STORAGE_KEY;
  let storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set<() => void>();

  let current: BrandProfile | null = null;
  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        const parsed = parseBrandJson(raw);
        if (parsed.ok) current = parsed.brand;
        else storage.removeItem(key);
      }
    } catch {
      storage = null;
    }
  }

  return {
    get: () => current,
    set(profile) {
      current = profile ? { ...profile, fonts: [...profile.fonts], colors: [...profile.colors] } : null;
      if (storage) {
        try {
          if (current) storage.setItem(key, serializeBrand(current));
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
    auditOptions: () => (current ? { brand: current } : {}),
    get persistent() {
      return storage !== null;
    },
  };
}
