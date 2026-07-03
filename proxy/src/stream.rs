//! RSL-3 segment streaming — the counted, optionally-buffered, stall-guarded pipe that replaces the P1 direct
//! `Body::from_stream(resp.bytes_stream())`. One bounded `tokio::sync::mpsc` sits between the upstream byte
//! stream and the client so brief upstream jitter is absorbed (bounded read-ahead, depth from `bufferSizeKb`)
//! and so we can measure the TRUE egress — including chunked / no-Content-Length segments the P1 header-based
//! count missed (that undercount also produced FALSE client-side buffering in streamTelemetry.tick step 2b,
//! now cured). A per-chunk IDLE timeout (`readTimeoutMs`) turns an upstream stall into a clean truncation + a
//! transient telemetry event instead of a hang; a mid-stream upstream error is reported the same way; a client
//! disconnect ends the pump and still reports the partial bytes actually delivered. All telemetry is
//! fire-and-forget via `AppState::report` (batched).

use axum::body::Body;
use bytes::Bytes;
use std::io;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::state::AppState;

/// Telemetry attribution for one segment stream (mirrors the fields the P1 `bytes` event carried).
pub struct TelemetryCtx {
    pub state: AppState,
    pub source: String,
    pub entry: String,
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

impl TelemetryCtx {
    /// Emit the segment's outcome ONCE, when the pump ends (EOF, error, stall, or client disconnect): the
    /// ACCURATE delivered byte total (drives noteBytes + keeps the channel live), and — if the upstream
    /// errored/stalled mid-body — a transient upstream failure (status 0 ⇒ noteFailure ⇒ an upstream rebuffer).
    fn finish(&self, total: u64, errored: bool) {
        if total > 0 {
            self.state.report(serde_json::json!({
                "kind": "bytes", "source": self.source, "entryUrl": self.entry,
                "ip": self.ip, "ua": self.ua, "username": self.username, "bytes": total,
            }));
        }
        if errored {
            self.state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": self.source, "entryUrl": self.entry,
            }));
        }
    }
}

// Read-ahead depth (in chunks) for the bounded buffer. `bufferSizeKb` (when set) picks the depth against a
// nominal chunk size; unset (0) → a shallow 2-chunk pipeline that behaves ~like the P1 direct pipe.
const DEFAULT_READAHEAD_CHUNKS: usize = 2;
const NOMINAL_CHUNK_KB: u64 = 64;
const MAX_READAHEAD_CHUNKS: usize = 4096;

pub(crate) fn channel_capacity(buffer_size_kb: u64) -> usize {
    if buffer_size_kb == 0 {
        DEFAULT_READAHEAD_CHUNKS
    } else {
        ((buffer_size_kb / NOMINAL_CHUNK_KB) as usize).clamp(2, MAX_READAHEAD_CHUNKS)
    }
}

/// Build the axum response Body for a segment/non-manifest upstream: spawn a pump that drains `resp` into a
/// bounded channel (counting bytes, applying the idle timeout, reporting the outcome) and return a Body that
/// streams the channel to the client. Dropping the Body (client disconnect) drops the receiver, so the pump's
/// next `send` fails and it tears down — reporting the partial bytes + closing the upstream connection.
pub fn segment_body(
    resp: reqwest::Response,
    ctx: TelemetryCtx,
    read_timeout_ms: u64,
    buffer_size_kb: u64,
) -> Body {
    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(channel_capacity(buffer_size_kb));
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    tokio::spawn(pump(resp, tx, ctx, idle));
    Body::from_stream(ReceiverStream::new(rx))
}

async fn pump(
    resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    ctx: TelemetryCtx,
    idle: Option<Duration>,
) {
    // Box::pin so StreamExt::next (which needs Unpin) can drive reqwest's bytes_stream; resp is moved in and
    // stays alive for the pump's lifetime, so the upstream connection closes exactly when the pump ends.
    let mut stream = Box::pin(resp.bytes_stream());
    let mut total: u64 = 0;
    let mut errored = false;
    loop {
        let next = match idle {
            Some(d) => match tokio::time::timeout(d, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    // Idle-timeout: the upstream went silent mid-segment. Signal the client with an error (a
                    // truncated segment; the player refetches) and mark it a transient upstream failure.
                    errored = true;
                    let _ = tx
                        .send(Err(io::Error::new(io::ErrorKind::TimedOut, "upstream stalled")))
                        .await;
                    break;
                }
            },
            None => stream.next().await,
        };
        match next {
            Some(Ok(chunk)) => {
                total += chunk.len() as u64;
                if tx.send(Ok(chunk)).await.is_err() {
                    break; // client disconnected (receiver dropped) — stop reading upstream
                }
            }
            Some(Err(e)) => {
                errored = true;
                let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
                break;
            }
            None => break, // clean EOF
        }
    }
    ctx.finish(total, errored);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_disabled_is_shallow() {
        assert_eq!(channel_capacity(0), DEFAULT_READAHEAD_CHUNKS);
    }

    #[test]
    fn capacity_scales_with_buffer_kb() {
        assert_eq!(channel_capacity(1024), 16); // 1024KB / 64KB nominal = 16 chunks
    }

    #[test]
    fn capacity_has_a_floor_and_ceiling() {
        assert_eq!(channel_capacity(16), 2); // 16/64 = 0 → floored to 2
        assert_eq!(channel_capacity(1_048_576), MAX_READAHEAD_CHUNKS); // huge → clamped
    }
}
