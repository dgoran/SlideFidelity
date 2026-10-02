/**
 * Test-only fakes for the SlideCheck Helper client and store (U12): a URL-routed fake fetch, health
 * and JSON response builders, and a request that hangs until aborted.
 */
import { vi } from "vitest";
import type { FetchLike } from "./client";

export function health(over: Record<string, unknown> = {}) {
  return { version: "0.1.0", apiVersion: 1, platform: "mac", certDaysRemaining: 823, update: null, ...over };
}

export function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type Route = (url: string, init?: RequestInit) => Promise<unknown>;

/** A fake fetch routed by URL; unknown URLs fail like a refused connection. */
export function fakeFetch(routes: Record<string, Route | unknown>) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const r = routes[url];
    if (r === undefined) return Promise.reject(new TypeError("Failed to fetch"));
    if (typeof r === "function") return (r as Route)(url, init) as Promise<never>;
    return Promise.resolve(r as never);
  });
  return fn as typeof fn & FetchLike;
}

/** Never settles unless aborted (like a port that accepts but never answers). */
export function hang(_url: string, init?: RequestInit): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}
