import { describe, expect, it } from "vitest";
import {
  EmailNotConfiguredError,
  ResendEmailSender,
  UnconfiguredEmailSender,
  createEmailSender,
  signInCodeEmail,
} from "../src/email";

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: Response, captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
}

describe("ResendEmailSender", () => {
  it("posts the message to the Resend emails endpoint with bearer auth", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: "re_test_123",
      from: "SlideFidelity <signin@slidefidelity.com>",
      fetch: fakeFetch(Response.json({ id: "email_1" }), captured),
    });

    await sender.send(signInCodeEmail("ada@example.com", "123456"));

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer re_test_123");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body.from).toBe("SlideFidelity <signin@slidefidelity.com>");
    expect(body.to).toEqual(["ada@example.com"]);
    expect(body.subject).toBe("123456 is your SlideFidelity sign-in code");
    expect(body.text).toContain("123456");
    expect(body.html).toContain("123456");
  });

  it("escapes message text in the HTML body", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: "re_test_123",
      from: "SlideFidelity <signin@slidefidelity.com>",
      fetch: fakeFetch(Response.json({ id: "email_2" }), captured),
    });

    await sender.send({ to: "a@example.com", subject: "s", text: "<b>x</b> & y" });

    const body = JSON.parse(String(captured[0]!.init.body)) as { html: string };
    expect(body.html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(body.html).not.toContain("<b>x</b>");
  });

  it("throws when Resend rejects the request", async () => {
    const sender = new ResendEmailSender({
      apiKey: "re_test_123",
      from: "SlideFidelity <signin@slidefidelity.com>",
      fetch: fakeFetch(Response.json({ name: "validation_error" }, { status: 422 }), []),
    });

    await expect(sender.send(signInCodeEmail("a@example.com", "000000"))).rejects.toThrow(/Resend responded 422/);
  });

  it("throws when the network call fails", async () => {
    const sender = new ResendEmailSender({
      apiKey: "re_test_123",
      from: "SlideFidelity <signin@slidefidelity.com>",
      fetch: (async () => {
        throw new TypeError("network down");
      }) as typeof fetch,
    });

    await expect(sender.send(signInCodeEmail("a@example.com", "000000"))).rejects.toThrow("network down");
  });
});

describe("createEmailSender", () => {
  it("returns a Resend sender when an API key is configured", () => {
    const sender = createEmailSender({ EMAIL_API_KEY: "re_live_abc", EMAIL_FROM: "SlideFidelity <signin@slidefidelity.com>" });
    expect(sender).toBeInstanceOf(ResendEmailSender);
  });

  it("fails closed when no API key is configured", async () => {
    const sender = createEmailSender({ EMAIL_API_KEY: "", EMAIL_FROM: "SlideFidelity <signin@slidefidelity.com>" });
    expect(sender).toBeInstanceOf(UnconfiguredEmailSender);
    await expect(sender.send(signInCodeEmail("a@example.com", "000000"))).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    );
  });
});
