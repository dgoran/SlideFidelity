/**
 * Scan orchestration (U10, D4, D10): read the snapshot → audit it in the worker → result.
 *
 * Hook-free and Office-free when its dependencies are injected. Keeps the last
 * `{hash, bytes, result}` so fixes can rescan cheaply (`rescanForFix`, D4) and so the pre-fix
 * bytes stay available (D16). Every failure surfaces as a `ScanError` with a user-facing kind.
 */
import { isPackageError, type AuditOptions, type AuditResult, type ProgressEvent } from "@slidecheck/audit-core";
import { AuditClientError, createAuditClient, type AuditClient } from "../worker/client";
import { SnapshotError, readSnapshot as defaultReadSnapshot, type Snapshot } from "./snapshot";

// ---------------------------------------------------------------------------------------------
// Errors

export type ScanErrorKind =
  | "cancelled"
  /** getFileAsync / getSliceAsync failed (on the web: often "not saved yet"). */
  | "read-failed"
  /** The document has no bytes (nothing to scan). */
  | "empty"
  /** Not a ZIP or not a PowerPoint package. */
  | "not-a-presentation"
  /** A required part is missing or unreadable. */
  | "damaged-file"
  /** The audit worker crashed (often out of memory on a huge deck). */
  | "audit-crashed"
  | "internal";

export class ScanError extends Error {
  readonly kind: ScanErrorKind;
  constructor(kind: ScanErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanError";
    this.kind = kind;
  }
}

function fromCode(code: string): ScanErrorKind {
  switch (code) {
    case "cancelled":
      return "cancelled";
    case "open-failed":
    case "slice-failed":
      return "read-failed";
    case "empty-document":
      return "empty";
    case "not-a-zip":
    case "not-a-pptx":
      return "not-a-presentation";
    case "malformed-part":
      return "damaged-file";
    case "worker-crashed":
      return "audit-crashed";
    default:
      return "internal";
  }
}

/** Map SnapshotError / PackageError / AuditClientError / anything to a ScanError. */
export function toScanError(e: unknown): ScanError {
  if (e instanceof ScanError) return e;
  if (e instanceof SnapshotError || e instanceof AuditClientError || isPackageError(e)) {
    return new ScanError(fromCode(e.code), e.message, { cause: e });
  }
  return new ScanError("internal", e instanceof Error ? e.message : String(e), { cause: e });
}

// ---------------------------------------------------------------------------------------------
// Service

export type ScanPhase = "reading" | "auditing";

export interface ScanRunOptions {
  onPhase?: (phase: ScanPhase) => void;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface LastScan {
  hash: string;
  /** The scanned `.pptx` bytes (the service's own copy; D16 "pre-fix copy"). */
  bytes: Uint8Array;
  result: AuditResult;
  /** Serialized audit options the result was computed with. */
  optionsKey: string;
  scannedAt: number;
}

export interface RescanForFixResult {
  result: AuditResult;
  /** False when the file hash and options were unchanged and the cached result was reused. */
  changed: boolean;
  hash: string;
  bytes: Uint8Array;
}

export interface ScanService {
  /** Full scan (the pane's Scan/Rescan button). A new scan cancels a running one. */
  scan(options?: ScanRunOptions): Promise<AuditResult>;
  /**
   * D4: re-read the file; unchanged hash (and options) → the cached result, else a full rescan.
   * U12 calls this before every fix and re-plans when `changed` is true.
   */
  rescanForFix(options?: ScanRunOptions): Promise<RescanForFixResult>;
  /** Cancel the running scan; its promise rejects with kind `cancelled`. */
  cancel(): void;
  readonly last: LastScan | null;
  readonly busy: boolean;
  dispose(): void;
}

export interface ScanServiceDeps {
  readSnapshot?: () => Promise<Snapshot>;
  client?: Pick<AuditClient, "scan" | "cancel" | "dispose">;
  /** Current audit options (brand profile). Read at the start of each scan. */
  getOptions?: () => AuditOptions;
  now?: () => number;
}

function optionsKey(o: AuditOptions): string {
  return JSON.stringify(o, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export function createScanService(deps: ScanServiceDeps = {}): ScanService {
  const read = deps.readSnapshot ?? (() => defaultReadSnapshot());
  let client = deps.client;
  const getClient = () => (client ??= createAuditClient());
  const getOptions = deps.getOptions ?? (() => ({}));
  const now = deps.now ?? (() => Date.now());

  let last: LastScan | null = null;
  let running: AbortController | null = null;

  function begin(external?: AbortSignal): AbortController {
    running?.abort();
    const ctrl = new AbortController();
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    running = ctrl;
    return ctrl;
  }

  function assertLive(ctrl: AbortController): void {
    if (ctrl.signal.aborted) throw new ScanError("cancelled", "Scan cancelled");
  }

  async function readFile(ctrl: AbortController, o: ScanRunOptions): Promise<Snapshot> {
    o.onPhase?.("reading");
    const snap = await read();
    assertLive(ctrl);
    return snap;
  }

  async function audit(ctrl: AbortController, snap: Snapshot, o: ScanRunOptions): Promise<AuditResult> {
    o.onPhase?.("auditing");
    const opts = getOptions();
    const keep = snap.bytes.slice();
    // The client transfers its input buffer to the worker, so hand it a separate copy.
    const result = await getClient().scan(snap.bytes, snap.sha256, opts, {
      signal: ctrl.signal,
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    assertLive(ctrl);
    last = { hash: snap.sha256, bytes: keep, result, optionsKey: optionsKey(opts), scannedAt: now() };
    return result;
  }

  async function guarded<T>(o: ScanRunOptions, body: (ctrl: AbortController) => Promise<T>): Promise<T> {
    const ctrl = begin(o.signal);
    try {
      return await body(ctrl);
    } catch (e) {
      throw ctrl.signal.aborted ? new ScanError("cancelled", "Scan cancelled", { cause: e }) : toScanError(e);
    } finally {
      if (running === ctrl) running = null;
    }
  }

  return {
    get last() {
      return last;
    },
    get busy() {
      return running !== null;
    },
    scan(o = {}) {
      return guarded(o, async (ctrl) => audit(ctrl, await readFile(ctrl, o), o));
    },
    rescanForFix(o = {}) {
      return guarded(o, async (ctrl) => {
        const snap = await readFile(ctrl, o);
        const prev = last;
        if (prev && prev.hash === snap.sha256 && prev.optionsKey === optionsKey(getOptions())) {
          return { result: prev.result, changed: false, hash: prev.hash, bytes: prev.bytes };
        }
        const result = await audit(ctrl, snap, o);
        return { result, changed: true, hash: snap.sha256, bytes: last!.bytes };
      });
    },
    cancel() {
      if (!running) return;
      running.abort();
      client?.cancel();
    },
    dispose() {
      running?.abort();
      client?.dispose();
    },
  };
}
