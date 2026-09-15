
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use reqwest::header::{HeaderMap as RHeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::log;
use crate::manifest::extract_media;
use crate::proxy::{check_secret, host_of, text};
use crate::state::AppState;

const PROBE_CONCURRENCY: usize = 8;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ProbeItem {
    id: String,
    target: String,
    #[serde(default, rename = "upstreamHeaders")]
    upstream_headers: HashMap<String, String>,
}

#[derive(Deserialize)]
pub struct ProbeRequest {
    items: Vec<ProbeItem>,
}

#[derive(Serialize)]
pub struct ProbeResult {
    id: String,
    live: bool,
    resolution: Option<String>,
    codecs: Option<String>,
    #[serde(rename = "frameRate")]
    frame_rate: Option<String>,
    container: Option<String>,
    bandwidth: Option<i64>,
}

#[derive(Serialize)]
pub struct ProbeResponse {
    results: Vec<ProbeResult>,
}

pub async fn probe(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<ProbeRequest>) -> Response {
    if !check_secret(&headers, &state.secret) {
        return text(403, "forbidden");
    }
    let n = req.items.len();
    log::info("probe", "", || format!("probe batch: {n} item(s)"));
    let sem = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
    let mut set: JoinSet<ProbeResult> = JoinSet::new();
    for item in req.items {
        let state = state.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            probe_one(&state, item).await
        });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(r) = joined {
            results.push(r);
        }
    }
    let live = results.iter().filter(|r| r.live).count();
    log::info("probe", "", || format!("probe batch done: {live}/{n} live"));
    Json(ProbeResponse { results }).into_response()
}

async fn probe_one(state: &AppState, item: ProbeItem) -> ProbeResult {
    let dead = |id: String| ProbeResult {
        id,
        live: false,
        resolution: None,
        codecs: None,
        frame_rate: None,
        container: None,
        bandwidth: None,
    };

    let mut hm = RHeaderMap::new();
    for (k, v) in &item.upstream_headers {
        if let (Ok(name), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            hm.insert(name, val);
        }
    }

    log::trace("probe", "", || format!("probe {} → {}", item.id, host_of(&item.target)));
    let resp = match state.client.get(&item.target).headers(hm).timeout(PROBE_TIMEOUT).send().await {
        Ok(r) => r,
        Err(_) => {
            log::trace("probe", "", || format!("probe {} DOWN (connect/resolve failed)", item.id));
            return dead(item.id);
        }
    };
    if !resp.status().is_success() {
        log::trace("probe", "", || format!("probe {} DOWN ({})", item.id, resp.status().as_u16()));
        return dead(item.id);
    }

    let final_url = resp.url().clone();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = match resp.text().await {
        Ok(t) => t,
        Err(_) => return dead(item.id),
    };

    let is_manifest = ct.contains("mpegurl")
        || final_url.path().to_ascii_lowercase().ends_with(".m3u8")
        || body.trim_start().starts_with("#EXTM3U");
    if !is_manifest {
        return ProbeResult {
            id: item.id,
            live: true,
            resolution: None,
            codecs: None,
            frame_rate: None,
            container: None,
            bandwidth: None,
        };
    }
    let media = extract_media(&body);
    ProbeResult {
        id: item.id,
        live: true,
        resolution: media.resolution,
        codecs: media.codecs,
        frame_rate: media.frame_rate,
        container: media.container,
        bandwidth: media.bandwidth,
    }
}
