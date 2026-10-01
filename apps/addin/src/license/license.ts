/**
 * License state for the task pane (U15; R19–R21, D8, D12, KTD7).
 *
 * Sources of truth, in order: the session (no session = anonymous), then a verified entitlement
 * token. The token is cached so Pro survives restarts and up to 7 days offline (`grace_until`).
 * A network or server failure never downgrades a valid cached token; only time does.
 *
 * `state.plan` uses the gate.ts `Plan` values, so the integrator passes it straight to the gate.
 */
import { ApiError, createLicenseApi, type ApiAccount, type LicenseApi, type StartAuthResult } from "./api";
import { createLicenseConfig, type EntitlementPublicKey, type LicenseConfig } from "./config";
import { deriveEntitlement, entitlementPhase, verifyEntitlementToken, type EntitlementClaims, type LicensePlan } from "./entitlement";
import { createSessionStore, type SessionStore, type StoredSession } from "./session";

export type { LicensePlan } from "./entitlement";

const DAY_MS = 86_400_000;
/** D8: the non-blocking trial notice appears when this many days (or fewer) remain. */
export const TRIAL_WARNING_DAYS = 3;
/** Default age after which `refreshIfStale` calls the API again (R21: purchases show within a minute of a refresh). */
export const DEFAULT_STALE_MS = 60 * 60_000;

/** Why the plan is what it is, when that needs explaining (D12). */
export type LicenseReason =
  /** Offline for longer than the 7-day grace: Pro lapsed until the next successful check. */
  | "grace-ended"
  /** The 30-day trial ended with no subscription. */
  | "trial-ended"
  /** A paid subscription ran out (canceled, or the paid period ended) while online. */
  | "subscription-ended"
  /** The server no longer accepts the session (revoked or expired): signed out. */
  | "session-expired"
  /** A cached or served entitlement failed verification and was discarded. */
  | "token-rejected";

export interface LicenseState {
  plan: LicensePlan;
  account?: { email: string };
  /** Epoch ms; present while on a trial. */
  trialEndsAt?: number;
  /** Whole days left, rounded up; present while on a trial. */
  trialDaysLeft?: number;
  /** Epoch ms when offline Pro lapses; present while the last check failed or the token is in grace. */
  graceUntil?: number;
  /** The last refresh could not reach the API. */
  offline?: boolean;
  /** Epoch ms of the last successful entitlement check; null when never checked. */
  lastChecked: number | null;
  reason?: LicenseReason;
  /** False when storage is unavailable: sign-in lasts for this pane session only. */
  persistent: boolean;
}

export type LicenseEvent =
  | { type: "signed-in"; email: string }
  | { type: "signed-out" }
  | { type: "session-expired" }
  | { type: "account-deleted" }
  | { type: "token-rejected" }
  | { type: "plan-changed"; from: LicensePlan; to: LicensePlan }
  | { type: "trial-ending"; daysLeft: number }
  | { type: "offline-grace"; graceUntil: number }
  | { type: "grace-ended" };

export type LicenseErrorCode = "billing_cancel_failed" | "not_signed_in" | "session_expired" | "network" | "unknown";

/** User-facing failure from an account action; `message` is safe to show as-is. */
export class LicenseError extends Error {
  constructor(
    readonly code: LicenseErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

export interface LicenseServiceOptions {
  api: LicenseApi;
  store: SessionStore;
  keys: readonly EntitlementPublicKey[];
  /** Website origin; `/account.html` is the manage-subscription fallback. */
  siteUrl: string;
  now?: () => number;
}

export interface SignInSession {
  sessionToken: string;
  account: ApiAccount;
  expiresAt?: number;
}

export class LicenseService {
  private readonly api: LicenseApi;
  private readonly store: SessionStore;
  private readonly keys: readonly EntitlementPublicKey[];
  private readonly siteUrl: string;
  private readonly now: () => number;

  private session: StoredSession | null = null;
  private claims: EntitlementClaims | null = null;
  private offline = false;
  private rejected = false;
  private lastChecked: number | null = null;
  private anonymousReason: LicenseReason | undefined;
  /** Plan of the last non-free entitlement seen this session (in memory): tells a lapsed subscriber from a lapsed trial. */
  private lastEntitledPlan: "trial" | "pro" | null = null;
  private trialWarned = false;
  private generation = 0;
  private inflight: { gen: number; promise: Promise<void> } | null = null;

  private state: LicenseState;
  private readonly listeners = new Set<(s: LicenseState) => void>();
  private readonly eventListeners = new Set<(e: LicenseEvent) => void>();

  constructor(options: LicenseServiceOptions) {
    this.api = options.api;
    this.store = options.store;
    this.keys = options.keys;
    this.siteUrl = options.siteUrl.replace(/\/+$/, "");
    this.now = options.now ?? (() => Date.now());
    this.state = { plan: "anonymous", lastChecked: null, persistent: this.store.persistent };
  }

  // --- observation ---

  getState(): LicenseState {
    return this.state;
  }

  /** Called on every state change (not immediately). Returns an unsubscribe function. */
  subscribe(listener: (s: LicenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The current session token (loaded from the session store by `init`, or adopted at sign-in),
   * or null when signed out. Used as the bearer for server-enforced features such as the link
   * check (R11). Never log or display it.
   */
  getSessionToken(): string | null {
    return this.session?.token ?? null;
  }

  onEvent(listener: (e: LicenseEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // --- lifecycle ---

  /**
   * Loads and verifies the cache, publishes that state, then refreshes in the background.
   * Resolves once the cached state is published; `refreshed` settles after the network check.
   */
  async init(): Promise<{ refreshed: Promise<void> }> {
    const gen = this.generation;
    const session = this.store.loadSession();
    this.session = session;
    if (!session) {
      this.publish();
      return { refreshed: Promise.resolve() };
    }
    const cached = this.store.loadEntitlement();
    if (cached) {
      const r = await verifyEntitlementToken(cached, this.keys);
      if (gen !== this.generation) return { refreshed: Promise.resolve() };
      if (r.ok && r.claims.sub === session.account.id) {
        this.claims = r.claims;
        this.noteEntitledPlan(r.claims);
        this.lastChecked = r.claims.iat * 1000;
      } else if (!r.ok && r.reason === "unknown-kid") {
        // Key rotation, not tampering: drop the token, keep the session, fetch a new one.
        this.store.saveEntitlement(null);
      } else {
        // Tampered or foreign token: distrust the whole cache (U15 test scenario).
        this.endSession("token-rejected");
        this.emit({ type: "token-rejected" });
        this.publish();
        return { refreshed: Promise.resolve() };
      }
    }
    this.publish();
    return { refreshed: this.refresh() };
  }

  /** Fetches a new entitlement. Never throws: failures become `offline` or a sign-out on 401. */
  refresh(): Promise<void> {
    if (this.inflight && this.inflight.gen === this.generation) return this.inflight.promise;
    const gen = this.generation;
    const promise = this.doRefresh(gen).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { gen, promise };
    return promise;
  }

  /** Refreshes when the last check is older than `maxAgeMs` or the token is past `exp`. */
  async refreshIfStale(maxAgeMs = DEFAULT_STALE_MS): Promise<void> {
    if (!this.session) return;
    const now = this.now();
    const stale =
      this.lastChecked === null ||
      now - this.lastChecked >= maxAgeMs ||
      !this.claims ||
      entitlementPhase(this.claims, now) !== "fresh";
    if (stale) await this.refresh();
  }

  private async doRefresh(gen: number): Promise<void> {
    const session = this.session;
    if (!session) {
      this.publish();
      return;
    }
    try {
      const res = await this.api.getEntitlement(session.token);
      const r = await verifyEntitlementToken(res.token, this.keys);
      if (gen !== this.generation) return;
      this.offline = false;
      this.lastChecked = this.now();
      this.session = { ...session, account: { ...session.account, trialEndsAt: res.trialEndsAt } };
      this.store.saveSession(this.session);
      if (r.ok && r.claims.sub === session.account.id) {
        this.claims = r.claims;
        this.noteEntitledPlan(r.claims);
        this.rejected = false;
        this.store.saveEntitlement(res.token);
      } else {
        this.claims = null;
        this.rejected = true;
        this.store.saveEntitlement(null);
        this.emit({ type: "token-rejected" });
      }
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof ApiError && err.code === "unauthorized") {
        this.endSession("session-expired");
        this.emit({ type: "session-expired" });
      } else {
        this.offline = true;
      }
    }
    this.publish();
  }

  // --- sign-in ---

  /** POST /auth/start. Rejects with `ApiError` (invalid_email, resend_too_soon, rate_limited, ...). */
  startSignIn(email: string): Promise<StartAuthResult> {
    return this.api.startAuth(email);
  }

  /** POST /auth/verify, then store the session and fetch the entitlement. Rejects with `ApiError`. */
  async verifyCode(email: string, code: string): Promise<void> {
    const res = await this.api.verifyAuth(email, code);
    await this.acceptSession({ sessionToken: res.sessionToken, account: res.account, expiresAt: res.expiresAt });
  }

  /** Adopt a session obtained elsewhere (the sign-in dialog's `messageParent` payload). */
  async acceptSession(s: SignInSession): Promise<void> {
    this.generation++;
    this.session = {
      token: s.sessionToken,
      account: { id: s.account.id, email: s.account.email, trialEndsAt: s.account.trial_ends_at },
      ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
    };
    this.store.saveSession(this.session);
    this.store.saveEntitlement(null);
    this.claims = null;
    this.offline = false;
    this.rejected = false;
    this.lastChecked = null;
    this.anonymousReason = undefined;
    this.lastEntitledPlan = null;
    this.trialWarned = false;
    this.emit({ type: "signed-in", email: s.account.email });
    this.publish();
    await this.refresh();
  }

  /** Clears local state immediately; server revocation is best effort. */
  async signOut(): Promise<void> {
    const session = this.session;
    this.endSession(undefined);
    if (session) this.emit({ type: "signed-out" });
    this.publish();
    if (session) {
      try {
        await this.api.signOut(session.token);
      } catch {
        /* the local session is gone either way; the server session expires on its own */
      }
    }
  }

  /** DELETE /account. On failure the session is kept and a `LicenseError` explains why. */
  async deleteAccount(): Promise<void> {
    const session = this.session;
    if (!session) throw new LicenseError("not_signed_in", "Sign in to delete your account.");
    try {
      await this.api.deleteAccount(session.token);
    } catch (err) {
      if (err instanceof ApiError && err.code === "billing_cancel_failed") {
        throw new LicenseError(
          "billing_cancel_failed",
          "We couldn't cancel your subscription, so your account was not deleted. Try again in a few minutes, or cancel the subscription from Manage subscription first.",
          err,
        );
      }
      if (err instanceof ApiError && err.code === "unauthorized") {
        this.endSession("session-expired");
        this.emit({ type: "session-expired" });
        this.publish();
        throw new LicenseError("session_expired", "Your session has expired. Sign in again to delete your account.", err);
      }
      if (err instanceof ApiError && err.code === "network") {
        throw new LicenseError("network", "Can't reach SlideCheck. Check your connection and try again.", err);
      }
      throw new LicenseError("unknown", "Something went wrong and your account was not deleted. Try again.", err);
    }
    this.endSession(undefined);
    this.emit({ type: "account-deleted" });
    this.publish();
  }

  /**
   * The page "Manage subscription" opens (D8, via `Office.context.ui.openBrowserWindow`): the Paddle
   * portal when the account has a subscription, else the site account page. Never rejects.
   */
  async manageSubscriptionUrl(): Promise<string> {
    return (await this.manageSubscriptionLink()).url;
  }

  /**
   * Like `manageSubscriptionUrl`, plus whether the URL is the site fallback used when the billing
   * links could not be fetched (signed out, offline, bad response). Never rejects.
   */
  async manageSubscriptionLink(): Promise<{ url: string; fallback: boolean }> {
    const fallback = { url: `${this.siteUrl}/account.html`, fallback: true };
    const session = this.session;
    if (!session) return fallback;
    try {
      const links = await this.api.getBillingLinks(session.token);
      const url = links.portalUrl ?? links.checkoutUrl;
      return /^https:\/\//i.test(url) ? { url, fallback: false } : fallback;
    } catch {
      return fallback;
    }
  }

  // --- internals ---

  private endSession(reason: LicenseReason | undefined): void {
    this.generation++;
    this.session = null;
    this.claims = null;
    this.offline = false;
    this.rejected = false;
    this.lastChecked = null;
    this.trialWarned = false;
    this.lastEntitledPlan = null;
    this.anonymousReason = reason;
    this.store.clear();
  }

  private noteEntitledPlan(claims: EntitlementClaims): void {
    if (claims.plan !== "free") this.lastEntitledPlan = claims.plan;
  }

  private compute(): LicenseState {
    const now = this.now();
    const persistent = this.store.persistent;
    const session = this.session;
    if (!session) {
      return {
        plan: "anonymous",
        lastChecked: null,
        persistent,
        ...(this.anonymousReason ? { reason: this.anonymousReason } : {}),
      };
    }

    let plan: LicensePlan = "free";
    let reason: LicenseReason | undefined;
    let graceUntil: number | undefined;
    let trialEndsAt: number | undefined;

    if (this.claims) {
      const d = deriveEntitlement(this.claims, now);
      plan = d.plan;
      trialEndsAt = d.trialEndsAt;
      if (d.entitledPlan !== "free" && (d.phase === "grace" || (d.phase === "fresh" && this.offline))) {
        graceUntil = d.graceUntil;
      }
      if (d.phase === "expired" && d.entitledPlan !== "free") {
        const trialOver = d.entitledPlan === "trial" && (d.trialEndsAt ?? session.account.trialEndsAt) <= now;
        // The server caps grace_until at exp when the paid period or trial itself ends, so only a token
        // with grace_until > exp ran out of OFFLINE grace; otherwise the subscription or trial lapsed.
        const offlineGrace = this.claims.grace_until > this.claims.exp;
        if (trialOver) reason = "trial-ended";
        else if (offlineGrace) reason = "grace-ended";
        else reason = d.entitledPlan === "pro" ? "subscription-ended" : "trial-ended";
      }
      // Every account starts with a trial (R20), so a free account past its trial end has lapsed:
      // a lapsed subscriber (last entitlement Pro) is not told their trial ended.
      if (plan === "free" && session.account.trialEndsAt <= now) {
        plan = "expired";
        reason ??= this.lastEntitledPlan === "pro" ? "subscription-ended" : "trial-ended";
      }
    }
    if (this.rejected) reason = "token-rejected";

    const state: LicenseState = {
      plan,
      account: { email: session.account.email },
      lastChecked: this.lastChecked,
      offline: this.offline,
      persistent,
    };
    if (plan === "trial") {
      const end = trialEndsAt ?? session.account.trialEndsAt;
      state.trialEndsAt = end;
      state.trialDaysLeft = Math.max(0, Math.ceil((end - now) / DAY_MS));
    }
    if (graceUntil !== undefined) state.graceUntil = graceUntil;
    if (reason) state.reason = reason;
    return state;
  }

  private publish(): void {
    const prev = this.state;
    const next = this.compute();
    this.state = next;

    if (prev.plan !== next.plan) this.emit({ type: "plan-changed", from: prev.plan, to: next.plan });
    if (next.offline && next.graceUntil !== undefined && !(prev.offline && prev.graceUntil !== undefined)) {
      this.emit({ type: "offline-grace", graceUntil: next.graceUntil });
    }
    if (next.reason === "grace-ended" && prev.reason !== "grace-ended") this.emit({ type: "grace-ended" });
    if (next.plan === "trial" && next.trialDaysLeft !== undefined && next.trialDaysLeft <= TRIAL_WARNING_DAYS && !this.trialWarned) {
      this.trialWarned = true;
      this.emit({ type: "trial-ending", daysLeft: next.trialDaysLeft });
    }
    for (const l of this.listeners) l(next);
  }

  private emit(e: LicenseEvent): void {
    for (const l of this.eventListeners) l(e);
  }
}

/** Production wiring: real fetch, localStorage-backed store, embedded keys. */
export function createLicenseService(config: LicenseConfig = createLicenseConfig()): LicenseService {
  return new LicenseService({
    api: createLicenseApi({ baseUrl: config.apiBase }),
    store: createSessionStore(),
    keys: config.keys,
    siteUrl: config.siteUrl,
  });
}
