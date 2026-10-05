/**
 * SlideFidelity Helper pane state (U12, HTD "Pane helper-state machine"; R1, R3–R6; H5, H7).
 *
 *   Probing → Connected (health ok, apiVersion compatible, font list read)
 *           → Outdated  (health ok, another apiVersion)
 *           → Absent    → Offered (desktop Mac/PC host, not dismissed)
 *                       → Silent  (web, iPad, mobile; "Not now" for this session; "Don't ask again")
 *   Offered / Outdated → Waiting (Install: the download page opens; health is polled every 3 s)
 *   Waiting → Connected when the helper answers; → back after 5 minutes, or on Cancel.
 *   Connected → Absent when a later probe fails (checked before each scan, R4).
 *
 * The store probes once when the pane opens (`start`), and before every user scan refetches the
 * font list (`beforeScan`) so the synchronous scan options (`auditOptions`) see a fresh list. On
 * hosts other than desktop Mac/PC nothing is probed, offered, or polled (AE3).
 *
 * "Don't ask again" is kept in `localStorage`; every access is guarded and a storage failure falls
 * back to remembering the choice for this session only. Timers, fetch, storage, and the host
 * platform are injected for tests.
 */
import type { AuditOptions } from "@slidefidelity/audit-core";
import { fetchHelperFonts, HELPER_PORTS, isHttpsUrl, probeHelper, PROBE_TIMEOUT_MS, type FetchLike, type HelperHealth } from "./client";

export const HELPER_DISMISS_KEY = "slidefidelity:helperOfferDismissed";
export const HELPER_POLL_MS = 3000;
export const HELPER_WAIT_MS = 5 * 60_000;
/** Below this many days, the pane asks for a reinstall to renew the certificate (H1). */
export const CERT_RENEW_DAYS = 90;

/** "mac" / "windows": PowerPoint desktop. "other": web, iPad, mobile, unknown. */
export type HelperPlatform = "mac" | "windows" | "other";

export type HelperPhase = "probing" | "connected" | "outdated" | "offered" | "waiting" | "silent";
export type SilentReason = "host" | "not-now" | "dismissed";

export interface HelperSnapshot {
  phase: HelperPhase;
  platform: HelperPlatform;
  /** Connected / Outdated (and while waiting to replace an outdated helper). */
  health: HelperHealth | null;
  port: number | null;
  /** The helper's font names (Connected only). */
  fonts: readonly string[] | null;
  /** Why the offer is hidden (Silent only). */
  reason: SilentReason | null;
  /** False when "Don't ask again" could not be saved (it lasts for this session). */
  dismissPersistent: boolean;
}

export interface HelperStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HelperStoreOptions {
  fetch: FetchLike;
  platform: HelperPlatform;
  /** Opens a page in the user's browser (`Office.context.ui.openBrowserWindow`). */
  openBrowserWindow: (url: string) => void;
  /** Defaults to `globalThis.localStorage` (guarded). `null`: session only. */
  storage?: HelperStorage | null;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  ports?: readonly number[];
  timeoutMs?: number;
  pollMs?: number;
  waitMs?: number;
}

export interface HelperStore {
  getSnapshot(): HelperSnapshot;
  subscribe(listener: () => void): () => void;
  /** Probe once (later calls return the same promise). */
  start(): Promise<void>;
  /**
   * Offered / Outdated (or hidden by Not now / Don't ask again, from Settings): open the download
   * page and wait for the helper.
   */
  install(): void;
  /** Waiting: stop waiting and show the offer again. */
  cancelInstall(): void;
  /** Offered: hide the offer for this session. */
  notNow(): void;
  /** Offered: hide the offer for good (persisted when storage allows). */
  dontAskAgain(): void;
  /** Open the platform download page (reinstall / renew the certificate). */
  openDownloadPage(): void;
  /** Open the helper's update page (H5), when it reported an https one. */
  openUpdatePage(): void;
  /** Before a user scan: refresh the font list when Connected; re-probe if that fails (R4). */
  beforeScan(): Promise<void>;
  /** `{ localFonts }` when Connected, else `{}`. Synchronous: read by the scan's `getOptions`. */
  auditOptions(): Pick<AuditOptions, "localFonts">;
  dispose(): void;
}

export function helperDownloadUrl(platform: "mac" | "windows"): string {
  return `https://slidefidelity.com/helper?platform=${platform}`;
}

/** Map `Office.context.platform` to a helper platform. */
export function helperPlatformOf(officePlatform: unknown): HelperPlatform {
  if (officePlatform === "PC") return "windows";
  if (officePlatform === "Mac") return "mac";
  return "other";
}

function defaultStorage(): HelperStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createHelperStore(o: HelperStoreOptions): HelperStore {
  const set = o.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clear = o.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = o.now ?? (() => Date.now());
  const ports = o.ports ?? HELPER_PORTS;
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const pollMs = o.pollMs ?? HELPER_POLL_MS;
  const waitMs = o.waitMs ?? HELPER_WAIT_MS;
  const storage = o.storage === undefined ? defaultStorage() : o.storage;
  const desktop = o.platform === "mac" || o.platform === "windows";
  const listeners = new Set<() => void>();

  let dismissed = false;
  let dismissPersistent = true;
  try {
    dismissed = storage?.getItem(HELPER_DISMISS_KEY) === "1";
  } catch {
    dismissed = false;
  }
  let notNow = false;

  let snap: HelperSnapshot = {
    phase: desktop ? "probing" : "silent",
    platform: o.platform,
    health: null,
    port: null,
    fonts: null,
    reason: desktop ? null : "host",
    dismissPersistent,
  };
  let started: Promise<void> | null = null;
  /** Bumped by every transition that makes in-flight results stale. */
  let generation = 0;
  let poll: unknown = null;
  let waitUntil = 0;
  let disposed = false;

  function emit(next: Partial<HelperSnapshot>) {
    snap = { ...snap, ...next, dismissPersistent };
    for (const l of [...listeners]) l();
  }

  /** The state for "no usable helper": the offer, or silence. */
  function absentState(): Partial<HelperSnapshot> {
    const base = { health: null, port: null, fonts: null };
    if (!desktop) return { ...base, phase: "silent", reason: "host" };
    if (dismissed) return { ...base, phase: "silent", reason: "dismissed" };
    if (notNow) return { ...base, phase: "silent", reason: "not-now" };
    return { ...base, phase: "offered", reason: null };
  }

  /** Probe, then read the font list. Connected needs both (else no local list: Absent). */
  async function detect(): Promise<Partial<HelperSnapshot>> {
    const r = await probeHelper({ fetch: o.fetch, ports, timeoutMs });
    if (r.kind === "outdated") return { phase: "outdated", health: r.health, port: r.port, fonts: null, reason: null };
    if (r.kind === "connected") {
      const fonts = await fetchHelperFonts(r.port, o.fetch);
      if (fonts) return { phase: "connected", health: r.health, port: r.port, fonts, reason: null };
    }
    return absentState();
  }

  function stopPolling() {
    if (poll !== null) clear(poll);
    poll = null;
  }

  function schedulePoll(gen: number) {
    poll = set(() => {
      poll = null;
      void (async () => {
        const next = await detect();
        if (gen !== generation || disposed) return;
        if (next.phase === "connected") {
          generation += 1;
          emit(next);
          return;
        }
        if (now() >= waitUntil) {
          generation += 1;
          emit(next.phase === "outdated" ? next : absentState());
          return;
        }
        schedulePoll(gen);
      })();
    }, pollMs);
  }

  function openPage(url: string) {
    try {
      o.openBrowserWindow(url);
    } catch {
      /* the host refused; nothing else to do */
    }
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (!desktop) return Promise.resolve();
      started ??= (async () => {
        const gen = ++generation;
        const next = await detect();
        if (gen === generation && !disposed) emit(next);
      })();
      return started;
    },
    install() {
      const canInstall = snap.phase === "offered" || snap.phase === "outdated" || (snap.phase === "silent" && snap.reason !== "host");
      if (!desktop || !canInstall) return;
      openPage(helperDownloadUrl(o.platform as "mac" | "windows"));
      stopPolling();
      const gen = ++generation;
      waitUntil = now() + waitMs;
      emit({ phase: "waiting", reason: null, fonts: null });
      schedulePoll(gen);
    },
    cancelInstall() {
      if (snap.phase !== "waiting") return;
      stopPolling();
      generation += 1;
      emit(snap.health ? { phase: "outdated" } : absentState());
    },
    notNow() {
      if (snap.phase !== "offered") return;
      notNow = true;
      emit(absentState());
    },
    dontAskAgain() {
      if (snap.phase !== "offered") return;
      dismissed = true;
      try {
        if (!storage) throw new Error("no storage");
        storage.setItem(HELPER_DISMISS_KEY, "1");
        dismissPersistent = true;
      } catch {
        dismissPersistent = false; // remembered for this session only
      }
      emit(absentState());
    },
    openDownloadPage() {
      if (desktop) openPage(helperDownloadUrl(o.platform as "mac" | "windows"));
    },
    openUpdatePage() {
      const page = snap.health?.update?.page;
      if (page && isHttpsUrl(page)) openPage(page);
    },
    async beforeScan() {
      if (!desktop || snap.phase !== "connected" || snap.port === null) return;
      const gen = generation;
      const fonts = await fetchHelperFonts(snap.port, o.fetch);
      if (gen !== generation || disposed) return;
      if (fonts) {
        emit({ fonts });
        return;
      }
      const next = await detect();
      if (gen !== generation || disposed) return;
      generation += 1;
      emit(next);
    },
    auditOptions: () => (snap.phase === "connected" && snap.fonts ? { localFonts: [...snap.fonts] } : {}),
    dispose() {
      disposed = true;
      stopPolling();
      listeners.clear();
    },
  };
}

/** Whether the H1 certificate-renewal note applies. */
export function certNeedsRenewal(health: HelperHealth | null): health is HelperHealth & { certDaysRemaining: number } {
  return health !== null && typeof health.certDaysRemaining === "number" && health.certDaysRemaining < CERT_RENEW_DAYS;
}
