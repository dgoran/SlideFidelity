use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use slidecheck_helper::cert::{self, CertPaths, InstallOptions, InstallOutcome, SystemTrustStore};
use slidecheck_helper::config::{self, Managed};
use slidecheck_helper::fonts::{self, FontCache};
use slidecheck_helper::server::{self, ServerState};
use slidecheck_helper::update::{self, HttpFetch, Platform, UpdateState};
use slidecheck_helper::{logging, paths, API_VERSION};

const USAGE: &str = "usage: slidecheck-helper <command>

commands:
  serve            run the HTTPS font service (default; started at login)
  install-cert     create and trust this computer's localhost certificate (installer, as root/SYSTEM)
  uninstall-cert   remove the certificate and its trust (uninstaller, as root/SYSTEM)
  fonts            print this computer's font families as JSON
  version          print the helper and API versions";

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    match cmd.as_str() {
        "version" | "--version" => {
            println!(
                "slidecheck-helper {} (api {API_VERSION})",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::SUCCESS
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        "fonts" => {
            let _guard = logging::init(false);
            let (inv, errors) = fonts::collect();
            for e in &errors {
                tracing::debug!("{e}");
            }
            println!("{:#}", inv.to_api_json(time::OffsetDateTime::now_utc()));
            ExitCode::SUCCESS
        }
        "install-cert" => {
            let _guard = logging::init(false);
            match cert::install_cert(
                &SystemTrustStore,
                &paths::state_dir(),
                &InstallOptions::native(),
            ) {
                Ok(InstallOutcome::Untrusted { reason, .. }) => {
                    // macOS refuses trust changes without a user session (H2); the helper asks
                    // the user at login instead, so installation still succeeds.
                    tracing::warn!("certificate created but not yet trusted: {reason}");
                    ExitCode::SUCCESS
                }
                Ok(outcome) => {
                    tracing::info!("install-cert: {outcome:?}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    tracing::error!("install-cert failed: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        "uninstall-cert" => {
            let _guard = logging::init(false);
            match cert::uninstall_cert(&SystemTrustStore, &paths::state_dir()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    tracing::error!("uninstall-cert failed: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        "serve" => {
            let _guard = logging::init(true);
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            match rt.block_on(serve()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    tracing::error!("serve stopped: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        other => {
            eprintln!("unknown command `{other}`\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state_dir = paths::state_dir();
    let certs = CertPaths::in_dir(&state_dir);

    // Without a certificate there is nothing to serve. Wait rather than exit: auto-start would
    // restart us in a tight loop (and, on macOS, re-ask for trust each time).
    let mut warned = false;
    while !(certs.leaf_pem.exists() && certs.leaf_key.exists()) {
        if !warned {
            tracing::warn!(
                "no certificate in {}; waiting for the installer",
                state_dir.display()
            );
            warned = true;
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }

    // Asked once per start; if the user declines, keep running so a later approval works
    // without a restart of the pane.
    let store = SystemTrustStore;
    let dir = state_dir.clone();
    match tokio::task::spawn_blocking(move || cert::ensure_user_trust(&store, &dir)).await? {
        Ok(status) => tracing::info!("certificate trust: {status:?}"),
        Err(e) => tracing::warn!("certificate not trusted: {e}"),
    }
    let cert_days_remaining = std::fs::read_to_string(&certs.leaf_pem)
        .ok()
        .and_then(|p| cert::days_remaining(&p).ok());

    let managed = Managed::load();
    let bound = server::bind_first_free(&config::port_order(managed.port))?;
    let port = bound.port;
    if paths::ensure_dir(&paths::runtime_dir(), 0o700).is_ok() {
        let _ = std::fs::write(paths::port_file(), format!("{port}\n"));
    }

    let fonts = Arc::new(FontCache::system());
    let warm = fonts.clone();
    tokio::task::spawn_blocking(move || warm.get());

    let updates = UpdateState::new();
    if let Some(platform) = Platform::current() {
        let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
        let fetch = HttpFetch::new(&current).map_err(|e| e.0)?;
        tokio::spawn(update::run_scheduler(
            updates.clone(),
            managed.clone(),
            fetch,
            current,
            update::FEED_PUBLIC_KEY.into(),
            platform,
            update::CHECK_INTERVAL,
        ));
    }

    let tls =
        axum_server::tls_rustls::RustlsConfig::from_pem_file(&certs.leaf_pem, &certs.leaf_key)
            .await?;
    let app = server::router(ServerState {
        fonts,
        update: updates,
        cert_days_remaining,
        port,
        allow_origin: config::allowed_origin,
    });
    let handle = axum_server::Handle::new();
    let stop = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        stop.graceful_shutdown(Some(Duration::from_secs(2)));
    });
    tracing::info!("serving on https://localhost:{port} (127.0.0.1 and ::1)");
    server::serve(bound, tls, app, handle).await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
