#!/bin/sh
# Removes SlideCheck Helper: the login item, the certificate and its trust, and every file.
# Usage: sudo "/Library/Application Support/SlideCheck/Helper/uninstall.sh"
set -u
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo \"$0\"" >&2
  exit 1
fi
H="/Library/Application Support/SlideCheck/Helper"

for uid in $(ps -axo uid=,comm= | awk '/loginwindow$/ {print $1}' | sort -u); do
  [ "$uid" -ne 0 ] && launchctl bootout "gui/$uid/io.slidecheck.helper" 2>/dev/null
done
rm -f /Library/LaunchAgents/io.slidecheck.helper.plist

if [ -x "$H/bin/slidecheck-helper" ]; then
  "$H/bin/slidecheck-helper" uninstall-cert || echo "warning: could not remove the certificate trust; see Keychain Access > System" >&2
fi

rm -rf "$H"
rmdir "/Library/Application Support/SlideCheck" 2>/dev/null
for home in /Users/*; do
  rm -rf "$home/Library/Application Support/SlideCheck/Helper"
  rmdir "$home/Library/Application Support/SlideCheck" 2>/dev/null
done
pkgutil --forget io.slidecheck.helper >/dev/null 2>&1
echo "SlideCheck Helper removed."
