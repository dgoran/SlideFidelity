import { sha256Hex } from "./util";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Default abuse limits. Windows are fixed (aligned to multiples of the window length). */
export const LIMITS = {
  authStartPerIp: { limit: 20, windowMs: HOUR },
  authStartPerEmail: { limit: 6, windowMs: HOUR },
  newAccountPerIp: { limit: 5, windowMs: HOUR },
  authVerifyPerIp: { limit: 30, windowMs: HOUR },
  linkcheckPerAccount: { limit: 30, windowMs: HOUR },
  linkcheckPerIp: { limit: 60, windowMs: HOUR },
  linkcheckGlobalUrlsPerDay: { limit: 20_000, windowMs: DAY },
} as const;

export interface RateDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Adds `cost` to the counter for `key` in the current window and reports whether it stays within `limit`. */
  consume(key: string, limit: number, windowMs: number, now: number, cost?: number): Promise<RateDecision>;
  /** Reads the counter without changing it. */
  peek(key: string, limit: number, windowMs: number, now: number, cost?: number): Promise<RateDecision>;
}

/** Fixed-window counters stored in the D1 `rate_limits` table. */
export class D1RateLimiter implements RateLimiter {
  constructor(private readonly db: D1Database) {}

  async consume(key: string, limit: number, windowMs: number, now: number, cost = 1): Promise<RateDecision> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + excluded.count
         RETURNING count`,
      )
      .bind(key, windowStart, cost, windowStart + windowMs)
      .first<{ count: number }>();
    const used = row?.count ?? Number.MAX_SAFE_INTEGER;
    return { allowed: used <= limit, retryAfterMs: windowStart + windowMs - now };
  }

  async peek(key: string, limit: number, windowMs: number, now: number, cost = 1): Promise<RateDecision> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const row = await this.db
      .prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?")
      .bind(key, windowStart)
      .first<{ count: number }>();
    return { allowed: (row?.count ?? 0) + cost <= limit, retryAfterMs: windowStart + windowMs - now };
  }
}

/** Rate-limit keys never contain raw IPs or emails. */
export async function hashedKey(scope: string, identifier: string): Promise<string> {
  return `${scope}:${(await sha256Hex(`rl:${identifier}`)).slice(0, 32)}`;
}
