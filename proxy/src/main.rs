//! masq-proxy — the masqueradarr durable video **data plane** (Phase 0 scaffold).
//!
//! A loopback HTTP sidecar that the Node **control plane** spawns and supervises
//! (`server/src/proxy/sidecar.ts`). The split is deliberate: Node keeps every stateful, churn-prone
//! per-source resolve/policy concern (dulo Supabase auth, dlhd mirror rotation + growing SSRF
//! allowlist, the `SourceProxy` bag); this binary is the durable byte engine that will fetch upstream,
//! follow redirects, rewrite HLS manifests, and pipe segments — driven per stream by a "grant" from
//! Node's resolve seam.
//!
//! P0 exposes only `/health` so the supervisor + Docker wiring can be proven end to end. P1 adds the
//! HLS proxy (manifest rewrite via `m3u8-rs` + segment pipe via `reqwest`) behind the resolve seam.
//! See `.claude/plans/use-ultrathink-durable-vectorized-comet.md`.

use axum::{routing::get, Json, Router};
use serde_json::json;
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    // Loopback bind only. Node is the sole client (the reverse-proxy in P1); the sidecar must never bind a
    // public interface in this phase. Host/port arrive via env from the Node supervisor (defaults below).
    let host = std::env::var("MASQ_PROXY_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("MASQ_PROXY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("MASQ_PROXY_HOST/MASQ_PROXY_PORT do not form a valid socket address");

    let app = Router::new()
        // `/` mirrors `/health` so a bare liveness probe against the root also succeeds.
        .route("/health", get(health))
        .route("/", get(health));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("masq-proxy: failed to bind {addr}: {e}"));
    eprintln!("[masq-proxy] listening on http://{addr}");

    // Graceful shutdown: the Node supervisor sends SIGTERM on app shutdown (and the OS/tini may deliver
    // SIGINT). Draining in-flight streams matters from P1 on; in P0 there is nothing to drain.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|e| eprintln!("[masq-proxy] server error: {e}"));
    eprintln!("[masq-proxy] shut down cleanly");
}

/// Liveness + build identity. The Node supervisor can poll this to confirm the sidecar is up.
async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "service": "masq-proxy",
        "version": env!("CARGO_PKG_VERSION"),
        "phase": "P0",
    }))
}

/// Resolve when the process receives SIGINT (Ctrl-C) or SIGTERM (the supervisor's stop signal).
async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
