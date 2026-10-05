import type { Context } from "hono";
import { getAccountById, listSubscriptions, upsertSubscriptionStatement } from "./db";
import type { HonoEnv } from "./env";
import { hmacSha256, timingSafeEqual, toHex, utf8 } from "./util";

/** Outbound Paddle Billing API calls. Tests use a fake. */
export interface PaddleClient {
  /** Cancels immediately. Must succeed (or already be canceled) before account deletion proceeds. */
  cancelSubscription(subscriptionId: string): Promise<void>;
  /**
   * Creates a Paddle customer-portal session and returns its authenticated overview URL
   * (`data.urls.general.overview`). Portal links are short-lived, so callers create one per request.
   * Throws when Paddle fails or returns no URL.
   */
  createPortalSession(customerId: string): Promise<string>;
}

export class PaddleApiClient implements PaddleClient {
  private readonly base: string;
  constructor(
    private readonly apiKey: string,
    environment: string,
    private readonly fetcher: typeof fetch = (i, init) => fetch(i, init),
  ) {
    this.base = environment === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
  }

  private call(path: string, body: unknown): Promise<Response> {
    return this.fetcher(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const res = await this.call(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { effective_from: "immediately" });
    if (res.ok) return;
    const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    // Already canceled counts as done (Paddle error codes for this mention "canceled").
    if (err?.error?.code?.includes("canceled")) return;
    throw new Error(`paddle cancel failed: ${res.status}`);
  }

  async createPortalSession(customerId: string): Promise<string> {
    const res = await this.call(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, {});
    if (!res.ok) throw new Error(`paddle portal session failed: ${res.status}`);
    const body = (await res.json().catch(() => null)) as { data?: { urls?: { general?: { overview?: unknown } } } } | null;
    const url = body?.data?.urls?.general?.overview;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("paddle portal session returned no URL");
    return url;
  }
}

export const SIGNATURE_TOLERANCE_S = 300;

/**
 * Verifies a `Paddle-Signature: ts=<unix>;h1=<hex>` header: h1 = HMAC-SHA256(secret, `${ts}:${rawBody}`).
 * Several h1 values may be present during secret rotation. Rejects timestamps outside ±5 minutes.
 */
export async function verifyPaddleSignature(header: string | null | undefined, rawBody: string, secret: string, nowMs: number): Promise<boolean> {
  if (!header || !secret) return false;
  let ts: string | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "h1") h1.push(v.toLowerCase());
  }
  if (!ts || !/^\d{1,12}$/.test(ts) || h1.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = utf8(toHex(await hmacSha256(secret, `${ts}:${rawBody}`)));
  let ok = false;
  for (const candidate of h1) ok = timingSafeEqual(expected, utf8(candidate)) || ok;
  return ok;
}

const HANDLED = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
]);

interface PaddleEvent {
  event_id?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  data?: {
    id?: unknown;
    status?: unknown;
    customer_id?: unknown;
    custom_data?: { account_id?: unknown } | null;
    current_billing_period?: { ends_at?: unknown } | null;
    first_billed_at?: unknown;
    canceled_at?: unknown;
  };
}

function parseTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function handlePaddleWebhook(c: Context<HonoEnv>) {
  const now = c.var.deps.now();
  const raw = await c.req.text();
  if (!(await verifyPaddleSignature(c.req.header("Paddle-Signature"), raw, c.env.PADDLE_WEBHOOK_SECRET, now))) {
    return c.json({ error: "invalid_signature" }, 400);
  }
  let event: PaddleEvent;
  try {
    event = JSON.parse(raw) as PaddleEvent;
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (typeof event.event_id !== "string" || typeof event.event_type !== "string" || !event.event_id) {
    return c.json({ error: "invalid_payload" }, 400);
  }
  const db = c.env.DB;
  // No pre-check for a replayed event: the webhook_events insert leads the atomic batch, so a duplicate
  // event_id fails it (rolling back any subscription change) and the catch below reports duplicate.
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)").bind(event.event_id, event.event_type, now),
  ];
  let applied = false;
  const d = event.data;
  if (HANDLED.has(event.event_type) && d && typeof d.id === "string" && typeof d.status === "string") {
    const occurredAt = parseTime(event.occurred_at) ?? now;
    const isPaying = d.status === "active" || d.status === "past_due";
    const accountId = d.custom_data?.account_id;
    const account = typeof accountId === "string" ? await getAccountById(db, accountId) : null;
    if (account) {
      statements.push(
        upsertSubscriptionStatement(
          db,
          {
            paddle_subscription_id: d.id,
            account_id: account.id,
            paddle_customer_id: typeof d.customer_id === "string" ? d.customer_id : null,
            status: d.status,
            current_period_end: parseTime(d.current_billing_period?.ends_at),
            last_event_at: occurredAt,
            first_active_at: parseTime(d.first_billed_at) ?? (isPaying ? occurredAt : null),
            canceled_at: d.status === "canceled" ? (parseTime(d.canceled_at) ?? occurredAt) : null,
          },
          now,
        ),
      );
      applied = true;
    }
  }
  try {
    await db.batch(statements); // atomic: event id + subscription change
  } catch (err) {
    // Only a stored event id makes this a duplicate; any other failure is rethrown.
    const again = await db.prepare("SELECT 1 FROM webhook_events WHERE event_id = ?").bind(event.event_id).first();
    if (again) return c.json({ ok: true, duplicate: true });
    throw err;
  }
  return c.json({ ok: true, applied });
}

/** Cancels every subscription that is not already canceled. Throws if any cancel fails. */
export async function cancelActiveSubscriptions(c: Context<HonoEnv>, accountId: string): Promise<void> {
  const subs = await listSubscriptions(c.env.DB, accountId);
  for (const s of subs) {
    if (s.status !== "canceled") await c.var.deps.paddle.cancelSubscription(s.paddle_subscription_id);
  }
}
