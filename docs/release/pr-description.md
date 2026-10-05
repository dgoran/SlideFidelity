# feat: SlideFidelity PowerPoint add-in, license API, and website

## Summary

SlideFidelity is a cross-platform alternative to Neuxpower Slidewise. It is an Office.js add-in for PowerPoint for Mac, Windows (Microsoft 365), and the web, and it does not run on iPad or mobile.

- **Audit engine** (`packages/audit-core`) parses a byte snapshot of the open `.pptx` in a Web Worker. It covers six areas:
  - Fonts: per script, plus bullet fonts, hidden list styles, theme fonts, charts, SmartArt, and embedding status.
  - Colors: theme colors and literal colors, recent colors, and the brand profile.
  - Media and size: oversized, too small, distorted, cropped-retained, low-compression, and auto-generated images, plus a per-slide size breakdown.
  - Masters and layouts.
  - Links: hyperlinks, linked files, local paths, and unsafe schemes.
  - File review: hidden content, off-slide shapes, empty placeholders and sections, notes, comments, properties, animations, transitions, autofit, and languages.
- **Task pane** (`apps/addin`) has these parts:
  - Overview with per-area counts.
  - Accessible, virtualized findings tree.
  - Show in PowerPoint.
  - Inspector.
  - Brand-profile editor.
  - Account panel.
  - Fix panel, which offers: replace fonts, replace colors, delete hidden, off-slide, or empty shapes, and edit or remove hyperlinks. Every fix rescans first, previews, runs in batches with progress and cancel, and offers "Open pre-fix copy".
  - Pro link reachability check.
- **License API** (`apps/license-api`) is a Cloudflare Worker with D1. It provides:
  - Email one-time-code sign-in through Resend.
  - Revocable sessions.
  - Ed25519-signed entitlements with 7-day offline grace.
  - A 30-day trial.
  - Paddle webhooks and a customer portal.
  - A link-check proxy hardened against SSRF.
  - Product-metrics SQL.
- **Website** (`apps/site`) has the landing, pricing, account (Paddle checkout and portal), privacy, terms, refund, and support pages.

Plan: `docs/plans/2026-09-30-1529-feat-slidefidelity-powerpoint-addin-plan.md`. The user's review decisions, which supersede parts of the plan: `docs/notes/review-decisions.md`.

## Testing

| Suite | Result |
|---|---|
| audit-core | 225 tests pass. An opt-in performance test scans a 50 MB, 100-slide deck in about 250 ms. |
| add-in | 477 tests pass. They include fix planners run on real audit findings, accessibility and virtualization, untrusted-text rendering, and licensing states. |
| license-api | 146 tests pass in the real Workers runtime (Miniflare and D1). They include concurrent OTP attempts, SSRF redirect blocking, webhook signature and replay handling, and rate limits. |

Typecheck, lint, manifest validation, the production add-in build, the site build, and a Worker dry-run bundle are clean. CI runs all of them (`.github/workflows/ci.yml`).

Not yet run: sideloading on real PowerPoint hosts. The open host questions are in `docs/notes/office-js-platform-behavior.md`.

## Review

`ce-code-review` ran with 10 reviewers (status complete; run `20261001-070948-854f02e5`). It produced 13 findings after validation, and all 11 actionable findings are applied (`fix(review)` commits). The cross-model adversarial pass did not run because no consent was given for code egress; the adversarial review ran locally instead.

Decision gates left for the owner:

- [ ] P2: deleting an account and signing up again grants a fresh 30-day trial (`apps/license-api/src/db.ts`). Decide whether to keep a hashed-email tombstone, which needs privacy sign-off, or to accept the behavior.
- [ ] P2 (release): replace the placeholder entitlement public key in `apps/addin/src/license/config.ts`, and the Paddle values in `apps/site/src/config.js`, before a production build.

## Post-Deploy Monitoring & Validation

- **Logs:** Worker logs for `sign-in email failed`, `invalid_signature` on `/paddle/webhook`, `billing_cancel_failed`, and 5xx on `/entitlement`.
- **Metrics:** run `apps/license-api/scripts/metrics.sql` weekly. Review the free/Pro split if trial-to-paid conversion is below 3% after 200 trials, or if 90-day retention is below 70% (see `docs/notes/product-metrics.md`).
- **Healthy signals:**
  - A sandbox purchase shows Pro in the add-in within 1 minute.
  - Sign-in codes arrive within 30 seconds.
  - The link-check 429 rate stays under 1% of requests.
- **Rollback triggers:**
  - Webhook signature failures after a Paddle key change.
  - Entitlement verification failures in the add-in, which would show as users reporting "please sign in again".
  - Roll back by redeploying the previous Worker version, then the previous Pages build.
- **Validation window:** the first 7 days after launch (the offline-grace length). Owner: the publisher.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
