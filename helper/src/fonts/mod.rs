//! Font enumeration (U4): every font family PowerPoint can use on this computer.
//!
//! Family names are read from the font FILES on both platforms (decision H6): every face of every
//! file, name IDs 1, 16 and 21 in all languages. That captures legacy names such as
//! "Segoe UI Semibold" (ID 1), which PowerPoint decks store, as well as typographic names
//! ("Segoe UI", ID 16). Faces are grouped under their English typographic family; the add-in
//! matches a deck typeface case-insensitively against every entry of a family's `names`.
//!
//! Layers:
//! - OS: macOS asks CoreText for the installed font files ([`mac`]); Windows walks the system and
//!   per-user font folders ([`windows`]).
//! - Office: PowerPoint's private fonts and its downloaded cloud fonts ([`office::office_roots`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use time::OffsetDateTime;

#[cfg(target_os = "macos")]
pub mod mac;
pub mod office;
#[cfg(windows)]
pub mod windows;

pub use office::{office_roots, parse_font_bytes, FaceNames};

/// Where a family was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Installed for all users (macOS system/`/Library/Fonts`, `%WINDIR%\Fonts`).
    Os,
    /// Installed for this user only.
    User,
    /// Shipped inside Microsoft Office.
    Office,
    /// Downloaded by Office from its cloud font service.
    Cloud,
}

/// One font family.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Family {
    /// English typographic family name (as first seen).
    pub name: String,
    /// Every distinct family name of every face, localized and legacy included; sorted.
    pub names: Vec<String>,
    pub sources: BTreeSet<Source>,
}

/// Every family found, keyed by the lowercased English family name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FontInventory {
    pub families: BTreeMap<String, Family>,
}

fn fold(name: &str) -> String {
    name.to_lowercase()
}

impl FontInventory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one parsed face.
    pub fn add_face(&mut self, face: &FaceNames, source: Source) {
        self.add_names(&face.family, face.names.iter().cloned(), [source]);
    }

    fn add_names(
        &mut self,
        family: &str,
        names: impl IntoIterator<Item = String>,
        sources: impl IntoIterator<Item = Source>,
    ) {
        let entry = self.families.entry(fold(family)).or_insert_with(|| Family {
            name: family.to_string(),
            names: Vec::new(),
            sources: BTreeSet::new(),
        });
        entry.names.push(family.to_string());
        entry.names.extend(names);
        entry.names.sort();
        entry.names.dedup();
        entry.sources.extend(sources);
    }

    /// Fold `other` into `self`: same-key families union their names and sources.
    pub fn merge(&mut self, other: FontInventory) {
        for (_, f) in other.families {
            self.add_names(&f.name, f.names, f.sources);
        }
    }

    /// The family whose `names` contain `name`, compared case-insensitively (as the add-in does).
    pub fn find(&self, name: &str) -> Option<&Family> {
        let wanted = fold(name.trim());
        if let Some(f) = self.families.get(&wanted) {
            return Some(f);
        }
        self.families
            .values()
            .find(|f| f.names.iter().any(|n| fold(n) == wanted))
    }

    /// The `/v1/fonts` response body:
    /// `{"families":[{"name","names","sources"}], "generatedAt": RFC 3339}`, sorted by key.
    pub fn to_api_json(&self, generated_at: OffsetDateTime) -> serde_json::Value {
        let generated = generated_at
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        serde_json::json!({
            "families": self.families.values().collect::<Vec<_>>(),
            "generatedAt": generated,
        })
    }
}

/// Scan font folders recursively. Never fails: unreadable folders/files and non-font files are
/// reported in the returned errors.
pub fn scan_dirs(roots: &[(PathBuf, Source)]) -> (FontInventory, Vec<String>) {
    let mut inv = FontInventory::new();
    let mut errors = Vec::new();
    for (root, source) in roots {
        office::scan_dir(root, *source, &mut inv, &mut errors);
    }
    (inv, errors)
}

/// Scan the OS layer (installed fonts) of this platform.
pub fn scan_os() -> (FontInventory, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        mac::scan()
    }
    #[cfg(windows)]
    {
        windows::scan()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        (FontInventory::new(), Vec::new())
    }
}

/// Folders whose modification time signals that installed fonts changed (cache invalidation).
fn os_watch_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        mac::watch_roots()
    }
    #[cfg(windows)]
    {
        windows::os_roots().into_iter().map(|(p, _)| p).collect()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

fn scan(roots: &[(PathBuf, Source)], os_layer: bool) -> (FontInventory, Vec<String>) {
    let (mut inv, mut errors) = if os_layer {
        scan_os()
    } else {
        (FontInventory::new(), Vec::new())
    };
    let (office, office_errors) = scan_dirs(roots);
    inv.merge(office);
    errors.extend(office_errors);
    (inv, errors)
}

/// Every family PowerPoint can use here: OS layer plus Office layer. For the `fonts` CLI command.
pub fn collect() -> (FontInventory, Vec<String>) {
    scan(&office_roots(), true)
}

/// How long a scan stays valid even when no watched folder changed.
pub const CACHE_MAX_AGE: Duration = Duration::from_secs(10 * 60);

struct Cached {
    inventory: Arc<FontInventory>,
    stamp: Option<SystemTime>,
    scanned_at: Instant,
}

/// Cached inventory for the server. Rescans when a watched folder (a root or one of its immediate
/// subfolders) has a newer modification time than at the last scan, or after [`CACHE_MAX_AGE`].
pub struct FontCache {
    roots: Vec<(PathBuf, Source)>,
    os_layer: bool,
    state: Mutex<Option<Cached>>,
    generation: AtomicU64,
}

impl FontCache {
    /// `roots` are scanned recursively; `os_layer` adds the platform's installed fonts.
    pub fn new(roots: Vec<(PathBuf, Source)>, os_layer: bool) -> Self {
        Self {
            roots,
            os_layer,
            state: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    /// The real thing: OS layer plus this platform's Office folders.
    pub fn system() -> Self {
        Self::new(office_roots(), true)
    }

    /// Number of scans performed so far (for tests and logging).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// The current inventory, rescanning first if it is stale.
    pub fn get(&self) -> Arc<FontInventory> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let stamp = self.stamp();
        if let Some(c) = state.as_ref() {
            if c.stamp == stamp && c.scanned_at.elapsed() < CACHE_MAX_AGE {
                return c.inventory.clone();
            }
        }
        let started = Instant::now();
        let (inv, errors) = scan(&self.roots, self.os_layer);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!(
            families = inv.families.len(),
            skipped = errors.len(),
            ms = started.elapsed().as_millis() as u64,
            generation,
            "font scan"
        );
        for e in errors.iter().take(20) {
            tracing::debug!("font scan: {e}");
        }
        let inventory = Arc::new(inv);
        *state = Some(Cached {
            inventory: inventory.clone(),
            stamp,
            scanned_at: Instant::now(),
        });
        inventory
    }

    /// Newest modification time among watched folders and their immediate subfolders.
    fn stamp(&self) -> Option<SystemTime> {
        let mut dirs: Vec<PathBuf> = self.roots.iter().map(|(p, _)| p.clone()).collect();
        if self.os_layer {
            dirs.extend(os_watch_roots());
        }
        let mut newest: Option<SystemTime> = None;
        let mut consider = |p: &std::path::Path| {
            if let Ok(t) = std::fs::metadata(p).and_then(|m| m.modified()) {
                newest = Some(newest.map_or(t, |n| n.max(t)));
            }
        };
        for dir in &dirs {
            consider(dir);
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        consider(&e.path());
                    }
                }
            }
        }
        newest
    }
}
