# AppSource submission checklist

Status: not submitted. Items marked **You** need account access or a decision from the owner.

## Accounts and hosting

- [ ] **You:** Partner Center account enrolled for Office add-ins.
- [ ] **You:** Cloudflare: Pages project for `apps/addin/dist` at `app.slidecheck.io`, and a Pages project for `apps/site/dist` at `slidecheck.io`. The Worker `apps/license-api` runs at `api.slidecheck.io`.
- [ ] **You:** Apply the D1 database and migrations:

  ```bash
  npx wrangler d1 migrations apply slidecheck-license --remote
  ```

- [ ] **You:** Set the Worker secrets. `wrangler.toml` lists each one:
  - `SESSION_SECRET`
  - `ENTITLEMENT_PRIVATE_KEY` (from `npm run keys:generate -w @slidecheck/license-api`)
  - `PADDLE_WEBHOOK_SECRET`
  - `PADDLE_API_KEY`
  - `EMAIL_API_KEY` (Resend)
  - `REVIEWER_CODE` (a long random value)
- [ ] **You:** Verify the sending domain in Resend, with SPF and DKIM.
- [ ] **You:** Paddle setup:
  - Create the Pro yearly price.
  - Approve the checkout domain.
  - Enable the customer portal.
  - Point the webhook at `/paddle/webhook` with the `subscription.*` events.
  - Fill in `apps/site/src/config.js`.
- [ ] Embed the entitlement public key (`x` and `kid`) in the add-in licensing client (U15).

## Manifest (`apps/addin/manifest.xml`)

- [ ] `npm run validate --workspace @slidecheck/addin` passes. The production build rewrites `https://localhost:3000/` to `https://app.slidecheck.io/`.
- [ ] The minimum requirement set is `PowerPointApi 1.3`. The validator then reports Mac, web, and Windows (Microsoft 365) only, with no iPad or mobile. This keeps certification policy 1120.2, which bans purchase UI on mobile, out of scope. Leave "support mobile apps" unticked at submission.
- [ ] Icons at 16, 32, 64, 80, and 128 px are final artwork, not the template icons.
- [ ] `SupportUrl` resolves (`https://slidecheck.io/support`).

## Listing and policy

- [ ] The listing description says which features need a Pro subscription.
- [ ] Privacy (`/privacy.html`), terms (`/terms.html`), and refunds (`/refund.html`) have passed legal review and are no longer marked as drafts.
- [ ] The privacy and terms pages carry no commerce UI.
- [ ] The add-in shows no prices and no checkout. "Manage subscription" opens the website account page with `openBrowserWindow`.

## Certification notes (paste into Partner Center)

- [ ] Reviewer sign-in: email `appsource-review@slidecheck.io` (`REVIEWER_EMAIL`), code = the `REVIEWER_CODE` secret. This account always has Pro and never receives email.
- [ ] Test steps:
  1. Open any deck.
  2. Select **Home › Check Deck**, then **Scan**.
  3. Open each area.
  4. Select **Show in PowerPoint** on a finding.
  5. Replace a font.
  6. Remove a hidden shape.
- [ ] Recommended versions: PowerPoint for Mac 16.105 or later, Windows Microsoft 365 2601 or later, or PowerPoint on the web. Older builds disable some fixes and show the reason.

## Before submitting

- [ ] CI is green on `main`.
- [ ] The host smoke matrix in the plan's Verification Contract is complete. Record the results in `docs/notes/office-js-platform-behavior.md`.
- [ ] Complete a Paddle sandbox purchase, and confirm the add-in shows Pro within 1 minute.
