import { describe, expect, it, vi } from "vitest";
import { AREAS, summarize, type AuditResult, type ProgressEvent } from "@slidecheck/audit-core";
import {
  AuditClientError,
  createAuditClient,
  type ScanRequest,
  type WorkerLike,
  type WorkerResponse,
} from "./client";
import { createAuditCache, runChecksCached } from "@slidecheck/audit-core";
import { corpusDeck } from "../../../../packages/audit-core/test/helpers/corpus";
import { createInventoryCache, handleWorkerMessage } from "./audit.worker";

/** A controllable Worker double: records posts; tests push responses with `emit`. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: Array<{ msg: ScanRequest; transfer: Transferable[] }> = [];
  terminated = false;
  postMessage(msg: ScanRequest, transfer: Transferable[]): void {
    this.posted.push({ msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  get lastId(): number {
    return this.posted[this.posted.length - 1]!.msg.id;
  }
}

function fakeResult(hash: string): AuditResult {
  return {
    findings: [],
    hash,
    stats: { slides: 1, shapes: 2, durationMs: 1, perArea: summarize([]) },
    errors: [],
  };
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = createAuditClient({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
}

describe("audit worker client", () => {
  it("posts bytes as a transferable and resolves with the result after progress in area order", async () => {
    const { client, workers } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const progress: string[] = [];
    const p = client.scan(bytes, "hash1", { brand: { fonts: ["Calibri"], colors: [], tolerance: 0 } }, {
      onProgress: (e) => progress.push(e.area),
    });
    const w = workers[0]!;
    const { msg, transfer } = w.posted[0]!;
    expect(msg).toMatchObject({ type: "scan", hash: "hash1", options: { brand: { fonts: ["Calibri"] } } });
    expect(msg.bytes).toBeInstanceOf(ArrayBuffer);
    expect(transfer).toEqual([msg.bytes]);
    AREAS.forEach((area, i) => w.emit({ type: "progress", id: msg.id, area, completed: i + 1, total: AREAS.length }));
    w.emit({ type: "result", id: msg.id, result: fakeResult("hash1") });
    await expect(p).resolves.toMatchObject({ result: { hash: "hash1" } });
    expect(progress).toEqual([...AREAS]);
  });

  it("copies instead of transferring when the view does not span its whole buffer", async () => {
    const { client, workers } = setup();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const p = client.scan(view, "h", {});
    const w = workers[0]!;
    const sent = w.posted[0]!.msg.bytes;
    expect(new Uint8Array(sent)).toEqual(new Uint8Array([1, 2, 3]));
    expect(backing.byteLength).toBe(6); // not detached
    w.emit({ type: "result", id: w.lastId, result: fakeResult("h") });
    await p;
  });

  it("reuses the worker across scans (so its hash cache survives)", async () => {
    const { client, workers } = setup();
    const p1 = client.scan(new Uint8Array([1]), "h", {});
    workers[0]!.emit({ type: "result", id: workers[0]!.lastId, result: fakeResult("h") });
    await p1;
    const p2 = client.scan(new Uint8Array([1]), "h", {});
    workers[0]!.emit({ type: "result", id: workers[0]!.lastId, result: fakeResult("h") });
    await p2;
    expect(workers).toHaveLength(1);
  });

  it("rejects with the mapped error code from the worker", async () => {
    const { client, workers } = setup();
    const p = client.scan(new Uint8Array([1]), "h", {});
    workers[0]!.emit({ type: "error", id: workers[0]!.lastId, code: "not-a-pptx", message: "a docx" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditClientError);
    expect(err).toMatchObject({ code: "not-a-pptx", message: "a docx" });
  });

  it("rejects with worker-crashed on an uncaught worker error and replaces the worker next time", async () => {
    const { client, workers } = setup();
    const p = client.scan(new Uint8Array([1]), "h", {});
    workers[0]!.crash("script error");
    await expect(p).rejects.toMatchObject({ code: "worker-crashed" });
    expect(workers[0]!.terminated).toBe(true);
    const p2 = client.scan(new Uint8Array([1]), "h", {});
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: "result", id: workers[1]!.lastId, result: fakeResult("h") });
    await p2;
  });

  it("cancel() terminates the worker and rejects with cancelled; late messages are ignored", async () => {
    const { client, workers } = setup();
    const onProgress = vi.fn();
    const p = client.scan(new Uint8Array([1]), "h", {}, { onProgress });
    const w = workers[0]!;
    const id = w.lastId;
    client.cancel();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(w.terminated).toBe(true);
    w.emit({ type: "progress", id, area: "fonts", completed: 2, total: 7 });
    expect(onProgress).not.toHaveBeenCalled();
    expect(client.busy).toBe(false);
  });

  it("an AbortSignal cancels the scan", async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    const p = client.scan(new Uint8Array([1]), "h", {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]!.terminated).toBe(true);
  });

  it("an already-aborted signal rejects without starting a worker", async () => {
    const { client, workers } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.scan(new Uint8Array([1]), "h", {}, { signal: ac.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(workers).toHaveLength(0);
  });

  it("a new scan supersedes a running one", async () => {
    const { client, workers } = setup();
    const p1 = client.scan(new Uint8Array([1]), "h1", {});
    const p2 = client.scan(new Uint8Array([2]), "h2", {});
    await expect(p1).rejects.toMatchObject({ code: "cancelled" });
    const w = workers[workers.length - 1]!;
    w.emit({ type: "result", id: w.lastId, result: fakeResult("h2") });
    await expect(p2).resolves.toMatchObject({ result: { hash: "h2" } });
  });

  it("dispose() terminates the worker", async () => {
    const { client, workers } = setup();
    const p = client.scan(new Uint8Array([1]), "h", {});
    client.dispose();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]!.terminated).toBe(true);
  });
});

/** Runs the real worker handler in-process behind the WorkerLike interface. */
class InProcessWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(private readonly deps?: Parameters<typeof handleWorkerMessage>[2]) {}
  postMessage(msg: ScanRequest): void {
    void handleWorkerMessage(
      structuredClone(msg),
      (m) => this.onmessage?.({ data: structuredClone(m) } as MessageEvent<WorkerResponse>),
      this.deps,
    );
  }
  terminate(): void {}
}

describe("audit worker handler", () => {
  it("streams progress from the runner and posts the result", async () => {
    const run = vi.fn(async (_bytes, hash: string, _opts, o?: { onProgress?: (e: ProgressEvent) => void }) => {
      AREAS.forEach((area, i) => o?.onProgress?.({ area, completed: i + 1, total: AREAS.length }));
      return fakeResult(hash);
    });
    const client = createAuditClient({ createWorker: () => new InProcessWorker({ run }) });
    const areas: string[] = [];
    const { result } = await client.scan(new Uint8Array([5, 6]), "hh", {}, { onProgress: (e) => areas.push(e.area) });
    expect(result.hash).toBe("hh");
    expect(areas).toEqual([...AREAS]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
  });

  it("maps a real PackageError code (garbage bytes -> not-a-zip)", async () => {
    const client = createAuditClient({ createWorker: () => new InProcessWorker() });
    await expect(client.scan(new Uint8Array([1, 2, 3]), "x", {})).rejects.toMatchObject({ code: "not-a-zip" });
  });

  it("maps unexpected errors to internal", async () => {
    const run = vi.fn(async () => {
      throw new Error("kaput");
    });
    const client = createAuditClient({ createWorker: () => new InProcessWorker({ run }) });
    await expect(client.scan(new Uint8Array([1]), "x", {})).rejects.toMatchObject({
      code: "internal",
      message: "kaput",
    });
  });

  it("rejects malformed requests with bad-request", async () => {
    const posted: WorkerResponse[] = [];
    await handleWorkerMessage({ type: "nope" } as unknown as ScanRequest, (m) => posted.push(m));
    expect(posted).toEqual([expect.objectContaining({ type: "error", code: "bad-request" })]);
  });
});

describe("audit worker scan inventory (U11)", () => {
  function realWorker() {
    const cache = createAuditCache();
    const inventoryCache = createInventoryCache();
    const parse = vi.fn(async (b: Uint8Array) => (await import("@slidecheck/audit-core")).loadPresentation(b));
    const run: typeof runChecksCached = (bytes, hash, options, o) => runChecksCached(bytes, hash, options, { ...o, cache });
    const client = createAuditClient({ createWorker: () => new InProcessWorker({ run, parse, inventoryCache }) });
    return { client, parse, inventoryCache };
  }

  it("returns the inventory with the result, parsing the deck once", async () => {
    const { client, parse } = realWorker();
    const bytes = await corpusDeck("fonts-hidden");
    const { result, inventory } = await client.scan(bytes.slice(), "fh", {});
    expect(result.fromCache).toBe(false);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(inventory?.slides.length).toBe(result.stats.slides);
    expect(inventory?.slides[0]?.shapes.map((s) => s.shapeId)).toContain(4);
  });

  it("a result-cache hit returns the cached inventory without re-parsing", async () => {
    const { client, parse } = realWorker();
    const bytes = await corpusDeck("fonts-hidden");
    const first = await client.scan(bytes.slice(), "fh", {});
    const again = await client.scan(bytes.slice(), "fh", {});
    expect(again.result.fromCache).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(again.inventory).toEqual(first.inventory);
  });

  it("rebuilds an evicted inventory on a result-cache hit", async () => {
    const { client, parse, inventoryCache } = realWorker();
    const bytes = await corpusDeck("fonts-hidden");
    const first = await client.scan(bytes.slice(), "fh", {});
    inventoryCache.entries.clear();
    const again = await client.scan(bytes.slice(), "fh", {});
    expect(again.result.fromCache).toBe(true);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(again.inventory).toEqual(first.inventory);
  });

  it("omits the inventory (without failing) when it cannot be built", async () => {
    const run = vi.fn(async (_b: unknown, hash: string) => fakeResult(hash));
    const client = createAuditClient({ createWorker: () => new InProcessWorker({ run, inventoryCache: createInventoryCache() }) });
    const out = await client.scan(new Uint8Array([1, 2]), "nope", {});
    expect(out.result.hash).toBe("nope");
    expect(out.inventory).toBeUndefined();
  });
});
