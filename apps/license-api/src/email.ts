/**
 * Transactional email. The provider is not chosen yet (see plan risk "Sign-in codes land in spam"):
 * whichever is picked must support SPF/DKIM on the sending domain. Implement `EmailSender` for it and
 * return it from `createEmailSender`. Tests use a capturing fake.
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

/** Placeholder until a provider is chosen: fails closed so no code is silently dropped. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(_message: EmailMessage): Promise<void> {
    throw new EmailNotConfiguredError();
  }
}

export function createEmailSender(_env: { EMAIL_API_KEY: string; EMAIL_FROM: string }): EmailSender {
  return new UnconfiguredEmailSender();
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
