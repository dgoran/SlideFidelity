//! macOS OS layer: ask CoreText which font files are installed, then parse those files.
//!
//! Files under `~/Library/Fonts` are `user`; everything else CoreText reports (`/System/Library`,
//! `/Library/Fonts`, downloaded system assets) is `os`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use objc2_core_foundation::{CFRetained, CFString, CFURL};
use objc2_core_text::{
    CTFontManagerCopyAvailableFontFamilyNames, CTFontManagerCopyAvailableFontURLs,
};

use super::{office, FontInventory, Source};

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Installed font files, as CoreText reports them.
pub fn installed_font_files() -> Vec<PathBuf> {
    // SAFETY: plain CoreText query with no arguments; returns a retained CFArray of CFURLs.
    let urls = unsafe { CTFontManagerCopyAvailableFontURLs() };
    // SAFETY: documented to contain CFURLs.
    let urls = unsafe { urls.cast_unchecked::<CFURL>() };
    let set: BTreeSet<PathBuf> = urls
        .iter()
        .filter_map(|u: CFRetained<CFURL>| u.to_file_path())
        .collect();
    set.into_iter().collect()
}

/// CoreText's own list of family names (non-hidden).
pub fn coretext_family_names() -> Vec<String> {
    // SAFETY: plain CoreText query; returns a retained CFArray of CFStrings.
    let names = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
    // SAFETY: documented to contain CFStrings.
    let names = unsafe { names.cast_unchecked::<CFString>() };
    names
        .iter()
        .map(|s: CFRetained<CFString>| s.to_string())
        .filter(|s| !s.is_empty() && !s.starts_with('.'))
        .collect()
}

fn source_for(path: &Path, user_fonts: &Path) -> Source {
    if path.starts_with(user_fonts) {
        Source::User
    } else {
        Source::Os
    }
}

/// Scan every installed font file. CoreText family names that no parsed file produced (rare) are
/// added as their own `os` family so nothing CoreText can render is reported missing.
pub fn scan() -> (FontInventory, Vec<String>) {
    let user_fonts = home().join("Library/Fonts");
    let mut inv = FontInventory::new();
    let mut errors = Vec::new();
    for path in installed_font_files() {
        let source = source_for(&path, &user_fonts);
        office::scan_file(&path, source, &mut inv, &mut errors);
    }
    let known: std::collections::HashSet<String> = inv
        .families
        .values()
        .flat_map(|f| f.names.iter().map(|n| n.to_lowercase()))
        .collect();
    for name in coretext_family_names() {
        if !known.contains(&name.to_lowercase()) {
            inv.add_names(&name, std::iter::empty(), [Source::Os]);
        }
    }
    (inv, errors)
}

/// Folders whose modification time changes when fonts are installed or removed.
pub fn watch_roots() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Library/Fonts"),
        home().join("Library/Fonts"),
        PathBuf::from("/System/Library/Fonts"),
    ]
}
