import type { Account } from "./db";
import type { EmailSender } from "./email";
import type { PaddleClient } from "./paddle";
import type { RateLimiter } from "./ratelimit";
import type { DnsResolver } from "./ssrf";

/** Worker bindings: D1, `[vars]` from wrangler.toml, and secrets (see wrangler.toml comments). */
export interface AppBindings {
  DB: D1Database;
  // vars
  ALLOWED_ORIGINS: string;
  SITE_URL: string;
  ENTITLEMENT_KID: string;
  PADDLE_ENV: string;
  EMAIL_FROM: string;
  REVIEWER_EMAIL: string;
  LINKCHECK_GLOBAL_DAILY_URL_CAP?: string;
  // secrets
  SESSION_SECRET: string;
  ENTITLEMENT_PRIVATE_KEY: string;
  PADDLE_WEBHOOK_SECRET: string;
  PADDLE_API_KEY: string;
  EMAIL_API_KEY: string;
  REVIEWER_CODE: string;
}

/** Injectable collaborators. Production defaults are built in index.ts; tests pass fakes. */
export interface Deps {
  email: EmailSender;
  paddle: PaddleClient;
  resolver: DnsResolver;
  /** Outbound fetch used for link checks only. */
  fetch: typeof fetch;
  now: () => number;
  limiter: RateLimiter;
  linkTimeoutMs: number;
}

export interface HonoEnv {
  Bindings: AppBindings;
  Variables: {
    deps: Deps;
    account: Account;
    sessionId: string;
  };
}
