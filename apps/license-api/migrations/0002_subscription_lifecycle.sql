-- Subscription lifecycle timestamps for product metrics (D17). Epoch milliseconds.
-- Filled from Paddle subscription webhooks; rows written before this migration stay NULL
-- until their next webhook (Paddle resends first_billed_at on every subscription event).
ALTER TABLE subscriptions ADD COLUMN created_at INTEGER;       -- when this API first stored the subscription
ALTER TABLE subscriptions ADD COLUMN first_active_at INTEGER;  -- Paddle first_billed_at, else first active/past_due event time
ALTER TABLE subscriptions ADD COLUMN canceled_at INTEGER;      -- Paddle canceled_at (or event time) while status = canceled
CREATE INDEX subscriptions_first_active ON subscriptions (first_active_at);
