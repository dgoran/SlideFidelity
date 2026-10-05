//! U7: notify-only update check (H3/H5). No test makes a real network request: feeds come from
//! signed fixtures in tests/fixtures/update (test-only minisign keys) through a fake fetcher.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use slidefidelity_helper::config::Managed;
use slidefidelity_helper::update::{
    check, check_once, run_scheduler, Fetch, FetchError, HttpFetch, Platform, UpdateError,
    UpdateInfo, UpdateState, FEED_PUBLIC_KEY, FEED_URL, SIGNATURE_URL,
};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/update")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn test_key() -> String {
    String::from_utf8(fixture("TEST-ONLY.pub")).unwrap()
}

/// Serves fixed bodies by URL and counts every call.
struct FakeFetch {
    bodies: Mutex<HashMap<String, Vec<u8>>>,
    calls: AtomicUsize,
}

impl FakeFetch {
    fn new(feed: Vec<u8>, sig: Vec<u8>) -> Self {
        let mut bodies = HashMap::new();
        bodies.insert(FEED_URL.to_string(), feed);
        bodies.insert(SIGNATURE_URL.to_string(), sig);
        Self {
            bodies: Mutex::new(bodies),
            calls: AtomicUsize::new(0),
        }
    }
    fn feed(name: &str) -> Self {
        Self::new(fixture(name), fixture(&format!("{name}.minisig")))
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Fetch for FakeFetch {
    async fn get(&self, url: &str) -> Result<Vec<u8>, FetchError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.bodies
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| FetchError(format!("404 {url}")))
    }
}

fn v(s: &str) -> Version {
    Version::parse(s).unwrap()
}

#[test]
fn feed_urls_are_https_and_signature_sits_next_to_feed() {
    assert_eq!(FEED_URL, "https://app.slidefidelity.com/helper/latest.json");
    assert_eq!(SIGNATURE_URL, format!("{FEED_URL}.minisig"));
}

#[tokio::test]
async fn newer_signed_feed_yields_update_info() {
    let f = FakeFetch::feed("newer.json");
    let info = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap()
        .expect("newer version");
    assert_eq!(
        info,
        UpdateInfo {
            version: "0.2.0".into(),
            page: "https://slidefidelity.com/helper".into(),
            notes: Some("Faster font scan.".into()),
        }
    );
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["version"], "0.2.0");
    assert_eq!(json["page"], "https://slidefidelity.com/helper");
}

#[tokio::test]
async fn windows_platform_also_accepted() {
    let f = FakeFetch::feed("newer.json");
    let got = check(&f, &v("0.1.0"), &test_key(), Platform::Windows)
        .await
        .unwrap();
    assert!(got.is_some());
}

#[tokio::test]
async fn bare_base64_public_key_is_accepted() {
    let f = FakeFetch::feed("newer.json");
    let key = test_key();
    let line = key.lines().nth(1).unwrap();
    assert!(check(&f, &v("0.1.0"), line, Platform::Mac)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn signature_from_another_key_is_rejected() {
    let f = FakeFetch::new(
        fixture("newer.json"),
        fixture("newer.json.other-key.minisig"),
    );
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::BadSignature(_)), "{err:?}");
}

#[tokio::test]
async fn verifying_with_another_public_key_is_rejected() {
    let f = FakeFetch::feed("newer.json");
    let other = String::from_utf8(fixture("TEST-ONLY-other.pub")).unwrap();
    let err = check(&f, &v("0.1.0"), &other, Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::BadSignature(_)), "{err:?}");
}

#[tokio::test]
async fn tampered_feed_is_rejected() {
    let feed = String::from_utf8(fixture("newer.json")).unwrap().replace(
        "https://slidefidelity.com/helper",
        "https://evil.example/helper",
    );
    let f = FakeFetch::new(feed.into_bytes(), fixture("newer.json.minisig"));
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::BadSignature(_)), "{err:?}");
}

#[tokio::test]
async fn garbage_signature_is_rejected() {
    let f = FakeFetch::new(fixture("newer.json"), b"not a signature".to_vec());
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::BadSignature(_)), "{err:?}");
}

#[tokio::test]
async fn placeholder_production_key_never_verifies() {
    let f = FakeFetch::feed("newer.json");
    let err = check(&f, &v("0.1.0"), FEED_PUBLIC_KEY, Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::BadSignature(_)), "{err:?}");
}

#[tokio::test]
async fn equal_or_older_version_is_not_an_update() {
    let f = FakeFetch::feed("newer.json");
    for cur in ["0.2.0", "0.3.0", "1.0.0"] {
        let got = check(&f, &v(cur), &test_key(), Platform::Mac)
            .await
            .unwrap();
        assert_eq!(got, None, "current {cur}");
    }
}

#[tokio::test]
async fn http_page_is_rejected() {
    let f = FakeFetch::feed("http-page.json");
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::InsecureUrl(_)), "{err:?}");
}

#[tokio::test]
async fn http_platform_url_is_rejected_even_for_other_platform() {
    let f = FakeFetch::feed("http-platform.json");
    for p in [Platform::Mac, Platform::Windows] {
        let err = check(&f, &v("0.1.0"), &test_key(), p).await.unwrap_err();
        assert!(matches!(err, UpdateError::InsecureUrl(_)), "{err:?}");
    }
}

#[tokio::test]
async fn missing_platform_entry_is_rejected() {
    let f = FakeFetch::feed("windows-only.json");
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::MissingPlatform(_)), "{err:?}");
    // The same feed is fine for Windows.
    assert!(check(&f, &v("0.1.0"), &test_key(), Platform::Windows)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn malformed_json_is_rejected() {
    let f = FakeFetch::feed("malformed.json");
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::Malformed(_)), "{err:?}");
}

#[tokio::test]
async fn fetch_failure_is_network_error() {
    let f = FakeFetch::new(fixture("newer.json"), vec![]);
    f.bodies.lock().unwrap().remove(SIGNATURE_URL);
    let err = check(&f, &v("0.1.0"), &test_key(), Platform::Mac)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::Network(_)), "{err:?}");
}

#[tokio::test]
async fn auto_update_off_makes_no_network_call() {
    let f = FakeFetch::feed("newer.json");
    let state = UpdateState::new();
    let managed = Managed {
        auto_update: false,
        port: None,
    };
    // Must return immediately rather than loop.
    tokio::time::timeout(
        Duration::from_secs(5),
        run_scheduler(
            state.clone(),
            managed,
            &f,
            v("0.1.0"),
            test_key(),
            Platform::Mac,
            Duration::from_millis(1),
        ),
    )
    .await
    .expect("scheduler returns at once when auto_update is off");
    assert_eq!(f.calls(), 0);
    assert_eq!(state.get(), None);
}

#[tokio::test]
async fn check_once_stores_update_and_clears_it_when_feed_rolls_back() {
    let state = UpdateState::new();
    let newer = FakeFetch::feed("newer.json");
    check_once(&state, &newer, &v("0.1.0"), &test_key(), Platform::Mac).await;
    assert_eq!(state.get().unwrap().version, "0.2.0");

    // Feed rolled back: helper is now current (equal version) -> notice cleared.
    check_once(&state, &newer, &v("0.2.0"), &test_key(), Platform::Mac).await;
    assert_eq!(state.get(), None);
}

#[tokio::test]
async fn check_once_keeps_last_known_update_on_error() {
    let state = UpdateState::new();
    let newer = FakeFetch::feed("newer.json");
    check_once(&state, &newer, &v("0.1.0"), &test_key(), Platform::Mac).await;
    assert!(state.get().is_some());

    let broken = FakeFetch::feed("malformed.json");
    check_once(&state, &broken, &v("0.1.0"), &test_key(), Platform::Mac).await;
    assert_eq!(state.get().unwrap().version, "0.2.0");
}

#[tokio::test]
async fn scheduler_checks_at_start_and_repeats() {
    let f = FakeFetch::feed("newer.json");
    let state = UpdateState::new();
    let _ = tokio::time::timeout(
        Duration::from_millis(300),
        run_scheduler(
            state.clone(),
            Managed::default(),
            &f,
            v("0.1.0"),
            test_key(),
            Platform::Mac,
            Duration::from_millis(20),
        ),
    )
    .await;
    assert_eq!(state.get().unwrap().version, "0.2.0");
    // Two fetches (feed + signature) per check; more than one check ran.
    assert!(f.calls() >= 4, "calls {}", f.calls());
}

#[tokio::test]
async fn http_fetch_refuses_plain_http_without_a_request() {
    let fetch = HttpFetch::new(&v("0.1.0")).unwrap();
    // Port 9 on loopback (discard) would error differently if a connection were attempted; the
    // refusal must come from the scheme check itself.
    let err = fetch.get("http://127.0.0.1:9/helper/latest.json").await;
    let msg = err.unwrap_err().0;
    assert!(msg.contains("https"), "{msg}");
}

#[test]
fn platform_current_matches_target() {
    if cfg!(target_os = "macos") {
        assert_eq!(Platform::current(), Some(Platform::Mac));
    } else if cfg!(windows) {
        assert_eq!(Platform::current(), Some(Platform::Windows));
    }
}
