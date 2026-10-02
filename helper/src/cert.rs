//! Certificate lifecycle (U6): this computer's localhost certificate chain and its trust.
//!
//! Design (docs/notes/helper-decisions.md, H1/H2/H4):
//! - A per-machine root CA with critical NameConstraints permitting only `localhost`,
//!   `127.0.0.1/32` and `::1/128`, `CA:TRUE pathlen:0`, keyUsage `keyCertSign, cRLSign`. It signs
//!   exactly one leaf, then its private key is dropped and is never written anywhere. (rcgen's
//!   `KeyPair` cannot be zeroized internally; we drop it as soon as the leaf is signed.)
//! - The leaf: critical `CA:FALSE`, keyUsage `digitalSignature`, EKU `serverAuth`, SANs exactly
//!   `localhost`, `127.0.0.1`, `::1`. Total validity (including backdating) is at most 825 days,
//!   which macOS requires; renewal happens when fewer than [`RENEW_BELOW_DAYS`] remain.
//! - Files in the state directory, all mode 0644 (every local user's helper serves the same leaf,
//!   so the leaf key is readable by every local account; the installer owns the files):
//!   `leaf.pem`, `leaf.key`, `root.pem` (public certificate only), `root.sha256`, `root.sha1`.
//!   Files are written atomically (temp file + rename).
//! - Trust lives in the OS store behind [`TrustStore`]. On macOS a root process without a user
//!   session cannot set trust, so `install-cert` keeps the files and reports
//!   [`InstallOutcome::Untrusted`]; the helper then calls [`ensure_user_trust`] at login, which
//!   shows the admin-approval dialog once. On Windows a trust failure rolls back instead.

use std::fmt;
use std::io::{self, Write as _};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose,
    NameConstraints, SanType,
};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

/// macOS rejects TLS leaves whose total validity exceeds this (H1).
pub const MAX_TOTAL_VALIDITY_DAYS: i64 = 825;
/// `install-cert` regenerates the chain when the leaf has fewer days left than this.
pub const RENEW_BELOW_DAYS: i64 = 90;
/// Leaf lifetime after `now`; with one hour of backdating the total stays under 825 days.
const LEAF_DAYS: i64 = 824;
const BACKDATE: Duration = Duration::hours(1);
const ROOT_CN_PREFIX: &str = "SlideCheck Helper Local Root";

// ---------------------------------------------------------------------------------------------
// Errors

#[derive(Debug)]
pub enum CertError {
    Io(io::Error),
    Generate(rcgen::Error),
    /// A certificate file could not be parsed.
    Parse(String),
    /// The OS trust store refused or failed.
    Trust(String),
}

impl fmt::Display for CertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CertError::Io(e) => write!(f, "certificate file error: {e}"),
            CertError::Generate(e) => write!(f, "certificate generation failed: {e}"),
            CertError::Parse(e) => write!(f, "certificate parse error: {e}"),
            CertError::Trust(e) => write!(f, "trust store error: {e}"),
        }
    }
}

impl std::error::Error for CertError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CertError::Io(e) => Some(e),
            CertError::Generate(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for CertError {
    fn from(e: io::Error) -> Self {
        CertError::Io(e)
    }
}

impl From<rcgen::Error> for CertError {
    fn from(e: rcgen::Error) -> Self {
        CertError::Generate(e)
    }
}

// ---------------------------------------------------------------------------------------------
// Paths

/// The files this module manages inside a state directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertPaths {
    pub dir: PathBuf,
    pub leaf_pem: PathBuf,
    pub leaf_key: PathBuf,
    pub root_pem: PathBuf,
    /// Upper-case hex SHA-256 of the root certificate DER.
    pub root_sha256: PathBuf,
    /// Upper-case hex SHA-1 of the root certificate DER (what `security -Z` and `certutil` take).
    pub root_sha1: PathBuf,
    /// The new root while it is being trusted, before the chain is committed.
    staging_root: PathBuf,
    /// The replaced root while its trust is being removed after a renewal.
    old_root: PathBuf,
}

impl CertPaths {
    pub fn in_dir(dir: &Path) -> Self {
        CertPaths {
            dir: dir.to_path_buf(),
            leaf_pem: dir.join("leaf.pem"),
            leaf_key: dir.join("leaf.key"),
            root_pem: dir.join("root.pem"),
            root_sha256: dir.join("root.sha256"),
            root_sha1: dir.join("root.sha1"),
            staging_root: dir.join("root.new.pem"),
            old_root: dir.join("root.old.pem"),
        }
    }

    /// The machine-wide state directory (`paths::state_dir()`).
    pub fn system() -> Self {
        Self::in_dir(&crate::paths::state_dir())
    }

    fn all_files(&self) -> [&PathBuf; 7] {
        [
            &self.leaf_pem,
            &self.leaf_key,
            &self.root_pem,
            &self.root_sha256,
            &self.root_sha1,
            &self.staging_root,
            &self.old_root,
        ]
    }

    fn chain_files(&self) -> [&PathBuf; 5] {
        [
            &self.leaf_pem,
            &self.leaf_key,
            &self.root_pem,
            &self.root_sha256,
            &self.root_sha1,
        ]
    }
}

// ---------------------------------------------------------------------------------------------
// Trust store

/// Identifies a root certificate to the OS trust store.
#[derive(Debug, Clone, Copy)]
pub struct RootRef<'a> {
    /// A PEM file holding the root certificate (public part only).
    pub pem_path: &'a Path,
    /// Upper-case hex SHA-1 thumbprint of the certificate DER.
    pub sha1_hex: &'a str,
    /// The root's subject common name (unique per generated root).
    pub common_name: &'a str,
}

/// The OS store of trusted roots. The real implementation is [`SystemTrustStore`]; tests use a fake.
pub trait TrustStore {
    /// Trust `root` as an SSL/TLS root for this machine.
    fn add(&self, root: &RootRef<'_>) -> Result<(), CertError>;
    /// Remove trust for `root` and delete it from the store. Succeeds if it is not present.
    fn remove(&self, root: &RootRef<'_>) -> Result<(), CertError>;
    fn is_trusted(&self, root: &RootRef<'_>) -> Result<bool, CertError>;
}

/// The real OS trust store: the macOS System keychain admin trust settings, or the Windows
/// LocalMachine\Root store. Shells out to `security` / `certutil`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemTrustStore;

#[cfg(target_os = "macos")]
fn run(program: &str, args: &[&std::ffi::OsStr]) -> Result<String, CertError> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| CertError::Trust(format!("{program}: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(CertError::Trust(format!(
            "{program} {} failed ({}): {}{}",
            args.first()
                .map(|a| a.to_string_lossy())
                .unwrap_or_default(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim(),
            stdout.trim()
        )))
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::OsStr;

    pub const SYSTEM_KEYCHAIN: &str = "/Library/Keychains/System.keychain";
    const SECURITY: &str = "/usr/bin/security";

    /// Whether the System keychain holds a certificate with this SHA-1.
    fn in_keychain(root: &RootRef<'_>) -> Result<bool, CertError> {
        match run(
            SECURITY,
            &[
                OsStr::new("find-certificate"),
                OsStr::new("-a"),
                OsStr::new("-Z"),
                OsStr::new("-c"),
                OsStr::new(root.common_name),
                OsStr::new(SYSTEM_KEYCHAIN),
            ],
        ) {
            Ok(out) => Ok(out
                .lines()
                .filter_map(|l| l.trim().strip_prefix("SHA-1 hash:"))
                .any(|h| h.trim().eq_ignore_ascii_case(root.sha1_hex))),
            // `find-certificate` exits non-zero when nothing matches.
            Err(_) => Ok(false),
        }
    }

    impl TrustStore for SystemTrustStore {
        fn add(&self, root: &RootRef<'_>) -> Result<(), CertError> {
            // Run as root without a user session this fails with "The authorization was denied
            // since no user interaction was possible" (H2). Run in a user session it shows the
            // admin-approval dialog.
            run(
                SECURITY,
                &[
                    OsStr::new("add-trusted-cert"),
                    OsStr::new("-d"),
                    OsStr::new("-r"),
                    OsStr::new("trustRoot"),
                    OsStr::new("-p"),
                    OsStr::new("ssl"),
                    OsStr::new("-k"),
                    OsStr::new(SYSTEM_KEYCHAIN),
                    root.pem_path.as_os_str(),
                ],
            )
            .map(drop)
        }

        fn remove(&self, root: &RootRef<'_>) -> Result<(), CertError> {
            if root.pem_path.is_file() {
                if let Err(e) = run(
                    SECURITY,
                    &[
                        OsStr::new("remove-trusted-cert"),
                        OsStr::new("-d"),
                        root.pem_path.as_os_str(),
                    ],
                ) {
                    // Trust settings may already be gone; deleting the certificate below is
                    // what matters.
                    tracing::warn!("removing trust settings: {e}");
                }
            }
            if !in_keychain(root)? {
                return Ok(());
            }
            run(
                SECURITY,
                &[
                    OsStr::new("delete-certificate"),
                    OsStr::new("-Z"),
                    OsStr::new(root.sha1_hex),
                    OsStr::new(SYSTEM_KEYCHAIN),
                ],
            )
            .map(drop)
        }

        fn is_trusted(&self, root: &RootRef<'_>) -> Result<bool, CertError> {
            // Trusted = this exact certificate (by SHA-1) is in the System keychain AND the admin
            // trust settings list a certificate with its common name. The common name embeds a
            // per-root id, so an old SlideCheck root cannot satisfy the check for a new one.
            if !in_keychain(root)? {
                return Ok(false);
            }
            let settings = match run(
                SECURITY,
                &[OsStr::new("dump-trust-settings"), OsStr::new("-d")],
            ) {
                Ok(out) => out,
                // Exits non-zero with "No Trust Settings were found" when there are none.
                Err(_) => return Ok(false),
            };
            Ok(settings.lines().any(|l| {
                l.trim_start()
                    .strip_prefix("Cert ")
                    .and_then(|rest| rest.split_once(": "))
                    .is_some_and(|(_, name)| name.trim() == root.common_name)
            }))
        }
    }
}

#[cfg(windows)]
mod win {
    //! `LocalMachine\Root` through the CryptoAPI. Writing needs elevation (the MSI runs
    //! `install-cert` as SYSTEM); reading works for every user.
    use super::*;
    use std::ffi::c_void;
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{
        CertAddEncodedCertificateToStore, CertCloseStore, CertDeleteCertificateFromStore,
        CertFindCertificateInStore, CertFreeCertificateContext, CertOpenStore,
        CertSetCertificateContextProperty, CERT_CONTEXT, CERT_ENHKEY_USAGE_PROP_ID,
        CERT_FIND_SHA1_HASH, CERT_STORE_ADD_REPLACE_EXISTING, CERT_STORE_OPEN_EXISTING_FLAG,
        CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG, CERT_SYSTEM_STORE_LOCAL_MACHINE,
        CRYPT_INTEGER_BLOB, HCERTSTORE, X509_ASN_ENCODING,
    };

    /// DER of an EnhancedKeyUsage extension value listing only serverAuth (1.3.6.1.5.5.7.3.1).
    /// Set on the store entry, it limits what Windows trusts this root for.
    const EKU_SERVER_AUTH_ONLY: [u8; 12] = [
        0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
    ];

    struct Store(HCERTSTORE);

    impl Store {
        fn open(writable: bool) -> Result<Self, CertError> {
            let name: Vec<u16> = "ROOT".encode_utf16().chain(Some(0)).collect();
            let mut flags = CERT_SYSTEM_STORE_LOCAL_MACHINE | CERT_STORE_OPEN_EXISTING_FLAG;
            if !writable {
                flags |= CERT_STORE_READONLY_FLAG;
            }
            // SAFETY: valid provider constant and a NUL-terminated UTF-16 store name.
            let h = unsafe {
                CertOpenStore(
                    CERT_STORE_PROV_SYSTEM_W,
                    0,
                    0,
                    flags,
                    name.as_ptr() as *const c_void,
                )
            };
            if h.is_null() {
                return Err(last_error("CertOpenStore(LocalMachine\\Root)"));
            }
            Ok(Self(h))
        }

        /// The store entry whose SHA-1 thumbprint is `sha1_hex`, if present. Caller frees it.
        fn find(&self, sha1_hex: &str) -> Result<Option<*mut CERT_CONTEXT>, CertError> {
            let mut hash = hex_decode(sha1_hex)
                .ok_or_else(|| CertError::Parse(format!("bad thumbprint {sha1_hex}")))?;
            let blob = CRYPT_INTEGER_BLOB {
                cbData: hash.len() as u32,
                pbData: hash.as_mut_ptr(),
            };
            // SAFETY: the store handle is open; `blob` outlives the call.
            let ctx = unsafe {
                CertFindCertificateInStore(
                    self.0,
                    X509_ASN_ENCODING,
                    0,
                    CERT_FIND_SHA1_HASH,
                    &blob as *const _ as *const c_void,
                    ptr::null(),
                )
            };
            Ok((!ctx.is_null()).then_some(ctx))
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            // SAFETY: handle came from CertOpenStore.
            unsafe { CertCloseStore(self.0, 0) };
        }
    }

    fn last_error(what: &str) -> CertError {
        CertError::Trust(format!("{what}: {}", std::io::Error::last_os_error()))
    }

    fn hex_decode(s: &str) -> Option<Vec<u8>> {
        if s.len() % 2 != 0 {
            return None;
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
            .collect()
    }

    impl TrustStore for SystemTrustStore {
        fn add(&self, root: &RootRef<'_>) -> Result<(), CertError> {
            let pem = std::fs::read_to_string(root.pem_path)?;
            let der = pem_to_der(&pem)?;
            let store = Store::open(true)?;
            let mut ctx: *mut CERT_CONTEXT = ptr::null_mut();
            // SAFETY: `der` is a complete DER certificate; `ctx` receives a context we free below.
            let ok = unsafe {
                CertAddEncodedCertificateToStore(
                    store.0,
                    X509_ASN_ENCODING,
                    der.as_ptr(),
                    der.len() as u32,
                    CERT_STORE_ADD_REPLACE_EXISTING,
                    &mut ctx,
                )
            };
            if ok == 0 {
                return Err(last_error("CertAddEncodedCertificateToStore"));
            }
            let blob = CRYPT_INTEGER_BLOB {
                cbData: EKU_SERVER_AUTH_ONLY.len() as u32,
                pbData: EKU_SERVER_AUTH_ONLY.as_ptr() as *mut u8,
            };
            // SAFETY: `ctx` is valid; the property data is read, not written.
            let set = unsafe {
                CertSetCertificateContextProperty(
                    ctx,
                    CERT_ENHKEY_USAGE_PROP_ID,
                    0,
                    &blob as *const _ as *const c_void,
                )
            };
            let err = (set == 0).then(|| last_error("CertSetCertificateContextProperty(EKU)"));
            // SAFETY: context from CertAddEncodedCertificateToStore.
            unsafe { CertFreeCertificateContext(ctx) };
            match err {
                // Trust without the purpose restriction is not acceptable: undo it.
                Some(e) => {
                    let _ = self.remove(root);
                    Err(e)
                }
                None => Ok(()),
            }
        }

        fn remove(&self, root: &RootRef<'_>) -> Result<(), CertError> {
            let store = Store::open(true)?;
            while let Some(ctx) = store.find(root.sha1_hex)? {
                // SAFETY: CertDeleteCertificateFromStore frees `ctx` whether or not it succeeds.
                if unsafe { CertDeleteCertificateFromStore(ctx) } == 0 {
                    return Err(last_error("CertDeleteCertificateFromStore"));
                }
            }
            Ok(())
        }

        fn is_trusted(&self, root: &RootRef<'_>) -> Result<bool, CertError> {
            let store = Store::open(false)?;
            match store.find(root.sha1_hex)? {
                Some(ctx) => {
                    // SAFETY: context from CertFindCertificateInStore.
                    unsafe { CertFreeCertificateContext(ctx) };
                    Ok(true)
                }
                None => Ok(false),
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl TrustStore for SystemTrustStore {
    fn add(&self, _root: &RootRef<'_>) -> Result<(), CertError> {
        Err(CertError::Trust("unsupported platform".into()))
    }
    fn remove(&self, _root: &RootRef<'_>) -> Result<(), CertError> {
        Err(CertError::Trust("unsupported platform".into()))
    }
    fn is_trusted(&self, _root: &RootRef<'_>) -> Result<bool, CertError> {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------------------------
// Install / uninstall

/// What `install_cert` does when the trust store refuses the root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnTrustFailure {
    /// macOS (H2): keep the files, report [`InstallOutcome::Untrusted`]; the helper asks the user
    /// at login via [`ensure_user_trust`].
    KeepUntrusted,
    /// Windows: leave no orphan state. A first install removes everything it wrote; a failed
    /// renewal keeps the previous (still trusted) chain. Returns the error.
    RollBack,
}

impl OnTrustFailure {
    /// The policy for the OS this binary runs on.
    pub fn native() -> Self {
        if cfg!(target_os = "macos") {
            OnTrustFailure::KeepUntrusted
        } else {
            OnTrustFailure::RollBack
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InstallOptions {
    /// The current time (injectable for tests).
    pub now: OffsetDateTime,
    pub on_trust_failure: OnTrustFailure,
}

impl InstallOptions {
    pub fn native() -> Self {
        InstallOptions {
            now: OffsetDateTime::now_utc(),
            on_trust_failure: OnTrustFailure::native(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    /// A valid, trusted chain was already installed; nothing changed.
    Unchanged,
    /// The files were valid but untrusted; trusting them succeeded.
    TrustRepaired,
    /// A new chain was generated and trusted. `renewed`: it replaced earlier (expiring, partial or
    /// corrupt) files, whose root was removed from the store.
    Generated { renewed: bool },
    /// [`OnTrustFailure::KeepUntrusted`] only: the chain is on disk but the store refused it.
    /// `install-cert` should log a warning and exit 0.
    Untrusted { generated: bool, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustStatus {
    Trusted,
    NotTrusted,
    /// No complete chain in the state directory.
    Missing,
}

/// `install-cert`: make sure the state directory holds a valid chain whose root is trusted.
/// Idempotent; see the module docs and [`OnTrustFailure`].
pub fn install_cert(
    store: &dyn TrustStore,
    state_dir: &Path,
    opts: &InstallOptions,
) -> Result<InstallOutcome, CertError> {
    let p = CertPaths::in_dir(state_dir);
    crate::paths::ensure_dir(state_dir, 0o755)?;
    remove_leftovers(&p);

    let existing = check_existing(&p, opts.now).and_then(|existing| {
        let trusted = store
            .is_trusted(&existing.root_ref(&p.root_pem))
            .unwrap_or_else(|e| {
                tracing::warn!("checking trust: {e}");
                false
            });
        // Under RollBack a failed trust attempt deletes its files, so an untrusted chain on disk
        // was not written by us: on Windows any user can pre-create the state directory under
        // %ProgramData% and plant one. Never trust it; generate a fresh chain instead.
        if !trusted && opts.on_trust_failure == OnTrustFailure::RollBack {
            return Err("the chain on disk is not trusted; replacing it".to_string());
        }
        Ok((existing, trusted))
    });
    match existing {
        Ok((_, true)) => Ok(InstallOutcome::Unchanged),
        Ok((existing, false)) => {
            let root = existing.root_ref(&p.root_pem);
            match store.add(&root) {
                Ok(()) => {
                    tracing::info!("trusted existing root {}", existing.sha1);
                    Ok(InstallOutcome::TrustRepaired)
                }
                // Only KeepUntrusted gets here; RollBack regenerates untrusted chains above.
                Err(e) => {
                    tracing::warn!("root is installed but not trusted yet: {e}");
                    Ok(InstallOutcome::Untrusted {
                        generated: false,
                        reason: e.to_string(),
                    })
                }
            }
        }
        Err(why) => {
            let renewed = p.chain_files().iter().any(|f| f.exists());
            if renewed {
                tracing::info!("regenerating certificate chain: {why}");
            }
            // The old root, if readable, so its trust can be removed after the swap.
            let old = std::fs::read_to_string(&p.root_pem)
                .ok()
                .and_then(|pem| RootInfo::from_pem(&pem).ok().map(|info| (pem, info)));

            let chain = generate(opts.now)?;
            write_atomic(&p.staging_root, chain.root_pem.as_bytes(), 0o644)?;
            let staged = RootRef {
                pem_path: &p.staging_root,
                sha1_hex: &chain.root.sha1,
                common_name: &chain.root.common_name,
            };
            let trust = match store.add(&staged) {
                Ok(()) => Ok(()),
                Err(e) if opts.on_trust_failure == OnTrustFailure::RollBack => {
                    let _ = std::fs::remove_file(&p.staging_root);
                    tracing::error!("trusting the new root failed; previous state kept: {e}");
                    return Err(e);
                }
                Err(e) => Err(e),
            };
            commit(&p, &chain)?;
            let _ = std::fs::remove_file(&p.staging_root);

            if let Some((pem, info)) = old {
                if info.sha1 != chain.root.sha1 {
                    remove_old_root(store, &p, &pem, &info);
                }
            }
            match trust {
                Ok(()) => {
                    tracing::info!("installed and trusted root {}", chain.root.sha1);
                    Ok(InstallOutcome::Generated { renewed })
                }
                Err(e) => {
                    tracing::warn!("certificate installed but not trusted yet: {e}");
                    Ok(InstallOutcome::Untrusted {
                        generated: true,
                        reason: e.to_string(),
                    })
                }
            }
        }
    }
}

/// `uninstall-cert`: remove the root from the trust store, then delete every file this module
/// created (and the state directory if it is then empty). If the store refuses, the files are kept
/// so a retry can find the root again.
pub fn uninstall_cert(store: &dyn TrustStore, state_dir: &Path) -> Result<(), CertError> {
    let p = CertPaths::in_dir(state_dir);
    if let Ok(pem) = std::fs::read_to_string(&p.root_pem) {
        if let Ok(info) = RootInfo::from_pem(&pem) {
            store.remove(&info.root_ref(&p.root_pem))?;
        }
    }
    // A root left mid-renewal.
    if let Ok(pem) = std::fs::read_to_string(&p.old_root) {
        if let Ok(info) = RootInfo::from_pem(&pem) {
            store.remove(&info.root_ref(&p.old_root))?;
        }
    }
    delete_files(&p);
    let _ = std::fs::remove_dir(state_dir); // only succeeds if empty
    Ok(())
}

/// Whether the installed root is trusted. Never writes anything.
pub fn trust_status(store: &dyn TrustStore, state_dir: &Path) -> TrustStatus {
    let p = CertPaths::in_dir(state_dir);
    let Some(info) = installed_root(&p) else {
        return TrustStatus::Missing;
    };
    match store.is_trusted(&info.root_ref(&p.root_pem)) {
        Ok(true) => TrustStatus::Trusted,
        Ok(false) => TrustStatus::NotTrusted,
        Err(e) => {
            tracing::warn!("checking trust: {e}");
            TrustStatus::NotTrusted
        }
    }
}

/// Called by the helper at login, running as the user (H2). If the installed root is not trusted,
/// asks the store to trust it; on macOS this shows the admin-approval dialog once. Never writes to
/// the state directory. On Windows trust is the installer's job, so this only reports status.
pub fn ensure_user_trust(
    store: &dyn TrustStore,
    state_dir: &Path,
) -> Result<TrustStatus, CertError> {
    let status = trust_status(store, state_dir);
    if status != TrustStatus::NotTrusted || cfg!(windows) {
        return Ok(status);
    }
    let p = CertPaths::in_dir(state_dir);
    let Some(info) = installed_root(&p) else {
        return Ok(TrustStatus::Missing);
    };
    store.add(&info.root_ref(&p.root_pem))?;
    Ok(trust_status(store, state_dir))
}

/// Whole days until the leaf in `leaf_pem` expires (negative once expired).
pub fn days_remaining(leaf_pem: &str) -> Result<i64, CertError> {
    days_remaining_at(leaf_pem, OffsetDateTime::now_utc())
}

pub fn days_remaining_at(leaf_pem: &str, now: OffsetDateTime) -> Result<i64, CertError> {
    let der = pem_to_der(leaf_pem)?;
    let cert = der::parse_cert(&der)?;
    Ok((cert.not_after - now).whole_days())
}

// ---------------------------------------------------------------------------------------------
// Internals

struct RootInfo {
    sha1: String,
    sha256: String,
    common_name: String,
    subject_der: Vec<u8>,
}

impl RootInfo {
    fn from_pem(pem: &str) -> Result<Self, CertError> {
        let der = pem_to_der(pem)?;
        let cert = der::parse_cert(&der)?;
        Ok(RootInfo {
            sha1: hex_upper(&<sha1::Sha1 as sha2::Digest>::digest(&der)),
            sha256: hex_upper(&Sha256::digest(&der)),
            common_name: cert
                .common_name
                .ok_or_else(|| CertError::Parse("root has no common name".into()))?,
            subject_der: cert.subject.to_vec(),
        })
    }

    fn root_ref<'a>(&'a self, pem_path: &'a Path) -> RootRef<'a> {
        RootRef {
            pem_path,
            sha1_hex: &self.sha1,
            common_name: &self.common_name,
        }
    }
}

/// The root of a complete chain on disk (leaf files present), without checking expiry.
fn installed_root(p: &CertPaths) -> Option<RootInfo> {
    if !p.leaf_pem.is_file() || !p.leaf_key.is_file() {
        return None;
    }
    RootInfo::from_pem(&std::fs::read_to_string(&p.root_pem).ok()?).ok()
}

/// A complete, consistent chain with enough validity left, or why not.
fn check_existing(p: &CertPaths, now: OffsetDateTime) -> Result<RootInfo, String> {
    let read =
        |f: &PathBuf| std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()));
    let root_pem = read(&p.root_pem)?;
    let leaf_pem = read(&p.leaf_pem)?;
    let key = Zeroizing::new(read(&p.leaf_key)?);
    if !key.contains("PRIVATE KEY") {
        return Err("leaf.key holds no private key".into());
    }
    let root = RootInfo::from_pem(&root_pem).map_err(|e| format!("root.pem: {e}"))?;
    if !read(&p.root_sha256)?
        .trim()
        .eq_ignore_ascii_case(&root.sha256)
        || !read(&p.root_sha1)?.trim().eq_ignore_ascii_case(&root.sha1)
    {
        return Err("root thumbprint files do not match root.pem".into());
    }
    let leaf_der = pem_to_der(&leaf_pem).map_err(|e| format!("leaf.pem: {e}"))?;
    let leaf = der::parse_cert(&leaf_der).map_err(|e| format!("leaf.pem: {e}"))?;
    if leaf.issuer != root.subject_der.as_slice() {
        return Err("leaf was not issued by root.pem".into());
    }
    let days = (leaf.not_after - now).whole_days();
    if days < RENEW_BELOW_DAYS {
        return Err(format!("leaf expires in {days} days"));
    }
    Ok(root)
}

struct Chain {
    root_pem: String,
    root: RootInfo,
    leaf_pem: String,
    leaf_key_pem: Zeroizing<String>,
}

fn generate(now: OffsetDateTime) -> Result<Chain, CertError> {
    let leaf_key = KeyPair::generate()?;
    let leaf_key_pem = Zeroizing::new(leaf_key.serialize_pem());

    let mut leaf = CertificateParams::default();
    leaf.distinguished_name = DistinguishedName::new();
    leaf.distinguished_name
        .push(DnType::CommonName, "SlideCheck Helper (localhost)");
    leaf.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    ];
    leaf.is_ca = IsCa::ExplicitNoCa;
    leaf.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf.use_authority_key_identifier_extension = true;
    leaf.not_before = now - BACKDATE;
    leaf.not_after = now + Duration::days(LEAF_DAYS);

    let (root_pem, leaf_pem) = {
        let ca_key = KeyPair::generate()?;
        // A per-root id in the subject keeps every generated root distinguishable in the
        // keychain and in the approval dialog.
        let id = hex_upper(&Sha256::digest(ca_key.public_key_raw()))[..8].to_string();
        let mut ca = CertificateParams::default();
        ca.distinguished_name = DistinguishedName::new();
        ca.distinguished_name.push(
            DnType::CommonName,
            format!("{ROOT_CN_PREFIX} {id} (this computer only)"),
        );
        ca.distinguished_name
            .push(DnType::OrganizationName, "SlideCheck");
        ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        ca.name_constraints = Some(NameConstraints {
            permitted_subtrees: vec![
                GeneralSubtree::DnsName("localhost".into()),
                GeneralSubtree::IpAddress(CidrSubnet::V4([127, 0, 0, 1], [255; 4])),
                GeneralSubtree::IpAddress(CidrSubnet::V6(Ipv6Addr::LOCALHOST.octets(), [255; 16])),
            ],
            excluded_subtrees: vec![],
        });
        ca.not_before = now - BACKDATE;
        ca.not_after = now + Duration::days(LEAF_DAYS + 1);
        let root = ca.self_signed(&ca_key)?;
        // The issuer takes ownership of the CA key; both are dropped at the end of this block,
        // right after signing the one leaf. The key is never serialized.
        let issuer = Issuer::new(ca, ca_key);
        let leaf_cert = leaf.signed_by(&leaf_key, &issuer)?;
        (root.pem(), leaf_cert.pem())
    };
    let root = RootInfo::from_pem(&root_pem)?;
    Ok(Chain {
        root_pem,
        root,
        leaf_pem,
        leaf_key_pem,
    })
}

/// Write the chain's files. Each file is replaced atomically; the root goes last so an interrupted
/// commit fails `check_existing` (issuer or thumbprint mismatch) and is regenerated next time.
fn commit(p: &CertPaths, chain: &Chain) -> Result<(), CertError> {
    write_atomic(&p.leaf_key, chain.leaf_key_pem.as_bytes(), 0o644)?;
    write_atomic(&p.leaf_pem, chain.leaf_pem.as_bytes(), 0o644)?;
    write_atomic(
        &p.root_sha256,
        format!("{}\n", chain.root.sha256).as_bytes(),
        0o644,
    )?;
    write_atomic(
        &p.root_sha1,
        format!("{}\n", chain.root.sha1).as_bytes(),
        0o644,
    )?;
    write_atomic(&p.root_pem, chain.root_pem.as_bytes(), 0o644)?;
    Ok(())
}

fn remove_old_root(store: &dyn TrustStore, p: &CertPaths, pem: &str, info: &RootInfo) {
    if let Err(e) = write_atomic(&p.old_root, pem.as_bytes(), 0o644) {
        tracing::warn!("could not stage old root for removal: {e}");
        return;
    }
    match store.remove(&info.root_ref(&p.old_root)) {
        Ok(()) => tracing::info!("removed old root {}", info.sha1),
        Err(e) => tracing::warn!("could not remove old root {}: {e}", info.sha1),
    }
    let _ = std::fs::remove_file(&p.old_root);
}

fn remove_leftovers(p: &CertPaths) {
    let _ = std::fs::remove_file(&p.staging_root);
    if let Ok(entries) = std::fs::read_dir(&p.dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name.ends_with(".tmp") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn delete_files(p: &CertPaths) {
    for f in p.all_files() {
        match std::fs::remove_file(f) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("removing {}: {e}", f.display()),
        }
    }
    remove_leftovers(p);
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("path has no file name"))?;
    let tmp = dir.join(format!(".{}.tmp", name.to_string_lossy()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, CertError> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = pem
        .find(BEGIN)
        .ok_or_else(|| CertError::Parse("no PEM certificate".into()))?
        + BEGIN.len();
    let len = pem[start..]
        .find(END)
        .ok_or_else(|| CertError::Parse("unterminated PEM certificate".into()))?;
    base64_decode(&pem[start..start + len])
}

fn base64_decode(s: &str) -> Result<Vec<u8>, CertError> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return Err(CertError::Parse("invalid base64 in PEM".into())),
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Just enough DER to read an X.509 certificate's issuer, validity and subject.
mod der {
    use super::CertError;
    use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

    pub struct Cert<'a> {
        /// Full DER (tag + length + content) of the issuer Name.
        pub issuer: &'a [u8],
        pub not_after: OffsetDateTime,
        /// Full DER of the subject Name.
        pub subject: &'a [u8],
        pub common_name: Option<String>,
    }

    fn err(what: &str) -> CertError {
        CertError::Parse(format!("malformed certificate DER: {what}"))
    }

    /// (tag, content, whole TLV, rest)
    type Tlv<'a> = (u8, &'a [u8], &'a [u8], &'a [u8]);
    /// (content, whole TLV, rest)
    type Expected<'a> = (&'a [u8], &'a [u8], &'a [u8]);

    fn tlv(input: &[u8]) -> Result<Tlv<'_>, CertError> {
        let (&tag, rest) = input.split_first().ok_or_else(|| err("truncated"))?;
        let (&first, mut rest) = rest.split_first().ok_or_else(|| err("truncated"))?;
        let len = if first < 0x80 {
            usize::from(first)
        } else {
            let n = usize::from(first & 0x7f);
            if n == 0 || n > 4 || rest.len() < n {
                return Err(err("bad length"));
            }
            let len = rest[..n]
                .iter()
                .fold(0usize, |a, &b| (a << 8) | usize::from(b));
            rest = &rest[n..];
            len
        };
        if rest.len() < len {
            return Err(err("truncated"));
        }
        let header = input.len() - rest.len();
        Ok((tag, &rest[..len], &input[..header + len], &rest[len..]))
    }

    fn expect(input: &[u8], want: u8) -> Result<Expected<'_>, CertError> {
        let (tag, content, whole, rest) = tlv(input)?;
        if tag != want {
            return Err(err("unexpected tag"));
        }
        Ok((content, whole, rest))
    }

    pub fn parse_cert(der: &[u8]) -> Result<Cert<'_>, CertError> {
        let (cert, _, _) = expect(der, 0x30)?;
        let (tbs, _, _) = expect(cert, 0x30)?;
        let mut r = tbs;
        let (tag, _, _, rest) = tlv(r)?;
        if tag == 0xa0 {
            r = rest; // explicit version
        }
        let (_, _, r) = expect(r, 0x02)?; // serial
        let (_, _, r) = expect(r, 0x30)?; // signature algorithm
        let (_, issuer, r) = expect(r, 0x30)?;
        let (validity, _, r) = expect(r, 0x30)?;
        let (subject_content, subject, _) = expect(r, 0x30)?;
        let (_, _, _, v) = tlv(validity)?; // not_before
        let (tag, not_after, _, _) = tlv(v)?;
        Ok(Cert {
            issuer,
            not_after: parse_time(tag, not_after)?,
            subject,
            common_name: common_name(subject_content)?,
        })
    }

    fn common_name(mut rdns: &[u8]) -> Result<Option<String>, CertError> {
        while !rdns.is_empty() {
            let (set, _, rest) = expect(rdns, 0x31)?;
            rdns = rest;
            let mut atvs = set;
            while !atvs.is_empty() {
                let (atv, _, rest) = expect(atvs, 0x30)?;
                atvs = rest;
                let (oid, _, value) = expect(atv, 0x06)?;
                if oid == [0x55, 0x04, 0x03] {
                    let (_, s, _, _) = tlv(value)?;
                    return Ok(Some(String::from_utf8_lossy(s).into_owned()));
                }
            }
        }
        Ok(None)
    }

    fn parse_time(tag: u8, s: &[u8]) -> Result<OffsetDateTime, CertError> {
        let s = std::str::from_utf8(s).map_err(|_| err("time"))?;
        let s = s.strip_suffix('Z').ok_or_else(|| err("time zone"))?;
        let (year, rest) = match (tag, s.len()) {
            (0x17, 12) => {
                let yy: i32 = s[..2].parse().map_err(|_| err("time"))?;
                (if yy < 50 { 2000 + yy } else { 1900 + yy }, &s[2..])
            }
            (0x18, 14) => (s[..4].parse().map_err(|_| err("time"))?, &s[4..]),
            _ => return Err(err("time format")),
        };
        let n =
            |i: usize| -> Result<u8, CertError> { rest[i..i + 2].parse().map_err(|_| err("time")) };
        let month = Month::try_from(n(0)?).map_err(|_| err("month"))?;
        let date = Date::from_calendar_date(year, month, n(2)?).map_err(|_| err("date"))?;
        let time = Time::from_hms(n(4)?, n(6)?, n(8)?).map_err(|_| err("time"))?;
        Ok(PrimitiveDateTime::new(date, time).assume_utc())
    }
}
