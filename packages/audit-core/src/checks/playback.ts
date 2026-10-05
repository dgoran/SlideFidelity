/**
 * Video / audio playback checks (area `media`): will each video and sound on the slides (and on
 * layouts / masters) actually play on the show machine?
 *
 * Media objects are `p:pic` shapes whose `p:nvPr` carries `a:videoFile` / `a:audioFile` /
 * `a:quickTimeFile` / `a:wavAudioFile` and/or a `p14:media` extension, pointing at `video` /
 * `audio` (legacy) or `media` (2010+) relationships via `r:link` / `r:embed`.
 *
 * Kinds (one finding per media object and kind; none has an in-place fix):
 * - `media-missing` (warning): the relationship or its target part is not in the package.
 * - `media-linked` (warning): linked to a file outside the deck (not http/https).
 * - `media-online` (warning): streamed from the internet (http/https, rtsp, mms, rtmp).
 * - `media-format` (warning | info): embedded media whose container / codecs (sniffed from bytes)
 *   may not play everywhere. H.264 (+AAC or silent) in MP4/M4V/MOV and MP3/M4A/WAV audio are OK.
 * - `media-poster-missing` (info): a video without a poster frame image.
 * - `media-playback-settings` (info): how a slide video starts (automatically / on click / when
 *   clicked on / no start setting), plus full screen and loop, read from `p:timing`.
 */
import { formatBytes } from "./media";
import { containerName, makeFinding, shapeTarget, type Finding, type FindingTarget } from "../findings";
import { describeContainer, isIsoContainer, sniffMedia, type MediaContainer, type MediaSniff } from "../mediaContainer";
import { getShapes, relationshipsOf, shapeContainers, type Presentation } from "../package/model";
import type { Relationship } from "../package/rels";
import type { ContainerKind, ShapeRef } from "../package/shapes";
import { attr, boolAttr, child, childPath, descendants, elements, localName, relAttr, type XmlElement } from "../package/xml";
import type { Check } from "../runner";

// ---------------------------------------------------------------------------------------------
// Data types

export type PlaybackMediaKind = "video" | "audio";

interface MediaBaseData {
  mediaKind: PlaybackMediaKind;
  /** Shape name (`p:cNvPr/@name`), plain string. */
  shapeName: string;
  /** "slide 3", "layout 'Title Only'", "master 'Office Theme'". */
  location: string;
}

export interface MediaMissingData extends MediaBaseData {
  /** The relationship id that could not be resolved to a part. */
  relId: string;
  /** Expected part when the relationship exists but its target is absent. */
  partName?: string;
  reason: "part-missing" | "relationship-missing";
}

export type MediaPathKind = "absolute-windows" | "absolute-posix" | "network" | "relative" | "other";

export interface MediaLinkedData extends MediaBaseData {
  relId: string;
  /** Relationship target exactly as written (untrusted, plain string). */
  target: string;
  pathKind: MediaPathKind;
  /** Last path segment, URL-decoded when possible. */
  fileName: string;
}

export interface MediaOnlineData extends MediaBaseData {
  relId: string;
  /** URL exactly as written (untrusted, plain string; never render clickable without vetting). */
  url: string;
  /** Host name when the URL parses. */
  host?: string;
}

export type MediaFormatIssue = "unsupported-container" | "unsupported-codec" | "hevc" | "uncommon-codec" | "unknown";

export interface MediaFormatData extends MediaBaseData {
  partName: string;
  /** Lower-case file extension of the part (may disagree with the sniffed container). */
  extension: string;
  contentType?: string;
  bytes: number;
  container: MediaContainer;
  /** e.g. `MP4 (HEVC / AAC)`, `WMV`, `Unknown format`. */
  formatLabel: string;
  brand?: string;
  videoCodecs: string[];
  audioCodecs: string[];
  issue: MediaFormatIssue;
}

export interface MediaPosterMissingData extends MediaBaseData {
  reason: "no-poster" | "relationship-missing" | "part-missing";
  relId?: string;
  partName?: string;
}

export type MediaStart = "automatic" | "on-click" | "when-clicked-on" | "not-set";

export interface MediaPlaybackSettingsData extends MediaBaseData {
  start: MediaStart;
  fullScreen: boolean;
  loop: boolean;
}

declare module "../findings" {
  interface FindingDataMap {
    "media-missing": MediaMissingData;
    "media-linked": MediaLinkedData;
    "media-online": MediaOnlineData;
    "media-format": MediaFormatData;
    "media-poster-missing": MediaPosterMissingData;
    "media-playback-settings": MediaPlaybackSettingsData;
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery

interface MediaRelRef {
  relId: string;
  source: "file" | "p14";
}

interface MediaObject {
  ref: ShapeRef;
  /** Kind declared by the XML element; refined from rel types / sniffing later. */
  declaredKind: PlaybackMediaKind | undefined;
  rels: MediaRelRef[];
  /** `undefined` = no `a:blip`; `null` = blip without a relationship id. */
  posterRelId: string | null | undefined;
}

const FILE_ELEMENTS: Record<string, PlaybackMediaKind> = {
  videoFile: "video",
  quickTimeFile: "video",
  audioFile: "audio",
  wavAudioFile: "audio",
};

function relIdOf(el: XmlElement): string | undefined {
  const id = relAttr(el, "link") ?? relAttr(el, "embed");
  return id !== undefined && id.trim() !== "" ? id : undefined;
}

function mediaObjectOf(ref: ShapeRef): MediaObject | undefined {
  if (ref.kind !== "pic") return undefined;
  const nvPr = childPath(ref.node, "nvPicPr", "nvPr");
  if (!nvPr) return undefined;
  let declaredKind: PlaybackMediaKind | undefined;
  const rels: MediaRelRef[] = [];
  for (const el of elements(nvPr)) {
    const kind = FILE_ELEMENTS[localName(el.name)];
    if (!kind) continue;
    declaredKind ??= kind;
    const id = relIdOf(el);
    if (id !== undefined) rels.push({ relId: id, source: "file" });
  }
  const extLst = child(nvPr, "extLst");
  for (const m of extLst ? descendants(extLst, "media") : []) {
    const id = relIdOf(m);
    if (id !== undefined) rels.push({ relId: id, source: "p14" });
    else rels.push({ relId: "", source: "p14" });
  }
  if (declaredKind === undefined && rels.length === 0) return undefined;
  const blip = childPath(ref.node, "blipFill", "blip");
  const posterRelId = blip ? (relAttr(blip, "embed") ?? relAttr(blip, "link") ?? null) : undefined;
  return { ref, declaredKind, rels: rels.filter((r) => r.relId !== ""), posterRelId: posterRelId === "" ? null : posterRelId };
}

interface ContainerMedia {
  kind: ContainerKind;
  partName: string;
  location: string;
  objects: MediaObject[];
  rels: Map<string, Relationship>;
}

function locationOf(pres: Presentation, kind: ContainerKind, partName: string): string {
  if (kind === "slide") {
    const s = pres.slides.find((x) => x.partName === partName);
    return s ? `slide ${s.number}` : "a slide";
  }
  const name = containerName(pres, kind, partName) ?? partName.slice(partName.lastIndexOf("/") + 1);
  return `${kind} '${name}'`;
}

const discoveryCache = new WeakMap<Presentation, Promise<ContainerMedia[]>>();

function discover(pres: Presentation): Promise<ContainerMedia[]> {
  let p = discoveryCache.get(pres);
  if (!p) {
    p = (async () => {
      const out: ContainerMedia[] = [];
      for (const c of shapeContainers(pres)) {
        const objects = (await getShapes(pres, c)).map(mediaObjectOf).filter((o): o is MediaObject => o !== undefined);
        if (!objects.length) continue;
        const rels = new Map((await relationshipsOf(pres, c.partName)).map((r) => [r.id, r] as const));
        out.push({ kind: c.kind, partName: c.partName, location: locationOf(pres, c.kind, c.partName), objects, rels });
      }
      return out;
    })();
    discoveryCache.set(pres, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Classification helpers

const ONLINE_SCHEMES = /^(https?|rtsp|rtmp|mms|mmsh):/i;

export function classifyMediaPath(target: string): MediaPathKind {
  let t = target.trim();
  if (/^file:/i.test(t)) {
    t = t.replace(/^file:/i, "");
    if (/^\/\/\/?[a-zA-Z]:[\\/]/.test(t)) return "absolute-windows";
    if (/^\/\/[^/]/.test(t)) return "network";
    t = t.replace(/^\/\//, "");
  }
  if (/^[a-zA-Z]:[\\/]/.test(t)) return "absolute-windows";
  if (/^(\\\\|\/\/)/.test(t)) return "network";
  if (t.startsWith("/")) return "absolute-posix";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return "other";
  return "relative";
}

function fileNameOf(target: string): string {
  const seg = target.split(/[\\/]/).filter((s) => s !== "").pop() ?? target;
  const clean = seg.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

const H264 = new Set(["avc1", "avc2", "avc3", "avc4"]);
const HEVC = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);
const PRORES = new Set(["apcn", "apch", "apcs", "apco", "ap4h", "ap4x"]);
const OK_AUDIO_ISO = new Set(["mp4a"]);
const OK_AUDIO_CONTAINERS: ReadonlySet<MediaContainer> = new Set(["mp3", "aac", "wav"]);
const UNSUPPORTED_CONTAINERS: ReadonlySet<MediaContainer> = new Set([
  "asf", "avi", "mpeg-ps", "mpeg-ts", "mpeg-video", "flv", "webm", "mkv", "ogg", "flac", "aiff", "midi",
]);

interface Assessment {
  severity: "warning" | "info";
  issue: MediaFormatIssue;
}

/** Playback policy for an embedded media part; undefined = fine everywhere. */
export function assessMedia(s: MediaSniff): Assessment | undefined {
  if (s.container === "unknown") return { severity: "info", issue: "unknown" };
  if (OK_AUDIO_CONTAINERS.has(s.container)) return undefined;
  if (UNSUPPORTED_CONTAINERS.has(s.container)) return { severity: "warning", issue: "unsupported-container" };
  if (isIsoContainer(s.container)) {
    if (!s.codecsKnown) return { severity: "info", issue: "unknown" };
    if (s.videoCodecs.some((c) => PRORES.has(c))) return { severity: "warning", issue: "unsupported-codec" };
    if (s.videoCodecs.some((c) => HEVC.has(c))) return { severity: "info", issue: "hevc" };
    const oddVideo = s.videoCodecs.some((c) => !H264.has(c));
    const oddAudio = s.audioCodecs.some((c) => !OK_AUDIO_ISO.has(c));
    if (oddVideo || oddAudio) return { severity: "info", issue: "uncommon-codec" };
    return undefined;
  }
  return { severity: "info", issue: "unknown" };
}

// ---------------------------------------------------------------------------------------------
// Finding helpers

const KIND_TITLE: Record<PlaybackMediaKind, string> = { video: "Video", audio: "Audio" };

function subject(kind: PlaybackMediaKind, name: string, location: string): string {
  return name ? `${KIND_TITLE[kind]} '${name}' on ${location}` : `${KIND_TITLE[kind]} on ${location}`;
}

function base(kind: PlaybackMediaKind, obj: MediaObject, c: ContainerMedia): MediaBaseData {
  return { mediaKind: kind, shapeName: obj.ref.name, location: c.location };
}

const CONVERT_TO: Record<PlaybackMediaKind, string> = {
  video: "Convert it to MP4 (H.264/AAC) and insert it again",
  audio: "Convert it to MP3 or M4A (AAC) and insert it again",
};

function formatDetail(kind: PlaybackMediaKind, a: Assessment, label: string, bytes: number): string {
  const noun = kind === "video" ? "video" : "audio file";
  switch (a.issue) {
    case "hevc":
      return `The video uses HEVC (H.265). It may not play on older PowerPoint versions, or on Windows computers without the HEVC Video Extension installed. For the widest compatibility, convert it to MP4 (H.264/AAC).`;
    case "unsupported-container":
    case "unsupported-codec":
      return `The ${noun} is ${label}, which may not play on every PowerPoint version or platform (especially PowerPoint for Mac or the web). ${CONVERT_TO[kind]}.`;
    case "uncommon-codec":
      return `The ${noun} is ${label}. Some of its codecs are less widely supported than H.264/AAC; test it in Slide Show on the presenting computer, or ${CONVERT_TO[kind].charAt(0).toLowerCase()}${CONVERT_TO[kind].slice(1)}.`;
    case "unknown":
      return `SlideFidelity could not recognize the format of this ${noun} (${formatBytes(bytes)}). Play it in Slide Show on the presenting computer to confirm it works.`;
  }
}

function formatTitle(subj: string, a: Assessment, label: string): string {
  switch (a.issue) {
    case "hevc":
      return `${subj} uses HEVC (H.265)`;
    case "unknown":
      return `${subj} is in an unrecognized format`;
    case "uncommon-codec":
      return `${subj} uses a less common codec (${label})`;
    default:
      return `${subj} may not play on every computer (${label})`;
  }
}

function linkedDetail(d: MediaLinkedData, kind: PlaybackMediaKind): string {
  const noun = kind === "video" ? "video" : "audio";
  const embed = `Embed the ${noun} instead (Insert > ${kind === "video" ? "Video" : "Audio"} > This Device), or copy the file with the deck and link it again.`;
  switch (d.pathKind) {
    case "absolute-windows":
    case "absolute-posix":
      return `It points to an absolute path on the computer where it was inserted (${d.target}). On any other computer, including the show machine, the ${noun} will not play. ${embed}`;
    case "network":
      return `It points to a network location (${d.target}), which may not be reachable at the venue. ${embed}`;
    case "relative":
      return `PowerPoint looks for '${d.fileName}' relative to the deck, so it breaks if the deck is moved without it. ${embed}`;
    case "other":
      return `It points to '${d.target}', outside the deck. ${embed}`;
  }
}

function mediaKindOf(obj: MediaObject, rels: Relationship[], pres: Presentation, sniff?: MediaSniff): PlaybackMediaKind {
  if (obj.declaredKind) return obj.declaredKind;
  for (const r of rels) {
    if (r.shortType === "video") return "video";
    if (r.shortType === "audio") return "audio";
  }
  for (const r of rels) {
    const part = r.targetPart !== undefined ? pres.media.find((m) => m.partName === r.targetPart) : undefined;
    if (part?.kind === "audio") return "audio";
    if (part?.kind === "video") return "video";
  }
  if (sniff && !sniff.hasVideo && sniff.hasAudio) return "audio";
  return "video";
}

// ---------------------------------------------------------------------------------------------
// The media check

interface SniffResult {
  sniff: MediaSniff;
  bytes: number;
}

async function sniffPart(pres: Presentation, partName: string): Promise<SniffResult> {
  try {
    const data = await pres.pkg.readBytes(partName);
    if (!data) return { sniff: sniffMedia(new Uint8Array(0)), bytes: 0 };
    return { sniff: sniffMedia(data), bytes: data.byteLength };
  } catch {
    return { sniff: sniffMedia(new Uint8Array(0)), bytes: (await pres.pkg.size(partName).catch(() => undefined)) ?? 0 };
  }
}

async function runMedia(pres: Presentation): Promise<Finding[]> {
  const out: Finding[] = [];
  const sniffs = new Map<string, Promise<SniffResult>>();
  const sniff = (part: string): Promise<SniffResult> => {
    let p = sniffs.get(part);
    if (!p) {
      p = sniffPart(pres, part);
      sniffs.set(part, p);
    }
    return p;
  };

  for (const c of await discover(pres)) {
    for (const obj of c.objects) {
      const target: FindingTarget = shapeTarget(obj.ref, pres);
      const resolved = obj.rels.map((r) => ({ ...r, rel: c.rels.get(r.relId) }));
      const rels = resolved.map((r) => r.rel).filter((r): r is Relationship => r !== undefined);
      // Prefer the 2010+ p14:media relationship, then the legacy element's.
      const ordered = [...resolved].sort((a, b) => (a.source === b.source ? 0 : a.source === "p14" ? -1 : 1));
      const present = ordered.find((r) => r.rel?.targetMode === "Internal" && r.rel.targetPart !== undefined && pres.pkg.has(r.rel.targetPart));
      const external = ordered.find((r) => r.rel?.targetMode === "External");
      const common = { area: "media" as const, targets: [target], fixes: [], reachable: false };

      if (present?.rel?.targetPart !== undefined) {
        const partName = pres.pkg.canonical(present.rel.targetPart) ?? present.rel.targetPart;
        const { sniff: s, bytes } = await sniff(partName);
        const kind = mediaKindOf(obj, rels, pres, s);
        const a = assessMedia(s);
        if (a) {
          const label = describeContainer(s);
          const dot = partName.lastIndexOf(".");
          const data: MediaFormatData = {
            ...base(kind, obj, c),
            partName,
            extension: dot > partName.lastIndexOf("/") ? partName.slice(dot + 1).toLowerCase() : "",
            bytes,
            container: s.container,
            formatLabel: label,
            videoCodecs: [...s.videoCodecs],
            audioCodecs: [...s.audioCodecs],
            issue: a.issue,
          };
          const ct = pres.pkg.contentTypeOf(partName);
          if (ct !== undefined) data.contentType = ct;
          if (s.brand !== undefined) data.brand = s.brand;
          out.push(
            makeFinding({
              ...common,
              kind: "media-format",
              severity: a.severity,
              title: formatTitle(subject(kind, obj.ref.name, c.location), a, label),
              detail: formatDetail(kind, a, label, bytes),
              group: label,
              data,
            }),
          );
        }
      } else if (external?.rel) {
        const kind = mediaKindOf(obj, rels, pres);
        const subj = subject(kind, obj.ref.name, c.location);
        const t = external.rel.target;
        if (ONLINE_SCHEMES.test(t.trim())) {
          const data: MediaOnlineData = { ...base(kind, obj, c), relId: external.relId, url: t };
          const host = hostOf(t.trim());
          if (host !== undefined) data.host = host;
          out.push(
            makeFinding({
              ...common,
              kind: "media-online",
              severity: "warning",
              title: `${subj} plays from the internet`,
              detail: `It streams from ${host ?? "the web"}, so it needs a working internet connection at the venue and may be blocked by the venue network or firewall. Download and embed the ${kind} if you are allowed to, or test it on the show network.`,
              group: host ?? t,
              data,
            }),
          );
        } else {
          const data: MediaLinkedData = { ...base(kind, obj, c), relId: external.relId, target: t, pathKind: classifyMediaPath(t), fileName: fileNameOf(t) };
          out.push(
            makeFinding({
              ...common,
              kind: "media-linked",
              severity: "warning",
              title: `${subj} is linked to a file outside the deck`,
              detail: linkedDetail(data, kind),
              group: t,
              data,
            }),
          );
        }
      } else if (resolved.length) {
        const kind = mediaKindOf(obj, rels, pres);
        const withPart = ordered.find((r) => r.rel?.targetPart !== undefined);
        const first = withPart ?? ordered[0]!;
        const data: MediaMissingData = {
          ...base(kind, obj, c),
          relId: first.relId,
          reason: withPart ? "part-missing" : "relationship-missing",
        };
        if (withPart?.rel?.targetPart !== undefined) data.partName = withPart.rel.targetPart;
        out.push(
          makeFinding({
            ...common,
            kind: "media-missing",
            severity: "warning",
            title: `${subject(kind, obj.ref.name, c.location)} is missing from the file`,
            detail: `The deck refers to ${data.partName ?? `relationship ${data.relId}`}, but that file is not in the package, so the ${kind} cannot play. Insert the ${kind} again from the original file.`,
            group: data.partName ?? data.relId,
            data,
          }),
        );
      }

      // Poster frame (videos only).
      const kind = mediaKindOf(obj, rels, pres);
      if (kind === "video") {
        let poster: MediaPosterMissingData | undefined;
        if (obj.posterRelId === undefined || obj.posterRelId === null) {
          poster = { ...base(kind, obj, c), reason: "no-poster" };
        } else {
          const rel = c.rels.get(obj.posterRelId);
          if (!rel) poster = { ...base(kind, obj, c), reason: "relationship-missing", relId: obj.posterRelId };
          else if (rel.targetMode === "Internal" && rel.targetPart !== undefined && !pres.pkg.has(rel.targetPart)) {
            poster = { ...base(kind, obj, c), reason: "part-missing", relId: obj.posterRelId, partName: rel.targetPart };
          }
        }
        if (poster) {
          out.push(
            makeFinding({
              ...common,
              kind: "media-poster-missing",
              severity: "info",
              title: `${subject(kind, obj.ref.name, c.location)} has no preview image`,
              detail: `It shows a blank frame until it starts playing. In PowerPoint, choose Video Format > Poster Frame to set a preview image.`,
              group: poster.reason,
              data: poster,
            }),
          );
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Playback settings (p:timing)

interface TimingInfo {
  start?: MediaStart;
  fullScreen?: boolean;
  loop?: boolean;
}

const PLAY_COMMANDS = /^(playFrom|togglePause|play)\b/;
const MAX_TIMING_NODES = 50_000;

/** Per shape id: start mode from the first media command, full screen / loop from media nodes. */
export function readMediaTiming(timing: XmlElement | undefined): Map<number, TimingInfo> {
  const out = new Map<number, TimingInfo>();
  if (!timing) return out;
  const get = (spid: number): TimingInfo => {
    let t = out.get(spid);
    if (!t) {
      t = {};
      out.set(spid, t);
    }
    return t;
  };
  const spidOf = (el: XmlElement): number | undefined => {
    const tgt = descendants(el, "spTgt")[0];
    const v = attr(tgt, "spid");
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  let budget = MAX_TIMING_NODES;
  let sawClick = false;
  const visit = (el: XmlElement, inMain: boolean, inInteractive: boolean, depth: number): void => {
    if (depth > 64) return;
    for (const c of elements(el)) {
      if (--budget < 0) return;
      const name = localName(c.name);
      let main = inMain;
      let interactive = inInteractive;
      if (name === "cTn") {
        const nodeType = attr(c, "nodeType");
        if (nodeType === "mainSeq") main = true;
        else if (nodeType === "interactiveSeq") interactive = true;
        else if (nodeType === "clickEffect" && main && !interactive) sawClick = true;
      } else if (name === "cmd") {
        const spid = PLAY_COMMANDS.test(attr(c, "cmd") ?? "") ? spidOf(c) : undefined;
        if (spid !== undefined) {
          const t = get(spid);
          t.start ??= interactive ? "when-clicked-on" : main && sawClick ? "on-click" : "automatic";
        }
        continue;
      } else if (name === "video" || name === "audio") {
        const node = child(c, "cMediaNode");
        const spid = node ? spidOf(node) : undefined;
        if (spid !== undefined) {
          const t = get(spid);
          if (name === "video") t.fullScreen = boolAttr(c, "fullScrn") ?? false;
          t.loop = attr(child(node, "cTn"), "repeatCount") === "indefinite";
        }
        continue;
      }
      visit(c, main, interactive, depth + 1);
    }
  };
  visit(timing, false, false, 0);
  return out;
}

const START_TITLES: Record<MediaStart, string> = {
  automatic: "plays automatically",
  "on-click": "starts on click",
  "when-clicked-on": "starts when clicked on",
  "not-set": "has no start setting",
};

const START_DETAILS: Record<MediaStart, string> = {
  automatic: "It starts by itself when its turn in the slide's animation sequence comes, without a click.",
  "on-click": "It starts with a click (or the presentation remote) in the slide's click sequence.",
  "when-clicked-on": "It starts only when someone clicks the video itself; a remote's next button will not start it.",
  "not-set": "It plays only when someone clicks its play control during the show.",
};

async function runSettings(pres: Presentation): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const c of await discover(pres)) {
    if (c.kind !== "slide") continue;
    const root = await pres.pkg.xml(c.partName);
    const timing = readMediaTiming(root ? child(root, "timing") : undefined);
    for (const obj of c.objects) {
      const rels = obj.rels.map((r) => c.rels.get(r.relId)).filter((r): r is Relationship => r !== undefined);
      const kind = mediaKindOf(obj, rels, pres);
      const t = timing.get(obj.ref.shapeId) ?? {};
      const start = t.start ?? "not-set";
      const data: MediaPlaybackSettingsData = { ...base(kind, obj, c), start, fullScreen: t.fullScreen ?? false, loop: t.loop ?? false };
      const extras = [data.fullScreen ? "It plays full screen." : "", data.loop ? "It loops until stopped." : ""].filter(Boolean).join(" ");
      out.push(
        makeFinding({
          area: "media",
          kind: "media-playback-settings",
          severity: "info",
          title: `${subject(kind, obj.ref.name, c.location)} ${START_TITLES[start]}`,
          detail: extras ? `${START_DETAILS[start]} ${extras}` : START_DETAILS[start],
          group: start,
          targets: [shapeTarget(obj.ref, pres)],
          fixes: [],
          reachable: false,
          data,
        }),
      );
    }
  }
  return out;
}

export const playbackChecks: Check[] = [
  { id: "media-playback", area: "media", run: ({ pres }) => runMedia(pres) },
  { id: "media-playback-settings", area: "media", run: ({ pres }) => runSettings(pres) },
];
