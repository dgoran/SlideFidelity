Update-check fixtures (U7). TEST ONLY.

`TEST-ONLY.key` / `TEST-ONLY.pub` and `TEST-ONLY-other.*` are password-less minisign key pairs made
for these tests. They are not the production feed key and must never sign a real feed.
Re-sign after editing a feed: `scripts/sign-feed.sh tests/fixtures/update/TEST-ONLY.key tests/fixtures/update/*.json`
