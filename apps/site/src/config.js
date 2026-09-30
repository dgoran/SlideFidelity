/* global window */
// SlideCheck website configuration (D6 account page).
//
// PLACEHOLDERS: replace every value marked "REPLACE" before deploying. When you change API_BASE_URL,
// also update the `connect-src` entry in the Content-Security-Policy meta tag of account.html.
//
// - API_BASE_URL          Origin of the license API Worker (KTD8), no trailing slash.
// - PADDLE_ENVIRONMENT    "sandbox" while testing, "production" when live. Must match the Worker's PADDLE_ENV.
// - PADDLE_CLIENT_TOKEN   Paddle > Developer tools > Authentication > client-side token
//                         (starts with "test_" in sandbox, "live_" in production). Safe to publish.
// - PADDLE_PRICE_ID       Paddle > Catalog > the SlideCheck Pro yearly price (starts with "pri_").
window.SLIDECHECK_CONFIG = Object.freeze({
  API_BASE_URL: "https://api.slidecheck.io",
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_CLIENT_TOKEN: "REPLACE_WITH_PADDLE_CLIENT_TOKEN",
  PADDLE_PRICE_ID: "REPLACE_WITH_PADDLE_PRICE_ID",
});
