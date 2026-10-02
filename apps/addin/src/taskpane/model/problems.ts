/**
 * Problems model (Graphics Ops G1): the show-readiness checklist, as a pure function of the scan's
 * findings. No React, no gating (the view applies the plan per finding).
 *
 * Five categories, each with a status:
 * - `warning`: at least one warning (a problem to fix before the show);
 * - `note`: only info findings (worth a look, not counted as problems);
 * - `pass`: nothing found.
 * The headline counts warnings across the categories: "Ready for show" or "N problems to fix".
 *
 * Note-level kinds (`NOTE_KINDS`) are listed as notes whatever their engine severity: titles at
 * different sizes (`title-sizes-inconsistent`) are worth a look under Fonts (with "Set title
 * size…"), but are not a show-breaker. Slide numbers (`slide-numbers`) are a cleanup, not a
 * problem, and are not listed here (they stay in Review).
 *
 * G6: a linked video is reported by the engine as both `linked-file` (Links) and `media-linked`
 * (Media); only `media-linked` is listed here, so it shows once, under Videos & audio.
 */
import type { Finding } from "@slidecheck/audit-core";
import { hasReachableTarget } from "../fixes/model";

export const PROBLEM_CATEGORIES = ["playback", "fonts", "off-slide", "text-collision", "size"] as const;
export type ProblemCategoryId = (typeof PROBLEM_CATEGORIES)[number];
export type CategoryStatus = "pass" | "warning" | "note";

export const CATEGORY_LABELS: Record<ProblemCategoryId, string> = {
  playback: "Videos & audio",
  fonts: "Fonts",
  "off-slide": "Off-slide objects",
  "text-collision": "Text touching objects",
  size: "Media & image size",
};

/** The finding kinds each category lists. */
export const CATEGORY_KINDS: Record<ProblemCategoryId, readonly string[]> = {
  playback: ["media-missing", "media-linked", "media-online", "media-format", "media-poster-missing"],
  fonts: ["font-maybe-missing", "title-sizes-inconsistent"],
  "off-slide": ["off-slide-shape", "partly-off-slide"],
  "text-collision": ["text-collision"],
  size: ["image-issue"],
};

const CATEGORY_OF = new Map<string, ProblemCategoryId>(
  PROBLEM_CATEGORIES.flatMap((id) => CATEGORY_KINDS[id].map((k) => [k, id] as const)),
);

export function problemCategoryOf(kind: string): ProblemCategoryId | undefined {
  return CATEGORY_OF.get(kind);
}

export interface ProblemCategory {
  id: ProblemCategoryId;
  label: string;
  status: CategoryStatus;
  /** Warning (and error) findings: the problems. */
  warnings: number;
  /** Info findings, including `intentional`. */
  notes: number;
  /** Listed findings: warnings first, then notes, in engine order otherwise. */
  findings: Finding[];
  /** Text collisions the engine rates as info ("Possibly intentional"), listed separately. */
  intentional: Finding[];
}

export interface LargestMedia {
  /** Last path segment of the part name (deck text; render as text only). */
  name: string;
  partName: string;
  bytes: number;
  mediaKind?: string;
}

export interface SizeSummary {
  totalBytes: number;
  mediaBytes: number;
  /** Up to three largest media parts, largest first. */
  largest: LargestMedia[];
}

export interface ProblemsModel {
  categories: ProblemCategory[];
  /** Warnings across the categories. */
  problemCount: number;
  ready: boolean;
  headline: string;
  size?: SizeSummary;
  /** From `font-availability-summary`, when the fonts check ran. */
  fontList?: { teamListProvided: boolean };
  /** Every font family that may be missing, in engine order. */
  missingFonts: string[];
  /** Those the in-place replace-font fix can reach (at least one reachable target, D2). */
  reachableMissingFonts: string[];
}

const LARGEST_COUNT = 3;

/** Kinds listed as notes whatever their engine severity. */
export const NOTE_KINDS: ReadonlySet<string> = new Set(["title-sizes-inconsistent"]);

/** Whether a listed finding counts as a note (info severity, or a note-level kind). */
export function isNoteLevel(f: Pick<Finding, "kind" | "severity">): boolean {
  return f.severity === "info" || NOTE_KINDS.has(f.kind);
}

const isProblem = (f: Finding) => !isNoteLevel(f);

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function baseName(partName: string): string {
  return partName.slice(partName.lastIndexOf("/") + 1) || partName;
}

export function headlineText(problemCount: number): string {
  if (problemCount === 0) return "Ready for show";
  return `${problemCount} ${problemCount === 1 ? "problem" : "problems"} to fix`;
}

export function buildProblems(findings: readonly Finding[]): ProblemsModel {
  const byCategory = new Map<ProblemCategoryId, Finding[]>(PROBLEM_CATEGORIES.map((id) => [id, []]));
  let size: SizeSummary | undefined;
  const media: LargestMedia[] = [];
  let fontList: ProblemsModel["fontList"];

  for (const f of findings) {
    const id = problemCategoryOf(f.kind);
    if (id) {
      byCategory.get(id)!.push(f);
      continue;
    }
    if (f.kind === "file-size-breakdown") {
      size = { totalBytes: num(f.data.totalBytes), mediaBytes: num(f.data.categories?.media), largest: [] };
    } else if (f.kind === "media-size") {
      const partName = typeof f.data.partName === "string" ? f.data.partName : f.group;
      const item: LargestMedia = { name: baseName(partName), partName, bytes: num(f.data.bytes) };
      if (typeof f.data.mediaKind === "string") item.mediaKind = f.data.mediaKind;
      media.push(item);
    } else if (f.kind === "font-availability-summary") {
      fontList = { teamListProvided: f.data.teamListProvided === true };
    }
  }

  if (size) size.largest = [...media].sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_COUNT);

  const categories = PROBLEM_CATEGORIES.map((id): ProblemCategory => {
    const all = byCategory.get(id)!;
    const problems = all.filter(isProblem);
    const infos = all.filter((f) => !isProblem(f));
    const intentional = id === "text-collision" ? infos : [];
    const listedInfos = id === "text-collision" ? [] : infos;
    const status: CategoryStatus = problems.length > 0 ? "warning" : infos.length > 0 ? "note" : "pass";
    return {
      id,
      label: CATEGORY_LABELS[id],
      status,
      warnings: problems.length,
      notes: infos.length,
      findings: [...problems, ...listedInfos],
      intentional,
    };
  });

  const missing = byCategory.get("fonts")!.filter((f) => f.kind === "font-maybe-missing");
  const typeface = (f: Finding) => (f.kind === "font-maybe-missing" ? f.data.typeface : f.group);
  const problemCount = categories.reduce((n, c) => n + c.warnings, 0);

  return {
    categories,
    problemCount,
    ready: problemCount === 0,
    headline: headlineText(problemCount),
    ...(size ? { size } : {}),
    ...(fontList ? { fontList } : {}),
    missingFonts: missing.map(typeface),
    reachableMissingFonts: missing.filter(hasReachableTarget).map(typeface),
  };
}
