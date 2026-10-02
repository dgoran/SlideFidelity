import { describe, expect, it } from "vitest";
import { describeContainer, sniffMedia } from "../src/mediaContainer";
import { noiseBytes } from "./helpers/media";
import {
  H264_AAC_MP4,
  HEVC_MP4,
  PRORES_MOV,
  asfBytes,
  aviBytes,
  box,
  concat,
  ebmlBytes,
  flvBytes,
  id3Mp3Bytes,
  mp4Bytes,
  mpegPsBytes,
  oggVorbisBytes,
  wavBytes,
} from "./checks/playback.fixtures";

describe("sniffMedia", () => {
  it("reads ISO-BMFF brand and sample-entry codecs (H.264 + AAC)", () => {
    const s = sniffMedia(H264_AAC_MP4());
    expect(s.container).toBe("mp4");
    expect(s.brand).toBe("mp42");
    expect(s.videoCodecs).toEqual(["avc1"]);
    expect(s.audioCodecs).toEqual(["mp4a"]);
    expect(s.codecsKnown).toBe(true);
  });

  it("finds moov at the end of the file", () => {
    const s = sniffMedia(mp4Bytes("isom", [{ handler: "vide", codec: "avc3" }], { moovAtEnd: true, mdatBytes: 100_000 }));
    expect(s.container).toBe("mp4");
    expect(s.videoCodecs).toEqual(["avc3"]);
    expect(s.audioCodecs).toEqual([]);
  });

  it("identifies HEVC, ProRes / QuickTime, M4V and M4A brands", () => {
    expect(sniffMedia(HEVC_MP4()).videoCodecs).toEqual(["hvc1"]);
    const mov = sniffMedia(PRORES_MOV());
    expect(mov.container).toBe("mov");
    expect(mov.videoCodecs).toEqual(["apcn"]);
    expect(mov.audioCodecs).toEqual(["lpcm"]);
    expect(sniffMedia(mp4Bytes("M4V ", [{ handler: "vide", codec: "avc1" }])).container).toBe("m4v");
    const m4a = sniffMedia(mp4Bytes("M4A ", [{ handler: "soun", codec: "mp4a" }]));
    expect(m4a.container).toBe("m4a");
    expect(m4a.audioCodecs).toEqual(["mp4a"]);
  });

  it("treats a QuickTime file without ftyp (moov first) as MOV", () => {
    const s = sniffMedia(concat(box("wide"), box("moov", box("trak", box("mdia", box("hdlr", [0, 0, 0, 0], new Uint8Array(4), "vide", new Uint8Array(12)), box("minf", box("stbl", box("stsd", [0, 0, 0, 0, 0, 0, 0, 1], box("avc1", new Uint8Array(78))))))))));
    expect(s.container).toBe("mov");
    expect(s.videoCodecs).toEqual(["avc1"]);
  });

  it("identifies WMV vs WMA (ASF), AVI, WebM, MKV, FLV, MPEG-PS, OGG, WAV, MP3", () => {
    const wmv = sniffMedia(asfBytes(true));
    expect(wmv.container).toBe("asf");
    expect(wmv.hasVideo).toBe(true);
    const wma = sniffMedia(asfBytes(false));
    expect(wma.container).toBe("asf");
    expect(wma.hasVideo).toBe(false);
    expect(wma.hasAudio).toBe(true);
    const avi = sniffMedia(aviBytes());
    expect(avi.container).toBe("avi");
    expect(avi.videoCodecs).toEqual(["DIVX"]);
    expect(sniffMedia(ebmlBytes("webm")).container).toBe("webm");
    expect(sniffMedia(ebmlBytes("matroska")).container).toBe("mkv");
    expect(sniffMedia(flvBytes()).container).toBe("flv");
    expect(sniffMedia(mpegPsBytes()).container).toBe("mpeg-ps");
    const ogg = sniffMedia(oggVorbisBytes());
    expect(ogg.container).toBe("ogg");
    expect(ogg.audioCodecs).toEqual(["vorbis"]);
    const wav = sniffMedia(wavBytes());
    expect(wav.container).toBe("wav");
    expect(wav.audioCodecs).toEqual(["pcm"]);
    expect(sniffMedia(id3Mp3Bytes()).container).toBe("mp3");
    expect(sniffMedia(Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])).container).toBe("mp3");
    expect(sniffMedia(Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0])).container).toBe("aac");
  });

  it("identifies MPEG-TS by repeated sync bytes", () => {
    const ts = new Uint8Array(188 * 3);
    ts[0] = 0x47;
    ts[188] = 0x47;
    ts[376] = 0x47;
    expect(sniffMedia(ts).container).toBe("mpeg-ts");
  });

  it("returns unknown for noise, empty, and tiny input", () => {
    expect(sniffMedia(noiseBytes(4096, 3)).container).toBe("unknown");
    expect(sniffMedia(new Uint8Array(0)).container).toBe("unknown");
    expect(sniffMedia(Uint8Array.from([0x00, 0x00])).container).toBe("unknown");
  });

  it("never throws on malformed boxes and reports codecs as unknown", () => {
    // ftyp ok, then a moov box claiming a huge size, with a truncated child.
    const bad1 = concat(box("ftyp", "isom", [0, 0, 0, 0]), [0x7f, 0xff, 0xff, 0xff], "moov", [0, 0, 0, 40], "trak", [0, 0]);
    const s1 = sniffMedia(bad1);
    expect(s1.container).toBe("mp4");
    expect(s1.codecsKnown).toBe(false);
    // Zero-size and size < 8 boxes inside moov.
    const bad2 = concat(box("ftyp", "isom"), box("moov", [0, 0, 0, 3], "trak", [0, 0, 0, 0]));
    expect(() => sniffMedia(bad2)).not.toThrow();
    // 64-bit largesize pointing beyond the end.
    const bad3 = concat(box("ftyp", "isom"), [0, 0, 0, 1], "mdat", [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => sniffMedia(bad3)).not.toThrow();
    // Deeply nested boxes beyond the depth cap.
    let nested = box("stsd", [0, 0, 0, 0, 0, 0, 0, 1], box("avc1", new Uint8Array(78)));
    for (let i = 0; i < 64; i++) nested = box("trak", nested);
    expect(() => sniffMedia(concat(box("ftyp", "isom"), box("moov", nested)))).not.toThrow();
    // Truncated RIFF / ASF / EBML.
    for (const b of [Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0]), asfBytes(true).subarray(0, 20), Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])]) {
      expect(() => sniffMedia(b)).not.toThrow();
    }
  });
});

describe("describeContainer", () => {
  it("labels containers and codecs", () => {
    expect(describeContainer(sniffMedia(H264_AAC_MP4()))).toBe("MP4 (H.264 / AAC)");
    expect(describeContainer(sniffMedia(PRORES_MOV()))).toBe("MOV (ProRes / PCM)");
    expect(describeContainer(sniffMedia(asfBytes(true)))).toBe("WMV");
    expect(describeContainer(sniffMedia(asfBytes(false)))).toBe("WMA");
    expect(describeContainer(sniffMedia(noiseBytes(64, 2)))).toBe("Unknown format");
  });
});
