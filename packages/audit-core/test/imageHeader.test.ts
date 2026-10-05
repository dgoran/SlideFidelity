import { describe, expect, it } from "vitest";
import { readImageHeader } from "../src/imageHeader";
import { jpegBytes, noiseBytes, pngBytes, svgBytes } from "./helpers/media";

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe("readImageHeader", () => {
  it("reads PNG IHDR: size, color type, bit depth", () => {
    const h = readImageHeader(pngBytes(800, 600));
    expect(h).toMatchObject({ format: "png", width: 800, height: 600, vector: false });
    expect(h.png).toEqual({ colorType: 6, bitDepth: 8, interlaced: false });
  });

  it("reads a baseline JPEG SOF0 after APP0", () => {
    const h = readImageHeader(jpegBytes(4000, 3000, 2048));
    expect(h).toMatchObject({ format: "jpeg", width: 4000, height: 3000 });
    expect(h.jpeg).toMatchObject({ progressive: false, components: 3, sofMarker: 0xc0 });
  });

  it("reads a progressive JPEG (SOF2) after a large APP1 and fill bytes", () => {
    const app1Payload = noiseBytes(3000, 5);
    const h = readImageHeader(
      bytes(
        [0xff, 0xd8],
        [0xff, 0xe1, ...be16(app1Payload.length + 2)],
        app1Payload,
        [0xff, 0xff, 0xdb, ...be16(4), 0, 0], // fill byte then DQT
        [0xff, 0xc2, ...be16(17), 8, ...be16(1080), ...be16(1920), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
        [0xff, 0xd9],
      ),
    );
    expect(h).toMatchObject({ format: "jpeg", width: 1920, height: 1080 });
    expect(h.jpeg).toMatchObject({ progressive: true, sofMarker: 0xc2 });
  });

  it("returns JPEG without dimensions when SOS comes before any SOF, or when truncated", () => {
    expect(readImageHeader(bytes([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]))).toEqual({ format: "jpeg", vector: false });
    expect(readImageHeader(bytes([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00]))).toEqual({ format: "jpeg", vector: false });
  });

  it("reads GIF logical screen size", () => {
    expect(readImageHeader(bytes(ascii("GIF89a"), le16(320), le16(240), [0, 0, 0]))).toMatchObject({
      format: "gif",
      width: 320,
      height: 240,
    });
  });

  it("reads BMP (BITMAPINFOHEADER with top-down negative height, and BITMAPCOREHEADER)", () => {
    const info = bytes(ascii("BM"), le32(0), le32(0), le32(54), le32(40), le32(640), le32(-480 >>> 0), le16(1), le16(24));
    expect(readImageHeader(info)).toMatchObject({ format: "bmp", width: 640, height: 480 });
    const core = bytes(ascii("BM"), le32(0), le32(0), le32(26), le32(12), le16(100), le16(50), le16(1), le16(24));
    expect(readImageHeader(core)).toMatchObject({ format: "bmp", width: 100, height: 50 });
  });

  it("reads TIFF little-endian (LONG) and big-endian (SHORT) first IFD", () => {
    const le = bytes(
      ascii("II"), le16(42), le32(8),
      le16(2),
      le16(256), le16(4), le32(1), le32(3000),
      le16(257), le16(4), le32(1), le32(2000),
      le32(0),
    );
    expect(readImageHeader(le)).toMatchObject({ format: "tiff", width: 3000, height: 2000 });
    const be = bytes(
      ascii("MM"), be16(42), be32(8),
      be16(3),
      be16(254), be16(4), be32(1), be32(0),
      be16(256), be16(3), be32(1), be16(1024), be16(0),
      be16(257), be16(3), be32(1), be16(768), be16(0),
      be32(0),
    );
    expect(readImageHeader(be)).toMatchObject({ format: "tiff", width: 1024, height: 768 });
  });

  it("reports TIFF format without dimensions when the IFD offset is out of range", () => {
    expect(readImageHeader(bytes(ascii("II"), le16(42), le32(9999)))).toEqual({ format: "tiff", vector: false });
  });

  it("reads JPEG XR / HD Photo (WDP) dimensions from its IFD", () => {
    const wdp = bytes(
      [0x49, 0x49, 0xbc, 0x01], le32(8),
      le16(2),
      le16(0xbc80), le16(4), le32(1), le32(1600),
      le16(0xbc81), le16(4), le32(1), le32(900),
      le32(0),
    );
    expect(readImageHeader(wdp)).toMatchObject({ format: "wdp", width: 1600, height: 900 });
    expect(readImageHeader(bytes([0x49, 0x49, 0xbc, 0x01], le32(500)))).toEqual({ format: "wdp", vector: false });
  });

  it("reads SVG width/height with units, falling back to the viewBox", () => {
    expect(readImageHeader(svgBytes(200, 100))).toMatchObject({ format: "svg", width: 200, height: 100, vector: true });
    const withUnits = new TextEncoder().encode(
      `<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg" width="2in" height='72pt' viewBox="0 0 10 10"/>`,
    );
    expect(readImageHeader(withUnits)).toMatchObject({ format: "svg", width: 192, height: 96 });
    const pct = new TextEncoder().encode(`<svg width="100%" height="100%" viewBox="0,0,640,480"></svg>`);
    expect(readImageHeader(pct)).toMatchObject({ format: "svg", width: 640, height: 480 });
    const bare = new TextEncoder().encode(`\uFEFF<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    expect(readImageHeader(bare)).toEqual({ format: "svg", vector: true });
  });

  it("recognizes EMF and WMF (format only)", () => {
    const emf = new Uint8Array(88);
    emf.set(le32(1), 0);
    emf.set(le32(88), 4);
    emf.set(ascii(" EMF"), 40);
    expect(readImageHeader(emf)).toEqual({ format: "emf", vector: true });
    expect(readImageHeader(bytes([0xd7, 0xcd, 0xc6, 0x9a], new Array(18).fill(0)))).toEqual({ format: "wmf", vector: true });
    expect(readImageHeader(bytes([1, 0, 9, 0, 0, 3], new Array(12).fill(0)))).toEqual({ format: "wmf", vector: true });
  });

  it("returns unknown for noise, empty, and truncated inputs without throwing", () => {
    expect(readImageHeader(noiseBytes(3000, 16))).toEqual({ format: "unknown", vector: false });
    expect(readImageHeader(new Uint8Array())).toEqual({ format: "unknown", vector: false });
    expect(readImageHeader(pngBytes(10, 10).subarray(0, 12))).toEqual({ format: "png", vector: false });
    expect(readImageHeader(bytes(ascii("GIF89a"), [1]))).toEqual({ format: "gif", vector: false });
  });
});
