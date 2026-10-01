/**
 * Link check session store (U9 UI, R11, R18): shared by the Links area panel (`fixPanelSlot`) and
 * the per-row status badges (`renderRowActions`). A tiny external store (useSyncExternalStore), like
 * the fix controller, so results survive the panel and rows re-mounting.
 *
 * - The privacy disclosure is accepted once per pane session (in memory only).
 * - Results belong to the `AuditResult` they were checked for and are keyed by exact address; a new
 *   scan (a different result object) clears them and aborts a check still in flight.
 * - The check is user-triggered; `cancel()` aborts the request.
 */
import { useSyncExternalStore } from "react";
import type { AuditResult } from "@slidecheck/audit-core";
import { checkLinks, type LinkCheckDeps, type LinkCheckErrorCode, type LinkCheckReport, type LinkCheckResult } from "../../office/linkCheck";

export interface LinkCheckSlotDeps {
  /** License API origin (`config.apiBase`). */
  baseUrl: string;
  /** The license service's session token (`LicenseService.getSessionToken`). */
  getToken: () => string | null;
  /** Injected for tests; defaults to `checkLinks`. */
  checkLinks?: (urls: readonly string[], deps: LinkCheckDeps) => Promise<LinkCheckReport>;
  /** Called when the API refused the session (401), so the license state can catch up. */
  onUnauthorized?: () => void;
}

export type LinkCheckPhase = "idle" | "disclosure" | "checking" | "done" | "cancelled";

export interface LinkCheckCounts {
  ok: number;
  broken: number;
  unverified: number;
  notChecked: number;
}

export interface LinkCheckState {
  phase: LinkCheckPhase;
  /** The privacy disclosure was accepted this session. */
  accepted: boolean;
  /** The scan result these results (and any running check) belong to. */
  forResult: AuditResult | null;
  /** Results by exact address. */
  byUrl: Readonly<Record<string, LinkCheckResult>>;
  /** URLs being checked (while `checking`) or waiting on the disclosure. */
  pending: readonly string[];
  counts?: LinkCheckCounts;
  error?: { code: LinkCheckErrorCode; retryAfterSeconds?: number };
}

export interface LinkCheckController {
  get(): LinkCheckState;
  subscribe(listener: () => void): () => void;
  /** "Check links": shows the disclosure first unless it was accepted this session. */
  request(result: AuditResult, urls: readonly string[]): void;
  /** Disclosure "Continue". */
  accept(): void;
  /** Disclosure "Cancel". */
  decline(): void;
  /** Abort the running check. */
  cancel(): void;
  /** Drop results (and abort a check) that belong to a different scan result. */
  sync(result: AuditResult | null): void;
}

const EMPTY: Readonly<Record<string, LinkCheckResult>> = Object.freeze({});

export function countResults(results: readonly LinkCheckResult[]): LinkCheckCounts {
  const c: LinkCheckCounts = { ok: 0, broken: 0, unverified: 0, notChecked: 0 };
  for (const r of results) {
    if (r.status === "ok") c.ok += 1;
    else if (r.status === "broken") c.broken += 1;
    else if (r.status === "unverified") c.unverified += 1;
    else c.notChecked += 1;
  }
  return c;
}

export function createLinkCheckController(deps: LinkCheckSlotDeps): LinkCheckController {
  const run = deps.checkLinks ?? checkLinks;
  let state: LinkCheckState = { phase: "idle", accepted: false, forResult: null, byUrl: EMPTY, pending: [] };
  let abort: AbortController | null = null;
  let gen = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const replace = (next: LinkCheckState) => {
    state = next;
    emit();
  };
  const set = (patch: Partial<LinkCheckState>) => replace({ ...state, ...patch });
  /** A state with no results, keeping the session's disclosure acceptance. */
  const blank = (forResult: AuditResult | null, pending: readonly string[] = []): LinkCheckState => ({
    phase: "idle",
    accepted: state.accepted,
    forResult,
    byUrl: EMPTY,
    pending,
  });

  const stop = () => {
    gen += 1;
    abort?.abort();
    abort = null;
  };

  const start = () => {
    const urls = state.pending;
    const forResult = state.forResult;
    if (urls.length === 0 || !forResult) {
      set({ phase: "idle", pending: [] });
      return;
    }
    stop();
    const my = gen;
    const ac = new AbortController();
    abort = ac;
    // A new check replaces the previous one's results.
    replace({ ...blank(forResult, urls), phase: "checking" });
    run(urls, { baseUrl: deps.baseUrl, getToken: () => deps.getToken(), signal: ac.signal }).then(
      (report) => {
        if (my !== gen) return;
        abort = null;
        replace({
          ...blank(forResult),
          phase: "done",
          byUrl: report.byUrl,
          counts: countResults(report.results),
          ...(report.error ? { error: report.error } : {}),
        });
        if (report.error?.code === "unauthorized") deps.onUnauthorized?.();
      },
      () => {
        if (my !== gen) return;
        abort = null;
        if (ac.signal.aborted) replace({ ...blank(forResult), phase: "cancelled" });
        // checkLinks only rejects on abort; anything else is reported like a network failure.
        else replace({ ...blank(forResult), phase: "done", error: { code: "network_error" } });
      },
    );
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(result, urls) {
      if (state.phase === "checking") return;
      if (state.forResult !== result) {
        stop();
        state = blank(result);
      }
      set({ pending: [...urls] });
      if (state.accepted) start();
      else set({ phase: "disclosure" });
    },
    accept() {
      if (state.phase !== "disclosure") return;
      set({ accepted: true });
      start();
    },
    decline() {
      if (state.phase !== "disclosure") return;
      set({ phase: state.counts || state.error ? "done" : "idle", pending: [] });
    },
    cancel() {
      if (state.phase !== "checking") return;
      abort?.abort();
    },
    sync(result) {
      if (state.forResult === result || state.forResult === null) return;
      stop();
      replace(blank(null));
    },
  };
}

export function useLinkCheck(controller: LinkCheckController): LinkCheckState {
  return useSyncExternalStore(controller.subscribe, controller.get, controller.get);
}

/** The state as seen for `result`: results from another scan are not shown. */
export function viewFor(state: LinkCheckState, result: AuditResult | null): LinkCheckState | null {
  return result && state.forResult === result ? state : null;
}
