# Deploying SlideFidelity Helper with Jamf Pro (or another Mac MDM)

SlideFidelity Helper is optional. It lets the SlideFidelity PowerPoint add-in see exactly which fonts the Mac can use. See `docs/notes/helper-decisions.md` for the design decisions referenced below.

## What the package installs
- `/Library/Application Support/SlideFidelity/Helper/`: the signed helper binary (`bin/slidefidelity-helper`), `uninstall.sh`, and this Mac's localhost certificate (`leaf.pem`, `leaf.key`, `root.pem`, thumbprints).
- `/Library/LaunchAgents/com.slidefidelity.helper.plist`: starts the helper for each user at sign-in. It serves HTTPS on `localhost:47317` (falls back to 47318 or 47319).
- A certificate unique to this Mac, valid only for `localhost`, `127.0.0.1` and `::1`, trusted for SSL only. Its root cannot sign anything else: name constraints, and its key is destroyed after creation. It lasts about two years. Reinstalling renews it.

## Deploy
1. Upload `SlideFidelityHelper-<version>.pkg` (signed with Developer ID Installer and notarized) and scope a policy to install it.
2. **One user approval per Mac (H2).** macOS does not let a root process change certificate trust without a user session. When Jamf installs the package, the certificate is created but not yet trusted. At the next sign-in the helper shows one macOS prompt asking an administrator to approve it. Until then, SlideFidelity uses the show-machine font list. Interactive installs need only the installer's own prompt.
3. Optional: a managed login items payload (`com.apple.servicemanagement`), with a rule for Team ID `XM4M8R6AVA` or label `com.slidefidelity.helper`. Users then see no "Background Items Added" notice and cannot turn the helper off.

## Settings (configuration profile, domain `com.slidefidelity.helper`)
| Key | Type | Effect |
|---|---|---|
| `AutoUpdate` | Boolean | `false` stops the helper checking `https://app.slidefidelity.com/helper/latest.json`. Updates are notify-only either way (H5); with Jamf, deploy new versions as packages. |
| `Port` | Integer | Preferred port. Only 47317, 47318 or 47319 are honored, because the add-in looks only there. |

## Uninstall
Run as root: `"/Library/Application Support/SlideFidelity/Helper/uninstall.sh"`. It stops the helper for logged-in users, removes the login item and the certificate trust, and deletes every file and the package receipt.

## Verified on the dev Mac (2026-10-02, macOS, PowerPoint 16.113)
- `sudo installer -pkg …` from Terminal: installed, the certificate was trusted during install, and the helper answered on 47317 at once. The pane showed "Font missing on this computer" for an uninstalled font.
- `uninstall.sh`: no files, LaunchAgent, receipt, certificate or trust left; the port was freed.
- Not yet verified: a Developer ID Installer-signed, notarized package (identity not yet created); a Jamf push with no user session; reboot persistence; a clean macOS VM.
