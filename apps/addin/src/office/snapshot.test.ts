import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readSnapshot, SnapshotError, type SnapshotDocument } from "./snapshot";

type SliceSpec = number[] | Uint8Array | ArrayBuffer | { fail: string };

interface FakeOptions {
  slices: SliceSpec[];
  openError?: string;
  closeError?: string;
  /** Override the reported sliceCount (defaults to slices.length). */
  sliceCount?: number;
  size?: number;
}

function fakeDocument(opts: FakeOptions) {
  const closeAsync = vi.fn((cb?: (r: unknown) => void) => {
    cb?.(opts.closeError ? { status: "failed", error: { message: opts.closeError } } : { status: "succeeded" });
  });
  const requested: number[] = [];
  const getSliceAsync = vi.fn((index: number, cb?: (r: unknown) => void) => {
    requested.push(index);
    const spec = opts.slices[index];
    if (spec === undefined) {
      cb?.({ status: "failed", error: { message: `no slice ${index}` } });
    } else if (!Array.isArray(spec) && !(spec instanceof Uint8Array) && !(spec instanceof ArrayBuffer)) {
      cb?.({ status: "failed", error: { message: spec.fail } });
    } else {
      // Deliver asynchronously to prove the reader really waits for each slice.
      setTimeout(() => cb?.({ status: "succeeded", value: { data: spec, index, size: 0 } }), 0);
    }
  });
  const byteLen = opts.slices.reduce<number>((n, s) => {
    if (Array.isArray(s) || s instanceof Uint8Array) return n + s.length;
    if (s instanceof ArrayBuffer) return n + s.byteLength;
    return n;
  }, 0);
  const file = {
    size: opts.size ?? byteLen,
    sliceCount: opts.sliceCount ?? opts.slices.length,
    closeAsync,
    getSliceAsync,
  };
  const getFileAsync = vi.fn((_type: unknown, _options: unknown, cb?: (r: unknown) => void) => {
    if (opts.openError) cb?.({ status: "failed", error: { message: opts.openError } });
    else cb?.({ status: "succeeded", value: file });
  });
  const doc = { getFileAsync } as unknown as SnapshotDocument;
  return { doc, getFileAsync, closeAsync, getSliceAsync, requested };
}

async function expectSnapshotError(p: Promise<unknown>, code: string): Promise<SnapshotError> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SnapshotError);
  expect((err as SnapshotError).code).toBe(code);
  return err as SnapshotError;
}

describe("readSnapshot", () => {
  it("concatenates 3 slices in order, hashes them, and closes the file once", async () => {
    const f = fakeDocument({ slices: [[1, 2, 3], new Uint8Array([4, 5]), new Uint8Array([6]).buffer] });
    const snap = await readSnapshot(f.doc);
    expect(Array.from(snap.bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snap.sliceCount).toBe(3);
    expect(snap.sha256).toBe(bytesToHex(sha256(new Uint8Array([1, 2, 3, 4, 5, 6]))));
    expect(f.requested).toEqual([0, 1, 2]);
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("requests the compressed file type with 4 MB slices", async () => {
    const f = fakeDocument({ slices: [[1]] });
    await readSnapshot(f.doc);
    expect(f.getFileAsync).toHaveBeenCalledWith("compressed", { sliceSize: 4194304 }, expect.any(Function));
  });

  it("requests slices sequentially, never more than one in flight", async () => {
    const f = fakeDocument({ slices: [[1], [2], [3]] });
    let inFlight = 0;
    let maxInFlight = 0;
    const original = f.getSliceAsync.getMockImplementation()!;
    f.getSliceAsync.mockImplementation((i: number, cb?: (r: unknown) => void) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      original(i, (r) => {
        inFlight--;
        cb?.(r);
      });
    });
    await readSnapshot(f.doc);
    expect(maxInFlight).toBe(1);
  });

  it("rejects with slice-failed when slice 2 fails, and still closes the file", async () => {
    const f = fakeDocument({ slices: [[1], { fail: "boom" }, [3]] });
    const err = await expectSnapshotError(readSnapshot(f.doc), "slice-failed");
    expect(err.message).toContain("boom");
    expect(f.requested).toEqual([0, 1]);
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects with empty-document for a zero-slice file and still closes it", async () => {
    const f = fakeDocument({ slices: [] });
    await expectSnapshotError(readSnapshot(f.doc), "empty-document");
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects with empty-document when slices exist but carry no bytes", async () => {
    const f = fakeDocument({ slices: [[]], size: 0 });
    await expectSnapshotError(readSnapshot(f.doc), "empty-document");
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects with open-failed when getFileAsync fails (nothing to close)", async () => {
    const f = fakeDocument({ slices: [[1]], openError: "busy" });
    const err = await expectSnapshotError(readSnapshot(f.doc), "open-failed");
    expect(err.message).toContain("busy");
    expect(f.closeAsync).not.toHaveBeenCalled();
  });

  it("rejects with open-failed when getFileAsync throws synchronously", async () => {
    const doc = {
      getFileAsync: () => {
        throw new Error("sync throw");
      },
    } as unknown as SnapshotDocument;
    await expectSnapshotError(readSnapshot(doc), "open-failed");
  });

  it("still resolves when closeAsync reports failure after a good read", async () => {
    const f = fakeDocument({ slices: [[9]], closeError: "close failed" });
    const snap = await readSnapshot(f.doc);
    expect(Array.from(snap.bytes)).toEqual([9]);
  });

  it("keeps the original slice error when closeAsync also fails", async () => {
    const f = fakeDocument({ slices: [{ fail: "slice broke" }], closeError: "close failed" });
    const err = await expectSnapshotError(readSnapshot(f.doc), "slice-failed");
    expect(err.message).toContain("slice broke");
  });

  it("writes slices into a buffer preallocated from file.size with identical bytes and hash", async () => {
    const slices = [[1, 2, 3], new Uint8Array([4, 5]), new Uint8Array([6]).buffer];
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const pre = await readSnapshot(fakeDocument({ slices, size: 6 }).doc);
    const concat = await readSnapshot(fakeDocument({ slices, size: 0 }).doc);
    expect(Array.from(pre.bytes)).toEqual(Array.from(expected));
    expect(pre.bytes.byteLength).toBe(6);
    expect(pre.bytes.buffer.byteLength).toBe(6);
    expect(pre.sha256).toBe(bytesToHex(sha256(expected)));
    expect(Array.from(concat.bytes)).toEqual(Array.from(pre.bytes));
    expect(concat.sha256).toBe(pre.sha256);
  });

  it("falls back to concatenation when file.size is missing", async () => {
    const f = fakeDocument({ slices: [[1, 2], [3]] });
    (f.doc as unknown as { getFileAsync: ReturnType<typeof vi.fn> }).getFileAsync.mockImplementation(
      (_t: unknown, _o: unknown, cb?: (r: unknown) => void) => {
        const file = { sliceCount: 2, closeAsync: f.closeAsync, getSliceAsync: f.getSliceAsync };
        cb?.({ status: "succeeded", value: file });
      },
    );
    const snap = await readSnapshot(f.doc);
    expect(Array.from(snap.bytes)).toEqual([1, 2, 3]);
    expect(snap.sha256).toBe(bytesToHex(sha256(new Uint8Array([1, 2, 3]))));
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("falls back correctly when slices overflow the reported size", async () => {
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const f = fakeDocument({ slices: [[1, 2, 3], [4, 5], [6, 7]], size: 4 });
    const snap = await readSnapshot(f.doc);
    expect(Array.from(snap.bytes)).toEqual(Array.from(expected));
    expect(snap.bytes.byteLength).toBe(7);
    expect(snap.sha256).toBe(bytesToHex(sha256(expected)));
    expect(f.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("trims to the assembled length when slices fall short of the reported size", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const f = fakeDocument({ slices: [[1, 2], [3]], size: 10 });
    const snap = await readSnapshot(f.doc);
    expect(Array.from(snap.bytes)).toEqual(Array.from(expected));
    expect(snap.bytes.byteLength).toBe(3);
    expect(snap.bytes.buffer.byteLength).toBe(3);
    expect(snap.sha256).toBe(bytesToHex(sha256(expected)));
  });

  it("produces identical hashes for identical bytes split differently", async () => {
    const a = await readSnapshot(fakeDocument({ slices: [[1, 2], [3, 4]] }).doc);
    const b = await readSnapshot(fakeDocument({ slices: [[1], [2, 3, 4]] }).doc);
    const c = await readSnapshot(fakeDocument({ slices: [[1, 2, 3, 5]] }).doc);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
  });
});
