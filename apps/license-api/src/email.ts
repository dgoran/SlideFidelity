/**
 * Transactional email through Resend (https://resend.com). The sending domain in EMAIL_FROM must be
 * verified in Resend with SPF and DKIM records, or codes land in spam (plan risk "Sign-in codes land
 * in spam"). Tests use a capturing fake.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("email provider not configured");
  }
}

/** Used when EMAIL_API_KEY is unset: fails closed so no code is silently dropped. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(_message: EmailMessage): Promise<void> {
    throw new EmailNotConfiguredError();
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}

export class ResendEmailSender implements EmailSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ResendConfig) {
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: textToHtml(message.text),
      }),
    });
    if (!response.ok) {
      // The response body can echo the recipient address, so only the status is surfaced.
      throw new Error(`Resend responded ${response.status}`);
    }
  }
}

export function createEmailSender(env: { EMAIL_API_KEY: string; EMAIL_FROM: string }): EmailSender {
  if (!env.EMAIL_API_KEY) return new UnconfiguredEmailSender();
  return new ResendEmailSender({ apiKey: env.EMAIL_API_KEY, from: env.EMAIL_FROM });
}

export function signInCodeEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: `${code} is your SlideCheck sign-in code`,
    text: [
      `Your SlideCheck sign-in code is ${code}`,
      "",
      "It expires in 10 minutes. If you did not try to sign in, you can ignore this email.",
    ].join("\n"),
  };
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const paragraphs = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`);
  return `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">${paragraphs.join("")}</div>`;
}
