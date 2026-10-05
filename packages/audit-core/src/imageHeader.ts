/**
 * Image header sniffing (U7). Reads the format and native pixel size from the first bytes of an
 * image without decoding pixel data. Detection is by magic bytes, never by file extension, and
 * never throws: malformed or truncated input degrades to "format known, size unknown" or
 * `unknown`.
 *
 * Supported: PNG (IHDR incl. color type / bit depth), JPEG (SOFn after any APPn, incl.
 * progressive), GIF, BMP, TIFF (both byte orders, first IFD), JPEG XR / HD Photo (`.wdp`, its
 * IFD), SVG (width/height or viewBox from the first few KB), EMF / WMF (format only).
 *
 * Known limits: JPEG EXIF orientation is not applied (a rotated camera JPEG reports its stored,
 * unrotated size); SVGZ and BigTIFF report no size.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "bmp" | "tiff" | "wdp" | "svg" | "emf" | "wmf" | "webp" | "unknown";

export interface PngInfo {
  /** IHDR color type: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  bitDepth: number;
  interlaced: boolean;
}

export interface JpegInfo {
  /** SOF2/6/10/14 (progressive DCT). */
  progressive: boolean;
  components: number;
  /** The SOFn marker byte, e.g. 0xC0 (baseline) or 0xC2 (progressive). */
  sofMarker: number;
}

export interface ImageHeader {
  format: ImageFormat;
  /** Native pixel width, when readable. For SVG: CSS pixels (96/in) or viewBox units. */
  width?: number;
  height?: number;
  /** Vector formats (SVG, EMF, WMF) have no meaningful pixel density. */
  vector: boolean;
  png?: PngInfo;
  jpeg?: JpegInfo;
}

/** How much of an SVG is scanned for the root element. */
export const SVG_SNIFF_BYTES = 4096;

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32be = (b: Uint8Array, o: number): number => ((u16be(b, o) << 16) >>> 0) + u16be(b, o + 2);
const u32le = (b: Uint8Array, o: number): number => u16le(b, o) + ((u16le(b, o + 2) << 16) >>> 0);
const i32le = (b: Uint8Array, o: number): number => u32le(b, o) | 0;

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function sized(format: ImageFormat, width: number, height: number, extra: Partial<ImageHeader> = {}): ImageHeader {
  const h: ImageHeader = { format, vector: false, ...extra };
  if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
    h.width = width;
    h.height = height;
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// Raster formats

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(b: Uint8Array): ImageHeader {
  // Signature (8) + length (4) + "IHDR" (4) + 13 bytes of IHDR data.
  if (b.length < 29 || !startsWith(b, ascii("IHDR"), 12)) return { format: "png", vector: false };
  return sized("png", u32be(b, 16), u32be(b, 20), {
    png: { bitDepth: b[24] ?? 0, colorType: b[25] ?? 0, interlaced: (b[28] ?? 0) === 1 },
  });
}

/** SOFn markers carrying frame dimensions (C4 = DHT, C8 = JPG ext, CC = DAC are not frames). */
function isSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function readJpeg(b: Uint8Array): ImageHeader {
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) return { format: "jpeg", vector: false }; // lost sync
    while (o < b.length && b[o] === 0xff) o++; // fill bytes
    if (o >= b.length) break;
    const m = b[o] ?? 0;
    o++;
    // Stand-alone markers without a length.
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS before any frame header
    if (o + 2 > b.length) break;
    const len = u16be(b, o);
    if (len < 2) break;
    if (isSof(m)) {
      if (o + 8 > b.length) break;
      const progressive = m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce;
      return sized("jpeg", u16be(b, o + 5), u16be(b, o + 3), {
        jpeg: { progressive, components: b[o + 7] ?? 0, sofMarker: m },
      });
    }
    o += len;
  }
  return { format: "jpeg", vector: false };
}

function readGif(b: Uint8Array): ImageHeader {
  if (b.length < 10) return { format: "gif", vector: false };
  return sized("gif", u16le(b, 6), u16le(b, 8));
}

function readBmp(b: Uint8Array): ImageHeader {
  if (b.length < 18) return { format: "bmp", vector: false };
  const dib = u32le(b, 14);
  if (dib === 12) {
    if (b.length < 22) return { format: "bmp", vector: false };
    return sized("bmp", u16le(b, 18), u16le(b, 20));
  }
  if (b.length < 26) return { format: "bmp", vector: false };
  // Negative height = top-down bitmap.
  return sized("bmp", Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)));
}

/**
 * Reads two tags from the first IFD of a TIFF-structured file (TIFF, JPEG XR). SHORT values are
 * left-justified in the 4-byte value field, so they sit at the field start for both byte orders.
 */
function readIfdSize(
  b: Uint8Array,
  littleEndian: boolean,
  ifdOffset: number,
  widthTag: number,
  heightTag: number,
): { width: number; height: number } | undefined {
  const r16 = littleEndian ? u16le : u16be;
  const r32 = littleEndian ? u32le : u32be;
  if (ifdOffset < 8 || ifdOffset + 2 > b.length) return undefined;
  const count = r16(b, ifdOffset);
  let width: number | undefined;
  let height: number | undefined;
  for (let i = 0; i < count; i++) {
    const e = ifdOffset + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = r16(b, e);
    if (tag !== widthTag && tag !== heightTag) continue;
    const type = r16(b, e + 2);
    // 1 BYTE, 3 SHORT, 4 LONG.
    const value = type === 3 ? r16(b, e + 8) : type === 4 ? r32(b, e + 8) : type === 1 ? (b[e + 8] ?? 0) : undefined;
    if (value === undefined) continue;
    if (tag === widthTag) width = value;
    else height = value;
  }
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function readTiff(b: Uint8Array, littleEndian: boolean): ImageHeader {
  const off = littleEndian ? u32le(b, 4) : u32be(b, 4);
  const s = readIfdSize(b, littleEndian, off, 256, 257);
  return s ? sized("tiff", s.width, s.height) : { format: "tiff", vector: false };
}

function readWdp(b: Uint8Array): ImageHeader {
  // JPEG XR: "II" 0xBC 0x01, then a little-endian IFD with ImageWidth 0xBC80 / ImageHeight 0xBC81.
  const s = readIfdSize(b, true, u32le(b, 4), 0xbc80, 0xbc81);
  return s ? sized("wdp", s.width, s.height) : { format: "wdp", vector: false };
}

// ---------------------------------------------------------------------------------------------
// Vector formats

/** CSS pixels per unit (96 px per inch). */
const SVG_UNITS: Readonly<Record<string, number>> = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
};

function svgLength(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m) return undefined;
  const unit = SVG_UNITS[(m[2] ?? "").toLowerCase()];
  if (unit === undefined) return undefined; // %, em, ex: not absolute
  return Number(m[1]) * unit;
}

function svgAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

function looksLikeSvg(text: string): number {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (!/^<(\?xml|!--|!doctype|svg[\s>/])/i.test(t)) return -1;
  const i = text.search(/<svg[\s>/]/i);
  return i;
}

function readSvg(text: string, start: number): ImageHeader {
  const tag = /^<svg\b[^>]*>?/i.exec(text.slice(start))?.[0] ?? "";
  const w = svgLength(svgAttr(tag, "width"));
  const h = svgLength(svgAttr(tag, "height"));
  if (w !== undefined && h !== undefined && w > 0 && h > 0) return { format: "svg", width: w, height: h, vector: true };
  const vb = svgAttr(tag, "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) {
    const vw = vb[2] ?? 0;
    const vh = vb[3] ?? 0;
    if (vw > 0 && vh > 0) return { format: "svg", width: vw, height: vh, vector: true };
  }
  return { format: "svg", vector: true };
}

// ---------------------------------------------------------------------------------------------

/** Sniff the format and native size of an image from its leading bytes. Never throws. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const b = bytes;
  if (startsWith(b, PNG_SIG)) return readPng(b);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return readJpeg(b);
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return readGif(b);
  if (startsWith(b, [0x49, 0x49, 0xbc])) return readWdp(b);
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00])) return readTiff(b, true);
  if (startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return readTiff(b, false);
  if (startsWith(b, ascii("BM")) && b.length >= 18) {
    const dib = u32le(b, 14);
    if (dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124) return readBmp(b);
  }
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return { format: "webp", vector: false };
  if (startsWith(b, [0x01, 0x00, 0x00, 0x00]) && startsWith(b, ascii(" EMF"), 40)) return { format: "emf", vector: true };
  if (startsWith(b, [0xd7, 0xcd, 0xc6, 0x9a])) return { format: "wmf", vector: true };
  if ((startsWith(b, [0x01, 0x00, 0x09, 0x00]) || startsWith(b, [0x02, 0x00, 0x09, 0x00])) && b.length >= 18) {
    return { format: "wmf", vector: true };
  }
  // Text formats last: decode only a small prefix.
  const head = b.subarray(0, SVG_SNIFF_BYTES);
  if (head.length > 0 && (head[0] === 0x3c || head[0] === 0xef || head[0] === 0x20 || head[0] === 0x0a || head[0] === 0x0d || head[0] === 0x09)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
    const at = looksLikeSvg(text);
    if (at >= 0) return readSvg(text, at);
  }
  return { format: "unknown", vector: false };
}
