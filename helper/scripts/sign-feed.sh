#!/bin/sh
# Sign a helper update feed (latest.json) with minisign, producing latest.json.minisig next to it.
# Dev/test use: scripts/sign-feed.sh tests/fixtures/update/TEST-ONLY.key tests/fixtures/update/newer.json
# Production signing happens in CI with the production secret key (U0/U10); never commit that key.
set -eu
if [ "$#" -lt 2 ]; then
  echo "usage: $0 <secret-key> <feed.json>..." >&2
  exit 2
fi
key="$1"; shift
for feed in "$@"; do
  minisign -S -s "$key" -m "$feed" -x "$feed.minisig" -t "slidefidelity helper feed $(basename "$feed")"
done
