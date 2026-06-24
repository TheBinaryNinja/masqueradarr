<div align="center">
<img src="docs/img/masqueradarr.png" height="350">
  <p><em>Aggregating scattered IPTV sources behind a single, trusted identity.</em></p>
  <img alt="Docker Image Version (tag)" src="https://img.shields.io/docker/v/iflip721/tvapp2-app-stack/dev?sort=date&style=for-the-badge&logo=Docker">
</div>

## What this is

**masqueradarr** is a self-hosted IPTV aggregator. It pulls channel playlists (M3U) and guide
data (EPG/XMLTV) from a range of online IPTV services, normalizes them into one catalog, and
serves them back as a single, unified, standards-compliant playlist + guide — behind one trusted
identity that your media apps and IPTV clients can talk to.

It is the direct successor to **[TVApp2](https://github.com/TheBinaryNinja/tvapp2)**, which is now
**deprecated**. masqueradarr is not a fork or a patch — it is a ground-up re-architecture of the same
idea, carrying the project into the `*arr` self-hosted media family (Sonarr, Radarr, …) it's named for.

<img src="docs/img/screenshots/dashboard.png">

<br >

---

<br >

<img src="docs/img/screenshots/active-streams.png">

<br >

---

<br >

<img src="docs/img/screenshots/history-metrics.png">

<br >

---

<br >

<img src="docs/img/screenshots/playlists.png">

<br >

---

<br >

<img src="docs/img/screenshots/epg-sources.png">

<br >

---

<br >

<img src="docs/img/screenshots/channel-mapping.png">

<br >

---

<br >

<img src="docs/img/screenshots/users.png">

<br >

---

<br >

<img src="docs/img/screenshots/settings-1.png">

<br >

---

<br >

<img src="docs/img/screenshots/settings-2.png">

<br >

---

<br >

<img src="docs/img/screenshots/settings-3.png">

<br >

## The evolution — from **TVApp2** to **masqueradarr**

### Where it started: **TVApp2**

TVApp2 was a single, self-contained Docker container whose job was simple and effective: on a
schedule, **scrape a handful of IPTV providers** (TheTvApp, TVPass, MoveOnJoy), **download and
regenerate flat `.m3u` and `.xml` files**, and serve them over a small web interface so that
Jellyfin, Plex, or Emby could ingest them. It was a Node.js app on an **Alpine Linux** base,
supervised by **s6-overlay**, configured almost entirely through **environment variables**, with
HDHomeRun emulation and HD/SD quality toggles. It did one thing well — keep static playlists fresh.

That model had ceilings. Streams were **static URLs** baked into files, so anything behind a login,
a device check, an expiring token, or a rotating mirror couldn't be served. There was **no database**,
**no real UI** beyond file links, **no per-user access control**, **no live observability** of who was
watching what, and **no transcoding** for clients that couldn't play the upstream format. Every new
provider meant bespoke scraping glued into the core.

### Where it's going: masqueradarr

masqueradarr keeps the original promise — *aggregate scattered IPTV sources into one playlist + guide* —
and rebuilds everything underneath it to lift those ceilings:

- **Static files → a live, resolve-on-demand engine.** Instead of writing dead URLs to disk,
  masqueradarr resolves each stream **at play time** through an HLS proxy. That's what makes
  **authenticated** and **rotating** sources possible — e.g. an in-app, server-streamed Chromium
  captures a real login session, and per-play signed URLs are minted on demand.
- **Flat config → MongoDB + a real management SPA.** State lives in MongoDB; the front end is a
  **Vue 3 single-page app** with full screens for Dashboard, Active Streams, History / Metrics,
  Playlists, EPG Sources, Channel Mapping, Users, and Settings.
- **Bespoke scrapers → a source-agnostic adapter framework.** Adding a provider is one adapter file
  plus one registry line; the generic core (sync, proxy, B-Roll, telemetry) never branches per source.
- **File server → an API + two delivery surfaces.** An in-app player **and** an external-client
  engine that transcodes for TiviMate / Kodi / VLC, with **GPU hardware acceleration** (NVENC / VAAPI / QSV).
- **Env-var toggles → users, roles & per-user access.** Real authentication (scrypt), session vs.
  stream tokens, and per-user tokenized playlist access.
- **Blind scheduling → live observability.** WebSocket-pushed viewer/bandwidth/buffering telemetry,
  ffprobe stream monitoring, a B-Roll placeholder slate while a channel buffers, and MongoDB-backed
  application logs.

### At a glance

| | **TVApp2** (deprecated) | **masqueradarr** |
|---|---|---|
| **Role** | Static M3U/XMLTV regenerator | Live IPTV aggregator + delivery platform |
| **Streams** | Static URLs written to files | Resolve-on-demand via HLS proxy |
| **State** | Flat files, no DB | MongoDB (Mongoose 8) |
| **Frontend** | Links to generated files | Vue 3 + Vite management SPA |
| **Backend** | Node.js scripts | Express 4 API (ESM, TypeScript) |
| **Sources** | Hard-coded scrapers (TheTvApp, TVPass, MoveOnJoy) | Pluggable adapters (dulo, dlhd, …) |
| **Auth** | None | scrypt users, roles, per-user access lists |
| **Auth'd sources** | Not possible | Supported (streamed-login session capture) |
| **External clients** | Pass-through only | ffmpeg/VLC transcode engine, GPU HW accel |
| **Observability** | Logs | Live WS telemetry, history/metrics, ffprobe, app logs |
| **Base image** | Alpine + s6-overlay | Debian bookworm (glibc) + tini |
| **Config** | Environment variables | DB-backed settings + minimal `.env` bootstrap |

---

## Architecture

masqueradarr is **two independently-built, independently-versioned npm packages** that the Docker
image stitches together — *not* a workspace, and they never import across the boundary:

- **`/` (root)** — the **Vue 3 + Vite SPA** (the management front end; `hls.js`, `vue-router`, `mitt`).
- **`server/`** — the **Express 4 + Mongoose 8 API** (ESM, TypeScript `strict`), which serves the
  built SPA, the `/api/*` REST surface, the HLS proxy + external-player engine, and three WebSockets
  (login-stream, stream-stats, logs-stream).

Key subsystems:

- **Sources adapter framework** — a source-agnostic core (sync → normalize → dedupe → proxy) with
  per-provider adapters. Current sources: **dulo** (authenticated, resolve-on-demand) and **dlhd**
  (anonymous, scraped from a rotating mirror); a shared **common** tier is planned.
- **Channel model** — a pristine synced reference (`sourcechannels`) projected into an editable,
  UI-facing store (`playlistchannels`); user edits survive re-syncs.
- **EPG + scheduler** — Gracenote and EPG-PW ingestion behind a shared sync path, driven by a
  `croner`-backed runtime scheduler over a persisted `cronjobs` collection.
- **Composition + export** — composes Global, per-user, and custom `.m3u` playlists with matching
  XMLTV guide siblings for downstream clients.
- **externalPlayer engine** — ffmpeg / VLC transcode for third-party IPTV clients on a dedicated
  mount, with boot-time hardware-encoder detection.


---

## Migration status

The rename and re-architecture are **in flight**. The codebase, brand, and runtime are masqueradarr;
the **published Docker repositories still carry the `tvapp2` names** (`iflip721/tvapp2-app-stack` for
the standard image, `iflip721/tvapp2` for the all-in-one) until the registry rename completes. If
you're coming from TVApp2: there is **no in-place upgrade path** — masqueradarr is a new application
with a new data model (MongoDB instead of flat files), so stand it up fresh and re-add your sources
through the UI.

---

## Lineage & credits

masqueradarr is the successor to **[TVApp2](https://github.com/TheBinaryNinja/tvapp2)** by
[TheBinaryNinja](https://github.com/TheBinaryNinja), and inherits its core aggregation framework
(ported from the sibling project). TVApp2 remains available, archived, and deprecated —
all new development happens here.

# New server-side video engine for IPTV clients (process doc)

> **Scope:** how a stream session opened by a **IPTV client** (TiviMate, IPTV Client, VLC, UHF, IPTV One,
> ffmpeg-tier players) is served and made observable — the **externalPlayer** path. This is the engine half of
> the appPlayer / externalPlayer split (the "robust-donut" rollout); its sibling is the in-app slide-out player.
> This doc traces only what is externalPlayer-specific.
>
> **One-line:** external clients subscribe to a per-user `.m3u` whose channel URLs are the **`/api/ext/v1`**
> mount (the M3U composer writes them, carrying `&pl=<owningPlaylistId>` so the per-playlist config is selectable).
> The external HLS path is **composer-free + engine-driven** — there is **no B-Roll slate** on external (that's the
> in-app `/api/v1` path only). When an engine is enabled in **Settings → Video Configuration**, those sessions are
> routed through a shared per-channel **ffmpeg or VLC** process that transcodes/normalizes **and** captures
> loading/buffering/failed health for an otherwise-opaque client — output as **loopback HLS** (default) or an
> opt-in **raw MPEG-TS socket**. With no engine enabled, `/api/ext` is a plain **B-Roll-free direct relay**, so
> external clients keep working either way; a resolve/engine failure is a clean error (**502**), not a slate.

---

## Plain language

A TiviMate/IPTV Client/VLC user downloads their personal playlist file from TVApp2 and the app plays its channels.
Those channels point at a special server URL (`/api/ext/...`) that TVApp2 writes specifically for outside
apps. The problem this solves: an outside app is a **black box** — it never tells the server "I'm buffering" or
"this failed," and it may need a different video format than the source provides.

So TVApp2 can put a **media engine** (ffmpeg, or optionally VLC) in the middle. The engine pulls the channel
once, optionally re-encodes it to something every player accepts, and — crucially — **watches its own health**
(is it keeping up? did it stall? did it die?) so the server can show that session's state on the **Active
Streams** and **History** screens, exactly like an in-app session. One engine process is shared by everyone
watching that channel.

Unlike the in-app player, the external path does **not** show the broadcast-style "holding card" (B-Roll) while
a channel is starting up or failing — an outside app supplies its own loading/error UI, so the server just hands
over the stream and, if it can't, returns a clean error (the in-app player keeps the slate). There are two ways
to hand the bytes over:

- **HLS (default)** — the engine writes a normal HLS stream the server already knows how to serve and count.
  Works for almost every modern client (TiviMate, IPTV Client, VLC, Emby). The server fetches the engine's output and
  rewrites/serves it through the same proxy plumbing the in-app path uses — but **without** the B-Roll composer.
- **Raw TS (opt-in)** — the classic "IPTV link": one long-held connection streaming MPEG-TS, for older
  raw-only clients. This needs its own connection-counting because such a client never re-polls.

If GPU hardware is present, the engine can offload re-encoding to it (NVENC / Intel QSV / VAAPI); the server
detects what's usable at startup so the Settings screen only offers real options. If no engine is turned on,
nothing changes — the URL just relays the source straight through.

---

## Technical

### 1. How external clients get their URLs (the discriminator)

The per-user M3U composer writes each channel's URL to the **externalPlayer** mount, `channelToExtinf`
(`server/src/m3u/serialize.ts:32-38`):

```
<settings.domain>/api/ext/v1/<origin ?? source>/<encodeURIComponent(streamEntryUrl)>?token=<streamToken>
```

`appPlayerProxyPath` (the in-app player) keeps `/api/v1`. **Classification follows the mount** — no UA sniffing,
no query flag to propagate — so the hot path is branch-free (the discriminator decision; research §5). The URL
is **format-neutral** (the encoded entry never ends in `.m3u8`): the served **Content-Type** distinguishes HLS
(`application/vnd.apple.mpegurl`) from raw-TS (`video/mp2t`), so one composed line works for either output and
never advertises `.m3u8` for a TS body (the ExoPlayer OOM guardrail; `serialize.ts` does **not** read
`videoconfig`).

### 2. The `/api/ext/v1` mount + the output branch

`sourcesRouter.get('/api/ext/v1/:source/*')` (`server/src/routes/sources.ts`): the **same** stream-access gate
as `/api/v1` (`checkStreamAccess`), then resolve the **per-playlist config** and branch on it:

```ts
const playlistId = (typeof req.query.pl === 'string' && req.query.pl) || source; // composed URL carries ?pl=<owningPlaylistId>
const configId = await resolvePlaylistConfigId(playlistId);     // 'app' (Default) or 'app_<playlistId>' (Custom)
(req as any).videoConfigId = configId;                          // attached → entry resolver + raw-TS handler + engine keying
const cfg = await getVideoConfigCached(configId);               // 5s-TTL cache, one slot per id (videoconfig/runtime.ts)
if ((cfg?.enabledEngine === 'ffmpeg' || cfg?.enabledEngine === 'vlc') && cfg.output === 'ts')
  → externalTsHandlers.get(source)   // raw-TS socket (externalTsEngine.ts)
else
  → externalHandlers.get(source)     // composer-free loopback-HLS engine (externalEngine.ts) OR direct relay if engine off
```

`?pl` maps to a `videoconfig` id via `resolvePlaylistConfigId` (`'default'`/missing/unknown-playlist ⇒ `'app'`,
else the stored `'app_<playlistId>'`); old M3Us / source playlists without `?pl` fall back to `:source`.

The HLS handler is **composer-free** — `createProxyHandler(adapter, m, undefined, {...})` (NO B-Roll composer
arg), differing from `/api/v1` in: `prefix = /api/ext/v1/<id>/`, a new **`serveEntry: makeExternalHlsEntry(adapter)`**
(the slate-free, engine-driven channel-entry resolver — §4), **`learnChildHosts: false`** (the engine's
loopback/relay child hosts are NOT taught to the adapter's shared SSRF allowlist), and `extraAllowed:
isExternalEngineLoopbackUrl` (the SSRF escape hatch for the 127.0.0.1 engine origin). `createBrollComposer` is
used **only** by `/api/v1`; the old external `createBrollComposer` + `driveStreamState` were **removed**. The
shared proxy plumbing (SSRF gate, child-URI rewrite, segment piping, telemetry `noteBytes`) is still reused via
the proxy handler's direct-hop branch + `serveEntry`. With the engine active it is the **SOLE** streamState
writer — there is **no composer to race** (the single-writer invariant); an engine-off relay writes no phase.

### 3. `videoconfig` — the operative config (per-id, Settings-driven)

`server/src/models/VideoConfig.ts` (`videoconfigs`; `schemas.md`). No longer a lone singleton: **`_id:'app'`** is
the global Default and **`_id:'app_<playlistId>'`** is a per-playlist Custom config. Provisioned by
`ensureVideoConfig(id)` (`videoconfig/provision.ts`, shared by the GET/PUT route + boot detection): `'app'` seeds
from the built-in `DEFAULT_*` args, `'app_<id>'` seeds by **copying** the live `'app'`. The REST surface is
**per-id** — `GET`/`PUT`/`DELETE /:id` (DELETE never removes `'app'`).

- `enabledEngine: 'ffmpeg' | 'vlc' | null` — `null` ⇒ engine off (`/api/ext` = direct relay). Single active engine.
- `mode: 'auto' | 'copy' | 'transcode'` — informational in v1 (the preset/args encode the codec choice).
- `output: 'hls' | 'ts'` — loopback HLS (default) vs raw-TS passthrough.
- `<engine>.advancedArgs` — **★ the OPERATIVE driver**: the raw single-line ffmpeg/VLC syntax the engine spawns
  with (placeholders `<INPUT> <UA> <OUTDIR> <M3U8> <SEG>` substituted). The Settings card's preset picker
  (`src/composables/videoPresets.ts`) populates it; `<engine>.options` is the reserved comprehensive catalog.
- `hwAccel: { enabled, encoder, detected[] }` — `detected` is server-derived (§7), read-only over the API.

Read hot-path via `getVideoConfigCached(configId)` (5s TTL, one cache slot per id); a Settings PUT takes effect
on the next channel establish.
The engine cores stay **DB-free** — the route injects `cfg` as a plain `ExternalEngineConfig` (`engine, args,
mode, output, stallSpeedThreshold, failTimeoutS`).

### 4. The engine — binary, serving model, copy-vs-transcode

One shared engine process **per channel + config** (proc-map key `streamKey(source, entryUrl) + '#' + configId`,
so two playlists with different configs for one channel stay isolated; the `streamState` key stays the plain
`streamKey`); multiple viewers of one config ride one process = one upstream pull. The binary is `ffmpeg` or
`cvlc` (`VLC_BIN`) per `cfg.engine`. Argv is built from
`advancedArgs` by the shared `engineArgs.ts` — `buildFfmpegArgv` (injects `-progress` + `-headers` gate
headers) or `buildVlcArgv` (injects `--http-referrer`; VLC can't send arbitrary Origin → **Origin-gated sources
like dulo may not auth via VLC**). The engine fetches the upstream **directly** (bypassing the proxy), so it
needs the adapter's gate headers (Referer/Origin). Copy-vs-transcode is encoded in the preset/args (mirrors
`hdhomerun/remux.ts`'s `decideVideoMode`); `mode` is the policy knob.

**HLS path (`server/src/sources/core/externalEngine.ts`, default) — composer-free.** Generalizes
`hdhomerun/remux.ts`: the engine writes a live HLS window to a temp dir served over a **127.0.0.1 loopback**
origin; `externalPlayerEnsureStream` awaits the first playlist+segment, then returns the loopback master.
The route's `serveEntry` resolver — **`makeExternalHlsEntry`** — does, per entry poll:
`getVideoConfigCached(configId)` → `adapter.resolveStream` (the real upstream master) → `noteViewer` (the poll
is the viewer heartbeat) → **engine ON**: `externalPlayerEnsureStream` ⇒ the loopback master; **engine OFF**:
the adapter master unchanged (a **B-Roll-free direct relay**) → `ensureProbe` (one-shot ffprobe, keyed by the
plain `streamKey` so `stream-details` reads it back) → returns `{ masterUrl }`. The **proxy handler** then
fetches that master, rewrites its children back through `/api/ext/v1` (re-appending `&token=` + `&pl=`), and
serves the bytes — **no B-Roll composer, no slate**. A resolve/engine failure throws and the handler returns a
clean **502** (the externalPlayer's truest path). Idle-reaped once the client stops polling (`IDLE_MS` > the 30s
telemetry TTL).

**Raw-TS path (`server/src/sources/core/externalTsEngine.ts`, opt-in `output:'ts'`).** Bypasses the composer:
the engine muxes MPEG-TS to **stdout** (ffmpeg `-f mpegts pipe:1` / VLC `std{access=file,mux=ts,dst=/dev/stdout}`),
which is tapped into an in-proc **188-byte-aligned ring buffer** (byte-capped) and **fanned out** to N held-open
client sockets — each follows the ring at its own cursor with backpressure (`res.write`/`drain`) and
skip-forward on eviction (a slow client jumps to live rather than stalling the channel). One shared engine per
channel; reaped a short delay after the last client leaves. Served `Content-Type: video/mp2t`. (Do **not** use
ffmpeg `-listen 1` — the server owns the socket; the engine is just a byte producer.)

### 5. Health — the new visibility (the whole point)

The engine drives the existing `streamState` phases (`establishing | live | buffer | failed`) via the shared
`engineHealth.ts`:

- **ffmpeg** — `-progress` stream (HLS on `pipe:1`; raw-TS on **`pipe:3`**, since stdout carries the TS bytes)
  parsed into edge-triggered transitions: a healthy block (`speed ≥ threshold` + advancing `out_time`) ⇒ live;
  `speed < threshold` / stalled ⇒ buffer; sustained stall or non-zero exit ⇒ failed.
- **VLC** — no `-progress`, so **coarser** cadence health via `noteProducerAlive`: positive liveness from the
  HLS **segment-write cadence** (the sweep checks `index.m3u8` mtime) / raw-TS **byte-flow** (each ring chunk),
  with the same watchdog escalation when activity stops.

A `watchdog` (in the per-engine sweep) catches a fully-hung process (no health signal past the fail window).
ffprobe stays the one-shot technical-detail side-channel (codec/res/fps), engine-agnostic and unchanged. The
engine is the **sole** streamState writer on external — there is **no composer to race** (§2); an engine-off
relay writes no phase (telemetry still counts the viewer).

### 6. Telemetry — the fork (uniform sessions, two accounting paths)

Both paths feed the **same** `ClosedSession` → `ViewSession` shape (`models/ViewSession.ts`, tagged
`playerType: 'externalPlayer'`), so Active Streams (an **External · &lt;client&gt;** pill) + History treat TS and
HLS sessions identically. They differ in how a viewer is *counted* (`server/src/sources/core/streamTelemetry.ts`):

- **HLS** — reuses the existing **poll-recency** model verbatim: the client's playlist/segment GETs are the
  heartbeat (`noteViewer` / `noteBytes`; 30s recency TTL).
- **Raw-TS** — a held socket never polls, so the **socket-liveness** hooks fork in: `noteSocketViewerOpen` on
  socket open, `noteSocketBytes` per ring write, `noteSocketViewerClose` on socket close — `socketBound`
  clients are exempt from the recency sweep and reaped on close (with a 60s no-byte backstop).

### 7. Hardware acceleration (WS6)

Boot detection `videoconfig/hwDetect.ts` (`applyHwDetection`, wired non-fatal in `index.ts` after
`bootInitSources`) intersects `ffmpeg -encoders` with device-node presence (`/dev/dri` for VAAPI/QSV/AMF,
`/dev/nvidia*` for NVENC) → `$set videoconfig.hwAccel.detected`. The Settings card offers **only** detected
encoders and gates the NVENC/QSV/VAAPI presets on it. Images ship VAAPI drivers (`libva`+`mesa-va-gallium`;
Intel iHD on amd64 only); pass `/dev/dri` + the render group at run time (commented opt-in in
`docker-compose.yml`). NVENC additionally needs an nvenc-enabled ffmpeg + the nvidia container runtime.

### 8. `externalPlayer*` naming + degradation

Engine functions carry the `externalPlayer*` prefix (`externalPlayerEnsureStream`, `externalPlayerSpawn`, …) /
`ensureTsStream`+`attachTsClient` (raw-TS); the in-app player is `appPlayer*`. The `-progress`→streamState
machine (`engineHealth.ts`) and the argv builder (`engineArgs.ts`) are shared by both engines. A missing binary
(`ffmpeg`/`cvlc` ENOENT) degrades to direct relay (logged once) so external clients keep working.

---

## Dependencies

- **`ffmpeg`** — the default + recommended engine (clean `-progress` health). In both Docker runtimes.
- **`cvlc` (VLC)** — the secondary engine (coarser cadence health). Baked into both images (a large package).
- **`videoconfig`** (Mongo, **per-id**: `'app'` Default + `'app_<playlistId>'` Custom) —
  `enabledEngine`/`mode`/`output`/`<engine>.advancedArgs`/`hwAccel`; the Settings → Video Configuration card
  (`VideoConfigPanel.vue` + `useVideoConfig.ts` + `videoPresets.ts`).
- **The M3U composer** — `m3u/serialize.ts` writes the `/api/ext/v1` URLs (with `&pl=<owningPlaylistId>`);
  per-user fan-out in `m3u/compose.ts`.
- **The shared proxy plumbing** — `createProxyHandler`'s direct-hop branch (SSRF gate, child-URI rewrite,
  segment piping) + `serveEntry` + ffprobe/streamState/streamTelemetry. The HLS path reuses this but is
  **composer-free** (NO B-Roll — that's `/api/v1` only); `video-stream-diagram.md` §2.
- **Per-source resolve** — each adapter's `resolveStream`/`upstreamHeaders`/SSRF gate.
- **(optional) GPU** — `/dev/dri` (VAAPI/QSV) or the nvidia container runtime (NVENC) + `hwAccel.detected`.

---

## Functional flow

```mermaid
graph TD
    A["IPTV client (TiviMate/IPTV Client/VLC/…)<br/>downloads per-user .m3u → GET /api/ext/v1/&lt;src&gt;/&lt;enc&gt;?token=&amp;pl="] --> B["stream-access gate (routes/sources.ts)<br/>same token model as /api/v1"]
    B -->|401/403| Bx["plain-text error"]
    B --> C0["resolvePlaylistConfigId(?pl)<br/>→ configId: 'app' | 'app_&lt;pl&gt;'"]
    C0 --> C["getVideoConfigCached(configId) (5s TTL, per-id)"]
    C --> D{"enabledEngine?"}
    D -->|"null (off)"| R["B-Roll-free DIRECT RELAY<br/>(serveEntry returns adapter master)"]
    D -->|ffmpeg / vlc| E{"output?"}

    E -->|"hls (default)"| F["serveEntry = makeExternalHlsEntry<br/>resolveStream · noteViewer · ensureProbe<br/>(externalEngine.ts) — COMPOSER-FREE, no B-Roll"]
    F -->|resolve/engine fail| Fx["clean 502 (no slate)"]
    F --> G["spawn ffmpeg/cvlc (shared per channel+config)<br/>key = streamKey#configId · advancedArgs → buildFfmpegArgv/buildVlcArgv"]
    G --> H["live HLS window → 127.0.0.1 loopback dir"]
    H --> P["proxy handler direct-hop: fetch loopback master<br/>· child-rewrite /api/ext/v1 (+ &amp;token= &amp;pl=) · serve bytes<br/>engine owns streamState (no composer)"]
    R --> P
    P --> A

    E -->|"ts (opt-in)"| J["createExternalTsHandler → ensureTsStream<br/>(externalTsEngine.ts)"]
    J --> K["spawn ffmpeg -f mpegts pipe:1 / cvlc dst=/dev/stdout"]
    K --> L["188-aligned RING BUFFER (byte-capped)"]
    L --> M["fan-out to N client sockets (per-client cursor<br/>+ backpressure + skip-forward) · video/mp2t"]
    M --> A

    G -. health .-> N["engineHealth: ffmpeg -progress (pipe:1 / pipe:3)<br/>VLC cadence noteProducerAlive + watchdog<br/>→ streamState live/buffer/failed"]
    K -. health .-> N
    P -. poll-recency: noteViewer/noteBytes .-> T["streamTelemetry → ViewSession playerType=externalPlayer"]
    M -. socket-liveness: noteSocketViewerOpen/Bytes/Close .-> T
    N -.-> T
    T --> U["Active Streams (External pill) + History"]

    HW["boot hwDetect.ts: ffmpeg -encoders ∩ /dev nodes<br/>→ videoconfig.hwAccel.detected"] -. gates HW presets .-> C
```
