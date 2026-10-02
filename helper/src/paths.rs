//! Where the helper keeps things (U3).
//!
//! - State (machine-wide, written by the installer as root/SYSTEM): the leaf certificate and key and
//!   the trusted root's thumbprint. Every user account's helper serves the same leaf.
//! - Runtime (per user, written by the helper itself): logs and the chosen port. The helper never
//!   writes to the state directory.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
pub fn state_dir() -> PathBuf {
    PathBuf::from("/Library/Application Support/SlideCheck/Helper")
}

#[cfg(target_os = "macos")]
pub fn runtime_dir() -> PathBuf {
    home().join("Library/Application Support/SlideCheck/Helper")
}

#[cfg(windows)]
pub fn state_dir() -> PathBuf {
    env_dir("ProgramData", r"C:\ProgramData").join(r"SlideCheck\Helper")
}

#[cfg(windows)]
pub fn runtime_dir() -> PathBuf {
    env_dir("LOCALAPPDATA", r"C:\Users\Default\AppData\Local").join(r"SlideCheck\Helper")
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn state_dir() -> PathBuf {
    PathBuf::from("/var/lib/slidecheck-helper")
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn runtime_dir() -> PathBuf {
    home().join(".local/state/slidecheck-helper")
}

#[cfg(windows)]
fn env_dir(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

#[cfg(not(windows))]
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn leaf_cert_path() -> PathBuf {
    state_dir().join("leaf.pem")
}
pub fn leaf_key_path() -> PathBuf {
    state_dir().join("leaf.key")
}
pub fn root_thumbprint_path() -> PathBuf {
    state_dir().join("root.sha256")
}
pub fn port_file() -> PathBuf {
    runtime_dir().join("port")
}
pub fn log_dir() -> PathBuf {
    runtime_dir().join("logs")
}

/// Create `dir` (and parents) if missing; on Unix set its mode.
pub fn ensure_dir(dir: &Path, mode: u32) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}
