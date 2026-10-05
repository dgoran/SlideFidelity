/* global window */
// SlideFidelity website configuration (D6 account page).
//
// PLACEHOLDERS: replace every value marked "REPLACE" before deploying. When you change API_BASE_URL,
// also update the `connect-src` entry in the Content-Security-Policy meta tag of account.html.
//
// - API_BASE_URL          Origin of the license API Worker (KTD8), no trailing slash.
// - PADDLE_ENVIRONMENT    "sandbox" while testing, "production" when live. Must match the Worker's PADDLE_ENV.
// - PADDLE_CLIENT_TOKEN   Paddle > Developer tools > Authentication > client-side token
//                         (starts with "test_" in sandbox, "live_" in production). Safe to publish.
// - PADDLE_PRICE_ID       Paddle > Catalog > the SlideFidelity Pro yearly price (starts with "pri_").
//
// SlideFidelity Helper download page (helper.html, U13). The release pipeline (U10) fills these from the
// signed release; until then the page shows "Download coming soon" instead of a broken link.
// - helper.version         Released helper version, for example "1.0.0".
// - helper.mac.url         HTTPS URL of the signed, notarized .pkg.
// - helper.mac.sha256      SHA-256 of that .pkg, 64 hex characters.
// - helper.windows.url     HTTPS URL of the signed .msi.
// - helper.windows.sha256  SHA-256 of that .msi, 64 hex characters.
// The minimum OS strings are product decisions, not release values; change them only with the installers.
window.SLIDEFIDELITY_CONFIG = Object.freeze({
  API_BASE_URL: "https://api.slidefidelity.com",
  PADDLE_ENVIRONMENT: "production",
  PADDLE_CLIENT_TOKEN: "live_48d996f5026faf92da8c47312e1",
  PADDLE_PRICE_ID: "pri_01m46m1ye39sje220r46fthmxs",
  helper: Object.freeze({
    version: "0.1.0",
    mac: Object.freeze({
      url: "REPLACE_WITH_HELPER_MAC_PKG_URL",
      sha256: "REPLACE_WITH_HELPER_MAC_PKG_SHA256",
      minimumOs: "macOS 12 Monterey or later, Apple silicon or Intel",
    }),
    windows: Object.freeze({
      url: "https://slidefidelity.com/downloads/SlideFidelityHelper-0.1.0.msi",
      sha256: "CA40EDE7FE765A93DFEF692688C9CA3A08D15723E828CEA4B1DD9378AFF3E8FB",
      minimumOs: "Windows 10 or later, 64-bit (x64)",
    }),
  }),
});
