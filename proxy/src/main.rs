
mod dns;
mod edge;
mod log;
mod manifest;
mod origin;
mod probe;
mod proxy;
mod state;
mod stream;
mod sync;
#[cfg(test)]
mod testkit;
mod tsmux;
mod tsnorm;
mod tsseg;
mod tsweave;

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
    let host = env_or("MASQ_PROXY_HOST", "127.0.0.1");
    let port: u16 = std::env::var("MASQ_PROXY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let node_url = env_or("MASQ_NODE_URL", "http://127.0.0.1:3000");
    let secret = std::env::var("MASQ_PROXY_SECRET").unwrap_or_default();
    let internal_addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("MASQ_PROXY_HOST/MASQ_PROXY_PORT do not form a valid socket address");

    let state = AppState::new(node_url.clone(), secret);

    let internal = Router::new()
        .route("/health", get(health))
        .route("/probe", post(probe::probe))
        .fallback(proxy::proxy)
        .with_state(state.clone());
    let internal_listener = tokio::net::TcpListener::bind(internal_addr)
        .await
        .unwrap_or_else(|e| panic!("masq-proxy: failed to bind {internal_addr}: {e}"));
    log::info("proxy", "", || format!("internal listener up on http://{internal_addr} (node={node_url}, logLevel={})", log::level()));
    let internal_server =
        axum::serve(internal_listener, internal).with_graceful_shutdown(shutdown_signal());

    if std::env::var("MASQ_EDGE").map(|v| !v.is_empty()).unwrap_or(false) {
        let edge_host = env_or("MASQ_EDGE_HOST", "0.0.0.0");
        let edge_port: u16 = std::env::var("MASQ_EDGE_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000);
        let edge_addr: SocketAddr = format!("{edge_host}:{edge_port}")
            .parse()
            .expect("MASQ_EDGE_HOST/MASQ_EDGE_PORT do not form a valid socket address");
        let edge = Router::new().fallback(edge::edge_dispatch).with_state(state);
        let edge_listener = tokio::net::TcpListener::bind(edge_addr)
            .await
            .unwrap_or_else(|e| panic!("masq-proxy: failed to bind edge {edge_addr}: {e}"));
        log::info("edge", "", || format!("PUBLIC EDGE listener up on http://{edge_addr} → node {node_url}"));
        let edge_server = axum::serve(
            edge_listener,
            edge.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal());
        let (ri, re) = tokio::join!(internal_server, edge_server);
        if let Err(e) = ri {
            log::error("proxy", "", || format!("internal server error: {e}"));
        }
        if let Err(e) = re {
            log::error("edge", "", || format!("edge server error: {e}"));
        }
    } else {
        internal_server
            .await
            .unwrap_or_else(|e| log::error("proxy", "", || format!("server error: {e}")));
    }
    log::info("proxy", "", || "shut down cleanly".to_string());
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
