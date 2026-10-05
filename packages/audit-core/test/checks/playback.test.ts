import { describe, expect, it } from "vitest";
import { CHECKS } from "../../src/checks/index";
import { playbackChecks } from "../../src/checks/playback";
import type { Finding, FindingOf } from "../../src/findings";
import { loadPresentation } from "../../src/package/model";
import { runChecks } from "../../src/runner";
import { corpusDeck, CORPUS_NAMES } from "../helpers/corpus";
import { mutateDeck } from "../helpers/mutateDeck";
import { noiseBytes } from "../helpers/media";
import {
  AUTO_TIMING,
  CLICK_TIMING,
  H264_AAC_MP4,
  HEVC_MP4,
  IN,
  PRORES_MOV,
  TRIGGER_TIMING,
  asfBytes,
  aviBytes,
  box,
  cleanVideoDeck,
  concat,
  danglingRelDeck,
  ebmlBytes,
  embeddedDeck,
  flvBytes,
  id3Mp3Bytes,
  layoutMissingDeck,
  linkedDeck,
  missingDeck,
  mp4Bytes,
  mpegPsBytes,
  oggVorbisBytes,
  onlineDeck,
  wavBytes,
} from "./playback.fixtures";

async function audit(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of playbackChecks) out.push(...(await c.run({ pres, options: {} })));
  return out;
}

function ofKind<K extends Finding["kind"]>(findings: Finding[], kind: K): FindingOf<K>[] {
  return findings.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

const warnings = (fs: Finding[]): Finding[] => fs.filter((f) => f.severity === "warning");

describe("playbackChecks registration", () => {
  it("exports media-area checks with unique ids", () => {
    expect(playbackChecks.length).toBeGreaterThan(0);
    for (const c of playbackChecks) expect(c.area).toBe("media");
    expect(new Set(playbackChecks.map((c) => c.id)).size).toBe(playbackChecks.length);
  });
});

describe("clean media", () => {
  it("H.264/AAC MP4 with poster on a slide and a layout produces no warnings and no format findings", async () => {
    const fs = await audit(await cleanVideoDeck());
    expect(warnings(fs)).toEqual([]);
    expect(ofKind(fs, "media-format")).toEqual([]);
    expect(ofKind(fs, "media-poster-missing")).toEqual([]);
    expect(ofKind(fs, "media-missing")).toEqual([]);
    // Only the playback-settings info for the slide video (layouts carry no timing).
    for (const f of fs) expect(f.kind).toBe("media-playback-settings");
    expect(fs).toHaveLength(1);
  });

  it("MP3, M4A, WAV audio are OK", async () => {
    for (const [name, bytes] of [
      ["song.mp3", id3Mp3Bytes()],
      ["song.m4a", mp4Bytes("M4A ", [{ handler: "soun", codec: "mp4a" }])],
      ["song.wav", wavBytes()],
    ] as const) {
      const fs = await audit(await embeddedDeck(name, bytes, { kind: "audio" }));
      expect(ofKind(fs, "media-format"), name).toEqual([]);
      expect(warnings(fs), name).toEqual([]);
    }
  });

  it("a MOV with H.264 is OK, as is a QuickTime element", async () => {
    const fs = await audit(await embeddedDeck("clip.mov", mp4Bytes("qt  ", [{ handler: "vide", codec: "avc1" }, { handler: "soun", codec: "mp4a" }])));
    expect(ofKind(fs, "media-format")).toEqual([]);
  });

  it("the corpus decks never get playback warnings except where seeded", async () => {
    for (const name of CORPUS_NAMES) {
      const fs = await audit(await corpusDeck(name));
      expect(warnings(fs), name).toEqual([]);
    }
  });

  it("the full registry + playbackChecks keeps the clean corpus deck at zero warnings", async () => {
    const res = await runChecks(await corpusDeck("clean"), {}, { checks: CHECKS });
    expect(res.errors).toEqual([]);
    expect(res.findings.filter((f) => f.severity === "warning")).toEqual([]);
  });
});

describe("media-format", () => {
  it("HEVC is info with an HEVC-extension hint", async () => {
    const [f, ...rest] = ofKind(await audit(await embeddedDeck("clip.mp4", HEVC_MP4())), "media-format");
    expect(rest).toEqual([]);
    expect(f?.severity).toBe("info");
    expect(f?.data.issue).toBe("hevc");
    expect(f?.data.videoCodecs).toEqual(["hvc1"]);
    expect(f?.detail).toMatch(/HEVC/);
    expect(f?.title).toBe("Video 'clip.mp4' on slide 1 uses HEVC (H.265)");
  });

  it.each([
    ["clip.mov", PRORES_MOV(), "MOV (ProRes / PCM)"],
    ["clip.wmv", asfBytes(true), "WMV"],
    ["clip.avi", aviBytes(), "AVI"],
    ["clip.webm", ebmlBytes("webm"), "WebM"],
    ["clip.mkv", ebmlBytes("matroska"), "MKV"],
    ["clip.flv", flvBytes(), "FLV"],
    ["clip.mpg", mpegPsBytes(), "MPEG program stream"],
    ["clip.ogv", oggVorbisBytes(), "Ogg (Vorbis)"],
  ])("%s is a warning recommending MP4 (H.264/AAC)", async (name, bytes, label) => {
    const fs = ofKind(await audit(await embeddedDeck(name, bytes)), "media-format");
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.severity).toBe("warning");
    expect(f.area).toBe("media");
    expect(f.data.formatLabel).toBe(label);
    expect(f.detail).toMatch(/MP4 \(H\.264\/AAC\)/);
    expect(f.title).toContain(`Video '${name}' on slide 1`);
    expect(f.fixes).toEqual([]);
    expect(f.targets[0]?.shapeId).toBe(4);
    expect(f.targets[0]?.bounds).toEqual({ x: IN, y: IN, cx: 4 * IN, cy: 2.25 * IN });
    expect(f.targets[0]?.container.slideNumber).toBe(1);
    expect(f.data.partName).toBe(`ppt/media/${name}`);
    expect(() => structuredClone(f)).not.toThrow();
  });

  it("sniffs bytes, not the extension: an AVI renamed .mp4 is still flagged", async () => {
    const [f] = ofKind(await audit(await embeddedDeck("fake.mp4", aviBytes())), "media-format");
    expect(f?.data.container).toBe("avi");
    expect(f?.data.extension).toBe("mp4");
    expect(f?.severity).toBe("warning");
  });

  it("WMA and OGG audio are warnings; title says Audio", async () => {
    for (const [name, bytes] of [
      ["a.wma", asfBytes(false)],
      ["a.ogg", oggVorbisBytes()],
    ] as const) {
      const [f] = ofKind(await audit(await embeddedDeck(name, bytes, { kind: "audio" })), "media-format");
      expect(f?.severity, name).toBe("warning");
      expect(f?.title, name).toMatch(/^Audio '/);
      expect(f?.data.mediaKind).toBe("audio");
    }
  });

  it("unknown container is info with the size", async () => {
    const [f] = ofKind(await audit(await embeddedDeck("weird.bin", noiseBytes(3000, 9))), "media-format");
    expect(f?.severity).toBe("info");
    expect(f?.data.issue).toBe("unknown");
    expect(f?.data.bytes).toBe(3000);
    expect(f?.detail).toMatch(/2\.9 KB|3,000|3 KB/);
  });

  it("malformed MP4 boxes do not throw and become unknown (info)", async () => {
    const bad = concat(box("ftyp", "isom", [0, 0, 0, 0]), [0x7f, 0xff, 0xff, 0xff], "moov", [0, 0, 0, 40], "trak", [0, 0]);
    const [f] = ofKind(await audit(await embeddedDeck("broken.mp4", bad)), "media-format");
    expect(f?.severity).toBe("info");
    expect(f?.data.issue).toBe("unknown");
  });
});

describe("media-linked / media-online", () => {
  it.each([
    ["file:///C:/Videos/intro.mp4", "absolute-windows"],
    ["C:\\Videos\\intro.mp4", "absolute-windows"],
    ["\\\\server\\share\\intro.mp4", "network"],
    ["/Users/ana/Movies/intro.mp4", "absolute-posix"],
    ["intro.mp4", "relative"],
  ])("linked %s is a warning (%s)", async (target, pathKind) => {
    const fs = await audit(await linkedDeck(target));
    const linked = ofKind(fs, "media-linked");
    expect(linked).toHaveLength(1);
    const f = linked[0]!;
    expect(f.severity).toBe("warning");
    expect(f.data.target).toBe(target);
    expect(f.data.pathKind).toBe(pathKind);
    expect(f.data.fileName).toBe("intro.mp4");
    expect(f.title).toBe("Video 'Linked video' on slide 1 is linked to a file outside the deck");
    if (pathKind !== "relative") expect(f.detail).toMatch(/absolute|network/i);
    expect(ofKind(fs, "media-format")).toEqual([]);
    expect(ofKind(fs, "media-missing")).toEqual([]);
  });

  it("http(s) media is media-online, not media-linked", async () => {
    const fs = await audit(await onlineDeck("https://www.youtube.com/embed/abc123"));
    expect(ofKind(fs, "media-linked")).toEqual([]);
    const [f] = ofKind(fs, "media-online");
    expect(f?.severity).toBe("warning");
    expect(f?.data.url).toBe("https://www.youtube.com/embed/abc123");
    expect(f?.data.host).toBe("www.youtube.com");
    expect(f?.title).toBe("Video 'Online Media 1' on slide 1 plays from the internet");
    expect(f?.detail).toMatch(/internet/);
  });
});

describe("media-missing", () => {
  it("rel target not in the package is a warning naming slide N; no poster is info", async () => {
    const fs = await audit(await missingDeck());
    const [f, ...rest] = ofKind(fs, "media-missing");
    expect(rest).toEqual([]);
    expect(f?.severity).toBe("warning");
    expect(f?.title).toBe("Video 'Gone' on slide 2 is missing from the file");
    expect(f?.data.partName).toBe("ppt/media/media9.mp4");
    expect(f?.data.reason).toBe("part-missing");
    expect(f?.targets[0]?.shapeId).toBe(6);
    const [p] = ofKind(fs, "media-poster-missing");
    expect(p?.severity).toBe("info");
    expect(p?.data.reason).toBe("no-poster");
  });

  it("relationship ids absent from rels", async () => {
    const [f] = ofKind(await audit(await danglingRelDeck()), "media-missing");
    expect(f?.data.reason).toBe("relationship-missing");
    expect(f?.data.relId).toBe("rIdNope2");
  });

  it("media on a layout is found and named by layout", async () => {
    const [f] = ofKind(await audit(await layoutMissingDeck()), "media-missing");
    expect(f?.targets[0]?.container.kind).toBe("layout");
    expect(f?.title).toBe("Video 'Layout video' on layout 'Broken Layout' is missing from the file");
  });
});

describe("media-poster-missing", () => {
  it("poster rel pointing at a removed part / blip without embed", async () => {
    const removed = await mutateDeck(await embeddedDeck("clip.mp4", H264_AAC_MP4()), (m) => m.remove("ppt/media/poster.png"));
    const [a] = ofKind(await audit(removed), "media-poster-missing");
    expect(a?.data.reason).toBe("part-missing");
    expect(a?.title).toBe("Video 'clip.mp4' on slide 1 has no preview image");

    const noEmbed = await mutateDeck(await embeddedDeck("clip.mp4", H264_AAC_MP4()), (m) =>
      m.editXml("ppt/slides/slide1.xml", (x) => x.replace(`<a:blip r:embed="rIdP"/>`, "<a:blip/>")),
    );
    expect(ofKind(await audit(noEmbed), "media-poster-missing")[0]?.data.reason).toBe("no-poster");

    const badRel = await mutateDeck(await embeddedDeck("clip.mp4", H264_AAC_MP4()), (m) =>
      m.editXml("ppt/slides/slide1.xml", (x) => x.replace(`r:embed="rIdP"`, `r:embed="rIdZ"`)),
    );
    expect(ofKind(await audit(badRel), "media-poster-missing")[0]?.data.reason).toBe("relationship-missing");
  });

  it("audio icons are not flagged for missing poster", async () => {
    const d = await mutateDeck(await embeddedDeck("a.mp3", id3Mp3Bytes(), { kind: "audio" }), (m) => m.remove("ppt/media/poster.png"));
    expect(ofKind(await audit(d), "media-poster-missing")).toEqual([]);
  });
});

describe("media-playback-settings", () => {
  it("reads automatic / on click / when clicked on / not set", async () => {
    const start = async (tail?: string): Promise<FindingOf<"media-playback-settings"> | undefined> =>
      ofKind(await audit(await embeddedDeck("clip.mp4", H264_AAC_MP4(), tail !== undefined ? { tail } : {})), "media-playback-settings")[0];
    const auto = await start(AUTO_TIMING(4));
    expect(auto?.data.start).toBe("automatic");
    expect(auto?.data.fullScreen).toBe(true);
    expect(auto?.data.loop).toBe(true);
    expect(auto?.severity).toBe("info");
    expect(auto?.title).toBe("Video 'clip.mp4' on slide 1 plays automatically");
    const click = await start(CLICK_TIMING(4));
    expect(click?.data.start).toBe("on-click");
    expect(click?.data.fullScreen).toBe(false);
    expect((await start(TRIGGER_TIMING(4)))?.data.start).toBe("when-clicked-on");
    expect((await start())?.data.start).toBe("not-set");
  });
});

describe("robustness", () => {
  it("media pic with no media relationship ids at all is ignored; plain pictures are ignored", async () => {
    const fs = await audit(await corpusDeck("media-bloat"));
    expect(fs).toEqual([]);
  });

  it("findings are deterministic and structured-clone safe", async () => {
    const bytes = await missingDeck();
    const a = await audit(bytes);
    const b = await audit(bytes);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(structuredClone(a)).toEqual(a);
  });
});
