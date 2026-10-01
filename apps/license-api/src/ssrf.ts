/**
 * SSRF guard for the link-check proxy (KTD9). Every hop's URL is checked: scheme, userinfo, host name,
 * and every resolved address must be public unicast.
 *
 * Residual risk: Workers `fetch` resolves DNS again itself, so a rebinding attacker could answer
 * differently between our DoH lookup and the fetch. Workers egress cannot reach private networks
 * behind Cloudflare, so the guard mainly protects against reaching third-party internal addresses
 * that are routable from the edge; the short TTL window is accepted.
 */

export type DnsResult = { status: "ok"; addresses: string[] } | { status: "nxdomain" } | { status: "error" };

export interface DnsResolver {
  resolve(hostname: string): Promise<DnsResult>;
}

export type TargetCheck = { ok: true } | { ok: false; reason: "blocked" | "nxdomain" | "dns_error" };

// --- address parsing ---

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":") || s.includes("%")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = s.slice(0, lastColon + 1) + "0"; // placeholder hextet, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length - (tail.length ? 1 : 0);
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (tail.length) groups = [...groups.slice(0, -1), ...tail];
  return groups.length === 8 ? groups : null;
}

// --- range checks ---

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const V4_RANGES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (parseIPv4(base)! & mask) >>> 0, mask };
});

function isPublicV4(n: number): boolean {
  return !V4_RANGES.some(({ net, mask }) => ((n & mask) >>> 0) === net);
}

function isPublicV6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::ffff:a.b.c.d (IPv4-mapped): judge by the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPublicV4(((g6 << 16) | g7) >>> 0);
  // Only global unicast 2000::/3 is allowed; this excludes ::, ::1, IPv4-compatible, ULA fc00::/7,
  // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, and NAT64 64:ff9b::/96.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 IETF assignments (Teredo, ORCHID, benchmarking)
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 can embed any IPv4 address
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isPublicV4(v4);
  const v6 = parseIPv6(ip);
  if (v6 !== null) return isPublicV6(v6);
  return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

/** Validates one hop's URL. Callers must invoke this for the original URL and every redirect target. */
export async function checkTarget(url: URL, resolver: DnsResolver): Promise<TargetCheck> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "blocked" };
  if (url.username || url.password) return { ok: false, reason: "blocked" };
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[")) return isPublicAddress(host.slice(1, -1)) ? { ok: true } : { ok: false, reason: "blocked" };
  if (/^[\d.]+$/.test(host)) return isPublicAddress(host) ? { ok: true } : { ok: false, reason: "blocked" };
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "blocked" };
  }
  const result = await resolver.resolve(host);
  if (result.status === "nxdomain") return { ok: false, reason: "nxdomain" };
  if (result.status === "error" || result.addresses.length === 0) return { ok: false, reason: "dns_error" };
  return result.addresses.every(isPublicAddress) ? { ok: true } : { ok: false, reason: "blocked" };
}

/**
 * Wraps a resolver so each hostname is looked up at most once while the wrapper lives (one /linkcheck
 * request). Callers still run `checkTarget` per URL and per hop; only the lookup is shared. Error results
 * and rejections are not kept, so a later hop or link retries the lookup exactly as it would unwrapped.
 */
export function memoizeResolver(resolver: DnsResolver): DnsResolver {
  const cache = new Map<string, Promise<DnsResult>>();
  return {
    resolve(hostname: string): Promise<DnsResult> {
      let pending = cache.get(hostname);
      if (!pending) {
        pending = resolver.resolve(hostname);
        cache.set(hostname, pending);
        pending.then(
          (r) => {
            if (r.status === "error" && cache.get(hostname) === pending) cache.delete(hostname);
          },
          () => {
            if (cache.get(hostname) === pending) cache.delete(hostname);
          },
        );
      }
      return pending;
    },
  };
}

// --- DNS over HTTPS ---

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: unknown }[];
}

/** Resolves A and AAAA via Cloudflare's DNS-over-HTTPS JSON API. Any partial failure is an error. */
export class DohResolver implements DnsResolver {
  constructor(
    private readonly fetcher: typeof fetch = (i, init) => fetch(i, init),
    private readonly endpoint = "https://cloudflare-dns.com/dns-query",
    private readonly timeoutMs = 3000,
  ) {}

  private async query(name: string, type: "A" | "AAAA"): Promise<DohAnswer | null> {
    try {
      const u = new URL(this.endpoint);
      u.searchParams.set("name", name);
      u.searchParams.set("type", type);
      const res = await this.fetcher(u.toString(), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as DohAnswer;
    } catch {
      return null;
    }
  }

  async resolve(hostname: string): Promise<DnsResult> {
    const [a, aaaa] = await Promise.all([this.query(hostname, "A"), this.query(hostname, "AAAA")]);
    if (a?.Status === 3 || aaaa?.Status === 3) return { status: "nxdomain" };
    if (!a || !aaaa || a.Status !== 0 || aaaa.Status !== 0) return { status: "error" };
    const addresses: string[] = [];
    for (const [answer, type] of [[a, 1], [aaaa, 28]] as const) {
      for (const rec of answer.Answer ?? []) {
        if (rec.type === type && typeof rec.data === "string") addresses.push(rec.data);
      }
    }
    return addresses.length ? { status: "ok", addresses } : { status: "error" };
  }
}
