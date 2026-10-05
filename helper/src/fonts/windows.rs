//! Windows OS layer: walk the machine-wide and per-user font folders and parse the files, then add
//! the face names GDI reports for the registered fonts.
//!
//! File parsing alone misses the names Windows derives for variable fonts' named instances from
//! their `STAT` table ("Segoe UI Variable Display Semib", "Nunito Sans 10pt Normal Light"). GDI's
//! list is exactly what PowerPoint for Windows offers and stores in decks, so it is authoritative
//! for registered fonts. Office's private and cloud fonts are not registered and stay file-only.

use std::collections::BTreeSet;
use std::path::PathBuf;

use super::{office, FontInventory, Source};

/// `%WINDIR%\Fonts` (`os`) and `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (`user`).
pub fn os_roots() -> Vec<(PathBuf, Source)> {
    let windir = std::env::var_os("WINDIR")
        .or_else(|| std::env::var_os("SystemRoot"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut roots = vec![(windir.join("Fonts"), Source::Os)];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push((
            PathBuf::from(local).join(r"Microsoft\Windows\Fonts"),
            Source::User,
        ));
    }
    roots
}

/// Scan the installed font folders, then add GDI's face names. A missing per-user folder is
/// normal and not reported.
pub fn scan() -> (FontInventory, Vec<String>) {
    let mut inv = FontInventory::new();
    let mut errors = Vec::new();
    for (root, source) in os_roots() {
        if source == Source::User && !root.exists() {
            continue;
        }
        office::scan_dir(&root, source, &mut inv, &mut errors);
    }
    for name in gdi_face_names() {
        inv.add_registered_name(&name, Source::Os);
    }
    (inv, errors)
}

/// Every face name GDI enumerates for this user (machine and per-user fonts), without the
/// vertical-writing `@` duplicates.
pub fn gdi_face_names() -> BTreeSet<String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn collect(
        lf: *const LOGFONTW,
        _tm: *const TEXTMETRICW,
        _font_type: u32,
        out: LPARAM,
    ) -> i32 {
        // SAFETY: GDI passes a valid LOGFONTW; `out` is the BTreeSet passed below.
        let (lf, out) = unsafe { (&*lf, &mut *(out as *mut BTreeSet<String>)) };
        let len = lf
            .lfFaceName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(lf.lfFaceName.len());
        let name = String::from_utf16_lossy(&lf.lfFaceName[..len]);
        if !name.is_empty() && !name.starts_with('@') {
            out.insert(name);
        }
        1
    }

    let mut names = BTreeSet::new();
    // SAFETY: a screen DC is valid until released; the callback only runs during the call.
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            tracing::warn!("GDI font enumeration: no screen DC");
            return names;
        }
        let mut lf: LOGFONTW = std::mem::zeroed();
        lf.lfCharSet = DEFAULT_CHARSET;
        EnumFontFamiliesExW(
            dc,
            &lf,
            Some(collect),
            &mut names as *mut BTreeSet<String> as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), dc);
    }
    names
}
