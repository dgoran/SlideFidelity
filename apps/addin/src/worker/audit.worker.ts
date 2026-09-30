/**
 * The audit Web Worker (U4, KTD3). Receives `{type:'scan', bytes, hash, options}`, runs the
 * audit-core checks with the snapshot-hash cache (KTD6), and posts per-area progress followed by
 * one `result` or `error`. The handler is exported so it can be exercised in-process by tests.
 */
import { isPackageError, runChecksCached } from "@slidecheck/audit-core";
import type { ScanRequest, WorkerResponse } from "./client";

/** Realm-independent (instanceof fails across realms, e.g. after structured clone in tests). */
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === "[object ArrayBuffer]";

export interface WorkerDeps {
  run?: typeof runChecksCached;
}

export async function handleWorkerMessage(
  msg: ScanRequest,
  post: (m: WorkerResponse) => void,
  deps: WorkerDeps = {},
): Promise<void> {
  const id = typeof msg?.id === "number" ? msg.id : -1;
  if (!msg || msg.type !== "scan" || !isArrayBuffer(msg.bytes) || typeof msg.hash !== "string") {
    post({ type: "error", id, code: "bad-request", message: "Expected {type:'scan', bytes: ArrayBuffer, hash}" });
    return;
  }
  const run = deps.run ?? runChecksCached;
  try {
    const result = await run(new Uint8Array(msg.bytes), msg.hash, msg.options ?? {}, {
      onProgress: (e) => post({ type: "progress", id, ...e }),
    });
    post({ type: "result", id, result });
  } catch (e) {
    if (isPackageError(e)) {
      post({ type: "error", id, code: e.code, message: e.message });
    } else {
      post({ type: "error", id, code: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  }
}

// Attach only inside a real dedicated worker (not when imported by tests in jsdom).
declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage = (e: MessageEvent<ScanRequest>) => {
    void handleWorkerMessage(e.data, (m) => scope.postMessage(m));
  };
}
