//! Phase 0 test harness: send a file or folder, printing machine-readable lines.
//! Usage: send <path> [code]
//! Optional env: PG_RENDEZVOUS_URL, PG_TRANSIT_URL to override servers.

use std::io::Write;

fn out(line: String) {
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{line}").unwrap();
    stdout.flush().unwrap();
}

fn server_from_env() -> wormhole_core::ServerConfig {
    wormhole_core::ServerConfig {
        rendezvous_url: std::env::var("PG_RENDEZVOUS_URL").ok(),
        transit_url: std::env::var("PG_TRANSIT_URL").ok(),
    }
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: send <path> [code]");
    let code = args.next();
    let is_dir = std::fs::metadata(&path)?.is_dir();

    async_io::block_on(async move {
        let mut last_pct = 0u64;
        let server = server_from_env();
        let on_code = |code: String| out(format!("CODE:{code}"));
        let on_transit = |transit: String| out(format!("TRANSIT:{transit}"));
        let progress = move |sent: u64, total: u64| {
            let pct = if total == 0 { 100 } else { sent * 100 / total };
            if pct == 100 || pct >= last_pct + 25 {
                last_pct = pct;
                out(format!("PROGRESS:{pct}"));
            }
        };
        if is_dir {
            wormhole_core::send_folder(
                &path,
                code.as_deref(),
                &server,
                on_code,
                on_transit,
                progress,
                std::future::pending::<()>(),
            )
            .await
        } else {
            wormhole_core::send_file(
                &path,
                code.as_deref(),
                &server,
                on_code,
                on_transit,
                progress,
                std::future::pending::<()>(),
            )
            .await
        }
    })?;
    out("SEND-OK".to_string());
    Ok(())
}
