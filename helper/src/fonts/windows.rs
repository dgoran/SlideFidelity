//! Windows OS layer: walk the machine-wide and per-user font folders and parse the files.
//! (DirectWrite enumeration may replace or supplement this later.)

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

/// Scan the installed font folders. A missing per-user folder is normal and not reported.
pub fn scan() -> (FontInventory, Vec<String>) {
    let mut inv = FontInventory::new();
    let mut errors = Vec::new();
    for (root, source) in os_roots() {
        if source == Source::User && !root.exists() {
            continue;
        }
        office::scan_dir(&root, source, &mut inv, &mut errors);
    }
    (inv, errors)
}
