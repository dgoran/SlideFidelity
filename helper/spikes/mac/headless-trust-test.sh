#!/bin/sh
# U1 spike: run the trust step the way Jamf does - as root from launchd, with no user session.
# Usage: sudo sh headless-trust-test.sh <root.pem>
set -eu
PEM="$1"; W=/private/tmp/sc-spike; L=io.slidecheck.spike.trusttest
mkdir -p "$W"; cp "$PEM" "$W/root.pem"; rm -f "$W/trust.log"
cat > /Library/LaunchDaemons/$L.plist <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$L</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>/usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain $W/root.pem; echo "exit=\$?"</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$W/trust.log</string>
  <key>StandardErrorPath</key><string>$W/trust.log</string>
</dict></plist>
P
launchctl bootstrap system /Library/LaunchDaemons/$L.plist
sleep 5
launchctl bootout system/$L 2>/dev/null || true
rm -f /Library/LaunchDaemons/$L.plist
echo "--- result ---"; cat "$W/trust.log"
