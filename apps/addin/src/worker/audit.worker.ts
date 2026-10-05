/**
 * The audit Web Worker (U4, KTD3). Receives `{type:'scan', bytes, hash, options}`, runs the
 * audit-core checks with the snapshot-hash cache (KTD6), and posts per-area progress followed by
 * one `result` or `error`. The handler is exported so it can be exercised in-process by tests.
 *
 * Each result carries a `ScanInventory` (U11: every scanned slide and shape) built from the SAME
 * parsed presentation the checks used (captured through `runChecks`' `parse` option, so the deck
 * is parsed once). Inventories are cached by snapshot hash next to the result cache, so a cache
 * hit returns the inventory without re-parsing (the inventory depends only on the bytes).
 */
import { isPackageError, loadPresentation, runChecksCached, type Presentation } from "@slidefidelity/audit-core";
import { buildScanInventory, type ScanInventory } from "../inspector/model";
import type { ScanRequest, WorkerResponse } from "./client";

/** Realm-independent (instanceof fails across realms, e.g. after structured clone in tests). */
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === "[object ArrayBuffer]";

/** Small LRU of inventories keyed by snapshot hash (plain object, like the audit cache). */
export interface InventoryCache {
  readonly max: number;
  readonly entries: Map<string, ScanInventory>;
}

export function createInventoryCache(max = 4): InventoryCache {
  return { max, entries: new Map() };
}

const defaultInventoryCache = createInventoryCache();

function remember(cache: InventoryCache, hash: string, inv: ScanInventory): void {
  cache.entries.delete(hash);
  cache.entries.set(hash, inv);
  while (cache.entries.size > cache.max) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
}

function recall(cache: InventoryCache, hash: string): ScanInventory | undefined {
  const hit = cache.entries.get(hash);
  if (hit) remember(cache, hash, hit);
  return hit;
}

export interface WorkerDeps {
  run?: typeof runChecksCached;
  /** Parser handed to the runner (and used for the rare inventory-only fallback). */
  parse?: (bytes: Uint8Array) => Promise<Presentation>;
  inventoryCache?: InventoryCache;
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
  const parse = deps.parse ?? ((b: Uint8Array) => loadPresentation(b));
  const inventories = deps.inventoryCache ?? defaultInventoryCache;
  const bytes = new Uint8Array(msg.bytes);
  try {
    let parsed: Presentation | undefined;
    const result = await run(bytes, msg.hash, msg.options ?? {}, {
      onProgress: (e) => post({ type: "progress", id, ...e }),
      parse: async (input) => {
        parsed = await parse(input as Uint8Array);
        return parsed;
      },
    });
    let inventory: ScanInventory | undefined;
    if (parsed) {
      inventory = await buildScanInventory(parsed);
      remember(inventories, msg.hash, inventory);
    } else {
      // Result-cache hit: the runner did not parse. Reuse the inventory for this snapshot.
      inventory = recall(inventories, msg.hash);
      if (!inventory) {
        // Evicted (rare): build it once more. Never fail the scan over the inventory.
        try {
          inventory = await buildScanInventory(await parse(bytes));
          remember(inventories, msg.hash, inventory);
        } catch {
          inventory = undefined;
        }
      }
    }
    post({ type: "result", id, result, ...(inventory ? { inventory } : {}) });
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
