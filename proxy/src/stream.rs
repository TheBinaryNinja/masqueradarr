
use axum::body::Body;
use bytes::Bytes;
use std::io;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::log;
use crate::state::AppState;

pub struct TelemetryCtx {
    pub state: AppState,
    pub source: String,
    pub entry: String,
    pub rid: String,
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

impl TelemetryCtx {
    fn finish(&self, p: &Pumped) {
        let (total, errored) = (p.sent, p.errored);
        if errored {
            log::warn("stream", &self.rid, || format!("segment ended on an upstream stall/error after {total} bytes"));
        } else if let Some(u) = p.unwrapped {
            log::trace("stream", &self.rid, || {
                format!("segment done ({total} bytes of TS from a {}-byte {} disguise)", u.wrapper, u.kind.label())
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
    let out = forward(Box::pin(resp.bytes_stream()), &tx, idle, unwrap).await;
    ctx.finish(&out);
}

struct Pumped {
    sent: u64,
    errored: bool,
    unwrapped: Option<crate::tsseg::Unwrapped>,
}

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
    let mut failure: Option<io::Error> = None;
    loop {
        let next = match idle {
            Some(d) => match tokio::time::timeout(d, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
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
                        return Pumped { sent, errored: false, unwrapped: unwrapped_by(&strip) };
                    }
                }
            }
            Some(Err(e)) => {
                failure = Some(io::Error::other(e.to_string()));
                break;
            }
            None => break,
        }
    }
    let errored = failure.is_some();
    let truncated_whole = errored && strip.as_ref().is_some_and(crate::tsseg::DisguiseStripper::is_buffering);
    if let Some(b) = strip.as_mut().filter(|_| !truncated_whole).and_then(crate::tsseg::DisguiseStripper::finish) {
        if !send_counted(tx, b, &mut sent).await {
            return Pumped { sent, errored, unwrapped: unwrapped_by(&strip) };
        }
    }
    if let Some(err) = failure {
        let _ = tx.send(Err(err)).await;
    }
    Pumped { sent, errored, unwrapped: unwrapped_by(&strip) }
}

fn unwrapped_by(strip: &Option<crate::tsseg::DisguiseStripper>) -> Option<crate::tsseg::Unwrapped> {
    strip.as_ref().and_then(crate::tsseg::DisguiseStripper::unwrapped)
}

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
        assert_eq!(channel_capacity(1024), 16);
    }

    #[test]
    fn capacity_has_a_floor_and_ceiling() {
        assert_eq!(channel_capacity(16), 2);
        assert_eq!(channel_capacity(1_048_576), MAX_READAHEAD_CHUNKS);
    }


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

    fn upstream(body: &[u8], n: usize) -> impl tokio_stream::Stream<Item = Result<Bytes, String>> + Unpin {
        let chunks: Vec<Result<Bytes, String>> = body.chunks(n).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
        tokio_stream::iter(chunks)
    }

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
        assert_eq!(p.sent, ts.len() as u64);
        assert_eq!(p.unwrapped.map(|u| (u.kind.label(), u.wrapper)), Some(("riff-webp", 42)));
    }

    #[tokio::test]
    async fn a_flagged_pump_decodes_a_png_disguised_segment_across_chunks() {
        use crate::disguise::tests::{png_pixel_disguise, PngSpec};
        for ts in [crate::disguise::tests::null_ts(400), crate::disguise::tests::noisy_ts(400, 11)] {
            let body = png_pixel_disguise(&ts, &PngSpec { width: 64, ..PngSpec::default() });
            let (tx, rx) = mpsc::channel(4096);
            let p = forward(upstream(&body, 1000), &tx, None, true).await;
            drop(tx);
            let (got, err) = received(rx).await;
            assert_eq!(got, ts, "the client gets the decoded stream, not the image ({} B PNG)", body.len());
            assert!(!err && !p.errored);
            assert_eq!(p.sent, ts.len() as u64, "billed for what it sent");
            assert_eq!(p.unwrapped.map(|u| (u.kind.label(), u.wrapper)), Some(("png-pixels", body.len())));
        }
    }

    #[tokio::test]
    async fn a_png_disguised_segment_cut_off_upstream_is_not_forwarded_as_an_image() {
        use crate::disguise::tests::{png_pixel_disguise, PngSpec};
        for ts in [crate::disguise::tests::null_ts(400), crate::disguise::tests::noisy_ts(400, 12)] {
            let body = png_pixel_disguise(&ts, &PngSpec { width: 64, ..PngSpec::default() });
            let items: Vec<Result<Bytes, String>> =
                vec![Ok(Bytes::copy_from_slice(&body[..body.len() / 2])), Err("reset by peer".into())];
            let (tx, rx) = mpsc::channel(16);
            let p = forward(tokio_stream::iter(items), &tx, None, true).await;
            drop(tx);
            let (got, err) = received(rx).await;
            assert!(got.is_empty(), "half an image is never written as TS ({} B PNG)", body.len());
            assert!(err && p.errored);
        }
    }

    #[tokio::test]
    async fn an_unflagged_pump_passes_a_png_through_untouched() {
        use crate::disguise::tests::{png_pixel_disguise, PngSpec};
        let body = png_pixel_disguise(&crate::disguise::tests::null_ts(40), &PngSpec::default());
        let (tx, rx) = mpsc::channel(4096);
        let p = forward(upstream(&body, 1000), &tx, None, false).await;
        drop(tx);
        assert_eq!(received(rx).await.0, body);
        assert_eq!(p.unwrapped, None);
    }

    #[tokio::test]
    async fn an_unflagged_pump_is_a_byte_exact_pipe() {
        let body = crate::tsseg::webp_disguise(&null_ts(40));
        let (tx, rx) = mpsc::channel(4096);
        let p = forward(upstream(&body, 1000), &tx, None, false).await;
        drop(tx);
        assert_eq!(received(rx).await.0, body);
        assert_eq!((p.sent, p.unwrapped), (body.len() as u64, None));
    }

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

    #[tokio::test]
    async fn a_client_that_hung_up_is_not_billed_for_the_chunk_it_never_took() {
        let (tx, rx) = mpsc::channel(4);
        drop(rx);
        let p = forward(upstream(&null_ts(8), 500), &tx, None, false).await;
        assert_eq!(p.sent, 0);
        assert!(!p.errored, "a disconnect is not an upstream failure");
    }
}
