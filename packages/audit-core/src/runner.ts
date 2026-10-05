/**
 * The check runner (U4): parse the snapshot once, run every registered check in isolation, stream
 * per-area progress in fixed area order, and cache results by snapshot hash (KTD6).
 */
import { CHECKS } from "./checks/index";
import {
  AREAS,
  makeFinding,
  summarize,
  type Area,
  type AreaSummary,
  type Finding,
} from "./findings";
import { getShapes, loadPresentation, type Presentation } from "./package/model";
import type { PackageInput } from "./package/zip";

// ---------------------------------------------------------------------------------------------
// Options and checks

// Brand profile (R22) lives in brand.ts; re-exported here for check authors.
import type { BrandProfile } from "./brand";
export type { BrandProfile } from "./brand";

/** Serializable scan options (they cross the worker boundary and form part of the cache key). */
export interface AuditOptions {
  /** Active brand profile; absent means "derive from the deck's theme" (R22 default). */
  brand?: BrandProfile;
  /**
   * Fonts known to be installed on the presenting computers ("show machine fonts"). A font that is
   * not embedded, not on this list, and not one that ships with Microsoft Office on both Mac and
   * Windows is reported as possibly missing. Absent or empty means "no team list".
   */
  availableFonts?: string[];
  /**
   * Every font family name the SlideFidelity Helper reported as usable by PowerPoint on THIS computer
   * (system, user, Office private and Office cloud fonts that are present; family names from name
   * IDs 1/16/21 in all languages, so legacy and localized names are included), as a flat list.
   * Absent means "no helper"; an empty array means "helper present, nothing found". When present,
   * a used, non-embedded font not on this list is reported as missing on this computer.
   */
  localFonts?: string[];
}

export interface CheckContext {
  pres: Presentation;
  options: AuditOptions;
}

/**
 * A check: a pure function of the model and options (U4 approach 2). It may be async (shape
 * access via `getShapes` is async). Throwing or rejecting is isolated by the runner.
 */
export interface Check {
  /** Unique, stable, kebab-case, e.g. `fonts`, `colors-literal`. */
  id: string;
  area: Area;
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

// ---------------------------------------------------------------------------------------------
// Results

export interface ProgressEvent {
  /** The area that just finished. */
  area: Area;
  /** Areas finished so far (1-based). */
  completed: number;
  /** Always `AREAS.length`. */
  total: number;
}

export interface CheckError {
  checkId: string;
  area: Area;
  message: string;
}

export interface AuditStats {
  slides: number;
  /** Shapes on slides (all nesting levels; layouts and masters excluded). */
  shapes: number;
  durationMs: number;
  perArea: AreaSummary;
}

export interface AuditResult {
  /** Ordered by area (AREAS order), then check registration order, then check output order. */
  findings: Finding[];
  /** Snapshot SHA-256 (lower-case hex) when the caller supplied it. */
  hash?: string;
  stats: AuditStats;
  /** One entry per failed check; each also appears as a `check-failed` finding. */
  errors: CheckError[];
  /** True when served from the hash cache without re-parsing. */
  fromCache?: boolean;
}

export interface RunOptions {
  /** Checks to run; defaults to the registry `CHECKS`. */
  checks?: readonly Check[];
  onProgress?: (e: ProgressEvent) => void;
  /** Snapshot hash to stamp on the result. */
  hash?: string;
  /** Parser; injectable so tests can spy on it. Defaults to `loadPresentation`. */
  parse?: (bytes: PackageInput) => Promise<Presentation>;
}

// ---------------------------------------------------------------------------------------------
// Runner

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function errorInfo(e: unknown): { message: string; errorName?: string } {
  if (e instanceof Error) return { message: e.message, errorName: e.name };
  return { message: String(e) };
}

async function countSlideShapes(pres: Presentation): Promise<number> {
  let n = 0;
  for (const s of pres.slides) {
    n += (await getShapes(pres, { kind: "slide", partName: s.partName, slideId: s.slideId })).length;
  }
  return n;
}

/**
 * Parse `bytes` and run the checks. Package errors (`PackageError`: not-a-zip, not-a-pptx,
 * malformed-part) propagate; individual check failures do not.
 */
export async function runChecks(
  bytes: PackageInput,
  options: AuditOptions = {},
  run: RunOptions = {},
): Promise<AuditResult> {
  const started = now();
  const checks = run.checks ?? CHECKS;
  const pres = await (run.parse ?? loadPresentation)(bytes);
  const ctx: CheckContext = { pres, options };

  const findings: Finding[] = [];
  const errors: CheckError[] = [];
  const seen = new Map<string, number>();

  for (const [i, area] of AREAS.entries()) {
    for (const check of checks) {
      if (check.area !== area) continue;
      let out: Finding[];
      try {
        const res = await check.run(ctx);
        if (!Array.isArray(res)) throw new TypeError(`check "${check.id}" did not return an array`);
        out = res;
      } catch (e) {
        const info = errorInfo(e);
        errors.push({ checkId: check.id, area, message: info.message });
        out = [
          makeFinding({
            area,
            kind: "check-failed",
            severity: "error",
            title: `The ${area} check could not finish`,
            detail: info.message,
            group: "check-failed",
            targets: [],
            fixes: [],
            key: check.id,
            data: { checkId: check.id, ...info },
          }),
        ];
      }
      for (const f of out) {
        // Deterministic disambiguation of colliding ids (same deck ⇒ same order ⇒ same suffix).
        const n = (seen.get(f.id) ?? 0) + 1;
        seen.set(f.id, n);
        findings.push(n === 1 ? f : { ...f, id: `${f.id}~${n}` });
      }
    }
    run.onProgress?.({ area, completed: i + 1, total: AREAS.length });
  }

  const result: AuditResult = {
    findings,
    stats: {
      slides: pres.slides.length,
      shapes: await countSlideShapes(pres),
      durationMs: Math.max(0, now() - started),
      perArea: summarize(findings),
    },
    errors,
  };
  if (run.hash !== undefined) result.hash = run.hash;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Cache (KTD6)

/** A small LRU of results keyed by snapshot hash + options + check ids. Plain object, no class. */
export interface AuditCache {
  readonly max: number;
  readonly entries: Map<string, AuditResult>;
}

export function createAuditCache(max = 4): AuditCache {
  return { max, entries: new Map() };
}

const defaultCache = createAuditCache();

/** JSON with sorted object keys, so option objects compare structurally. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export interface CachedRunOptions extends Omit<RunOptions, "hash"> {
  cache?: AuditCache;
}

/**
 * Like `runChecks`, but returns the cached result without re-parsing when `hash`, `options`, and
 * the check set match a previous run. Progress is still reported for every area on a hit.
 */
export async function runChecksCached(
  bytes: PackageInput,
  hash: string,
  options: AuditOptions = {},
  run: CachedRunOptions = {},
): Promise<AuditResult> {
  const cache = run.cache ?? defaultCache;
  const checks = run.checks ?? CHECKS;
  const key = `${hash}\u0000${stableStringify(options)}\u0000${checks.map((c) => c.id).join(",")}`;

  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key);
    cache.entries.set(key, hit);
    for (const [i, area] of AREAS.entries()) run.onProgress?.({ area, completed: i + 1, total: AREAS.length });
    return { ...hit, fromCache: true };
  }

  const result = await runChecks(bytes, options, { ...run, checks, hash });
  result.fromCache = false;
  cache.entries.set(key, result);
  while (cache.entries.size > cache.max) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
  return result;
}
