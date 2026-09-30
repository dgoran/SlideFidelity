/**
 * Sign-in dialog page (U15, D12): email → one-time code, with a resend countdown and a message per
 * error code. On success it sends the session to the task pane with `messageParent`; the pane
 * adopts it (`LicenseService.acceptSession`). All text goes through `textContent`.
 */
import { ApiError, createLicenseApi, type LicenseApi } from "../license/api";
import { createLicenseConfig } from "../license/config";

export type SignInPageApi = Pick<LicenseApi, "startAuth" | "verifyAuth">;

export type SignInMessageCode =
  | "invalid_email"
  | "invalid_code"
  | "code_expired"
  | "code_locked"
  | "resend_too_soon"
  | "rate_limited"
  | "too_many_signups"
  | "email_unavailable"
  | "network"
  | "unknown";

export const SIGNIN_MESSAGES: Record<SignInMessageCode, string> = {
  invalid_email: "Enter a valid email address.",
  invalid_code: "That code isn't right. Check the email and try again.",
  code_expired: "That code has expired. Send a new code.",
  code_locked: "Too many wrong attempts. Send a new code.",
  resend_too_soon: "A code was just sent. Wait a moment before asking for another.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  too_many_signups: "Too many new accounts were created from this network. Try again later.",
  email_unavailable: "We couldn't send the email right now. Try again in a few minutes.",
  network: "Can't reach SlideCheck. Check your connection and try again.",
  unknown: "Something went wrong. Try again.",
};

const KNOWN = new Set<string>(Object.keys(SIGNIN_MESSAGES));

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The user-facing text for a failed request. */
export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) return SIGNIN_MESSAGES.unknown;
  const code = (KNOWN.has(err.code) ? err.code : "unknown") as SignInMessageCode;
  const base = SIGNIN_MESSAGES[code];
  if (code === "rate_limited") {
    return err.retryAfterSeconds ? `Too many attempts. Try again in ${waitText(err.retryAfterSeconds)}.` : base;
  }
  return base;
}

export interface SignInPageDeps {
  api: SignInPageApi;
  /** `Office.context.ui.messageParent`. */
  messageParent: (message: string) => void;
  doc?: Document;
  now?: () => number;
}

export function mountSignIn(deps: SignInPageDeps): { destroy: () => void } {
  const doc = deps.doc ?? document;
  const now = deps.now ?? (() => Date.now());
  const byId = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`signin.html is missing #${id}`);
    return el as T;
  };

  const emailStep = byId<HTMLElement>("email-step");
  const codeStep = byId<HTMLElement>("code-step");
  const emailForm = byId<HTMLFormElement>("email-form");
  const emailInput = byId<HTMLInputElement>("email");
  const emailSubmit = byId<HTMLButtonElement>("email-submit");
  const codeForm = byId<HTMLFormElement>("code-form");
  const codeInput = byId<HTMLInputElement>("code");
  const codeSubmit = byId<HTMLButtonElement>("code-submit");
  const codeSentTo = byId<HTMLElement>("code-sent-to");
  const resend = byId<HTMLButtonElement>("resend");
  const changeEmail = byId<HTMLButtonElement>("change-email");
  const cancel = byId<HTMLButtonElement>("cancel");
  const errorEl = byId<HTMLElement>("error");
  const statusEl = byId<HTMLElement>("status");

  let email = "";
  let busy = false;
  let resendAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const setError = (text: string) => {
    errorEl.textContent = text;
  };
  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  function setBusy(value: boolean) {
    busy = value;
    emailSubmit.disabled = value;
    codeSubmit.disabled = value;
    renderResend();
  }

  function remaining(): number {
    return Math.max(0, Math.ceil((resendAt - now()) / 1000));
  }

  function renderResend() {
    const left = remaining();
    resend.textContent = left > 0 ? `Resend code in ${left} s` : "Resend code";
    resend.disabled = busy || left > 0;
    if (left === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startCountdown(seconds: number) {
    resendAt = now() + Math.max(0, seconds) * 1000;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(renderResend, 1000);
    renderResend();
  }

  function showStep(step: "email" | "code") {
    emailStep.hidden = step !== "email";
    codeStep.hidden = step !== "code";
    (step === "email" ? emailInput : codeInput).focus();
  }

  async function sendCode(isResend: boolean) {
    if (busy) return;
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const r = await deps.api.startAuth(email);
      codeSentTo.textContent = `We sent a 6-digit code to ${email}. It expires in ${waitText(r.expiresInSeconds)}.`;
      startCountdown(r.resendAfterSeconds);
      if (isResend) {
        setStatus("We sent a new code.");
        codeInput.value = "";
      } else {
        showStep("code");
      }
    } catch (err) {
      setError(messageFor(err));
      if (err instanceof ApiError && err.code === "resend_too_soon" && err.retryAfterSeconds) {
        startCountdown(err.retryAfterSeconds);
      }
    } finally {
      setBusy(false);
    }
  }

  const onEmailSubmit = (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    const value = emailInput.value.trim();
    if (!value) {
      setError(SIGNIN_MESSAGES.invalid_email);
      return;
    }
    email = value;
    void sendCode(false);
  };

  const onCodeSubmit = (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    const code = codeInput.value.replace(/\s+/g, "");
    if (!code) {
      setError(SIGNIN_MESSAGES.invalid_code);
      return;
    }
    void (async () => {
      setError("");
      setStatus("");
      setBusy(true);
      try {
        const r = await deps.api.verifyAuth(email, code);
        setStatus("Signed in.");
        deps.messageParent(JSON.stringify({ type: "signed-in", session_token: r.sessionToken, account: r.account }));
      } catch (err) {
        setError(messageFor(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const onResend = () => void sendCode(true);
  const onChangeEmail = () => {
    setError("");
    setStatus("");
    codeInput.value = "";
    showStep("email");
  };
  const onCancel = () => deps.messageParent(JSON.stringify({ type: "cancelled" }));

  emailForm.addEventListener("submit", onEmailSubmit);
  codeForm.addEventListener("submit", onCodeSubmit);
  resend.addEventListener("click", onResend);
  changeEmail.addEventListener("click", onChangeEmail);
  cancel.addEventListener("click", onCancel);
  showStep("email");

  return {
    destroy() {
      if (timer !== null) clearInterval(timer);
      emailForm.removeEventListener("submit", onEmailSubmit);
      codeForm.removeEventListener("submit", onCodeSubmit);
      resend.removeEventListener("click", onResend);
      changeEmail.removeEventListener("click", onChangeEmail);
      cancel.removeEventListener("click", onCancel);
    },
  };
}

// Bootstrap inside the Office dialog. Tests import the module without Office, so this is skipped.
if (typeof Office !== "undefined") {
  void Office.onReady(() => {
    mountSignIn({
      api: createLicenseApi({ baseUrl: createLicenseConfig().apiBase }),
      messageParent: (message) => Office.context.ui.messageParent(message),
    });
  });
}
