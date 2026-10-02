# U2 Windows spike

Uses the same spike binary as the Mac (`helper/spikes/mac`); it is cross-platform. Run on the Windows PC, in this order.

1. Install Rust from https://rustup.rs (accept the Visual Studio Build Tools prompt). Clone or copy this repo.
2. Build: `cd helper\spikes\mac` then `cargo build --release`.
3. Generate certificates: `target\release\slidecheck-helper-spike-mac.exe gen out\c824 constrained 824`
4. Trust the root machine-wide, from an **elevated** PowerShell:
   `certutil -addstore Root out\c824\root.pem` (this is `LocalMachine\Root`)
5. Serve: `target\release\slidecheck-helper-spike-mac.exe serve out\c824 47317`. Note any Windows Firewall prompt.
6. Fonts: `target\release\slidecheck-helper-spike-mac.exe fonts > out\fonts-spike.txt`, then
   `powershell -ExecutionPolicy Bypass -File ..\..\..\tools\list-fonts-windows.ps1 > out\fonts-script.txt`.
7. Sideload the dev add-in (`npm install`, then `npm run start --workspace @slidecheck/addin`). Open the SlideCheck pane:
   the "Helper connection (dev spike)" box should read `health: ok 200` and `fonts: ok 200, N fonts`.
8. Optional, for the record: remove the root (`certutil -delstore Root "SlideCheck Helper Local Root (this computer only)"`), add it to the
   current user's store instead (`certutil -user -addstore Root out\c824\root.pem`, non-elevated) and retry the pane.

Send back: the pane result for each store, whether the firewall prompted, both font files, and the PowerPoint version (File > Account).
