//! Throwaway spike for plan unit U1 (Mac trust and font access). Not product code.
//!
//!   spike gen <outdir> constrained|selfsigned <leaf-days>
//!       Writes root.pem (the certificate to trust), leaf.pem and leaf.key.
//!       In the constrained design the CA key is never written: it is dropped after signing.
//!   spike serve <certdir> <port>
//!       Serves /v1/health and /v1/fonts over HTTPS on 127.0.0.1 and ::1.
//!   spike fonts
//!       Prints the font families found in the Office and user font folders, plus read errors.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::{env, fs};

use axum::http::{HeaderMap, HeaderValue};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DnType, ExtendedKeyUsagePurpose, GeneralSubtree, IsCa, Issuer,
    KeyPair, KeyUsagePurpose, NameConstraints, SanType,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("gen") => gen(Path::new(&args[2]), &args[3], args[4].parse().expect("leaf days")),
        Some("serve") => serve(PathBuf::from(&args[2]), args[3].parse().expect("port")),
        Some("fonts") => {
            let (families, errors) = office_fonts();
            for f in &families {
                println!("{f}");
            }
            eprintln!("{} families, {} errors", families.len(), errors.len());
            for e in errors {
                eprintln!("error: {e}");
            }
        }
        _ => eprintln!("usage: spike gen|serve|fonts ..."),
    }
}

// ---------------------------------------------------------------------------------------------
// Certificates

fn leaf_params(days: i64) -> CertificateParams {
    let mut p = CertificateParams::default();
    p.distinguished_name.push(DnType::CommonName, "SlideFidelity Helper (localhost)");
    p.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().unwrap()),
        SanType::IpAddress("127.0.0.1".parse().unwrap()),
        SanType::IpAddress("::1".parse().unwrap()),
    ];
    p.is_ca = IsCa::ExplicitNoCa;
    p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let now = OffsetDateTime::now_utc();
    p.not_before = now - Duration::days(1);
    p.not_after = now + Duration::days(days);
    p
}

fn gen(out: &Path, design: &str, days: i64) {
    fs::create_dir_all(out).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let params = leaf_params(days);
    let (root_pem, leaf_pem) = match design {
        "constrained" => {
            let mut ca = CertificateParams::default();
            ca.distinguished_name.push(DnType::CommonName, "SlideFidelity Helper Local Root (this computer only)");
            ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
            ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            ca.name_constraints = Some(NameConstraints {
                permitted_subtrees: vec![
                    GeneralSubtree::DnsName("localhost".into()),
                    GeneralSubtree::IpAddress(CidrSubnet::V4([127, 0, 0, 1], [255; 4])),
                    GeneralSubtree::IpAddress(CidrSubnet::V6(
                        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                        [255; 16],
                    )),
                ],
                excluded_subtrees: vec![],
            });
            let now = OffsetDateTime::now_utc();
            ca.not_before = now - Duration::days(1);
            ca.not_after = now + Duration::days(days + 1);
            let ca_key = KeyPair::generate().unwrap();
            let root = ca.self_signed(&ca_key).unwrap();
            let issuer = Issuer::new(ca, ca_key); // takes ownership; dropped at the end of this arm
            let leaf = params.signed_by(&leaf_key, &issuer).unwrap();
            (root.pem(), leaf.pem())
        }
        "selfsigned" => {
            let leaf = params.self_signed(&leaf_key).unwrap();
            (leaf.pem(), leaf.pem())
        }
        other => panic!("unknown design {other}"),
    };
    fs::write(out.join("root.pem"), root_pem).unwrap();
    fs::write(out.join("leaf.pem"), leaf_pem).unwrap();
    fs::write(out.join("leaf.key"), leaf_key.serialize_pem()).unwrap();
    println!("wrote {design} ({days}-day leaf) to {}", out.display());
}

// ---------------------------------------------------------------------------------------------
// Server

fn cors(headers: &HeaderMap) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(origin) = headers.get("origin") {
        h.insert("access-control-allow-origin", origin.clone());
        h.insert("vary", HeaderValue::from_static("Origin"));
    }
    h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h
}

fn log(line: &str) {
    eprintln!("{} {line}", OffsetDateTime::now_utc());
}

async fn health(headers: HeaderMap) -> impl IntoResponse {
    log(&format!("GET /v1/health origin={:?}", headers.get("origin")));
    (cors(&headers), Json(json!({ "ok": true, "apiVersion": 1, "spike": true })))
}

async fn fonts(headers: HeaderMap) -> impl IntoResponse {
    let (families, errors) = office_fonts();
    log(&format!("GET /v1/fonts origin={:?} -> {} families, {} errors", headers.get("origin"), families.len(), errors.len()));
    (cors(&headers), Json(json!({ "count": families.len(), "families": families, "errors": errors })))
}

fn serve(dir: PathBuf, port: u16) {
    rustls::crypto::ring::default_provider().install_default().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async move {
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(dir.join("leaf.pem"), dir.join("leaf.key"))
            .await
            .expect("load cert");
        let app = Router::new().route("/v1/health", get(health)).route("/v1/fonts", get(fonts));
        let v4: SocketAddr = ([127, 0, 0, 1], port).into();
        let v6: SocketAddr = (std::net::Ipv6Addr::LOCALHOST, port).into();
        log(&format!("listening on {v4} and {v6}"));
        let a = axum_server::bind_rustls(v4, config.clone()).serve(app.clone().into_make_service());
        let b = axum_server::bind_rustls(v6, config).serve(app.into_make_service());
        let (ra, rb) = tokio::join!(a, b);
        ra.unwrap();
        rb.unwrap();
    });
}

// ---------------------------------------------------------------------------------------------
// Fonts

#[cfg(windows)]
fn font_roots() -> Vec<PathBuf> {
    let var = |k: &str| PathBuf::from(env::var(k).unwrap_or_default());
    vec![
        var("WINDIR").join("Fonts"),
        var("LOCALAPPDATA").join(r"Microsoft\Windows\Fonts"),
        var("ProgramFiles").join(r"Microsoft Office\root\vfs\Fonts\private"),
        var("ProgramFiles(x86)").join(r"Microsoft Office\root\vfs\Fonts\private"),
        var("LOCALAPPDATA").join(r"Microsoft\FontCache\4\CloudFonts"),
    ]
}

#[cfg(not(windows))]
fn font_roots() -> Vec<PathBuf> {
    let home = PathBuf::from(env::var("HOME").unwrap_or_default());
    vec![
        PathBuf::from("/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts"),
        home.join("Library/Group Containers/UBF8T346G9.Office/FontCache"),
        home.join("Library/Fonts"),
        PathBuf::from("/Library/Fonts"),
    ]
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>, errors: &mut Vec<String>) {
    match fs::read_dir(dir) {
        Ok(rd) => {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, files, errors);
                } else {
                    files.push(p);
                }
            }
        }
        Err(e) => errors.push(format!("{}: {e}", dir.display())),
    }
}

fn office_fonts() -> (BTreeSet<String>, Vec<String>) {
    let mut families = BTreeSet::new();
    let mut errors = Vec::new();
    let mut files = Vec::new();
    for root in font_roots() {
        walk(&root, &mut files, &mut errors);
    }
    for f in files {
        let data = match fs::read(&f) {
            Ok(d) => d,
            Err(e) => {
                errors.push(format!("{}: {e}", f.display()));
                continue;
            }
        };
        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for i in 0..count {
            let Ok(face) = ttf_parser::Face::parse(&data, i) else { continue };
            for name in face.names() {
                if matches!(name.name_id, 1 | 16 | 21) {
                    if let Some(s) = name.to_string() {
                        if !s.trim().is_empty() {
                            families.insert(s.trim().to_string());
                        }
                    }
                }
            }
        }
    }
    (families, errors)
}
