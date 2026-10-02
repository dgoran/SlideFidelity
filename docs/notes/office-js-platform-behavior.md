# Office.js platform behavior (U2 spike)

Status: **Pending host verification.** This note was written before anyone ran it on a real host. Code in `apps/addin/src/office/` encodes the assumptions below. Fill in each cell after running on a real host. If an answer changes an assumption, update `ids.ts` or `snapshot.ts` to match.

Record for each answer: host build (for example "PowerPoint for Mac 16.9x, M365 Current Channel"), date, deck used, and how it was observed.

## Hosts in scope

| Host | Build tested | Tester | Date |
|---|---|---|---|
| Mac (M365) | | | |
| Windows (M365) | | | |
| Web (PowerPoint on the web) | | | |

## Questions

### Q1. Does `getFileAsync(Compressed)` include unsaved edits?

- Why it matters: If it doesn't, the audit reports stale results (KTD2). This is a Goal Capsule stop condition: stop if `getFileAsync` does not reflect the live document and there is no workaround.
- Plan assumption: yes on Mac and Windows. On the web it may return the last autosaved state.
- How to test: Open a saved deck and add a text box without saving. Run `readSnapshot()`, unzip the bytes, and check that the new `p:sp` is in the slide XML. On the web, repeat with autosave on and off, and check again after waiting about 30 s.
- What the docs say: `Document.getFileAsync` is documented as getting "the entire document file". The docs don't say whether this is in-memory or saved state.

| Host | Answer | Status |
|---|---|---|
| Mac | | Pending host verification |
| Windows | | Pending host verification |
| Web | | Pending host verification |

### Q2. Live `Slide.id` / `Shape.id` format vs. OOXML `p:sldId/@id` and `p:cNvPr/@id`

- Why it matters: Findings are joined to live objects by ID (KTD5).
- What the docs say: `PowerPoint.Slide.id` and `PowerPoint.Shape.id` are both typed as `string` and described as unique IDs. The docs don't give the format or say whether it relates to OOXML. **Treat the format as unverified.**
- Assumption encoded in `ids.ts`:
  - Slide: the ID starts with the `p:sldId/@id` integer, optionally followed by `#` and a suffix. For example, `"256#"` or `"256#3241234"`. `parseLiveSlideId` uses the leading integer.
  - Shape: the ID is the `p:cNvPr/@id` integer as a decimal string. `parseLiveShapeId` accepts only whole digits.
  - Fallback: if the ID format assumption fails, slides fall back to the same position (only when the live ID can't be parsed). Shapes fall back to the same name with `left`/`top` within 1 pt. Both fallbacks report `method: "fallback"`. Destructive fixes refuse fallback matches (`isSafeForDestructiveFix`).
- How to test: Log `slide.id` and `shape.id` for every slide and shape in a fixture deck. Compare them with `ppt/presentation.xml` `p:sldIdLst` and each slide's `p:cNvPr/@id`. Check group children, placeholders, tables, and duplicated slides. Also check whether IDs stay the same after save and reopen.

| Host | Observed `Slide.id` sample | Observed `Shape.id` sample | Matches OOXML? | Status |
|---|---|---|---|---|
| Mac | | | | Pending host verification |
| Windows | | | | Pending host verification |
| Web | | | | Pending host verification |

### Q3. Hyperlink identity

- Why it matters: Link checks (U9) and hyperlink edit/remove fixes (KTD4) need to find the live hyperlink that matches a finding.
- Assumption encoded in `ids.ts`: hyperlinks have no stable ID. The join key is (slide ID, address, occurrence order of that address within the slide). `matchHyperlink` returns `ambiguous` when the number of live links with that address differs from the snapshot count. It returns `not-found` when the address is gone.
- How to test: Build a slide with the same URL linked twice and a different URL linked once. Compare the order of `slide.hyperlinks` (PowerPointApi 1.6) with the document order of `a:hlinkClick` in the slide XML. Check whether any live hyperlink ID or `screenTip` survives edits.

| Host | Live order matches OOXML order? | Any stable live ID? | Status |
|---|---|---|---|
| Mac | | | Pending host verification |
| Windows | | | Pending host verification |
| Web | | | Pending host verification |

### Q4. `getFileAsync` read time for a 50 MB deck

- Why it matters: Scans have a 10 s budget. **Stop condition:** if reading the file alone leaves no practical room in that budget for parsing and checks (say more than about 6 s), stop and escalate. Don't try to work around it.
- How to test: Use a roughly 50 MB fixture deck (mostly images/media). Time `readSnapshot()` from the call to resolve, 5 runs each on a cold and a warm file. Record slice count and median.

| Host | Deck size | Slices | Median read (ms) | Within budget? | Status |
|---|---|---|---|---|---|
| Mac | | | | | Pending host verification |
| Windows | | | | | Pending host verification |
| Web | | | | | Pending host verification |

### Q5. Does setting `TextRange.font.name` also change East Asian (`a:ea`) and complex-script (`a:cs`) fonts?

- Why it matters: The replace-fonts fix (U13) may leave `ea`/`cs` fonts unchanged. If so, the audit keeps flagging the old font after the fix.
- What the docs say: `ShapeFont.name` is described as the font name. The docs don't say how it treats the `latin`/`ea`/`cs` script slots.
- How to test: Take a run with different `a:latin`, `a:ea`, and `a:cs` fonts. Set `font.name`, then read a new snapshot and inspect `a:rPr`.

| Host | latin changed | ea changed | cs changed | Status |
|---|---|---|---|---|
| Mac | | | | Pending host verification |
| Windows | | | | Pending host verification |
| Web | | | | Pending host verification |

### Q6. Do API edits join the host undo stack?

- Why it matters: This decides whether "Undo" in the fix UI can rely on Ctrl/Cmd+Z, or whether SlideCheck needs its own reversal.
- How to test: Run a fix that changes a font and deletes a shape in one `PowerPoint.run`. Press Ctrl/Cmd+Z once and then again. Record what comes back and how many steps it takes.

| Host | Undoable? | Steps per `PowerPoint.run` | Status |
|---|---|---|---|
| Mac | | | Pending host verification |
| Windows | | | Pending host verification |
| Web | | | Pending host verification |

### Q7. Can PowerPointApi 1.10 write a theme-color reference (not just a literal RGB)?

- Why it matters: "Snap to brand/theme color" fixes should write `a:schemeClr`, not a hard-coded `a:srgbClr`. If the API can only write literals, those fixes turn theme colors into hard-coded colors, which is what the audit flags.
- How to test: Use the 1.10 color APIs to set a fill or font color to a theme color, if an API exists. Then read a new snapshot and check for `a:schemeClr`.

| Host | Theme ref writable? | API used | Status |
|---|---|---|---|
| Mac | | | Pending host verification |
| Windows | | | Pending host verification |
| Web | | | Pending host verification |

## Snapshot reader facts (from docs, used in `snapshot.ts`)

- `getFileAsync` slices can be up to 4194304 bytes (4 MB) on non-iPad hosts. The reader requests exactly that size.
- Only two files can be open in memory at once, or `getFileAsync` fails. The reader therefore always calls `closeAsync`, including on error.
- The reader fetches slices one at a time and feeds each one into an incremental SHA-256 (`@noble/hashes`). The hash of the full file is the scan-freshness key (KTD6).

## Observed on real hosts

### PowerPoint for Mac 16.113 (2026-10-01, dev build sideloaded from https://localhost:3000)

- The add-in loads from the XML manifest, and the ribbon button **Check Deck** appears on the Home tab. The production-shaped CSP did not block office.js; the development CSP adds localhost.
- **Q1, partly answered:** `getFileAsync(Compressed)` returned the file for a new, never-saved presentation ("Presentation1", 95 KB), and the full scan completed with the result "Ready for show". This test did not check whether *unsaved edits to a saved file* are included.
- Still pending: Q2 (live id formats, through Show in PowerPoint on a real deck), Q3 (hyperlink identity), Q4 (read time on a 50 MB deck), Q5 (whether `font.name` changes ea/cs fonts), Q6 (undo stack), Q7 (theme reference writes).

### Font probe experiment: PowerPoint for Mac 16.113 (2026-10-01)

A canvas text-width probe ran in the task pane web view. A family counts as detected when its width differs from at least one of the monospace, serif and sans-serif fallbacks. The experiment code is in commit c99a244 and was removed afterwards.

| Family | Where it lives on this Mac | Probe result |
|---|---|---|
| Arial, Helvetica Neue | built into macOS | detected |
| Gotham, Montserrat, Segoe UI, Calibri | installed by the user (~/Library/Fonts) | not detected |
| Aptos, Cambria, Candara | inside Office only (PowerPoint.app DFonts) | not detected |
| a made-up name | nowhere | not detected |

**Conclusion:** PowerPoint's WKWebView exposes only fonts that ship with macOS. WebKit hides user-installed fonts from web content as fingerprinting protection, and Office's own fonts are invisible to it. The probe cannot tell whether PowerPoint has a font, so it is not used. Missing-font detection relies on the show-machine fonts list, generated by `tools/list-fonts-mac.py` or `tools/list-fonts-windows.ps1`.

Windows (WebView2/Edge) normally exposes user-installed fonts, but not Office's private fonts. It is untested there.

### Local helper connection spike: PowerPoint for Mac 16.113 (2026-10-01)

A stand-in "SlideCheck Helper" (Node) served the installed font list on two loopback endpoints. The task pane, a development build served from https://localhost:3000 with a CSP that allowed both endpoints, fetched each one. The code is in commit 73da3ed and was removed afterwards.

| Endpoint | Result in the pane | Helper log |
|---|---|---|
| http://127.0.0.1:7317/fonts | `TypeError: Load failed` | no request arrived: WebKit blocked it before the network |
| https://localhost:7318/fonts (certificate trusted in the login keychain) | 200, 484 fonts | request arrived with `Origin: https://localhost:3000`, no Private Network Access preflight |

**Conclusion:** on Mac, a helper must serve **HTTPS on localhost with a certificate that macOS trusts**. Plain HTTP to the loopback address is blocked as mixed content. Windows (WebView2) and Office on the web (Chrome Local Network Access prompt and iframe permission delegation) are untested.

### Helper plan U1 gate: Mac trust and font access, PowerPoint for Mac 16.113 (2026-10-01)

The spike is the Rust binary in `helper/spikes/mac/` (rcgen 0.14, axum-server with rustls/ring, ttf-parser). It served `/v1/health` and `/v1/fonts` on https://localhost:47317 as a per-user LaunchAgent. The pane used the dev-only probe in `HelperProbeDiagnostics.tsx`.

**Certificate design.** A per-machine root with critical `NameConstraints` (permitted: DNS `localhost`, IP `127.0.0.1/32`, IP `::1/128`) and `pathlen:0` signed one leaf. The leaf has SANs `localhost`, `127.0.0.1` and `::1`, critical `CA:FALSE`, key usage `digitalSignature` only, and EKU `serverAuth`. The CA key was never written to disk. The root was trusted in the System keychain with `-p ssl`.

| Check | Result |
|---|---|
| Name-constrained root accepted by macOS trust evaluation | yes, the constraints raise no error; the KTD2 fallback is not needed |
| Leaf valid for 826 days (825 + 1-day backdate), and 3650 days | **rejected**: "Certificate exceeds maximum temporal validity period", even with the root trusted |
| Leaf valid for 825 days in total (824 + 1-day backdate), and 398 days | accepted |
| `nscurl` (NSURLSession) to https://localhost:47317 with the 825-day chain trusted | 200 |
| SlideCheck pane in PowerPoint, origin https://localhost:3000 | health 200; fonts 200, 991 families; no preflight |
| Trust step run as root from a LaunchDaemon, no user session (Jamf stand-in) | **fails**: `SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.` exit 1. The certificate is added to the keychain but not trusted |
| Trust step run with `sudo` in Terminal (logged-in admin) | succeeds with only the sudo password, no extra dialog |
| Office and user font folders read from the LaunchAgent (DFonts, Office FontCache, ~/Library/Fonts, /Library/Fonts) | 991 families, 0 read errors, no privacy prompt; identical to the list read from Terminal |

**Conclusions:**
- The constrained-root design works. The leaf must be valid for **825 days or less in total**: macOS applies the 825-day limit to certificates under admin-trusted roots too. A 10-year leaf is never accepted. The certificate therefore needs renewal about every two years.
- **A silent MDM install cannot trust a certificate generated on the machine.** On macOS 11 and later, changing admin trust settings needs user interaction even as root. The Jamf path needs another design (a decision is pending). An interactive install trusts it with the installer's own authorization; the pkg postinstall case still has to be confirmed with a real pkg in U8.
- Font access from a background login item needs no Full Disk Access and raises no prompt.
- Not tested here: a pane served from a public origin. WKWebView has no Local Network Access check; that question belongs to the Windows spike (U2).
