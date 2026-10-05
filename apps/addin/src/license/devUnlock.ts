/**
 * Development-only Pro unlock, so a sideloaded add-in can exercise Pro features before the license
 * API is deployed. It needs BOTH a development build and a page served from a loopback host.
 * `__SLIDEFIDELITY_DEV__` is a webpack DefinePlugin constant: `false` in production builds, so the
 * minifier removes the unlock branch and production bundles cannot enable it.
 */
import type { Plan } from "./gate";

declare const __SLIDEFIDELITY_DEV__: boolean | undefined;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function devUnlockActive(env: { devBuild: boolean; hostname: string }): boolean {
  return env.devBuild && isLocalHostname(env.hostname);
}

/** Reads the build flag and the page's host name. False outside a development build. */
export function devUnlockFromEnvironment(): boolean {
  const devBuild = typeof __SLIDEFIDELITY_DEV__ !== "undefined" && __SLIDEFIDELITY_DEV__ === true;
  if (!devBuild) return false;
  return devUnlockActive({ devBuild, hostname: typeof location === "undefined" ? "" : location.hostname });
}

export function effectivePlan(plan: Plan, unlocked: boolean): Plan {
  return unlocked ? "pro" : plan;
}
