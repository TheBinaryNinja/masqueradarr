//! masq-proxy — the masqueradarr durable video **data plane** (P1: HLS proxy).
//!
//! A loopback HTTP sidecar the Node **control plane** spawns + supervises (`server/src/proxy/sidecar.ts`).
//! Node keeps every stateful per-source concern (dulo Supabase auth, dlhd mirror rotation + growing SSRF
//! allowlist, the SourceProxy bag) behind the resolve seam; this binary fetches upstream, follows redirects,
//! rewrites HLS manifests, and pipes segments — driven per stream by the grant the seam returns.
//!
//! Routes: `/health` (liveness) + a fallback that serves both stream mounts (/api/v1, /api/ext/v1). See
//! `.claude/plans/use-ultrathink-durable-vectorized-comet.md`.

mod manifest;
mod probe;
mod proxy;
mod state;

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use state::AppState;
use std::net::SocketAddr;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    // Loopback bind only — Node (the relay) is the sole client in the sidecar topology. Host/port/secret and
    // the Node callback URL arrive via env from the supervisor.
    let host = env_or("MASQ_PROXY_HOST", "127.0.0.1");
    let port: u16 = std::env::var("MASQ_PROXY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let node_url = env_or("MASQ_NODE_URL", "http://127.0.0.1:3000");
    let secret = std::env::var("MASQ_PROXY_SECRET").unwrap_or_default();
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("MASQ_PROXY_HOST/MASQ_PROXY_PORT do not form a valid socket address");

    let state = AppState::new(node_url.clone(), secret);
    let app = Router::new()
        .route("/health", get(health))
        .route("/probe", post(probe::probe)) // PRB: the scheduled channel-probe batch (loopback + secret)
        .fallback(proxy::proxy)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("masq-proxy: failed to bind {addr}: {e}"));
    eprintln!("[masq-proxy] listening on http://{addr} (node={node_url})");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|e| eprintln!("[masq-proxy] server error: {e}"));
    eprintln!("[masq-proxy] shut down cleanly");
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "masq-proxy", "version": env!("CARGO_PKG_VERSION"), "phase": "P1" }))
}

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
