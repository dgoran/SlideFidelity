/**
 * Fonts that may be missing on the presenting computer (Graphics Ops "show-ready").
 *
 * A font family the deck uses (any script and source, as collected by the fonts check: runs,
 * tables, charts, SmartArt, master text styles, bullets, theme references resolved to the theme
 * font) is safe when it is
 *   (a) embedded in the deck (`p:embeddedFontLst`; a subset embedding is safe only for the
 *       characters already used, so it is counted safe with a note),
 *   (b) one of the fonts Microsoft 365 installs on both Windows and Mac (`officeFonts.ts`), or
 *   (c) on the team's show-machine font list (`AuditOptions.availableFonts`, case-insensitive).
 * Otherwise it gets a `font-maybe-missing` finding whose targets are exactly the `font-usage`
 * targets, so the existing replace-font fix applies unchanged. One `font-availability-summary`
 * finding per deck carries the counts.
 *
 * Fonts on THIS computer (U11, H7): when the SlideCheck Helper is running, `AuditOptions.localFonts`
 * lists every family PowerPoint can use here (an empty list still means "helper present"). The
 * helper is authoritative for this machine: a used font that is not embedded (fully or as a subset)
 * and not on that list gets a `font-missing-here` warning with the same targets and fix, even when
 * it ships with Office. Reviews usually happen on the show machine, so with the helper present the
 * show-machine `font-maybe-missing` finding drops to info (`data.missingHere` says what the helper
 * found); without the helper it is unchanged (`data.missingHere` is null).
 *
 * Usage collection is reused by running the fonts check (`fontChecks` id `fonts`) and reading its
 * `font-usage` findings; the collector in fonts.ts is not exported.
 */
import {
  makeFinding,
  partTarget,
  type Finding,
  type FindingOf,
  type FindingTarget,
} from "../findings";
import { officeCrossPlatformFont, platformOnlyFont, suggestedReplacement, type FontPlatform } from "../officeFonts";
import type { Check, CheckContext } from "../runner";
import { fontChecks, type FontScript, type FontSource } from "./fonts";

// ---------------------------------------------------------------------------------------------
// Public data types

export interface FontMaybeMissingData {
  typeface: string;
  /** Number of usages (= targets). */
  usageCount: number;
  /** 1-based slide numbers with a usage, ascending. */
  slideNumbers: number[];
  /** Where the font is used, in fonts-check source order. */
  sources: FontSource[];
  /** Font script slots it is used in. */
  scripts: FontScript[];
  /** Always `none` today: any embedding (full or subset) counts as safe. */
  embedded: "none" | "subset";
  onTeamList: false;
  /** Used only as a bullet / symbol glyph font (reported as info). */
  symbolOnly: boolean;
  /** Set when the font is standard on one platform only. */
  platform?: FontPlatform;
  platformNote?: string;
  /** A standard cross-platform stand-in, for well-known fonts. */
  replacement?: string;
  /** Plain-language recommended action. */
  suggestion: string;
  /**
   * What the SlideCheck Helper found on this computer: true = not installed here (a separate
   * `font-missing-here` warning carries the problem), false = installed here, null = no helper
   * list (`AuditOptions.localFonts` absent). Any non-null value makes this finding info.
   */
  missingHere: boolean | null;
}

/** A used, non-embedded font the SlideCheck Helper did not report on this computer. */
export interface FontMissingHereData {
  typeface: string;
  /** Number of usages (= targets). */
  usageCount: number;
  /** 1-based slide numbers with a usage, ascending. */
  slideNumbers: number[];
  /** Where the font is used, in fonts-check source order. */
  sources: FontSource[];
  /** Font script slots it is used in. */
  scripts: FontScript[];
  /** Used only as a bullet / symbol glyph font. */
  symbolOnly: boolean;
  /** An Office cloud font (downloads on demand, only when online) that is not downloaded here. */
  cloud: boolean;
  /** One of the fonts Microsoft 365 installs on both Windows and Mac (`officeFonts.ts`). */
  officeFont: boolean;
  /** On the show-machine font list (`AuditOptions.availableFonts`). */
  onTeamList: boolean;
  /** A standard cross-platform stand-in, for well-known fonts. */
  replacement?: string;
  /** Plain-language recommended action. */
  suggestion: string;
}

export type FontAvailabilityStatus = "embedded" | "embedded-subset" | "office" | "team-list" | "maybe-missing";

export interface FontAvailabilitySummaryData {
  /** Fully or subset embedded (subset included; see `subsetEmbedded`). */
  safeByEmbedding: number;
  subsetEmbedded: number;
  safeByOffice: number;
  safeByTeamList: number;
  maybeMissing: number;
  /** Whether a non-empty show-machine font list was supplied. */
  teamListProvided: boolean;
  /** Whether the SlideCheck Helper's local font list was supplied (`localFonts`, even empty). */
  localListProvided: boolean;
  /** Fonts with a `font-missing-here` finding (0 when no local list). */
  missingHere: number;
  /** Every font the deck uses, alphabetical (fonts check order). */
  fonts: {
    typeface: string;
    status: FontAvailabilityStatus;
    /** Office cloud font (downloads on demand; needs internet on the show machine). */
    cloud?: boolean;
    note?: string;
    /** Set only when the local list was supplied: not embedded and not installed on this computer. */
    missingHere?: boolean;
  }[];
}

declare module "../findings" {
  interface FindingDataMap {
    "font-maybe-missing": FontMaybeMissingData;
    "font-missing-here": FontMissingHereData;
    "font-availability-summary": FontAvailabilitySummaryData;
  }
}

// ---------------------------------------------------------------------------------------------

const SCRIPT_ORDER: readonly FontScript[] = ["latin", "ea", "cs", "sym", "bu"];
const SOURCE_ORDER: readonly FontSource[] = ["direct", "hidden-list-style", "master", "chart", "smartart", "theme-default"];

const SOURCE_PHRASE: Record<FontSource, string> = {
  direct: "slide text",
  "hidden-list-style": "shape list styles",
  master: "masters/layouts",
  chart: "charts",
  smartart: "SmartArt",
  "theme-default": "the theme",
};

const SUBSET_NOTE = "Embedded as a subset: only the characters already typed are included, so new or edited text may fall back to another font.";

const PLATFORM_NOTE: Record<FontPlatform, (cloud: boolean) => string> = {
  windows: (cloud) =>
    cloud
      ? "Standard on Windows only. A Mac has it only if Office can download it as a cloud font (needs internet and connected experiences)."
      : "Standard on Windows only; a Mac won't have it.",
  mac: () => "Standard on Mac only; Windows computers won't have it.",
};

const lower = (s: string): string => s.trim().toLowerCase();
/** Family-name key for the helper's list: trimmed, inner whitespace collapsed, lower case. */
const familyKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

function slidesPhrase(nums: number[]): string {
  if (nums.length === 0) return "";
  return nums.length === 1 ? `slide ${nums[0]}` : `slides ${nums.join(", ")}`;
}

async function fontUsages(ctx: CheckContext): Promise<FindingOf<"font-usage">[]> {
  const check = fontChecks.find((c) => c.id === "fonts");
  if (!check) throw new Error("fonts check is not registered");
  const out = await check.run(ctx);
  return out.filter((f): f is FindingOf<"font-usage"> => f.kind === "font-usage");
}

interface UsageFacts {
  typeface: string;
  targets: FindingTarget[];
  slideNumbers: number[];
  sources: FontSource[];
  scripts: FontScript[];
  symbolOnly: boolean;
  usageCount: number;
  /** "Used N times in ..." sentence. */
  usedPhrase: string;
  replacement?: string;
}

function usageFacts(usage: FindingOf<"font-usage">): UsageFacts {
  const { typeface, usages } = usage.data;
  const targets: FindingTarget[] = usage.targets.map((t) => ({ ...t }));
  const slideNumbers = [
    ...new Set(targets.map((t) => t.container.slideNumber).filter((n): n is number => n !== undefined)),
  ].sort((a, b) => a - b);
  const sources = SOURCE_ORDER.filter((s) => usages.some((u) => u.source === s));
  const scripts = SCRIPT_ORDER.filter((s) => usages.some((u) => u.script === s));
  const symbolOnly = usages.length > 0 && usages.every((u) => u.script === "bu" || u.script === "sym");
  const where: string[] = [];
  const slides = slidesPhrase(slideNumbers);
  if (slides) where.push(slides);
  for (const s of sources) if (s !== "direct" && s !== "hidden-list-style") where.push(SOURCE_PHRASE[s]);
  const n = usages.length;
  const replacement = suggestedReplacement(typeface);
  return {
    typeface,
    targets,
    slideNumbers,
    sources,
    scripts,
    symbolOnly,
    usageCount: n,
    usedPhrase: `Used ${n} ${n === 1 ? "time" : "times"}${where.length ? ` in ${where.join(", ")}` : ""}.`,
    ...(replacement ? { replacement } : {}),
  };
}

function maybeMissing(usage: FindingOf<"font-usage">, missingHere: boolean | null): Finding {
  const { typeface, targets, slideNumbers, sources, scripts, symbolOnly, usageCount: n, usedPhrase, replacement } = usageFacts(usage);
  const platform = platformOnlyFont(typeface);

  const stand = replacement ?? "a standard Office font such as Arial";
  const suggestion =
    `Embed it (File > Options > Save > Embed fonts in the file), confirm it is installed on the show machine ` +
    `and add it to the show-machine font list, or replace it with ${stand}.`;

  const parts = [usedPhrase];
  const data: FontMaybeMissingData = {
    typeface,
    usageCount: n,
    slideNumbers,
    sources,
    scripts,
    embedded: "none",
    onTeamList: false,
    symbolOnly,
    suggestion,
    missingHere,
  };
  if (platform) {
    data.platform = platform.platform;
    data.platformNote = PLATFORM_NOTE[platform.platform](platform.cloud);
    parts.push(data.platformNote);
  }
  if (symbolOnly) parts.push("Only used for bullet or symbol glyphs; a substitute changes how those glyphs look.");
  if (missingHere === false) parts.push("It is installed on this computer; this matters only if you present from another computer.");
  if (missingHere === true) parts.push("It is also missing on this computer (reported separately).");
  if (replacement) data.replacement = replacement;
  parts.push(suggestion);

  return makeFinding({
    area: "fonts",
    kind: "font-maybe-missing",
    severity: symbolOnly || missingHere !== null ? "info" : "warning",
    title: `Font '${typeface}' may be missing on the presenting computer (not embedded, not a standard Office font)`,
    detail: parts.join(" "),
    group: typeface,
    ...(usage.groupLabel ? { groupLabel: usage.groupLabel } : {}),
    count: n,
    targets,
    fixes: ["replace-font"],
    reachable: targets.some((t) => t.reachable === true),
    key: lower(typeface),
    data,
  });
}

function missingHereFinding(usage: FindingOf<"font-usage">, officeFont: boolean, cloud: boolean, onTeamList: boolean): Finding {
  const { typeface, targets, slideNumbers, sources, scripts, symbolOnly, usageCount: n, usedPhrase, replacement } = usageFacts(usage);
  const stand = replacement ?? "a standard Office font such as Arial";
  const suggestion = cloud
    ? `Open the deck while online so PowerPoint can download it, or replace it with ${stand}.`
    : `Install it on this computer, or replace it with ${stand}.`;
  const parts = [usedPhrase];
  parts.push(
    cloud
      ? "It is an Office cloud font that is not downloaded on this computer; PowerPoint downloads it only when online (with connected experiences on). Until then PowerPoint shows a substitute font."
      : "The SlideCheck Helper did not find it among the fonts PowerPoint can use on this computer, so PowerPoint shows a substitute font here.",
  );
  if (symbolOnly) parts.push("Only used for bullet or symbol glyphs; a substitute changes how those glyphs look.");
  parts.push(suggestion);
  const data: FontMissingHereData = {
    typeface,
    usageCount: n,
    slideNumbers,
    sources,
    scripts,
    symbolOnly,
    cloud,
    officeFont,
    onTeamList,
    suggestion,
    ...(replacement ? { replacement } : {}),
  };
  return makeFinding({
    area: "fonts",
    kind: "font-missing-here",
    severity: symbolOnly ? "info" : "warning",
    title: `Font missing on this computer: ${typeface}`,
    detail: parts.join(" "),
    group: typeface,
    ...(usage.groupLabel ? { groupLabel: usage.groupLabel } : {}),
    count: n,
    targets,
    fixes: ["replace-font"],
    reachable: targets.some((t) => t.reachable === true),
    key: lower(typeface),
    data,
  });
}

async function runAvailability(ctx: CheckContext): Promise<Finding[]> {
  const { pres, options } = ctx;
  const team = new Set((options.availableFonts ?? []).map(lower).filter((f) => f !== ""));
  const local = options.localFonts === undefined ? undefined : new Set(options.localFonts.map(familyKey).filter((f) => f !== ""));
  const usageFindings = await fontUsages(ctx);

  const summary: FontAvailabilitySummaryData = {
    safeByEmbedding: 0,
    subsetEmbedded: 0,
    safeByOffice: 0,
    safeByTeamList: 0,
    maybeMissing: 0,
    teamListProvided: team.size > 0,
    localListProvided: local !== undefined,
    missingHere: 0,
    fonts: [],
  };
  const out: Finding[] = [];

  for (const usage of usageFindings) {
    const { typeface, embedding } = usage.data;
    const office = officeCrossPlatformFont(typeface);
    const entry: FontAvailabilitySummaryData["fonts"][number] = { typeface, status: "maybe-missing" };
    // Embedded fonts (full or subset) are never missing here; otherwise the helper's list decides.
    const here: boolean | null =
      local === undefined ? null : embedding !== "full" && embedding !== "subset" && !local.has(familyKey(typeface));
    if (here !== null) entry.missingHere = here;
    if (here === true) {
      summary.missingHere++;
      const cloud = office?.cloud === true || platformOnlyFont(typeface)?.cloud === true;
      out.push(missingHereFinding(usage, office !== undefined, cloud, team.has(lower(typeface))));
    }
    if (embedding === "full") {
      entry.status = "embedded";
      summary.safeByEmbedding++;
    } else if (office) {
      entry.status = "office";
      if (office.cloud) {
        entry.cloud = true;
        entry.note = "Office cloud font: downloads on demand if not already on the computer.";
      }
      summary.safeByOffice++;
    } else if (team.has(lower(typeface))) {
      entry.status = "team-list";
      summary.safeByTeamList++;
    } else if (embedding === "subset") {
      entry.status = "embedded-subset";
      entry.note = SUBSET_NOTE;
      summary.safeByEmbedding++;
      summary.subsetEmbedded++;
    } else {
      summary.maybeMissing++;
      out.push(maybeMissing(usage, here));
    }
    summary.fonts.push(entry);
  }

  const m = summary.maybeMissing;
  const detail: string[] = [
    `${summary.safeByEmbedding} embedded, ${summary.safeByOffice} standard Office, ${summary.safeByTeamList} on the show-machine list, ${m} may be missing.`,
  ];
  if (summary.subsetEmbedded > 0) {
    detail.push(`${summary.subsetEmbedded} ${summary.subsetEmbedded === 1 ? "font is" : "fonts are"} embedded as a subset (only the characters used).`);
  }
  if (!summary.teamListProvided) detail.push("No show-machine font list set.");
  const mh = summary.missingHere;
  if (summary.localListProvided) detail.push(`${mh} missing on this computer.`);

  out.push(
    makeFinding({
      area: "fonts",
      kind: "font-availability-summary",
      severity: "info",
      title:
        mh > 0
          ? `${mh} ${mh === 1 ? "font is" : "fonts are"} missing on this computer`
          : m === 0 ? "All fonts should be available on the presenting computer" : `${m} ${m === 1 ? "font" : "fonts"} may be missing on the presenting computer`,
      detail: detail.join(" "),
      group: "font-availability",
      groupLabel: "Font availability",
      targets: [partTarget("presentation", pres.presentationPart)],
      fixes: [],
      key: "deck",
      data: summary,
    }),
  );
  return out;
}

export const fontAvailabilityChecks: Check[] = [{ id: "fonts-availability", area: "fonts", run: runAvailability }];
