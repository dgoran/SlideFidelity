//! Fixed configuration (KTD7, KTD8) and the administrator-managed settings.

/// Ports tried in order (KTD8). The add-in probes all three, so a helper must never use another port.
pub const PORTS: [u16; 3] = [47317, 47318, 47319];

/// Managed-preferences domain on macOS and registry key under HKLM on Windows.
pub const PREFS_DOMAIN: &str = "io.slidecheck.helper";
#[cfg(windows)]
pub const PREFS_KEY: &str = r"Software\SlideCheck\Helper";

const PROD_ORIGINS: &[&str] = &["https://app.slidecheck.io"];
#[cfg(debug_assertions)]
const DEV_ORIGINS: &[&str] = &["https://localhost:3000"];
#[cfg(not(debug_assertions))]
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
    use super::Managed;

    /// Registry reading lands with the Windows work (U2/U9 gate); defaults until then.
    pub fn load() -> Managed {
        Managed::default()
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Managed;
    pub fn load() -> Managed {
        Managed::default()
    }
}
