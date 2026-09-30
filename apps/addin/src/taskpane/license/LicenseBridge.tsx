/**
 * Licensing bridge (U15): connects ONE `LicenseService` to the pane.
 *
 * - `init()` once when mounted (index.tsx mounts inside `Office.onReady`), `refreshIfStale()` on
 *   every window focus (R21: a purchase on the website shows up when the user comes back).
 * - The service's state drives the gate's plan (`PlanProvider`, D7/D8/D13).
 * - `signIn()` opens the sign-in dialog SYNCHRONOUSLY (Office on the web only allows dialogs from
 *   a user gesture), then adopts the session with `acceptSession`. Dialog outcomes (dismissed,
 *   cancelled, blocked by a pop-up blocker, already open) become a plain-language notice.
 * - `manageSubscription()` opens the account / billing page with `openBrowserWindow`. The URL is
 *   fetched ahead of time (on every account change) so the window opens inside the click.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LicenseService, LicenseState } from "../../license/license";
import { openSignInDialog, SignInDialogError, type SignInDialogResult } from "../../license/signinDialog";
import type { Plan } from "../../license/gate";

export type LicenseServiceLike = Pick<
  LicenseService,
  "getState" | "subscribe" | "init" | "refresh" | "refreshIfStale" | "acceptSession" | "signOut" | "deleteAccount" | "manageSubscriptionUrl"
>;

export interface LicenseUi {
  /** Must open the dialog synchronously when called. */
  openSignInDialog: () => Promise<SignInDialogResult>;
  openBrowserWindow: (url: string) => void;
  /** Window-focus subscription for `refreshIfStale`. */
  subscribeFocus?: (onFocus: () => void) => () => void;
}

export const defaultLicenseUi: LicenseUi = {
  openSignInDialog: () => openSignInDialog(),
  openBrowserWindow: (url) => Office.context.ui.openBrowserWindow(url),
  subscribeFocus: (onFocus) => {
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  },
};

/** Plain-language message for a sign-in dialog failure (D12 "dialog dismissed" and friends). */
export function signInFailureMessage(e: unknown): string {
  if (e instanceof SignInDialogError) {
    switch (e.code) {
      case "already-open":
        return "The sign-in window is already open. Finish signing in there, or close it and try again.";
      case "blocked":
        return "The sign-in window was blocked. Allow pop-ups for SlideCheck in your browser, then try again.";
      case "load-failed":
        return "The sign-in page couldn't load. Check your connection and try again.";
      case "bad-message":
      case "open-failed":
        return "Sign-in couldn't start. Try again.";
    }
  }
  return "Sign-in couldn't start. Try again.";
}

const isHttpsUrl = (u: string): boolean => /^https:\/\//i.test(u);

export interface AccountContextValue {
  state: LicenseState;
  service: LicenseServiceLike;
  /** Call directly from a click handler (opens the dialog synchronously). */
  signIn: () => void;
  /** Call directly from a click handler. */
  manageSubscription: () => void;
  signingIn: boolean;
  /** Outcome of the last sign-in attempt, when the user should know about it. */
  signInNotice: string | null;
  clearSignInNotice: () => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const v = useContext(AccountContext);
  if (!v) throw new Error("useAccount must be used inside <LicenseBridge>");
  return v;
}

export interface LicenseBridgeRenderProps {
  plan: Plan;
  onSignIn: () => void;
  onManageSubscription: () => void;
}

export interface LicenseBridgeProps {
  service: LicenseServiceLike;
  ui?: LicenseUi;
  /** Skip `init()` (tests that drive the state directly). */
  skipInit?: boolean;
  children: (props: LicenseBridgeRenderProps) => ReactNode;
}

export function LicenseBridge({ service, ui = defaultLicenseUi, skipInit = false, children }: LicenseBridgeProps) {
  const state = useSyncExternalStore(
    (cb) => service.subscribe(() => cb()),
    () => service.getState(),
    () => service.getState(),
  );
  const [signingIn, setSigningIn] = useState(false);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const signingRef = useRef(false);
  const manageUrl = useRef<string | null>(null);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Init once; refresh when the user comes back to the pane.
  useEffect(() => {
    if (!skipInit) void service.init().catch(() => {});
    const unsubscribe = uiRef.current.subscribeFocus?.(() => void service.refreshIfStale().catch(() => {}));
    return () => unsubscribe?.();
  }, [service, skipInit]);

  // Prefetch the manage-subscription URL so the click can open it synchronously.
  const accountKey = `${state.account?.email ?? ""}|${state.plan}`;
  useEffect(() => {
    let live = true;
    manageUrl.current = null;
    void service
      .manageSubscriptionUrl()
      .then((u) => {
        if (live && isHttpsUrl(u)) manageUrl.current = u;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [service, accountKey]);

  const signIn = useCallback(() => {
    if (signingRef.current) {
      setSignInNotice("The sign-in window is already open. Finish signing in there, or close it and try again.");
      return;
    }
    let pending: Promise<SignInDialogResult>;
    try {
      pending = uiRef.current.openSignInDialog(); // synchronous: still inside the user gesture
    } catch (e) {
      setSignInNotice(signInFailureMessage(e));
      return;
    }
    signingRef.current = true;
    setSigningIn(true);
    setSignInNotice(null);
    pending
      .then(async (r) => {
        if (r.kind === "signed-in") {
          await service.acceptSession({ sessionToken: r.sessionToken, account: r.account });
          if (mounted.current) setSignInNotice(null);
        } else if (r.kind === "dismissed") {
          if (mounted.current) setSignInNotice("The sign-in window was closed before you finished. You're not signed in.");
        }
        // "cancelled": the user chose Cancel in the dialog; nothing to say.
      })
      .catch((e: unknown) => {
        if (mounted.current) setSignInNotice(signInFailureMessage(e));
      })
      .finally(() => {
        signingRef.current = false;
        if (mounted.current) setSigningIn(false);
      });
  }, [service]);

  const manageSubscription = useCallback(() => {
    const url = manageUrl.current;
    if (url) {
      uiRef.current.openBrowserWindow(url); // synchronous: inside the click
      return;
    }
    void service
      .manageSubscriptionUrl()
      .then((u) => {
        if (isHttpsUrl(u)) uiRef.current.openBrowserWindow(u);
      })
      .catch(() => {});
  }, [service]);

  const clearSignInNotice = useCallback(() => setSignInNotice(null), []);

  const value = useMemo<AccountContextValue>(
    () => ({ state, service, signIn, manageSubscription, signingIn, signInNotice, clearSignInNotice }),
    [state, service, signIn, manageSubscription, signingIn, signInNotice, clearSignInNotice],
  );

  return (
    <AccountContext.Provider value={value}>
      {children({ plan: state.plan, onSignIn: signIn, onManageSubscription: manageSubscription })}
    </AccountContext.Provider>
  );
}
