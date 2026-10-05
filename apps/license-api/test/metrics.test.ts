import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import metricsSql from "../scripts/metrics.sql?raw";
import { DAY, resetDb } from "./helpers";

beforeEach(resetDb);

/** Splits scripts/metrics.sql into statements (comments stripped) and runs each against the test D1. */
async function runMetrics(): Promise<Record<string, unknown>[][]> {
  const statements = metricsSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Record<string, unknown>[][] = [];
  for (const sql of statements) out.push((await env.DB.prepare(sql).all<Record<string, unknown>>()).results);
  return out;
}

async function account(id: string, createdAt: number, email = `${id}@example.com`) {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at, trial_ends_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, createdAt, createdAt + 30 * DAY)
    .run();
}

async function sub(id: string, accountId: string, status: string, firstActiveAt: number | null, canceledAt: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (paddle_subscription_id, account_id, paddle_customer_id, status, current_period_end, last_event_at, updated_at, created_at, first_active_at, canceled_at)
     VALUES (?, ?, 'ctm', ?, NULL, 0, 0, 0, ?, ?)`,
  )
    .bind(id, accountId, status, firstActiveAt, canceledAt)
    .run();
}

describe("scripts/metrics.sql (D17)", () => {
  it("runs against the migrated schema and computes conversion, retention, and active paid", async () => {
    const now = Date.now();
    const old = now - 200 * DAY; // mature cohort for conversion and retention
    await account("a1", old); // converted on day 20, still active
    await sub("s1", "a1", "active", old + 20 * DAY);
    await account("a2", old); // converted on day 40, canceled after 30 days of paying
    await sub("s2", "a2", "canceled", old + 40 * DAY, old + 70 * DAY);
    await account("a3", old); // converted too late (day 60): not a trial conversion
    await sub("s3", "a3", "past_due", old + 60 * DAY);
    await account("a4", old); // never paid
    await account("rev", old, "appsource-review@slidefidelity.com"); // excluded
    await account("new", now - DAY); // too young for conversion, counted as a sign-up

    const [signups, trials, byCohort, conversion, retention, active] = await runMetrics();
    const sum = (rows: Record<string, unknown>[] | undefined, key: string) => (rows ?? []).reduce((n, r) => n + Number(r[key]), 0);
    expect(sum(signups, "signups")).toBe(1); // only "new" is within the 26-week window
    expect(sum(trials, "trial_starts")).toBe(1);
    expect(sum(byCohort, "accounts")).toBe(4);
    expect(conversion?.[0]).toMatchObject({ trials: 4, converted: 2, conversion_pct: 50 });
    // s1 retained (not canceled); s2 canceled 30 days in; s3 still paying.
    expect(retention?.[0]).toMatchObject({ paid_subscriptions_90d_old: 3, retained: 2 });
    expect(active?.[0]).toMatchObject({ active_paid_accounts: 2 });
  });

  it("returns zero rates, not errors, on an empty database", async () => {
    const [, , , conversion, retention, active] = await runMetrics();
    expect(conversion?.[0]).toMatchObject({ trials: 0, conversion_pct: 0 });
    expect(retention?.[0]).toMatchObject({ paid_subscriptions_90d_old: 0, retention_pct: 0 });
    expect(active?.[0]).toMatchObject({ active_paid_accounts: 0 });
  });
});
