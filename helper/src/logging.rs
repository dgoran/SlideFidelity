//! Logging: a daily-rotating file in the per-user runtime directory, plus stderr.

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::paths;

/// Initialise logging. Keep the guard alive for the life of the process.
pub fn init(to_file: bool) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_env("SLIDEFIDELITY_HELPER_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let stderr = fmt::layer().with_writer(std::io::stderr).with_target(false);
    if to_file && paths::ensure_dir(&paths::log_dir(), 0o700).is_ok() {
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("helper")
            .filename_suffix("log")
            .max_log_files(7)
            .build(paths::log_dir());
        if let Ok(appender) = appender {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let file = fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_target(false);
            tracing_subscriber::registry()
                .with(filter)
                .with(stderr)
                .with(file)
                .init();
            return Some(guard);
        }
    }
    tracing_subscriber::registry()
        .with(filter)
        .with(stderr)
        .init();
    None
}
