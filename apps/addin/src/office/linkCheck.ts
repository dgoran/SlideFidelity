/**
 * Link reachability client (U9, R11) for the license API's `POST /linkcheck`.
 *
 * Privacy (R18): only `http:`/`https:` URLs are ever sent. Everything else (mailto, file paths,
 * javascript:, data:, …) is reported `not-checked` locally and never leaves the device.
 *
 * The check is user-triggered. URLs are deduplicated and sent in batches of at most 50; the
 * per-URL results are merged back by exact URL string. Failures never throw: a 429 marks the
 * remaining URLs `not-checked` with reason `rate-limited` and a retry-after hint, and a network
 * failure marks that batch `not-checked`, so the listed links always remain.
 *
 * Contract: request `{urls: string[]}` (1–50, each ≤ 2048 chars) with `Authorization: Bearer`;
 * response `{results: [{url, status: 'ok'|'broken'|'unverified', http_status?, reason?}]}`;
 * errors 401 `unauthorized`, 403 `pro_required`, 400 `invalid_urls`,
 * 429 `rate_limited` | `daily_capacity_reached` with `Retry-After`.
 */

export const MAX_URLS_PER_REQUEST = 50;
export const MAX_URL_LENGTH = 2048;

export type LinkStatus = "ok" | "broken" | "unverified" | "not-checked";

export type NotCheckedReason =
  | "not-http"
  | "too-long"
  | "rate-limited"
  | "unauthorized"
  | "pro-required"
  | "invalid-request"
  | "network-error"
  | "server-error"
  | "no-result";

export interface LinkCheckResult {
  url: string;
  status: LinkStatus;
  /** HTTP status the backend saw, when it got one. */
  httpStatus?: number;
  /** Backend reason for `broken`/`unverified` (untrusted text), or a `NotCheckedReason`. */
  reason?: string;
  /** For `rate-limited`: seconds to wait before retrying. */
  retryAfterSeconds?: number;
}

export type LinkCheckErrorCode =
  | "unauthorized"
  | "pro_required"
  | "invalid_urls"
  | "rate_limited"
  | "daily_capacity_reached"
  | "network_error"
  | "server_error";

export interface LinkCheckReport {
  /** One entry per distinct input URL, in first-seen input order. */
  results: LinkCheckResult[];
  /** Lookup by exact URL string. */
  byUrl: Record<string, LinkCheckResult>;
  /** Requests actually sent. */
  requests: number;
  /** The most significant error encountered, for a banner ("rate limited, try later"). */
  error?: { code: LinkCheckErrorCode; retryAfterSeconds?: number };
}

export interface LinkCheckDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** License API origin, e.g. `https://api.slidecheck.io`. */
  baseUrl: string;
  /** Current session token, or null when signed out. */
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  signal?: AbortSignal;
}

/** True for absolute `http:`/`https:` URLs: the only ones we may send (R18). */
export function isHttpUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Checkable URLs from `hyperlink` findings (audit-core `HyperlinkData.checkable`), deduped. */
export function checkableUrls(findings: ReadonlyArray<{ kind: string; data?: unknown }>): string[] {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.kind !== "hyperlink") continue;
    const d = f.data as { address?: unknown; checkable?: unknown } | undefined;
    if (d && d.checkable === true && typeof d.address === "string" && isHttpUrl(d.address)) out.add(d.address);
  }
  return [...out];
}

function parseRetryAfter(header: string | null, body: unknown, now = Date.now()): number | undefined {
  if (header) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  const s = (body as { retry_after_seconds?: unknown } | null)?.retry_after_seconds;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.ceil(s) : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const SERVER_STATUSES = new Set(["ok", "broken", "unverified"]);

/** Parse the backend's results defensively; entries for URLs we did not send are ignored. */
function parseResults(body: unknown, sent: ReadonlySet<string>): Map<string, LinkCheckResult> {
  const out = new Map<string, LinkCheckResult>();
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return out;
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const { url, status, http_status, reason } = r as Record<string, unknown>;
    if (typeof url !== "string" || !sent.has(url) || typeof status !== "string" || !SERVER_STATUSES.has(status)) continue;
    out.set(url, {
      url,
      status: status as LinkStatus,
      ...(typeof http_status === "number" ? { httpStatus: http_status } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  return out;
}

function notChecked(url: string, reason: NotCheckedReason, retryAfterSeconds?: number): LinkCheckResult {
  return { url, status: "not-checked", reason, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
}

const ERROR_SEVERITY: Record<LinkCheckErrorCode, number> = {
  server_error: 1,
  network_error: 2,
  invalid_urls: 3,
  rate_limited: 4,
  daily_capacity_reached: 5,
  pro_required: 6,
  unauthorized: 7,
};

/**
 * Check the reachability of `urls`. Never throws for API or network failures; the report marks
 * affected URLs `not-checked` and sets `error`. Aborting via `signal` rejects with the abort error.
 */
export async function checkLinks(urls: readonly string[], deps: LinkCheckDeps): Promise<LinkCheckReport> {
  const doFetch = deps.fetch ?? fetch;
  const endpoint = `${deps.baseUrl.replace(/\/+$/, "")}/linkcheck`;
  const byUrl = new Map<string, LinkCheckResult>();
  const order: string[] = [];
  const seen = new Set<string>();
  const toSend: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    order.push(url);
    if (!isHttpUrl(url)) byUrl.set(url, notChecked(url, "not-http"));
    else if (url.length > MAX_URL_LENGTH) byUrl.set(url, notChecked(url, "too-long"));
    else toSend.push(url);
  }

  let error: LinkCheckReport["error"];
  const noteError = (code: LinkCheckErrorCode, retryAfterSeconds?: number): void => {
    if (!error || ERROR_SEVERITY[code] > ERROR_SEVERITY[error.code]) {
      error = { code, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
    }
  };
  let requests = 0;

  const batches: string[][] = [];
  for (let i = 0; i < toSend.length; i += MAX_URLS_PER_REQUEST) batches.push(toSend.slice(i, i + MAX_URLS_PER_REQUEST));

  const token = batches.length > 0 ? await deps.getToken() : undefined;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const rest = (): string[] => batches.slice(b).flat();
    if (!token) {
      noteError("unauthorized");
      for (const u of rest()) byUrl.set(u, notChecked(u, "unauthorized"));
      break;
    }
    let res: Response;
    try {
      requests++;
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ urls: batch }),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (e) {
      if (deps.signal?.aborted) throw e;
      noteError("network_error");
      for (const u of batch) byUrl.set(u, notChecked(u, "network-error"));
      continue;
    }

    if (res.ok) {
      const merged = parseResults(await readJson(res), new Set(batch));
      for (const u of batch) byUrl.set(u, merged.get(u) ?? notChecked(u, "no-result"));
      continue;
    }

    const body = await readJson(res);
    const code = (body as { error?: unknown } | null)?.error;
    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get("Retry-After"), body);
      noteError(code === "daily_capacity_reached" ? "daily_capacity_reached" : "rate_limited", retry);
      // Later batches would be refused too; don't spend more of the quota.
      for (const u of rest()) byUrl.set(u, notChecked(u, "rate-limited", retry));
      break;
    }
    if (res.status === 401 || res.status === 403) {
      const pro = res.status === 403 && code === "pro_required";
      noteError(pro ? "pro_required" : "unauthorized");
      for (const u of rest()) byUrl.set(u, notChecked(u, pro ? "pro-required" : "unauthorized"));
      break;
    }
    if (res.status === 400) {
      noteError("invalid_urls");
      for (const u of batch) byUrl.set(u, notChecked(u, "invalid-request"));
      continue;
    }
    noteError("server_error");
    for (const u of batch) byUrl.set(u, notChecked(u, "server-error"));
  }

  const results = order.map((u) => byUrl.get(u) ?? notChecked(u, "no-result"));
  return {
    results,
    byUrl: Object.fromEntries(results.map((r) => [r.url, r])),
    requests,
    ...(error ? { error } : {}),
  };
}
