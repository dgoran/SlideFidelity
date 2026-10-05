/**
 * Host capability probe (R17, KTD4, AE4).
 *
 * Probes `Office.context.requirements.isSetSupported('PowerPointApi', v)` once for 1.3–1.10 and
 * exposes feature flags. The UI disables unsupported actions and shows `explain(feature)` as the
 * reason. Injectable: pass any `{ isSetSupported }` (tests use `capabilitiesUpTo`).
 */

export const API_VERSIONS = ["1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10"] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];

export type CapabilityFeature =
  | "navigateSlide"
  | "selectSlides"
  | "selectShapes"
  | "replaceFonts"
  | "replaceColors"
  | "deleteShapes"
  | "tablesGroups"
  | "hyperlinkEdit"
  | "hyperlinkRemove"
  | "shapeVisible"
  | "themeColors"
  | "setTitleSize"
  | "removeSlideNumbers";

/** Minimum `PowerPointApi` version per feature (KTD4). */
export const FEATURE_MIN_VERSION: Record<CapabilityFeature, ApiVersion> = {
  // Slide-only navigation uses the common-API `goToByIdAsync`, available at the manifest minimum.
  navigateSlide: "1.3",
  selectSlides: "1.5",
  selectShapes: "1.5",
  replaceFonts: "1.4",
  replaceColors: "1.4",
  deleteShapes: "1.4",
  tablesGroups: "1.8",
  hyperlinkEdit: "1.6",
  hyperlinkRemove: "1.10",
  shapeVisible: "1.10",
  themeColors: "1.10",
  setTitleSize: "1.4",
  removeSlideNumbers: "1.4",
};

export interface RequirementsLike {
  isSetSupported(name: string, minVersion?: string): boolean;
}

export interface Capabilities {
  versions: Readonly<Record<ApiVersion, boolean>>;
  /** Highest supported version, or null when even 1.3 is missing. */
  highest: ApiVersion | null;
  flags: Readonly<Record<CapabilityFeature, boolean>>;
  supports(feature: CapabilityFeature): boolean;
  /** Why a feature is unavailable ("Requires a newer version of PowerPoint (PowerPointApi 1.10)"), else null. */
  explain(feature: CapabilityFeature): string | null;
}

function build(versions: Record<ApiVersion, boolean>): Capabilities {
  let highest: ApiVersion | null = null;
  for (const v of API_VERSIONS) if (versions[v]) highest = v;
  const flags = Object.fromEntries(
    (Object.keys(FEATURE_MIN_VERSION) as CapabilityFeature[]).map((f) => [f, versions[FEATURE_MIN_VERSION[f]]]),
  ) as Record<CapabilityFeature, boolean>;
  return {
    versions,
    highest,
    flags,
    supports: (f) => flags[f],
    explain: (f) => (flags[f] ? null : `Requires a newer version of PowerPoint (PowerPointApi ${FEATURE_MIN_VERSION[f]})`),
  };
}

export function probeCapabilities(req: RequirementsLike | undefined): Capabilities {
  const versions = {} as Record<ApiVersion, boolean>;
  for (const v of API_VERSIONS) {
    let ok = false;
    try {
      ok = !!req?.isSetSupported("PowerPointApi", v);
    } catch {
      ok = false;
    }
    versions[v] = ok;
  }
  return build(versions);
}

/** A host that supports every version up to and including `max` (tests, previews). */
export function capabilitiesUpTo(max: ApiVersion | null): Capabilities {
  const limit = max === null ? -1 : API_VERSIONS.indexOf(max);
  return build(Object.fromEntries(API_VERSIONS.map((v, i) => [v, i <= limit])) as Record<ApiVersion, boolean>);
}

let cached: Capabilities | undefined;

/** Probe the running host once (after `Office.onReady`) and cache the answer. */
export function getHostCapabilities(): Capabilities {
  if (!cached) {
    const req = typeof Office !== "undefined" ? (Office.context?.requirements as RequirementsLike | undefined) : undefined;
    cached = probeCapabilities(req);
  }
  return cached;
}
