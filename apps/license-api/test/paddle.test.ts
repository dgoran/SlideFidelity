import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyPaddleSignature } from "../src/paddle";
import { DAY, count, makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Harness = ReturnType<typeof makeHarness>;

interface SubEvent {
  eventId: string;
  type: string;
  status: string;
  accountId: string | undefined;
  periodEnd?: number | null;
  occurredAt?: number;
  subscriptionId?: string;
}

function eventBody(h: Harness, e: SubEvent): string {
  return JSON.stringify({
    event_id: e.eventId,
    event_type: e.type,
    occurred_at: new Date(e.occurredAt ?? h.clock.t).toISOString(),
    notification_id: `ntf_${e.eventId}`,
    data: {
      id: e.subscriptionId ?? "sub_01",
      status: e.status,
      customer_id: "ctm_01",
      custom_data: e.accountId === undefined ? null : { account_id: e.accountId },
      current_billing_period:
        e.periodEnd === null
          ? null
          : {
              starts_at: new Date(h.clock.t - DAY).toISOString(),
              ends_at: new Date(e.periodEnd ?? h.clock.t + 30 * DAY).toISOString(),
            },
    },
  });
}

async function send(h: Harness, body: string, opts: { secret?: string; ts?: number; header?: string } = {}) {
  const ts = opts.ts ?? Math.floor(h.clock.t / 1000);
  const h1 = await hmacHex(opts.secret ?? env.PADDLE_WEBHOOK_SECRET, `${ts}:${body}`);
  const header = opts.header ?? `ts=${ts};h1=${h1}`;
  return h.request("/paddle/webhook", { method: "POST", body, headers: { "Paddle-Signature": header } });
}

async function plan(h: Harness, token: string): Promise<string> {
  const res = await h.request("/entitlement", { token });
  expect(res.status).toBe(200);
  return (await res.json<{ plan: string }>()).plan;
}

describe("verifyPaddleSignature", () => {
  it("accepts a valid header, including one of several h1 values", async () => {
    const body = '{"a":1}';
    const ts = 1_700_000_000;
    const good = await hmacHex("s3cret", `${ts}:${body}`);
    expect(await verifyPaddleSignature(`ts=${ts};h1=${good}`, body, "s3cret", ts * 1000)).toBe(true);
    expect(await verifyPaddleSignature(`ts=${ts};h1=${"0".repeat(64)};h1=${good}`, body, "s3cret", ts * 1000)).toBe(true);
    expect(await verifyPaddleSignature(`ts=${ts};h1=${good}`, body + " ", "s3cret", ts * 1000)).toBe(false);
    expect(await verifyPaddleSignature(`ts=${ts};h1=${good}`, body, "s3cret", (ts + 301) * 1000)).toBe(false);
    expect(await verifyPaddleSignature(`h1=${good}`, body, "s3cret", ts * 1000)).toBe(false);
    expect(await verifyPaddleSignature(null, body, "s3cret", ts * 1000)).toBe(false);
  });
});

describe("POST /paddle/webhook", () => {
  it("a bad signature returns 400 and changes nothing", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("bad@example.com");
    const body = eventBody(h, { eventId: "evt_bad", type: "subscription.activated", status: "active", accountId });
    expect((await send(h, body, { secret: "wrong-secret" })).status).toBe(400);
    expect((await send(h, body, { header: "garbage" })).status).toBe(400);
    const noHeader = await h.request("/paddle/webhook", { method: "POST", body });
    expect(noHeader.status).toBe(400);
    expect(await count("subscriptions")).toBe(0);
    expect(await count("webhook_events")).toBe(0);
  });

  it("a stale timestamp is rejected", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("stale@example.com");
    const body = eventBody(h, { eventId: "evt_stale", type: "subscription.activated", status: "active", accountId });
    const res = await send(h, body, { ts: Math.floor(h.clock.t / 1000) - 600 });
    expect(res.status).toBe(400);
    expect(await count("subscriptions")).toBe(0);
  });

  it("subscription.activated then /entitlement returns pro", async () => {
    const h = makeHarness();
    const { token, accountId } = await h.signIn("pro@example.com");
    h.clock.advance(40 * DAY); // trial over, session re-issued below
    const s = await h.signIn("pro@example.com");
    void token;
    expect(await plan(h, s.token)).toBe("free");
    const res = await send(h, eventBody(h, { eventId: "evt_1", type: "subscription.activated", status: "active", accountId }));
    expect(res.status).toBe(200);
    expect(await plan(h, s.token)).toBe("pro");
  });

  it("a replayed event id is a no-op", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("replay@example.com");
    const first = eventBody(h, { eventId: "evt_r", type: "subscription.activated", status: "active", accountId });
    expect((await send(h, first)).status).toBe(200);
    h.clock.advance(1000);
    const replay = eventBody(h, { eventId: "evt_r", type: "subscription.canceled", status: "canceled", accountId, periodEnd: null });
    const res = await send(h, replay);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    const row = await env.DB.prepare("SELECT status FROM subscriptions").first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect(await count("webhook_events")).toBe(1);
  });

  it("subscription.canceled with a period end in the past returns free; in the future stays pro", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("cancel@example.com");
    h.clock.advance(40 * DAY);
    const { token } = await h.signIn("cancel@example.com");
    await send(h, eventBody(h, { eventId: "evt_a", type: "subscription.activated", status: "active", accountId }));
    expect(await plan(h, token)).toBe("pro");

    h.clock.advance(1000);
    await send(
      h,
      eventBody(h, { eventId: "evt_c1", type: "subscription.canceled", status: "canceled", accountId, periodEnd: h.clock.t + 5 * DAY }),
    );
    expect(await plan(h, token)).toBe("pro");

    h.clock.advance(1000);
    await send(
      h,
      eventBody(h, { eventId: "evt_c2", type: "subscription.canceled", status: "canceled", accountId, periodEnd: h.clock.t - DAY }),
    );
    expect(await plan(h, token)).toBe("free");
  });

  it("canceled with no billing period is free", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("cancel2@example.com");
    h.clock.advance(40 * DAY);
    const { token } = await h.signIn("cancel2@example.com");
    await send(h, eventBody(h, { eventId: "evt_x", type: "subscription.canceled", status: "canceled", accountId, periodEnd: null }));
    expect(await plan(h, token)).toBe("free");
  });

  it("past_due and updated keep pro; created is stored", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("pd@example.com");
    h.clock.advance(40 * DAY);
    const { token } = await h.signIn("pd@example.com");
    await send(h, eventBody(h, { eventId: "evt_cr", type: "subscription.created", status: "active", accountId }));
    expect(await plan(h, token)).toBe("pro");
    h.clock.advance(1000);
    await send(h, eventBody(h, { eventId: "evt_pd", type: "subscription.past_due", status: "past_due", accountId }));
    expect(await plan(h, token)).toBe("pro");
    h.clock.advance(1000);
    await send(h, eventBody(h, { eventId: "evt_up", type: "subscription.updated", status: "active", accountId }));
    expect(await plan(h, token)).toBe("pro");
  });

  it("an older event arriving late does not overwrite newer state", async () => {
    const h = makeHarness();
    const { accountId } = await h.signIn("order@example.com");
    h.clock.advance(40 * DAY);
    const { token } = await h.signIn("order@example.com");
    const t0 = h.clock.t;
    await send(h, eventBody(h, { eventId: "evt_new", type: "subscription.canceled", status: "canceled", accountId, periodEnd: null }));
    await send(h, eventBody(h, { eventId: "evt_old", type: "subscription.activated", status: "active", accountId, occurredAt: t0 - 60_000 }));
    expect(await plan(h, token)).toBe("free");
  });

  it("an event without a known account_id is acknowledged and ignored", async () => {
    const h = makeHarness();
    expect((await send(h, eventBody(h, { eventId: "evt_n1", type: "subscription.activated", status: "active", accountId: undefined }))).status).toBe(200);
    expect((await send(h, eventBody(h, { eventId: "evt_n2", type: "subscription.activated", status: "active", accountId: "nope" }))).status).toBe(200);
    expect(await count("subscriptions")).toBe(0);
  });

  it("unhandled event types are acknowledged", async () => {
    const h = makeHarness();
    const body = JSON.stringify({ event_id: "evt_tx", event_type: "transaction.completed", occurred_at: new Date(h.clock.t).toISOString(), data: {} });
    expect((await send(h, body)).status).toBe(200);
    expect(await count("subscriptions")).toBe(0);
  });
});
