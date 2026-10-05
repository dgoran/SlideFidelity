import { describe, expect, it, vi } from "vitest";
import { bytesToBase64, openPreFixCopy } from "./preFixCopy";

/** Reference encoder, written out independently of the implementation. */
function reference(bytes: Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? abc[n & 63]! : "=";
  }
  return out;
}

describe("pre-fix copy (D16)", () => {
  it("base64-encodes the bytes and passes them to createPresentation", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x7f]);
    const createPresentation = vi.fn(async (_b64: string) => {});
    await openPreFixCopy(bytes, createPresentation);
    expect(createPresentation).toHaveBeenCalledTimes(1);
    expect(createPresentation).toHaveBeenCalledWith("UEsDBP8Afw==");
    expect(reference(bytes)).toBe("UEsDBP8Afw==");
  });

  it("encodes large buffers (beyond one chunk) correctly", () => {
    const bytes = new Uint8Array(200_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("refuses to open an empty copy", async () => {
    const createPresentation = vi.fn(async () => {});
    await expect(openPreFixCopy(new Uint8Array(), createPresentation)).rejects.toThrow(/no pre-fix copy/i);
    expect(createPresentation).not.toHaveBeenCalled();
  });
});
