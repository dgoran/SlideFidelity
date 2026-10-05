/**
 * Deck and byte fixtures for the video / audio playback checks (area `media`).
 *
 * The media byte builders synthesize just enough real container structure (ISO-BMFF boxes, ASF
 * GUIDs, RIFF chunks, EBML, ID3, Ogg pages) for `sniffMedia` to identify container and codecs.
 */
import { NS, buildDeck, pic, type RelSpec } from "../helpers/buildDeck";
import { pngBytes } from "../helpers/media";

export const IN = 914400;

// ---------------------------------------------------------------------------------------------
// Byte builders

const enc = new TextEncoder();

export function concat(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
  const arrs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** An ISO-BMFF box: 32-bit size, four-character type, payload. */
export function box(type: string, ...payload: (Uint8Array | number[] | string)[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32be(8 + body.length), type, body);
}

function fullBox(type: string, ...payload: (Uint8Array | number[] | string)[]): Uint8Array {
  return box(type, [0, 0, 0, 0], ...payload);
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

export interface TrackSpec {
  handler: "vide" | "soun";
  codec: string;
}

function trak(t: TrackSpec): Uint8Array {
  const hdlr = fullBox("hdlr", zeros(4), t.handler, zeros(12), "Handler\0");
  const entry = box(t.codec, zeros(78));
  const stsd = fullBox("stsd", u32be(1), entry);
  return box("trak", fullBox("tkhd", zeros(80)), box("mdia", fullBox("mdhd", zeros(20)), hdlr, box("minf", box("stbl", stsd))));
}

/** A minimal MP4 / MOV: `ftyp` + `moov` (one `trak` per track) + `mdat`, moov first or last. */
export function mp4Bytes(brand: string, tracks: TrackSpec[], opts: { moovAtEnd?: boolean; mdatBytes?: number } = {}): Uint8Array {
  const ftyp = box("ftyp", brand, u32be(0x200), brand, "isom");
  const moov = box("moov", fullBox("mvhd", zeros(96)), ...tracks.map(trak));
  const mdat = box("mdat", zeros(opts.mdatBytes ?? 64));
  return opts.moovAtEnd ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
}

export const H264_AAC_MP4 = (): Uint8Array =>
  mp4Bytes("mp42", [
    { handler: "vide", codec: "avc1" },
    { handler: "soun", codec: "mp4a" },
  ]);
export const HEVC_MP4 = (): Uint8Array =>
  mp4Bytes("mp42", [
    { handler: "vide", codec: "hvc1" },
    { handler: "soun", codec: "mp4a" },
  ]);
export const PRORES_MOV = (): Uint8Array =>
  mp4Bytes("qt  ", [
    { handler: "vide", codec: "apcn" },
    { handler: "soun", codec: "lpcm" },
  ]);

// ASF GUIDs in on-disk (little-endian first three fields) byte order.
const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
const ASF_STREAM_PROPS = [0x91, 0x07, 0xdc, 0xb7, 0xb7, 0xa9, 0xcf, 0x11, 0x8e, 0xe6, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
const ASF_VIDEO = [0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b];
const ASF_AUDIO = [0x40, 0x9e, 0x69, 0xf8, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b];

/** ASF header with stream-properties objects for a video and/or an audio stream (WMV / WMA). */
export function asfBytes(video: boolean, audio = true): Uint8Array {
  const stream = (type: number[]): Uint8Array => concat(ASF_STREAM_PROPS, u32le(78), u32le(0), type, zeros(54));
  return concat(ASF_HEADER, u32le(200), u32le(0), u32le(2), [1, 2], video ? stream(ASF_VIDEO) : [], audio ? stream(ASF_AUDIO) : [], zeros(32));
}

/** RIFF AVI with one `strh` video stream header (`vids`, handler `DIVX`). */
export function aviBytes(): Uint8Array {
  const strh = concat("strh", u32le(56), "vids", "DIVX", zeros(48));
  const hdrl = concat("LIST", u32le(4 + strh.length), "hdrl", strh);
  return concat("RIFF", u32le(4 + hdrl.length), "AVI ", hdrl, zeros(16));
}

/** EBML header with DocType `webm` or `matroska`. */
export function ebmlBytes(docType: "webm" | "matroska"): Uint8Array {
  const dt = concat([0x42, 0x82, 0x80 | docType.length], docType);
  return concat([0x1a, 0x45, 0xdf, 0xa3, 0x80 | dt.length], dt, zeros(32));
}

/** ID3v2 tag followed by an MPEG-1 Layer III frame header. */
export function id3Mp3Bytes(): Uint8Array {
  return concat("ID3", [3, 0, 0, 0, 0, 0, 10], zeros(10), [0xff, 0xfb, 0x90, 0x64], zeros(400));
}

/** RIFF WAVE with a PCM `fmt ` chunk. */
export function wavBytes(): Uint8Array {
  const fmt = concat("fmt ", u32le(16), [1, 0, 2, 0], u32le(44100), u32le(176400), [4, 0, 16, 0]);
  return concat("RIFF", u32le(4 + fmt.length + 8), "WAVE", fmt, "data", u32le(0));
}

export function oggVorbisBytes(): Uint8Array {
  return concat("OggS", [0, 2], zeros(20), [1, 30], [1], "vorbis", zeros(32));
}

export function flvBytes(): Uint8Array {
  return concat("FLV", [1, 5, 0, 0, 0, 9], zeros(16));
}

export function mpegPsBytes(): Uint8Array {
  return concat([0x00, 0x00, 0x01, 0xba, 0x44], zeros(64));
}

// ---------------------------------------------------------------------------------------------
// Slide XML

export interface MediaPicSpec {
  id: number;
  name: string;
  kind?: "video" | "audio" | "quickTime";
  /** rel id on `a:videoFile` / `a:audioFile` / `a:quickTimeFile` (`r:link`). Omit for none. */
  fileRel?: string;
  /** rel id on `p14:media`. Omit for none. */
  mediaRel?: string;
  /** `p14:media` uses `r:link` instead of `r:embed`. */
  mediaLinked?: boolean;
  /** Poster relationship id; `null` = blip without r:embed; undefined = no blipFill blip. */
  poster?: string | null;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
}

export function mediaPic(s: MediaPicSpec): string {
  const kind = s.kind ?? "video";
  const fileEl = kind === "audio" ? "a:audioFile" : kind === "quickTime" ? "a:quickTimeFile" : "a:videoFile";
  const file = s.fileRel !== undefined ? `<${fileEl} r:link="${s.fileRel}"/>` : "";
  const media =
    s.mediaRel !== undefined
      ? `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${NS.p14}" r:${s.mediaLinked ? "link" : "embed"}="${s.mediaRel}"/></p:ext></p:extLst>`
      : "";
  const blip = s.poster === undefined ? "" : s.poster === null ? `<a:blip/>` : `<a:blip r:embed="${s.poster}"/>`;
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${s.id}" name="${s.name}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${file}${media}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${s.x ?? IN}" y="${s.y ?? IN}"/><a:ext cx="${s.cx ?? 4 * IN}" cy="${s.cy ?? 2.25 * IN}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** Rels for an embedded video `media/<file>` with poster `media/poster.png`. */
export function embeddedRels(file: string, kind: "video" | "audio" = "video"): RelSpec[] {
  return [
    { id: "rIdV", type: kind, target: `../media/${file}` },
    { id: "rIdM", type: "media", target: `../media/${file}` },
    { id: "rIdP", type: "image", target: "../media/poster.png" },
  ];
}

const POSTER = (): Uint8Array => pngBytes(640, 360, 1_000, 7);

/** One slide with one embedded media pic (`fileName` in ppt/media). */
export function embeddedDeck(fileName: string, bytes: Uint8Array, opts: { kind?: "video" | "audio"; tail?: string } = {}): Promise<Uint8Array> {
  const kind = opts.kind ?? "video";
  return buildDeck({
    media: { [fileName]: bytes, "poster.png": POSTER() },
    slides: [
      {
        layout: "Blank",
        shapes: mediaPic({ id: 4, name: fileName, kind, fileRel: "rIdV", mediaRel: "rIdM", poster: "rIdP" }),
        rels: embeddedRels(fileName, kind),
        ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
      },
    ],
  });
}

/** Video linked to an external target (local path or URL). */
export function linkedDeck(target: string): Promise<Uint8Array> {
  return buildDeck({
    media: { "poster.png": POSTER() },
    slides: [
      {
        layout: "Blank",
        shapes: mediaPic({ id: 4, name: "Linked video", fileRel: "rIdV", mediaRel: "rIdM", mediaLinked: true, poster: "rIdP" }),
        rels: [
          { id: "rIdV", type: "video", target, external: true },
          { id: "rIdM", type: "media", target, external: true },
          { id: "rIdP", type: "image", target: "../media/poster.png" },
        ],
      },
    ],
  });
}

/** Online video (legacy rel only on `a:videoFile`, as PowerPoint writes for web video). */
export function onlineDeck(url: string): Promise<Uint8Array> {
  return buildDeck({
    media: { "poster.png": POSTER() },
    slides: [
      {
        layout: "Blank",
        shapes: mediaPic({ id: 5, name: "Online Media 1", fileRel: "rIdV", poster: "rIdP" }),
        rels: [
          { id: "rIdV", type: "video", target: url, external: true },
          { id: "rIdP", type: "image", target: "../media/poster.png" },
        ],
      },
    ],
  });
}

/** Video whose rels point at a media part that is not in the package; no poster either. */
export function missingDeck(): Promise<Uint8Array> {
  return buildDeck({
    slides: [
      { layout: "Blank" },
      {
        layout: "Blank",
        shapes: mediaPic({ id: 6, name: "Gone", fileRel: "rIdV", mediaRel: "rIdM" }),
        rels: [
          { id: "rIdV", type: "video", target: "../media/media9.mp4" },
          { id: "rIdM", type: "media", target: "../media/media9.mp4" },
        ],
      },
    ],
  });
}

/** Video pic whose relationship ids are absent from the slide rels entirely. */
export function danglingRelDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "poster.png": POSTER() },
    slides: [
      {
        layout: "Blank",
        shapes: mediaPic({ id: 7, name: "Dangling", fileRel: "rIdNope", mediaRel: "rIdNope2", poster: "rIdP" }),
        rels: [{ id: "rIdP", type: "image", target: "../media/poster.png" }],
      },
    ],
  });
}

/** Clean H.264/AAC video with poster; a video on a layout too; plain picture on the slide. */
export function cleanVideoDeck(): Promise<Uint8Array> {
  const mp4 = H264_AAC_MP4();
  return buildDeck({
    media: { "media1.mp4": mp4, "media2.mp4": mp4, "poster.png": POSTER() },
    masters: [
      {
        layouts: [
          { name: "Title Slide", type: "title" },
          {
            name: "Video Layout",
            type: "blank",
            shapes: mediaPic({ id: 9, name: "Layout video", fileRel: "rIdV", mediaRel: "rIdM", poster: "rIdP" }),
            rels: embeddedRels("media2.mp4"),
          },
        ],
      },
    ],
    slides: [
      {
        layout: "Video Layout",
        shapes:
          mediaPic({ id: 4, name: "Intro", fileRel: "rIdV", mediaRel: "rIdM", poster: "rIdP" }) +
          pic({ id: 5, name: "Photo", embed: "rIdP", x: 6 * IN, y: IN, cx: 2 * IN, cy: IN }),
        rels: embeddedRels("media1.mp4"),
      },
    ],
  });
}

/** Video on a layout whose media part is missing. */
export function layoutMissingDeck(): Promise<Uint8Array> {
  return buildDeck({
    media: { "poster.png": POSTER() },
    masters: [
      {
        layouts: [
          {
            name: "Broken Layout",
            type: "blank",
            shapes: mediaPic({ id: 9, name: "Layout video", fileRel: "rIdV", mediaRel: "rIdM", poster: "rIdP" }),
            rels: [
              { id: "rIdV", type: "video", target: "../media/nothere.mp4" },
              { id: "rIdM", type: "media", target: "../media/nothere.mp4" },
              { id: "rIdP", type: "image", target: "../media/poster.png" },
            ],
          },
        ],
      },
    ],
    slides: [{ layout: "Broken Layout" }],
  });
}

// ---------------------------------------------------------------------------------------------
// Timing

function mainSeq(effects: string): string {
  return (
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${effects}</p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`
  );
}

function mediaEffect(spid: number, nodeType: string, cmd = "playFrom(0.0)"): string {
  return (
    `<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:cmd type="call" cmd="${cmd}"><p:cBhvr><p:cTn id="6" dur="5000" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd>` +
    `</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`
  );
}

function mediaNode(spid: number, opts: { fullScrn?: boolean; loop?: boolean } = {}): string {
  return (
    `<p:video${opts.fullScrn ? ` fullScrn="1"` : ""}><p:cMediaNode vol="80000"><p:cTn id="7"${opts.loop ? ` repeatCount="indefinite"` : ""} fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>` +
    `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cMediaNode></p:video>`
  );
}

function timing(inner: string): string {
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

export const AUTO_TIMING = (spid: number): string => timing(mainSeq(mediaEffect(spid, "afterEffect")) + mediaNode(spid, { fullScrn: true, loop: true }));
export const CLICK_TIMING = (spid: number): string => timing(mainSeq(mediaEffect(spid, "clickEffect")) + mediaNode(spid));
export const TRIGGER_TIMING = (spid: number): string =>
  timing(
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="20" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">` +
      `<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cond></p:stCondLst><p:childTnLst>` +
      mediaEffect(spid, "clickEffect", "togglePause") +
      `</p:childTnLst></p:cTn><p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` +
      mediaNode(spid),
  );
