//! PortalGems desktop engine: napi-rs addon over `wormhole-core`.
//!
//! Electron's V8 memory cage forbids external ArrayBuffers, which rules out
//! the libffi-based `@ubjs/node` runtime inside Electron. This addon avoids
//! the problem entirely: only strings and f64 numbers cross the FFI boundary.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

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

#[napi]
pub async fn send_file(path: String, code: Option<String>, callback: Callback) -> Result<()> {
    let on_code = callback.clone();
    let on_transit = callback.clone();
    let on_progress = callback;
    wormhole_core::send_file(
        &path,
        code.as_deref(),
        move |c| emit(&on_code, code_event(c)),
        move |i| emit(&on_transit, transit_event(i)),
        move |d, t| emit(&on_progress, progress_event(d, t)),
    )
    .await
    .map_err(to_napi_err)
}

#[napi]
pub async fn receive_file(code: String, dest_dir: String, callback: Callback) -> Result<String> {
    let on_transit = callback.clone();
    let on_progress = callback;
    let path = wormhole_core::receive_file(
        &code,
        &dest_dir,
        move |i| emit(&on_transit, transit_event(i)),
        move |d, t| emit(&on_progress, progress_event(d, t)),
    )
    .await
    .map_err(to_napi_err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[napi]
pub fn create_test_file(dir: String, size_kb: u32) -> Result<String> {
    wormhole_core::create_test_file(dir, size_kb).map_err(to_napi_err)
}
