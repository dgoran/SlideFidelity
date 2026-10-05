import { describe, expect, it, vi } from "vitest";
import { SignInDialogError, openSignInDialog, signInDialogUrl, type DialogLike, type DialogUi } from "./signinDialog";

type Handler = (arg: unknown) => void;

function fakeUi(open: { ok: true } | { ok: false; code: number } = { ok: true }) {
  const handlers = new Map<string, Handler>();
  const dialog: DialogLike & { close: ReturnType<typeof vi.fn<() => void>> } = {
    addEventHandler: (type: string, h: Handler) => void handlers.set(type, h),
    close: vi.fn<() => void>(),
  };
  const ui: DialogUi = {
    displayDialogAsync: vi.fn((_url, _opts, cb) => {
      if (open.ok) cb({ status: "succeeded", value: dialog });
      else cb({ status: "failed", error: { code: open.code, message: "nope" } });
    }),
  };
  const message = (m: unknown, origin?: string) =>
    handlers.get("dialogMessageReceived")?.({ message: typeof m === "string" ? m : JSON.stringify(m), origin });
  const event = (error: number) => handlers.get("dialogEventReceived")?.({ error });
  return { ui, dialog, message, event };
}

const URL_ = "https://app.test/signin.html";
const ACCOUNT = { id: "acct", email: "ada@example.com", trial_ends_at: 1 };

describe("openSignInDialog", () => {
  it("opens the add-in's own signin page", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message({ type: "cancelled" });
    await p;
    expect(f.ui.displayDialogAsync).toHaveBeenCalledWith(URL_, expect.objectContaining({ height: expect.any(Number) }), expect.any(Function));
  });

  it("resolves signed-in with the session from messageParent and closes the dialog", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message({ type: "signed-in", session_token: "sess", account: ACCOUNT }, "https://app.test");
    await expect(p).resolves.toEqual({ kind: "signed-in", sessionToken: "sess", account: ACCOUNT });
    expect(f.dialog.close).toHaveBeenCalled();
  });

  it("resolves cancelled when the dialog's Cancel button is used", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message({ type: "cancelled" });
    await expect(p).resolves.toEqual({ kind: "cancelled" });
    expect(f.dialog.close).toHaveBeenCalled();
  });

  it("12006 (closed by the user) resolves 'dismissed'", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.event(12006);
    await expect(p).resolves.toEqual({ kind: "dismissed" });
  });

  it.each([
    [12007, "already-open"],
    [12009, "blocked"],
    [12011, "blocked"],
    [12004, "open-failed"],
  ])("open failure %i rejects with %s", async (code, expected) => {
    const f = fakeUi({ ok: false, code });
    const err = await openSignInDialog({ ui: f.ui, url: URL_ }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInDialogError);
    expect(err).toMatchObject({ code: expected, officeCode: code });
  });

  it("12002 (page failed to load) rejects with load-failed and closes", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.event(12002);
    await expect(p).rejects.toMatchObject({ code: "load-failed", officeCode: 12002 });
    expect(f.dialog.close).toHaveBeenCalled();
  });

  it("a malformed message rejects with bad-message", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message("not json");
    await expect(p).rejects.toMatchObject({ code: "bad-message" });
  });

  it("a signed-in message without a token rejects with bad-message", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message({ type: "signed-in", account: ACCOUNT });
    await expect(p).rejects.toMatchObject({ code: "bad-message" });
  });

  it("ignores messages from another origin", async () => {
    const f = fakeUi();
    const p = openSignInDialog({ ui: f.ui, url: URL_ });
    f.message({ type: "signed-in", session_token: "evil", account: ACCOUNT }, "https://evil.test");
    f.message({ type: "cancelled" }, "https://app.test");
    await expect(p).resolves.toEqual({ kind: "cancelled" });
  });

  it("a synchronous throw from displayDialogAsync rejects with open-failed", async () => {
    const ui: DialogUi = {
      displayDialogAsync: () => {
        throw new Error("no host");
      },
    };
    await expect(openSignInDialog({ ui, url: URL_ })).rejects.toMatchObject({ code: "open-failed" });
  });

  it("signInDialogUrl resolves next to the task pane", () => {
    expect(signInDialogUrl("https://app.test/taskpane.html?x=1")).toBe("https://app.test/signin.html");
  });
});
