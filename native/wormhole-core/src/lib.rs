//! PortalGems wormhole engine: an app-shaped wrapper around magic-wormhole.rs.
//!
//! Phase 0 scope: prove send/receive interop with the reference CLI, including
//! sender-specified codes (the pairing prerequisite). The API is deliberately
//! shaped like the future UniFFI surface: plain async functions, callbacks for
//! code/transit/progress, and a small error enum.

use std::path::{Path, PathBuf};

use futures_lite::future::pending;

uniffi::setup_scaffolding!();

mod ffi;
pub use ffi::{create_test_file, FolderOfferInfo, IncomingFile, TransferListener};
use std::borrow::Cow;

use magic_wormhole::{
    transfer::{self, AppVersion, APP_CONFIG},
    transit::{self, Abilities, RelayHint, TransitInfo},
    AppConfig, MailboxConnection, Wormhole,
};

/// Number of wordlist words in generated codes (the CLI default).
pub const DEFAULT_CODE_LENGTH: usize = 2;

/// Which servers a transfer should use. Both fields are optional; a missing or
/// empty field falls back to the public magic-wormhole defaults. Keeping the
/// app id fixed (see `app_config`) means any two clients pointed at the SAME
/// rendezvous server interoperate - including the reference CLI.
///
/// - `rendezvous_url`: the mailbox/rendezvous server (`ws(s)://host:port/v1`),
///   where the two sides exchange the code and run the PAKE handshake.
/// - `transit_url`: the transit relay used when a direct connection is not
///   possible (`tcp://host:port`).
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct ServerConfig {
    pub rendezvous_url: Option<String>,
    pub transit_url: Option<String>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum Error {
    #[error("invalid wormhole code: {0}")]
    InvalidCode(String),
    #[error("the transfer was cancelled")]
    Cancelled,
    #[error("this transfer was already accepted or rejected")]
    AlreadyConsumed,
    #[error("invalid server URL: {0}")]
    InvalidServerUrl(String),
    #[error("invalid folder archive: {0}")]
    Archive(String),
    #[error(transparent)]
    Wormhole(#[from] magic_wormhole::WormholeError),
    #[error(transparent)]
    Transfer(#[from] transfer::TransferError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Archive(e.to_string())
    }
}

/// rustls 0.23 needs a process-wide crypto provider selected before any TLS
/// handshake, or it panics. Install `ring` once, idempotently. Called at every
/// connection entry point since there is no single init hook across the FFIs.
pub(crate) fn ensure_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The rendezvous/mailbox config for this transfer. We clone the library's
/// `APP_CONFIG` (which fixes the interop-critical app id) and override only the
/// rendezvous URL when the caller supplied one.
pub(crate) fn app_config(server: &ServerConfig) -> AppConfig<AppVersion> {
    match server.rendezvous_url.as_deref() {
        Some(url) if !url.is_empty() => APP_CONFIG.rendezvous_url(Cow::Owned(url.to_owned())),
        _ => APP_CONFIG,
    }
}

/// Transit relay hints for this transfer: the caller's relay when given,
/// otherwise the public default. A malformed URL is a caller error, not a
/// panic, so we surface it as `InvalidServerUrl`.
pub(crate) fn relay_hints(server: &ServerConfig) -> Result<Vec<RelayHint>, Error> {
    let raw = server
        .transit_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(transit::DEFAULT_RELAY_SERVER);
    let url = raw
        .parse()
        .map_err(|_| Error::InvalidServerUrl(raw.to_string()))?;
    let hint =
        RelayHint::from_urls(None, [url]).map_err(|_| Error::InvalidServerUrl(raw.to_string()))?;
    Ok(vec![hint])
}

pub(crate) fn describe_transit(info: &TransitInfo) -> String {
    format!("{:?} peer={}", info.conn_type, info.peer_addr)
}

/// Send a file (or folder). With `code: None` a fresh code is generated and
/// reported through `on_code`. With `code: Some(..)` the wormhole is opened on
/// that exact code (`allocate = true` claims the nameplate) - this is what
/// paired devices use to meet on a derived code without typing anything.
pub async fn send_file<F, G, H>(
    path: impl AsRef<Path>,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    on_transit: G,
    progress: H,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), Error>
where
    F: FnOnce(String),
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    ensure_crypto_provider();
    let path = path.as_ref();
    let file_name = path
        .file_name()
        .ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path has no file name",
            ))
        })?
        .to_string_lossy()
        .into_owned();

    // Race the whole pipeline against `cancel`: a sender waiting for its
    // receiver blocks inside Wormhole::connect (the PAKE needs a peer), so
    // cancellation must cover more than just the transfer phase.
    let work = async {
        let (wormhole, relay_hints) = sender_connect(code, server, on_code).await?;
        transfer::send_file_or_folder(
            wormhole,
            relay_hints,
            path,
            file_name,
            Abilities::ALL,
            |info| on_transit(describe_transit(&info)),
            progress,
            pending::<()>(),
        )
        .await?;
        Ok(())
    };
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

/// Open the sender side of a wormhole: allocate (or claim) the code, report it
/// through `on_code`, and complete the PAKE handshake.
async fn sender_connect<F: FnOnce(String)>(
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
) -> Result<(Wormhole, Vec<RelayHint>), Error> {
    let relay_hints = relay_hints(server)?;
    let mailbox = match code {
        None => MailboxConnection::create(app_config(server), DEFAULT_CODE_LENGTH).await?,
        Some(raw) => {
            let code = raw.parse().map_err(|_| Error::InvalidCode(raw.into()))?;
            MailboxConnection::connect(app_config(server), code, true).await?
        },
    };
    on_code(mailbox.code().to_string());
    let wormhole = Wormhole::connect(mailbox).await?;
    Ok((wormhole, relay_hints))
}

/// Send a folder as a protocol-v1 `directory` offer (the same wire format the
/// reference CLI uses): the tree is zipped into a temporary archive, the peer
/// sees the folder name, file count and unpacked size before accepting, and a
/// conforming receiver unpacks it back into a folder. Symbolic links inside
/// the tree are skipped.
pub async fn send_folder<F, G, H>(
    path: impl AsRef<Path>,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    on_transit: G,
    progress: H,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), Error>
where
    F: FnOnce(String),
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    ensure_crypto_provider();
    let path = path.as_ref().to_path_buf();
    let dir_name = path
        .file_name()
        .ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path has no folder name",
            ))
        })?
        .to_string_lossy()
        .into_owned();

    let work = async {
        // Zip into a private temp workspace, cleaned up on every exit path.
        // If `cancel` fires mid-zip, dropping this future sets the abort flag
        // (via the guard) and the zipping thread bails at the next entry.
        let work_dir = std::env::temp_dir().join(format!(
            "pg-sendfolder-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&work_dir)?;
        let _workspace = RemoveDirOnDrop(work_dir.clone());
        let zip_path = work_dir.join("payload.zip");

        let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _abort_guard = AbortOnDrop(abort.clone());
        let stats = {
            let (src, dest) = (path.clone(), zip_path.clone());
            blocking::unblock(move || zip_folder_sync(&src, &dest, &abort)).await?
        };

        send_zip_inner(
            &zip_path,
            &dir_name,
            stats.num_files,
            stats.num_bytes,
            code,
            server,
            on_code,
            on_transit,
            progress,
        )
        .await
    };
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

/// Send an already-zipped folder as a protocol-v1 `directory` offer. This is
/// the entry point for platforms whose folder trees are not filesystem paths
/// (Android SAF): the app zips the tree into a real file first and passes the
/// stats it counted while doing so. The zip must contain paths relative to the
/// folder root (no top-level folder-name entry), matching the reference CLI.
pub async fn send_zip_as_folder<F, G, H>(
    zip_path: impl AsRef<Path>,
    dir_name: &str,
    num_files: u64,
    num_bytes: u64,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    on_transit: G,
    progress: H,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), Error>
where
    F: FnOnce(String),
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    ensure_crypto_provider();
    let work = send_zip_inner(
        zip_path.as_ref(),
        dir_name,
        num_files,
        num_bytes,
        code,
        server,
        on_code,
        on_transit,
        progress,
    );
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

/// Shared sending half of [`send_folder`] / [`send_zip_as_folder`]. Callers
/// race this against their cancel future.
async fn send_zip_inner<F, G, H>(
    zip_path: &Path,
    dir_name: &str,
    num_files: u64,
    num_bytes: u64,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    on_transit: G,
    progress: H,
) -> Result<(), Error>
where
    F: FnOnce(String),
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    let (wormhole, relay_hints) = sender_connect(code, server, on_code).await?;
    let mut zip = async_fs::File::open(zip_path).await?;
    let zip_size = zip.metadata().await?.len();
    transfer::send_zipped_directory(
        wormhole,
        relay_hints,
        &mut zip,
        dir_name,
        zip_size,
        num_bytes,
        num_files,
        Abilities::ALL,
        |info| on_transit(describe_transit(&info)),
        progress,
        pending::<()>(),
    )
    .await?;
    Ok(())
}

/// Best-effort removal of a temp workspace on every exit path.
struct RemoveDirOnDrop(PathBuf);
impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Flips the shared abort flag when the owning future is dropped (cancelled),
/// so the detached zipping thread stops at the next entry.
struct AbortOnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Folder metadata carried by a protocol-v1 `directory` offer. All values are
/// sender-claimed; `num_bytes` is enforced (with slack) as an unpack cap so a
/// hostile archive cannot expand far beyond what the user agreed to.
#[derive(Debug, Clone)]
pub struct FolderOffer {
    /// Sanitized folder name (path components stripped)
    pub dir_name: String,
    /// Number of files inside the folder, as claimed by the sender
    pub num_files: u64,
    /// Total unpacked size in bytes, as claimed by the sender
    pub num_bytes: u64,
}

/// A file (or folder) offer that has been received but not yet accepted: the
/// platform bindings build their confirmation UIs on top of this.
///
/// For folder offers `file_name`/`file_size` keep their historic meaning - the
/// name of the transferred archive (`<dirname>.zip`) and its size - while
/// `folder` carries what the UI should actually show.
pub struct PendingReceive {
    pub file_name: String,
    pub file_size: u64,
    pub folder: Option<FolderOffer>,
    request: transfer::ReceiveRequest,
}

/// Connect to the wormhole under `code` and wait for the sender's offer,
/// without accepting it.
pub async fn request_receive(
    code: &str,
    server: &ServerConfig,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<PendingReceive, Error> {
    ensure_crypto_provider();
    let work = async {
        let relay_hints = relay_hints(server)?;
        let parsed = code.parse().map_err(|_| Error::InvalidCode(code.into()))?;
        let mailbox = MailboxConnection::connect(app_config(server), parsed, false).await?;
        let wormhole = Wormhole::connect(mailbox).await?;
        let request = transfer::request_file(
            wormhole,
            relay_hints,
            Abilities::ALL,
            pending::<()>(),
        )
        .await?
        .ok_or(Error::Cancelled)?;

        let folder = request.directory_offer().map(|d| FolderOffer {
            dir_name: sanitize_dir_name(&d.dir_name),
            num_files: d.num_files,
            num_bytes: d.num_bytes,
        });
        Ok(PendingReceive {
            file_name: sanitize_file_name(&request.file_name()),
            file_size: request.file_size(),
            folder,
            request,
        })
    };
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

impl PendingReceive {
    /// Accept the offer, writing into `dest_dir`; returns the saved path.
    ///
    /// For a file offer this saves a single file. For a folder offer the zip
    /// payload is staged inside `dest_dir`, unpacked into a folder named after
    /// the offer (never clobbering an existing one), and deleted; the returned
    /// path is the folder. Progress covers the network transfer (zip bytes).
    pub async fn accept<G, H>(
        self,
        dest_dir: impl AsRef<Path>,
        on_transit: G,
        progress: H,
        cancel: impl std::future::Future<Output = ()>,
    ) -> Result<PathBuf, Error>
    where
        G: FnOnce(String),
        H: FnMut(u64, u64) + 'static,
    {
        let dest_dir = dest_dir.as_ref();
        match &self.folder {
            None => {
                let (dest, mut file) = create_unique(dest_dir, &self.file_name).await?;
                self.request
                    .accept(
                        |info| on_transit(describe_transit(&info)),
                        progress,
                        &mut file,
                        cancel,
                    )
                    .await?;
                Ok(dest)
            },
            Some(folder) => {
                let folder = folder.clone();
                let (zip_path, mut zip_file) = create_unique(dest_dir, &self.file_name).await?;
                let received = self
                    .request
                    .accept(
                        |info| on_transit(describe_transit(&info)),
                        progress,
                        &mut zip_file,
                        cancel,
                    )
                    .await;
                drop(zip_file);
                if let Err(e) = received {
                    async_fs::remove_file(&zip_path).await.ok();
                    return Err(e.into());
                }

                let dest = create_unique_dir(dest_dir, &folder.dir_name).await?;
                let cap = unpack_cap(folder.num_bytes);
                let unpacked = {
                    let (zip, out) = (zip_path.clone(), dest.clone());
                    blocking::unblock(move || unzip_into_sync(&zip, &out, cap)).await
                };
                async_fs::remove_file(&zip_path).await.ok();
                if let Err(e) = unpacked {
                    // Leave nothing half-extracted behind.
                    async_fs::remove_dir_all(&dest).await.ok();
                    return Err(e);
                }
                Ok(dest)
            },
        }
    }

    /// Decline the offer; the sender sees the transfer fail cleanly.
    pub async fn reject(self) -> Result<(), Error> {
        self.request.reject().await?;
        Ok(())
    }
}

/// Receive a file offered under `code` into `dest_dir`. The sender's file name
/// is sanitized and never overwrites an existing file. Returns the saved path.
pub async fn receive_file<G, H>(
    code: &str,
    dest_dir: impl AsRef<Path>,
    server: &ServerConfig,
    on_transit: G,
    progress: H,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<PathBuf, Error>
where
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    let pending_receive = request_receive(code, server, pending::<()>()).await?;
    pending_receive
        .accept(dest_dir, on_transit, progress, cancel)
        .await
}

/// Strip any path components the sender may have smuggled into the file name.
pub(crate) fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| "received.bin".to_string())
}

/// Like `sanitize_file_name`, with a folder-appropriate fallback.
pub(crate) fn sanitize_dir_name(name: &str) -> String {
    match sanitize_file_name(name) {
        n if n == "received.bin" => "received".to_string(),
        n => n,
    }
}

/// How many unpacked bytes we tolerate for a folder offer that claims
/// `num_bytes`: the claim plus 25% slack plus a small floor for tiny offers.
/// Anything past that is treated as a hostile archive, not rounding error.
pub(crate) fn unpack_cap(num_bytes: u64) -> u64 {
    num_bytes
        .saturating_add(num_bytes / 4)
        .saturating_add(16 * 1024 * 1024)
}

/// What `zip_folder_sync` counted while building the archive; sent in the
/// directory offer so the receiver can show it before accepting.
#[derive(Debug, Clone, Copy)]
pub struct FolderStats {
    pub num_files: u64,
    pub num_bytes: u64,
}

/// Zip the contents of `src_dir` into `dest_zip` (deflate). Entry paths are
/// relative to `src_dir` - no top-level folder-name component - matching what
/// the reference CLI produces. Directories are stored so empty ones survive;
/// symlinks are skipped (they cannot be represented portably and could point
/// outside the tree). Checks `abort` between entries so a cancelled send
/// stops promptly.
pub(crate) fn zip_folder_sync(
    src_dir: &Path,
    dest_zip: &Path,
    abort: &std::sync::atomic::AtomicBool,
) -> Result<FolderStats, Error> {
    use std::io::{Read, Write};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    const ZIP64_THRESHOLD: u64 = 0xFFFF_FFFF;

    let file = std::fs::File::create(dest_zip)?;
    let mut writer = ZipWriter::new(std::io::BufWriter::new(file));
    let base_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut stats = FolderStats {
        num_files: 0,
        num_bytes: 0,
    };
    // Depth-first walk with sorted entries for a deterministic archive.
    let mut stack: Vec<(PathBuf, String)> = vec![(src_dir.to_path_buf(), String::new())];
    let mut buf = vec![0u8; 64 * 1024];
    while let Some((dir, rel)) = stack.pop() {
        if abort.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let mut entries: Vec<_> = std::fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if abort.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let entry_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                writer.add_directory(format!("{entry_rel}/"), base_opts)?;
                stack.push((entry.path(), entry_rel));
            } else if meta.is_file() {
                let opts = if meta.len() >= ZIP64_THRESHOLD {
                    base_opts.large_file(true)
                } else {
                    base_opts
                };
                writer.start_file(&entry_rel, opts)?;
                let mut src = std::fs::File::open(entry.path())?;
                loop {
                    let n = src.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    writer.write_all(&buf[..n])?;
                    stats.num_bytes += n as u64;
                }
                stats.num_files += 1;
            }
        }
    }
    writer.finish()?.flush()?;
    Ok(stats)
}

/// Unpack a received folder archive into `dest` (which must already exist).
/// Entry paths are validated against traversal (zip-slip) and the cumulative
/// unpacked size is capped at `max_total_bytes` (zip-bomb guard).
pub(crate) fn unzip_into_sync(
    zip_path: &Path,
    dest: &Path,
    max_total_bytes: u64,
) -> Result<(), Error> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))?;
    let mut written: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        // `enclosed_name` rejects absolute paths and any `..` traversal.
        let Some(rel) = entry.enclosed_name() else {
            return Err(Error::Archive(format!(
                "unsafe path in archive: {}",
                entry.name()
            )));
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut target = std::fs::File::create(&out)?;
        let allowed = max_total_bytes.saturating_sub(written);
        let copied = std::io::copy(&mut std::io::Read::take(&mut entry, allowed + 1), &mut target)?;
        if copied > allowed {
            return Err(Error::Archive(
                "unpacked data exceeds the offered folder size".to_string(),
            ));
        }
        written += copied;
    }
    Ok(())
}

/// Create `dir/name` as a new directory without clobbering: falls back to
/// `name (1)`, `name (2)`, … if the name is taken (by anything).
pub(crate) async fn create_unique_dir(dir: &Path, name: &str) -> Result<PathBuf, Error> {
    for n in 0u32..1000 {
        let candidate = if n == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{name} ({n})"))
        };
        match async_fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not find a free folder name",
    )))
}

/// Open `dir/name` for writing without clobbering: falls back to
/// `name (1)`, `name (2)`, … if the file already exists.
pub(crate) async fn create_unique(
    dir: &Path,
    name: &str,
) -> Result<(PathBuf, async_fs::File), Error> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 0u32..1000 {
        let candidate = if n == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        match async_fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not find a free file name",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_components_and_empties() {
        assert_eq!(sanitize_file_name("normal.jpg"), "normal.jpg");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("/abs/path/file.txt"), "file.txt");
        assert_eq!(sanitize_file_name(""), "received.bin");
        assert_eq!(sanitize_file_name(".."), "received.bin");
        assert_eq!(sanitize_file_name("."), "received.bin");
    }

    #[test]
    fn create_unique_never_clobbers() {
        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-core-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let (p1, _) = create_unique(&dir, "a.txt").await.unwrap();
            let (p2, _) = create_unique(&dir, "a.txt").await.unwrap();
            let (p3, _) = create_unique(&dir, "a.txt").await.unwrap();
            assert_eq!(p1.file_name().unwrap(), "a.txt");
            assert_eq!(p2.file_name().unwrap(), "a (1).txt");
            assert_eq!(p3.file_name().unwrap(), "a (2).txt");
            // extensionless names get plain " (n)" suffixes too
            let (q1, _) = create_unique(&dir, "noext").await.unwrap();
            let (q2, _) = create_unique(&dir, "noext").await.unwrap();
            assert_eq!(q1.file_name().unwrap(), "noext");
            assert_eq!(q2.file_name().unwrap(), "noext (1)");
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    fn write(path: &Path, contents: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn no_abort() -> std::sync::atomic::AtomicBool {
        std::sync::atomic::AtomicBool::new(false)
    }

    #[test]
    fn sanitize_dir_name_has_folder_fallback() {
        assert_eq!(sanitize_dir_name("photos"), "photos");
        assert_eq!(sanitize_dir_name("../../etc"), "etc");
        assert_eq!(sanitize_dir_name(""), "received");
        assert_eq!(sanitize_dir_name(".."), "received");
    }

    #[test]
    fn zip_roundtrip_preserves_tree() {
        let root = std::env::temp_dir().join(format!("pg-zip-rt-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let src = root.join("src");
        write(&src.join("a.txt"), b"alpha");
        write(&src.join("sub/b.bin"), &[0u8; 70_000]); // spans several copy buffers
        write(&src.join("sub/deeper/c"), b"");
        std::fs::create_dir_all(src.join("empty-dir")).unwrap();

        let zip = root.join("out.zip");
        let stats = zip_folder_sync(&src, &zip, &no_abort()).unwrap();
        assert_eq!(stats.num_files, 3);
        assert_eq!(stats.num_bytes, 5 + 70_000);

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        unzip_into_sync(&zip, &out, unpack_cap(stats.num_bytes)).unwrap();
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(out.join("sub/b.bin")).unwrap(), [0u8; 70_000]);
        assert_eq!(std::fs::read(out.join("sub/deeper/c")).unwrap(), b"");
        assert!(out.join("empty-dir").is_dir());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn zip_skips_symlinks() {
        let root = std::env::temp_dir().join(format!("pg-zip-sym-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let src = root.join("src");
        write(&src.join("real.txt"), b"data");
        std::os::unix::fs::symlink("/etc/passwd", src.join("link")).unwrap();

        let zip = root.join("out.zip");
        let stats = zip_folder_sync(&src, &zip, &no_abort()).unwrap();
        assert_eq!(stats.num_files, 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unzip_rejects_traversal_entries() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("pg-zip-slip-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();

        // Craft a hostile archive by hand; ZipWriter happily stores the name.
        let zip_path = root.join("evil.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        w.start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"pwned").unwrap();
        w.finish().unwrap();

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let err = unzip_into_sync(&zip_path, &out, u64::MAX).unwrap_err();
        assert!(matches!(err, Error::Archive(_)), "got: {err}");
        assert!(!root.join("escape.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unzip_enforces_size_cap() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("pg-zip-cap-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();

        // A highly compressible payload that claims to be small.
        let zip_path = root.join("bomb.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        w.start_file("big.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(&vec![0u8; 1_000_000]).unwrap();
        w.finish().unwrap();

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let err = unzip_into_sync(&zip_path, &out, 1024).unwrap_err();
        assert!(matches!(err, Error::Archive(_)), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_unique_dir_never_clobbers() {
        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-uniqdir-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            let p1 = create_unique_dir(&dir, "photos").await.unwrap();
            let p2 = create_unique_dir(&dir, "photos").await.unwrap();
            assert_eq!(p1.file_name().unwrap(), "photos");
            assert_eq!(p2.file_name().unwrap(), "photos (1)");
            // a dotted folder name must not be split like a file extension
            let q1 = create_unique_dir(&dir, "my.stuff").await.unwrap();
            let q2 = create_unique_dir(&dir, "my.stuff").await.unwrap();
            assert_eq!(q1.file_name().unwrap(), "my.stuff");
            assert_eq!(q2.file_name().unwrap(), "my.stuff (1)");
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn create_test_file_writes_requested_size() {
        let dir = std::env::temp_dir();
        let path = create_test_file(dir.to_string_lossy().into_owned(), 4).unwrap();
        let len = std::fs::metadata(&path).unwrap().len();
        std::fs::remove_file(&path).ok();
        assert_eq!(len, 4 * 1024);
    }

    /// Full network round-trip against the public mailbox server; run with
    /// `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn roundtrip_over_public_server() {
        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-rt-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let src = create_test_file(dir.to_string_lossy().into_owned(), 64).unwrap();
            let code = format!(
                "9{}-integration-test",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
                    % 1_000_000
            );
            let send_code = code.clone();
            let src_clone = src.clone();
            let sender = std::thread::spawn(move || {
                futures_lite::future::block_on(send_file(
                    &src_clone,
                    Some(&send_code),
                    &ServerConfig::default(),
                    |_| {},
                    |_| {},
                    |_, _| {},
                    futures_lite::future::pending::<()>(),
                ))
            });
            std::thread::sleep(std::time::Duration::from_secs(2));
            let dest = receive_file(
                &code,
                &dir,
                &ServerConfig::default(),
                |_| {},
                |_, _| {},
                futures_lite::future::pending::<()>(),
            )
            .await
            .unwrap();
            sender.join().unwrap().unwrap();
            assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&dest).unwrap());
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// Folder round-trip (directory offer) against the public mailbox server;
    /// run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn folder_roundtrip_over_public_server() {
        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-frt-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            let src = dir.join("shared-folder");
            write(&src.join("one.txt"), b"first file");
            write(&src.join("nested/two.bin"), &[7u8; 32 * 1024]);
            std::fs::create_dir_all(src.join("hollow")).unwrap();
            let recv_dir = dir.join("recv");
            std::fs::create_dir_all(&recv_dir).unwrap();

            let code = format!(
                "9{}-folder-integration-test",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
                    % 1_000_000
            );
            let send_code = code.clone();
            let src_clone = src.clone();
            let sender = std::thread::spawn(move || {
                futures_lite::future::block_on(send_folder(
                    &src_clone,
                    Some(&send_code),
                    &ServerConfig::default(),
                    |_| {},
                    |_| {},
                    |_, _| {},
                    futures_lite::future::pending::<()>(),
                ))
            });
            std::thread::sleep(std::time::Duration::from_secs(2));

            let pending_receive = request_receive(
                &code,
                &ServerConfig::default(),
                futures_lite::future::pending::<()>(),
            )
            .await
            .unwrap();
            let offer = pending_receive.folder.clone().expect("folder offer");
            assert_eq!(offer.dir_name, "shared-folder");
            assert_eq!(offer.num_files, 2);
            assert_eq!(offer.num_bytes, 10 + 32 * 1024);

            let dest = pending_receive
                .accept(
                    &recv_dir,
                    |_| {},
                    |_, _| {},
                    futures_lite::future::pending::<()>(),
                )
                .await
                .unwrap();
            sender.join().unwrap().unwrap();

            assert_eq!(dest.file_name().unwrap(), "shared-folder");
            assert_eq!(std::fs::read(dest.join("one.txt")).unwrap(), b"first file");
            assert_eq!(
                std::fs::read(dest.join("nested/two.bin")).unwrap(),
                [7u8; 32 * 1024]
            );
            assert!(dest.join("hollow").is_dir());
            // the staged zip must be gone
            assert!(!recv_dir.join("shared-folder.zip").exists());
            std::fs::remove_dir_all(&dir).ok();
        });
    }
}
