/** D1 data access. All timestamps are epoch milliseconds. */

export const TRIAL_MS = 30 * 86_400_000;

export interface Account {
  id: string;
  email: string;
  created_at: number;
  trial_ends_at: number;
}

export interface Subscription {
  paddle_subscription_id: string;
  account_id: string;
  paddle_customer_id: string | null;
  status: string;
  current_period_end: number | null;
  last_event_at: number;
}

export interface OtpRow {
  id: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  attempts: number;
}

export function getAccountByEmail(db: D1Database, email: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<Account>();
}

export function getAccountById(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

/** Returns the existing account for `email`, or creates one with a fresh 30-day trial (R20). */
export async function getOrCreateAccount(db: D1Database, email: string, now: number): Promise<Account> {
  await db
    .prepare("INSERT INTO accounts (id, email, created_at, trial_ends_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(crypto.randomUUID(), email, now, now + TRIAL_MS)
    .run();
  const account = await getAccountByEmail(db, email);
  if (!account) throw new Error("account upsert failed");
  return account;
}

// --- OTP codes ---

export function latestOtp(db: D1Database, email: string): Promise<OtpRow | null> {
  return db
    .prepare("SELECT id, code_hash, created_at, expires_at, attempts FROM otp_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1")
    .bind(email)
    .first<OtpRow>();
}

/** Replaces any previous codes for the email with a single new one. */
export async function replaceOtp(db: D1Database, email: string, codeHash: string, now: number, ttlMs: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email),
    db
      .prepare("INSERT INTO otp_codes (id, email, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(crypto.randomUUID(), email, codeHash, now, now + ttlMs),
  ]);
}

export async function incrementOtpAttempts(db: D1Database, id: string): Promise<number> {
  const row = await db
    .prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? RETURNING attempts")
    .bind(id)
    .first<{ attempts: number }>();
  return row?.attempts ?? Number.MAX_SAFE_INTEGER;
}

/** Deletes the code row; returns false if it was already consumed (race-safe single use). */
export async function consumeOtp(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM otp_codes WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// --- sessions ---

export async function createSession(db: D1Database, accountId: string, now: number, ttlMs: number): Promise<{ id: string; expires_at: number }> {
  const id = crypto.randomUUID();
  const expires_at = now + ttlMs;
  await db
    .prepare("INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, accountId, now, expires_at)
    .run();
  return { id, expires_at };
}

/** Returns the account for a live (unrevoked, unexpired) session whose account still exists. */
export function getLiveSessionAccount(db: D1Database, sid: string, accountId: string, now: number): Promise<Account | null> {
  return db
    .prepare(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ? AND s.account_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .bind(sid, accountId, now)
    .first<Account>();
}

export async function revokeSession(db: D1Database, sid: string, now: number): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, sid).run();
}

// --- subscriptions ---

export async function listSubscriptions(db: D1Database, accountId: string): Promise<Subscription[]> {
  const res = await db.prepare("SELECT * FROM subscriptions WHERE account_id = ?").bind(accountId).all<Subscription>();
  return res.results;
}

export function upsertSubscriptionStatement(db: D1Database, s: Subscription, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO subscriptions (paddle_subscription_id, account_id, paddle_customer_id, status, current_period_end, last_event_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (paddle_subscription_id) DO UPDATE SET
         account_id = excluded.account_id,
         paddle_customer_id = COALESCE(excluded.paddle_customer_id, subscriptions.paddle_customer_id),
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         last_event_at = excluded.last_event_at,
         updated_at = excluded.updated_at
       WHERE excluded.last_event_at >= subscriptions.last_event_at`,
    )
    .bind(s.paddle_subscription_id, s.account_id, s.paddle_customer_id, s.status, s.current_period_end, s.last_event_at, now);
}

// --- deletion and housekeeping ---

export async function deleteAccountData(db: D1Database, account: Account): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(account.id),
    db.prepare("DELETE FROM otp_codes WHERE email = ?").bind(account.email),
    db.prepare("DELETE FROM subscriptions WHERE account_id = ?").bind(account.id),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id),
  ]);
}

export async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM otp_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now, now - 86_400_000),
    db.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
  ]);
}
