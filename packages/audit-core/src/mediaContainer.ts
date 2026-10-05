/**
 * Video / audio container and codec sniffing from bytes (not the file extension).
 *
 * Pure, bounded, and never throws: magic-number checks look only at the first bytes; ISO-BMFF
 * (MP4 / M4V / M4A / MOV / 3GP) walks top-level box headers to find `moov`, then descends
 * moov → trak → mdia → (hdlr, minf → stbl → stsd) to read each track's sample-entry codec
 * four-character code. Box walking is capped by depth and count; anything malformed degrades to
 * "codecs unknown" (or an `unknown` container) instead of an exception.
 */

export type MediaContainer =
  | "mp4"
  | "m4v"
  | "m4a"
  | "mov"
  | "3gp"
  | "asf"
  | "avi"
  | "wav"
  | "aiff"
  | "mpeg-ps"
  | "mpeg-ts"
  | "mpeg-video"
  | "flv"
  | "webm"
  | "mkv"
  | "ogg"
  | "mp3"
  | "aac"
  | "flac"
  | "midi"
  | "unknown";

export interface MediaSniff {
  container: MediaContainer;
  /** ISO-BMFF major brand (`ftyp`), e.g. `mp42`, `qt  `, `M4V `. */
  brand?: string;
  /** Video codec ids: ISO sample-entry fourccs (`avc1`, `hvc1`, `apcn`, …) or AVI handlers. */
  videoCodecs: string[];
  /** Audio codec ids: ISO sample-entry fourccs (`mp4a`, `lpcm`, …) or names (`pcm`, `vorbis`). */
  audioCodecs: string[];
  hasVideo: boolean;
  hasAudio: boolean;
  /**
   * True when the track codecs were actually read. For ISO-BMFF this means `moov` was found and
   * at least one `stsd` sample entry was parsed; for other containers, when codecs are implied
   * by the format or were read from its header.
   */
  codecsKnown: boolean;
}

/** Bytes inspected by the magic-number / header scans (ISO-BMFF top-level walking may skip further). */
export const SNIFF_HEAD_BYTES = 1 << 20;
/** Limits on ISO-BMFF walking. */
const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_BOXES = 20_000;
const MAX_DEPTH = 10;
const MAX_STSD_ENTRIES = 16;
/** Window for GUID / chunk / string searches in non-ISO headers. */
const SCAN_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Byte helpers

function fourcc(b: Uint8Array, o: number): string {
  if (o < 0 || o + 4 > b.length) return "";
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

function u32le(b: Uint8Array, o: number): number {
  return b[o]! + (b[o + 1]! << 8) + (b[o + 2]! << 16) + ((b[o + 3]! << 24) >>> 0);
}

function u16le(b: Uint8Array, o: number): number {
  return b[o]! + (b[o + 1]! << 8);
}

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (at + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** First index of `needle` in `b[from, to)`, or -1. */
function indexOf(b: Uint8Array, needle: readonly number[], from = 0, to = b.length): number {
  const end = Math.min(to, b.length) - needle.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function isPrintableFourcc(s: string): boolean {
  return s.length === 4 && /^[\x20-\x7e]{4}$/.test(s);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------------------------
// ISO-BMFF

interface Box {
  type: string;
  /** Payload start. */
  start: number;
  /** Payload end (clamped to the buffer). */
  end: number;
}

interface WalkBudget {
  boxes: number;
}

/** Boxes in `[from, to)`. Stops at the first malformed header. */
function boxes(b: Uint8Array, from: number, to: number, budget: WalkBudget, max = Number.POSITIVE_INFINITY): Box[] {
  const out: Box[] = [];
  let o = from;
  const limit = Math.min(to, b.length);
  while (o + 8 <= limit && out.length < max && budget.boxes < MAX_BOXES) {
    budget.boxes++;
    let size = u32be(b, o);
    const type = fourcc(b, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > limit) break;
      const hi = u32be(b, o + 8);
      const lo = u32be(b, o + 12);
      size = hi * 4294967296 + lo;
      header = 16;
    } else if (size === 0) {
      size = limit - o;
    }
    if (size < header || !isPrintableFourcc(type)) break;
    const end = Math.min(limit, o + size);
    out.push({ type, start: o + header, end });
    if (o + size >= limit) break;
    o += size;
  }
  return out;
}

const ISO_CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"]);

interface Track {
  handler?: string;
  codecs: string[];
}

function readTrack(b: Uint8Array, trak: Box, budget: WalkBudget): Track {
  const t: Track = { codecs: [] };
  const visit = (box: Box, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const c of boxes(b, box.start, box.end, budget)) {
      if (c.type === "hdlr") {
        // FullBox: version/flags (4), pre_defined (4), handler_type (4).
        if (c.start + 12 <= c.end) t.handler = fourcc(b, c.start + 8);
      } else if (c.type === "stsd") {
        // FullBox: version/flags (4), entry_count (4), then sample entries (boxes).
        if (c.start + 8 <= c.end) {
          for (const e of boxes(b, c.start + 8, c.end, budget, MAX_STSD_ENTRIES)) t.codecs.push(e.type);
        }
      } else if (ISO_CONTAINER_BOXES.has(c.type) && c.type !== "trak") {
        visit(c, depth + 1);
      }
    }
  };
  visit(trak, 0);
  return t;
}

const VIDEO_FOURCCS = new Set([
  "avc1", "avc2", "avc3", "avc4", "hvc1", "hev1", "dvh1", "dvhe", "mp4v", "apcn", "apch", "apcs", "apco", "ap4h", "ap4x",
  "jpeg", "mjpa", "mjpb", "s263", "h263", "av01", "vp08", "vp09", "encv", "mp2v", "cvid", "SVQ1", "SVQ3", "dvc ", "dvcp",
]);
const AUDIO_FOURCCS = new Set([
  "mp4a", "ac-3", "ec-3", "ac-4", "lpcm", "sowt", "twos", "in24", "in32", "fl32", "fl64", "alac", "Opus", "fLaC", "samr",
  "sawb", "enca", "ulaw", "alaw", ".mp3", "ima4", "raw ",
]);

function sniffIso(b: Uint8Array): MediaSniff {
  const budget: WalkBudget = { boxes: 0 };
  const top = boxes(b, 0, b.length, budget, MAX_TOP_LEVEL_BOXES);
  const ftyp = top.find((x) => x.type === "ftyp");
  const brand = ftyp && ftyp.start + 4 <= ftyp.end ? fourcc(b, ftyp.start) : undefined;
  let container: MediaContainer = "mp4";
  if (brand === undefined || brand === "qt  ") container = "mov";
  else if (brand.startsWith("M4V")) container = "m4v";
  else if (brand === "M4A " || brand === "M4B " || brand === "M4P ") container = "m4a";
  else if (brand.startsWith("3g")) container = "3gp";

  const video: string[] = [];
  const audio: string[] = [];
  let entries = 0;
  const moov = top.find((x) => x.type === "moov");
  if (moov) {
    for (const trak of boxes(b, moov.start, moov.end, budget).filter((x) => x.type === "trak")) {
      const t = readTrack(b, trak, budget);
      entries += t.codecs.length;
      for (const c of t.codecs) {
        if (t.handler === "vide" || (t.handler !== "soun" && VIDEO_FOURCCS.has(c))) video.push(c);
        else if (t.handler === "soun" || AUDIO_FOURCCS.has(c)) audio.push(c);
      }
    }
  }
  const sniff: MediaSniff = {
    container,
    videoCodecs: uniq(video),
    audioCodecs: uniq(audio),
    hasVideo: video.length > 0,
    hasAudio: audio.length > 0,
    codecsKnown: entries > 0,
  };
  if (brand !== undefined) sniff.brand = brand;
  return sniff;
}

const QT_LEADING_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

function looksIso(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  const t = fourcc(b, 4);
  if (t === "ftyp") return true;
  if (!QT_LEADING_BOXES.has(t)) return false;
  const size = u32be(b, 0);
  return size === 0 || size === 1 || size >= 8;
}

// ---------------------------------------------------------------------------------------------
// Other containers

const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
const ASF_STREAM_PROPS = [0x91, 0x07, 0xdc, 0xb7, 0xb7, 0xa9, 0xcf, 0x11, 0x8e, 0xe6, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
const ASF_VIDEO = [0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b];
const ASF_AUDIO = [0x40, 0x9e, 0x69, 0xf8, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b];

function sniffAsf(b: Uint8Array): MediaSniff {
  let hasVideo = false;
  let hasAudio = false;
  let o = 16;
  for (let n = 0; n < 64; n++) {
    const i = indexOf(b, ASF_STREAM_PROPS, o, SCAN_BYTES);
    if (i < 0) break;
    if (startsWith(b, ASF_VIDEO, i + 24)) hasVideo = true;
    if (startsWith(b, ASF_AUDIO, i + 24)) hasAudio = true;
    o = i + 16;
  }
  return {
    container: "asf",
    videoCodecs: hasVideo ? ["wmv"] : [],
    audioCodecs: hasAudio ? ["wma"] : [],
    hasVideo,
    hasAudio,
    codecsKnown: hasVideo || hasAudio,
  };
}

function sniffAvi(b: Uint8Array): MediaSniff {
  const video: string[] = [];
  let hasAudio = false;
  let o = 12;
  for (let n = 0; n < 16; n++) {
    const i = indexOf(b, ascii("strh"), o, SCAN_BYTES);
    if (i < 0 || i + 16 > b.length) break;
    const type = fourcc(b, i + 8);
    if (type === "vids") {
      const h = fourcc(b, i + 12);
      video.push(isPrintableFourcc(h) && h.trim() !== "" ? h.trim() : "video");
    } else if (type === "auds") hasAudio = true;
    o = i + 4;
  }
  return { container: "avi", videoCodecs: uniq(video), audioCodecs: [], hasVideo: video.length > 0, hasAudio, codecsKnown: video.length > 0 };
}

const WAV_FORMATS: Record<number, string> = {
  0x0001: "pcm",
  0x0003: "pcm-float",
  0x0002: "adpcm",
  0x0006: "alaw",
  0x0007: "ulaw",
  0x0011: "ima-adpcm",
  0x0050: "mp2",
  0x0055: "mp3",
  0x0160: "wma",
  0x0161: "wma",
  0x0162: "wma",
  0x0163: "wma",
  0xfffe: "pcm",
};

function sniffWav(b: Uint8Array): MediaSniff {
  const audio: string[] = [];
  let o = 12;
  for (let n = 0; n < 64 && o + 8 <= b.length; n++) {
    const id = fourcc(b, o);
    const size = u32le(b, o + 4);
    if (id === "fmt " && o + 10 <= b.length) {
      const tag = u16le(b, o + 8);
      audio.push(WAV_FORMATS[tag] ?? `0x${tag.toString(16).padStart(4, "0")}`);
      break;
    }
    o += 8 + size + (size & 1);
  }
  return { container: "wav", videoCodecs: [], audioCodecs: audio, hasVideo: false, hasAudio: true, codecsKnown: audio.length > 0 };
}

function sniffOgg(b: Uint8Array): MediaSniff {
  const head = Math.min(b.length, 4096);
  const video: string[] = [];
  const audio: string[] = [];
  if (indexOf(b, ascii("OpusHead"), 0, head) >= 0) audio.push("opus");
  if (indexOf(b, [0x01, ...ascii("vorbis")], 0, head) >= 0) audio.push("vorbis");
  if (indexOf(b, [0x7f, ...ascii("FLAC")], 0, head) >= 0) audio.push("flac");
  if (indexOf(b, [0x80, ...ascii("theora")], 0, head) >= 0) video.push("theora");
  return { container: "ogg", videoCodecs: video, audioCodecs: audio, hasVideo: video.length > 0, hasAudio: audio.length > 0, codecsKnown: video.length + audio.length > 0 };
}

/** MPEG audio frame / ADTS header at `o`: `mp3` (layer I–III) or `aac` (ADTS), else undefined. */
function mpegAudioAt(b: Uint8Array, o: number): { container: "mp3" | "aac"; codec: string } | undefined {
  if (o + 2 > b.length || b[o] !== 0xff) return undefined;
  const b1 = b[o + 1]!;
  if ((b1 & 0xe0) !== 0xe0) return undefined;
  const layer = (b1 >> 1) & 3;
  if (layer === 0) return (b1 & 0xf6) === 0xf0 ? { container: "aac", codec: "aac" } : undefined;
  const version = (b1 >> 3) & 3;
  if (version === 1) return undefined; // reserved
  return { container: "mp3", codec: layer === 1 ? "mp3" : layer === 2 ? "mp2" : "mp1" };
}

function audioOnly(container: MediaContainer, codec: string | undefined): MediaSniff {
  return { container, videoCodecs: [], audioCodecs: codec ? [codec] : [], hasVideo: false, hasAudio: true, codecsKnown: codec !== undefined };
}

function unknown(): MediaSniff {
  return { container: "unknown", videoCodecs: [], audioCodecs: [], hasVideo: false, hasAudio: false, codecsKnown: false };
}

function sniffUnsafe(b: Uint8Array): MediaSniff {
  if (b.length < 4) return unknown();
  if (looksIso(b)) return sniffIso(b);
  if (startsWith(b, ASF_HEADER)) return sniffAsf(b);
  if (startsWith(b, ascii("RIFF")) && b.length >= 12) {
    const form = fourcc(b, 8);
    if (form === "AVI ") return sniffAvi(b);
    if (form === "WAVE") return sniffWav(b);
    return unknown();
  }
  if (startsWith(b, ascii("FORM")) && b.length >= 12 && (fourcc(b, 8) === "AIFF" || fourcc(b, 8) === "AIFC")) return audioOnly("aiff", "pcm");
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = Math.min(b.length, 4096);
    const webm = indexOf(b, ascii("webm"), 0, head) >= 0;
    return { container: webm ? "webm" : "mkv", videoCodecs: [], audioCodecs: [], hasVideo: false, hasAudio: false, codecsKnown: false };
  }
  if (startsWith(b, ascii("OggS"))) return sniffOgg(b);
  if (startsWith(b, ascii("FLV")) && b[3] === 1) {
    const flags = b.length > 4 ? b[4]! : 0;
    return { container: "flv", videoCodecs: [], audioCodecs: [], hasVideo: (flags & 1) !== 0, hasAudio: (flags & 4) !== 0, codecsKnown: false };
  }
  if (startsWith(b, [0x00, 0x00, 0x01, 0xba])) return { container: "mpeg-ps", videoCodecs: [], audioCodecs: [], hasVideo: true, hasAudio: false, codecsKnown: false };
  if (startsWith(b, [0x00, 0x00, 0x01, 0xb3])) return { container: "mpeg-video", videoCodecs: ["mpeg"], audioCodecs: [], hasVideo: true, hasAudio: false, codecsKnown: true };
  if (b[0] === 0x47 && b.length > 188 && b[188] === 0x47 && (b.length <= 376 || b[376] === 0x47)) {
    return { container: "mpeg-ts", videoCodecs: [], audioCodecs: [], hasVideo: true, hasAudio: false, codecsKnown: false };
  }
  if (startsWith(b, ascii("fLaC"))) return audioOnly("flac", "flac");
  if (startsWith(b, ascii("MThd"))) return audioOnly("midi", "midi");
  if (startsWith(b, ascii("ID3")) && b.length >= 10) {
    // Syncsafe tag size; skip the tag (and footer) and look at the first frame.
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const after = 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
    const frame = mpegAudioAt(b, after);
    return frame ? audioOnly(frame.container, frame.codec) : audioOnly("mp3", "mp3");
  }
  const frame = mpegAudioAt(b, 0);
  if (frame) return audioOnly(frame.container, frame.codec);
  return unknown();
}

/** Identify the media container and track codecs of `bytes`. Never throws. */
export function sniffMedia(bytes: Uint8Array): MediaSniff {
  try {
    return sniffUnsafe(bytes);
  } catch {
    return unknown();
  }
}

// ---------------------------------------------------------------------------------------------
// Labels

const CONTAINER_LABELS: Record<MediaContainer, string> = {
  mp4: "MP4",
  m4v: "M4V",
  m4a: "M4A",
  mov: "MOV",
  "3gp": "3GP",
  asf: "ASF",
  avi: "AVI",
  wav: "WAV",
  aiff: "AIFF",
  "mpeg-ps": "MPEG program stream",
  "mpeg-ts": "MPEG transport stream",
  "mpeg-video": "MPEG video",
  flv: "FLV",
  webm: "WebM",
  mkv: "MKV",
  ogg: "Ogg",
  mp3: "MP3",
  aac: "AAC",
  flac: "FLAC",
  midi: "MIDI",
  unknown: "Unknown format",
};

const CODEC_LABELS: Record<string, string> = {
  avc1: "H.264",
  avc2: "H.264",
  avc3: "H.264",
  avc4: "H.264",
  hvc1: "HEVC",
  hev1: "HEVC",
  dvh1: "HEVC (Dolby Vision)",
  dvhe: "HEVC (Dolby Vision)",
  mp4v: "MPEG-4 Visual",
  apcn: "ProRes",
  apch: "ProRes",
  apcs: "ProRes",
  apco: "ProRes",
  ap4h: "ProRes",
  ap4x: "ProRes",
  jpeg: "Motion JPEG",
  mjpa: "Motion JPEG",
  mjpb: "Motion JPEG",
  s263: "H.263",
  h263: "H.263",
  av01: "AV1",
  vp08: "VP8",
  vp09: "VP9",
  encv: "encrypted video",
  mp4a: "AAC",
  "ac-3": "AC-3",
  "ec-3": "E-AC-3",
  "ac-4": "AC-4",
  lpcm: "PCM",
  sowt: "PCM",
  twos: "PCM",
  in24: "PCM",
  in32: "PCM",
  fl32: "PCM",
  fl64: "PCM",
  pcm: "PCM",
  alac: "ALAC",
  Opus: "Opus",
  opus: "Opus",
  fLaC: "FLAC",
  flac: "FLAC",
  vorbis: "Vorbis",
  theora: "Theora",
  enca: "encrypted audio",
  ".mp3": "MP3",
  mp3: "MP3",
  wmv: "WMV",
  wma: "WMA",
};

/** Human label of a codec id (`avc1` → `H.264`); unknown ids are returned trimmed. */
export function codecLabel(id: string): string {
  return CODEC_LABELS[id] ?? id.trim();
}

const ISO_CONTAINERS: ReadonlySet<MediaContainer> = new Set(["mp4", "m4v", "m4a", "mov", "3gp"]);

/** True for ISO-BMFF family containers (MP4, M4V, M4A, MOV, 3GP). */
export function isIsoContainer(c: MediaContainer): boolean {
  return ISO_CONTAINERS.has(c);
}

/**
 * Short display label, e.g. `MP4 (H.264 / AAC)`, `MOV (ProRes / PCM)`, `WMV`, `Ogg (Vorbis)`.
 * Codecs are listed for ISO-BMFF and Ogg, where the container alone says little.
 */
export function describeContainer(s: MediaSniff): string {
  if (s.container === "asf") return s.hasVideo ? "WMV" : s.hasAudio ? "WMA" : "ASF";
  const base = CONTAINER_LABELS[s.container];
  if (!isIsoContainer(s.container) && s.container !== "ogg") return base;
  const codecs = uniq([...s.videoCodecs, ...s.audioCodecs].map(codecLabel));
  return codecs.length ? `${base} (${codecs.join(" / ")})` : base;
}
