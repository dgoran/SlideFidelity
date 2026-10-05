import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LicenseApi } from "./api";
import type { EntitlementPublicKey } from "./config";
import type { EntitlementClaims } from "./entitlement";
import { isAllowed, lockAction } from "./gate";
import { LicenseError, LicenseService, type LicenseEvent, type LicenseState } from "./license";
import { createSessionStore, type SessionStore, type StoredSession } from "./session";

// --- signing helpers (mirror apps/license-api signEntitlement) ---

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let pub: EntitlementPublicKey;
let priv: CryptoKey;
let otherPriv: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  pub = { kid: "k1", x: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
  priv = pair.privateKey;
  otherPriv = ((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
});

async function token(c: EntitlementClaims, key: CryptoKey = priv): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: c.kid }))}.${b64url(JSON.stringify(c))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 30, 12);
const S = (ms: number) => Math.floor(ms / 1000);

function claims(plan: EntitlementClaims["plan"], at: number, over: Partial<EntitlementClaims> = {}): EntitlementClaims {
  return { sub: "acct_1", plan, iat: S(at), exp: S(at + DAY), grace_until: S(at + 7 * DAY), kid: "k1", ...over };
}

const SESSION: StoredSession = { token: "sess_1", account: { id: "acct_1", email: "ada@example.com", trialEndsAt: T0 + 20 * DAY } };

// --- fakes ---

type FakeApi = { [K in keyof LicenseApi]: ReturnType<typeof vi.fn> & LicenseApi[K] };

function fakeApi(): FakeApi {
  return {
    startAuth: vi.fn(),
    verifyAuth: vi.fn(),
    signOut: vi.fn(async () => undefined),
    getEntitlement: vi.fn(),
    getBillingLinks: vi.fn(),
    deleteAccount: vi.fn(async () => undefined),
  } as unknown as FakeApi;
}

function entitlementResponse(t: string, c: EntitlementClaims, trialEndsAt = SESSION.account.trialEndsAt) {
  return { token: t, plan: c.plan, expiresAt: c.exp * 1000, graceUntil: c.grace_until * 1000, trialEndsAt };
}

const networkDown = () => Promise.reject(new ApiError("network", 0));

let now = T0;
let api: FakeApi;
let store: SessionStore;

function service(s: SessionStore = store) {
  const svc = new LicenseService({
    api,
    store: s,
    keys: [pub],
    siteUrl: "https://site.test",
    now: () => now,
  });
  const events: LicenseEvent[] = [];
  svc.onEvent((e) => events.push(e));
  return { svc, events };
}

async function initAndSettle(svc: LicenseService) {
  const { refreshed } = await svc.init();
  await refreshed;
}

beforeEach(() => {
  localStorage.clear();
  now = T0;
  api = fakeApi();
  store = createSessionStore(() => localStorage);
});

describe("LicenseService", () => {
  it("anonymous: no session means plan 'anonymous' and only the free features (R19)", async () => {
    const { svc } = service();
    await initAndSettle(svc);
    const s = svc.getState();
    expect(s.plan).toBe("anonymous");
    expect(s.account).toBeUndefined();
    expect(api.getEntitlement).not.toHaveBeenCalled();
    expect(isAllowed(s.plan, "overview.counts")).toBe(true);
    expect(isAllowed(s.plan, "area.fonts.list")).toBe(true);
    expect(isAllowed(s.plan, "area.media.sizes")).toBe(true);
    expect(isAllowed(s.plan, "area.colors")).toBe(false);
    expect(lockAction(s.plan)).toBe("sign-in-trial");
  });

  it("init publishes the cached state before the background refresh finishes", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0)));
    let release!: (v: unknown) => void;
    api.getEntitlement.mockImplementation(() => new Promise((r) => (release = r)));
    const { svc } = service();
    const { refreshed } = await svc.init();
    expect(svc.getState()).toMatchObject({ plan: "pro", account: { email: "ada@example.com" }, lastChecked: T0 });
    const fresh = claims("pro", T0);
    release(entitlementResponse(await token(fresh), fresh));
    await refreshed;
    expect(api.getEntitlement).toHaveBeenCalledWith("sess_1");
  });

  it("AE5: a trial that ended with no subscription is 'expired' with a manage-subscription link", async () => {
    const ended: StoredSession = { ...SESSION, account: { ...SESSION.account, trialEndsAt: T0 - DAY } };
    store.saveSession(ended);
    const c = claims("free", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c, T0 - DAY));
    api.getBillingLinks.mockResolvedValue({ checkoutUrl: "https://site.test/account.html", portalUrl: null });
    const { svc } = service();
    await initAndSettle(svc);
    const s = svc.getState();
    expect(s.plan).toBe("expired");
    expect(s.reason).toBe("trial-ended");
    expect(isAllowed(s.plan, "area.colors")).toBe(false);
    expect(lockAction(s.plan)).toBe("manage-subscription");
    await expect(svc.manageSubscriptionUrl()).resolves.toBe("https://site.test/account.html");
  });

  it("manageSubscriptionLink marks the offline fallback so callers do not cache it", async () => {
    store.saveSession(SESSION);
    const { svc } = service();
    api.getEntitlement.mockImplementation(networkDown);
    await initAndSettle(svc);
    api.getBillingLinks.mockResolvedValueOnce({ checkoutUrl: "https://site.test/account.html", portalUrl: null });
    await expect(svc.manageSubscriptionLink()).resolves.toEqual({ url: "https://site.test/account.html", fallback: false });
    api.getBillingLinks.mockImplementationOnce(networkDown);
    await expect(svc.manageSubscriptionLink()).resolves.toEqual({ url: "https://site.test/account.html", fallback: true });
  });

  it("manageSubscriptionUrl prefers the portal, and falls back to the site when the API is down", async () => {
    store.saveSession(SESSION);
    const { svc } = service();
    api.getEntitlement.mockImplementation(networkDown);
    await initAndSettle(svc);
    api.getBillingLinks.mockResolvedValueOnce({ checkoutUrl: "https://site.test/account.html", portalUrl: "https://portal/x" });
    await expect(svc.manageSubscriptionUrl()).resolves.toBe("https://portal/x");
    api.getBillingLinks.mockImplementationOnce(networkDown);
    await expect(svc.manageSubscriptionUrl()).resolves.toBe("https://site.test/account.html");
  });

  it("after a purchase, refresh() fetches plan=pro and notifies subscribers without a reload", async () => {
    store.saveSession(SESSION);
    const trial = claims("trial", T0, { trial_ends_at: S(T0 + 20 * DAY) });
    api.getEntitlement.mockResolvedValueOnce(entitlementResponse(await token(trial), trial));
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState().plan).toBe("trial");

    const seen: LicenseState[] = [];
    svc.subscribe((s) => seen.push(s));
    now = T0 + 60_000;
    const pro = claims("pro", now);
    api.getEntitlement.mockResolvedValueOnce(entitlementResponse(await token(pro), pro));
    await svc.refresh();
    expect(svc.getState()).toMatchObject({ plan: "pro", lastChecked: now, offline: false });
    expect(seen.at(-1)?.plan).toBe("pro");
    expect(events).toContainEqual({ type: "plan-changed", from: "trial", to: "pro" });
    expect(isAllowed(svc.getState().plan, "area.colors")).toBe(true);
    expect(store.loadEntitlement()).toBe(await token(pro));
  });

  it("offline within grace stays Pro and exposes the lapse date; after grace it falls back with a reason", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0)));
    api.getEntitlement.mockImplementation(networkDown);
    now = T0 + 3 * DAY; // past exp (1 day), within grace (7 days)
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "pro", offline: true, graceUntil: T0 + 7 * DAY, lastChecked: T0 });
    expect(events).toContainEqual({ type: "offline-grace", graceUntil: T0 + 7 * DAY });

    now = T0 + 7 * DAY + 1;
    await svc.refresh();
    expect(svc.getState()).toMatchObject({ plan: "expired", offline: true, reason: "grace-ended" });
    expect(events).toContainEqual({ type: "grace-ended" });
    expect(lockAction(svc.getState().plan)).toBe("manage-subscription");
  });

  it("a canceled Pro that ran out while online is a subscription lapse, not 'grace ended' or 'trial ended'", async () => {
    // Trial long over; the server caps exp and grace_until at the end of the paid period.
    const lapsed: StoredSession = { ...SESSION, account: { ...SESSION.account, trialEndsAt: T0 - 60 * DAY } };
    store.saveSession(lapsed);
    const paidUntil = T0 + 2 * DAY;
    const pro = claims("pro", T0, { exp: S(paidUntil), grace_until: S(paidUntil) });
    api.getEntitlement.mockResolvedValueOnce(entitlementResponse(await token(pro), pro, T0 - 60 * DAY));
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState().plan).toBe("pro");

    now = paidUntil + 1000; // the cached token has lapsed; no refresh yet
    api.getEntitlement.mockImplementationOnce(networkDown);
    await svc.refresh();
    expect(svc.getState()).toMatchObject({ plan: "expired", reason: "subscription-ended" });
    expect(events).not.toContainEqual({ type: "grace-ended" });

    const free = claims("free", now);
    api.getEntitlement.mockResolvedValueOnce(entitlementResponse(await token(free), free, T0 - 60 * DAY));
    await svc.refresh();
    expect(svc.getState()).toMatchObject({ plan: "expired", reason: "subscription-ended", offline: false });
  });

  it("a trial token that lapsed at its trial end is 'trial-ended'", async () => {
    const trialEnd = T0 + DAY;
    store.saveSession({ ...SESSION, account: { ...SESSION.account, trialEndsAt: trialEnd } });
    const trial = claims("trial", T0, { exp: S(trialEnd), grace_until: S(trialEnd), trial_ends_at: S(trialEnd) });
    api.getEntitlement.mockResolvedValueOnce(entitlementResponse(await token(trial), trial, trialEnd));
    const { svc } = service();
    await initAndSettle(svc);
    now = trialEnd + 1000;
    api.getEntitlement.mockImplementationOnce(networkDown);
    await svc.refresh();
    expect(svc.getState()).toMatchObject({ plan: "expired", reason: "trial-ended" });
  });

  it("a server error during refresh is treated like offline, not as a downgrade", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0)));
    api.getEntitlement.mockRejectedValue(new ApiError("internal", 500));
    const { svc } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "pro", offline: true });
  });

  it("offline with no cached token is a signed-in free account", async () => {
    store.saveSession(SESSION);
    api.getEntitlement.mockImplementation(networkDown);
    const { svc } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "free", offline: true, account: { email: "ada@example.com" } });
  });

  it("a tampered cached token is discarded and the user is treated as anonymous", async () => {
    store.saveSession(SESSION);
    const good = await token(claims("free", T0));
    const [h, , sig] = good.split(".");
    store.saveEntitlement(`${h}.${b64url(JSON.stringify(claims("pro", T0)))}.${sig}`);
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "anonymous", reason: "token-rejected" });
    expect(store.loadSession()).toBeNull();
    expect(store.loadEntitlement()).toBeNull();
    expect(api.getEntitlement).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "token-rejected" });
  });

  it("a cached token signed by an unknown kid is dropped but the session survives and refreshes", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0, { kid: "old" }), otherPriv));
    const fresh = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(fresh), fresh));
    const { svc } = service();
    const { refreshed } = await svc.init();
    expect(svc.getState().plan).toBe("free");
    await refreshed;
    expect(svc.getState().plan).toBe("pro");
  });

  it("a server token that fails verification is not trusted", async () => {
    store.saveSession(SESSION);
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c, otherPriv), c));
    const { svc } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "free", reason: "token-rejected" });
    expect(store.loadEntitlement()).toBeNull();
    expect(store.loadSession()).not.toBeNull();
  });

  it("a token issued for another account is rejected", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0, { sub: "acct_other" })));
    api.getEntitlement.mockImplementation(networkDown);
    const { svc } = service();
    await initAndSettle(svc);
    expect(svc.getState().plan).not.toBe("pro");
  });

  it("401 on refresh ends the session", async () => {
    store.saveSession(SESSION);
    api.getEntitlement.mockRejectedValue(new ApiError("unauthorized", 401));
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "anonymous", reason: "session-expired" });
    expect(store.loadSession()).toBeNull();
    expect(events).toContainEqual({ type: "session-expired" });
  });

  it("exposes the trial countdown and emits trial-ending at 3 days (D8)", async () => {
    store.saveSession(SESSION);
    const c = claims("trial", T0, { trial_ends_at: S(T0 + 2.5 * DAY) });
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c, T0 + 2.5 * DAY));
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState()).toMatchObject({ plan: "trial", trialEndsAt: T0 + 2.5 * DAY, trialDaysLeft: 3 });
    expect(events).toContainEqual({ type: "trial-ending", daysLeft: 3 });
    await svc.refresh();
    expect(events.filter((e) => e.type === "trial-ending")).toHaveLength(1);
  });

  it("does not emit trial-ending with more than 3 days left", async () => {
    store.saveSession(SESSION);
    const c = claims("trial", T0, { trial_ends_at: S(T0 + 10 * DAY) });
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    const { svc, events } = service();
    await initAndSettle(svc);
    expect(svc.getState().trialDaysLeft).toBe(10);
    expect(events.some((e) => e.type === "trial-ending")).toBe(false);
  });

  it("startSignIn returns the resend countdown; verifyCode stores the session and refreshes", async () => {
    api.startAuth.mockResolvedValue({ resendAfterSeconds: 30, expiresInSeconds: 600 });
    api.verifyAuth.mockResolvedValue({
      sessionToken: "sess_new",
      expiresAt: T0 + 30 * DAY,
      account: { id: "acct_1", email: "ada@example.com", trial_ends_at: T0 + 30 * DAY },
    });
    const c = claims("trial", T0, { trial_ends_at: S(T0 + 30 * DAY) });
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c, T0 + 30 * DAY));
    const { svc, events } = service();
    await initAndSettle(svc);
    await expect(svc.startSignIn("ada@example.com")).resolves.toEqual({ resendAfterSeconds: 30, expiresInSeconds: 600 });
    await svc.verifyCode("ada@example.com", "123456");
    expect(svc.getState()).toMatchObject({ plan: "trial", account: { email: "ada@example.com" }, trialDaysLeft: 30 });
    expect(store.loadSession()?.token).toBe("sess_new");
    expect(api.getEntitlement).toHaveBeenCalledWith("sess_new");
    expect(events).toContainEqual({ type: "signed-in", email: "ada@example.com" });
  });

  it("verifyCode surfaces API errors unchanged", async () => {
    api.verifyAuth.mockRejectedValue(new ApiError("code_locked", 400));
    const { svc } = service();
    await expect(svc.verifyCode("a@b.co", "000000")).rejects.toMatchObject({ code: "code_locked" });
    expect(svc.getState().plan).toBe("anonymous");
  });

  it("acceptSession takes the dialog result", async () => {
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    const { svc } = service();
    await svc.acceptSession({ sessionToken: "sess_d", account: { id: "acct_1", email: "ada@example.com", trial_ends_at: T0 } });
    expect(svc.getState().plan).toBe("pro");
  });

  it("when localStorage throws, the session lives in memory for this session only", async () => {
    const broken = createSessionStore(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    api.verifyAuth.mockResolvedValue({
      sessionToken: "sess_mem",
      expiresAt: T0 + 30 * DAY,
      account: { id: "acct_1", email: "ada@example.com", trial_ends_at: T0 + 30 * DAY },
    });
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    const { svc } = service(broken);
    await initAndSettle(svc);
    await svc.verifyCode("ada@example.com", "123456");
    expect(svc.getState()).toMatchObject({ plan: "pro", persistent: false });
    expect(broken.loadSession()?.token).toBe("sess_mem");

    // A new pane load (fresh memory) starts anonymous again.
    const nextLoad = createSessionStore(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { svc: svc2 } = service(nextLoad);
    await initAndSettle(svc2);
    expect(svc2.getState().plan).toBe("anonymous");
  });

  it("signOut clears locally even when the server call fails", async () => {
    store.saveSession(SESSION);
    store.saveEntitlement(await token(claims("pro", T0)));
    api.getEntitlement.mockImplementation(networkDown);
    api.signOut.mockRejectedValue(new ApiError("network", 0));
    const { svc, events } = service();
    await initAndSettle(svc);
    await svc.signOut();
    expect(api.signOut).toHaveBeenCalledWith("sess_1");
    expect(svc.getState().plan).toBe("anonymous");
    expect(svc.getState().account).toBeUndefined();
    expect(store.loadSession()).toBeNull();
    expect(store.loadEntitlement()).toBeNull();
    expect(events).toContainEqual({ type: "signed-out" });
  });

  it("a refresh that resolves after sign-out does not resurrect the session", async () => {
    store.saveSession(SESSION);
    let release!: (v: unknown) => void;
    api.getEntitlement.mockImplementation(() => new Promise((r) => (release = r)));
    const { svc } = service();
    const { refreshed } = await svc.init();
    await svc.signOut();
    const c = claims("pro", T0);
    release(entitlementResponse(await token(c), c));
    await refreshed;
    expect(svc.getState().plan).toBe("anonymous");
    expect(store.loadEntitlement()).toBeNull();
  });

  it("deleteAccount: 502 billing_cancel_failed keeps the session and reports a clear error", async () => {
    store.saveSession(SESSION);
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    api.deleteAccount.mockRejectedValue(new ApiError("billing_cancel_failed", 502));
    const { svc } = service();
    await initAndSettle(svc);
    const err = await svc.deleteAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenseError);
    expect(err).toMatchObject({ code: "billing_cancel_failed" });
    expect((err as Error).message).toMatch(/subscription/i);
    expect(svc.getState().plan).toBe("pro");
    expect(store.loadSession()).not.toBeNull();
  });

  it("deleteAccount success clears everything", async () => {
    store.saveSession(SESSION);
    api.getEntitlement.mockImplementation(networkDown);
    const { svc, events } = service();
    await initAndSettle(svc);
    await svc.deleteAccount();
    expect(api.deleteAccount).toHaveBeenCalledWith("sess_1");
    expect(svc.getState().plan).toBe("anonymous");
    expect(store.loadSession()).toBeNull();
    expect(events).toContainEqual({ type: "account-deleted" });
  });

  it("deleteAccount while signed out is an error", async () => {
    const { svc } = service();
    await expect(svc.deleteAccount()).rejects.toMatchObject({ code: "not_signed_in" });
  });

  it("concurrent refresh calls share one request", async () => {
    store.saveSession(SESSION);
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    const { svc } = service();
    const { refreshed } = await svc.init();
    await Promise.all([refreshed, svc.refresh(), svc.refresh()]);
    expect(api.getEntitlement).toHaveBeenCalledTimes(1);
  });

  it("refreshIfStale only calls the API when the last check is old or the token is not fresh", async () => {
    store.saveSession(SESSION);
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    const { svc } = service();
    await initAndSettle(svc);
    expect(api.getEntitlement).toHaveBeenCalledTimes(1);
    now = T0 + 30_000;
    await svc.refreshIfStale(60_000);
    expect(api.getEntitlement).toHaveBeenCalledTimes(1);
    now = T0 + 61_000;
    await svc.refreshIfStale(60_000);
    expect(api.getEntitlement).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops notifications", async () => {
    const { svc } = service();
    const fn = vi.fn();
    const off = svc.subscribe(fn);
    off();
    await initAndSettle(svc);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("LicenseService.getSessionToken (link check auth, R11)", () => {
  it("is null when signed out, the stored token once loaded, and null again after sign-out", async () => {
    const { svc } = service();
    expect(svc.getSessionToken()).toBeNull();
    store.saveSession(SESSION);
    const c = claims("pro", T0);
    api.getEntitlement.mockResolvedValue(entitlementResponse(await token(c), c));
    await initAndSettle(svc);
    expect(svc.getSessionToken()).toBe("sess_1");
    await svc.signOut();
    expect(svc.getSessionToken()).toBeNull();
  });

  it("returns the token of a session adopted from the sign-in dialog", async () => {
    const { svc } = service();
    api.getEntitlement.mockImplementation(networkDown);
    await svc.acceptSession({ sessionToken: "sess_new", account: { id: "acct_1", email: "ada@example.com", trial_ends_at: T0 + DAY } });
    expect(svc.getSessionToken()).toBe("sess_new");
  });
});
