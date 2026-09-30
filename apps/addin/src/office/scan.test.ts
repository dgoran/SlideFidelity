import { describe, expect, it, vi } from "vitest";
import { PackageError, summarize, type AuditOptions, type AuditResult, type ProgressEvent } from "@slidecheck/audit-core";
import { AuditClientError, type AuditClient, type AuditScan } from "../worker/client";
import { SnapshotError, type Snapshot } from "./snapshot";
import { ScanError, createScanService, toScanError } from "./scan";

function result(hash: string): AuditResult {
  return { findings: [], hash, stats: { slides: 3, shapes: 9, durationMs: 1, perArea: summarize([]) }, errors: [] };
}

function snapshot(hash: string, bytes = [1, 2, 3]): Snapshot {
  return { bytes: Uint8Array.from(bytes), sha256: hash, sliceCount: 1 };
}

type ScanFn = AuditClient["scan"];

function fakeClient(impl?: ScanFn) {
  const scan = vi.fn<ScanFn>(
    impl ??
      (async (_bytes, hash, _opts, s) => {
        s?.onProgress?.({ area: "overview", completed: 1, total: 7 });
        s?.onProgress?.({ area: "fonts", completed: 2, total: 7 });
        return { result: result(hash) };
      }),
  );
  return { scan, cancel: vi.fn(), dispose: vi.fn(), busy: false } satisfies AuditClient;
}

describe("scan service", () => {
  it("reads the snapshot, scans it in the worker, and reports phases and progress", async () => {
    const client = fakeClient();
    const svc = createScanService({ readSnapshot: async () => snapshot("h1"), client, now: () => 42 });
    const phases: string[] = [];
    const progress: ProgressEvent[] = [];
    const r = await svc.scan({ onPhase: (p) => phases.push(p), onProgress: (e) => progress.push(e) });
    expect(r.hash).toBe("h1");
    expect(phases).toEqual(["reading", "auditing"]);
    expect(progress.map((p) => p.area)).toEqual(["overview", "fonts"]);
    expect(svc.last?.hash).toBe("h1");
    expect(svc.last?.scannedAt).toBe(42);
    expect(Array.from(svc.last!.bytes)).toEqual([1, 2, 3]);
  });

  it("keeps its own copy of the bytes even though the client transfers (detaches) its input", async () => {
    const client = fakeClient(async (bytes, hash) => {
      // Simulate transfer: zero the caller's view.
      if (bytes instanceof Uint8Array) bytes.fill(0);
      return { result: result(hash) };
    });
    const svc = createScanService({ readSnapshot: async () => snapshot("h1", [7, 8]), client });
    await svc.scan();
    expect(Array.from(svc.last!.bytes)).toEqual([7, 8]);
  });

  it("passes the current audit options (brand profile) to the worker", async () => {
    const client = fakeClient();
    const opts: AuditOptions = { brand: { fonts: ["Arial"], colors: ["FF0000"], tolerance: 2 } };
    const svc = createScanService({ readSnapshot: async () => snapshot("h"), client, getOptions: () => opts });
    await svc.scan();
    expect(client.scan.mock.calls[0]![2]).toEqual(opts);
  });

  it("cancel aborts the running scan with a cancelled error", async () => {
    let rejectScan: ((e: unknown) => void) | undefined;
    const client = fakeClient(
      (_b, _h, _o, s) =>
        new Promise<AuditScan>((_res, rej) => {
          rejectScan = rej;
          s?.signal?.addEventListener("abort", () => rej(new AuditClientError("cancelled", "Scan cancelled")));
        }),
    );
    const svc = createScanService({ readSnapshot: async () => snapshot("h"), client });
    const p = svc.scan();
    await vi.waitFor(() => expect(rejectScan).toBeDefined());
    svc.cancel();
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
    expect(svc.last).toBeNull();
  });

  it("cancel during the read phase stops before the worker runs", async () => {
    let release: (s: Snapshot) => void = () => {};
    const client = fakeClient();
    const svc = createScanService({ readSnapshot: () => new Promise((r) => (release = r)), client });
    const p = svc.scan();
    svc.cancel();
    release(snapshot("h"));
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
    expect(client.scan).not.toHaveBeenCalled();
  });

  it.each([
    [new SnapshotError("open-failed", "x"), "read-failed"],
    [new SnapshotError("slice-failed", "x"), "read-failed"],
    [new SnapshotError("empty-document", "x"), "empty"],
    [new PackageError("not-a-zip", "x"), "not-a-presentation"],
    [new PackageError("not-a-pptx", "x"), "not-a-presentation"],
    [new PackageError("malformed-part", "x"), "damaged-file"],
    [new AuditClientError("not-a-pptx", "x"), "not-a-presentation"],
    [new AuditClientError("malformed-part", "x"), "damaged-file"],
    [new AuditClientError("worker-crashed", "x"), "audit-crashed"],
    [new AuditClientError("internal", "x"), "internal"],
    [new AuditClientError("cancelled", "x"), "cancelled"],
    [new TypeError("x"), "internal"],
  ] as const)("maps %s to %s", (err, kind) => {
    const mapped = toScanError(err);
    expect(mapped).toBeInstanceOf(ScanError);
    expect(mapped.kind).toBe(kind);
  });

  it("surfaces mapped errors from scan()", async () => {
    const svc = createScanService({
      readSnapshot: async () => {
        throw new SnapshotError("open-failed", "getFileAsync failed");
      },
      client: fakeClient(),
    });
    await expect(svc.scan()).rejects.toMatchObject({ kind: "read-failed" });
  });

  describe("rescanForFix (D4)", () => {
    it("reuses the cached result when the file hash is unchanged", async () => {
      const client = fakeClient();
      const read = vi.fn(async () => snapshot("same"));
      const svc = createScanService({ readSnapshot: read, client });
      const first = await svc.scan();
      const again = await svc.rescanForFix();
      expect(read).toHaveBeenCalledTimes(2);
      expect(client.scan).toHaveBeenCalledTimes(1);
      expect(again.changed).toBe(false);
      expect(again.result).toBe(first);
      expect(again.hash).toBe("same");
    });

    it("runs a full rescan when the hash changed", async () => {
      const client = fakeClient();
      const hashes = ["a", "b"];
      const svc = createScanService({ readSnapshot: async () => snapshot(hashes.shift()!), client });
      await svc.scan();
      const again = await svc.rescanForFix();
      expect(client.scan).toHaveBeenCalledTimes(2);
      expect(again.changed).toBe(true);
      expect(again.result.hash).toBe("b");
      expect(svc.last?.hash).toBe("b");
    });

    it("rescans when the audit options changed even if the hash did not", async () => {
      const client = fakeClient();
      let opts: AuditOptions = {};
      const svc = createScanService({ readSnapshot: async () => snapshot("same"), client, getOptions: () => opts });
      await svc.scan();
      opts = { brand: { fonts: ["Arial"], colors: [], tolerance: 2 } };
      const again = await svc.rescanForFix();
      expect(again.changed).toBe(true);
      expect(client.scan).toHaveBeenCalledTimes(2);
    });

    it("with no previous scan, performs a full scan", async () => {
      const client = fakeClient();
      const svc = createScanService({ readSnapshot: async () => snapshot("x"), client });
      const r = await svc.rescanForFix();
      expect(r.changed).toBe(true);
      expect(client.scan).toHaveBeenCalledTimes(1);
    });
  });

  describe("scan inventory (U11)", () => {
    const inventory = { slides: [{ slideId: 256, index: 0, number: 1, partName: "ppt/slides/slide1.xml", shapes: [] }] };

    it("keeps the worker's inventory on last and returns it from rescanForFix (cache hit and miss)", async () => {
      const client = fakeClient(async (_b, hash) => ({ result: result(hash), inventory }));
      const hashes = ["a", "a", "b"];
      const svc = createScanService({ readSnapshot: async () => snapshot(hashes.shift()!), client });
      await svc.scan();
      expect(svc.last?.inventory).toEqual(inventory);
      const hit = await svc.rescanForFix();
      expect(hit.changed).toBe(false);
      expect(hit.inventory).toEqual(inventory);
      const miss = await svc.rescanForFix();
      expect(miss.changed).toBe(true);
      expect(miss.inventory).toEqual(inventory);
    });

    it("leaves inventory absent when the worker sent none", async () => {
      const svc = createScanService({ readSnapshot: async () => snapshot("h"), client: fakeClient() });
      await svc.scan();
      expect(svc.last && "inventory" in svc.last).toBe(false);
    });
  });
});
