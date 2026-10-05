# Product metrics (D17)

SlideFidelity measures product success only from license-API (D1) data and Paddle. There is no in-pane tracking: the add-in sends no analytics, telemetry, or usage events, and deck content never leaves the device (R18).

## Metrics and success criteria

| Metric | Definition | Source | Review threshold |
|---|---|---|---|
| Sign-ups | New accounts per week (first successful email-code sign-in) | `accounts.created_at` | Review acquisition (listing copy, website) if weekly sign-ups fall for 4 weeks in a row |
| Trial starts | Every new account starts a 30-day Pro trial (R20), so trial starts are sign-ups minus accounts that paid before their trial began | `accounts`, `subscriptions.first_active_at` | Tracked for context; no separate threshold |
| Trial-to-paid conversion | Accounts whose first subscription became active within 45 days of account creation, divided by accounts created in that cohort. Only cohorts at least 45 days old count | `accounts`, `subscriptions.first_active_at` | **Review the Free/Pro split and trial length if conversion is below 3% after 200 trials** |
| 90-day paid retention | Of subscriptions that became active at least 90 days ago, the share not canceled within their first 90 days | `subscriptions.first_active_at`, `subscriptions.canceled_at` | **Review pricing and the Pro value (fixes, Inspector) if retention is below 70%** (after at least 30 paid subscriptions are 90+ days old) |
| Active paid | Accounts with an `active` or `past_due` subscription now | `subscriptions.status` | Informational; cross-check against the Paddle dashboard monthly |

Success for v1: trial-to-paid conversion at or above 3% and 90-day paid retention at or above 70% once the sample sizes above are reached. Revenue, refunds, and churn reasons come from the Paddle dashboard, not from the license API.

## How the data is recorded

- `accounts.created_at` is set on first sign-in.
- `subscriptions.first_active_at` and `subscriptions.canceled_at` (migration `0002_subscription_lifecycle.sql`) are written by the Paddle subscription webhooks. `first_active_at` uses Paddle's `first_billed_at`, falling back to the time of the first `active`/`past_due` event. `canceled_at` uses Paddle's `canceled_at` when the status is `canceled`.
- Subscriptions stored before migration 0002 have NULL lifecycle columns until their next webhook. Paddle includes `first_billed_at` on every subscription event, so they fill in at the next renewal or update.
- Deleted accounts (`DELETE /account`) are removed with their subscriptions, so the numbers describe accounts that still exist. Use Paddle for historical revenue.
- The AppSource reviewer account (`appsource-review@slidefidelity.com`) is excluded. If `REVIEWER_EMAIL` changes in `wrangler.toml`, update `scripts/metrics.sql`.

## Running the queries

From `apps/license-api`:

```sh
npx wrangler d1 migrations apply slidefidelity-license --remote   # once, to add the lifecycle columns
npx wrangler d1 execute slidefidelity-license --remote --file scripts/metrics.sql
```

The script is read-only. It prints six result sets in order: sign-ups per week, trial starts per week, conversion by weekly cohort, overall conversion, 90-day retention, and active paid accounts. `test/metrics.test.ts` runs the same file against the test database to keep it in step with the schema.

## Review cadence

Run the script monthly, and record the four headline numbers (sign-ups for the month, overall conversion, 90-day retention, active paid) alongside the Paddle MRR figure. Act on a threshold only once its sample-size condition is met.
