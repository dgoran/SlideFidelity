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

## Graphics Ops addendum (2026-10-01)

The primary user is Graphics Ops reviewing one deck at a time before a show. The add-in leads with show-breaking problems; brand checks stay as they are.

- G1. A **Problems** view opens first after a scan. It has five categories: videos and audio, fonts, off-slide objects, text touching objects, and media and image size. It shows an overall "Ready for show" or "N problems to fix" headline. The headline and counts are free; details and fixes follow the existing gates (D7, D13).
- G2. **Video and audio playback** checks report: missing media, media linked outside the deck, online media, formats that may not play everywhere (MP4 with H.264 and AAC is the safe target), and missing poster frames.
- G3. **Fonts that may be missing:**
  - A font counts as safe when it is embedded, ships with Microsoft 365 on both Mac and Windows, or is on the team's "show machine fonts" list (`AuditOptions.availableFonts`).
  - Platform-only fonts get a platform note.
  - "Replace missing fonts" reuses the replace-font fix (D2 applies).
- G4. **Partly off-slide objects** are reported beyond a tolerance of 0.05 in. Cut-off text, tables, charts, and video are warnings. Pictures and plain shapes that bleed off the edge are notes.
- G5. **Text touching other objects** (overlap, or a gap under 2 pt) is a heuristic based on shape bounds.
  - Text that sits fully inside a filled object, and rotated shapes, are notes.
  - Backgrounds covering 95% or more of the slide are ignored.
  - There is no dismiss action yet. Add one if real decks prove noisy.
- G6. A linked video is reported both as `linked-file` (Links) and `media-linked` (Media). Problems shows it once, under Videos.
- G7. **Optional native SlideCheck Helper for exact font checks** (2026-10-01). On PowerPoint desktop for Mac and Windows, an optional, free helper app reports the fonts installed on this computer, so "Missing on this computer" is exact. Without it, and on the web, iPad, and phones, the show-machine font list (G3) is used as before. The helper reads only font names, answers only the add-in over loopback, and sends nothing off the computer except its update check. Disclosure: `apps/site/src/helper.html`, the privacy page, and the AppSource checklist. Decisions: `docs/notes/helper-decisions.md` (H1–H7); plan: `docs/plans/2026-10-01-2113-feat-slidecheck-helper-plan.md`.
