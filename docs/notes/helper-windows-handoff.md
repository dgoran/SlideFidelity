# SlideCheck Helper: Windows handoff (2026-10-02)

This is for the Claude Code session on the Windows PC. The Mac session built and verified everything that could be done on macOS. The remaining helper work is Windows-only and needs this PC.

## Read first
1. `docs/plans/2026-10-01-2113-feat-slidecheck-helper-plan.md`: the plan. Read the Goal Capsule, the KTDs, and units **U2** and **U9**, plus U4 and U6 for the Windows parts.
2. `docs/notes/helper-decisions.md`: **H1–H7 override the plan.** In short:
   - The certificate lasts 825 days or less.
   - Windows updates are notify-only.
   - The leaf can never sign other certificates.
   - Font names are read from the font files themselves.
   - Reviews happen on the show machine.
3. `docs/notes/office-js-platform-behavior.md`: the Mac spike and end-to-end results, for comparison.
4. `helper/spikes/windows/README.md`: the U2 spike steps.

## State at handoff (branch `feat/slidecheck-addin`)
- **Helper crate (`helper/`):** done and tested on macOS (75 tests): CLI, font inventory (U4), certificates (U6), notify-only update check (U7), HTTPS server with origin/host guards (U5). The Mac package (U8) installs and uninstalls cleanly.
- **Add-in:** detects the helper, shows the offer and status, and passes `localFonts` to scans (U12). The audit engine has the `font-missing-here` finding (U11). The production CSP allows `https://localhost:47317-47319`.
- **Windows code written but never compiled or run on Windows:**
  - `src/cert.rs` `mod win`: `LocalMachine\Root` through the CryptoAPI (`CertAddEncodedCertificateToStore`, then `CERT_ENHKEY_USAGE_PROP_ID` = serverAuth only, then find/delete by SHA-1). This was just committed and has never been built.
  - `src/fonts/windows.rs`: walks `%WINDIR%\Fonts` and `%LOCALAPPDATA%\Microsoft\Windows\Fonts`. `src/fonts/office.rs` adds the Office private folders (`%ProgramFiles%` and `%ProgramFiles(x86)%` `...\Microsoft Office\root\vfs\Fonts\private`) and `%LOCALAPPDATA%\Microsoft\FontCache\4\CloudFonts`.
  - `src/paths.rs`: state is `%ProgramData%\SlideCheck\Helper`; runtime (logs, port) is `%LOCALAPPDATA%\SlideCheck\Helper`.

## Do on the PC, in order
0. **Tools:** Git, Node 20+ with npm, Rust via rustup (MSVC toolchain and the VS Build Tools C++ workload; `ring` needs a C compiler), and WiX (`dotnet tool install --global wix`, plus `wix extension add -g WixToolset.Util.wixext`). Run `npm install` at the repo root. pnpm is not used, and `.npmrc` sets legacy-peer-deps.
1. **Build and test:** `cd helper` then `cargo build`, `cargo test`, `cargo clippy --all-targets -- -D warnings`. Fix any Windows compile errors, especially in `cert.rs` `mod win`, `fonts/windows.rs` and `config.rs`.
2. **U2 spike** (gate for U9): follow `helper/spikes/windows/README.md`. The real helper can replace the spike binary. From an elevated prompt:
   - `set SLIDECHECK_HELPER_STATE_DIR=%TEMP%\sc-state`
   - `target\debug\slidecheck-helper install-cert` (this exercises the CryptoAPI store)
   - then, unelevated, with the same env var, `target\debug\slidecheck-helper serve`.
   - Sideload the dev add-in (`npm run start --workspace @slidecheck/addin`) and open the SlideCheck pane. The Fonts row should say "Exact font check: on (SlideCheck Helper v0.1.0)".
   - Record the results in `office-js-platform-behavior.md` under a "Helper plan U2 gate" heading: WebView2 result per trust store, firewall prompt, font parity against `tools/list-fonts-windows.ps1`, and the PowerPoint version.
   - **Stop and ask the user** if WebView2 cannot reach the helper (a goal-capsule stop condition).
3. **Finish the Windows code:**
   - `config.rs` `mod platform` for Windows: read `HKLM\Software\SlideCheck\Helper` DWORDs `AutoUpdate` and `Port` with `RegGetValueW` (windows-sys `Win32_System_Registry`, already enabled).
   - `install-cert` on Windows: before writing, lock the state dir so users cannot pre-create or replace the key, using well-known SIDs: `icacls <dir> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX` and `/setowner *S-1-5-32-544`.
   - Add a `#[cfg(windows)] #[ignore]` integration test in `tests/cert.rs` for a real `LocalMachine\Root` round trip in an elevated shell, and run it once.
   - Run `cargo test --test fonts -- --ignored` style parity against the PowerShell script, and record any missing families.
4. **U9 MSI** (`helper/packaging/windows/`: `helper.wxs`, `build.ps1`, `README-intune.md`), WiX v5, per-machine, x64:
   - Install the exe to `ProgramFiles64Folder\SlideCheck Helper\`. `MajorUpgrade`. Use a fixed `UpgradeCode`: generate one GUID once and never change it.
   - `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` value "SlideCheck Helper" = `"[#HelperExe]" serve`.
   - Custom actions:
     - Stop running helpers before files change: deferred, `Impersonate="no"`, `WixQuietExec64`, `taskkill /F /IM slidecheck-helper.exe`, return ignore.
     - `install-cert`: deferred, `Impersonate="no"`, after InstallFiles, when `NOT REMOVE="ALL"`.
     - `uninstall-cert`: deferred, `Impersonate="no"`, before RemoveFiles, when `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`, so upgrades keep the certificate.
     - Start the helper as the interactive user: an immediate, impersonated action after InstallFinalize, `Return="asyncNoWait"`, only when the UI is shown (`UILevel > 3`). Silent Intune installs (SYSTEM) start it at the next sign-in. Never start it from an elevated or SYSTEM context: it would read the wrong user's fonts.
   - `build.ps1`: `cargo build --release` (add `--features dev-origin` for a `-Dev` test MSI), `wix build`, then sign with Azure Artifact Signing when configured, otherwise build unsigned with a warning.
   - Smoke test on the PC:
     - `msiexec /i … ` shows exactly one UAC prompt;
     - the root appears in certlm.msc > Trusted Root, with "Intended purposes: Server Authentication";
     - the pane connects within 10 s;
     - it survives sign-out and sign-in;
     - `msiexec /x` leaves no files, Run value or root.
   - `README-intune.md`: silent install `msiexec /i SlideCheckHelper.msi /qn`, `AutoUpdate=0` registry policy, uninstall, and that the helper starts at the next sign-in.
5. **Commit** in small conventional commits on `feat/slidecheck-addin`, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push when the user asks.

## Ground rules
- The user runs anything that needs their password or approval, such as elevated prompts and certificate trust, unless they tell you otherwise. Never enter credentials.
- Do not publish, release, or change production services.
- Keep the add-in working with no helper present. The existing test suites must stay green: helper 75, audit-core 341, add-in 625.
- Still owned by the user: the Developer ID Installer certificate, Azure Artifact Signing, the production minisign key, and a public host for installers. The release pipeline (U10) waits on these.
