//! The UniFFI surface: what Kotlin (Android) and, via
//! uniffi-bindgen-react-native, TypeScript see of this crate.
//!
//! Thin wrappers over the generic functions in `lib.rs` - UniFFI cannot export
//! generics, so callbacks are funneled through the `TransferListener` trait,
//! which foreign code implements.

use std::sync::{Arc, Mutex};

use futures_lite::future::pending;

use crate::{Error, PendingReceive, ServerConfig};

/// Implemented by the app (Kotlin/TypeScript) to observe a running transfer.
#[uniffi::export(with_foreign)]
pub trait TransferListener: Send + Sync {
    /// The wormhole code the receiver must use (fires once, senders only).
    fn on_code(&self, code: String);
    /// How the transit connection was established (direct vs relay).
    fn on_transit(&self, info: String);
    /// Bytes done / bytes total.
    fn on_progress(&self, done: u64, total: u64);
}

/// Send a file or folder. `code: None` generates a fresh code (reported via
/// `listener.on_code`); `code: Some(..)` opens the wormhole on that exact code
/// (paired-device flow).
#[uniffi::export]
pub async fn send_file(
    path: String,
    code: Option<String>,
    server: ServerConfig,
    listener: Arc<dyn TransferListener>,
) -> Result<(), Error> {
    let code_listener = listener.clone();
    let transit_listener = listener.clone();
    crate::send_file(
        &path,
        code.as_deref(),
        &server,
        move |code| code_listener.on_code(code),
        move |info| transit_listener.on_transit(info),
        move |done, total| listener.on_progress(done, total),
        pending::<()>(),
    )
    .await
}

/// Send a folder as a protocol-v1 directory offer: the tree at `path` is
/// zipped into a temp archive and the receiver unpacks it back into a folder.
/// Only usable where the folder is a real filesystem path (not Android SAF).
#[uniffi::export]
pub async fn send_folder(
    path: String,
    code: Option<String>,
    server: ServerConfig,
    listener: Arc<dyn TransferListener>,
) -> Result<(), Error> {
    let code_listener = listener.clone();
    let transit_listener = listener.clone();
    crate::send_folder(
        &path,
        code.as_deref(),
        &server,
        move |code| code_listener.on_code(code),
        move |info| transit_listener.on_transit(info),
        move |done, total| listener.on_progress(done, total),
        pending::<()>(),
    )
    .await
}

/// Send an already-zipped folder as a protocol-v1 directory offer. This is
/// the Android path: the app zips the SAF tree into `zip_path` (cache dir)
/// first and passes the file count and unpacked byte total it counted while
/// zipping. The zip must hold paths relative to the folder root.
#[uniffi::export]
pub async fn send_zip_as_folder(
    zip_path: String,
    dir_name: String,
    num_files: u64,
    num_bytes: u64,
    code: Option<String>,
    server: ServerConfig,
    listener: Arc<dyn TransferListener>,
) -> Result<(), Error> {
    let code_listener = listener.clone();
    let transit_listener = listener.clone();
    crate::send_zip_as_folder(
        &zip_path,
        &dir_name,
        num_files,
        num_bytes,
        code.as_deref(),
        &server,
        move |code| code_listener.on_code(code),
        move |info| transit_listener.on_transit(info),
        move |done, total| listener.on_progress(done, total),
        pending::<()>(),
    )
    .await
}

/// Phase 0 test helper: write a `size_kb` KiB file into `dir` and return its
/// path, so the spike app has something to send without a filesystem library.
#[uniffi::export]
pub fn create_test_file(dir: String, size_kb: u32) -> Result<String, Error> {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let path = std::path::Path::new(&dir).join(format!("portalgems-test-{stamp}.bin"));
    let mut file = std::fs::File::create(&path)?;
    let mut block = [0u8; 1024];
    for (i, b) in block.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    for _ in 0..size_kb {
        file.write_all(&block)?;
    }
    file.sync_all()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Folder metadata of a directory offer, for the receive confirmation UI.
/// All values are sender-claimed; the engine enforces `num_bytes` (plus
/// slack) as an unpack cap.
#[derive(uniffi::Record)]
pub struct FolderOfferInfo {
    /// Sanitized folder name
    pub dir_name: String,
    /// Number of files inside the folder
    pub num_files: u64,
    /// Total unpacked size in bytes
    pub num_bytes: u64,
}

/// A pending file (or folder) offer. Inspect `file_name`/`file_size` and
/// `folder_offer`, then `accept` into a destination directory or `reject` to
/// tell the sender you declined.
#[derive(uniffi::Object)]
pub struct IncomingFile {
    name: String,
    size: u64,
    folder: Option<crate::FolderOffer>,
    request: Mutex<Option<PendingReceive>>,
}

/// Connect to the wormhole under `code` and wait for the sender's file offer,
/// without accepting it yet. This is what allows a confirmation UI.
#[uniffi::export]
pub async fn request_receive(
    code: String,
    server: ServerConfig,
) -> Result<Arc<IncomingFile>, Error> {
    let pending_receive = crate::request_receive(&code, &server, pending::<()>()).await?;
    Ok(Arc::new(IncomingFile {
        name: pending_receive.file_name.clone(),
        size: pending_receive.file_size,
        folder: pending_receive.folder.clone(),
        request: Mutex::new(Some(pending_receive)),
    }))
}

#[uniffi::export]
impl IncomingFile {
    pub fn file_name(&self) -> String {
        self.name.clone()
    }

    pub fn file_size(&self) -> u64 {
        self.size
    }

    /// Folder metadata when this is a directory offer; `None` for plain files.
    /// When present, `accept` unpacks the folder and returns its path, and
    /// `file_name`/`file_size` describe the underlying zip transfer instead.
    pub fn folder_offer(&self) -> Option<FolderOfferInfo> {
        self.folder.as_ref().map(|f| FolderOfferInfo {
            dir_name: f.dir_name.clone(),
            num_files: f.num_files,
            num_bytes: f.num_bytes,
        })
    }

    /// Accept the offer, writing into `dest_dir`; returns the saved path
    /// (a file path, or the unpacked folder path for directory offers).
    pub async fn accept(
        &self,
        dest_dir: String,
        listener: Arc<dyn TransferListener>,
    ) -> Result<String, Error> {
        let request = self
            .request
            .lock()
            .unwrap()
            .take()
            .ok_or(Error::AlreadyConsumed)?;
        let transit_listener = listener.clone();
        let dest = request
            .accept(
                &dest_dir,
                move |info| transit_listener.on_transit(info),
                move |done, total| listener.on_progress(done, total),
                pending::<()>(),
            )
            .await?;
        Ok(dest.to_string_lossy().into_owned())
    }

    /// Decline the offer; the sender sees the transfer fail cleanly.
    pub async fn reject(&self) -> Result<(), Error> {
        let request = self
            .request
            .lock()
            .unwrap()
            .take()
            .ok_or(Error::AlreadyConsumed)?;
        request.reject().await?;
        Ok(())
    }
}

/// Receive the file offered under `code` into `dest_dir`; returns the saved path.
#[uniffi::export]
pub async fn receive_file(
    code: String,
    dest_dir: String,
    server: ServerConfig,
    listener: Arc<dyn TransferListener>,
) -> Result<String, Error> {
    let transit_listener = listener.clone();
    let path = crate::receive_file(
        &code,
        &dest_dir,
        &server,
        move |info| transit_listener.on_transit(info),
        move |done, total| listener.on_progress(done, total),
        pending::<()>(),
    )
    .await?;
    Ok(path.to_string_lossy().into_owned())
}
