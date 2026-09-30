/**
 * Fix engine contract (U12) shared by the fix actions (U13) and the fix UI.
 *
 * A fix kind turns findings + user parameters into a plan (pure, no Office calls), then applies the
 * plan to the live deck in batches. Everything in a plan is plain data so the UI can render the
 * preview (R16) and keep it across renders.
 */
import type { Finding, FindingTarget, FixKind } from "@slidecheck/audit-core";

export type FixKindId = FixKind;

/** `PowerPointApi` requirement-set check, e.g. `(v) => Office.context.requirements.isSetSupported("PowerPointApi", v)`. */
export type IsSetSupported = (version: string) => boolean;

/** The one `PowerPoint.run` overload the engine uses (injectable; tests pass a fake). */
export type PowerPointRun = <T>(batch: (context: PowerPoint.RequestContext) => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------------------------
// Parameters (D11)

export interface ReplaceFontParams {
  /** Font family names to replace (case-insensitive), e.g. ["Arial"]. */
  from: string[];
  /** Replacement family name; the theme fonts are passed by their resolved name. */
  to: string;
}

export interface ReplaceColorParams {
  /** Literal colors to replace, `RRGGBB` or `#RRGGBB` (case-insensitive). */
  from: string[];
  /** Replacement color, `RRGGBB` or `#RRGGBB`. A theme swatch is passed as its current RGB. */
  to: string;
}

/**
 * Which targets a fix acts on. Exactly one selector: every eligible target (`all`), the targets of
 * the given findings, or individual targets by `targetKey()` (audit-core).
 */
export type TargetSelection = { all: true } | { findingIds: string[] } | { targetKeys: string[] };

export type DeleteShapesParams = TargetSelection;

export type EditHyperlinkParams = {
  /** The current address (exactly as the scan reported it). */
  address: string;
  /** New address: http, https, or mailto only. */
  newAddress: string;
} & Partial<{ findingIds: string[]; targetKeys: string[] }>;

export type RemoveHyperlinkParams =
  | { addresses: string[] }
  | { findingIds: string[] }
  | { targetKeys: string[] }
  | { all: true };

export interface FixParamsMap {
  "replace-font": ReplaceFontParams;
  "replace-color": ReplaceColorParams;
  "delete-shapes": DeleteShapesParams;
  "edit-hyperlink": EditHyperlinkParams;
  "remove-hyperlink": RemoveHyperlinkParams;
}

// ---------------------------------------------------------------------------------------------
// Plans

/** What to do to one live object. Kinds narrow on `op.type`. */
export type FixOp =
  | { type: "font-text" }
  | { type: "font-cell"; cell: { row: number; col: number } }
  | { type: "color-fill" }
  | { type: "color-line" }
  | { type: "color-text" }
  | { type: "color-cell-fill"; cell: { row: number; col: number } }
  | { type: "color-cell-text"; cell: { row: number; col: number } }
  | { type: "delete-shape" }
  | { type: "hyperlink"; address: string; occurrence: number; sameAddressCount: number };

/**
 * One unit of work on one live object (a shape's text, a shape's fill, a table cell, a hyperlink).
 * Several finding targets can merge into one unit (e.g. three Arial runs in one text box), so
 * counts in the preview and the summary are per unit.
 */
export interface PlannedTarget {
  /** Unique within the plan. */
  key: string;
  slideId: number;
  slideIndex?: number;
  slideNumber?: number;
  /** OOXML shape id (`p:cNvPr/@id`). */
  shapeId: number;
  shapeName: string;
  /** Snapshot position in points, for the name + position fallback. */
  left: number;
  top: number;
  /** Ancestor group ids, outermost first. */
  path: number[];
  /** Display label, e.g. "Slide 3 · Title 1 (cell 2,1)". Untrusted deck text: render as text. */
  label: string;
  op: FixOp;
  /** The finding targets this unit covers. */
  sources: FindingTarget[];
  findingIds: string[];
  /** Units with the same batch key are always applied in the same batch. */
  batchKey?: string;
}

export interface UnreachableTarget {
  target: FindingTarget;
  findingId: string;
  label: string;
  /** Plain-language reason, e.g. "Inside a chart". */
  reason: string;
}

export interface SlideCount {
  slideId: number;
  slideNumber?: number;
  count: number;
}

export interface FixPlan<K extends FixKindId = FixKindId> {
  kind: K;
  params: FixParamsMap[K];
  destructive: boolean;
  targets: PlannedTarget[];
  unreachable: UnreachableTarget[];
  /** Reachable units per slide, in slide order. */
  perSlide: SlideCount[];
  /** Disclosures the preview must show (undo caveat, fixed-color caveat, ...). */
  notes: string[];
}

/** What a kind's `plan` returns; the engine adds `kind`, `params`, `perSlide`, and shared notes. */
export interface KindPlan {
  targets: PlannedTarget[];
  unreachable: UnreachableTarget[];
  notes?: string[];
}

export interface PlanEnv {
  isSetSupported: IsSetSupported;
}

// ---------------------------------------------------------------------------------------------
// Apply

/**
 * - changed: the write was committed.
 * - skipped: the engine decided not to write (not found, identity uncertain, no longer matches).
 * - failed: an error before anything in the batch was written; nothing changed.
 * - unknown: the batch's write sync threw. Office.js batches are not atomic, so the target may or
 *   may not have changed; a rescan tells.
 */
export type OutcomeStatus = "changed" | "skipped" | "failed" | "unknown";

export interface TargetOutcome {
  status: OutcomeStatus;
  reason?: string;
}

export interface TargetResult extends TargetOutcome {
  target: PlannedTarget;
}

/**
 * I/O for a kind's `apply`. A kind does all its reads with `sync()`, then queues its writes and
 * returns. The engine commits the queued writes with one final `context.sync()`. A kind must not
 * call `sync()` after queuing a write (any sync flushes queued writes), so "nothing written" (a
 * read failed: `failed`) stays distinguishable from "maybe written" (the commit failed: `unknown`).
 */
export interface ApplyIO {
  sync(): Promise<void>;
  isSetSupported: IsSetSupported;
}

export interface FixKindDef<K extends FixKindId> {
  id: K;
  /** Minimum `PowerPointApi` version for the kind as a whole (KTD4). */
  requiredSet: string;
  destructive: boolean;
  /** Returns a reason when the params are unusable, else null. */
  validate(params: FixParamsMap[K]): string | null;
  plan(findings: readonly Finding[], params: FixParamsMap[K], env: PlanEnv): KindPlan;
  /**
   * Outcomes aligned with `batch`; `changed` means "write queued" (the engine commits and turns
   * it into `unknown` if the commit fails).
   */
  apply(context: PowerPoint.RequestContext, batch: readonly PlannedTarget[], io: ApplyIO, params: FixParamsMap[K]): Promise<TargetOutcome[]>;
}

// ---------------------------------------------------------------------------------------------
// Engine results

export type PreviewResult<K extends FixKindId = FixKindId> =
  | { status: "blocked"; reason: string; requiredSet: string }
  | { status: "invalid"; reason: string }
  | { status: "ready"; plan: FixPlan<K> };

/** Structural match for `ScanService.rescanForFix()` (apps/addin/src/office/scan.ts). */
export interface RescanForFix {
  (): Promise<{ changed: boolean; hash: string; bytes: Uint8Array; result: { findings: readonly Finding[] } }>;
}

export interface FixProgress {
  batch: number;
  batches: number;
  done: number;
  total: number;
}

export interface RunFixDeps {
  rescanForFix: RescanForFix;
  run: PowerPointRun;
  isSetSupported: IsSetSupported;
  onProgress?: (p: FixProgress) => void;
  signal?: AbortSignal;
  /** Called once after any batch was attempted (mark the scan stale / trigger the post-fix rescan). */
  onApplied?: () => void;
  /** Targets per batch (default `BATCH_SIZE`). */
  batchSize?: number;
}

export interface FixSummary<K extends FixKindId = FixKindId> {
  plan: FixPlan<K>;
  results: TargetResult[];
  changed: number;
  skipped: TargetResult[];
  failed: TargetResult[];
  unknown: TargetResult[];
  /** Targets not attempted because the run was cancelled. */
  notRun: PlannedTarget[];
  unreachable: UnreachableTarget[];
  batches: number;
  completedBatches: number;
  /** The file the fix started from (D16 "Open pre-fix copy"). */
  preFixBytes: Uint8Array;
  preFixHash: string;
}

export type RunFixResult<K extends FixKindId = FixKindId> =
  | { status: "blocked"; reason: string; requiredSet: string }
  | { status: "invalid"; reason: string }
  /** D4: the file changed since the preview; show this new plan and ask again. Nothing was written. */
  | { status: "replanned"; plan: FixPlan<K>; hash: string }
  | { status: "completed" | "cancelled"; summary: FixSummary<K> };
