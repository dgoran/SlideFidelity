/* global window, document, sessionStorage, fetch, setInterval, clearInterval, setTimeout, clearTimeout, URL */
// SlideCheck account page (D6): email-code sign-in, plan display, Paddle checkout, customer portal.
// Every string from the API or the user is rendered with textContent only. No inline scripts (CSP).
(function () {
  "use strict";

  var config = window.SLIDECHECK_CONFIG || {};
  var API = String(config.API_BASE_URL || "").replace(/\/+$/, "");
  var SESSION_KEY = "slidecheck.account.session";
  var DEFAULT_RESEND_SECONDS = 30;

  var state = { email: "", session: null, plan: null, resendTimer: null, pollTimer: null, sendSeq: 0, paddleReady: false };

  function $(id) {
    return document.getElementById(id);
  }

  function isPlaceholder(value) {
    return typeof value !== "string" || value === "" || value.indexOf("REPLACE") === 0;
  }

  // --- session storage (may throw in private modes or with storage blocked) ---

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.token === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    state.session = session;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Storage unavailable: the session lives in memory for this page view only.
    }
  }

  function stopPoll() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function clearSession() {
    state.session = null;
    state.plan = null;
    stopPoll();
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }

  // --- messages ---

  function showStatus(text) {
    var el = $("status");
    el.textContent = text || "";
    el.hidden = !text;
  }

  function showError(text) {
    var el = $("error");
    el.textContent = text || "";
    el.hidden = !text;
  }

  function clearMessages() {
    showStatus("");
    showError("");
  }

  function waitText(seconds) {
    if (!seconds || seconds < 1) return "a moment";
    if (seconds < 90) return seconds + " seconds";
    return Math.ceil(seconds / 60) + " minutes";
  }

  // Maps API error codes (apps/license-api/src/auth.ts) to user-facing text.
  function errorText(code, retryAfter) {
    switch (code) {
      case "invalid_email":
        return "Enter a valid email address.";
      case "invalid_code":
        return "That code is not correct. Check the most recent email from SlideCheck and try again.";
      case "code_expired":
        return "That code has expired. Choose Resend code to get a new one.";
      case "code_locked":
        return "Too many wrong attempts for this code. Choose Resend code to get a new one.";
      case "resend_too_soon":
        return "A code was just sent. You can request another in " + waitText(retryAfter) + ".";
      case "rate_limited":
        return "Too many attempts. Try again in " + waitText(retryAfter) + ".";
      case "too_many_signups":
        return "Too many new accounts from this network. Try again in " + waitText(retryAfter) + ".";
      case "email_unavailable":
        return "We could not send the email right now. Try again in a few minutes.";
      case "unauthorized":
        return "Your session has ended. Sign in again.";
      case "network":
        return "Cannot reach SlideCheck. Check your connection and try again.";
      default:
        return "Something went wrong. Try again, or contact support@slidecheck.io.";
    }
  }

  // --- API ---

  function api(method, path, body) {
    var headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (state.session) headers.Authorization = "Bearer " + state.session.token;
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
    }).then(
      function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { ok: res.ok, status: res.status, data: data || {} };
          });
      },
      function () {
        return { ok: false, status: 0, data: { error: "network" } };
      },
    );
  }

  function failure(res) {
    var code = res.data && typeof res.data.error === "string" ? res.data.error : res.status >= 500 ? "server" : "unknown";
    var retry = res.data && typeof res.data.retry_after_seconds === "number" ? res.data.retry_after_seconds : 0;
    return { code: code, retry: retry };
  }

  // --- views ---

  function showStep(name) {
    $("step-email").hidden = name !== "email";
    $("step-code").hidden = name !== "code";
    $("step-account").hidden = name !== "account";
  }

  function setBusy(button, busy, busyLabel) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyLabel : button.dataset.label;
  }

  function startResendCountdown(seconds) {
    var button = $("resend");
    var remaining = Math.max(1, Math.round(seconds || DEFAULT_RESEND_SECONDS));
    if (state.resendTimer) clearInterval(state.resendTimer);
    button.disabled = true;
    button.textContent = "Resend code (" + remaining + " s)";
    state.resendTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(state.resendTimer);
        state.resendTimer = null;
        button.disabled = false;
        button.textContent = "Resend code";
      } else {
        button.textContent = "Resend code (" + remaining + " s)";
      }
    }, 1000);
  }

  function formatDate(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function renderAccount(ent) {
    var plan = ent && typeof ent.plan === "string" ? ent.plan : "free";
    state.plan = plan;
    $("account-email").textContent = state.session.email || "";
    var labels = { pro: "SlideCheck Pro", trial: "Pro trial", free: "Free" };
    $("account-plan").textContent = labels[plan] || plan;

    var detail = "";
    if (plan === "trial") {
      var ends = formatDate(ent.trial_ends_at);
      detail = "Your Pro trial ends " + (ends ? "on " + ends : "soon") + ". Subscribe any time to keep Pro after the trial.";
    } else if (plan === "free") {
      detail = "You are on the Free plan. Subscribe to unlock the full hidden-problem audit, the Inspector, and one-click fixes.";
    } else {
      detail = "Pro is active. Use Manage subscription to update payment details, download invoices, or cancel.";
    }
    $("plan-detail").textContent = detail;

    $("subscribe").hidden = plan === "pro";
    $("manage").hidden = false;
    showStep("account");
  }

  function loadEntitlement() {
    var session = state.session;
    return api("GET", "/entitlement").then(function (res) {
      // Signed out (or signed in as someone else) while this was in flight: drop the stale response.
      if (state.session !== session) return null;
      if (res.status === 401) {
        clearSession();
        showStep("email");
        showError(errorText("unauthorized"));
        return null;
      }
      if (!res.ok) {
        showError(errorText(failure(res).code));
        return null;
      }
      renderAccount(res.data);
      return res.data;
    });
  }

  // --- sign-in flow ---

  function sendCode(email, isResend) {
    var button = isResend ? $("resend") : $("email-submit");
    var seq = ++state.sendSeq;
    clearMessages();
    setBusy(button, true, "Sending…");
    showStatus("Sending code…");
    return api("POST", "/auth/start", { email: email }).then(function (res) {
      setBusy(button, false);
      // The user chose "use a different email" (or sent again) meanwhile: ignore this response.
      if (seq !== state.sendSeq) return;
      showStatus("");
      if (res.ok) {
        state.email = email;
        $("code-email").textContent = email;
        $("code-input").value = "";
        showStep("code");
        showStatus(isResend ? "We sent a new code." : "");
        startResendCountdown(res.data.resend_after_seconds);
        $("code-input").focus();
        return;
      }
      var f = failure(res);
      if (f.code === "resend_too_soon") {
        // A code is already on its way; go to the code step and count down.
        state.email = email;
        $("code-email").textContent = email;
        showStep("code");
        startResendCountdown(f.retry);
      }
      showError(errorText(f.code, f.retry));
    });
  }

  function verifyCode(code) {
    var button = $("code-submit");
    clearMessages();
    setBusy(button, true, "Signing in…");
    return api("POST", "/auth/verify", { email: state.email, code: code }).then(function (res) {
      setBusy(button, false);
      if (!res.ok) {
        var f = failure(res);
        showError(errorText(f.code, f.retry));
        $("code-input").focus();
        return;
      }
      var account = res.data.account || {};
      if (typeof res.data.session_token !== "string" || typeof account.id !== "string") {
        showError(errorText("server"));
        return;
      }
      if (state.resendTimer) clearInterval(state.resendTimer);
      saveSession({ token: res.data.session_token, email: String(account.email || state.email), account_id: account.id });
      showStatus("Signed in.");
      return loadEntitlement();
    });
  }

  function signOut() {
    clearMessages();
    var button = $("signout");
    setBusy(button, true, "Signing out…");
    var done = function () {
      setBusy(button, false);
      clearSession();
      $("email-input").value = "";
      showStep("email");
      showStatus("You are signed out.");
    };
    // Revoke the session server-side; sign out locally even if that fails.
    return api("POST", "/auth/signout").then(done, done);
  }

  // --- Paddle ---

  function paddleConfigured() {
    return !isPlaceholder(config.PADDLE_CLIENT_TOKEN) && !isPlaceholder(config.PADDLE_PRICE_ID);
  }

  function initPaddle() {
    if (state.paddleReady) return true;
    var Paddle = window.Paddle;
    if (!Paddle || !paddleConfigured()) return false;
    try {
      if (config.PADDLE_ENVIRONMENT === "sandbox" && Paddle.Environment) Paddle.Environment.set("sandbox");
      Paddle.Initialize({
        token: config.PADDLE_CLIENT_TOKEN,
        eventCallback: function (event) {
          if (event && event.name === "checkout.completed") onCheckoutCompleted();
        },
      });
      state.paddleReady = true;
    } catch {
      state.paddleReady = false;
    }
    return state.paddleReady;
  }

  // The webhook usually lands within seconds; poll the entitlement a few times.
  function onCheckoutCompleted() {
    showStatus("Thanks! Activating Pro…");
    var session = state.session;
    var attempts = 0;
    stopPoll();
    var poll = function () {
      state.pollTimer = null;
      if (state.session !== session) return;
      attempts += 1;
      loadEntitlement().then(function (ent) {
        if (state.session !== session) return;
        if (ent && ent.plan === "pro") {
          showStatus("Pro is active. In PowerPoint, open SlideCheck > Account and choose Refresh.");
        } else if (attempts < 6) {
          state.pollTimer = setTimeout(poll, 5000);
        } else {
          showStatus("Payment received. Pro can take a minute to activate. Choose Refresh shortly.");
        }
      });
    };
    state.pollTimer = setTimeout(poll, 3000);
  }

  function openCheckout() {
    clearMessages();
    if (!state.session) return;
    if (!initPaddle()) {
      showError(
        paddleConfigured()
          ? "The payment window could not load. Disable content blockers for this page, or try again later."
          : "Subscriptions are not available yet.",
      );
      return;
    }
    try {
      window.Paddle.Checkout.open({
        items: [{ priceId: config.PADDLE_PRICE_ID, quantity: 1 }],
        customer: { email: state.session.email },
        customData: { account_id: state.session.account_id },
      });
    } catch {
      showError("The payment window could not open. Try again.");
    }
  }

  function isPaddleUrl(value) {
    try {
      var u = new URL(value);
      return u.protocol === "https:" && (u.hostname === "paddle.com" || /\.paddle\.com$/.test(u.hostname));
    } catch {
      return false;
    }
  }

  function openPortal() {
    clearMessages();
    var button = $("manage");
    setBusy(button, true, "Opening…");
    api("GET", "/billing/links").then(function (res) {
      setBusy(button, false);
      if (res.status === 401) {
        clearSession();
        showStep("email");
        showError(errorText("unauthorized"));
        return;
      }
      if (!res.ok) {
        showError(errorText(failure(res).code));
        return;
      }
      var url = res.data.portal_url;
      if (typeof url === "string" && isPaddleUrl(url)) {
        window.location.assign(url);
        return;
      }
      showError(
        state.plan === "pro"
          ? "The subscription portal is unavailable right now. Try again in a few minutes, or use the link in your Paddle receipt email."
          : "There is no subscription on this account yet. Choose Subscribe to Pro to start one.",
      );
    });
  }

  // --- wiring ---

  function init() {
    if (!API || isPlaceholder(API)) {
      $("config-warning").hidden = false;
      return;
    }
    if (!paddleConfigured()) $("config-warning").hidden = false;

    $("email-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("email-input").value.trim();
      if (!email || email.indexOf("@") < 1) {
        showError(errorText("invalid_email"));
        $("email-input").focus();
        return;
      }
      sendCode(email, false);
    });
    $("code-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = $("code-input").value.replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) {
        showError("Enter the 6-digit code from the email.");
        $("code-input").focus();
        return;
      }
      verifyCode(code);
    });
    $("resend").addEventListener("click", function () {
      if (state.email) sendCode(state.email, true);
    });
    $("change-email").addEventListener("click", function () {
      state.sendSeq += 1;
      if (state.resendTimer) clearInterval(state.resendTimer);
      clearMessages();
      showStep("email");
      $("email-input").focus();
    });
    $("subscribe").addEventListener("click", openCheckout);
    $("manage").addEventListener("click", openPortal);
    $("refresh").addEventListener("click", function () {
      clearMessages();
      showStatus("Refreshing…");
      loadEntitlement().then(function (ent) {
        if (ent) showStatus("Up to date.");
      });
    });
    $("signout").addEventListener("click", signOut);

    var saved = loadSession();
    if (saved) {
      state.session = saved;
      showStatus("Loading your account…");
      loadEntitlement().then(function (ent) {
        if (ent) showStatus("");
      });
    } else {
      showStep("email");
    }
    initPaddle();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
