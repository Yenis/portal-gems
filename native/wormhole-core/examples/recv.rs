//! Phase 0 test harness: receive a file or folder, printing machine-readable lines.
//! Usage: recv <code> [dest_dir]
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
    let code = args.next().expect("usage: recv <code> [dest_dir]");
    let dest = args.next().unwrap_or_else(|| ".".to_string());

    let path = async_io::block_on(async move {
        let server = server_from_env();
        let pending = wormhole_core::request_receive(
            &code,
            &server,
            std::future::pending::<()>(),
        )
        .await?;
        match &pending.folder {
            Some(f) => out(format!(
                "OFFER-FOLDER:{}:{}:{}",
                f.dir_name, f.num_files, f.num_bytes
            )),
            None => out(format!("OFFER-FILE:{}:{}", pending.file_name, pending.file_size)),
        }
        let mut last_pct = 0u64;
        pending
            .accept(
                &dest,
                |transit| out(format!("TRANSIT:{transit}")),
                move |received, total| {
                    let pct = if total == 0 { 100 } else { received * 100 / total };
                    if pct == 100 || pct >= last_pct + 25 {
                        last_pct = pct;
                        out(format!("PROGRESS:{pct}"));
                    }
                },
                std::future::pending::<()>(),
            )
            .await
    })?;
    out(format!("RECV-OK:{}", path.display()));
    Ok(())
}
