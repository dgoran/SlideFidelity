//! U4: font enumeration (file parsing, grouping, sources, cache, API JSON).

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use slidefidelity_helper::fonts::{scan_dirs, FontCache, FontInventory, Source};
use support::*;

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn family<'a>(inv: &'a FontInventory, key: &str) -> &'a slidefidelity_helper::fonts::Family {
    inv.families.get(key).unwrap_or_else(|| {
        panic!(
            "no family {key:?}; have {:?}",
            inv.families.keys().collect::<Vec<_>>()
        )
    })
}

#[test]
fn synthetic_fonts_are_accepted_by_ttf_parser() {
    for magic in [TRUETYPE, OPENTYPE_CFF, APPLE_TRUE] {
        let data = build_font(magic, &[en(1, "X")]);
        ttf_parser::Face::parse(&data, 0).expect("synthetic face parses");
    }
    let ttc = build_collection(&[vec![en(1, "A")], vec![en(1, "B")]]);
    assert_eq!(ttf_parser::fonts_in_collection(&ttc), Some(2));
    ttf_parser::Face::parse(&ttc, 1).expect("second face parses");
}

#[test]
fn folder_with_ttf_otf_and_two_face_ttc_yields_each_family() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "a.ttf",
        &build_font(TRUETYPE, &[en(1, "Alpha Serif")]),
    );
    write(
        dir.path(),
        "b.otf",
        &build_font(OPENTYPE_CFF, &[mac_en(1, "Beta Grotesk")]),
    );
    write(
        dir.path(),
        "c.ttc",
        &build_collection(&[vec![en(1, "Gamma One")], vec![en(1, "Delta Two")]]),
    );

    let (inv, errors) = scan_dirs(&[(dir.path().to_path_buf(), Source::Os)]);
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(inv.families.len(), 4, "{:?}", inv.families.keys());
    assert_eq!(family(&inv, "alpha serif").name, "Alpha Serif");
    assert_eq!(family(&inv, "beta grotesk").name, "Beta Grotesk");
    assert_eq!(family(&inv, "gamma one").name, "Gamma One");
    assert_eq!(family(&inv, "delta two").name, "Delta Two");
    assert!(family(&inv, "alpha serif").sources.contains(&Source::Os));
}

#[test]
fn localized_names_are_kept_and_family_is_keyed_by_english() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "jp.ttf",
        &build_font(
            TRUETYPE,
            &[win(1, 0x0411, "ヒラギノ角ゴ"), en(1, "Hiragino Fixture")],
        ),
    );
    let (inv, errors) = scan_dirs(&[(dir.path().to_path_buf(), Source::User)]);
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(inv.families.len(), 1);
    let f = family(&inv, "hiragino fixture");
    assert_eq!(f.name, "Hiragino Fixture");
    assert!(
        f.names.contains(&"ヒラギノ角ゴ".to_string()),
        "{:?}",
        f.names
    );
    assert!(f.names.contains(&"Hiragino Fixture".to_string()));
}

#[test]
fn legacy_family_name_is_reachable_under_typographic_family() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "semibold.ttf",
        &build_font(
            TRUETYPE,
            &[
                en(1, "Fixture Sans Semibold"),
                en(2, "Regular"),
                en(16, "Fixture Sans"),
                en(17, "Semibold"),
            ],
        ),
    );
    write(
        dir.path(),
        "regular.ttf",
        &build_font(TRUETYPE, &[en(1, "Fixture Sans"), en(2, "Regular")]),
    );
    let (inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Office)]);
    assert_eq!(
        inv.families.len(),
        1,
        "{:?}",
        inv.families.keys().collect::<Vec<_>>()
    );
    let f = family(&inv, "fixture sans");
    assert_eq!(f.name, "Fixture Sans");
    assert_eq!(f.names, vec!["Fixture Sans", "Fixture Sans Semibold"]);
    // Style names (ID 2/17) are not family names.
    assert!(!f.names.iter().any(|n| n == "Regular" || n == "Semibold"));
}

#[test]
fn wws_family_name_is_collected() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "w.ttf",
        &build_font(
            TRUETYPE,
            &[
                en(1, "Wide Fixture Cond"),
                en(16, "Wide Fixture"),
                en(21, "Wide Fixture Condensed"),
            ],
        ),
    );
    let (inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Os)]);
    let f = family(&inv, "wide fixture");
    assert!(f.names.contains(&"Wide Fixture Condensed".to_string()));
    assert!(f.names.contains(&"Wide Fixture Cond".to_string()));
}

#[test]
fn magic_bytes_decide_not_extensions_and_junk_is_skipped_with_errors() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "no-extension",
        &build_font(OPENTYPE_CFF, &[en(1, "Sniffed Family")]),
    );
    let mut woff = b"wOFF".to_vec();
    woff.extend_from_slice(&[0u8; 64]);
    write(dir.path(), "web.ttf", &woff);
    write(dir.path(), "garbage.otf", b"this is not a font at all");
    write(dir.path(), "empty.ttf", b"");
    // Truncated: right magic, broken directory.
    write(dir.path(), "truncated.ttf", &[0, 1, 0, 0, 0, 9]);

    let (inv, errors) = scan_dirs(&[(dir.path().to_path_buf(), Source::Cloud)]);
    assert_eq!(
        inv.families.keys().collect::<Vec<_>>(),
        vec!["sniffed family"]
    );
    for bad in ["web.ttf", "garbage.otf", "empty.ttf", "truncated.ttf"] {
        assert!(
            errors.iter().any(|e| e.contains(bad)),
            "no error for {bad}: {errors:?}"
        );
    }
}

#[test]
fn missing_root_is_an_error_not_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    let (inv, errors) = scan_dirs(&[(missing, Source::Office)]);
    assert!(inv.families.is_empty());
    assert_eq!(errors.len(), 1, "{errors:?}");
}

#[test]
fn nested_folders_are_walked() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("4/CloudFonts/Some Family");
    std::fs::create_dir_all(&nested).unwrap();
    write(
        &nested,
        "x.ttf",
        &build_font(TRUETYPE, &[en(1, "Deep Cloud")]),
    );
    let (inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Cloud)]);
    assert!(family(&inv, "deep cloud").sources.contains(&Source::Cloud));
}

#[cfg(unix)]
#[test]
fn symlink_loops_do_not_hang() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::os::unix::fs::symlink(dir.path(), sub.join("loop")).unwrap();
    write(&sub, "a.ttf", &build_font(TRUETYPE, &[en(1, "Loop Safe")]));
    let (inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Os)]);
    assert_eq!(inv.families.len(), 1);
}

#[test]
fn same_family_in_two_folders_merges_sources() {
    let office = tempfile::tempdir().unwrap();
    let cloud = tempfile::tempdir().unwrap();
    write(
        office.path(),
        "r.ttf",
        &build_font(TRUETYPE, &[en(1, "Shared Face")]),
    );
    write(
        cloud.path(),
        "b.ttf",
        &build_font(
            TRUETYPE,
            &[en(1, "Shared Face Bold"), en(16, "Shared Face")],
        ),
    );
    let (inv, _) = scan_dirs(&[
        (office.path().to_path_buf(), Source::Office),
        (cloud.path().to_path_buf(), Source::Cloud),
    ]);
    assert_eq!(inv.families.len(), 1);
    let f = family(&inv, "shared face");
    assert_eq!(
        f.sources.iter().copied().collect::<Vec<_>>(),
        vec![Source::Office, Source::Cloud]
    );
    assert!(f.names.contains(&"Shared Face Bold".to_string()));
}

#[test]
fn merge_combines_inventories() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    write(
        a.path(),
        "a.ttf",
        &build_font(TRUETYPE, &[en(1, "Merge Me")]),
    );
    write(
        b.path(),
        "b.ttf",
        &build_font(TRUETYPE, &[en(1, "MERGE ME")]),
    );
    write(b.path(), "c.ttf", &build_font(TRUETYPE, &[en(1, "Other")]));
    let (mut inv, _) = scan_dirs(&[(a.path().to_path_buf(), Source::Os)]);
    let (other, _) = scan_dirs(&[(b.path().to_path_buf(), Source::User)]);
    inv.merge(other);
    assert_eq!(inv.families.len(), 2);
    let f = family(&inv, "merge me");
    assert_eq!(f.name, "Merge Me");
    assert_eq!(f.names, vec!["MERGE ME", "Merge Me"]);
    assert_eq!(f.sources.len(), 2);
}

#[test]
fn api_json_shape() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "z.ttf",
        &build_font(TRUETYPE, &[en(1, "Zeta Semibold"), en(16, "Zeta")]),
    );
    write(
        dir.path(),
        "a.ttf",
        &build_font(TRUETYPE, &[en(1, "Alpha")]),
    );
    let (inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Office)]);
    let at = time::OffsetDateTime::from_unix_timestamp(1_790_856_000).unwrap(); // 2026-10-01T12:00:00Z
    let v = inv.to_api_json(at);
    assert_eq!(
        v,
        serde_json::json!({
            "families": [
                {"name": "Alpha", "names": ["Alpha"], "sources": ["office"]},
                {"name": "Zeta", "names": ["Zeta", "Zeta Semibold"], "sources": ["office"]},
            ],
            "generatedAt": "2026-10-01T12:00:00Z",
        })
    );
}

#[test]
fn source_serializes_lowercase() {
    assert_eq!(
        serde_json::to_value([Source::Os, Source::User, Source::Office, Source::Cloud]).unwrap(),
        serde_json::json!(["os", "user", "office", "cloud"])
    );
}

#[test]
fn variable_font_named_instances_get_their_windows_names() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "var.ttf",
        &build_variable_font(
            &[
                en(1, "Fixture Variable Concept"),
                en(2, "Regular"),
                en(17, "Regular"),
                en(256, "Weight"),
                en(257, "SemiBold"),
                en(258, "Black Italic"),
                en(259, "Bold"),
            ],
            &[17, 257, 258, 259],
        ),
    );
    let (inv, errors) = scan_dirs(&[(dir.path().to_path_buf(), Source::Cloud)]);
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(inv.families.len(), 1, "{:?}", inv.families.keys());
    let names = &family(&inv, "fixture variable concept").names;
    for want in [
        "Fixture Variable Concept",
        "Fixture Variable Concept SemiBold",
        // GDI keeps 31 UTF-16 units of the 37-character name.
        "Fixture Variable Concept Black",
        "Fixture Variable Concept Black Italic",
        "Fixture Variable Concept Bold",
    ] {
        assert!(
            names.contains(&want.to_string()),
            "{want:?} not in {names:?}"
        );
    }
    assert!(
        !names.iter().any(|n| n.contains("Regular")),
        "\"Regular\" is dropped: {names:?}"
    );
}

#[test]
fn registered_names_join_the_family_they_extend() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "v.ttf",
        &build_font(TRUETYPE, &[en(1, "Segoe UI Variable")]),
    );
    write(
        dir.path(),
        "s.ttf",
        &build_font(TRUETYPE, &[en(1, "Segoe UI")]),
    );
    let (mut inv, _) = scan_dirs(&[(dir.path().to_path_buf(), Source::Os)]);

    inv.add_registered_name("Segoe UI Variable Display Semib", Source::Os);
    inv.add_registered_name("segoe ui", Source::Os); // already known: no-op
    inv.add_registered_name("Brand New Face", Source::Os);
    inv.add_registered_name("Segoe UIX", Source::Os); // not a word boundary: its own family

    assert!(family(&inv, "segoe ui variable")
        .names
        .contains(&"Segoe UI Variable Display Semib".to_string()));
    assert_eq!(family(&inv, "segoe ui").names, ["Segoe UI"]);
    assert_eq!(family(&inv, "brand new face").sources.len(), 1);
    assert!(inv.families.contains_key("segoe uix"));
    assert_eq!(inv.families.len(), 4);
}

#[cfg(windows)]
#[test]
fn gdi_reports_installed_windows_fonts() {
    let names = slidefidelity_helper::fonts::windows::gdi_face_names();
    assert!(names.contains("Arial"), "{names:?}");
    assert!(!names.iter().any(|n| n.starts_with('@')));
    let (inv, _) = slidefidelity_helper::fonts::collect();
    for n in &names {
        assert!(
            inv.find(n).is_some(),
            "GDI face {n:?} missing from the inventory"
        );
    }
}

fn bump_mtime(dir: &Path, secs: u64) {
    let later = SystemTime::now() + Duration::from_secs(secs);
    let mut open = std::fs::OpenOptions::new();
    open.read(true);
    #[cfg(windows)]
    {
        // A directory handle needs FILE_FLAG_BACKUP_SEMANTICS; setting times needs
        // FILE_WRITE_ATTRIBUTES.
        use std::os::windows::fs::OpenOptionsExt;
        open.access_mode(0x100).custom_flags(0x0200_0000);
    }
    open.open(dir).unwrap().set_modified(later).unwrap();
}

#[test]
fn cache_rescans_only_when_a_watched_folder_changes() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    write(
        dir.path(),
        "a.ttf",
        &build_font(TRUETYPE, &[en(1, "First")]),
    );
    let cache = FontCache::new(vec![(dir.path().to_path_buf(), Source::Office)], false);

    let first = cache.get();
    assert_eq!(first.families.len(), 1);
    assert_eq!(cache.generation(), 1);

    let again = cache.get();
    assert_eq!(cache.generation(), 1, "nothing changed, no rescan");
    assert!(std::sync::Arc::ptr_eq(&first, &again));

    write(
        dir.path(),
        "b.ttf",
        &build_font(TRUETYPE, &[en(1, "Second")]),
    );
    bump_mtime(dir.path(), 5);
    let after = cache.get();
    assert_eq!(cache.generation(), 2);
    assert_eq!(after.families.len(), 2);

    // A change inside an immediate subfolder is noticed too.
    write(&sub, "c.ttf", &build_font(TRUETYPE, &[en(1, "Third")]));
    bump_mtime(&sub, 10);
    let after = cache.get();
    assert_eq!(cache.generation(), 3);
    assert_eq!(after.families.len(), 3);
}

#[test]
fn cache_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<FontCache>();
}

#[cfg(target_os = "macos")]
#[test]
fn collect_finds_system_and_office_fonts() {
    let (inv, _errors) = slidefidelity_helper::fonts::collect();
    assert!(
        inv.find("Helvetica Neue").is_some(),
        "Helvetica Neue missing"
    );
    let hn = inv.find("helvetica neue").unwrap();
    assert!(hn.sources.contains(&Source::Os));
    if Path::new("/Applications/Microsoft PowerPoint.app").exists() {
        assert!(
            inv.families
                .values()
                .any(|f| f.sources.contains(&Source::Office)),
            "PowerPoint is installed but no office-sourced family was found"
        );
    }
}

/// Every family the reference Python script lists must be matched by some `names` entry.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "shells out to python3; run with --ignored"]
fn parity_with_list_fonts_mac_script() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/list-fonts-mac.py");
    let out = std::process::Command::new("python3")
        .arg(script)
        .output()
        .expect("run python3");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let expected: Vec<String> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    let (inv, _) = slidefidelity_helper::fonts::collect();
    // The script also lists Office's font-picker preview faces (msofp_*), which the helper skips.
    let missing: Vec<&String> = expected
        .iter()
        .filter(|n| !n.starts_with("msofp_") && inv.find(n).is_none())
        .collect();
    eprintln!(
        "parity: script lists {} families; helper has {} families; missing {}: {:?}",
        expected.len(),
        inv.families.len(),
        missing.len(),
        missing
    );
    assert!(missing.is_empty(), "missing: {missing:?}");
}
