//! Platform-neutral font file handling: walking font folders, sniffing and parsing font files, and
//! the Office font folder locations (PowerPoint's private fonts and its downloaded cloud fonts).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::{FontInventory, Source};

/// Files larger than this are skipped (no real font comes close; protects memory).
pub const MAX_FONT_FILE_BYTES: u64 = 64 * 1024 * 1024;

const NAME_FAMILY: u16 = 1;
const NAME_TYPOGRAPHIC_FAMILY: u16 = 16;
const NAME_WWS_FAMILY: u16 = 21;

/// The family names of one face.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceNames {
    /// The name the face is grouped under: English typographic family (ID 16), else English
    /// legacy family (ID 1), else the best other decodable family name.
    pub family: String,
    /// Every distinct ID 1/16/21 string in every language (includes `family`).
    pub names: Vec<String>,
}

/// Parse a font file's bytes into one entry per face. Decides by magic bytes, not by extension.
/// Faces without any usable family name are dropped silently.
pub fn parse_font_bytes(data: &[u8]) -> Result<Vec<FaceNames>, String> {
    let magic: [u8; 4] = match data.get(..4) {
        Some(m) => m.try_into().unwrap(),
        None => return Err("too short to be a font".into()),
    };
    let faces: u32 = match &magic {
        [0, 1, 0, 0] | b"true" | b"OTTO" => 1,
        b"ttcf" => ttf_parser::fonts_in_collection(data)
            .ok_or_else(|| "unreadable font collection header".to_string())?,
        b"wOFF" | b"wOF2" => return Err("web font (WOFF) is not usable by PowerPoint".into()),
        _ => return Err("not a font file".into()),
    };
    let mut out = Vec::new();
    let mut last_err = None;
    for index in 0..faces {
        match face_names(data, index) {
            Ok(Some(f)) => out.push(f),
            Ok(None) => {}
            Err(e) => last_err = Some(format!("face {index}: {e}")),
        }
    }
    match (out.is_empty(), last_err) {
        (true, Some(e)) => Err(e),
        _ => Ok(out),
    }
}

fn face_names(data: &[u8], index: u32) -> Result<Option<FaceNames>, String> {
    let raw = ttf_parser::RawFace::parse(data, index).map_err(|e| e.to_string())?;
    let table = raw
        .table(ttf_parser::Tag::from_bytes(b"name"))
        .ok_or("no name table")?;
    let table = ttf_parser::name::Table::parse(table).ok_or("unreadable name table")?;

    // (name_id, rank, value); lower rank = more English.
    let mut found: Vec<(u16, u8, String)> = Vec::new();
    for rec in table.names {
        if !matches!(
            rec.name_id,
            NAME_FAMILY | NAME_TYPOGRAPHIC_FAMILY | NAME_WWS_FAMILY
        ) {
            continue;
        }
        let Some(value) = decode(&rec) else { continue };
        let value = value.trim().trim_matches('\0').trim().to_string();
        if value.is_empty() || value.starts_with('.') {
            continue;
        }
        found.push((rec.name_id, english_rank(&rec), value));
    }
    if found.is_empty() {
        return Ok(None);
    }

    let best = |id: u16| {
        found
            .iter()
            .filter(|(i, _, _)| *i == id)
            .min_by_key(|(_, rank, _)| *rank)
            .map(|(_, rank, v)| (*rank, v.clone()))
    };
    let family = match (best(NAME_TYPOGRAPHIC_FAMILY), best(NAME_FAMILY)) {
        (Some((t_rank, t)), Some((f_rank, f))) => {
            // Prefer the typographic name unless only the legacy one is English.
            if f_rank < t_rank && t_rank >= RANK_OTHER {
                f
            } else {
                t
            }
        }
        (Some((_, t)), None) => t,
        (None, Some((_, f))) => f,
        (None, None) => best(NAME_WWS_FAMILY).map(|(_, v)| v).unwrap(),
    };

    let mut names: Vec<String> = found.into_iter().map(|(_, _, v)| v).collect();
    names.extend(instance_names(&raw, &table, &family));
    names.sort();
    names.dedup();
    Ok(Some(FaceNames { family, names }))
}

/// GDI's longest face name (LF_FACESIZE minus the terminating NUL), in UTF-16 units.
const GDI_FACE_CHARS: usize = 31;

/// The names Windows gives a variable font's named instances. GDI, and so PowerPoint for Windows,
/// lists each `fvar` instance as its own family, "<family> <instance subfamily>", with "Regular"
/// dropped and the result cut to 31 characters: "Bahnschrift SemiBold",
/// "Segoe UI Variable Display Semib". Style-linked endings ("Bold", "Italic", "Bold Italic") are
/// also tried without, since GDI may fold them into the base family.
fn instance_names(
    raw: &ttf_parser::RawFace<'_>,
    table: &ttf_parser::name::Table<'_>,
    family: &str,
) -> Vec<String> {
    let Some(fvar) = raw.table(ttf_parser::Tag::from_bytes(b"fvar")) else {
        return Vec::new();
    };
    let u16_at = |at: usize| Some(u16::from_be_bytes(fvar.get(at..at + 2)?.try_into().ok()?));
    let (Some(axes_offset), Some(axis_count), Some(count), Some(size)) =
        (u16_at(4), u16_at(8), u16_at(12), u16_at(14))
    else {
        return Vec::new();
    };
    let first = axes_offset as usize + axis_count as usize * 20;
    let mut out = Vec::new();
    for i in 0..count as usize {
        // Each instance record starts with its subfamilyNameID.
        let Some(id) = u16_at(first + i * size as usize) else {
            break;
        };
        let Some(sub) = english_name(table, id) else {
            continue;
        };
        let words: Vec<&str> = sub
            .split_whitespace()
            .filter(|w| !w.eq_ignore_ascii_case("Regular"))
            .collect();
        let mut variants = vec![words.clone()];
        let mut linked = words;
        while linked
            .last()
            .is_some_and(|w| w.eq_ignore_ascii_case("Bold") || w.eq_ignore_ascii_case("Italic"))
        {
            linked.pop();
            variants.push(linked.clone());
        }
        for v in variants {
            let full = std::iter::once(family)
                .chain(v)
                .collect::<Vec<_>>()
                .join(" ");
            let gdi: Vec<u16> = full.encode_utf16().take(GDI_FACE_CHARS).collect();
            if let Ok(cut) = String::from_utf16(&gdi) {
                out.push(cut.trim_end().to_string());
            }
            out.push(full);
        }
    }
    out
}

/// The most English decodable string for `name_id`.
fn english_name(table: &ttf_parser::name::Table<'_>, name_id: u16) -> Option<String> {
    table
        .names
        .into_iter()
        .filter(|rec| rec.name_id == name_id)
        .filter_map(|rec| Some((english_rank(&rec), decode(&rec)?)))
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

const RANK_OTHER: u8 = 4;

fn english_rank(rec: &ttf_parser::name::Name) -> u8 {
    use ttf_parser::PlatformId;
    match rec.platform_id {
        PlatformId::Windows if rec.language_id == 0x0409 => 0,
        PlatformId::Macintosh if rec.language_id == 0 => 1,
        PlatformId::Unicode => 2,
        PlatformId::Windows if rec.language_id & 0xFF == 0x09 => 3, // other English locales
        _ => RANK_OTHER,
    }
}

fn decode(rec: &ttf_parser::name::Name) -> Option<String> {
    if rec.is_unicode() {
        return rec.to_string();
    }
    // Macintosh platform, Roman encoding (any language using it).
    if rec.platform_id == ttf_parser::PlatformId::Macintosh && rec.encoding_id == 0 {
        return Some(rec.name.iter().map(|&b| mac_roman(b)).collect());
    }
    None
}

fn mac_roman(b: u8) -> char {
    const HIGH: &str = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u{A0}ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u{F8FF}ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
    if b < 0x80 {
        b as char
    } else {
        HIGH.chars().nth((b - 0x80) as usize).unwrap_or('\u{FFFD}')
    }
}

/// Read and parse one file, adding its faces to `inv`. Problems go to `errors`.
pub fn scan_file(path: &Path, source: Source, inv: &mut FontInventory, errors: &mut Vec<String>) {
    match fs::metadata(path) {
        Ok(m) if m.len() > MAX_FONT_FILE_BYTES => {
            errors.push(format!("{}: skipped, larger than 64 MB", path.display()));
            return;
        }
        Ok(_) => {}
        Err(e) => {
            errors.push(format!("{}: {e}", path.display()));
            return;
        }
    }
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            errors.push(format!("{}: {e}", path.display()));
            return;
        }
    };
    match parse_font_bytes(&data) {
        Ok(faces) => {
            for face in faces {
                inv.add_face(&face, source);
            }
        }
        Err(e) => errors.push(format!("{}: {e}", path.display())),
    }
}

/// Recursively scan a folder. Directory symlinks are not followed (no loops); file symlinks are.
/// Hidden files (".DS_Store" and the like) are ignored without an error.
pub fn scan_dir(root: &Path, source: Source, inv: &mut FontInventory, errors: &mut Vec<String>) {
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    errors.push(format!("{}: {e}", dir.display()));
                    continue;
                }
            };
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                // Office's font-picker preview images (`msofp_*` faces), not usable fonts.
                if entry.file_name() != "PreviewFont" {
                    stack.push(path);
                }
            } else if ft.is_file() {
                files.push(path);
            } else if ft.is_symlink() {
                // Follow file symlinks only.
                if fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false) {
                    files.push(path);
                }
            }
        }
        files.sort();
        for f in files {
            scan_file(&f, source, inv, errors);
        }
    }
}

/// Office's own font folders on this platform: fonts shipped inside PowerPoint (`office`) and the
/// cloud fonts it has downloaded (`cloud`). macOS does not register these for other apps.
#[cfg(target_os = "macos")]
pub fn office_roots() -> Vec<(PathBuf, Source)> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    vec![
        (
            PathBuf::from("/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts"),
            Source::Office,
        ),
        (
            home.join("Library/Group Containers/UBF8T346G9.Office/FontCache"),
            Source::Cloud,
        ),
    ]
}

#[cfg(windows)]
pub fn office_roots() -> Vec<(PathBuf, Source)> {
    let mut roots = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var) {
            roots.push((
                PathBuf::from(pf).join(r"Microsoft Office\root\vfs\Fonts\private"),
                Source::Office,
            ));
        }
    }
    roots.dedup_by(|a, b| a.0 == b.0);
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push((
            PathBuf::from(local).join(r"Microsoft\FontCache\4\CloudFonts"),
            Source::Cloud,
        ));
    }
    roots
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn office_roots() -> Vec<(PathBuf, Source)> {
    Vec::new()
}
