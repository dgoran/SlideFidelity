//! U3: CLI surface and platform paths.

use std::process::Command;

fn helper() -> Command {
    Command::new(env!("CARGO_BIN_EXE_slidecheck-helper"))
}

#[test]
fn version_prints_semver_and_api_version() {
    let out = helper().arg("version").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains(env!("CARGO_PKG_VERSION")), "{text}");
    assert!(text.contains("api 1"), "{text}");
}

#[test]
fn unknown_subcommand_exits_non_zero_with_usage() {
    let out = helper().arg("frobnicate").output().unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8(out.stderr).unwrap();
    assert!(err.contains("usage"), "{err}");
}

#[test]
fn help_lists_every_subcommand() {
    let out = helper().arg("--help").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    for cmd in [
        "serve",
        "install-cert",
        "uninstall-cert",
        "fonts",
        "version",
    ] {
        assert!(text.contains(cmd), "missing {cmd} in {text}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn mac_paths_are_documented_locations() {
    use slidecheck_helper::paths;
    assert_eq!(
        paths::state_dir(),
        std::path::Path::new("/Library/Application Support/SlideCheck/Helper")
    );
    let home = std::env::var("HOME").unwrap();
    assert_eq!(
        paths::runtime_dir(),
        std::path::Path::new(&home).join("Library/Application Support/SlideCheck/Helper")
    );
}

#[cfg(windows)]
#[test]
fn windows_paths_are_documented_locations() {
    use slidecheck_helper::paths;
    let pd = std::env::var("ProgramData").unwrap();
    assert_eq!(
        paths::state_dir(),
        std::path::Path::new(&pd).join(r"SlideCheck\Helper")
    );
    let la = std::env::var("LOCALAPPDATA").unwrap();
    assert_eq!(
        paths::runtime_dir(),
        std::path::Path::new(&la).join(r"SlideCheck\Helper")
    );
}

#[test]
fn ensure_dir_creates_missing_directory_with_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("a/b");
    slidecheck_helper::paths::ensure_dir(&dir, 0o700).unwrap();
    assert!(dir.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn config_ports_and_origins() {
    use slidecheck_helper::config;
    assert_eq!(config::PORTS, [47317, 47318, 47319]);
    assert!(config::allowed_origin("https://app.slidecheck.io"));
    assert!(!config::allowed_origin("https://example.com"));
    assert!(!config::allowed_origin("http://app.slidecheck.io"));
    // The dev origin is accepted only in debug builds (tests build in debug).
    assert_eq!(
        config::allowed_origin("https://localhost:3000"),
        cfg!(debug_assertions)
    );
}

#[test]
fn managed_port_outside_the_fixed_list_is_ignored() {
    use slidecheck_helper::config::port_order;
    assert_eq!(port_order(None), vec![47317, 47318, 47319]);
    assert_eq!(port_order(Some(47318)), vec![47318, 47317, 47319]);
    assert_eq!(port_order(Some(8080)), vec![47317, 47318, 47319]);
}
