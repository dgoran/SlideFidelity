/**
 * Brand profile (R22), shared by the Fonts and Colors areas.
 *
 * A profile lists allowed fonts, allowed colors (upper-case `RRGGBB`, no `#`), and a CIEDE2000
 * tolerance. The default profile is derived from the deck's theme. Profiles serialize to a small
 * versioned JSON document that users can export and import; imported JSON is untrusted and is
 * validated field by field.
 *
 * `BrandProfile` here is structurally compatible with the placeholder in `runner.ts`
 * (`{ fonts; colors; tolerance }`), so either can be passed as `AuditOptions.brand`.
 */
import { nearestColor, parseHex } from "./color";
import type { Presentation, ThemeInfo } from "./package/model";

export interface BrandProfile {
  /** Display name, when the user gave one. */
  name?: string;
  /** Allowed font family names, as written (case preserved), deduped case-insensitively. */
  fonts: string[];
  /** Allowed colors: upper-case `RRGGBB`, no `#`, deduped. */
  colors: string[];
  /** Max CIEDE2000 distance at which a color still counts as a brand color. */
  tolerance: number;
}

/** ≈ one just-noticeable difference. */
export const DEFAULT_COLOR_TOLERANCE = 2.3;
export const MAX_BRAND_TOLERANCE = 100;
export const MAX_BRAND_COLORS = 256;
export const MAX_BRAND_FONTS = 256;
export const MAX_FONT_NAME_LENGTH = 128;
export const BRAND_JSON_VERSION = 1;

/** Normalizes user hex input (`#RRGGBB`, `RRGGBB`, `#RGB`) to `RRGGBB`; undefined when invalid. */
export function normalizeHex(input: string): string | undefined {
  return parseHex(input);
}

/** The theme bound to a master (falls back to the deck's primary theme). */
export function themeForMaster(pres: Presentation, masterPart: string | undefined): ThemeInfo | undefined {
  const master = masterPart === undefined ? undefined : pres.masters.find((m) => m.partName === masterPart);
  if (master?.themePart) {
    const t = pres.themes.find((th) => th.partName === master.themePart);
    if (t) return t;
  }
  return pres.theme;
}

function dedupe(values: readonly string[], key: (v: string) => string = (v) => v): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * The default brand (R22): the theme's 12 colors and its heading/body fonts (latin, then the
 * east-asian and complex-script faces when set). Uses the given master's theme, else the
 * primary theme.
 */
export function defaultBrandFromTheme(pres: Presentation, masterPart?: string): BrandProfile {
  const theme = themeForMaster(pres, masterPart);
  if (!theme) return { fonts: [], colors: [], tolerance: DEFAULT_COLOR_TOLERANCE };
  const fonts = [
    theme.majorFont.latin,
    theme.minorFont.latin,
    theme.majorFont.ea,
    theme.minorFont.ea,
    theme.majorFont.cs,
    theme.minorFont.cs,
  ].filter((f) => f !== "");
  return {
    fonts: dedupe(fonts, (f) => f.toLowerCase()),
    colors: dedupe(theme.colors.map((c) => c.hex)),
    tolerance: DEFAULT_COLOR_TOLERANCE,
  };
}

export interface BrandColorMatch {
  inBrand: boolean;
  /** Nearest allowed color; absent when the palette is empty. */
  nearest?: { hex: string; distance: number };
}

/** Whether `hex` (RRGGBB) is within `brand.tolerance` of an allowed color. */
export function matchBrandColor(
  hex: string,
  brand: Pick<BrandProfile, "colors" | "tolerance"> & Partial<BrandProfile>,
): BrandColorMatch {
  const best = nearestColor(
    hex,
    brand.colors.map((c) => ({ hex: c })),
  );
  if (!best) return { inBrand: false };
  const distance = round4(best.distance);
  return { inBrand: distance <= brand.tolerance, nearest: { hex: best.item.hex.toUpperCase(), distance } };
}

/** Rounds a distance so findings stay stable across float noise. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------------------------
// JSON

export interface BrandFieldError {
  /** JSON path of the bad field (`colors[2]`, `tolerance`); "" for the document itself. */
  field: string;
  message: string;
}

export type BrandParseResult = { ok: true; brand: BrandProfile } | { ok: false; errors: BrandFieldError[] };

/** Serializes a profile as versioned JSON; colors are written as `#RRGGBB`. */
export function serializeBrand(brand: BrandProfile): string {
  const doc: Record<string, unknown> = { version: BRAND_JSON_VERSION };
  if (brand.name !== undefined) doc.name = brand.name;
  doc.fonts = [...brand.fonts];
  doc.colors = brand.colors.map((c) => `#${c.toUpperCase()}`);
  doc.tolerance = brand.tolerance;
  return JSON.stringify(doc, null, 2);
}

/** Shortened, printable echo of an untrusted value for an error message. */
function show(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v) ?? typeof v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/**
 * Parses and validates brand JSON (a string, or an already-parsed value). Every bad field is
 * reported with its path. Missing `fonts`/`colors` default to empty, missing `tolerance` to
 * `DEFAULT_COLOR_TOLERANCE`; unknown fields are ignored.
 */
export function parseBrandJson(input: unknown): BrandParseResult {
  let doc: unknown = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input) as unknown;
    } catch (e) {
      return { ok: false, errors: [{ field: "", message: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: [{ field: "", message: "A brand profile must be a JSON object." }] };
  }
  const o = doc as Record<string, unknown>;
  const errors: BrandFieldError[] = [];

  if (o.version !== undefined && o.version !== BRAND_JSON_VERSION) {
    errors.push({ field: "version", message: `Unsupported version ${show(o.version)}; expected ${BRAND_JSON_VERSION}.` });
  }

  let name: string | undefined;
  if (o.name !== undefined) {
    if (typeof o.name !== "string") errors.push({ field: "name", message: "Name must be a string." });
    else if (o.name.length > MAX_FONT_NAME_LENGTH) errors.push({ field: "name", message: `Name is longer than ${MAX_FONT_NAME_LENGTH} characters.` });
    else name = o.name;
  }

  const fonts: string[] = [];
  if (o.fonts !== undefined) {
    if (!Array.isArray(o.fonts)) errors.push({ field: "fonts", message: "Fonts must be a list of font names." });
    else if (o.fonts.length > MAX_BRAND_FONTS) errors.push({ field: "fonts", message: `At most ${MAX_BRAND_FONTS} fonts are allowed.` });
    else {
      o.fonts.forEach((f: unknown, i) => {
        const field = `fonts[${i}]`;
        if (typeof f !== "string") errors.push({ field, message: `Font ${show(f)} is not a string.` });
        else if (f.trim() === "") errors.push({ field, message: "Font name is empty." });
        else if (f.length > MAX_FONT_NAME_LENGTH) errors.push({ field, message: `Font name is longer than ${MAX_FONT_NAME_LENGTH} characters.` });
        else fonts.push(f.trim());
      });
    }
  }

  const colors: string[] = [];
  if (o.colors !== undefined) {
    if (!Array.isArray(o.colors)) errors.push({ field: "colors", message: "Colors must be a list of hex colors like \"#4472C4\"." });
    else if (o.colors.length > MAX_BRAND_COLORS) errors.push({ field: "colors", message: `At most ${MAX_BRAND_COLORS} colors are allowed.` });
    else {
      o.colors.forEach((c: unknown, i) => {
        const hex = typeof c === "string" ? parseHex(c) : undefined;
        if (hex === undefined) errors.push({ field: `colors[${i}]`, message: `${show(c)} is not a hex color like "#4472C4".` });
        else colors.push(hex);
      });
    }
  }

  let tolerance = DEFAULT_COLOR_TOLERANCE;
  if (o.tolerance !== undefined) {
    if (typeof o.tolerance !== "number" || !Number.isFinite(o.tolerance) || o.tolerance < 0 || o.tolerance > MAX_BRAND_TOLERANCE) {
      errors.push({ field: "tolerance", message: `Tolerance must be a number from 0 to ${MAX_BRAND_TOLERANCE}.` });
    } else tolerance = o.tolerance;
  }

  if (errors.length > 0) return { ok: false, errors };
  const brand: BrandProfile = {
    ...(name !== undefined ? { name } : {}),
    fonts: dedupe(fonts, (f) => f.toLowerCase()),
    colors: dedupe(colors),
    tolerance,
  };
  return { ok: true, brand };
}
