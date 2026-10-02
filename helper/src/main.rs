use std::process::ExitCode;

use slidecheck_helper::{logging, API_VERSION};

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
        "serve" | "install-cert" | "uninstall-cert" | "fonts" => {
            let _guard = logging::init(cmd == "serve");
            tracing::error!("`{cmd}` is not implemented yet");
            ExitCode::FAILURE
        }
        other => {
            eprintln!("unknown command `{other}`\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
