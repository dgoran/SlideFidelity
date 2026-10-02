/**
 * SlideCheck Helper client (U12, R1): find the local helper and read its font list.
 *
 * The helper serves HTTPS on the first free port of 47317–47319 (host `localhost`). `probeHelper`
 * asks all three at once, each with its own timeout, and settles within `timeoutMs` whatever the
 * network does. Only a well-formed JSON health answer counts: `apiVersion` 1 is Connected, any
 * other integer is Outdated. Everything the helper sends is untrusted input: shapes are checked,
 * strings are length-capped, lists are count-capped, and nothing here ever throws.
 */

export const HELPER_PORTS = [47317, 47318, 47319] as const;
/** The helper API version this pane speaks. */
export const HELPER_API_VERSION = 1;
export const PROBE_TIMEOUT_MS = 1500;
export const FONTS_TIMEOUT_MS = 5000;
/** Caps on the font list (a machine has a few thousand faces at most). */
export const MAX_HELPER_FONT_NAMES = 20_000;
export const MAX_HELPER_FONT_NAME_LENGTH = 200;
const MAX_VERSION_LENGTH = 64;
const MAX_PAGE_LENGTH = 2048;
const MAX_NOTES_LENGTH = 2000;
const MAX_FAMILIES = 20_000;

/** The subset of `Response` the client reads. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;

export interface HelperUpdate {
  version: string;
  /** An https page (the download page) to open with `openBrowserWindow`. */
  page: string;
  notes?: string;
}

export interface HelperHealth {
  version: string;
  apiVersion: number;
  /** "mac" | "windows" as reported; other strings are kept but unused. */
  platform: string;
  /** Days until the helper's localhost certificate expires (H1), or null when unknown. */
  certDaysRemaining: number | null;
  /** A newer helper is available (H5, notify-only), or null. */
  update: HelperUpdate | null;
}

export type ProbeResult =
  | { kind: "connected"; port: number; health: HelperHealth }
  | { kind: "outdated"; port: number; health: HelperHealth }
  | { kind: "absent" };

export interface ProbeOptions {
  fetch: FetchLike;
  ports?: readonly number[];
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function shortString(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

function parseUpdate(v: unknown): HelperUpdate | null {
  if (!isRecord(v)) return null;
  const version = shortString(v.version, MAX_VERSION_LENGTH);
  const page = shortString(v.page, MAX_PAGE_LENGTH);
  if (!version || !page || !isHttpsUrl(page)) return null;
  const notes = shortString(v.notes, MAX_NOTES_LENGTH);
  return { version, page, ...(notes ? { notes } : {}) };
}

/** Validate a `/v1/health` body; null when it isn't a helper health answer. */
export function parseHealth(v: unknown): HelperHealth | null {
  if (!isRecord(v)) return null;
  const version = shortString(v.version, MAX_VERSION_LENGTH);
  const apiVersion = v.apiVersion;
  if (!version || typeof apiVersion !== "number" || !Number.isInteger(apiVersion)) return null;
  const days = v.certDaysRemaining;
  return {
    version,
    apiVersion,
    platform: shortString(v.platform, 32) ?? "",
    certDaysRemaining: typeof days === "number" && Number.isFinite(days) ? Math.floor(days) : null,
    update: parseUpdate(v.update),
  };
}

/**
 * GET `url` as JSON within `timeoutMs`; undefined on any failure (network, status, JSON, timeout,
 * even a fetch that ignores its abort signal).
 */
async function getJson(fetch: FetchLike, url: string, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const request = (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
      if (!res || !res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

const baseUrl = (port: number) => `https://localhost:${port}`;

/**
 * Probe every port in parallel. Resolves with the first Connected answer as soon as it arrives;
 * otherwise, once every port has answered or timed out, with an Outdated answer (if any) or Absent.
 */
export async function probeHelper({ fetch, ports = HELPER_PORTS, timeoutMs = PROBE_TIMEOUT_MS }: ProbeOptions): Promise<ProbeResult> {
  if (typeof fetch !== "function" || ports.length === 0) return { kind: "absent" };
  const stop = new AbortController();
  return new Promise<ProbeResult>((resolve) => {
    let pending = ports.length;
    let outdated: ProbeResult | undefined;
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      stop.abort();
      resolve(r);
    };
    for (const port of ports) {
      void getJson(fetch, `${baseUrl(port)}/v1/health`, timeoutMs, stop.signal).then((body) => {
        const health = parseHealth(body);
        if (health && health.apiVersion === HELPER_API_VERSION) finish({ kind: "connected", port, health });
        else if (health && !outdated) outdated = { kind: "outdated", port, health };
        pending -= 1;
        if (pending === 0) finish(outdated ?? { kind: "absent" });
      });
    }
  });
}

/**
 * The helper's font list, flattened: every family's `names` (or its `name` when it has none),
 * trimmed, deduped case-insensitively, capped. Null when the request fails or the body is
 * malformed (so the caller can tell "no list" from "an empty list").
 */
export async function fetchHelperFonts(port: number, fetch: FetchLike, timeoutMs = FONTS_TIMEOUT_MS): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const body = await getJson(fetch, `${baseUrl(port)}/v1/fonts`, timeoutMs);
  if (!isRecord(body) || !Array.isArray(body.families)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const name = v.trim();
    if (!name || name.length > MAX_HELPER_FONT_NAME_LENGTH) return;
    const k = name.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(name);
  };
  for (const family of body.families.slice(0, MAX_FAMILIES)) {
    if (out.length >= MAX_HELPER_FONT_NAMES) break;
    if (!isRecord(family)) continue;
    const names = Array.isArray(family.names) ? family.names.filter((n) => typeof n === "string") : [];
    if (names.length === 0) add(family.name);
    for (const n of names) {
      if (out.length >= MAX_HELPER_FONT_NAMES) break;
      add(n);
    }
  }
  return out;
}
