//! Where the helper keeps things (U3).
//!
//! - State (machine-wide, written by the installer as root/SYSTEM): the leaf certificate and key and
//!   the trusted root's thumbprint. Every user account's helper serves the same leaf.
//! - Runtime (per user, written by the helper itself): logs and the chosen port. The helper never
//!   writes to the state directory.

use std::io;
use std::path::{Path, PathBuf};

/// Development builds may point the state directory elsewhere, so the helper can run without an
/// installer (`SLIDEFIDELITY_HELPER_STATE_DIR`). Release builds ignore it.
fn dev_state_override() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("SLIDEFIDELITY_HELPER_STATE_DIR").map(PathBuf::from)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn state_dir() -> PathBuf {
    dev_state_override()
        .unwrap_or_else(|| PathBuf::from("/Library/Application Support/SlideFidelity/Helper"))
}

#[cfg(target_os = "macos")]
pub fn runtime_dir() -> PathBuf {
    home().join("Library/Application Support/SlideFidelity/Helper")
}

#[cfg(windows)]
pub fn state_dir() -> PathBuf {
    if let Some(d) = dev_state_override() {
        return d;
    }
    env_dir("ProgramData", r"C:\ProgramData").join(r"SlideFidelity\Helper")
}

/// `%LOCALAPPDATA%\SlideFidelity\Helper` of the account the process runs as. Asked of the shell by
/// token rather than read from the environment: a helper started by an installer can inherit
/// another profile's environment.
#[cfg(windows)]
pub fn runtime_dir() -> PathBuf {
    local_app_data()
        .unwrap_or_else(|| env_dir("LOCALAPPDATA", r"C:\Users\Default\AppData\Local"))
        .join(r"SlideFidelity\Helper")
}

#[cfg(windows)]
fn local_app_data() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};
    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: on return `raw` is a NUL-terminated string we own and free, even on failure.
    let hr =
        unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, std::ptr::null_mut(), &mut raw) };
    let path = (hr == 0 && !raw.is_null()).then(|| {
        // SAFETY: `raw` is NUL-terminated.
        let len = unsafe { (0..).take_while(|&i| *raw.add(i) != 0).count() };
        PathBuf::from(std::ffi::OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw, len)
        }))
    });
    // SAFETY: allocated by SHGetKnownFolderPath (null is allowed).
    unsafe { CoTaskMemFree(raw as *const std::ffi::c_void) };
    path
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn state_dir() -> PathBuf {
    if let Some(d) = dev_state_override() {
        return d;
    }
    PathBuf::from("/var/lib/slidefidelity-helper")
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn runtime_dir() -> PathBuf {
    home().join(".local/state/slidefidelity-helper")
}

/// The top directory `install-cert` locks down: `%ProgramData%\SlideFidelity`, because whoever owns it
/// could rename `Helper` away and replace it. A development override locks only itself.
#[cfg(windows)]
pub fn state_lock_root() -> PathBuf {
    let dir = state_dir();
    match (dev_state_override(), dir.parent()) {
        (None, Some(parent)) => parent.to_path_buf(),
        _ => dir,
    }
}

/// Windows `install-cert`, before anything is written: any user may create folders under
/// %ProgramData%, so the state directory may already exist with a user as owner. Remove any
/// junction or symlink standing in for it, create it, make Administrators the owner of the whole
/// tree, and replace every ACL: SYSTEM and Administrators full control, Users read and execute.
#[cfg(windows)]
pub fn lock_state_dir(top: &Path, dir: &Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    for p in [top, dir] {
        if let Ok(m) = std::fs::symlink_metadata(p) {
            if m.file_type().is_symlink() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                // Removes the link itself, never its target.
                std::fs::remove_dir(p).or_else(|_| std::fs::remove_file(p))?;
            }
        }
    }
    std::fs::create_dir_all(dir)?;

    let icacls = env_dir("SystemRoot", r"C:\Windows").join(r"System32\icacls.exe");
    let run = |args: &[&std::ffi::OsStr]| -> io::Result<()> {
        let out = std::process::Command::new(&icacls).args(args).output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "icacls {:?} failed ({}): {}",
                args,
                out.status,
                String::from_utf8_lossy(&out.stdout).trim()
            )))
        }
    };
    let os = std::ffi::OsStr::new;
    // Owner first: an owner can always rewrite the ACL, so a user who pre-created the folder must
    // lose ownership before the ACL is replaced.
    run(&[
        top.as_os_str(),
        os("/setowner"),
        os("*S-1-5-32-544"),
        os("/T"),
        os("/C"),
        os("/Q"),
    ])?;
    // Drop every explicit entry (a planted "Everyone: full control"), then stop inheriting from
    // %ProgramData% and grant exactly SYSTEM, Administrators and Users.
    run(&[top.as_os_str(), os("/reset"), os("/Q")])?;
    run(&[
        top.as_os_str(),
        os("/inheritance:r"),
        os("/grant:r"),
        os("*S-1-5-18:(OI)(CI)F"),
        os("*S-1-5-32-544:(OI)(CI)F"),
        os("*S-1-5-32-545:(OI)(CI)RX"),
        os("/Q"),
    ])?;
    // Everything below inherits only from `top`.
    let children = top.join("*");
    if std::fs::read_dir(top)?.next().is_some() {
        run(&[
            children.as_os_str(),
            os("/reset"),
            os("/T"),
            os("/C"),
            os("/Q"),
        ])?;
    }
    Ok(())
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
