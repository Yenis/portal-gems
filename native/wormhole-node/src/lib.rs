//! PortalGems desktop engine: napi-rs addon over `wormhole-core`.
//!
//! Electron's V8 memory cage forbids external ArrayBuffers, which rules out
//! the libffi-based `@ubjs/node` runtime inside Electron. This addon avoids
//! the problem entirely: only strings and f64 numbers cross the FFI boundary.
//!
//! Transfers and pending receives are tracked in id-keyed registries instead
//! of napi classes: the JS side allocates an id, passes it to the async
//! functions, and can call `cancel_transfer(id)` / `accept_receive(id, ..)` /
//! `reject_receive(id)` against it. This sidesteps napi lifetime rules for
//! async methods on class instances.

use std::collections::HashMap;
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use once_cell::sync::Lazy;
use tokio::sync::oneshot;

use wormhole_core::PendingReceive;

static CANCELS: Lazy<Mutex<HashMap<u32, oneshot::Sender<()>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static RECEIVES: Lazy<Mutex<HashMap<u32, PendingReceive>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// One transfer event; `event` is "code" | "transit" | "progress".
#[napi(object)]
#[derive(Clone)]
pub struct TransferEvent {
    pub event: String,
    pub code: Option<String>,
    pub info: Option<String>,
    pub done: Option<f64>,
    pub total: Option<f64>,
}

/// The offer produced by `request_receive`. For folder (directory) offers
/// `folder` is set and `file_name`/`file_size` describe the underlying zip
/// transfer (`<dirname>.zip`); the UI should present the folder fields.
#[napi(object)]
#[derive(Clone)]
pub struct FileOffer {
    pub file_name: String,
    pub file_size: f64,
    pub folder: Option<FolderOffer>,
}

/// Folder metadata of a directory offer (sender-claimed; the engine caps the
/// unpack at `num_bytes` plus slack).
#[napi(object)]
#[derive(Clone)]
pub struct FolderOffer {
    pub dir_name: String,
    pub num_files: f64,
    pub num_bytes: f64,
}

/// Which servers a transfer should use; empty/missing fields fall back to the
/// public magic-wormhole defaults. Mirrors `wormhole_core::ServerConfig`.
#[napi(object)]
#[derive(Clone, Default)]
pub struct ServerConfig {
    pub rendezvous_url: Option<String>,
    pub transit_url: Option<String>,
}

impl From<ServerConfig> for wormhole_core::ServerConfig {
    fn from(s: ServerConfig) -> Self {
        wormhole_core::ServerConfig {
            rendezvous_url: s.rendezvous_url,
            transit_url: s.transit_url,
        }
    }
}

type Callback = ThreadsafeFunction<TransferEvent, ErrorStrategy::Fatal>;

fn emit(cb: &Callback, event: TransferEvent) {
    cb.call(event, ThreadsafeFunctionCallMode::NonBlocking);
}

fn code_event(code: String) -> TransferEvent {
    TransferEvent { event: "code".into(), code: Some(code), info: None, done: None, total: None }
}

fn transit_event(info: String) -> TransferEvent {
    TransferEvent { event: "transit".into(), code: None, info: Some(info), done: None, total: None }
}

fn progress_event(done: u64, total: u64) -> TransferEvent {
    TransferEvent {
        event: "progress".into(),
        code: None,
        info: None,
        done: Some(done as f64),
        total: Some(total as f64),
    }
}

fn to_napi_err(e: wormhole_core::Error) -> Error {
    Error::from_reason(e.to_string())
}

/// Register a cancel channel under `id` and return the receiving future.
fn cancel_future(id: u32) -> impl std::future::Future<Output = ()> {
    let (tx, rx) = oneshot::channel();
    CANCELS.lock().unwrap().insert(id, tx);
    async move {
        // Err (sender dropped without send) must NOT cancel: never resolve.
        if rx.await.is_ok() {
            return;
        }
        futures_lite::future::pending::<()>().await
    }
}

fn clear_cancel(id: u32) {
    CANCELS.lock().unwrap().remove(&id);
}

/// Cancel the transfer registered under `id` (send, request or accept phase).
#[napi]
pub fn cancel_transfer(id: u32) {
    if let Some(tx) = CANCELS.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[napi]
pub async fn send_file(
    id: u32,
    path: String,
    code: Option<String>,
    server: ServerConfig,
    callback: Callback,
) -> Result<()> {
    let on_code = callback.clone();
    let on_transit = callback.clone();
    let on_progress = callback;
    let cancel = cancel_future(id);
    let result = wormhole_core::send_file(
        &path,
        code.as_deref(),
        &server.into(),
        move |c| emit(&on_code, code_event(c)),
        move |i| emit(&on_transit, transit_event(i)),
        move |d, t| emit(&on_progress, progress_event(d, t)),
        cancel,
    )
    .await;
    clear_cancel(id);
    result.map_err(to_napi_err)
}

/// Send the folder at `path` as a protocol-v1 directory offer (zipped into a
/// temp archive; the receiver unpacks it back into a folder).
#[napi]
pub async fn send_folder(
    id: u32,
    path: String,
    code: Option<String>,
    server: ServerConfig,
    callback: Callback,
) -> Result<()> {
    let on_code = callback.clone();
    let on_transit = callback.clone();
    let on_progress = callback;
    let cancel = cancel_future(id);
    let result = wormhole_core::send_folder(
        &path,
        code.as_deref(),
        &server.into(),
        move |c| emit(&on_code, code_event(c)),
        move |i| emit(&on_transit, transit_event(i)),
        move |d, t| emit(&on_progress, progress_event(d, t)),
        cancel,
    )
    .await;
    clear_cancel(id);
    result.map_err(to_napi_err)
}

/// Wait for the offer under `code`; park it under `id` for accept/reject.
#[napi]
pub async fn request_receive(id: u32, code: String, server: ServerConfig) -> Result<FileOffer> {
    let cancel = cancel_future(id);
    let result = wormhole_core::request_receive(&code, &server.into(), cancel).await;
    clear_cancel(id);
    let pending = result.map_err(to_napi_err)?;
    let offer = FileOffer {
        file_name: pending.file_name.clone(),
        file_size: pending.file_size as f64,
        folder: pending.folder.as_ref().map(|f| FolderOffer {
            dir_name: f.dir_name.clone(),
            num_files: f.num_files as f64,
            num_bytes: f.num_bytes as f64,
        }),
    };
    RECEIVES.lock().unwrap().insert(id, pending);
    Ok(offer)
}

/// Accept the offer parked under `id`, writing into `dest_dir`.
#[napi]
pub async fn accept_receive(id: u32, dest_dir: String, callback: Callback) -> Result<String> {
    let pending = RECEIVES
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| Error::from_reason("no pending receive under this id"))?;
    let on_transit = callback.clone();
    let on_progress = callback;
    let cancel = cancel_future(id);
    let result = pending
        .accept(
            &dest_dir,
            move |i| emit(&on_transit, transit_event(i)),
            move |d, t| emit(&on_progress, progress_event(d, t)),
            cancel,
        )
        .await;
    clear_cancel(id);
    let path = result.map_err(to_napi_err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Reject the offer parked under `id`.
#[napi]
pub async fn reject_receive(id: u32) -> Result<()> {
    let pending = RECEIVES
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| Error::from_reason("no pending receive under this id"))?;
    pending.reject().await.map_err(to_napi_err)
}

#[napi]
pub fn create_test_file(dir: String, size_kb: u32) -> Result<String> {
    wormhole_core::create_test_file(dir, size_kb).map_err(to_napi_err)
}
