//! SlideCheck Helper: serves this computer's font families to the SlideCheck PowerPoint add-in
//! over HTTPS on localhost (plan: docs/plans/2026-10-01-2113-feat-slidecheck-helper-plan.md).

pub mod cert;
pub mod config;
pub mod fonts;
pub mod logging;
pub mod paths;
pub mod server;
pub mod update;

/// Version of the HTTP API (`/v1/...`). The add-in refuses helpers with an older API.
pub const API_VERSION: u32 = 1;
