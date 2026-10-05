/**
 * Deterministic synthetic media for fixtures. Headers are real (PNG IHDR with
 * CRCs, JPEG SOF0) so later header-sniffing checks (U7) read true pixel sizes;
 * the payload is PRNG noise so it does not compress (media-bloat stays big).
 */

/** xorshift32 noise; same seed → same bytes. */
export function noiseBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  let i = 0;
  const words = Math.floor(length / 4);
  const view = new DataView(out.buffer);
  for (let w = 0; w < words; w++, i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    view.setUint32(i, x);
  }
  for (; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const crcInput = concat([head.subarray(4), data]);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc32(crcInput));
  return concat([head, data, tail]);
}

/**
 * A PNG with a valid signature and IHDR for `width`×`height` (8-bit RGBA),
 * followed by an IDAT of `payloadBytes` noise and IEND. Not decodable as an
 * image, but every header reader sees the right dimensions.
 */
export function pngBytes(width: number, height: number, payloadBytes = 64, seed = 1): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", noiseBytes(payloadBytes, seed)), pngChunk("IEND", new Uint8Array())]);
}

/**
 * A baseline JPEG header (SOI, APP0/JFIF, SOF0 with `width`×`height`),
 * padded with noise to `totalBytes`, ending with EOI.
 */
export function jpegBytes(width: number, height: number, totalBytes = 1024, seed = 2): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8]);
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  const sof0 = new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const eoi = new Uint8Array([0xff, 0xd9]);
  const fixed = soi.byteLength + app0.byteLength + sof0.byteLength + eoi.byteLength;
  const pad = noiseBytes(Math.max(0, totalBytes - fixed), seed);
  // Avoid accidental 0xFF markers inside the padding.
  for (let i = 0; i < pad.length; i++) if (pad[i] === 0xff) pad[i] = 0xfe;
  return concat([soi, app0, sof0, pad, eoi]);
}

/** A tiny SVG document with a viewBox. */
export function svgBytes(width: number, height: number): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#4472C4"/></svg>`,
  );
}
