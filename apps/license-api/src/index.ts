import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleSignout, handleStart, handleVerify, requireSession } from "./auth";
import { deleteAccountData, listSubscriptions, purgeExpired } from "./db";
import { createEmailSender } from "./email";
import { handleEntitlement, publicJwks } from "./entitlement";
import type { AppBindings, Deps, HonoEnv } from "./env";
import { handleLinkcheck } from "./linkcheck";
import { PaddleApiClient, cancelActiveSubscriptions, handlePaddleWebhook } from "./paddle";
import { D1RateLimiter } from "./ratelimit";
import { DohResolver } from "./ssrf";

export type DepsOverrides = (env: AppBindings) => Partial<Deps>;

export function defaultDeps(env: AppBindings): Deps {
  const outbound: typeof fetch = (input, init) => fetch(input, init);
  return {
    email: createEmailSender(env),
    paddle: new PaddleApiClient(env.PADDLE_API_KEY, env.PADDLE_ENV, outbound),
    resolver: new DohResolver(outbound),
    fetch: outbound,
    now: () => Date.now(),
    limiter: new D1RateLimiter(env.DB),
    linkTimeoutMs: 5000,
  };
}

export function allowedOrigins(env: Pick<AppBindings, "ALLOWED_ORIGINS">): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function createApp(overrides?: DepsOverrides) {
  const app = new Hono<HonoEnv>();

  // KTD8: only the add-in and site origins; no credentials (bearer tokens only).
  app.use(
    "*",
    cors({
      origin: (origin, c) => (allowedOrigins(c.env as AppBindings).includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }),
  );
  app.use("*", async (c, next) => {
    c.set("deps", { ...defaultDeps(c.env), ...overrides?.(c.env) });
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/.well-known/entitlement-keys", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(publicJwks(c.env));
  });

  app.post("/auth/start", handleStart);
  app.post("/auth/verify", handleVerify);
  app.post("/auth/signout", requireSession, handleSignout);

  app.get("/entitlement", requireSession, handleEntitlement);
  app.post("/linkcheck", requireSession, handleLinkcheck);
  app.post("/paddle/webhook", handlePaddleWebhook);

  // Account-bound purchase links (KTD7). Checkout happens on the site account page, which signs the
  // user in and passes account_id into Paddle checkout custom_data. The portal link is a fresh
  // Paddle customer-portal session; any Paddle failure degrades to null rather than a 5xx.
  app.get("/billing/links", requireSession, async (c) => {
    const account = c.var.account;
    const checkout = new URL("/account.html", c.env.SITE_URL);
    const customer = (await listSubscriptions(c.env.DB, account.id)).find((s) => s.paddle_customer_id)?.paddle_customer_id;
    let portal: string | null = null;
    if (customer) {
      try {
        portal = await c.var.deps.paddle.createPortalSession(customer);
      } catch {
        console.error("paddle portal session failed");
        portal = null;
      }
    }
    return c.json({ checkout_url: checkout.toString(), portal_url: portal });
  });

  app.delete("/account", requireSession, async (c) => {
    const account = c.var.account;
    try {
      await cancelActiveSubscriptions(c, account.id);
    } catch {
      return c.json({ error: "billing_cancel_failed" }, 502);
    }
    await deleteAccountData(c.env.DB, account);
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error("unhandled error", err.name);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await purgeExpired(env.DB, Date.now());
  },
} satisfies ExportedHandler<AppBindings>;
