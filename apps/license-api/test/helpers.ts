import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import type { AppBindings } from "../src/env";
import type { EmailMessage, EmailSender } from "../src/email";
import type { PaddleClient } from "../src/paddle";
import type { DnsResolver, DnsResult } from "../src/ssrf";

export const TEST_IP = "203.0.113.7";
export const DAY = 86_400_000;

export class CapturingEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCodeFor(to: string): string {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    const match = msg?.text.match(/\b(\d{6})\b/);
    if (!match?.[1]) throw new Error(`no code sent to ${to}`);
    return match[1];
  }
}

export class FakePaddleClient implements PaddleClient {
  canceled: string[] = [];
  fail = false;
  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (this.fail) throw new Error("paddle down");
    this.canceled.push(subscriptionId);
  }
  async createPortalUrl(customerId: string): Promise<string | null> {
    return `https://sandbox-customer-portal.paddle.com/${customerId}`;
  }
}

export class FakeResolver implements DnsResolver {
  lookups: string[] = [];
  constructor(public records: Record<string, DnsResult> = {}) {}
  async resolve(hostname: string): Promise<DnsResult> {
    this.lookups.push(hostname);
    return this.records[hostname] ?? { status: "ok", addresses: ["93.184.216.34"] };
  }
}

/** Builds a bodiless response; statuses outside 200-599 (e.g. LinkedIn's 999) are patched in. */
export function statusResponse(status: number): Response {
  const res = new Response(null, { status: status >= 200 && status <= 599 ? status : 599 });
  if (res.status !== status) Object.defineProperty(res, "status", { value: status });
  return res;
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Outbound fetch fake for link checks. Unknown URLs throw like a network failure. */
export class FakeFetcher {
  calls: { url: string; method: string }[] = [];
  routes = new Map<string, Handler>();
  on(url: string, handler: Handler | number): this {
    this.routes.set(url, typeof handler === "number" ? () => statusResponse(handler) : handler);
    return this;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    this.calls.push({ url: req.url, method: req.method });
    const handler = this.routes.get(req.url);
    if (!handler) throw new TypeError(`network error: ${req.url}`);
    return handler(req);
  };
  urls(): string[] {
    return this.calls.map((c) => c.url);
  }
}

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 1, 12, 0, 0)) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function makeHarness(overrides: Partial<AppBindings> = {}) {
  const email = new CapturingEmailSender();
  const paddle = new FakePaddleClient();
  const resolver = new FakeResolver();
  const fetcher = new FakeFetcher();
  const clock = new Clock();
  const app = createApp(() => ({
    email,
    paddle,
    resolver,
    fetch: fetcher.fetch,
    now: clock.now,
    linkTimeoutMs: 100,
  }));
  const bindings: AppBindings = { ...env, ...overrides };

  async function request(path: string, init: RequestInit & { ip?: string; token?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("CF-Connecting-IP", init.ip ?? TEST_IP);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers }, bindings);
  }

  function json(path: string, body: unknown, init: RequestInit & { ip?: string; token?: string } = {}) {
    return request(path, { method: "POST", ...init, body: JSON.stringify(body) });
  }

  async function signIn(address: string, ip?: string): Promise<{ token: string; accountId: string }> {
    const start = await json("/auth/start", { email: address }, { ip });
    if (start.status !== 200) throw new Error(`start failed ${start.status}: ${await start.text()}`);
    const sentTo = email.sent.at(-1)?.to ?? address;
    const verify = await json("/auth/verify", { email: address, code: email.lastCodeFor(sentTo) }, { ip });
    if (verify.status !== 200) throw new Error(`verify failed ${verify.status}: ${await verify.text()}`);
    const body = await verify.json<{ session_token: string; account: { id: string } }>();
    return { token: body.session_token, accountId: body.account.id };
  }

  return { app, email, paddle, resolver, fetcher, clock, bindings, request, json, signIn };
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["sessions", "otp_codes", "subscriptions", "webhook_events", "rate_limits", "accounts"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export async function count(table: string, where = "1=1", ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (ch) => ch.charCodeAt(0));
}

export function b64urlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJwtPayload<T>(token: string): T {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as T;
}
