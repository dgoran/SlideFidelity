//! Fixed configuration (KTD7, KTD8) and the administrator-managed settings.

/// Ports tried in order (KTD8). The add-in probes all three, so a helper must never use another port.
pub const PORTS: [u16; 3] = [47317, 47318, 47319];

/// Managed-preferences domain on macOS and registry key under HKLM on Windows.
pub const PREFS_DOMAIN: &str = "io.slidecheck.helper";
#[cfg(windows)]
pub const PREFS_KEY: &str = r"Software\SlideCheck\Helper";

const PROD_ORIGINS: &[&str] = &["https://app.slidecheck.io"];
#[cfg(any(debug_assertions, feature = "dev-origin"))]
const DEV_ORIGINS: &[&str] = &["https://localhost:3000"];
#[cfg(not(any(debug_assertions, feature = "dev-origin")))]
const DEV_ORIGINS: &[&str] = &[];

/// Whether `origin` may call the API. Exact match only: scheme, host and port.
pub fn allowed_origin(origin: &str) -> bool {
    PROD_ORIGINS.contains(&origin) || DEV_ORIGINS.contains(&origin)
}

/// The production allowlist only, as a release build sees it.
pub fn allowed_origin_release(origin: &str) -> bool {
    PROD_ORIGINS.contains(&origin)
}

/// Port order for binding: a managed preferred port moves to the front, but only if it is one of
/// the fixed ports; anything else is ignored, because the add-in would never find it.
pub fn port_order(preferred: Option<u16>) -> Vec<u16> {
    let mut ports = PORTS.to_vec();
    if let Some(p) = preferred.filter(|p| PORTS.contains(p)) {
        ports.retain(|&x| x != p);
        ports.insert(0, p);
    }
    ports
}

/// Administrator-managed settings (Jamf configuration profile / Intune registry policy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Managed {
    /// `AutoUpdate=false` (Mac) or `AutoUpdate=0` (Windows) turns off update checks.
    pub auto_update: bool,
    /// `Port`: preferred port; honoured only when it is one of [`PORTS`].
    pub port: Option<u16>,
}

impl Default for Managed {
    fn default() -> Self {
        Self {
            auto_update: true,
            port: None,
        }
    }
}

impl Managed {
    pub fn load() -> Self {
        platform::load()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Managed, PREFS_DOMAIN};
    use objc2_core_foundation::{
        CFPreferencesGetAppBooleanValue, CFPreferencesGetAppIntegerValue, CFString,
    };

    pub fn load() -> Managed {
        let app = CFString::from_static_str(PREFS_DOMAIN);
        let mut out = Managed::default();
        let mut valid: u8 = 0;
        let auto = unsafe {
            CFPreferencesGetAppBooleanValue(
                &CFString::from_static_str("AutoUpdate"),
                &app,
                &mut valid,
            )
        };
        if valid != 0 {
            out.auto_update = auto;
        }
        let mut valid: u8 = 0;
        let port = unsafe {
            CFPreferencesGetAppIntegerValue(&CFString::from_static_str("Port"), &app, &mut valid)
        };
        if valid != 0 {
            out.port = u16::try_from(port).ok();
        }
        out
    }
}

#[cfg(windows)]
mod platform {
    //! Intune / GPO policy: DWORD values under `HKLM\Software\SlideCheck\Helper`. The helper is a
    //! 64-bit binary, so this reads the native (not WOW6432Node) view, where the MSI writes too.
    use super::{Managed, PREFS_KEY};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The DWORD `name`, or `None` when the key or value is missing or not a DWORD.
    fn read_dword(name: &str) -> Option<u32> {
        let key = wide(PREFS_KEY);
        let value = wide(name);
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: NUL-terminated UTF-16 key and value names; `data` holds exactly `size` bytes.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                &mut data as *mut u32 as *mut c_void,
                &mut size,
            )
        };
        (rc == ERROR_SUCCESS).then_some(data)
    }

    pub fn load() -> Managed {
        let mut out = Managed::default();
        if let Some(v) = read_dword("AutoUpdate") {
            out.auto_update = v != 0;
        }
        out.port = read_dword("Port").and_then(|p| u16::try_from(p).ok());
        out
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Managed;
    pub fn load() -> Managed {
        Managed::default()
    }
}
