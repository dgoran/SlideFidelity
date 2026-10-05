/* global window, document, navigator, URLSearchParams */
// SlideFidelity Helper download page (U13). Picks the platform from ?platform=mac|windows, else the user agent,
// and fills the download block from config.js (filled by the release pipeline, U10). Unfilled placeholders show
// "Download coming soon" instead of a link. Phones and tablets never get a download link (AppSource policy 1120.2).
// All values are written with textContent or as validated https URLs. No inline scripts (CSP).
(function () {
  "use strict";

  var PLATFORMS = ["mac", "windows"];
  var config = window.SLIDEFIDELITY_CONFIG || {};
  var helper = config.helper || {};

  function $(id) {
    return document.getElementById(id);
  }

  function isPlaceholder(value) {
    return typeof value !== "string" || value === "" || value.indexOf("REPLACE") === 0;
  }

  function isHttpsUrl(value) {
    return !isPlaceholder(value) && /^https:\/\/[^\s"'<>]+$/.test(value);
  }

  function isSha256(value) {
    return !isPlaceholder(value) && /^[0-9a-fA-F]{64}$/.test(value);
  }

  // iPadOS Safari reports a Mac user agent; touch support tells them apart.
  function isMobile() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua)) return true;
    return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  }

  function platformFromQuery() {
    try {
      var value = new URLSearchParams(window.location.search).get("platform");
      return PLATFORMS.indexOf(value) >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  function platformFromUserAgent() {
    var ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
    return null;
  }

  function fill(platform) {
    var entry = helper[platform] || {};
    var version = isPlaceholder(helper.version) ? null : helper.version;
    var ready = version !== null && isHttpsUrl(entry.url) && isSha256(entry.sha256);

    if (typeof entry.minimumOs === "string") $(platform + "-requires").textContent = entry.minimumOs;
    if (!ready) return;

    var link = $(platform + "-link");
    link.href = entry.url;
    link.textContent = (platform === "mac" ? "Download for Mac" : "Download for Windows") + " (version " + version + ")";
    link.hidden = false;
    $(platform + "-soon").hidden = true;
    $(platform + "-version").textContent = version;
    $(platform + "-sha256").textContent = entry.sha256.toLowerCase();
  }

  function init() {
    if (isMobile()) {
      $("mobile-notice").hidden = false;
      return;
    }

    PLATFORMS.forEach(fill);

    var platform = platformFromQuery() || platformFromUserAgent();
    if (platform) {
      $("download-" + platform).hidden = false;
      return;
    }
    // Unknown desktop (for example Linux): show both, without the cross-links.
    PLATFORMS.forEach(function (p) {
      $("download-" + p).hidden = false;
      $(p + "-other").hidden = true;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
