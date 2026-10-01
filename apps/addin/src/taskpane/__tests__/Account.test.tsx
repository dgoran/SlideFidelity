import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LicenseError, type LicenseState } from "../../license/license";
import { SignInDialogError, type SignInDialogResult } from "../../license/signinDialog";
import { capabilitiesUpTo } from "../../office/capabilities";
import { AccountEntry, AccountNotices, AccountPanel } from "../components/Account";
import { LicenseBridge, MANAGE_URL_TTL_MS, NO_PRO_FOCUS_STALE_MS, type LicenseServiceLike, type LicenseUi } from "../license/LicenseBridge";
import { TaskPaneRoot } from "../Root";
import { initialPaneState } from "../state/store";
import { button, cleanup, click, fakeScanService, flush, one, render } from "../testing/render";
import { deckResult } from "./deck";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 12);

function fakeLicense(initial: LicenseState) {
  let state = initial;
  const listeners = new Set<(s: LicenseState) => void>();
  const service = {
    getState: () => state,
    subscribe: (l: (s: LicenseState) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    init: vi.fn(async () => ({ refreshed: Promise.resolve() })),
    refresh: vi.fn(async () => {}),
    refreshIfStale: vi.fn(async () => {}),
    acceptSession: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
    manageSubscriptionLink: vi.fn(async (): Promise<{ url: string; fallback: boolean }> => ({
      url: "https://billing.example/portal",
      fallback: false,
    })),
  } satisfies LicenseServiceLike;
  const set = (next: LicenseState) =>
    act(() => {
      state = next;
      for (const l of listeners) l(next);
    });
  return { service, set };
}

function fakeUi() {
  let settle: { resolve: (r: SignInDialogResult) => void; reject: (e: unknown) => void } | undefined;
  let onFocus: (() => void) | undefined;
  const ui = {
    openSignInDialog: vi.fn(
      () =>
        new Promise<SignInDialogResult>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    ),
    openBrowserWindow: vi.fn(),
    subscribeFocus: vi.fn((fn: () => void) => {
      onFocus = fn;
      return () => {
        onFocus = undefined;
      };
    }),
  } satisfies LicenseUi;
  return {
    ui,
    resolve: (r: SignInDialogResult) => settle?.resolve(r),
    reject: (e: unknown) => settle?.reject(e),
    focus: () => onFocus?.(),
  };
}

const fmt = { formatDate: (t: number) => `D(${new Date(t).toISOString().slice(0, 10)})`, formatDateTime: (t: number) => `T(${t})` };

const anonymous: LicenseState = { plan: "anonymous", lastChecked: null, persistent: true };
const signedIn = (over: Partial<LicenseState>): LicenseState => ({
  plan: "free",
  account: { email: "ada@example.com" },
  lastChecked: NOW,
  offline: false,
  persistent: true,
  ...over,
});

function renderAccount(state: LicenseState) {
  const lic = fakeLicense(state);
  const u = fakeUi();
  const r = render(
    <LicenseBridge service={lic.service} ui={u.ui}>
      {() => (
        <>
          <AccountNotices {...fmt} />
          <AccountPanel {...fmt} />
        </>
      )}
    </LicenseBridge>,
  );
  return { ...r, ...lic, ...u };
}

describe("Account (U15, D12)", () => {
  it("initializes the license service once and refreshes when the pane regains focus", async () => {
    const a = renderAccount(anonymous);
    await flush();
    expect(a.service.init).toHaveBeenCalledTimes(1);
    a.focus();
    expect(a.service.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("anonymous: the trial CTA opens the sign-in dialog synchronously, then adopts the session", async () => {
    const a = renderAccount(anonymous);
    click(button(a.container, "Sign in to start your 30-day free trial"));
    // Opened inside the click (no await in between): required by Office on the web.
    expect(a.ui.openSignInDialog).toHaveBeenCalledTimes(1);
    const account = { id: "u1", email: "ada@example.com", trial_ends_at: NOW + 30 * DAY };
    a.resolve({ kind: "signed-in", sessionToken: "tok", account });
    await flush();
    expect(a.service.acceptSession).toHaveBeenCalledWith({ sessionToken: "tok", account });
  });

  it.each([
    [{ kind: "dismissed" } as SignInDialogResult, "closed before you finished"],
  ])("dialog outcome %o shows a notice", async (outcome, text) => {
    const a = renderAccount(anonymous);
    click(button(a.container, "Sign in to start your 30-day free trial"));
    a.resolve(outcome);
    await flush();
    expect(one(a.container, "[data-signin-notice]").textContent).toContain(text);
    expect(a.service.acceptSession).not.toHaveBeenCalled();
  });

  it("a cancelled dialog shows nothing", async () => {
    const a = renderAccount(anonymous);
    click(button(a.container, "Sign in to start your 30-day free trial"));
    a.resolve({ kind: "cancelled" });
    await flush();
    expect(a.container.querySelector("[data-signin-notice]")).toBeNull();
  });

  it.each([
    ["blocked", "Allow pop-ups"],
    ["already-open", "already open"],
    ["load-failed", "couldn't load"],
  ] as const)("dialog error %s explains what to do", async (code, text) => {
    const a = renderAccount(anonymous);
    click(button(a.container, "Sign in to start your 30-day free trial"));
    a.reject(new SignInDialogError(code, 12009));
    await flush();
    expect(one(a.container, "[data-signin-notice]").textContent).toContain(text);
  });

  it("anonymous after a session expired or a rejected token explains why", () => {
    const a = renderAccount({ ...anonymous, reason: "session-expired" });
    expect(one(a.container, '[data-reason="session-expired"]').textContent).toContain("session has expired");
    expect(one(a.container, '[data-notice="session-expired"]')).toBeTruthy();
    a.set({ ...anonymous, reason: "token-rejected" });
    expect(one(a.container, '[data-reason="token-rejected"]').textContent).toContain("couldn't be verified");
  });

  it("signed in: email, Sign out, and a Refresh with the last-checked time", async () => {
    const a = renderAccount(signedIn({ plan: "pro" }));
    expect(one(a.container, "[data-account-email]").textContent).toBe("ada@example.com");
    expect(one(a.container, "[data-last-checked]").textContent).toBe(`Last checked T(${NOW})`);
    click(button(a.container, "Refresh"));
    expect(a.service.refresh).toHaveBeenCalledTimes(1);
    click(button(a.container, "Sign out"));
    expect(a.service.signOut).toHaveBeenCalledTimes(1);
    a.set(signedIn({ plan: "pro", lastChecked: null }));
    expect(one(a.container, "[data-last-checked]").textContent).toBe("Not checked yet");
  });

  it("trial: days left, plus a non-blocking notice at 3 days or fewer", () => {
    const a = renderAccount(signedIn({ plan: "trial", trialDaysLeft: 10, trialEndsAt: NOW + 10 * DAY }));
    expect(one(a.container, "[data-trial-days]").textContent).toContain("10 days left in your trial.");
    expect(a.container.querySelector("[data-trial-ending]")).toBeNull();
    expect(a.container.querySelector('[data-notice="trial-ending"]')).toBeNull();
    a.set(signedIn({ plan: "trial", trialDaysLeft: 3, trialEndsAt: NOW + 3 * DAY }));
    expect(a.container.querySelector("[data-trial-ending]")).not.toBeNull();
    const notice = one(a.container, '[data-notice="trial-ending"]');
    expect(notice.textContent).toContain("ends in 3 days");
    click(button(notice, "Dismiss"));
    expect(a.container.querySelector('[data-notice="trial-ending"]')).toBeNull();
  });

  it("offline grace: banner with the date Pro lapses", () => {
    const graceUntil = Date.UTC(2026, 9, 7);
    const a = renderAccount(signedIn({ plan: "pro", offline: true, graceUntil }));
    expect(one(a.container, "[data-offline-grace]").textContent).toContain("Pro stays active until D(2026-10-07)");
    expect(one(a.container, '[data-notice="offline-grace"]').textContent).toContain("D(2026-10-07)");
  });

  it("grace ended: explains why Pro is paused", () => {
    const a = renderAccount(signedIn({ plan: "free", reason: "grace-ended", offline: true }));
    expect(one(a.container, "[data-grace-ended]").textContent).toContain("more than 7 days");
    expect(one(a.container, '[data-notice="grace-ended"]')).toBeTruthy();
  });

  it("expired trial: 'Your trial has ended' and Manage subscription opens the prefetched page inside the click", async () => {
    const a = renderAccount(signedIn({ plan: "expired", reason: "trial-ended" }));
    await flush();
    expect(one(a.container, '[data-reason="trial-ended"]').textContent).toBe("Your trial has ended.");
    click(button(a.container, "Manage subscription"));
    expect(a.ui.openBrowserWindow).toHaveBeenCalledWith("https://billing.example/portal");
  });

  it("returning from Manage subscription forces a refresh on the next focus only (R21)", async () => {
    const a = renderAccount(signedIn({ plan: "expired", reason: "trial-ended" }));
    await flush();
    click(button(a.container, "Manage subscription"));
    a.focus();
    expect(a.service.refresh).toHaveBeenCalledTimes(1);
    expect(a.service.refreshIfStale).not.toHaveBeenCalled();
    a.focus();
    expect(a.service.refresh).toHaveBeenCalledTimes(1);
    expect(a.service.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("focus uses a one-minute staleness window without Pro access, the default with it", () => {
    const a = renderAccount(signedIn({ plan: "free" }));
    a.focus();
    expect(a.service.refreshIfStale).toHaveBeenLastCalledWith(NO_PRO_FOCUS_STALE_MS);
    a.set(signedIn({ plan: "pro" }));
    a.focus();
    expect(a.service.refreshIfStale).toHaveBeenLastCalledWith(undefined);
  });

  it("a prefetched portal URL older than 5 minutes is not opened; the click fetches a new one and focus re-prefetches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const a = renderAccount(signedIn({ plan: "pro" }));
    await flush();
    expect(a.service.manageSubscriptionLink).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + MANAGE_URL_TTL_MS);
    a.service.manageSubscriptionLink.mockResolvedValueOnce({ url: "https://billing.example/portal2", fallback: false });
    click(button(a.container, "Manage subscription"));
    expect(a.ui.openBrowserWindow).not.toHaveBeenCalled();
    await flush();
    expect(a.ui.openBrowserWindow).toHaveBeenCalledWith("https://billing.example/portal2");

    a.focus(); // cache still stale: prefetch again
    expect(a.service.manageSubscriptionLink).toHaveBeenCalledTimes(3);
    await flush();
    a.ui.openBrowserWindow.mockClear();
    click(button(a.container, "Manage subscription"));
    expect(a.ui.openBrowserWindow).toHaveBeenCalledWith("https://billing.example/portal");
  });

  it("the offline fallback page is never opened from the cache; focus retries the prefetch", async () => {
    const a = renderAccount(signedIn({ plan: "free" }));
    a.service.manageSubscriptionLink.mockResolvedValue({ url: "https://site.example/account.html", fallback: true });
    a.set(signedIn({ plan: "expired" })); // account change: prefetch runs again and gets the fallback
    await flush();
    click(button(a.container, "Manage subscription"));
    expect(a.ui.openBrowserWindow).not.toHaveBeenCalled();
    await flush();
    expect(a.ui.openBrowserWindow).toHaveBeenCalledWith("https://site.example/account.html");
    const calls = a.service.manageSubscriptionLink.mock.calls.length;
    a.focus();
    expect(a.service.manageSubscriptionLink).toHaveBeenCalledTimes(calls + 1);
  });

  it("lapsed subscription: 'Your subscription has ended'", () => {
    const a = renderAccount(signedIn({ plan: "expired", reason: "subscription-ended" }));
    expect(one(a.container, '[data-reason="subscription-ended"]').textContent).toBe("Your subscription has ended.");
    expect(a.container.querySelector('[data-reason="trial-ended"]')).toBeNull();
    expect(a.container.querySelector("[data-grace-ended]")).toBeNull();
  });

  it("free account: Manage subscription is offered", () => {
    const a = renderAccount(signedIn({ plan: "free" }));
    expect(one(a.container, "[data-manage]")).toBeTruthy();
    expect(a.container.querySelector('[data-reason="trial-ended"]')).toBeNull();
  });

  it("delete account needs a confirm step and shows the error when it fails", async () => {
    const a = renderAccount(signedIn({ plan: "pro" }));
    a.service.deleteAccount.mockRejectedValueOnce(new LicenseError("billing_cancel_failed", "We couldn't cancel your subscription."));
    click(button(a.container, "Delete account…"));
    expect(a.service.deleteAccount).not.toHaveBeenCalled();
    click(button(a.container, "Keep my account"));
    expect(a.container.querySelector("[data-delete-confirm]")).toBeNull();
    click(button(a.container, "Delete account…"));
    click(button(a.container, "Delete my account"));
    await flush();
    expect(a.service.deleteAccount).toHaveBeenCalledTimes(1);
    expect(one(a.container, "[data-delete-error]").textContent).toContain("We couldn't cancel your subscription.");
    click(button(a.container, "Delete my account"));
    await flush();
    expect(a.service.deleteAccount).toHaveBeenCalledTimes(2);
    expect(a.container.querySelector("[data-delete-confirm]")).toBeNull();
  });

  it("notes when the sign-in cannot be saved on this device", () => {
    const a = renderAccount({ ...anonymous, persistent: false });
    expect(one(a.container, "[data-not-persistent]")).toBeTruthy();
  });
});

describe("Account in the pane (U15 → gate)", () => {
  function renderLicensedPane(state: LicenseState) {
    const lic = fakeLicense(state);
    const u = fakeUi();
    const scan = fakeScanService();
    const r = render(
      <LicenseBridge service={lic.service} ui={u.ui}>
        {({ plan, onSignIn, onManageSubscription }) => (
          <TaskPaneRoot
            services={{ capabilities: capabilitiesUpTo("1.10"), navigator: { navigate: async () => ({ kind: "not-found" }) }, isWeb: false }}
            scanService={scan.service}
            plan={plan}
            onSignIn={onSignIn}
            onManageSubscription={onManageSubscription}
            initialState={{
              ...initialPaneState(),
              scan: { status: "ready", result: deckResult(), scannedAt: 0, possiblyOutdated: false },
              area: "colors",
            }}
            slots={{ accountSlot: <AccountEntry {...fmt} />, noticeSlot: <AccountNotices {...fmt} /> }}
          />
        )}
      </LicenseBridge>,
    );
    return { ...r, ...lic, ...u };
  }

  it("a locked area's CTA opens sign-in synchronously; a Pro plan unlocks without a reload", () => {
    const a = renderLicensedPane(anonymous);
    click(one(a.container, '[data-lock-action="sign-in-trial"]'));
    expect(a.ui.openSignInDialog).toHaveBeenCalledTimes(1);
    a.set(signedIn({ plan: "pro" }));
    expect(a.container.querySelector("[data-locked-section]")).toBeNull();
  });

  it("the header entry shows the plan and opens the account panel; Escape closes it", () => {
    const a = renderLicensedPane(signedIn({ plan: "trial", trialDaysLeft: 12, trialEndsAt: NOW + 12 * DAY }));
    const entry = button(a.container, "Account: ada@example.com, Pro trial");
    expect(entry.textContent).toBe("Pro trial");
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    click(entry);
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    const panel = one(a.container, '[role="region"][aria-labelledby]');
    expect(document.activeElement).toBe(panel);
    expect(one(panel, "[data-trial-days]").textContent).toContain("12 days left");
    act(() => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(entry);
  });
});
