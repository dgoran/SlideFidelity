/**
 * Opens the email one-time-code sign-in dialog (U15 approach 1, KTD7).
 *
 * Office on the web blocks dialogs not opened from a user gesture: call `openSignInDialog` directly
 * from a button's click handler, before any `await`. The page (`signin.html`) is served from the
 * add-in's own origin so `messageParent` needs no extra configuration.
 */
import type { ApiAccount } from "./api";

/** The subset of `Office.Dialog` used here. */
export interface DialogLike {
  addEventHandler(eventType: string, handler: (arg: unknown) => void): void;
  close(): void;
}

type OpenResult =
  | { status: "succeeded"; value: DialogLike }
  | { status: "failed"; error: { code: number; message: string } };

/** The subset of `Office.context.ui` used here (injectable for tests). */
export interface DialogUi {
  displayDialogAsync(
    url: string,
    options: { height: number; width: number; displayInIframe?: boolean; promptBeforeOpen?: boolean },
    callback: (result: OpenResult) => void,
  ): void;
}

export type SignInDialogResult =
  | { kind: "signed-in"; sessionToken: string; account: ApiAccount }
  /** The dialog's own Cancel button. */
  | { kind: "cancelled" }
  /** The user closed the dialog window (12006). */
  | { kind: "dismissed" };

export type SignInDialogErrorCode =
  /** 12007: a dialog is already open from this pane. */
  | "already-open"
  /** 12009 / 12011: the user or browser blocked the dialog (pop-up blocker, "Ignore"). */
  | "blocked"
  /** 12002 / 12003: the dialog page could not load. */
  | "load-failed"
  /** The dialog sent something that is not a sign-in payload. */
  | "bad-message"
  /** Any other open failure (12004 domain not trusted, 12005 not HTTPS, no host). */
  | "open-failed";

export class SignInDialogError extends Error {
  constructor(
    readonly code: SignInDialogErrorCode,
    readonly officeCode?: number,
  ) {
    super(`sign-in dialog: ${code}${officeCode ? ` (${officeCode})` : ""}`);
    this.name = "SignInDialogError";
  }
}

/** Messages the dialog page sends with `messageParent` (JSON). */
export type SignInDialogMessage =
  | { type: "signed-in"; session_token: string; account: ApiAccount }
  | { type: "cancelled" };

const DIALOG_MESSAGE = "dialogMessageReceived"; // Office.EventType.DialogMessageReceived
const DIALOG_EVENT = "dialogEventReceived"; // Office.EventType.DialogEventReceived

/** URL of the dialog page next to the task pane (webpack emits `signin.html` beside `taskpane.html`). */
export function signInDialogUrl(base: string = location.href): string {
  return new URL("signin.html", base).toString();
}

function openErrorCode(code: number): SignInDialogErrorCode {
  if (code === 12007) return "already-open";
  if (code === 12009 || code === 12011) return "blocked";
  return "open-failed";
}

function parseMessage(raw: unknown): SignInDialogMessage | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.type === "cancelled") return { type: "cancelled" };
  if (m.type !== "signed-in" || typeof m.session_token !== "string" || !m.session_token) return null;
  const a = m.account as Record<string, unknown> | null | undefined;
  if (!a || typeof a.id !== "string" || typeof a.email !== "string" || typeof a.trial_ends_at !== "number") return null;
  return { type: "signed-in", session_token: m.session_token, account: { id: a.id, email: a.email, trial_ends_at: a.trial_ends_at } };
}

export interface OpenSignInDialogOptions {
  /** Defaults to `Office.context.ui`. */
  ui?: DialogUi;
  /** Defaults to `signInDialogUrl()`. */
  url?: string;
}

export function openSignInDialog(options: OpenSignInDialogOptions = {}): Promise<SignInDialogResult> {
  const url = options.url ?? signInDialogUrl();
  const expectedOrigin = new URL(url).origin;
  return new Promise<SignInDialogResult>((resolve, reject) => {
    let settled = false;
    let dialog: DialogLike | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        dialog?.close();
      } catch {
        /* already closed */
      }
      fn();
    };

    const onMessage = (arg: unknown) => {
      const { message, origin } = (arg ?? {}) as { message?: unknown; origin?: unknown };
      // Newer hosts report the sender origin; ignore anything not from our own page.
      if (typeof origin === "string" && origin !== expectedOrigin) return;
      const m = parseMessage(message);
      if (!m) return finish(() => reject(new SignInDialogError("bad-message")));
      if (m.type === "cancelled") return finish(() => resolve({ kind: "cancelled" }));
      finish(() => resolve({ kind: "signed-in", sessionToken: m.session_token, account: m.account }));
    };

    const onEvent = (arg: unknown) => {
      const code = Number((arg as { error?: unknown } | null)?.error);
      if (code === 12006) {
        settled = true; // already closed by the user; nothing to close
        resolve({ kind: "dismissed" });
        return;
      }
      finish(() => reject(new SignInDialogError(code === 12002 || code === 12003 ? "load-failed" : "open-failed", code || undefined)));
    };

    try {
      const ui = options.ui ?? (Office.context.ui as unknown as DialogUi);
      ui.displayDialogAsync(url, { height: 60, width: 30, displayInIframe: true, promptBeforeOpen: false }, (result) => {
        if (result.status !== "succeeded") {
          settled = true;
          reject(new SignInDialogError(openErrorCode(result.error.code), result.error.code));
          return;
        }
        dialog = result.value;
        dialog.addEventHandler(DIALOG_MESSAGE, onMessage);
        dialog.addEventHandler(DIALOG_EVENT, onEvent);
      });
    } catch {
      settled = true;
      reject(new SignInDialogError("open-failed"));
    }
  });
}
