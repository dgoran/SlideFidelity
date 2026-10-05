/**
 * The deck-theme brand as the pane can see it (D9 "reset to theme", R22 default): theme colors
 * from the `theme-colors` findings and theme fonts from `font-usage` findings with a theme role.
 * The audit derives the same default itself when no custom profile is set; this is for display
 * and as the starting point of a custom profile.
 */
import { DEFAULT_COLOR_TOLERANCE, normalizeHex, type AuditResult, type BrandProfile, type FindingOf } from "@slidefidelity/audit-core";
import type { ScanState } from "../state/store";

export interface ThemeColorSwatch {
  /** `RRGGBB`, validated. */
  hex: string;
  /** Theme slot (`accent1`, `dk1`, …). */
  slot: string;
}

export interface ThemeBrand {
  fonts: string[];
  colors: ThemeColorSwatch[];
}

export function themeBrandFromResult(result: AuditResult | null | undefined): ThemeBrand {
  const fonts: string[] = [];
  const colors: ThemeColorSwatch[] = [];
  if (!result) return { fonts, colors };
  for (const f of result.findings) {
    if (f.kind === "theme-colors") {
      const d = (f as FindingOf<"theme-colors">).data;
      for (const c of d?.colors ?? []) {
        const hex = typeof c.hex === "string" ? normalizeHex(c.hex) : undefined;
        if (hex && !colors.some((x) => x.hex === hex)) colors.push({ hex, slot: String(c.slot) });
      }
    } else if (f.kind === "font-usage") {
      const d = (f as FindingOf<"font-usage">).data;
      if (d?.themeRole && typeof d.typeface === "string" && !fonts.some((x) => x.toLowerCase() === d.typeface.toLowerCase())) {
        fonts.push(d.typeface);
      }
    }
  }
  return { fonts, colors };
}

export function themeBrandProfile(theme: ThemeBrand): BrandProfile {
  return { fonts: [...theme.fonts], colors: theme.colors.map((c) => c.hex), tolerance: DEFAULT_COLOR_TOLERANCE };
}

/** The latest results the pane has (ready, or the previous results while rescanning / failed). */
export function currentResult(scan: ScanState): AuditResult | null {
  if (scan.status === "ready") return scan.result;
  if (scan.status === "scanning" || scan.status === "failed") return scan.previous?.result ?? null;
  return null;
}
