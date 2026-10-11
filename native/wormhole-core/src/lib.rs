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
pub use ffi::{
    create_test_file, FolderOfferInfo, IncomingFile, LooseBundleInfo, TransferListener,
};
pub use magic_wormhole::transfer::LooseBundle;
use std::borrow::Cow;

use magic_wormhole::{
    transfer::{self, AppVersion, APP_CONFIG},
    transit::{self, Abilities, RelayHint, TransitInfo},
    AppConfig, MailboxConnection, Wormhole,
};

/// Number of wordlist words in generated codes (the CLI default).
pub const DEFAULT_CODE_LENGTH: usize = 2;

/// How long the mailbox server gets to answer before a transfer gives up.
/// It covers reaching the server and claiming or allocating the code, and
/// nothing after that: a sender waiting for its receiver waits as long as it
/// takes.
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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
    #[error("this offer is a text message, not a file")]
    NotAFileOffer,
    #[error("invalid server URL: {0}")]
    InvalidServerUrl(String),
    #[error("no answer from the connection server in time")]
    ConnectTimeout,
    #[error("this code already has two devices on it")]
    Crowded,
    #[error("invalid folder archive: {0}")]
    Archive(String),
    #[error(transparent)]
    Wormhole(magic_wormhole::WormholeError),
    #[error(transparent)]
    Transfer(#[from] transfer::TransferError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// A code holds two devices. The server turns a third away with the error
/// `crowded`, which the library reports as "Error with the rendezvous server
/// connection" - the words it uses for a server it cannot reach, with the
/// server's own word left in the error's source where no app sees it. So the
/// user was told to change servers when the server was fine and had just
/// answered. Pick that one case out here, where the cause is still attached.
impl From<magic_wormhole::WormholeError> for Error {
    fn from(e: magic_wormhole::WormholeError) -> Self {
        use magic_wormhole::{rendezvous::RendezvousError, WormholeError};
        match e {
            WormholeError::ServerError(RendezvousError::Server(ref said))
                if &**said == "crowded" =>
            {
                Error::Crowded
            },
            other => Error::Wormhole(other),
        }
    }
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

/// Send a text message.
///
/// The text is the payload of the offer itself, so it travels through the
/// mailbox and no transit connection is ever built - there is no relay hop, no
/// direct connection, and nothing to report progress on. That is the reference
/// client's behaviour for `wormhole send --text`, and matching it is what makes
/// a message from PortalGems readable by `wormhole receive`.
pub async fn send_text<F>(
    text: &str,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), Error>
where
    F: FnOnce(String),
{
    ensure_crypto_provider();
    let work = async {
        let (wormhole, _relay_hints) = sender_connect(code, server, on_code).await?;
        transfer::send_message(wormhole, text.to_owned(), pending::<()>()).await?;
        Ok(())
    };
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

/// Reach the mailbox server and take a place on it: a fresh code (`None`),
/// or `code` itself, which `allocate` claims for a sender and which a receiver
/// joins. Fails with `ConnectTimeout` if the server has not answered within
/// `timeout`. Nothing bounded the wait before, and a server that never
/// answered - or a device with no way out - left the apps on "Connecting"
/// until the user cancelled.
async fn open_mailbox(
    server: &ServerConfig,
    code: Option<magic_wormhole::Code>,
    allocate: bool,
    timeout: std::time::Duration,
) -> Result<MailboxConnection<AppVersion>, Error> {
    let config = app_config(server);
    let reach = async {
        Ok(match code {
            None => MailboxConnection::create(config, DEFAULT_CODE_LENGTH).await?,
            Some(code) => MailboxConnection::connect(config, code, allocate).await?,
        })
    };
    futures_lite::future::or(reach, async {
        async_io::Timer::after(timeout).await;
        Err(Error::ConnectTimeout)
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
    let code = match code {
        None => None,
        Some(raw) => Some(raw.parse().map_err(|_| Error::InvalidCode(raw.into()))?),
    };
    let mailbox = open_mailbox(server, code, true, CONNECT_TIMEOUT).await?;
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

    send_staged_zip(
        move |zip_path, abort| Ok((zip_folder_sync(&path, zip_path, abort)?, None)),
        &dir_name,
        code,
        server,
        on_code,
        on_transit,
        progress,
        cancel,
    )
    .await
}

/// Send several files and folders as one transfer that the receiver accepts
/// once.
///
/// The protocol has no offer for "several files", so the selection is zipped
/// and sent under a `directory` offer carrying the loose marker: a receiver
/// that knows it unpacks the items into its receive folder itself, and any
/// other client saves a folder called `bundle_name`. Every path becomes a
/// top-level entry - a folder goes in as a tree under its own name - and two
/// items of the same name are told apart as `name (1).ext`.
///
/// One file or one folder should go through [`send_file`] / [`send_folder`]
/// instead, so that it reaches other clients as exactly that; this is for a
/// selection of two or more.
pub async fn send_files<F, G, H>(
    paths: &[PathBuf],
    bundle_name: &str,
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
    let paths = paths.to_vec();
    send_staged_zip(
        move |zip_path, abort| {
            let (stats, bundle) = zip_items_sync(&paths, zip_path, abort)?;
            Ok((stats, Some(bundle)))
        },
        bundle_name,
        code,
        server,
        on_code,
        on_transit,
        progress,
        cancel,
    )
    .await
}

/// The part [`send_folder`] and [`send_files`] share: run `build` to write the
/// archive into a private temp workspace, send it under a directory offer -
/// loose, if `build` says what the bundle holds - and clean the workspace up
/// on every exit path. Nothing is offered - no
/// code is even allocated - until the archive is complete.
async fn send_staged_zip<B, F, G, H>(
    build: B,
    dir_name: &str,
    code: Option<&str>,
    server: &ServerConfig,
    on_code: F,
    on_transit: G,
    progress: H,
    cancel: impl std::future::Future<Output = ()>,
) -> Result<(), Error>
where
    B: FnOnce(
            &Path,
            &std::sync::atomic::AtomicBool,
        ) -> Result<(FolderStats, Option<LooseBundle>), Error>
        + Send
        + 'static,
    F: FnOnce(String),
    G: FnOnce(String),
    H: FnMut(u64, u64) + 'static,
{
    let work = async {
        // If `cancel` fires mid-zip, dropping this future sets the abort flag
        // (via the guard) and the zipping thread bails at the next entry.
        static WORKSPACES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let work_dir = std::env::temp_dir().join(format!(
            "pg-sendfolder-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0),
            WORKSPACES.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&work_dir)?;
        let _workspace = RemoveDirOnDrop(work_dir.clone());
        let zip_path = work_dir.join("payload.zip");

        let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _abort_guard = AbortOnDrop(abort.clone());
        let (stats, loose) = {
            let dest = zip_path.clone();
            blocking::unblock(move || build(&dest, &abort)).await?
        };

        send_zip_inner(
            &zip_path,
            dir_name,
            stats.num_files,
            stats.num_bytes,
            loose,
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
///
/// `loose` marks the archive as a selection of loose items rather than one
/// folder, and says how many files and folders are at its top level - see
/// [`send_files`], whose archive the app builds itself here.
pub async fn send_zip_as_folder<F, G, H>(
    zip_path: impl AsRef<Path>,
    dir_name: &str,
    num_files: u64,
    num_bytes: u64,
    loose: Option<LooseBundle>,
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
        loose,
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

/// Shared sending half of [`send_staged_zip`] / [`send_zip_as_folder`].
/// Callers race this against their cancel future.
async fn send_zip_inner<F, G, H>(
    zip_path: &Path,
    dir_name: &str,
    num_files: u64,
    num_bytes: u64,
    loose: Option<LooseBundle>,
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
        loose,
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
    /// Set when the sender offered a selection of loose items, not one
    /// folder: what `accept` unpacks belongs directly in the receive folder,
    /// and `dir_name` is only the name a client without this extension would
    /// have given it. The counts are the files and folders at the top level,
    /// sender-claimed like everything else here; they word the prompt ("7
    /// files and 2 folders") and nothing is enforced against them.
    /// `accept` itself does the same either way - it returns the unpacked
    /// directory - because moving things out of staging is the app's step.
    pub loose: Option<LooseBundle>,
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
    /// The message, when the sender offered text rather than a file. A text
    /// offer is already complete: it was acknowledged during `request_receive`,
    /// so there is nothing to accept and `file_name`/`file_size` mean nothing.
    pub text: Option<String>,
    offer: Offer,
}

enum Offer {
    File(transfer::ReceiveRequest),
    Text,
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
        let mailbox = open_mailbox(server, Some(parsed), false, CONNECT_TIMEOUT).await?;
        let wormhole = Wormhole::connect(mailbox).await?;
        let offer = transfer::request_offer(
            wormhole,
            relay_hints,
            Abilities::ALL,
            pending::<()>(),
        )
        .await?
        .ok_or(Error::Cancelled)?;

        let request = match offer {
            transfer::IncomingOffer::Text(text) => {
                return Ok(PendingReceive {
                    file_name: String::new(),
                    file_size: 0,
                    folder: None,
                    text: Some(text),
                    offer: Offer::Text,
                });
            },
            transfer::IncomingOffer::File(request) => request,
        };

        let folder = request.directory_offer().map(|d| FolderOffer {
            dir_name: sanitize_dir_name(&d.dir_name),
            num_files: d.num_files,
            num_bytes: d.num_bytes,
            loose: d.loose,
        });
        Ok(PendingReceive {
            file_name: sanitize_file_name(&request.file_name()),
            file_size: request.file_size(),
            folder,
            text: None,
            offer: Offer::File(request),
        })
    };
    futures_lite::future::or(work, async {
        cancel.await;
        Err(Error::Cancelled)
    })
    .await
}

/// A file staged inside the destination directory for one transfer.
///
/// A transfer that does not complete must not leave its partial file behind:
/// the next transfer of the same name would be staged as `name (1).ext`, and
/// that suffix reaches the name the caller finally saves under. The cleanup
/// lives in `Drop` because a cancelled transfer never unwinds through an error
/// path - the apps cancel by aborting the UniFFI future, which drops this one
/// mid-write, so nothing written after the `await` would run. Removal is
/// synchronous: `Drop` cannot await, and unlinking one file is cheap.
struct StagedFile {
    path: PathBuf,
    /// Held so the guard closes the handle before unlinking; Windows will not
    /// remove a file that is still open.
    file: Option<async_fs::File>,
    keep: bool,
}

impl StagedFile {
    fn new(path: PathBuf, file: async_fs::File) -> Self {
        Self {
            path,
            file: Some(file),
            keep: false,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// The handle the transfer writes into; only valid before `close`.
    fn file(&mut self) -> &mut async_fs::File {
        self.file.as_mut().expect("staged file already closed")
    }

    /// Done writing. The file stays on disk, still guarded.
    fn close(&mut self) {
        self.file = None;
    }

    /// The transfer completed: hand the path over and stop guarding it.
    fn keep(mut self) -> PathBuf {
        self.keep = true;
        self.path.clone()
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.file = None;
        if !self.keep {
            std::fs::remove_file(&self.path).ok();
        }
    }
}

/// A directory staged inside the destination directory, removed unless the
/// transfer that fills it completes. Same reasoning as `StagedFile`: a folder
/// left half-extracted would push the next one of that name to `name (1)`.
struct StagedDir {
    path: PathBuf,
    keep: bool,
}

impl StagedDir {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(mut self) -> PathBuf {
        self.keep = true;
        self.path.clone()
    }
}

impl Drop for StagedDir {
    fn drop(&mut self) {
        if !self.keep {
            std::fs::remove_dir_all(&self.path).ok();
        }
    }
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
        let request = match self.offer {
            Offer::Text => return Err(Error::NotAFileOffer),
            Offer::File(request) => request,
        };
        match &self.folder {
            None => {
                let (path, file) = create_unique(dest_dir, &self.file_name).await?;
                let mut staged = StagedFile::new(path, file);
                request
                    .accept(
                        |info| on_transit(describe_transit(&info)),
                        progress,
                        staged.file(),
                        cancel,
                    )
                    .await?;
                staged.close();
                Ok(staged.keep())
            },
            Some(folder) => {
                let folder = folder.clone();
                let (zip_path, zip_file) = create_unique(dest_dir, &self.file_name).await?;
                // The zip is scratch either way, so this guard is never kept:
                // it goes on success, on failure and on cancellation alike.
                let mut zip = StagedFile::new(zip_path, zip_file);
                let received = request
                    .accept(
                        |info| on_transit(describe_transit(&info)),
                        progress,
                        zip.file(),
                        cancel,
                    )
                    .await;
                zip.close();
                received?;

                let dest = StagedDir::new(create_unique_dir(dest_dir, &folder.dir_name).await?);
                let cap = unpack_cap(folder.num_bytes);
                let unpacked = {
                    let (src, out) = (zip.path().to_path_buf(), dest.path().to_path_buf());
                    blocking::unblock(move || unzip_into_sync(&src, &out, cap)).await
                };
                // Leave nothing half-extracted behind.
                unpacked?;
                Ok(dest.keep())
            },
        }
    }

    /// Decline the offer; the sender sees the transfer fail cleanly.
    pub async fn reject(self) -> Result<(), Error> {
        match self.offer {
            // A text offer was acknowledged the moment it arrived; there is no
            // sender still waiting on a decision to decline.
            Offer::Text => Ok(()),
            Offer::File(request) => {
                request.reject().await?;
                Ok(())
            },
        }
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

/// A zip archive being written, with the running totals a directory offer
/// reports. Shared by the two things that get zipped: one folder's contents,
/// and a selection of loose items.
struct ZipSink {
    writer: zip::ZipWriter<std::io::BufWriter<std::fs::File>>,
    stats: FolderStats,
    buf: Vec<u8>,
}

impl ZipSink {
    fn create(dest_zip: &Path) -> Result<Self, Error> {
        let file = std::fs::File::create(dest_zip)?;
        Ok(Self {
            writer: zip::ZipWriter::new(std::io::BufWriter::new(file)),
            stats: FolderStats {
                num_files: 0,
                num_bytes: 0,
            },
            buf: vec![0u8; 64 * 1024],
        })
    }

    fn options() -> zip::write::SimpleFileOptions {
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
    }

    /// Directories are stored so that empty ones survive.
    fn add_dir(&mut self, entry_name: &str) -> Result<(), Error> {
        self.writer
            .add_directory(format!("{entry_name}/"), Self::options())?;
        Ok(())
    }

    fn add_file(&mut self, path: &Path, entry_name: &str, len: u64) -> Result<(), Error> {
        use std::io::{Read, Write};
        const ZIP64_THRESHOLD: u64 = 0xFFFF_FFFF;

        let opts = if len >= ZIP64_THRESHOLD {
            Self::options().large_file(true)
        } else {
            Self::options()
        };
        self.writer.start_file(entry_name, opts)?;
        let mut src = std::fs::File::open(path)?;
        loop {
            let n = src.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            self.writer.write_all(&self.buf[..n])?;
            self.stats.num_bytes += n as u64;
        }
        self.stats.num_files += 1;
        Ok(())
    }

    /// Everything under `root`, with entry paths starting at `prefix` (empty
    /// for the archive root). Depth-first with sorted entries, for a
    /// deterministic archive. Symlinks are skipped: they cannot be
    /// represented portably and could point outside the tree. Checks `abort`
    /// between entries so a cancelled send stops promptly.
    fn add_tree(
        &mut self,
        root: &Path,
        prefix: &str,
        abort: &std::sync::atomic::AtomicBool,
    ) -> Result<(), Error> {
        let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), prefix.to_string())];
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
                    self.add_dir(&entry_rel)?;
                    stack.push((entry.path(), entry_rel));
                } else if meta.is_file() {
                    self.add_file(&entry.path(), &entry_rel, meta.len())?;
                }
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<FolderStats, Error> {
        use std::io::Write;
        self.writer.finish()?.flush()?;
        Ok(self.stats)
    }
}

/// Zip the contents of `src_dir` into `dest_zip` (deflate). Entry paths are
/// relative to `src_dir` - no top-level folder-name component - matching what
/// the reference CLI produces.
pub(crate) fn zip_folder_sync(
    src_dir: &Path,
    dest_zip: &Path,
    abort: &std::sync::atomic::AtomicBool,
) -> Result<FolderStats, Error> {
    let mut sink = ZipSink::create(dest_zip)?;
    sink.add_tree(src_dir, "", abort)?;
    sink.finish()
}

/// Zip a selection of files and folders into `dest_zip`, each as a top-level
/// entry under its own name; a folder goes in as a tree. This is the archive
/// of a loose bundle - see [`send_files`].
///
/// Items come from anywhere, so two can share a name; the later one is
/// renamed (see [`unique_entry_name`]). Beside the usual totals it returns
/// how many files and folders ended up at the top level, which is what the
/// receiver is told to expect. A symlink in the selection is
/// skipped, as one inside a folder is. A selection that leaves nothing to
/// send is an error rather than an empty transfer, and a path that cannot be
/// read fails the whole bundle: sending "most of" what was picked would be
/// worse than sending none of it.
pub(crate) fn zip_items_sync(
    items: &[PathBuf],
    dest_zip: &Path,
    abort: &std::sync::atomic::AtomicBool,
) -> Result<(FolderStats, LooseBundle), Error> {
    let nothing_to_send = || {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "nothing to send",
        ))
    };

    let mut sink = ZipSink::create(dest_zip)?;
    let mut taken = std::collections::HashSet::new();
    // What ends up at the top level, which is what the receiver is told to
    // expect - not what was picked: a skipped symlink is in neither count.
    let mut bundle = LooseBundle {
        files: 0,
        folders: 0,
    };
    for item in items {
        if abort.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let meta = std::fs::symlink_metadata(item)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        // `file_name` is None for `/` and for paths ending in `..`; neither is
        // something a picker hands over, and neither has a name to send under.
        let Some(name) = item.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("path has no name: {}", item.display()),
            )));
        };
        if meta.is_dir() {
            let entry_name = unique_entry_name(&mut taken, &name, true);
            sink.add_dir(&entry_name)?;
            sink.add_tree(item, &entry_name, abort)?;
            bundle.folders += 1;
        } else if meta.is_file() {
            let entry_name = unique_entry_name(&mut taken, &name, false);
            sink.add_file(item, &entry_name, meta.len())?;
            bundle.files += 1;
        }
        // Anything else - a socket, a device - is nothing that can be sent.
    }
    if bundle.files + bundle.folders == 0 {
        return Err(nothing_to_send());
    }
    Ok((sink.finish()?, bundle))
}

/// A top-level name for a bundle entry that no earlier entry has: `name`
/// itself, else `name (1).ext`, `name (2).ext`... - or `name (1)` for a
/// folder, whose dots are not an extension. The same shapes `create_unique`
/// and `create_unique_dir` give a file on disk.
///
/// Names are compared without regard to case. `Photo.JPG` and `photo.jpg`
/// are two files where they were picked, but the receiver may well be a
/// Windows disk or a memory card where they are one.
pub(crate) fn unique_entry_name(
    taken: &mut std::collections::HashSet<String>,
    name: &str,
    is_dir: bool,
) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !is_dir && !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut n = 0u32;
    loop {
        let candidate = if n == 0 {
            name.to_string()
        } else {
            format!("{stem} ({n}){ext}")
        };
        if taken.insert(candidate.to_lowercase()) {
            return candidate;
        }
        n += 1;
    }
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

    /// A server that takes the connection and then says nothing: what a
    /// device behind a dead route, or a server that has hung, looks like.
    fn silent_server() -> (std::net::TcpListener, ServerConfig) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = ServerConfig {
            rendezvous_url: Some(format!("ws://{}/v1", listener.local_addr().unwrap())),
            transit_url: None,
        };
        (listener, server)
    }

    #[test]
    fn a_server_that_never_answers_times_out() {
        futures_lite::future::block_on(async {
            let (_listener, server) = silent_server();
            let timeout = std::time::Duration::from_millis(300);

            let started = std::time::Instant::now();
            let fresh = open_mailbox(&server, None, true, timeout).await;
            assert!(matches!(fresh, Err(Error::ConnectTimeout)));
            assert!(started.elapsed() < std::time::Duration::from_secs(5));

            let code: magic_wormhole::Code = "7-crossover-clockwork".parse().unwrap();
            let claimed = open_mailbox(&server, Some(code.clone()), true, timeout).await;
            assert!(matches!(claimed, Err(Error::ConnectTimeout)));
            let joined = open_mailbox(&server, Some(code), false, timeout).await;
            assert!(matches!(joined, Err(Error::ConnectTimeout)));
        });
    }

    /// The message crosses both bindings as a string and `friendlyError` in
    /// packages/core matches it, so it must not drift - and must not contain
    /// "rendezvous", which that file reads as an unreachable server.
    #[test]
    fn connect_timeout_message_is_pinned() {
        assert_eq!(
            Error::ConnectTimeout.to_string(),
            "no answer from the connection server in time"
        );
    }

    #[test]
    fn a_crowded_code_is_told_apart_from_an_unreachable_server() {
        use magic_wormhole::{rendezvous::RendezvousError, WormholeError};

        let crowded = WormholeError::ServerError(RendezvousError::Server("crowded".into()));
        assert!(matches!(Error::from(crowded), Error::Crowded));

        // Anything else the server says keeps the library's own wording.
        let other = WormholeError::ServerError(RendezvousError::Server("bad mood".into()));
        let other = Error::from(other);
        assert!(matches!(other, Error::Wormhole(_)));
        assert_eq!(other.to_string(), "Error with the rendezvous server connection");
    }

    /// `friendlyError` in packages/core matches this text. It must not drift,
    /// and must not contain "rendezvous", "peer", "transit" or "network",
    /// which that file reads as other failures.
    #[test]
    fn crowded_message_is_pinned() {
        assert_eq!(
            Error::Crowded.to_string(),
            "this code already has two devices on it"
        );
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

    /// A fresh scratch directory for one test.
    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pg-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Entry names of an archive, sorted, directories with their slash.
    fn entry_names(zip_path: &Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        names
    }

    /// Build a bundle from `items` and unpack it the way a receiver does.
    fn bundle_roundtrip(root: &Path, items: &[PathBuf]) -> (FolderStats, PathBuf) {
        let zip = root.join("bundle.zip");
        let (stats, _) = zip_items_sync(items, &zip, &no_abort()).unwrap();
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        unzip_into_sync(&zip, &out, unpack_cap(stats.num_bytes)).unwrap();
        (stats, out)
    }

    #[test]
    fn bundle_puts_each_file_at_the_top_level() {
        let root = scratch("bundle-flat");
        let a = root.join("from/here/a.txt");
        let b = root.join("from/there/b.bin");
        let c = root.join("elsewhere/c");
        write(&a, b"alpha");
        write(&b, &[9u8; 70_000]); // spans several copy buffers
        write(&c, b"");

        let (stats, out) = bundle_roundtrip(&root, &[a, b, c]);
        assert_eq!(stats.num_files, 3);
        assert_eq!(stats.num_bytes, 5 + 70_000);
        assert_eq!(
            entry_names(&root.join("bundle.zip")),
            ["a.txt", "b.bin", "c"]
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(out.join("b.bin")).unwrap(), [9u8; 70_000]);
        assert_eq!(std::fs::read(out.join("c")).unwrap(), b"");
        // Nothing of where the files came from survives.
        assert!(!out.join("from").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_takes_a_folder_as_a_tree_beside_the_files() {
        let root = scratch("bundle-mixed");
        let file = root.join("pick/notes.txt");
        let folder = root.join("pick/album");
        write(&file, b"notes");
        write(&folder.join("one.jpg"), b"1");
        write(&folder.join("deep/er/two.jpg"), b"22");
        std::fs::create_dir_all(folder.join("empty")).unwrap();

        let (stats, out) = bundle_roundtrip(&root, &[file, folder]);
        // Files inside the folder count; the folders themselves do not.
        assert_eq!(stats.num_files, 3);
        assert_eq!(stats.num_bytes, 5 + 1 + 2);
        assert_eq!(std::fs::read(out.join("notes.txt")).unwrap(), b"notes");
        assert_eq!(std::fs::read(out.join("album/one.jpg")).unwrap(), b"1");
        assert_eq!(
            std::fs::read(out.join("album/deep/er/two.jpg")).unwrap(),
            b"22"
        );
        assert!(out.join("album/empty").is_dir());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_of_only_an_empty_folder_still_carries_it() {
        let root = scratch("bundle-emptydir");
        let a = root.join("pick/hollow");
        let b = root.join("pick/also-hollow");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let (stats, out) = bundle_roundtrip(&root, &[a, b]);
        assert_eq!(stats.num_files, 0);
        assert_eq!(stats.num_bytes, 0);
        assert!(out.join("hollow").is_dir());
        assert!(out.join("also-hollow").is_dir());
        std::fs::remove_dir_all(&root).ok();
    }

    /// The two counts are what lands at the top level of the receive folder,
    /// because that is the sentence the receiver reads: "7 files and 2
    /// folders". Files inside a picked folder belong to `num_files` only.
    #[test]
    fn bundle_counts_what_lands_at_the_top_level() {
        let root = scratch("bundle-counts");
        let counts = |items: &[PathBuf]| {
            let (stats, bundle) =
                zip_items_sync(items, &root.join("bundle.zip"), &no_abort()).unwrap();
            (bundle.files, bundle.folders, stats.num_files)
        };
        let file = |name: &str| {
            let path = root.join("files").join(name);
            write(&path, b"x");
            path
        };
        let folder = |name: &str, inside: usize| {
            let path = root.join("folders").join(name);
            std::fs::create_dir_all(&path).unwrap();
            for i in 0..inside {
                write(&path.join(format!("sub/{i}.txt")), b"y");
            }
            path
        };

        // Files only: both numbers agree.
        assert_eq!(counts(&[file("a"), file("b"), file("c")]), (3, 0, 3));
        // Files and folders: 2 + 5 + 3 files in all, 2 and 2 at the top.
        assert_eq!(
            counts(&[file("a"), folder("one", 5), file("b"), folder("two", 3)]),
            (2, 2, 10)
        );
        // Folders only, one of them empty.
        assert_eq!(counts(&[folder("one", 5), folder("hollow", 0)]), (0, 2, 5));
        // Same-name items are renamed, not merged: each still counts.
        let twin = root.join("elsewhere/a");
        write(&twin, b"z");
        assert_eq!(counts(&[file("a"), twin]), (2, 0, 2));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_keeps_same_name_files_apart() {
        let root = scratch("bundle-clash");
        let one = root.join("camera/IMG_0001.jpg");
        let two = root.join("screenshots/IMG_0001.jpg");
        let three = root.join("downloads/IMG_0001.jpg");
        write(&one, b"camera");
        write(&two, b"screenshot");
        write(&three, b"download");

        let (stats, out) = bundle_roundtrip(&root, &[one, two, three]);
        assert_eq!(stats.num_files, 3);
        // In the order they were picked: the first keeps its name.
        assert_eq!(std::fs::read(out.join("IMG_0001.jpg")).unwrap(), b"camera");
        assert_eq!(
            std::fs::read(out.join("IMG_0001 (1).jpg")).unwrap(),
            b"screenshot"
        );
        assert_eq!(
            std::fs::read(out.join("IMG_0001 (2).jpg")).unwrap(),
            b"download"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_keeps_a_file_and_a_folder_of_one_name_apart() {
        let root = scratch("bundle-clash-kinds");
        let file = root.join("a/report");
        let folder = root.join("b/report");
        write(&file, b"a file called report");
        write(&folder.join("inside.txt"), b"in the folder");

        let (_, out) = bundle_roundtrip(&root, &[file, folder]);
        assert_eq!(
            std::fs::read(out.join("report")).unwrap(),
            b"a file called report"
        );
        assert_eq!(
            std::fs::read(out.join("report (1)/inside.txt")).unwrap(),
            b"in the folder"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_names_that_differ_only_in_case_are_a_clash() {
        let root = scratch("bundle-clash-case");
        let lower = root.join("a/photo.jpg");
        let upper = root.join("b/Photo.JPG");
        write(&lower, b"lower");
        write(&upper, b"upper");

        let zip = root.join("bundle.zip");
        zip_items_sync(&[lower, upper], &zip, &no_abort()).unwrap();
        assert_eq!(entry_names(&zip), ["Photo (1).JPG", "photo.jpg"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unique_entry_name_shapes() {
        let mut taken = std::collections::HashSet::new();
        let mut name = |n: &str, is_dir: bool| unique_entry_name(&mut taken, n, is_dir);

        assert_eq!(name("a.txt", false), "a.txt");
        assert_eq!(name("a.txt", false), "a (1).txt");
        assert_eq!(name("a.txt", false), "a (2).txt");
        // A picked file that is itself called "a (1).txt" does not collide
        // silently with the one that was renamed to it.
        assert_eq!(name("a (1).txt", false), "a (1) (1).txt");

        // No extension, and a dot-file whose whole name is its "extension".
        assert_eq!(name("noext", false), "noext");
        assert_eq!(name("noext", false), "noext (1)");
        assert_eq!(name(".hidden", false), ".hidden");
        assert_eq!(name(".hidden", false), ".hidden (1)");

        // Only the last dot is an extension.
        assert_eq!(name("b.tar.gz", false), "b.tar.gz");
        assert_eq!(name("b.tar.gz", false), "b.tar (1).gz");

        // A folder's dots are part of its name.
        assert_eq!(name("my.stuff", true), "my.stuff");
        assert_eq!(name("my.stuff", true), "my.stuff (1)");
    }

    /// The bundle's renaming and the receiver's on-disk renaming must agree,
    /// or the same clash would read differently depending on which side
    /// happened to resolve it.
    #[test]
    fn unique_entry_name_matches_what_create_unique_does_on_disk() {
        futures_lite::future::block_on(async {
            let dir = scratch("bundle-naming-agrees");
            let mut taken = std::collections::HashSet::new();
            for name in ["a.txt", "a.txt", "a.txt", "noext", "noext", "b.tar.gz", "b.tar.gz"] {
                let (on_disk, _) = create_unique(&dir, name).await.unwrap();
                assert_eq!(
                    on_disk.file_name().unwrap().to_string_lossy(),
                    unique_entry_name(&mut taken, name, false)
                );
            }
            for name in ["photos", "photos", "my.stuff", "my.stuff"] {
                let on_disk = create_unique_dir(&dir, name).await.unwrap();
                assert_eq!(
                    on_disk.file_name().unwrap().to_string_lossy(),
                    unique_entry_name(&mut taken, name, true)
                );
            }
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn bundle_refuses_an_empty_selection() {
        let root = scratch("bundle-empty");
        let zip = root.join("bundle.zip");
        let err = zip_items_sync(&[], &zip, &no_abort()).unwrap_err();
        assert!(matches!(err, Error::Io(_)), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A file that was there when it was picked and is gone when it is read:
    /// the bundle fails as a whole instead of going out one file short.
    #[test]
    fn bundle_fails_when_a_picked_path_is_gone() {
        let root = scratch("bundle-gone");
        let here = root.join("here.txt");
        write(&here, b"present");
        let gone = root.join("gone.txt");

        let zip = root.join("bundle.zip");
        let err = zip_items_sync(&[here, gone], &zip, &no_abort()).unwrap_err();
        assert!(matches!(err, Error::Io(_)), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_skips_symlinks_and_refuses_a_selection_of_nothing_else() {
        let root = scratch("bundle-sym");
        let real = root.join("real.txt");
        write(&real, b"data");
        let link = root.join("link");
        std::os::unix::fs::symlink("/etc/passwd", &link).unwrap();
        // A symlink inside a picked folder is skipped as well.
        let folder = root.join("folder");
        write(&folder.join("kept.txt"), b"kept");
        std::os::unix::fs::symlink("/etc/passwd", folder.join("inner-link")).unwrap();

        let zip = root.join("bundle.zip");
        let (stats, bundle) =
            zip_items_sync(&[real, link.clone(), folder], &zip, &no_abort()).unwrap();
        assert_eq!(stats.num_files, 2);
        // Three were picked; the receiver is told about the two that went in.
        assert_eq!(
            bundle,
            LooseBundle {
                files: 1,
                folders: 1
            }
        );
        assert_eq!(entry_names(&zip), ["folder/", "folder/kept.txt", "real.txt"]);

        let err = zip_items_sync(&[link], &zip, &no_abort()).unwrap_err();
        assert!(matches!(err, Error::Io(_)), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundle_stops_when_aborted() {
        let root = scratch("bundle-abort");
        let a = root.join("a.txt");
        write(&a, b"a");
        let aborted = std::sync::atomic::AtomicBool::new(true);
        let err = zip_items_sync(&[a], &root.join("bundle.zip"), &aborted).unwrap_err();
        assert!(matches!(err, Error::Cancelled), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A bundle is unpacked by the same code as a folder, so the same two
    /// guards stand: a sender cannot claim five small files and deliver a
    /// disk-filler, and cannot write outside the staging directory.
    #[test]
    fn bundle_unpack_is_capped_like_a_folder() {
        let root = scratch("bundle-cap");
        let big = root.join("big.bin");
        let small = root.join("small.txt");
        write(&big, &vec![0u8; 1_000_000]);
        write(&small, b"x");

        let zip = root.join("bundle.zip");
        zip_items_sync(&[small, big], &zip, &no_abort()).unwrap();
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        // The offer claimed far less than the archive holds.
        let err = unzip_into_sync(&zip, &out, 1024).unwrap_err();
        assert!(matches!(err, Error::Archive(_)), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The folder archive is what it always was: this refactor moved its
    /// writer, and a real "Send folder" must not have changed shape with it.
    #[test]
    fn folder_archive_has_no_top_level_folder_entry() {
        let root = scratch("zip-shape");
        let src = root.join("my-folder");
        write(&src.join("a.txt"), b"a");
        write(&src.join("sub/b.txt"), b"b");
        let zip = root.join("out.zip");
        zip_folder_sync(&src, &zip, &no_abort()).unwrap();
        assert_eq!(entry_names(&zip), ["a.txt", "sub/", "sub/b.txt"]);
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

    /// Text round-trip against the public mailbox server; run with
    /// `cargo test -- --ignored` when online.
    ///
    /// Worth having as a network test rather than a unit test: the whole point
    /// of a message offer is that it negotiates no transit, and only a real
    /// peer proves the sequence is right.
    #[test]
    #[ignore]
    fn text_roundtrip_over_public_server() {
        futures_lite::future::block_on(async {
            let code = format!(
                "9{}-text-test",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
                    % 1_000_000
            );
            let message = "hello from the engine - \u{e4}\u{f6}\u{fc} \u{1f600} \n multi\nline";
            let send_code = code.clone();
            let sender = std::thread::spawn(move || {
                futures_lite::future::block_on(send_text(
                    message,
                    Some(&send_code),
                    &ServerConfig::default(),
                    |_| {},
                    futures_lite::future::pending::<()>(),
                ))
            });
            std::thread::sleep(std::time::Duration::from_secs(2));
            let pending = request_receive(
                &code,
                &ServerConfig::default(),
                futures_lite::future::pending::<()>(),
            )
            .await
            .unwrap();
            sender.join().unwrap().unwrap();
            assert_eq!(pending.text.as_deref(), Some(message));
            assert!(pending.folder.is_none());
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
            // A real folder carries no loose marker: it must arrive as a
            // folder, here and in every other client.
            assert_eq!(offer.loose, None);
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

    /// A code no other run of these tests will be using.
    fn test_code(tag: &str) -> String {
        format!(
            "9{}-{tag}-integration-test",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
                % 1_000_000
        )
    }

    /// A sender's `on_code` paired with a wait for it. The code is reported
    /// once the nameplate is claimed, which is the earliest a receiver can
    /// join - and for a bundle that is only after the archive has been built,
    /// however long that takes. Sleeping a fixed time instead is a guess: a
    /// receiver that turns up early finds no nameplate and fails.
    fn code_claimed() -> (impl FnOnce(String) + Send + 'static, impl FnOnce()) {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        (
            move |_| {
                tx.send(()).ok();
            },
            move || {
                rx.recv_timeout(std::time::Duration::from_secs(120))
                    .expect("the sender never claimed its code");
            },
        )
    }

    /// Bytes that do not compress, so an archive of them is as large as they
    /// are and a transfer of it lasts long enough to be interrupted.
    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state >> 8) as u8
            })
            .collect()
    }

    /// Several files and a folder in one transfer (a loose bundle) against
    /// the mailbox server; run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn files_roundtrip_over_public_server() {
        futures_lite::future::block_on(async {
            let dir = scratch("files-rt");
            let one = dir.join("camera/IMG_0001.jpg");
            let two = dir.join("screenshots/IMG_0001.jpg");
            let album = dir.join("pick/album");
            let one_bytes = noise(48 * 1024, 1);
            write(&one, &one_bytes);
            write(&two, b"second of that name");
            write(&album.join("nested/three.bin"), &[3u8; 1024]);
            std::fs::create_dir_all(album.join("hollow")).unwrap();
            let recv_dir = dir.join("recv");
            std::fs::create_dir_all(&recv_dir).unwrap();

            let code = test_code("files");
            let send_code = code.clone();
            let items = vec![one, two, album];
            let (on_code, wait_for_sender) = code_claimed();
            let sender = std::thread::spawn(move || {
                futures_lite::future::block_on(send_files(
                    &items,
                    "3 files - 2026-10-10 14.32",
                    Some(&send_code),
                    &test_server(),
                    on_code,
                    |_| {},
                    |_, _| {},
                    pending::<()>(),
                ))
            });
            wait_for_sender();

            let pending_receive = request_receive(&code, &test_server(), pending::<()>())
                .await
                .unwrap();
            let offer = pending_receive.folder.clone().expect("a directory offer");
            // Two files and one folder at the top level; the third file is
            // inside the folder and shows only in `num_files`.
            assert_eq!(
                offer.loose,
                Some(LooseBundle {
                    files: 2,
                    folders: 1
                }),
                "the loose marker did not survive the wire"
            );
            assert_eq!(offer.dir_name, "3 files - 2026-10-10 14.32");
            assert_eq!(offer.num_files, 3);
            assert_eq!(offer.num_bytes, 48 * 1024 + 19 + 1024);

            let staged = pending_receive
                .accept(&recv_dir, |_| {}, |_, _| {}, pending::<()>())
                .await
                .unwrap();
            sender.join().unwrap().unwrap();

            // `accept` hands back the unpacked directory; its children are
            // what the app moves into the receive folder.
            assert_eq!(std::fs::read(staged.join("IMG_0001.jpg")).unwrap(), one_bytes);
            assert_eq!(
                std::fs::read(staged.join("IMG_0001 (1).jpg")).unwrap(),
                b"second of that name"
            );
            assert_eq!(
                std::fs::read(staged.join("album/nested/three.bin")).unwrap(),
                [3u8; 1024]
            );
            assert!(staged.join("album/hollow").is_dir());
            // Only the unpacked directory is left: the staged zip is gone.
            let left: Vec<_> = std::fs::read_dir(&recv_dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            assert_eq!(left, [staged.clone()]);
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// A bundle built by the app itself (the Android path) carries the marker
    /// only when asked to: the same archive sent without it is a folder.
    ///
    /// Run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn app_staged_zip_is_loose_only_when_marked() {
        futures_lite::future::block_on(async {
            let dir = scratch("staged-zip");
            let a = dir.join("a.txt");
            let b = dir.join("b.txt");
            write(&a, b"a");
            write(&b, b"bb");
            let zip = dir.join("staged.zip");
            let (stats, bundle) = zip_items_sync(&[a, b], &zip, &no_abort()).unwrap();

            for loose in [Some(bundle), None] {
                let code = test_code(if loose.is_some() { "marked" } else { "unmarked" });
                let (send_code, zip_path) = (code.clone(), zip.clone());
                let (on_code, wait_for_sender) = code_claimed();
                let sender = std::thread::spawn(move || {
                    futures_lite::future::block_on(send_zip_as_folder(
                        &zip_path,
                        "2 files",
                        stats.num_files,
                        stats.num_bytes,
                        loose,
                        Some(&send_code),
                        &test_server(),
                        on_code,
                        |_| {},
                        |_, _| {},
                        pending::<()>(),
                    ))
                });
                wait_for_sender();

                let pending_receive = request_receive(&code, &test_server(), pending::<()>())
                    .await
                    .unwrap();
                let offer = pending_receive.folder.clone().expect("a directory offer");
                assert_eq!(offer.loose, loose);
                assert_eq!(offer.num_files, 2);
                pending_receive.reject().await.unwrap();
                // The sender sees the rejection as a failed transfer.
                assert!(sender.join().unwrap().is_err());
            }
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// A bundle cancelled mid-transfer leaves nothing in the staging
    /// directory - no partial archive and no half-unpacked files - so "all or
    /// nothing" holds: the receiver never ends up with some of the files.
    ///
    /// Run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn cancelled_bundle_leaves_nothing_staged() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        futures_lite::future::block_on(async {
            let dir = scratch("files-cancel");
            // Incompressible, so the archive is still in flight when the
            // first progress callback arrives.
            let a = dir.join("src/a.bin");
            let b = dir.join("src/b.bin");
            write(&a, &noise(16 * 1024 * 1024, 7));
            write(&b, &noise(16 * 1024 * 1024, 11));
            let recv_dir = dir.join("recv");
            std::fs::create_dir_all(&recv_dir).unwrap();

            let code = test_code("files-cancel");
            let send_code = code.clone();
            let items = vec![a, b];
            let (on_code, wait_for_sender) = code_claimed();
            let sender = std::thread::spawn(move || {
                futures_lite::future::block_on(send_files(
                    &items,
                    "2 files",
                    Some(&send_code),
                    &test_server(),
                    on_code,
                    |_| {},
                    |_, _| {},
                    pending::<()>(),
                ))
            });
            // 32 MiB to deflate before there is a code to join.
            wait_for_sender();

            let pending_receive = request_receive(&code, &test_server(), pending::<()>())
                .await
                .unwrap();
            let started = Arc::new(AtomicBool::new(false));
            let flag = started.clone();
            let accepting = pending_receive.accept(
                &recv_dir,
                |_| {},
                move |done, _| {
                    if done > 0 {
                        flag.store(true, Ordering::SeqCst);
                    }
                },
                pending::<()>(),
            );
            let finished = futures_lite::future::or(
                async { Some(accepting.await) },
                async {
                    while !started.load(Ordering::SeqCst) {
                        async_io::Timer::after(std::time::Duration::from_millis(5)).await;
                    }
                    None
                },
            )
            .await;
            assert!(
                finished.is_none(),
                "the transfer finished before it could be cancelled - send bigger files"
            );

            let staged: Vec<_> = std::fs::read_dir(&recv_dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert!(staged.is_empty(), "left behind: {staged:?}");
            // The sender is left to notice the dropped connection by itself.
            drop(sender);
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// The sender's workspace - the staged archive of a bundle - is removed
    /// when the send is cancelled before anybody joins.
    #[test]
    fn cancelled_bundle_send_removes_its_workspace() {
        futures_lite::future::block_on(async {
            let dir = scratch("files-send-cancel");
            let a = dir.join("a.txt");
            let b = dir.join("b.txt");
            write(&a, b"a");
            write(&b, b"b");

            let before = sender_workspaces();
            let result = send_files(
                &[a, b],
                "2 files",
                None,
                &ServerConfig::default(),
                |_| {},
                |_| {},
                |_, _| {},
                // Cancelled at once: the send never reaches the network.
                async {},
            )
            .await;
            assert!(matches!(result, Err(Error::Cancelled)), "got: {result:?}");
            // The zipping thread is detached; give it a moment to see the
            // abort flag before looking.
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert_eq!(sender_workspaces(), before);
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// This process's sender workspaces currently in the temp directory.
    fn sender_workspaces() -> Vec<std::ffi::OsString> {
        let prefix = format!("pg-sendfolder-{}-", std::process::id());
        let mut found: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .filter(|n| n.to_string_lossy().starts_with(&prefix))
            .collect();
        found.sort();
        found
    }

    /// Where the network tests below meet: the public server by default, or a
    /// local mailbox through `PG_RENDEZVOUS_URL` - the same variable the
    /// `send`/`recv` examples read.
    fn test_server() -> ServerConfig {
        ServerConfig {
            rendezvous_url: std::env::var("PG_RENDEZVOUS_URL").ok(),
            transit_url: std::env::var("PG_TRANSIT_URL").ok(),
        }
    }

    /// What the pairing handshake does: receive a tiny file and read it back
    /// the moment `receive_file` returns. The caller is handed a path, so the
    /// bytes have to be on disk by then - a small payload that never filled a
    /// buffer is exactly the case where they might not be.
    ///
    /// Run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn a_tiny_file_is_readable_the_instant_receive_returns() {
        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-tiny-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            let src_dir = dir.join("src");
            let recv_dir = dir.join("recv");
            std::fs::create_dir_all(&src_dir).unwrap();
            std::fs::create_dir_all(&recv_dir).unwrap();
            // The shape and size of a real pairing handshake.
            let body = br#"{"v":1,"name":"Nokia E72"}"#;
            let src = src_dir.join("pg-pair-handshake.json");
            std::fs::write(&src, body).unwrap();

            let code = format!(
                "9{}-tiny-integration-test",
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
                    &test_server(),
                    |_| {},
                    |_| {},
                    |_, _| {},
                    pending::<()>(),
                ))
            });
            std::thread::sleep(std::time::Duration::from_secs(2));

            let saved = receive_file(
                &code,
                &recv_dir,
                &test_server(),
                |_| {},
                |_, _| {},
                pending::<()>(),
            )
            .await
            .unwrap();
            // No sleep, no retry: read it exactly as the caller would.
            let got = std::fs::read(&saved).unwrap();
            sender.join().unwrap().unwrap();
            assert_eq!(
                got,
                body,
                "read back {} of {} bytes from {saved:?}",
                got.len(),
                body.len()
            );
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// A receive that is cancelled must leave nothing staged: a partial file
    /// left in the destination pushes the next transfer of that name to
    /// `name (1).ext`, which is the name the caller ends up saving under.
    ///
    /// Cancellation in the apps is not an error return. They abort the UniFFI
    /// future, which drops the Rust one mid-write, so the cleanup cannot live
    /// on an error path - and this test cancels the same way, by dropping the
    /// `accept` future rather than by firing its `cancel` argument.
    ///
    /// Run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn cancelled_receive_leaves_no_partial_file() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        futures_lite::future::block_on(async {
            let dir = std::env::temp_dir().join(format!("pg-cancel-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            let src_dir = dir.join("src");
            let recv_dir = dir.join("recv");
            std::fs::create_dir_all(&src_dir).unwrap();
            std::fs::create_dir_all(&recv_dir).unwrap();
            // Big enough that the transfer is still running when the first
            // progress callback arrives.
            let src = create_test_file(src_dir.to_string_lossy().into_owned(), 32 * 1024).unwrap();

            let code = format!(
                "9{}-cancel-integration-test",
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
                    &test_server(),
                    |_| {},
                    |_| {},
                    |_, _| {},
                    pending::<()>(),
                ))
            });
            std::thread::sleep(std::time::Duration::from_secs(2));

            let pending_receive = request_receive(&code, &test_server(), pending::<()>())
                .await
                .unwrap();

            // Cancel on the first bytes: the transfer is certainly in flight
            // by then, and the staged file certainly exists.
            let started = Arc::new(AtomicBool::new(false));
            let flag = started.clone();
            let accepting = pending_receive.accept(
                &recv_dir,
                |_| {},
                move |done, _| {
                    if done > 0 {
                        flag.store(true, Ordering::SeqCst);
                    }
                },
                pending::<()>(),
            );
            let finished = futures_lite::future::or(
                async { Some(accepting.await) },
                async {
                    while !started.load(Ordering::SeqCst) {
                        async_io::Timer::after(std::time::Duration::from_millis(5)).await;
                    }
                    None
                },
            )
            .await;
            assert!(
                finished.is_none(),
                "the transfer finished before it could be cancelled - send a bigger file"
            );

            let staged: Vec<_> = std::fs::read_dir(&recv_dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert!(staged.is_empty(), "left behind: {staged:?}");

            sender.join().unwrap().ok();
            std::fs::remove_dir_all(&dir).ok();
        });
    }
}
