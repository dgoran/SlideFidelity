//! U6: certificate lifecycle. Every test uses a temporary state directory and a fake trust store;
//! nothing here touches a real keychain or certificate store.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use slidecheck_helper::cert::{
    self, CertError, CertPaths, InstallOptions, InstallOutcome, OnTrustFailure, RootRef,
    TrustStatus, TrustStore, MAX_TOTAL_VALIDITY_DAYS, RENEW_BELOW_DAYS,
};
use time::{Duration, OffsetDateTime};

// ---------------------------------------------------------------------------------------------
// Fake trust store

#[derive(Default)]
struct FakeStore {
    /// sha1 (upper-case hex) -> PEM text of the trusted root.
    trusted: RefCell<BTreeMap<String, String>>,
    fail_add: Cell<bool>,
    adds: Cell<usize>,
    removes: RefCell<Vec<String>>,
}

impl FakeStore {
    fn failing() -> Self {
        let s = Self::default();
        s.fail_add.set(true);
        s
    }
    fn trusted_count(&self) -> usize {
        self.trusted.borrow().len()
    }
    fn trusts(&self, sha1: &str) -> bool {
        self.trusted
            .borrow()
            .contains_key(&sha1.to_ascii_uppercase())
    }
}

impl TrustStore for FakeStore {
    fn add(&self, root: &RootRef<'_>) -> Result<(), CertError> {
        self.adds.set(self.adds.get() + 1);
        if self.fail_add.get() {
            return Err(CertError::Trust(
                "SecTrustSettingsSetTrustSettings: no user interaction was possible".into(),
            ));
        }
        let pem = fs::read_to_string(root.pem_path).expect("root pem readable when trusting");
        assert!(pem.contains("BEGIN CERTIFICATE"));
        assert!(!pem.contains("PRIVATE KEY"));
        self.trusted
            .borrow_mut()
            .insert(root.sha1_hex.to_ascii_uppercase(), pem);
        Ok(())
    }
    fn remove(&self, root: &RootRef<'_>) -> Result<(), CertError> {
        self.removes
            .borrow_mut()
            .push(root.sha1_hex.to_ascii_uppercase());
        self.trusted
            .borrow_mut()
            .remove(&root.sha1_hex.to_ascii_uppercase());
        Ok(())
    }
    fn is_trusted(&self, root: &RootRef<'_>) -> Result<bool, CertError> {
        Ok(self.trusts(root.sha1_hex))
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers

fn mac_opts() -> InstallOptions {
    InstallOptions {
        now: OffsetDateTime::now_utc(),
        on_trust_failure: OnTrustFailure::KeepUntrusted,
    }
}

fn win_opts() -> InstallOptions {
    InstallOptions {
        now: OffsetDateTime::now_utc(),
        on_trust_failure: OnTrustFailure::RollBack,
    }
}

fn fresh() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("state");
    (tmp, dir)
}

#[cfg(not(windows))]
const OPENSSL: &str = "/usr/bin/openssl";
/// Git for Windows ships OpenSSL; nothing else on a stock PC does.
#[cfg(windows)]
const OPENSSL: &str = r"C:\Program Files\Git\usr\bin\openssl.exe";

fn openssl(args: &[&str], pem_path: &Path) -> String {
    let out = Command::new(OPENSSL)
        .arg("x509")
        .arg("-in")
        .arg(pem_path)
        .args(args)
        .output()
        .expect("openssl runs");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn text(pem_path: &Path) -> String {
    openssl(&["-noout", "-text"], pem_path)
}

/// The lines following `header` up to the next extension header ("X509v3 ...") or section.
fn ext_block(text: &str, header: &str) -> (String, Vec<String>) {
    let mut lines = text.lines();
    let head = lines
        .by_ref()
        .find(|l| l.contains(header))
        .unwrap_or_else(|| panic!("no {header} in\n{text}"))
        .trim()
        .to_string();
    let body = lines
        .take_while(|l| !l.contains("X509v3") && !l.contains("Signature Algorithm"))
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    (head, body)
}

fn parse_openssl_date(s: &str) -> OffsetDateTime {
    // e.g. "Oct  1 10:00:00 2026 GMT"
    let fmt = time::format_description::parse_borrowed::<2>(
        "[month repr:short] [day padding:space] [hour]:[minute]:[second] [year] GMT",
    )
    .unwrap();
    time::PrimitiveDateTime::parse(s.trim(), &fmt)
        .unwrap_or_else(|e| panic!("{s}: {e}"))
        .assume_utc()
}

fn validity(pem_path: &Path) -> (OffsetDateTime, OffsetDateTime) {
    let out = openssl(&["-noout", "-startdate", "-enddate"], pem_path);
    let mut nb = None;
    let mut na = None;
    for l in out.lines() {
        if let Some(v) = l.strip_prefix("notBefore=") {
            nb = Some(parse_openssl_date(v));
        }
        if let Some(v) = l.strip_prefix("notAfter=") {
            na = Some(parse_openssl_date(v));
        }
    }
    (nb.unwrap(), na.unwrap())
}

fn fingerprint(pem_path: &Path, alg: &str) -> String {
    let out = openssl(&["-noout", "-fingerprint", alg], pem_path);
    out.split('=').nth(1).unwrap().trim().replace(':', "")
}

fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

fn root_sha1(dir: &Path) -> String {
    fs::read_to_string(CertPaths::in_dir(dir).root_sha1)
        .unwrap()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------------------------
// Happy path: certificate contents

#[test]
fn install_writes_the_expected_files_and_trusts_the_root() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::Generated { renewed: false });

    let p = CertPaths::in_dir(&dir);
    for f in [
        &p.leaf_pem,
        &p.leaf_key,
        &p.root_pem,
        &p.root_sha256,
        &p.root_sha1,
    ] {
        assert!(f.is_file(), "{} missing", f.display());
    }
    assert_eq!(store.trusted_count(), 1);
    assert!(store.trusts(&root_sha1(&dir)));
    assert_eq!(
        cert::trust_status(&store, &dir),
        TrustStatus::Trusted,
        "status after install"
    );

    // Thumbprints match what openssl computes from root.pem.
    assert_eq!(
        fs::read_to_string(&p.root_sha256)
            .unwrap()
            .trim()
            .to_ascii_uppercase(),
        fingerprint(&p.root_pem, "-sha256")
    );
    assert_eq!(
        root_sha1(&dir).to_ascii_uppercase(),
        fingerprint(&p.root_pem, "-sha1")
    );

    // CertPaths for the real state dir agrees with paths.rs.
    let real = CertPaths::in_dir(&slidecheck_helper::paths::state_dir());
    assert_eq!(real.leaf_pem, slidecheck_helper::paths::leaf_cert_path());
    assert_eq!(real.leaf_key, slidecheck_helper::paths::leaf_key_path());
    assert_eq!(
        real.root_sha256,
        slidecheck_helper::paths::root_thumbprint_path()
    );
}

#[cfg(unix)]
#[test]
fn files_are_world_readable_and_not_writable_by_others() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    for (name, _) in snapshot(&dir) {
        let mode = fs::metadata(dir.join(&name)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "{name} has mode {mode:o}");
    }
}

#[test]
fn leaf_is_a_localhost_only_server_certificate() {
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    let leaf = CertPaths::in_dir(&dir).leaf_pem;
    let t = text(&leaf);

    let (head, body) = ext_block(&t, "X509v3 Subject Alternative Name");
    let _ = head;
    let mut sans: Vec<String> = body
        .join(",")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    sans.sort();
    // LibreSSL prints ::1 in full form.
    assert_eq!(
        sans,
        vec![
            "DNS:localhost",
            "IP Address:0:0:0:0:0:0:0:1",
            "IP Address:127.0.0.1"
        ],
        "{t}"
    );

    let (head, body) = ext_block(&t, "X509v3 Extended Key Usage");
    let _ = head;
    assert_eq!(body, vec!["TLS Web Server Authentication"], "{t}");

    let (head, body) = ext_block(&t, "X509v3 Key Usage");
    assert!(head.ends_with("critical"), "{head}");
    assert_eq!(body, vec!["Digital Signature"], "{t}");

    let (head, body) = ext_block(&t, "X509v3 Basic Constraints");
    assert!(head.ends_with("critical"), "{head}");
    assert_eq!(body, vec!["CA:FALSE"], "{t}");

    assert!(!t.contains("Name Constraints"), "{t}");

    let (nb, na) = validity(&leaf);
    let total = na - nb;
    assert!(
        total <= Duration::days(MAX_TOTAL_VALIDITY_DAYS),
        "leaf total validity {total} exceeds {MAX_TOTAL_VALIDITY_DAYS} days"
    );
    assert!(
        total >= Duration::days(800),
        "leaf validity {total} unexpectedly short"
    );
    let now = OffsetDateTime::now_utc();
    assert!(
        nb <= now && nb >= now - Duration::hours(2),
        "not_before {nb}"
    );
}

#[test]
fn root_is_a_name_constrained_ca_with_pathlen_zero() {
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    let p = CertPaths::in_dir(&dir);
    let t = text(&p.root_pem);

    let (head, body) = ext_block(&t, "X509v3 Name Constraints");
    assert!(head.ends_with("critical"), "{head}");
    let mut permitted: Vec<String> = body.into_iter().filter(|l| l != "Permitted:").collect();
    permitted.sort();
    assert_eq!(
        permitted,
        vec![
            "DNS:localhost",
            "IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF",
            "IP:127.0.0.1/255.255.255.255",
        ],
        "{t}"
    );
    assert!(!t.contains("Excluded:"), "{t}");

    let (head, body) = ext_block(&t, "X509v3 Basic Constraints");
    assert!(head.ends_with("critical"), "{head}");
    assert_eq!(body, vec!["CA:TRUE, pathlen:0"], "{t}");

    let (head, body) = ext_block(&t, "X509v3 Key Usage");
    assert!(head.ends_with("critical"), "{head}");
    assert_eq!(body, vec!["Certificate Sign, CRL Sign"], "{t}");

    let (nb, na) = validity(&p.root_pem);
    assert!(na - nb <= Duration::days(MAX_TOTAL_VALIDITY_DAYS + 1));

    // The leaf was issued by this root.
    let leaf_issuer = openssl(&["-noout", "-issuer"], &p.leaf_pem);
    let root_subject = openssl(&["-noout", "-subject"], &p.root_pem);
    assert_eq!(
        leaf_issuer.trim_start_matches("issuer="),
        root_subject.trim_start_matches("subject=")
    );
    let verify = Command::new(OPENSSL)
        .args(["verify", "-CAfile"])
        .arg(&p.root_pem)
        .arg(&p.leaf_pem)
        .output()
        .unwrap();
    assert!(
        verify.status.success(),
        "{}{}",
        String::from_utf8_lossy(&verify.stdout),
        String::from_utf8_lossy(&verify.stderr)
    );
}

#[test]
fn only_the_leaf_key_is_ever_written() {
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    let with_keys: Vec<String> = snapshot(&dir)
        .into_iter()
        .filter(|(_, bytes)| String::from_utf8_lossy(bytes).contains("PRIVATE KEY"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(with_keys, vec!["leaf.key".to_string()]);
}

#[test]
fn days_remaining_reads_the_leaf_expiry() {
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    let pem = fs::read_to_string(CertPaths::in_dir(&dir).leaf_pem).unwrap();
    let days = cert::days_remaining(&pem).unwrap();
    assert!((822..=824).contains(&days), "{days}");
    let later = OffsetDateTime::now_utc() + Duration::days(800);
    let d = cert::days_remaining_at(&pem, later).unwrap();
    assert!((22..=24).contains(&d), "{d}");
    assert!(cert::days_remaining("not a certificate").is_err());
}

// ---------------------------------------------------------------------------------------------
// Edge cases

#[test]
fn install_twice_is_a_no_op() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let before = snapshot(&dir);
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::Unchanged);
    assert_eq!(snapshot(&dir), before);
    assert_eq!(store.trusted_count(), 1);
    assert_eq!(store.adds.get(), 1);
}

#[test]
fn files_present_but_untrusted_only_retries_trust() {
    let (_t, dir) = fresh();
    let store = FakeStore::failing();
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert!(
        matches!(
            outcome,
            InstallOutcome::Untrusted {
                generated: true,
                ..
            }
        ),
        "{outcome:?}"
    );
    let before = snapshot(&dir);

    store.fail_add.set(false);
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::TrustRepaired);
    assert_eq!(snapshot(&dir), before, "files must not be regenerated");
    assert!(store.trusts(&root_sha1(&dir)));
}

#[test]
fn near_expiry_regenerates_trusts_new_root_and_removes_old() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let old_sha1 = root_sha1(&dir);
    let old_leaf = fs::read(CertPaths::in_dir(&dir).leaf_pem).unwrap();

    // 824 - 750 = 74 days left: below the renewal threshold.
    let later = InstallOptions {
        now: OffsetDateTime::now_utc() + Duration::days(824 - RENEW_BELOW_DAYS + 16),
        on_trust_failure: OnTrustFailure::KeepUntrusted,
    };
    let outcome = cert::install_cert(&store, &dir, &later).unwrap();
    assert_eq!(outcome, InstallOutcome::Generated { renewed: true });

    let new_sha1 = root_sha1(&dir);
    assert_ne!(new_sha1, old_sha1);
    assert_ne!(
        fs::read(CertPaths::in_dir(&dir).leaf_pem).unwrap(),
        old_leaf
    );
    assert!(store.trusts(&new_sha1));
    assert!(!store.trusts(&old_sha1), "old root still trusted");
    assert_eq!(store.trusted_count(), 1);
    assert_eq!(
        store.removes.borrow().as_slice(),
        [old_sha1.to_ascii_uppercase()]
    );
    // No leftovers from the swap.
    let names: Vec<String> = snapshot(&dir).into_keys().collect();
    assert_eq!(
        names,
        [
            "leaf.key",
            "leaf.pem",
            "root.pem",
            "root.sha1",
            "root.sha256"
        ]
    );
}

#[test]
fn just_above_the_threshold_does_not_renew() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let opts = InstallOptions {
        now: OffsetDateTime::now_utc() + Duration::days(824 - RENEW_BELOW_DAYS - 5),
        on_trust_failure: OnTrustFailure::KeepUntrusted,
    };
    assert_eq!(
        cert::install_cert(&store, &dir, &opts).unwrap(),
        InstallOutcome::Unchanged
    );
}

#[test]
fn corrupt_or_partial_files_are_regenerated() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let old_sha1 = root_sha1(&dir);
    let p = CertPaths::in_dir(&dir);

    fs::write(&p.leaf_pem, "-----BEGIN CERTIFICATE-----\ngarbage\n").unwrap();
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::Generated { renewed: true });
    assert!(!store.trusts(&old_sha1));
    assert_eq!(store.trusted_count(), 1);

    fs::remove_file(&p.leaf_key).unwrap();
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Missing);
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::Generated { renewed: true });
    assert_eq!(store.trusted_count(), 1);
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Trusted);
}

// ---------------------------------------------------------------------------------------------
// Errors

#[test]
fn windows_policy_trust_failure_fails_and_leaves_no_files() {
    let (_t, dir) = fresh();
    let store = FakeStore::failing();
    let err = cert::install_cert(&store, &dir, &win_opts()).unwrap_err();
    assert!(matches!(err, CertError::Trust(_)), "{err}");
    let left = if dir.exists() {
        snapshot(&dir)
    } else {
        BTreeMap::new()
    };
    assert!(
        left.is_empty(),
        "left behind: {:?}",
        left.keys().collect::<Vec<_>>()
    );
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Missing);
}

#[test]
fn windows_policy_failed_renewal_keeps_the_old_trusted_chain() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &win_opts()).unwrap();
    let before = snapshot(&dir);
    store.fail_add.set(true);
    let later = InstallOptions {
        now: OffsetDateTime::now_utc() + Duration::days(800),
        on_trust_failure: OnTrustFailure::RollBack,
    };
    assert!(cert::install_cert(&store, &dir, &later).is_err());
    assert_eq!(snapshot(&dir), before);
    assert!(store.trusts(&root_sha1(&dir)));
}

#[test]
fn windows_policy_never_trusts_an_untrusted_chain_found_on_disk() {
    // A standard user can pre-create %ProgramData%\SlideCheck\Helper and plant a consistent chain
    // of their own. The elevated installer must replace it, not add the planted root to the store.
    let (_t, dir) = fresh();
    let planter = FakeStore::failing();
    cert::install_cert(&planter, &dir, &mac_opts()).unwrap();
    let planted = root_sha1(&dir);

    let store = FakeStore::default();
    let outcome = cert::install_cert(&store, &dir, &win_opts()).unwrap();
    assert_eq!(outcome, InstallOutcome::Generated { renewed: true });
    let installed = root_sha1(&dir);
    assert_ne!(installed, planted);
    assert!(!store.trusts(&planted), "planted root was trusted");
    assert!(store.trusts(&installed));
    assert_eq!(store.trusted_count(), 1);
}

#[test]
fn mac_policy_trust_failure_keeps_files_and_reports_not_trusted() {
    let (_t, dir) = fresh();
    let store = FakeStore::failing();
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    match &outcome {
        InstallOutcome::Untrusted { generated, reason } => {
            assert!(generated);
            assert!(reason.contains("user interaction"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    let names: Vec<String> = snapshot(&dir).into_keys().collect();
    assert_eq!(
        names,
        [
            "leaf.key",
            "leaf.pem",
            "root.pem",
            "root.sha1",
            "root.sha256"
        ]
    );
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::NotTrusted);

    // A second failed attempt changes nothing.
    let before = snapshot(&dir);
    let again = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert!(
        matches!(
            again,
            InstallOutcome::Untrusted {
                generated: false,
                ..
            }
        ),
        "{again:?}"
    );
    assert_eq!(snapshot(&dir), before);
}

// The login-time trust prompt is the macOS flow (H2); on Windows the installer owns trust.
#[cfg(not(windows))]
#[test]
fn ensure_user_trust_trusts_an_untrusted_root_once() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    assert_eq!(
        cert::ensure_user_trust(&store, &dir).unwrap(),
        TrustStatus::Missing
    );
    assert_eq!(store.adds.get(), 0);

    store.fail_add.set(true);
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let before = snapshot(&dir);
    store.fail_add.set(false);

    let adds = store.adds.get();
    assert_eq!(
        cert::ensure_user_trust(&store, &dir).unwrap(),
        TrustStatus::Trusted
    );
    assert_eq!(store.adds.get(), adds + 1);
    // Already trusted: no second prompt.
    assert_eq!(
        cert::ensure_user_trust(&store, &dir).unwrap(),
        TrustStatus::Trusted
    );
    assert_eq!(store.adds.get(), adds + 1);
    // The helper never writes to the state directory.
    assert_eq!(snapshot(&dir), before);
}

#[cfg(not(windows))]
#[test]
fn ensure_user_trust_reports_refusal() {
    let (_t, dir) = fresh();
    let store = FakeStore::failing();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    assert!(cert::ensure_user_trust(&store, &dir).is_err());
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::NotTrusted);
}

#[cfg(windows)]
#[test]
fn ensure_user_trust_only_reports_on_windows() {
    let (_t, dir) = fresh();
    let store = FakeStore::failing();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let adds = store.adds.get();
    store.fail_add.set(false);
    assert_eq!(
        cert::ensure_user_trust(&store, &dir).unwrap(),
        TrustStatus::NotTrusted
    );
    assert_eq!(
        store.adds.get(),
        adds,
        "the helper must not touch the machine store"
    );
}

#[test]
fn uninstall_removes_trust_and_every_file() {
    let (_t, dir) = fresh();
    let store = FakeStore::default();
    cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    let sha1 = root_sha1(&dir);
    cert::uninstall_cert(&store, &dir).unwrap();
    assert!(!store.trusts(&sha1));
    assert_eq!(store.trusted_count(), 0);
    assert!(!dir.exists() || snapshot(&dir).is_empty());
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Missing);
    // Idempotent.
    cert::uninstall_cert(&store, &dir).unwrap();
}

// ---------------------------------------------------------------------------------------------
// TLS integration (no OS trust needed)

fn load_certs(path: &Path) -> Vec<rustls::pki_types::CertificateDer<'static>> {
    let mut r = std::io::BufReader::new(fs::File::open(path).unwrap());
    rustls_pemfile::certs(&mut r).map(|c| c.unwrap()).collect()
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

async fn handshake(dir: &Path, bind: std::net::SocketAddr, name: &str) -> Result<(), String> {
    use rustls::pki_types::ServerName;
    let p = CertPaths::in_dir(dir);
    let key = {
        let mut r = std::io::BufReader::new(fs::File::open(&p.leaf_key).unwrap());
        rustls_pemfile::private_key(&mut r).unwrap().unwrap()
    };
    let server_cfg = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(load_certs(&p.leaf_pem), key)
        .unwrap();
    let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_cfg));
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let _ = acceptor.accept(tcp).await;
    });

    let mut roots = rustls::RootCertStore::empty();
    for c in load_certs(&p.root_pem) {
        roots.add(c).unwrap();
    }
    let client_cfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_cfg));
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let server_name = ServerName::try_from(name.to_string()).unwrap();
    let res = connector
        .connect(server_name, tcp)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string());
    server.abort();
    res
}

#[tokio::test]
async fn generated_chain_serves_tls_for_localhost_names_only() {
    let (_t, dir) = fresh();
    cert::install_cert(&FakeStore::default(), &dir, &mac_opts()).unwrap();
    let v4: std::net::SocketAddr = "127.0.0.1:0".parse().unwrap();
    let v6: std::net::SocketAddr = "[::1]:0".parse().unwrap();

    handshake(&dir, v4, "localhost").await.unwrap();
    handshake(&dir, v4, "127.0.0.1").await.unwrap();
    handshake(&dir, v6, "::1").await.unwrap();
    handshake(&dir, v6, "localhost").await.unwrap();

    let err = handshake(&dir, v4, "example.com").await.unwrap_err();
    assert!(
        err.contains("NotValidForName") || err.contains("not valid"),
        "{err}"
    );
}

// ---------------------------------------------------------------------------------------------
// Real OS store (manual only)

/// Exercises the real System keychain. NEVER runs in CI. To run it by hand on a disposable Mac
/// (it shows the admin-approval dialog and adds, then removes, a root in the System keychain):
///
/// ```sh
/// cargo test --test cert -- --ignored real_system_keychain_round_trip
/// ```
///
/// Then confirm `security dump-trust-settings -d` no longer lists "SlideCheck Helper Local Root".
#[cfg(target_os = "macos")]
#[test]
#[ignore = "modifies the real System keychain; run manually on a disposable machine"]
fn real_system_keychain_round_trip() {
    let (_t, dir) = fresh();
    let store = cert::SystemTrustStore;
    let outcome = cert::install_cert(&store, &dir, &mac_opts()).unwrap();
    eprintln!("install: {outcome:?}");
    eprintln!("ensure: {:?}", cert::ensure_user_trust(&store, &dir));
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Trusted);
    cert::uninstall_cert(&store, &dir).unwrap();
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Missing);
}

/// Exercises the real `LocalMachine\Root` store. NEVER runs in CI. Run by hand from an elevated
/// prompt (it adds, then removes, a root in the machine store):
///
/// ```bat
/// cargo test --test cert -- --ignored real_local_machine_root_round_trip
/// ```
///
/// Then confirm certlm.msc > Trusted Root Certification Authorities no longer lists
/// "SlideCheck Helper Local Root".
#[cfg(windows)]
#[test]
#[ignore = "modifies the real LocalMachine\\Root store; run manually from an elevated prompt"]
fn real_local_machine_root_round_trip() {
    let (_t, dir) = fresh();
    let store = cert::SystemTrustStore;
    let outcome = cert::install_cert(&store, &dir, &win_opts()).unwrap();
    assert!(
        matches!(outcome, InstallOutcome::Generated { .. }),
        "{outcome:?}"
    );
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Trusted);

    // The store entry must be limited to Server Authentication (the EKU property, not the cert).
    let sha1 = root_sha1(&dir);
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-Item Cert:\\LocalMachine\\Root\\{sha1}).EnhancedKeyUsageList | \
                 ForEach-Object {{ $_.ObjectId }}"
            ),
        ])
        .output()
        .expect("powershell runs");
    let ekus = String::from_utf8_lossy(&out.stdout);
    let ekus: Vec<&str> = ekus
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    assert_eq!(
        ekus,
        ["1.3.6.1.5.5.7.3.1"],
        "intended purposes of the store entry"
    );

    // Installing again finds it trusted and changes nothing.
    assert_eq!(
        cert::install_cert(&store, &dir, &win_opts()).unwrap(),
        InstallOutcome::Unchanged
    );

    cert::uninstall_cert(&store, &dir).unwrap();
    assert_eq!(cert::trust_status(&store, &dir), TrustStatus::Missing);
    assert!(
        !store
            .is_trusted(&RootRef {
                pem_path: Path::new("unused"),
                sha1_hex: &sha1,
                common_name: "unused",
            })
            .unwrap(),
        "root still in LocalMachine\\Root"
    );
}
