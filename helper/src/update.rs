//! U7: notify-only update check (decisions H3 and H5).
//!
//! The helper never downloads or runs installers. It fetches the signed feed, verifies the minisign
//! signature against a key compiled into the binary, and if the feed names a newer version it
//! records an [`UpdateInfo`] that `/v1/health` reports as `"update": {"version", "page"}`. The add-in
//! then offers "Helper update available" and opens `page` in the browser.
//!
//! When the administrator sets `AutoUpdate=false` the scheduler returns at once and makes no
//! network call at all.

use std::future::Future;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::config::Managed;

/// The signed feed.
pub const FEED_URL: &str = "https://app.slidecheck.io/helper/latest.json";
/// Detached minisign signature over the exact bytes of [`FEED_URL`].
pub const SIGNATURE_URL: &str = "https://app.slidecheck.io/helper/latest.json.minisig";

// TODO(U0/U10): replace with the production minisign public key (base64 line of the .pub file).
// The production secret key lives only in CI secrets. Until then this placeholder is not valid
// base64 for a minisign key, so every feed fails verification and no update is ever reported.
pub const FEED_PUBLIC_KEY: &str = "RWQ_PLACEHOLDER_PRODUCTION_KEY_NOT_SET";

/// How often the scheduler re-checks after the check at start-up.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Timeout for each feed request.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest body accepted from the feed host.
pub const MAX_BODY: usize = 1024 * 1024;

/// What `/v1/health` reports as `update` when a newer helper is available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub page: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Which installer entry in the feed must exist for this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
}

impl Platform {
    /// The platform this binary was built for; `None` on anything else.
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Mac)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Mac => "mac",
            Self::Windows => "windows",
        }
    }
}

/// Why a check produced no answer. "Not newer" is not an error: [`check`] returns `Ok(None)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    /// Fetching the feed or its signature failed.
    Network(String),
    /// Signature missing, unparseable, from another key, or not matching the feed bytes.
    BadSignature(String),
    /// Feed is not the expected JSON shape (or a field has an invalid value).
    Malformed(String),
    /// `page` or a platform `url` is not `https://`.
    InsecureUrl(String),
    /// The feed has no entry for this platform.
    MissingPlatform(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(r) => write!(f, "network: {r}"),
            Self::BadSignature(r) => write!(f, "bad signature: {r}"),
            Self::Malformed(r) => write!(f, "malformed feed: {r}"),
            Self::InsecureUrl(r) => write!(f, "insecure url in feed: {r}"),
            Self::MissingPlatform(r) => write!(f, "feed has no entry for platform {r}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// A failed fetch, with a human-readable reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError(pub String);

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FetchError {}

/// Source of feed bytes: [`HttpFetch`] in production, a fake in tests.
pub trait Fetch {
    fn get(&self, url: &str) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send;
}

impl<T: Fetch + Sync> Fetch for &T {
    fn get(&self, url: &str) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send {
        (**self).get(url)
    }
}

/// HTTPS-only fetcher: platform certificate verifier, 10 s timeout, 1 MB cap, no plain-HTTP
/// redirects, `User-Agent: slidecheck-helper/<version>`.
#[derive(Debug, Clone)]
pub struct HttpFetch {
    client: reqwest::Client,
}

impl HttpFetch {
    /// Installs the ring crypto provider for the process if none is installed yet.
    pub fn new(current: &Version) -> Result<Self, FetchError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(FETCH_TIMEOUT)
            .user_agent(format!("slidecheck-helper/{current}"))
            .build()
            .map_err(|e| FetchError(format!("building http client: {e}")))?;
        Ok(Self { client })
    }
}

impl Fetch for HttpFetch {
    async fn get(&self, url: &str) -> Result<Vec<u8>, FetchError> {
        if !is_https(url) {
            return Err(FetchError(format!("refusing non-https url {url}")));
        }
        let mut resp = self
            .client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| FetchError(format!("{url}: {e}")))?;
        if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
            return Err(FetchError(format!(
                "{url}: body larger than {MAX_BODY} bytes"
            )));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| FetchError(format!("{url}: {e}")))?
        {
            if body.len() + chunk.len() > MAX_BODY {
                return Err(FetchError(format!(
                    "{url}: body larger than {MAX_BODY} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

/// `https://` with a host.
fn is_https(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty()))
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    #[allow(dead_code)]
    min_api_version: u32,
    page: String,
    platforms: Platforms,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Deserialize)]
struct Platforms {
    mac: Option<Installer>,
    windows: Option<Installer>,
}

#[derive(Deserialize)]
struct Installer {
    url: String,
    sha256: String,
}

fn parse_key(public_key: &str) -> Result<PublicKey, UpdateError> {
    let key = public_key.trim();
    let parsed = if key.contains('\n') {
        PublicKey::decode(key)
    } else {
        PublicKey::from_base64(key)
    };
    parsed.map_err(|e| UpdateError::BadSignature(format!("public key unusable: {e}")))
}

fn verify(feed: &[u8], sig: &[u8], public_key: &str) -> Result<(), UpdateError> {
    let key = parse_key(public_key)?;
    let sig = std::str::from_utf8(sig)
        .map_err(|_| UpdateError::BadSignature("signature is not text".into()))?;
    let sig = Signature::decode(sig)
        .map_err(|e| UpdateError::BadSignature(format!("signature unparseable: {e}")))?;
    key.verify(feed, &sig, false)
        .map_err(|e| UpdateError::BadSignature(e.to_string()))
}

/// Fetch and verify the feed, and report whether it names a version newer than `current`.
///
/// Order: fetch feed and signature, verify the signature over the exact feed bytes, parse, require
/// `https://` for `page` and every platform `url`, require this platform's entry, then compare
/// versions. Equal or older feed versions give `Ok(None)`.
pub async fn check(
    fetch: &impl Fetch,
    current: &Version,
    public_key: &str,
    platform: Platform,
) -> Result<Option<UpdateInfo>, UpdateError> {
    let feed = fetch
        .get(FEED_URL)
        .await
        .map_err(|e| UpdateError::Network(e.0))?;
    let sig = fetch
        .get(SIGNATURE_URL)
        .await
        .map_err(|e| UpdateError::Network(e.0))?;
    verify(&feed, &sig, public_key)?;

    let m: Manifest =
        serde_json::from_slice(&feed).map_err(|e| UpdateError::Malformed(e.to_string()))?;
    let version = Version::parse(&m.version)
        .map_err(|e| UpdateError::Malformed(format!("version {:?}: {e}", m.version)))?;

    if !is_https(&m.page) {
        return Err(UpdateError::InsecureUrl(format!("page {}", m.page)));
    }
    for (name, entry) in [("mac", &m.platforms.mac), ("windows", &m.platforms.windows)] {
        if let Some(i) = entry {
            if !is_https(&i.url) {
                return Err(UpdateError::InsecureUrl(format!("{name} url {}", i.url)));
            }
            if i.sha256.len() != 64 || !i.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(UpdateError::Malformed(format!(
                    "{name} sha256 is not 64 hex digits"
                )));
            }
        }
    }
    let entry = match platform {
        Platform::Mac => &m.platforms.mac,
        Platform::Windows => &m.platforms.windows,
    };
    if entry.is_none() {
        return Err(UpdateError::MissingPlatform(platform.key().into()));
    }

    if version <= *current {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: m.version,
        page: m.page,
        notes: m.notes.filter(|n| !n.trim().is_empty()),
    }))
}

/// The update notice shared between the scheduler and the HTTP server (`/v1/health`).
#[derive(Debug, Clone, Default)]
pub struct UpdateState(Arc<RwLock<Option<UpdateInfo>>>);

impl UpdateState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current notice, if any.
    pub fn get(&self) -> Option<UpdateInfo> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, info: Option<UpdateInfo>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = info;
    }
}

/// One check, applied to `state`:
/// - newer version: store it;
/// - not newer: clear it, so a rolled-back feed (or a helper already updated) stops the notice;
/// - error: log the reason and keep the last verified notice, so a transient failure neither
///   invents nor hides an update.
pub async fn check_once(
    state: &UpdateState,
    fetch: &impl Fetch,
    current: &Version,
    public_key: &str,
    platform: Platform,
) {
    match check(fetch, current, public_key, platform).await {
        Ok(Some(info)) => {
            tracing::info!(version = %info.version, page = %info.page, "helper update available");
            state.set(Some(info));
        }
        Ok(None) => {
            tracing::debug!(%current, "helper is up to date");
            state.set(None);
        }
        Err(e) => tracing::warn!(error = %e, "update check failed"),
    }
}

/// Check at start and then every `interval` ([`CHECK_INTERVAL`] in production). Returns at once,
/// without any network call, when `managed.auto_update` is false. Otherwise runs forever; spawn it.
pub async fn run_scheduler(
    state: UpdateState,
    managed: Managed,
    fetch: impl Fetch,
    current: Version,
    public_key: String,
    platform: Platform,
    interval: Duration,
) {
    if !managed.auto_update {
        tracing::info!("update checks turned off by managed setting AutoUpdate=false");
        return;
    }
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await; // first tick completes immediately
        check_once(&state, &fetch, &current, &public_key, platform).await;
    }
}
