/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "./signin.html?raw";
import { ApiError } from "../license/api";
import { SIGNIN_MESSAGES, mountSignIn, type SignInPageApi } from "./signin";

const ACCOUNT = { id: "acct", email: "ada@example.com", trial_ends_at: 5 };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

let api: { startAuth: ReturnType<typeof vi.fn>; verifyAuth: ReturnType<typeof vi.fn> };
let sent: unknown[];
let unmount: () => void;

function mount() {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  sent = [];
  const handle = mountSignIn({
    api: api as unknown as SignInPageApi,
    messageParent: (m) => sent.push(JSON.parse(m)),
    doc: document,
  });
  unmount = handle.destroy;
}

async function submitEmail(email = "ada@example.com") {
  el<HTMLInputElement>("email").value = email;
  el<HTMLFormElement>("email-form").requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
}

async function submitCode(code = "123456") {
  el<HTMLInputElement>("code").value = code;
  el<HTMLFormElement>("code-form").requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
}

const visible = (id: string) => !el(id).hidden;

beforeEach(() => {
  vi.useFakeTimers();
  api = {
    startAuth: vi.fn(async () => ({ resendAfterSeconds: 30, expiresInSeconds: 600 })),
    verifyAuth: vi.fn(async () => ({ sessionToken: "sess", expiresAt: 9, account: ACCOUNT })),
  };
  mount();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("sign-in dialog page", () => {
  it("the markup has no inline script", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("starts on the email step", () => {
    expect(visible("email-step")).toBe(true);
    expect(visible("code-step")).toBe(false);
  });

  it("sends the code and moves to the code step with a 30 s resend countdown", async () => {
    await submitEmail(" ada@example.com ");
    expect(api.startAuth).toHaveBeenCalledWith("ada@example.com");
    expect(visible("code-step")).toBe(true);
    expect(visible("email-step")).toBe(false);
    expect(el("code-sent-to").textContent).toContain("ada@example.com");
    const resend = el<HTMLButtonElement>("resend");
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toBe("Resend code in 30 s");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(resend.textContent).toBe("Resend code in 1 s");
    expect(resend.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resend.textContent).toBe("Resend code");
    expect(resend.disabled).toBe(false);
  });

  it("uses the countdown the API returns", async () => {
    api.startAuth.mockResolvedValueOnce({ resendAfterSeconds: 45, expiresInSeconds: 600 });
    await submitEmail();
    expect(el("resend").textContent).toBe("Resend code in 45 s");
  });

  it("resend sends again and restarts the countdown", async () => {
    await submitEmail();
    await vi.advanceTimersByTimeAsync(30_000);
    el<HTMLButtonElement>("resend").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startAuth).toHaveBeenCalledTimes(2);
    expect(el("resend").textContent).toBe("Resend code in 30 s");
    expect(el("status").textContent).toMatch(/new code/i);
  });

  it("resend_too_soon restarts the countdown from Retry-After", async () => {
    await submitEmail();
    await vi.advanceTimersByTimeAsync(30_000);
    api.startAuth.mockRejectedValueOnce(new ApiError("resend_too_soon", 429, 12));
    el<HTMLButtonElement>("resend").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el("error").textContent).toBe(SIGNIN_MESSAGES.resend_too_soon);
    expect(el("resend").textContent).toBe("Resend code in 12 s");
  });

  it.each(["invalid_email", "rate_limited", "too_many_signups", "email_unavailable", "network"] as const)(
    "email step shows the %s message and stays put",
    async (code) => {
      api.startAuth.mockRejectedValueOnce(new ApiError(code, code === "network" ? 0 : 400));
      await submitEmail();
      expect(el("error").textContent).toBe(SIGNIN_MESSAGES[code]);
      expect(visible("email-step")).toBe(true);
      expect(el<HTMLButtonElement>("email-submit").disabled).toBe(false);
    },
  );

  it("rate limits mention the wait when Retry-After is known", async () => {
    api.startAuth.mockRejectedValueOnce(new ApiError("rate_limited", 429, 90));
    await submitEmail();
    expect(el("error").textContent).toBe("Too many attempts. Try again in 2 minutes.");
  });

  it("rejects an empty email without calling the API", async () => {
    await submitEmail("   ");
    expect(api.startAuth).not.toHaveBeenCalled();
    expect(el("error").textContent).toBe(SIGNIN_MESSAGES.invalid_email);
  });

  it.each(["invalid_code", "code_expired", "code_locked", "rate_limited", "network"] as const)(
    "code step shows the %s message",
    async (code) => {
      await submitEmail();
      api.verifyAuth.mockRejectedValueOnce(new ApiError(code, 400));
      await submitCode();
      expect(el("error").textContent).toBe(SIGNIN_MESSAGES[code]);
      expect(visible("code-step")).toBe(true);
      expect(sent).toEqual([]);
    },
  );

  it("an unexpected error shows a generic message", async () => {
    await submitEmail();
    api.verifyAuth.mockRejectedValueOnce(new Error("boom"));
    await submitCode();
    expect(el("error").textContent).toBe(SIGNIN_MESSAGES.unknown);
  });

  it("clears the previous error on the next attempt", async () => {
    await submitEmail();
    api.verifyAuth.mockRejectedValueOnce(new ApiError("invalid_code", 400));
    await submitCode("111111");
    await submitCode("123456");
    expect(el("error").textContent).toBe("");
  });

  it("on success posts the session to the task pane", async () => {
    await submitEmail();
    await submitCode(" 123 456 ");
    expect(api.verifyAuth).toHaveBeenCalledWith("ada@example.com", "123456");
    expect(sent).toEqual([{ type: "signed-in", session_token: "sess", account: ACCOUNT }]);
  });

  it("guards against double submission while a request is in flight", async () => {
    let release!: (v: unknown) => void;
    api.startAuth.mockImplementationOnce(() => new Promise((r) => (release = r)));
    el<HTMLInputElement>("email").value = "ada@example.com";
    el<HTMLFormElement>("email-form").requestSubmit();
    el<HTMLFormElement>("email-form").requestSubmit();
    expect(el<HTMLButtonElement>("email-submit").disabled).toBe(true);
    release({ resendAfterSeconds: 30, expiresInSeconds: 600 });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startAuth).toHaveBeenCalledTimes(1);
  });

  it("'Use a different email' returns to the email step", async () => {
    await submitEmail();
    el<HTMLButtonElement>("change-email").click();
    expect(visible("email-step")).toBe(true);
    expect(el<HTMLInputElement>("email").value).toBe("ada@example.com");
  });

  it("Cancel tells the task pane", () => {
    el<HTMLButtonElement>("cancel").click();
    expect(sent).toEqual([{ type: "cancelled" }]);
  });

  it("renders user input as text only", async () => {
    await submitEmail('<img src=x onerror="alert(1)">@x.co');
    expect(document.querySelector("img")).toBeNull();
    expect(el("code-sent-to").textContent).toContain("<img");
  });
});
