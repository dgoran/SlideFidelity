#!/bin/sh
# Builds the macOS installer for SlideFidelity Helper.
#
#   packaging/mac/build.sh            release package: signed and notarized when the identities exist
#   packaging/mac/build.sh --dev      local test package: accepts the dev add-in origin, never notarized
#
# Signing identities (from `security find-identity -v`): "Developer ID Application: …" for the
# binary and "Developer ID Installer: …" for the package. Notarization uses the keychain profile
# named in NOTARY_PROFILE (default "notary"). Missing identities produce an unsigned package and a warning.
set -eu
export COPYFILE_DISABLE=1
cd "$(dirname "$0")/../.."
DEV=0; [ "${1:-}" = "--dev" ] && DEV=1
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
OUT=target/package/mac; STAGE=$OUT/root; H="$STAGE/Library/Application Support/SlideFidelity/Helper"
rm -rf "$OUT"; mkdir -p "$H/bin"
FEATURES=""; [ $DEV -eq 1 ] && FEATURES="--features dev-origin"

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --target "$t" $FEATURES
done
lipo -create -output "$H/bin/slidefidelity-helper" \
  target/aarch64-apple-darwin/release/slidefidelity-helper target/x86_64-apple-darwin/release/slidefidelity-helper

APP_ID=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
INST_ID=$(security find-identity -v -p basic | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)
if [ -n "$APP_ID" ]; then
  codesign --force --options runtime --timestamp --identifier com.slidefidelity.helper --sign "$APP_ID" "$H/bin/slidefidelity-helper"
else
  echo "warning: no Developer ID Application identity; binary is unsigned" >&2
fi

cp packaging/mac/com.slidefidelity.helper.plist "$H/"
cp packaging/mac/uninstall.sh "$H/"
chmod 755 "$H/uninstall.sh"

xattr -cr "$STAGE"
COPYFILE_DISABLE=1 pkgbuild --root "$STAGE" --scripts packaging/mac/scripts --identifier com.slidefidelity.helper \
  --version "$VERSION" --install-location / "$OUT/helper-component.pkg"
sed "s/__VERSION__/$VERSION/" packaging/mac/distribution.xml > "$OUT/distribution.xml"

SUFFIX=""; [ $DEV -eq 1 ] && SUFFIX="-dev"
PKG="$OUT/SlideFidelityHelper-$VERSION$SUFFIX.pkg"
if [ -n "$INST_ID" ]; then
  productbuild --distribution "$OUT/distribution.xml" --resources packaging/mac/resources \
    --package-path "$OUT" --sign "$INST_ID" --timestamp "$PKG"
else
  echo "warning: no Developer ID Installer identity; package is unsigned (local testing only)" >&2
  productbuild --distribution "$OUT/distribution.xml" --resources packaging/mac/resources --package-path "$OUT" "$PKG"
fi

if [ $DEV -eq 0 ] && [ -n "$INST_ID" ]; then
  xcrun notarytool submit "$PKG" --keychain-profile "${NOTARY_PROFILE:-notary}" --wait
  xcrun stapler staple "$PKG"
  spctl -a -vv -t install "$PKG"
fi
shasum -a 256 "$PKG"
echo "built $PKG"
