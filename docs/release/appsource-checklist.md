# AppSource submission checklist

Status: not submitted. Items marked **You** need account access or a decision from the owner.

## Accounts and hosting

- [ ] **You:** Partner Center account enrolled for Office add-ins.
- [x] Cloudflare: the add-in (`apps/addin/wrangler.toml`, Worker `slidefidelity-addin`) is live at `app.slidefidelity.com` and the site (`apps/site/wrangler.toml`, Worker `slidefidelity-site`) at `slidefidelity.com` and `www.slidefidelity.com`, deployed 2026-10-04 as Workers static assets (not Pages: the configs claim their custom domains themselves). Source maps are not published (`.assetsignore`).
- [x] The Worker `apps/license-api` (`slidefidelity-license-api`) is deployed at `api.slidefidelity.com` (2026-10-05). **You:** its daily cleanup cron needs a workers.dev subdomain: open Workers & Pages in the Cloudflare dashboard once, then redeploy.
- [x] D1 database `slidefidelity-license` (`af1b7d85-…`) created and both migrations applied (2026-10-05):

  ```bash
  npx wrangler d1 migrations apply slidefidelity-license --remote
  ```

- [ ] Worker secrets (`wrangler.toml` lists each one). Set on 2026-10-05: `SESSION_SECRET`, `ENTITLEMENT_PRIVATE_KEY`, `REVIEWER_CODE` (generated; the reviewer code is kept outside the repo). **You:** the Paddle and Resend secrets:
  - `SESSION_SECRET`
  - `ENTITLEMENT_PRIVATE_KEY` (from `npm run keys:generate -w @slidefidelity/license-api`)
  - `PADDLE_WEBHOOK_SECRET`
  - `PADDLE_API_KEY`
  - `EMAIL_API_KEY` (Resend)
  - `REVIEWER_CODE` (a long random value)
- [ ] **You:** Verify the sending domain in Resend, with SPF and DKIM.
- [ ] Paddle (live account, 2026-10-05):
  - [x] Product `SlideFidelity Pro` (`pro_01m46m0ema3ap4wk8xkjwjsj2b`), price $79/year USD, excludes tax, quantity 1 (`pri_01m46m1ye39sje220r46fthmxs`).
  - [x] Webhook destination `https://api.slidefidelity.com/paddle/webhook` (platform and simulation events); a simulated `subscription.created` was accepted (200) and stored.
  - [x] Worker secrets `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`; site config has the live client-side token and price ID; `PADDLE_ENV` / `PADDLE_ENVIRONMENT` = production.
  - [x] Customer portal (on by default).
  - [ ] **You:** website approval for `slidefidelity.com` (submitted, in review), then set the default payment link to `https://slidefidelity.com/account`.
  - [ ] **You:** Paddle business verification.
  - [ ] Optional: trim the webhook destination to the five `subscription.*` events the API handles.
- [x] Entitlement public key (`kid` `ent-2026-09`) embedded in `apps/addin/src/license/config.ts` and deployed (2026-10-05).

## Manifest (`apps/addin/manifest.xml`)

- [ ] `npm run validate --workspace @slidefidelity/addin` passes. The production build rewrites `https://localhost:3000/` to `https://app.slidefidelity.com/`.
- [ ] The minimum requirement set is `PowerPointApi 1.3`. The validator then reports Mac, web, and Windows (Microsoft 365) only, with no iPad or mobile. This keeps certification policy 1120.2, which bans purchase UI on mobile, out of scope. Leave "support mobile apps" unticked at submission.
- [ ] Icons at 16, 32, 64, 80, and 128 px are final artwork, not the template icons.
- [ ] `SupportUrl` resolves (`https://slidefidelity.com/support`).

## Listing and policy

- [ ] The listing description says which features need a Pro subscription.
- [ ] Privacy (`/privacy.html`), terms (`/terms.html`), and refunds (`/refund.html`) have passed legal review and are no longer marked as drafts.
- [ ] The privacy and terms pages carry no commerce UI.
- [ ] The add-in shows no prices and no checkout. "Manage subscription" opens the website account page with `openBrowserWindow`.

## Certification notes (paste into Partner Center)

- [ ] Reviewer sign-in: email `appsource-review@slidefidelity.com` (`REVIEWER_EMAIL`), code = the `REVIEWER_CODE` secret. This account always has Pro and never receives email.
- [ ] Test steps:
  1. Open any deck.
  2. Select **Home › Check Deck**, then **Scan**.
  3. Open each area.
  4. Select **Show in PowerPoint** on a finding.
  5. Replace a font.
  6. Remove a hidden shape.
- [ ] Recommended versions: PowerPoint for Mac 16.105 or later, Windows Microsoft 365 2601 or later, or PowerPoint on the web. Older builds disable some fixes and show the reason.

## SlideFidelity Helper disclosure

The optional native helper (`docs/plans/2026-10-01-2113-feat-slidefidelity-helper-plan.md` U13, R14; decisions in `docs/notes/helper-decisions.md`). Review each item against the current text of the Commercial marketplace certification policies before ticking it.

- [ ] **Optional and free.** The listing, the pane, and `helper.html` say the helper is optional and free, with no Pro gate on installing it.
- [ ] **Add-in fully functional without it.** Every feature works without the helper. Without it, the Fonts check uses the show-machine font list (G3); with it, "Missing on this computer" is exact (H7).
- [ ] **What it installs is disclosed (policy 100.11).** The listing, `privacy.html#helper`, and `helper.html` name the app, the login item, and the localhost-only certificate, and say how to uninstall.
- [ ] **Dependency disclosed in the listing description (policies 100.4 and 100.1.3).** The listing text below is in the description, and the exact-font-check feature is described as depending on the helper.
- [ ] **No download link on mobile (policy 1120.2).** The pane offers the helper only on PowerPoint desktop for Mac and Windows; web, iPad, and phones never see the offer. `helper.html` shows no download link on phones or tablets, even with `?platform=`.
- [ ] `apps/site/src/config.js` `helper` values are filled by the release pipeline (U10), and `helper.html` shows a working download with version and SHA-256 for both platforms.
- [ ] The privacy page's helper section has passed legal review with the rest of the page.

### Listing text (paste into the listing description)

> **Optional: SlideFidelity Helper for exact font checks.** On PowerPoint for Mac and Windows, you can install the free SlideFidelity Helper to see exactly which fonts in a deck are missing on this computer. SlideFidelity works fully without it and checks fonts against your show-machine font list instead. The helper installs a small background app, a login item that starts it at sign-in, and a certificate valid only for this computer's own address (localhost). It reads only the names of installed fonts, never opens presentations, and sends nothing off the computer except a check for its own updates. It is not available for PowerPoint on the web, iPad, or phones. Details and uninstall steps: https://slidefidelity.com/helper

### Certification notes (paste into Partner Center)

> SlideFidelity Helper is an optional, free companion app for PowerPoint desktop on Mac and Windows. The add-in is fully functional without it; it only makes one font check exact. It is never offered on PowerPoint on the web, iPad, or mobile, and the download page shows no download link on mobile devices.
>
> Helper off (default): open any deck on PowerPoint desktop and select Home › Check Deck › Scan. Open Problems › Fonts. The status reads "Using show-machine list" and the pane offers "Install SlideFidelity Helper for exact missing-font checks" with Install, Not now, and Don't ask again. Every feature works in this state.
>
> Helper on: install the helper from https://slidefidelity.com/helper (one administrator prompt from the installer). Return to SlideFidelity; the status changes to "Exact font check: on (SlideFidelity Helper vX)". Rescan: fonts not installed on the computer are reported as "Missing on this computer".
>
> To return to helper off, uninstall: Mac `sudo "/Library/Application Support/SlideFidelity/Helper/uninstall.sh"`; Windows Settings › Apps › Installed apps › SlideFidelity Helper › Uninstall.
>
> What the helper installs: an app, a login item, and a certificate unique to the computer, valid only for localhost, 127.0.0.1 and ::1, trusted for SSL only; its signing key is destroyed after creation. It reads only installed font names, answers only the SlideFidelity add-in over loopback, and sends nothing off the computer except an update check that administrators can turn off. Updates are offered in the pane and never install automatically.

## Before submitting

- [ ] CI is green on `main`.
- [ ] The host smoke matrix in the plan's Verification Contract is complete. Record the results in `docs/notes/office-js-platform-behavior.md`.
- [ ] Complete a Paddle sandbox purchase, and confirm the add-in shows Pro within 1 minute.
