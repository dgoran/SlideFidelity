//! U5: the HTTPS API on loopback (KTD7, KTD8).
//!
//! Every request passes the guard before routing: the `Host` must be a loopback name with the
//! helper's own port (DNS-rebinding defence) and the `Origin` must be on the allowlist; anything
//! else gets an empty 403. Only GET and CORS/Private Network Access preflights are served.

use std::future::Future;
use std::io;
use std::net::{Ipv6Addr, SocketAddr, TcpListener};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use serde_json::json;
use time::OffsetDateTime;

use crate::fonts::FontCache;
use crate::update::UpdateState;
use crate::API_VERSION;

/// What the handlers and the guard need.
#[derive(Clone)]
pub struct ServerState {
    pub fonts: Arc<FontCache>,
    pub update: UpdateState,
    /// Days until the TLS leaf expires, reported so the pane can ask for renewal (H1).
    pub cert_days_remaining: Option<i64>,
    /// The port this server is bound to; `Host` must name it.
    pub port: u16,
    /// Origin allowlist (`config::allowed_origin` in production).
    pub allow_origin: fn(&str) -> bool,
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/fonts", get(fonts))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn loopback_host(host: &str, port: u16) -> bool {
    let host = host.to_ascii_lowercase();
    ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|name| host == format!("{name}:{port}"))
}

fn forbidden() -> Response {
    StatusCode::FORBIDDEN.into_response()
}

async fn guard(State(st): State<ServerState>, req: Request, next: Next) -> Response {
    // Read what the guard needs into owned values: the request body is not `Sync`, so no borrow
    // of the request may live across the `await` below.
    let (host, authority, origin) = {
        let get = |name| {
            req.headers()
                .get(name)
                .and_then(|v: &HeaderValue| v.to_str().ok())
                .map(str::to_owned)
        };
        let authority = req.uri().authority().map(|a| a.as_str().to_owned());
        (get(header::HOST), authority, get(header::ORIGIN))
    };
    // HTTP/1.1 names the host in `Host`; HTTP/2 in `:authority` (the URI's authority). At least
    // one must be present, and every one present must be loopback with our port.
    let names: Vec<&str> = [host.as_deref(), authority.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let host_ok = !names.is_empty() && names.iter().all(|h| loopback_host(h, st.port));
    let allowed = origin.clone().filter(|o| host_ok && (st.allow_origin)(o));
    let Some(origin) = allowed else {
        tracing::debug!(
            "rejected {} {} host={host:?} origin={origin:?}",
            req.method(),
            req.uri().path()
        );
        return forbidden();
    };

    let mut res = if req.method() == Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        let h = r.headers_mut();
        h.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET"),
        );
        h.insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
        h.insert("access-control-max-age", HeaderValue::from_static("600"));
        r
    } else {
        next.run(req).await
    };
    let h: &mut HeaderMap = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&origin) {
        h.insert("access-control-allow-origin", v);
    }
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    res
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "windows"
    } else {
        "other"
    }
}

async fn health(State(st): State<ServerState>) -> Json<serde_json::Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "platform": platform(),
        "certDaysRemaining": st.cert_days_remaining,
        "update": st.update.get(),
    }))
}

async fn fonts(State(st): State<ServerState>) -> Response {
    let cache = st.fonts.clone();
    match tokio::task::spawn_blocking(move || cache.get()).await {
        Ok(inv) => Json(inv.to_api_json(OffsetDateTime::now_utc())).into_response(),
        Err(e) => {
            tracing::error!("font scan failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Listeners for one port on both loopback addresses.
pub struct Bound {
    pub port: u16,
    pub v4: TcpListener,
    pub v6: TcpListener,
}

/// Bind `127.0.0.1` and `::1` on the first port in `ports` that is free on both (KTD8).
pub fn bind_first_free(ports: &[u16]) -> io::Result<Bound> {
    let mut last = io::Error::new(io::ErrorKind::AddrInUse, "no ports to try");
    for &port in ports {
        let v4 = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))) {
            Ok(l) => l,
            Err(e) => {
                last = e;
                continue;
            }
        };
        let v6 = match TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))) {
            Ok(l) => l,
            Err(e) => {
                last = e;
                continue;
            }
        };
        v4.set_nonblocking(true)?;
        v6.set_nonblocking(true)?;
        return Ok(Bound { port, v4, v6 });
    }
    Err(last)
}

/// Serve `app` over TLS on both listeners until `handle` shuts down.
pub fn serve(
    bound: Bound,
    tls: RustlsConfig,
    app: Router,
    handle: Handle,
) -> impl Future<Output = io::Result<()>> {
    let a = axum_server::from_tcp_rustls(bound.v4, tls.clone())
        .handle(handle.clone())
        .serve(app.clone().into_make_service());
    let b = axum_server::from_tcp_rustls(bound.v6, tls)
        .handle(handle)
        .serve(app.into_make_service());
    async move {
        let (ra, rb) = tokio::join!(a, b);
        ra.and(rb)
    }
}
