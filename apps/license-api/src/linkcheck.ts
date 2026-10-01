/**
 * Link reachability (R11, KTD9). Privacy: submitted URLs are never logged or persisted; response
 * bodies are read up to BYTE_CAP and discarded.
 */
import type { Context } from "hono";
import { clientIp, readJson, tooMany } from "./auth";
import { planFor } from "./entitlement";
import type { HonoEnv } from "./env";
import { LIMITS, hashedKey } from "./ratelimit";
import { checkTarget, memoizeResolver, type DnsResolver } from "./ssrf";

export const MAX_URLS = 50;
export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 5;
export const BYTE_CAP = 64 * 1024;
export const CONCURRENCY = 6;
const USER_AGENT = "SlideCheck-LinkChecker/1.0 (+https://slidecheck.io/linkcheck)";

export type LinkStatus = "ok" | "broken" | "unverified";

export interface LinkResult {
  url: string;
  status: LinkStatus;
  http_status?: number;
  reason?: string;
}

export interface LinkCheckDeps {
  resolver: DnsResolver;
  fetch: typeof fetch;
  timeoutMs: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function classify(url: string, status: number): LinkResult {
  if (status >= 200 && status < 400) return { url, status: "ok", http_status: status };
  if (status === 404 || status === 410) return { url, status: "broken", http_status: status, reason: status === 404 ? "not_found" : "gone" };
  let reason = "http_error";
  if (status === 401 || status === 403) reason = "access_denied";
  else if (status === 429 || status === 999) reason = "rate_limited";
  else if (status >= 500 && status < 600) reason = "server_error";
  return { url, status: "unverified", http_status: status, reason };
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

async function readCapped(res: Response, cap: number): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function checkLink(raw: string, deps: LinkCheckDeps): Promise<LinkResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: raw, status: "unverified", reason: "invalid_url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), deps.timeoutMs);
  const { signal } = controller;
  const request = (method: "HEAD" | "GET") =>
    abortable(
      deps.fetch(url.toString(), { method, redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } }),
      signal,
    );
  try {
    for (let redirects = 0; ; redirects++) {
      const target = await abortable(checkTarget(url, deps.resolver), signal);
      if (!target.ok) {
        return target.reason === "nxdomain"
          ? { url: raw, status: "broken", reason: "nxdomain" }
          : { url: raw, status: "unverified", reason: target.reason };
      }
      let res = await request("HEAD");
      if (!REDIRECTS.has(res.status) && res.status >= 400) {
        // Many servers mishandle HEAD; confirm with a capped GET.
        discard(res);
        res = await request("GET");
        if (!REDIRECTS.has(res.status)) await abortable(readCapped(res, BYTE_CAP), signal);
      }
      discard(res);
      const location = res.headers.get("Location");
      if (REDIRECTS.has(res.status) && location) {
        if (redirects >= MAX_REDIRECTS) return { url: raw, status: "unverified", reason: "too_many_redirects" };
        try {
          url = new URL(location, url);
        } catch {
          return { url: raw, status: "unverified", reason: "invalid_redirect" };
        }
        continue;
      }
      return classify(raw, res.status);
    }
  } catch {
    return { url: raw, status: "unverified", reason: signal.aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks a batch (one /linkcheck request). DNS lookups are shared per hostname across the batch. */
export async function checkLinks(urls: string[], deps: LinkCheckDeps, concurrency = CONCURRENCY): Promise<LinkResult[]> {
  const batchDeps: LinkCheckDeps = { ...deps, resolver: memoizeResolver(deps.resolver) };
  const results = new Array<LinkResult>(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await checkLink(urls[i]!, batchDeps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

export async function handleLinkcheck(c: Context<HonoEnv>) {
  const { deps, account } = c.var;
  const { plan } = await planFor(c, account);
  if (plan === "free") return c.json({ error: "pro_required" }, 403);

  const body = await readJson(c);
  const urls = body?.urls;
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.length > MAX_URLS ||
    !urls.every((u): u is string => typeof u === "string" && u.length > 0 && u.length <= MAX_URL_LENGTH)
  ) {
    return c.json({ error: "invalid_urls", max_urls: MAX_URLS, max_url_length: MAX_URL_LENGTH }, 400);
  }

  const now = deps.now();
  const { limiter } = deps;
  const ipKey = await hashedKey("linkcheck_ip", clientIp(c));
  // Sequential on purpose: each check only spends budget once the previous one has passed.
  const perAccount = await limiter.consume(
    `linkcheck_account:${account.id}`,
    LIMITS.linkcheckPerAccount.limit,
    LIMITS.linkcheckPerAccount.windowMs,
    now,
  );
  if (!perAccount.allowed) return tooMany(c, perAccount.retryAfterMs);
  const accountUrls = await limiter.consume(
    `linkcheck_account_urls:${account.id}`,
    LIMITS.linkcheckUrlsPerAccountPerDay.limit,
    LIMITS.linkcheckUrlsPerAccountPerDay.windowMs,
    now,
    urls.length,
  );
  if (!accountUrls.allowed) return tooMany(c, accountUrls.retryAfterMs);
  const perIp = await limiter.consume(ipKey, LIMITS.linkcheckPerIp.limit, LIMITS.linkcheckPerIp.windowMs, now);
  if (!perIp.allowed) return tooMany(c, perIp.retryAfterMs);
  const ipUrls = await limiter.consume(
    `${ipKey}:urls`,
    LIMITS.linkcheckUrlsPerIpPerDay.limit,
    LIMITS.linkcheckUrlsPerIpPerDay.windowMs,
    now,
    urls.length,
  );
  if (!ipUrls.allowed) return tooMany(c, ipUrls.retryAfterMs);
  const cap = Number(c.env.LINKCHECK_GLOBAL_DAILY_URL_CAP) || LIMITS.linkcheckGlobalUrlsPerDay.limit;
  const global = await limiter.consume("linkcheck_global_urls", cap, LIMITS.linkcheckGlobalUrlsPerDay.windowMs, now, urls.length);
  if (!global.allowed) return tooMany(c, global.retryAfterMs, "daily_capacity_reached");

  const results = await checkLinks(urls, { resolver: deps.resolver, fetch: deps.fetch, timeoutMs: deps.linkTimeoutMs });
  return c.json({ results });
}
