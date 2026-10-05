# Deploying SlideFidelity Helper with Microsoft Intune (or another Windows MDM)

SlideFidelity Helper is optional. It lets the SlideFidelity PowerPoint add-in see exactly which fonts the PC can use. See `docs/notes/helper-decisions.md` for the design decisions referenced below.

## What the MSI installs
- `C:\Program Files\SlideFidelity Helper\slidefidelity-helper.exe`: the signed helper.
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`, value `SlideFidelity Helper` = `"C:\Program Files\SlideFidelity Helper\slidefidelity-helper.exe" serve`. This starts the helper for each user at sign-in, unelevated. It serves HTTPS on `localhost:47317` (falls back to 47318 or 47319), on loopback only, so Windows Firewall does not prompt.
- `C:\ProgramData\SlideFidelity\Helper\`: this PC's localhost certificate (`leaf.pem`, `leaf.key`, `root.pem`, thumbprints). Only SYSTEM and Administrators can change it; users can read it.
- A root certificate unique to this PC in **Local Computer > Trusted Root Certification Authorities**, named "SlideFidelity Helper Local Root … (this computer only)", with Intended Purposes limited to **Server Authentication**. It is valid only for `localhost`, `127.0.0.1` and `::1` (name constraints) and cannot sign anything else; its private key is destroyed after creation. The certificate lasts about two years. Reinstalling or upgrading renews it when fewer than 90 days remain.
- Per user, written by the helper itself: `%LOCALAPPDATA%\SlideFidelity\Helper\` (logs and the chosen port).

## Deploy
1. Add a **Windows app (line-of-business app)** and upload `SlideFidelityHelper-<version>.msi`, signed through Azure Artifact Signing. Intune reads the product code and installs it in the device context: `msiexec /i SlideFidelityHelper-<version>.msi /qn`.
2. Assign it as Required to a device group. Detection: the MSI product code. Intune fills this in for MSI line-of-business apps.
3. A silent install (SYSTEM) does not start the helper for users who are already signed in. It starts at each user's next sign-in. An interactive install (double-click, one UAC prompt) starts it for the installing user at once.
4. No user approval is needed: the installer trusts the certificate machine-wide as SYSTEM (unlike macOS, see H2).

## Settings (registry policy, `HKLM\Software\SlideFidelity\Helper`)
Deploy these with a Settings catalog / custom OMA-URI, a PowerShell script or Group Policy Preferences. The helper reads them at start.

| Value | Type | Effect |
|---|---|---|
| `AutoUpdate` | DWORD | `0` stops the helper checking `https://app.slidefidelity.com/helper/latest.json`. Updates are notify-only either way (H3, H5); with Intune, deploy new versions as a new app version (supersedence) and set `AutoUpdate=0`. |
| `Port` | DWORD | Preferred port. Only 47317, 47318 or 47319 are honored, because the add-in looks only there. |

```bat
reg add "HKLM\Software\SlideFidelity\Helper" /v AutoUpdate /t REG_DWORD /d 0 /f
```

## Upgrade
Install the newer MSI over the old one (Intune supersedence, or `msiexec /i … /qn`). It is a major upgrade: running helpers are stopped, the files are replaced and the certificate is kept (renewed only when it is close to expiry). Users get the new helper at their next sign-in. Downgrades are refused.

## Uninstall
Intune: assign the app as Uninstall. By hand: `msiexec /x SlideFidelityHelper-<version>.msi /qn` (or by product code). Running helpers are stopped, then the root is removed from Trusted Root Certification Authorities and the program files, Run entry and `C:\ProgramData\SlideFidelity` are deleted. Per-user logs in `%LOCALAPPDATA%\SlideFidelity\Helper` stay behind.

## Verified on the dev PC
See "Helper plan U2 gate" and "Helper plan U9 smoke test" in `docs/notes/office-js-platform-behavior.md`: interactive install, repair, uninstall and reboot verified with an unsigned dev MSI. The release MSI and helper exe sign through Azure Artifact Signing (publisher "Open IT Systems, LLC", `signtool verify /pa` clean, 2026-10-03). Not yet verified: SmartScreen on a fresh download, a silent `/qn` install as SYSTEM, and an Intune push to a managed device.
