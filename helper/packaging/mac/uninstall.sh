#!/bin/sh
# Removes SlideFidelity Helper: the login item, the certificate and its trust, and every file.
# Usage: sudo "/Library/Application Support/SlideFidelity/Helper/uninstall.sh"
set -u
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo \"$0\"" >&2
  exit 1
fi
H="/Library/Application Support/SlideFidelity/Helper"

for uid in $(ps -axo uid=,comm= | awk '/loginwindow$/ {print $1}' | sort -u); do
  [ "$uid" -ne 0 ] && launchctl bootout "gui/$uid/com.slidefidelity.helper" 2>/dev/null
done
rm -f /Library/LaunchAgents/com.slidefidelity.helper.plist

if [ -x "$H/bin/slidefidelity-helper" ]; then
  "$H/bin/slidefidelity-helper" uninstall-cert || echo "warning: could not remove the certificate trust; see Keychain Access > System" >&2
fi

rm -rf "$H"
rmdir "/Library/Application Support/SlideFidelity" 2>/dev/null
for home in /Users/*; do
  rm -rf "$home/Library/Application Support/SlideFidelity/Helper"
  rmdir "$home/Library/Application Support/SlideFidelity" 2>/dev/null
done
pkgutil --forget com.slidefidelity.helper >/dev/null 2>&1
echo "SlideFidelity Helper removed."
