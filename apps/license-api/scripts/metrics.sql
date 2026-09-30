-- SlideCheck product metrics (D17). Read-only queries over the license-API D1 database.
-- Run:  npx wrangler d1 execute slidecheck-license --remote --file scripts/metrics.sql
-- See docs/notes/product-metrics.md for definitions and review thresholds.
--
-- Conventions: timestamps are epoch milliseconds; weeks are ISO-like Monday-start weeks labeled by
-- their Monday (UTC). The AppSource reviewer account is excluded everywhere.
-- Accounts deleted through DELETE /account are gone (with their subscriptions), so these numbers
-- describe accounts that still exist.

-- 1. Sign-ups per week (new accounts), last 26 weeks.
SELECT date(created_at / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week_start,
       COUNT(*) AS signups
FROM accounts
WHERE email <> 'appsource-review@slidecheck.io'
  AND created_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 26 * 7 * 86400) * 1000
GROUP BY week_start
ORDER BY week_start;

-- 2. Trial starts per week. Every new account starts a 30-day Pro trial (R20), so a trial start is an
--    account creation; accounts that bought Pro before their trial began are not counted as trials.
SELECT date(a.created_at / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week_start,
       COUNT(*) AS trial_starts
FROM accounts a
WHERE a.email <> 'appsource-review@slidecheck.io'
  AND a.created_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 26 * 7 * 86400) * 1000
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.account_id = a.id AND s.first_active_at IS NOT NULL AND s.first_active_at <= a.created_at
  )
GROUP BY week_start
ORDER BY week_start;

-- 3. Trial-to-paid conversion by weekly sign-up cohort. Converted = the account's first subscription
--    became active within 45 days of account creation (30-day trial + 15 days' slack).
--    Only cohorts at least 45 days old are shown, so every account had the full window.
SELECT week_start,
       COUNT(*) AS accounts,
       COALESCE(SUM(converted), 0) AS converted,
       ROUND(100.0 * COALESCE(SUM(converted), 0) / COUNT(*), 1) AS conversion_pct
FROM (
  SELECT date(a.created_at / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week_start,
         CASE WHEN MIN(s.first_active_at) IS NOT NULL
                   AND MIN(s.first_active_at) <= a.created_at + 45 * 86400000 THEN 1 ELSE 0 END AS converted
  FROM accounts a
  LEFT JOIN subscriptions s ON s.account_id = a.id
  WHERE a.email <> 'appsource-review@slidecheck.io'
    AND a.created_at <= (CAST(strftime('%s', 'now') AS INTEGER) - 45 * 86400) * 1000
  GROUP BY a.id
)
GROUP BY week_start
ORDER BY week_start;

-- 4. Trial-to-paid conversion, all mature cohorts combined (the number the review threshold uses).
SELECT COUNT(*) AS trials,
       COALESCE(SUM(converted), 0) AS converted,
       ROUND(100.0 * COALESCE(SUM(converted), 0) / MAX(COUNT(*), 1), 1) AS conversion_pct
FROM (
  SELECT CASE WHEN MIN(s.first_active_at) IS NOT NULL
                   AND MIN(s.first_active_at) <= a.created_at + 45 * 86400000 THEN 1 ELSE 0 END AS converted
  FROM accounts a
  LEFT JOIN subscriptions s ON s.account_id = a.id
  WHERE a.email <> 'appsource-review@slidecheck.io'
    AND a.created_at <= (CAST(strftime('%s', 'now') AS INTEGER) - 45 * 86400) * 1000
  GROUP BY a.id
);

-- 5. 90-day retention of paid subscriptions. Cohort = subscriptions that became active at least
--    90 days ago. Retained = not canceled, or canceled 90+ days after becoming active.
SELECT COUNT(*) AS paid_subscriptions_90d_old,
       COALESCE(SUM(CASE WHEN s.canceled_at IS NULL OR s.canceled_at >= s.first_active_at + 90 * 86400000 THEN 1 ELSE 0 END), 0) AS retained,
       ROUND(100.0 * COALESCE(SUM(CASE WHEN s.canceled_at IS NULL OR s.canceled_at >= s.first_active_at + 90 * 86400000 THEN 1 ELSE 0 END), 0)
             / MAX(COUNT(*), 1), 1) AS retention_pct
FROM subscriptions s
JOIN accounts a ON a.id = s.account_id
WHERE a.email <> 'appsource-review@slidecheck.io'
  AND s.first_active_at IS NOT NULL
  AND s.first_active_at <= (CAST(strftime('%s', 'now') AS INTEGER) - 90 * 86400) * 1000;

-- 6. Active paid accounts now (active or past_due subscription; past_due is still in Paddle dunning).
SELECT COUNT(DISTINCT s.account_id) AS active_paid_accounts
FROM subscriptions s
JOIN accounts a ON a.id = s.account_id
WHERE a.email <> 'appsource-review@slidecheck.io'
  AND s.status IN ('active', 'past_due');
