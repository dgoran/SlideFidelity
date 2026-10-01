/**
 * Snapshot reader (KTD2, KTD6).
 *
 * Reads the open deck as OOXML bytes via `Document.getFileAsync(Compressed)` in 4 MB slices,
 * fetched strictly one at a time. Each slice is fed into an incremental SHA-256 as it arrives so
 * the hash is ready when the last slice lands (no second pass over a large buffer). The file handle
 * is always closed, including on error: Office allows at most two open files per document, so a
 * leaked handle breaks every later scan.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** 4 MB, the maximum slice size on desktop and web hosts. */
export const SLICE_SIZE = 4194304;

export type SnapshotErrorCode = "empty-document" | "slice-failed" | "open-failed";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export interface Snapshot {
  /** The complete `.pptx` package bytes. */
  bytes: Uint8Array;
  /** Lower-case hex SHA-256 of `bytes`. */
  sha256: string;
  sliceCount: number;
}

/** The subset of `Office.Document` the reader needs; injectable for tests. */
export type SnapshotDocument = Pick<Office.Document, "getFileAsync">;

/** `Office.FileType.Compressed`, as a literal so the module loads without the Office global. */
const COMPRESSED = "compressed" as unknown as Office.FileType;

interface AsyncLike<T> {
  status: Office.AsyncResultStatus | string;
  value?: T;
  error?: { message?: string } | null;
}

function failed(r: AsyncLike<unknown>): boolean {
  return r.status === "failed";
}

function errorText(r: AsyncLike<unknown>): string {
  return r.error?.message ?? "unknown error";
}

function openFile(doc: SnapshotDocument): Promise<Office.File> {
  return new Promise((resolve, reject) => {
    try {
      doc.getFileAsync(COMPRESSED, { sliceSize: SLICE_SIZE }, (r: AsyncLike<Office.File>) => {
        if (failed(r) || !r.value) {
          reject(new SnapshotError("open-failed", `getFileAsync failed: ${errorText(r)}`, { cause: r.error }));
        } else {
          resolve(r.value);
        }
      });
    } catch (e) {
      reject(new SnapshotError("open-failed", `getFileAsync threw: ${String(e)}`, { cause: e }));
    }
  });
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new TypeError(`unexpected slice data type: ${Object.prototype.toString.call(data)}`);
}

function readSlice(file: Office.File, index: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const fail = (msg: string, cause?: unknown) =>
      reject(new SnapshotError("slice-failed", `slice ${index} of ${file.sliceCount} failed: ${msg}`, { cause }));
    try {
      file.getSliceAsync(index, (r: AsyncLike<Office.Slice>) => {
        if (failed(r) || !r.value) return fail(errorText(r), r.error);
        try {
          resolve(toBytes(r.value.data));
        } catch (e) {
          fail(String(e), e);
        }
      });
    } catch (e) {
      fail(String(e), e);
    }
  });
}

/** Close the file, swallowing close errors so they never mask the read result. */
function closeQuietly(file: Office.File): Promise<void> {
  return new Promise((resolve) => {
    try {
      file.closeAsync(() => resolve());
    } catch {
      resolve();
    }
  });
}

export async function readSnapshot(doc: SnapshotDocument = Office.context.document): Promise<Snapshot> {
  const file = await openFile(doc);
  try {
    const count = file.sliceCount;
    if (!count) throw new SnapshotError("empty-document", "empty document: the file has no slices");

    const hash = sha256.create();
    // Write each slice straight into a buffer sized from `file.size` so the slices and a second
    // full copy are never held at once. If the host reports no size, or the slices overflow it,
    // fall back to collecting parts and concatenating them.
    const expected = typeof file.size === "number" && file.size > 0 ? file.size : 0;
    let pre: Uint8Array | null = expected ? new Uint8Array(expected) : null;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const part = await readSlice(file, i);
      hash.update(part);
      if (pre && total + part.length <= pre.length) {
        pre.set(part, total);
      } else {
        if (pre) {
          parts.push(pre.subarray(0, total));
          pre = null;
        }
        parts.push(part);
      }
      total += part.length;
    }
    if (total === 0) throw new SnapshotError("empty-document", "empty document: the file has no bytes");

    let bytes: Uint8Array;
    if (pre) {
      // Fewer bytes than reported: trim to what actually arrived.
      bytes = total === pre.length ? pre : pre.slice(0, total);
    } else {
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    return { bytes, sha256: bytesToHex(hash.digest()), sliceCount: count };
  } finally {
    await closeQuietly(file);
  }
}
