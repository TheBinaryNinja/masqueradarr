//! RSL-3 segment streaming — the counted, optionally-buffered, stall-guarded pipe that replaces the P1 direct
//! `Body::from_stream(resp.bytes_stream())`. One bounded `tokio::sync::mpsc` sits between the upstream byte
//! stream and the client so brief upstream jitter is absorbed (bounded read-ahead, depth from `bufferSizeKb`)
//! and so we can measure the TRUE egress — including chunked / no-Content-Length segments the P1 header-based
//! count missed (that undercount also produced FALSE client-side buffering in streamTelemetry.tick step 2b,
//! now cured). A per-chunk IDLE timeout (`readTimeoutMs`) turns an upstream stall into a clean truncation + a
//! transient telemetry event instead of a hang; a mid-stream upstream error is reported the same way; a client
//! disconnect ends the pump and still reports the partial bytes actually delivered. All telemetry is
//! fire-and-forget via `AppState::report` (batched). For a source whose grant says its segments arrive
//! disguised (DSG, `segmentUnwrap`), the body also passes through a `tsseg::DisguiseStripper`, so the client
//! receives the transport stream rather than the image it was smuggled in.

use axum::body::Body;
use bytes::Bytes;
use std::io;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::log;
use crate::state::AppState;

/// Telemetry attribution for one segment stream (mirrors the fields the P1 `bytes` event carried).
pub struct TelemetryCtx {
    pub state: AppState,
    pub source: String,
    pub entry: String,
    pub rid: String, // the viewing-session lineage id (for the segment's byte/outcome trace lines)
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

impl TelemetryCtx {
    /// Emit the segment's outcome ONCE, when the pump ends (EOF, error, stall, or client disconnect): the
    /// ACCURATE delivered byte total (drives noteBytes + keeps the channel live), and — if the upstream
    /// errored/stalled mid-body — a transient upstream failure (status 0 ⇒ noteFailure ⇒ an upstream rebuffer).
    fn finish(&self, p: &Pumped) {
        let (total, errored) = (p.sent, p.errored);
        if errored {
            log::warn("stream", &self.rid, || format!("segment ended on an upstream stall/error after {total} bytes"));
        } else if p.stripped > 0 {
            log::trace("stream", &self.rid, || {
                format!("segment done ({total} bytes, {}-byte disguise stripped)", p.stripped)
            });
        } else {
            log::trace("stream", &self.rid, || format!("segment done ({total} bytes)"));
        }
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
///
/// `unwrap` (DSG — the serving policy's `segment_unwrap`) runs the body through a `tsseg::DisguiseStripper`
/// on its way out, so a disguised segment reaches the client as the transport stream it carries. Off, the pipe
/// is byte-exact as ever. The response is chunked (`Body::from_stream`), so no Content-Length has to agree.
pub fn segment_body(
    resp: reqwest::Response,
    ctx: TelemetryCtx,
    read_timeout_ms: u64,
    buffer_size_kb: u64,
    unwrap: bool,
) -> Body {
    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(channel_capacity(buffer_size_kb));
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    tokio::spawn(pump(resp, tx, ctx, idle, unwrap));
    Body::from_stream(ReceiverStream::new(rx))
}

async fn pump(
    resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    ctx: TelemetryCtx,
    idle: Option<Duration>,
    unwrap: bool,
) {
    // Box::pin so StreamExt::next (which needs Unpin) can drive reqwest's bytes_stream; resp is moved in and
    // stays alive for the pump's lifetime, so the upstream connection closes exactly when the pump ends.
    let out = forward(Box::pin(resp.bytes_stream()), &tx, idle, unwrap).await;
    ctx.finish(&out);
}

/// What one segment's pump did, for its single outcome report.
struct Pumped {
    /// Bytes the client's channel ACCEPTED — the egress figure. Not what arrived: a disguise that was
    /// stripped never left, and a chunk offered to a client that had already gone was never delivered.
    sent: u64,
    /// The upstream stalled or errored mid-body (a transient failure, not a disconnect).
    errored: bool,
    /// Leading bytes a disguise stripper dropped (0 when off, or when the body was not disguised).
    stripped: usize,
}

/// The pump's byte loop, split from `pump` so a synthetic stream can drive it in tests. Generic over the
/// chunk error only because reqwest's cannot be constructed outside reqwest.
async fn forward<S, E>(
    mut stream: S,
    tx: &mpsc::Sender<Result<Bytes, io::Error>>,
    idle: Option<Duration>,
    unwrap: bool,
) -> Pumped
where
    S: tokio_stream::Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut strip = unwrap.then(crate::tsseg::DisguiseStripper::new);
    let mut sent: u64 = 0;
    // Why the body ended early, if it did. Sent to the client only AFTER any held head is released, so a
    // player gets every byte that did arrive before the error that truncates the segment.
    let mut failure: Option<io::Error> = None;
    loop {
        let next = match idle {
            Some(d) => match tokio::time::timeout(d, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    // Idle-timeout: the upstream went silent mid-segment. Signal the client with an error (a
                    // truncated segment; the player refetches) and mark it a transient upstream failure.
                    failure = Some(io::Error::new(io::ErrorKind::TimedOut, "upstream stalled"));
                    break;
                }
            },
            None => stream.next().await,
        };
        match next {
            Some(Ok(chunk)) => {
                let out = match strip.as_mut() {
                    Some(s) => s.push(chunk),
                    None => Some(chunk),
                };
                if let Some(b) = out {
                    if !send_counted(tx, b, &mut sent).await {
                        // client disconnected (receiver dropped) — stop reading upstream
                        return Pumped { sent, errored: false, stripped: stripped_by(&strip) };
                    }
                }
            }
            Some(Err(e)) => {
                failure = Some(io::Error::other(e.to_string()));
                break;
            }
            None => break, // clean EOF
        }
    }
    // A head the stripper is still holding is ALL of a body that ended inside its judging window (or everything
    // that arrived before a stall) — decided on what came, and released rather than lost.
    let errored = failure.is_some();
    if let Some(b) = strip.as_mut().and_then(crate::tsseg::DisguiseStripper::finish) {
        if !send_counted(tx, b, &mut sent).await {
            return Pumped { sent, errored, stripped: stripped_by(&strip) };
        }
    }
    if let Some(err) = failure {
        let _ = tx.send(Err(err)).await;
    }
    Pumped { sent, errored, stripped: stripped_by(&strip) }
}

fn stripped_by(strip: &Option<crate::tsseg::DisguiseStripper>) -> usize {
    strip.as_ref().map_or(0, |s| s.stripped())
}

/// Hand one chunk to the client and count it only once the channel took it — `sent` is EGRESS, so a chunk the
/// client never took (it disconnected) must not be billed to it.
async fn send_counted(tx: &mpsc::Sender<Result<Bytes, io::Error>>, b: Bytes, sent: &mut u64) -> bool {
    let n = b.len() as u64;
    if tx.send(Ok(b)).await.is_err() {
        return false;
    }
    *sent += n;
    true
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

    // ── DSG: the relay pump's unwrap and its egress count ──────────────────────────────────────────────────

    /// `n` packets of null padding.
    fn null_ts(n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|_| {
                let mut p = vec![0xFFu8; crate::tsseg::PKT];
                p[0] = crate::tsseg::SYNC;
                p[1] = 0x1F;
                p[3] = 0x10;
                p
            })
            .collect()
    }

    /// An upstream body as a stream of `n`-byte chunks.
    fn upstream(body: &[u8], n: usize) -> impl tokio_stream::Stream<Item = Result<Bytes, String>> + Unpin {
        let chunks: Vec<Result<Bytes, String>> = body.chunks(n).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
        tokio_stream::iter(chunks)
    }

    /// Everything the client received: the bytes, and whether an error ended it.
    async fn received(mut rx: mpsc::Receiver<Result<Bytes, io::Error>>) -> (Vec<u8>, bool) {
        let (mut got, mut err) = (Vec::new(), false);
        while let Some(item) = rx.recv().await {
            match item {
                Ok(b) => got.extend_from_slice(&b),
                Err(_) => err = true,
            }
        }
        (got, err)
    }

    /// A flagged relay hands the client the transport stream the disguise carried — and bills only that. The
    /// 42 wrapper bytes arrived from upstream but never left, so they are not egress.
    #[tokio::test]
    async fn a_flagged_pump_unwraps_the_segment_and_bills_only_what_it_sent() {
        let ts = null_ts(40);
        let body = crate::tsseg::webp_disguise(&ts);
        let (tx, rx) = mpsc::channel(4096);
        let p = forward(upstream(&body, 1000), &tx, None, true).await;
        drop(tx);
        let (got, err) = received(rx).await;
        assert_eq!(got, ts, "the client gets the stream, byte for byte");
        assert!(!err && !p.errored);
        assert_eq!((p.sent, p.stripped), (ts.len() as u64, 42));
    }

    /// Off, the pump is the byte-exact pipe it always was — the disguise is forwarded untouched.
    #[tokio::test]
    async fn an_unflagged_pump_is_a_byte_exact_pipe() {
        let body = crate::tsseg::webp_disguise(&null_ts(40));
        let (tx, rx) = mpsc::channel(4096);
        let p = forward(upstream(&body, 1000), &tx, None, false).await;
        drop(tx);
        assert_eq!(received(rx).await.0, body);
        assert_eq!((p.sent, p.stripped), (body.len() as u64, 0));
    }

    /// An upstream that errors while the stripper still holds the head must not swallow what did arrive:
    /// the held bytes go out first, THEN the error that truncates the segment.
    #[tokio::test]
    async fn a_held_head_is_released_before_an_upstream_error() {
        let short = b"not a transport stream".to_vec();
        let items: Vec<Result<Bytes, String>> = vec![Ok(Bytes::from(short.clone())), Err("reset by peer".into())];
        let (tx, rx) = mpsc::channel(16);
        let p = forward(tokio_stream::iter(items), &tx, None, true).await;
        drop(tx);
        let (got, err) = received(rx).await;
        assert_eq!(got, short, "the held head is delivered, byte-exact");
        assert!(err && p.errored, "…followed by the truncation");
        assert_eq!(p.sent, short.len() as u64);
    }

    /// Egress means DELIVERED: a client that already hung up is not billed for the chunk it never took.
    #[tokio::test]
    async fn a_client_that_hung_up_is_not_billed_for_the_chunk_it_never_took() {
        let (tx, rx) = mpsc::channel(4);
        drop(rx);
        let p = forward(upstream(&null_ts(8), 500), &tx, None, false).await;
        assert_eq!(p.sent, 0);
        assert!(!p.errored, "a disconnect is not an upstream failure");
    }
}
