# Review decisions (2026-09-30)

The user settled the document-review decisions on the SlideCheck plan (`docs/plans/2026-09-30-1529-feat-slidecheck-powerpoint-addin-plan.md`). Where this note and the plan differ, this note wins. IDs refer to the plan.

## Already implemented in the audit engine

- D1. Color auto-match is an info finding (`color-matches-theme`), not a fix. Converting literals to theme references moves to the deferred "Export cleaned copy". Affects R13, U6, U13.
- D2. Font and color fix targets never include theme-linked properties (`a:schemeClr`, `+mj-*`/`+mn-*` fonts). Those are listed as not fixable. Affects R12, R13, U5, U6, U13.
- D3. Hyperlink fixes match snapshot links to live links by (slide id, address, occurrence among same-address links on the slide). Ambiguous matches are skipped. Affects R15, KTD5, U9, U13.

## Scan freshness

- D4. Every fix first re-reads the file and rescans it. An unchanged file hash reuses the cached findings. A changed hash rescans, re-plans the fix, and shows the new preview before applying. Selection changes do not block anything. Replaces the stale-blocking behavior in KTD6, AE3, and U10/U12. Additional safeguards are allowed: an optional "may be out of date" hint, and fixes refuse shape targets matched only by name and position when deleting (`isSafeForDestructiveFix`).

## Product and licensing

- D5. Pro is positioned audit-first. The pitch is the full hidden-problem audit plus the Inspector, with fixes as a secondary benefit. The Goal Capsule objective narrows to the in-place fix set. "Export cleaned copy" is the next-release priority. Update pricing and landing copy to match.
- D6. The website gets an account page and a refund policy page.
  - The account page signs in with an email code, starts the Paddle checkout for that account, and links to the Paddle customer portal.
- D7. The Overview shows warning and info counts for every area, including Pro-locked areas, plus the file-size headline. Details and fixes stay gated.
- D8. Locked-state calls to action depend on license state:
  - Anonymous: "Sign in to start your 30-day free trial" opens sign-in.
  - Expired or free account: "Manage subscription" opens the website account page.
  - Trial: days remaining appear in Account, with a non-blocking notice when 3 days remain.
- D9. v1 includes a brand-profile editor (Pro). It covers allowed fonts, allowed colors, tolerance, JSON import/export, and reset to theme. It is reachable from settings and from the Fonts and Colors areas.
- D13. Gating is per feature, not per area. Free users see the font list and the media size breakdown. Inside Fonts and Media, Pro-only flags and fixes appear as an inline locked section.
- D12. Sign-in and account screens cover these states:
  - Email entry, and code sent with a resend countdown.
  - Wrong, expired, and locked code.
  - Dialog dismissed.
  - Offline-grace banner showing the date Pro lapses.
  - Trial countdown.
  - Signed-in email, sign out, and delete account.

## Pane behavior

- D10. The pane uses explicit states, with no auto-scan:
  - Not scanned: a Scan button and a one-line explanation.
  - Scanning: per-area progress with Cancel.
  - Failed: a plain-language message per error type, with Retry.
  - Empty: "No issues found", with counts of items checked.
  - On the web: "waiting for PowerPoint to save".
- D11. Fix pickers are inline in the pane. Fixes launch from a finding row or from an area's bulk action. Users can multi-select sources.
  - Font target: theme fonts, deck fonts, or a typed name, with a not-installed caveat.
  - Color target: theme swatches or a hex input.
  - The preview is a scrollable per-slide list with unreachable items grouped separately. Progress and cancel appear inline.
- D14. The findings tree has per-area grouping, with warnings first and then by count. The tree header has a severity filter and a search box.
- D15. Accessibility commitments:
  - Tree semantics with `aria-setsize`/`aria-posinset` on virtualized rows.
  - Full keyboard operation of the area picker, tree, Inspector, fix controls, and account.
  - Severity shown by icon shape as well as color.
  - Focus management after scan and fix completion.
  - A tested minimum pane width of 320 px.
- D16. The session keeps the pre-fix file bytes. The fix summary offers "Open pre-fix copy", which opens those bytes with `PowerPoint.createPresentation`.
- D17. Product success criteria use only license-API and Paddle data: sign-ups, trial starts, trial-to-paid conversion, and 90-day retention, each with a review threshold. There is no in-pane tracking.

## Security and correctness adjustments applied without a decision

These came from the review's proposed fixes and were applied as implementation details:

- Incremental snapshot hashing.
- Exact-ID-only destructive fixes.
- SSRF redirect re-validation with DNS-over-HTTPS.
- Three-way link statuses.
- Session table with revocation.
- Per-IP and global link-check caps.
- AppSource reviewer account.
- Email normalization.
- Master-text-style fonts marked unreachable.
- Untrusted deck strings rendered only as text, with a strict CSP (U10).
