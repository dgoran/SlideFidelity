-- SlideCheck license API schema (U14). All timestamps are Unix epoch milliseconds.
-- Privacy: no link-check URLs, IP addresses, or webhook payloads are stored.

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,           -- random UUID
  email         TEXT NOT NULL UNIQUE,       -- normalized (see src/auth.ts normalizeEmail)
  created_at    INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL            -- created_at + 30 days (R20)
);

-- One-time sign-in codes. Keyed by normalized email because the account may not exist yet.
CREATE TABLE otp_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                -- hex SHA-256 of pepper:email:code
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,             -- created_at + 10 minutes
  attempts    INTEGER NOT NULL DEFAULT 0    -- locked at 5
);
CREATE INDEX otp_codes_email ON otp_codes (email, created_at);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,             -- `sid` claim of the session JWT
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,             -- created_at + 30 days
  revoked_at  INTEGER
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE subscriptions (
  paddle_subscription_id TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  paddle_customer_id     TEXT,
  status                 TEXT NOT NULL,     -- active | trialing | past_due | paused | canceled
  current_period_end     INTEGER,           -- end of the paid period, if known
  last_event_at          INTEGER NOT NULL,  -- occurred_at of the event that last wrote this row
  updated_at             INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions (account_id);

-- Paddle webhook idempotency. Only the id and type are kept, never the payload.
CREATE TABLE webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Fixed-window rate-limit counters. Keys embed hashed identifiers, never raw IPs or emails.
CREATE TABLE rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);
