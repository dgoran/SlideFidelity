//! U5: the HTTPS API and its origin/host guards (KTD7, KTD8, AE4).

use std::net::TcpListener;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use slidecheck_helper::config::{allowed_origin, allowed_origin_release};
use slidecheck_helper::fonts::{FontCache, Source};
use slidecheck_helper::server::{bind_first_free, router, ServerState};
use slidecheck_helper::update::{UpdateInfo, UpdateState};
use tower::ServiceExt;

const PORT: u16 = 47317;
const APP: &str = "https://app.slidecheck.io";

fn state(allow: fn(&str) -> bool) -> ServerState {
    let empty = tempfile::tempdir().unwrap().keep();
    ServerState {
        fonts: Arc::new(FontCache::new(vec![(empty, Source::Office)], false)),
        update: UpdateState::new(),
        cert_days_remaining: Some(800),
        port: PORT,
        allow_origin: allow,
    }
}

fn req(method: Method, path: &str, host: &str, origin: Option<&str>) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("host", host);
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    b.body(Body::empty()).unwrap()
}

async fn send(st: ServerState, r: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = router(st).oneshot(r).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec();
    (status, headers, body)
}

fn json(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap()
}

#[tokio::test]
async fn allowed_origin_gets_fonts_json() {
    let (s, h, b) = send(
        state(allowed_origin),
        req(Method::GET, "/v1/fonts", "localhost:47317", Some(APP)),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v = json(&b);
    assert!(v["families"].is_array());
    assert!(v["generatedAt"].is_string());
    assert_eq!(h["access-control-allow-origin"], APP);
    assert_eq!(h["vary"], "Origin");
    assert_eq!(h["cache-control"], "no-store");
    assert_eq!(h["x-content-type-options"], "nosniff");
}

#[tokio::test]
async fn health_reports_versions_platform_cert_and_update() {
    let st = state(allowed_origin);
    st.update.set(Some(UpdateInfo {
        version: "9.9.9".into(),
        page: "https://slidecheck.io/helper".into(),
        notes: None,
    }));
    let (s, _, b) = send(
        st,
        req(Method::GET, "/v1/health", "127.0.0.1:47317", Some(APP)),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v = json(&b);
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["apiVersion"], 1);
    assert!(v["platform"].is_string());
    assert_eq!(v["certDaysRemaining"], 800);
    assert_eq!(v["update"]["version"], "9.9.9");
}

#[tokio::test]
async fn foreign_or_missing_origin_is_403_with_empty_body() {
    for origin in [
        Some("https://example.com"),
        Some("http://app.slidecheck.io"),
        Some("null"),
        None,
    ] {
        let (s, h, b) = send(
            state(allowed_origin),
            req(Method::GET, "/v1/fonts", "localhost:47317", origin),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{origin:?}");
        assert!(b.is_empty(), "{origin:?}");
        assert!(h.get("access-control-allow-origin").is_none(), "{origin:?}");
    }
}

#[tokio::test]
async fn non_loopback_or_wrong_port_host_is_403_even_with_allowed_origin() {
    for host in [
        "evil.example:47317",
        "localhost:47318",
        "localhost",
        "127.0.0.2:47317",
        "0.0.0.0:47317",
    ] {
        let (s, _, b) = send(
            state(allowed_origin),
            req(Method::GET, "/v1/health", host, Some(APP)),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{host}");
        assert!(b.is_empty());
    }
    for host in [
        "localhost:47317",
        "127.0.0.1:47317",
        "[::1]:47317",
        "LOCALHOST:47317",
    ] {
        let (s, _, _) = send(
            state(allowed_origin),
            req(Method::GET, "/v1/health", host, Some(APP)),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{host}");
    }
}

#[tokio::test]
async fn preflight_allows_private_network_for_allowed_origin() {
    let r = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/fonts")
        .header("host", "localhost:47317")
        .header("origin", APP)
        .header("access-control-request-method", "GET")
        .header("access-control-request-private-network", "true")
        .body(Body::empty())
        .unwrap();
    let (s, h, _) = send(state(allowed_origin), r).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(h["access-control-allow-origin"], APP);
    assert_eq!(h["access-control-allow-private-network"], "true");
    assert_eq!(h["access-control-allow-methods"], "GET");
}

#[tokio::test]
async fn preflight_from_foreign_origin_is_403() {
    let (s, h, _) = send(
        state(allowed_origin),
        req(
            Method::OPTIONS,
            "/v1/fonts",
            "localhost:47317",
            Some("https://example.com"),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(h.get("access-control-allow-private-network").is_none());
}

#[tokio::test]
async fn release_allowlist_rejects_the_dev_origin() {
    let (s, _, _) = send(
        state(allowed_origin_release),
        req(
            Method::GET,
            "/v1/health",
            "localhost:47317",
            Some("https://localhost:3000"),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _, _) = send(
        state(allowed_origin),
        req(
            Method::GET,
            "/v1/health",
            "localhost:47317",
            Some("https://localhost:3000"),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "debug builds accept the dev origin");
}

#[tokio::test]
async fn post_is_405_and_unknown_path_is_404() {
    let (s, _, _) = send(
        state(allowed_origin),
        req(Method::POST, "/v1/fonts", "localhost:47317", Some(APP)),
    )
    .await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    let (s, _, _) = send(
        state(allowed_origin),
        req(Method::GET, "/v1/secrets", "localhost:47317", Some(APP)),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn binds_the_first_port_free_on_both_loopbacks() {
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let busy = taken.local_addr().unwrap().port();
    let next = free_port();
    let bound = bind_first_free(&[busy, next]).unwrap();
    assert_eq!(bound.port, next);
    assert_eq!(bound.v4.local_addr().unwrap().ip().to_string(), "127.0.0.1");
    assert_eq!(bound.v6.local_addr().unwrap().ip().to_string(), "::1");
}

#[test]
fn port_taken_only_on_ipv6_is_skipped_too() {
    let taken6 = TcpListener::bind("[::1]:0").unwrap();
    let busy = taken6.local_addr().unwrap().port();
    let next = free_port();
    let bound = bind_first_free(&[busy, next]).unwrap();
    assert_eq!(bound.port, next);
}

#[test]
fn all_ports_taken_is_an_error() {
    let a = TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(bind_first_free(&[a.local_addr().unwrap().port()]).is_err());
}

/// Integration: real TLS on loopback with a generated chain; a client trusting only that root
/// fetches /v1/health over HTTPS with an allowed Origin.
#[tokio::test]
async fn https_round_trip_with_generated_certificate() {
    use slidecheck_helper::cert::{install_cert, CertError, InstallOptions, RootRef, TrustStore};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Accept;
    impl TrustStore for Accept {
        fn add(&self, _: &RootRef<'_>) -> Result<(), CertError> {
            Ok(())
        }
        fn remove(&self, _: &RootRef<'_>) -> Result<(), CertError> {
            Ok(())
        }
        fn is_trusted(&self, _: &RootRef<'_>) -> Result<bool, CertError> {
            Ok(true)
        }
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    install_cert(&Accept, dir.path(), &InstallOptions::native()).unwrap();

    let port = free_port();
    let bound = bind_first_free(&[port]).unwrap();
    let mut st = state(allowed_origin);
    st.port = bound.port;
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(
        dir.path().join("leaf.pem"),
        dir.path().join("leaf.key"),
    )
    .await
    .unwrap();
    let handle = axum_server::Handle::new();
    let server = slidecheck_helper::server::serve(bound, tls, router(st), handle.clone());
    let task = tokio::spawn(server);

    let mut roots = rustls::RootCertStore::empty();
    let pem = std::fs::read(dir.path().join("root.pem")).unwrap();
    for c in rustls_pemfile::certs(&mut pem.as_slice()) {
        roots.add(c.unwrap()).unwrap();
    }
    let cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(name, tcp).await.unwrap();
    let request = format!("GET /v1/health HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: {APP}\r\nConnection: close\r\n\r\n");
    tls.write_all(request.as_bytes()).await.unwrap();
    let mut out = String::new();
    tls.read_to_string(&mut out).await.ok();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("\"apiVersion\":1"), "{out}");
    handle.shutdown();
    let _ = task.await;
}

/// HTTP/2 (negotiated by WebKit and curl) carries the host in `:authority`, which hyper exposes as
/// the request URI's authority, often with no `Host` header at all.
#[tokio::test]
async fn http2_authority_is_checked_like_host() {
    let r = |uri: &str, host: Option<&str>| {
        let mut b = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header("origin", APP);
        if let Some(h) = host {
            b = b.header("host", h);
        }
        b.body(Body::empty()).unwrap()
    };
    let (s, _, _) = send(
        state(allowed_origin),
        r("https://localhost:47317/v1/health", None),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = send(
        state(allowed_origin),
        r("https://evil.example:47317/v1/health", None),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Both present: both must be loopback with our port.
    let (s, _, _) = send(
        state(allowed_origin),
        r(
            "https://localhost:47317/v1/health",
            Some("evil.example:47317"),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}
