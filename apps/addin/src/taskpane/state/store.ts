/**
 * Pane state (D10): an explicit scan lifecycle plus the area picker and tree filters.
 * A plain reducer, testable without React or Office. The plan lives in `PlanProvider`
 * (`license/gate.ts`) so gating has a single source of truth.
 */
import { AREAS, type Area, type AuditResult, type ProgressEvent } from "@slidefidelity/audit-core";
import type { ScanInventory } from "../../inspector/model";
import type { ScanErrorKind, ScanPhase } from "../../office/scan";

export type AreaProgress = "pending" | "done";
/**
 * What the pane shows after a scan: the Problems checklist (G1, a pseudo-area shown first and
 * selected by default), the Overview, or one area.
 */
export type PaneView = "problems" | Area;
/** Scan settings that can change after a scan: the brand profile (D9), the show-machine fonts (G3). */
export type ScanOptionKind = "brand" | "show-fonts";
export type SeverityFilter = "all" | "warning" | "info";

export interface ReadyState {
  status: "ready";
  result: AuditResult;
  scannedAt: number;
  /** Optional D4 hint ("may be out of date"); never blocks anything. */
  possiblyOutdated: boolean;
  /** Every scanned slide and shape (U11 Inspector), when the worker built it. */
  inventory?: ScanInventory;
  /** The scan options (brand profile D9, show-machine fonts G3) changed after this scan: a rescan applies them. */
  optionsChanged?: boolean;
  /** Which settings changed, in order, when the dispatcher said so. */
  changedOptions?: readonly ScanOptionKind[];
}

export type ScanState =
  | { status: "not-scanned" }
  | {
      status: "scanning";
      phase: ScanPhase;
      areas: Record<Area, AreaProgress>;
      completed: number;
      total: number;
      /** Results to return to on cancel. */
      previous?: ReadyState;
    }
  | ReadyState
  | { status: "failed"; kind: ScanErrorKind; message: string; previous?: ReadyState };

export interface PaneState {
  scan: ScanState;
  area: PaneView;
  severity: SeverityFilter;
  search: string;
  /**
   * Tree rows whose expansion is flipped from the default (groups open, findings closed), per
   * area. Keys are `TreeRow.key` values from `model/tree.ts`; finding ids are deterministic, so
   * the state survives a rescan.
   */
  toggled: Record<Area, ReadonlySet<string>>;
}

export type PaneAction =
  | { type: "scan/started" }
  | { type: "scan/phase"; phase: ScanPhase }
  | ({ type: "scan/progress" } & ProgressEvent)
  | { type: "scan/succeeded"; result: AuditResult; scannedAt: number; inventory?: ScanInventory }
  | { type: "scan/failed"; kind: ScanErrorKind; message: string }
  | { type: "scan/cancelled" }
  | { type: "scan/possibly-outdated" }
  /** The audit options changed; results stay, with a "rescan to apply" hint. */
  | { type: "scan/options-changed"; option?: ScanOptionKind }
  | { type: "area/selected"; area: PaneView }
  | { type: "filter/severity"; severity: SeverityFilter }
  | { type: "filter/search"; search: string }
  | { type: "tree/toggle"; area: Area; key: string };

export function initialPaneState(): PaneState {
  return {
    scan: { status: "not-scanned" },
    area: "problems",
    severity: "all",
    search: "",
    toggled: Object.fromEntries(AREAS.map((a) => [a, new Set<string>()])) as unknown as Record<Area, ReadonlySet<string>>,
  };
}

/** True when the row's expansion differs from its default. */
export function isToggled(state: PaneState, area: Area, key: string): boolean {
  return state.toggled[area].has(key);
}

function previousResults(s: ScanState): ReadyState | undefined {
  if (s.status === "ready") return s;
  if (s.status === "scanning" || s.status === "failed") return s.previous;
  return undefined;
}

function scanReducer(s: ScanState, a: PaneAction): ScanState {
  switch (a.type) {
    case "scan/started": {
      const previous = previousResults(s);
      return {
        status: "scanning",
        phase: "reading",
        areas: Object.fromEntries(AREAS.map((x) => [x, "pending"])) as Record<Area, AreaProgress>,
        completed: 0,
        total: AREAS.length,
        ...(previous ? { previous } : {}),
      };
    }
    case "scan/phase":
      return s.status === "scanning" ? { ...s, phase: a.phase } : s;
    case "scan/progress":
      return s.status === "scanning"
        ? { ...s, phase: "auditing", areas: { ...s.areas, [a.area]: "done" }, completed: a.completed, total: a.total }
        : s;
    case "scan/succeeded":
      return {
        status: "ready",
        result: a.result,
        scannedAt: a.scannedAt,
        possiblyOutdated: false,
        ...(a.inventory ? { inventory: a.inventory } : {}),
      };
    case "scan/failed": {
      const previous = previousResults(s);
      return { status: "failed", kind: a.kind, message: a.message, ...(previous ? { previous } : {}) };
    }
    case "scan/cancelled":
      if (s.status !== "scanning") return s;
      return s.previous ?? { status: "not-scanned" };
    case "scan/possibly-outdated":
      return s.status === "ready" && !s.possiblyOutdated ? { ...s, possiblyOutdated: true } : s;
    case "scan/options-changed": {
      if (s.status !== "ready") return s;
      const known = s.changedOptions ?? [];
      if (s.optionsChanged && (a.option === undefined || known.includes(a.option))) return s;
      return { ...s, optionsChanged: true, ...(a.option ? { changedOptions: [...known, a.option] } : {}) };
    }
    default:
      return s;
  }
}

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case "area/selected":
      return state.area === action.area ? state : { ...state, area: action.area };
    case "filter/severity":
      return { ...state, severity: action.severity };
    case "filter/search":
      return { ...state, search: action.search };
    case "tree/toggle": {
      const next = new Set(state.toggled[action.area]);
      if (!next.delete(action.key)) next.add(action.key);
      return { ...state, toggled: { ...state.toggled, [action.area]: next } };
    }
    default: {
      const scan = scanReducer(state.scan, action);
      return scan === state.scan ? state : { ...state, scan };
    }
  }
}
