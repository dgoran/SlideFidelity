#!/bin/sh
# Removes every spike root from the System keychain. Usage: sudo sh cleanup-trust.sh
for h in $(security find-certificate -a -c "SlideCheck Helper" -Z /Library/Keychains/System.keychain | awk '/SHA-1/{print $3}'); do
  security delete-certificate -Z "$h" /Library/Keychains/System.keychain && echo "removed $h"
done
