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
