/**
 * Promise API over the audit Web Worker (U4, KTD3): transfers the snapshot bytes, streams per-area
 * progress, and supports cancellation by terminating the worker. The worker is reused across
 * scans so its snapshot-hash cache (KTD6) survives; it is recreated after cancel or a crash.
 */
import type { AuditOptions, AuditResult, PackageErrorCode, ProgressEvent } from "@slidecheck/audit-core";
import type { ScanInventory } from "../inspector/model";

// ---------------------------------------------------------------------------------------------
// Protocol (shared with audit.worker.ts)

export interface ScanRequest {
  type: "scan";
  /** Request id; responses echo it so stale messages are ignored. */
  id: number;
  /** The `.pptx` bytes, transferred (not copied). */
  bytes: ArrayBuffer;
  /** Lower-case hex SHA-256 of the bytes (from `readSnapshot`). */
  hash: string;
  options: AuditOptions;
}

export type WorkerErrorCode = PackageErrorCode | "bad-request" | "internal";

export type WorkerResponse =
  | ({ type: "progress"; id: number } & ProgressEvent)
  | { type: "result"; id: number; result: AuditResult; inventory?: ScanInventory }
  | { type: "error"; id: number; code: WorkerErrorCode; message: string };

// ---------------------------------------------------------------------------------------------
// Client

export type AuditClientErrorCode = WorkerErrorCode | "cancelled" | "worker-crashed";

export class AuditClientError extends Error {
  readonly code: AuditClientErrorCode;
  constructor(code: AuditClientErrorCode, message: string) {
    super(message);
    this.name = "AuditClientError";
    this.code = code;
  }
}

/** The subset of `Worker` the client uses; inject a fake in tests. */
export interface WorkerLike {
  postMessage(message: ScanRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** Webpack 5 bundles the worker from this `new Worker(new URL(...))` pattern natively. */
export function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./audit.worker.ts", import.meta.url)) as unknown as WorkerLike;
}

/** One scan's output: the audit result plus the scan inventory (U11), when it could be built. */
export interface AuditScan {
  result: AuditResult;
  inventory?: ScanInventory;
}

export interface ScanOptions {
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface AuditClient {
  /**
   * Scan a snapshot. When `bytes` spans its whole buffer, the buffer is transferred and the
   * caller's view becomes detached (length 0); otherwise the bytes are copied. A new scan
   * cancels a running one.
   */
  scan(bytes: Uint8Array | ArrayBuffer, hash: string, options: AuditOptions, scan?: ScanOptions): Promise<AuditScan>;
  /** Cancel the running scan (terminates the worker). No-op when idle. */
  cancel(): void;
  /** Cancel and release the worker. */
  dispose(): void;
  readonly busy: boolean;
}

export interface AuditClientConfig {
  createWorker?: () => WorkerLike;
}

interface Pending {
  id: number;
  resolve: (r: AuditScan) => void;
  reject: (e: AuditClientError) => void;
  onProgress?: (e: ProgressEvent) => void;
  cleanup: () => void;
}

function toTransferable(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (!ArrayBuffer.isView(bytes)) return bytes;
  const buf = bytes.buffer;
  if (Object.prototype.toString.call(buf) === "[object ArrayBuffer]" && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return buf as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

export function createAuditClient(config: AuditClientConfig = {}): AuditClient {
  const createWorker = config.createWorker ?? defaultWorkerFactory;
  let worker: WorkerLike | null = null;
  let pending: Pending | null = null;
  let nextId = 1;

  const settle = (): Pending | null => {
    const p = pending;
    pending = null;
    p?.cleanup();
    return p;
  };

  const killWorker = (): void => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (e) => {
      const msg = e.data;
      if (!pending || msg.id !== pending.id) return; // stale or superseded
      if (msg.type === "progress") {
        pending.onProgress?.({ area: msg.area, completed: msg.completed, total: msg.total });
      } else if (msg.type === "result") {
        settle()?.resolve(msg.inventory ? { result: msg.result, inventory: msg.inventory } : { result: msg.result });
      } else {
        settle()?.reject(new AuditClientError(msg.code, msg.message));
      }
    };
    w.onerror = (e) => {
      killWorker();
      settle()?.reject(new AuditClientError("worker-crashed", e.message || "The audit worker crashed"));
    };
    worker = w;
    return w;
  };

  const cancel = (): void => {
    if (!pending) return;
    killWorker();
    settle()?.reject(new AuditClientError("cancelled", "Scan cancelled"));
  };

  return {
    get busy() {
      return pending !== null;
    },
    cancel,
    dispose() {
      cancel();
      killWorker();
    },
    scan(bytes, hash, options, scan = {}) {
      cancel();
      if (scan.signal?.aborted) return Promise.reject(new AuditClientError("cancelled", "Scan cancelled"));
      return new Promise<AuditScan>((resolve, reject) => {
        const id = nextId++;
        const onAbort = (): void => {
          if (pending?.id === id) cancel();
        };
        scan.signal?.addEventListener("abort", onAbort, { once: true });
        pending = {
          id,
          resolve,
          reject,
          onProgress: scan.onProgress,
          cleanup: () => scan.signal?.removeEventListener("abort", onAbort),
        };
        const buf = toTransferable(bytes);
        const msg: ScanRequest = { type: "scan", id, bytes: buf, hash, options };
        try {
          ensureWorker().postMessage(msg, [buf]);
        } catch (e) {
          killWorker();
          settle()?.reject(new AuditClientError("worker-crashed", e instanceof Error ? e.message : String(e)));
        }
      });
    },
  };
}
