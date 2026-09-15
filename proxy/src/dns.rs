//! dns.rs — the Settings nameservers, in the data plane: the resolver every UPSTREAM fetch connects through.
//!
//! WHY: Node's `server/src/dns.ts` routes its own outbound fetch() through the nameservers the operator set on
//! the Settings screen. The data plane used reqwest's default resolver (getaddrinfo) instead, so a channel's
//! resolve hop (Node) and its media hops (here) could land on different answers — split-horizon DNS, a filtered
//! OS resolver, a CDN name only the configured servers know — and "Node resolves it, the stream still 502s" is a
//! miserable thing to debug. One setting now governs both resolvers.
//!
//! SEMANTICS — mirror `server/src/dns.ts` and keep the two in lockstep:
//!  · The configured servers (an IP list) are asked FIRST.
//!  · ANY failure there — timeout, unreachable, SERVFAIL, NXDOMAIN, no records — falls back to the OS resolver
//!    (getaddrinfo), so `.local`, LAN and compose-service names keep resolving. The lookup fails only when the
//!    OS resolver fails TOO, and then with the custom error: that is the one the operator's setting produced.
//!  · IP literals never reach a resolver.
//!  · Names in the `localhost.` zone (RFC 6761) go straight to the OS resolver, as they do for dns.ts: its servers
//!    NXDOMAIN them and getaddrinfo decides. hickory would answer every one of them with loopback WITHOUT asking
//!    anybody — see `in_localhost_zone`.
//!  · A first; AAAA only when A comes back empty or failed. IPv4-leaning on purpose, for dns.ts's reason: most
//!    IPTV/CDN upstreams are v4, and many container bridge networks have no working v6 egress. A server that did
//!    not ANSWER the A query at all (timeout, unreachable) is not asked AAAA, and for `SERVERS_DOWN_WINDOW` after
//!    that nobody asks the configured servers at all — see there.
//!  · No servers configured → the OS resolver, silently — exactly what reqwest's default resolver did before.
//!  · Log lines as dns.ts writes them: a fallback is a warn, a double failure an error, the AAAA retry always a
//!    warn; a success is traced by level (3 = every one, 2 = first per host and on change, 1 = none).
//!
//! SCOPE: the UPSTREAM clients only — the default client (`AppState::client`: the probe, and `client_for`'s
//! build fallback) and every `client_for` client. The loopback Node client and the edge's reverse-proxy client
//! keep the system resolver: they only ever dial Node, and a nameserver the operator can misconfigure must never
//! be able to cut the data plane off from its control plane (dns.ts keeps Mongo off its dispatcher for the same
//! reason). It also keeps the log flusher — which ships this module's own lines — independent of it.
//!
//! LIVE: seeded from `MASQ_NAMESERVERS` at spawn (server/src/proxy/sidecar.ts), then kept current by the seam's
//! flush echo `{ logLevel, nameservers }` (log.rs `apply_flush_echo`), so a Settings change reaches the sidecar
//! within one flush cycle, no restart. A change swaps the ONE `Active` config every client shares — no client is
//! rebuilt, so connection pooling survives; the next lookup uses the new servers, one already in flight finishes
//! on the config it started with. Unlike Node, which swaps its whole dispatcher, connections already open are
//! kept: an answer only matters to the next connection, and dropping healthy segment sockets over it would stall
//! every live stream.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use hickory_resolver::config::{NameServerConfig, ResolveHosts, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::net::{DnsError, NetError};
use hickory_resolver::proto::op::ResponseCode;
use hickory_resolver::TokioResolver;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde_json::Value;

use crate::log;
use crate::sync::{LockExt, RwExt};

/// Every line this module writes. A sub-tag of `proxy`, like `iop:cue`: Node's category resolver falls back to
/// the namespace, so these land in the engine's own `proxy` category — beside the stream they slowed down — and
/// the tag still tells them apart from Node's own `dns` lines, which describe a different resolver.
const TAG: &str = "proxy:dns";

/// Where each configured server is asked. The Settings list is bare IPs (the PUT validator and dns.ts's
/// `parseServers` both refuse `ip:port`), so every server is plain DNS on the standard port.
const DNS_PORT: u16 = 53;

/// How long ONE custom query (the A, or the AAAA) may take across every configured server before it counts as
/// failed and the OS resolver is asked instead.
///
/// Tighter than hickory's 5 s default, and with no retry of its own, because the budget is not ours: reqwest's
/// connect timeout wraps the whole connect — resolve, TCP, TLS — so a blackholed nameserver spends it before a
/// single byte moves. A server that never answers costs ONE of these before the fallback answers (it is not asked
/// AAAA — it did not answer A), and then nothing at all for `SERVERS_DOWN_WINDOW`. Packet loss inside one query
/// is covered by hickory's own UDP retransmit; the fallback is the retry.
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// How long the configured servers are left alone after they failed to ANSWER (a timeout, an unreachable server,
/// no connection) — every lookup meanwhile goes straight to the OS resolver.
///
/// Without it a dead nameserver was a tax on every new upstream connection, forever: nothing remembered the
/// failure, so each one paid the query timeout again — per host, per retry — out of a connect budget the operator
/// can set as low as 100 ms (`connectTimeoutMs`). At a connect timeout under the query timeout that was every new
/// connection failing outright, for a name the OS resolver could have answered at once. A server that answers
/// "no such name" is not down and never trips this: that is an answer, and a LAN name the OS may still know.
/// The window then lapses on its own, so a server that comes back is back within one window.
const SERVERS_DOWN_WINDOW: Duration = Duration::from_secs(30);

/// Bound on the level-2 dedupe map. dns.ts's map is unbounded; this process runs for months against rotating
/// CDN hostnames, so it is cleared when full — the cost is one repeated trace line per host, nothing more.
const SEEN_MAX: usize = 1024;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The OS resolver as a value, so a test can stand in for getaddrinfo without touching real DNS.
type OsLookup = Arc<dyn Fn(String) -> OsAnswer + Send + Sync>;
type OsAnswer = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

/// The nameserver configuration in force — replaced wholesale on a change, never edited in place, so a lookup
/// holding a snapshot sees one consistent config for its whole life.
struct Active {
    /// The list exactly as last applied (`""` = none). The flush echo is compared against this, which makes the
    /// steady state — every flush repeats the list already in force — a string compare and nothing else.
    raw: String,
    servers: Vec<IpAddr>,
    /// `None` = no servers configured: the OS resolver answers everything.
    resolver: Option<TokioResolver>,
    /// Until when the servers are treated as down (`SERVERS_DOWN_WINDOW`) — `None` while they are trusted. Kept
    /// after it lapses, so the first answer after an outage can say the servers are back; a new config (a swap)
    /// starts trusted.
    down_until: Mutex<Option<Instant>>,
}

impl Active {
    fn new(raw: String, servers: Vec<IpAddr>, resolver: Option<TokioResolver>) -> Self {
        Self { raw, servers, resolver, down_until: Mutex::new(None) }
    }

    fn os_only() -> Self {
        Self::new(String::new(), Vec::new(), None)
    }

    /// Are the servers inside a down window right now?
    fn servers_down(&self) -> bool {
        self.down_until.lock_ok().is_some_and(|until| Instant::now() < until)
    }

    /// The servers failed to answer: open (or extend) the down window. True only for the lookup that OPENED it,
    /// so a burst of concurrent lookups against dead servers logs one line, not one per lookup.
    fn trip(&self, window: Duration) -> bool {
        let now = Instant::now();
        let mut until = self.down_until.lock_ok();
        let opened = !until.is_some_and(|t| now < t);
        *until = now.checked_add(window);
        opened
    }

    /// The servers answered. True only for the first answer after a down window — the "they are back" moment.
    fn heal(&self) -> bool {
        self.down_until.lock_ok().take().is_some()
    }
}

/// The upstream resolver: one per process, shared by every upstream client (`Arc` — reqwest's `dns_resolver`
/// takes one) and retargeted in place by `init_from_env` / `apply_echo`.
pub struct UpstreamDns {
    active: RwLock<Arc<Active>>,
    /// Level-2 trace dedupe: host → the `family|addresses` it last resolved to. Cleared on every change of
    /// servers, as dns.ts clears its own: a new config is new information.
    seen: Arc<Mutex<HashMap<String, String>>>,
    os: OsLookup,
    /// `DNS_PORT`, `QUERY_TIMEOUT` and `SERVERS_DOWN_WINDOW` in production; a test points them at a loopback
    /// responder on its own short clock.
    port: u16,
    query_timeout: Duration,
    down_window: Duration,
}

impl UpstreamDns {
    /// An OS-resolver-only instance; `init_from_env` or `apply_echo` gives it servers.
    pub fn new() -> Self {
        Self::with_parts(system_lookup(), DNS_PORT, QUERY_TIMEOUT, SERVERS_DOWN_WINDOW)
    }

    fn with_parts(os: OsLookup, port: u16, query_timeout: Duration, down_window: Duration) -> Self {
        Self {
            active: RwLock::new(Arc::new(Active::os_only())),
            seen: Arc::new(Mutex::new(HashMap::new())),
            os,
            port,
            query_timeout,
            down_window,
        }
    }

    /// Apply `MASQ_NAMESERVERS` — the list Node stamped at spawn, `""` or unset for the OS resolver. Always writes
    /// its lifecycle line, even for "none": the boot log should say which resolver the engine started on. Runs
    /// once logging is up (AppState::new), so the line reaches the drawer.
    pub fn init_from_env(&self) {
        let raw = std::env::var("MASQ_NAMESERVERS").unwrap_or_default();
        self.swap(&raw, "env", true);
    }

    /// Apply the seam echo's `nameservers`: a string is the list in force, `null` means the OS resolver. A missing
    /// key — an older Node — or any other shape leaves the resolver exactly as it is: the echo is advisory, and
    /// "no opinion" must never be read as "no servers".
    pub fn apply_echo(&self, echo: &Value) {
        match echo.get("nameservers") {
            Some(Value::String(list)) => self.swap(list, "seam echo", false),
            Some(Value::Null) => self.swap("", "seam echo", false),
            _ => {}
        }
    }

    /// Install `raw` unless it is already in force. A different spelling of the same servers only records the
    /// spelling; the resolver — and its answer cache — survive. `announce` forces the lifecycle line.
    fn swap(&self, raw: &str, from: &str, announce: bool) {
        if !announce && self.active.read_ok().raw == raw {
            return; // the steady state: every flush echoes the list already in force
        }
        let (servers, invalid) = parse_servers(raw);
        let changed = {
            let mut active = self.active.write_ok();
            // Re-checked under the write lock: both flushers carry the same echo, and the one that lost the race
            // must not rebuild (and re-announce) what the other just installed.
            if !announce && active.raw == raw {
                return;
            }
            let changed = active.servers != servers;
            let resolver = if changed { self.build(&servers) } else { active.resolver.clone() };
            // A build failure leaves the OS resolver in charge — `servers` is emptied to say so truthfully.
            let servers = if resolver.is_some() { servers } else { Vec::new() };
            *active = Arc::new(Active::new(raw.to_string(), servers, resolver));
            changed
        };
        for bad in &invalid {
            log::warn(TAG, "", || format!("ignoring invalid nameserver '{bad}' (from {from})"));
        }
        if changed {
            self.seen.lock_ok().clear();
        }
        if changed || announce {
            let servers = self.servers();
            if servers.is_empty() {
                log::info(TAG, "", || format!("upstream resolver: OS resolver (no nameserver configured, from {from})"));
            } else {
                log::info(TAG, "", || {
                    format!(
                        "upstream resolver: {} nameserver(s) from {from}: {} (OS resolver on any failure)",
                        servers.len(),
                        join(&servers)
                    )
                });
            }
        }
    }

    /// A hickory resolver asking exactly `servers`, in the operator's order. `None` for an empty list.
    fn build(&self, servers: &[IpAddr]) -> Option<TokioResolver> {
        if servers.is_empty() {
            return None;
        }
        let name_servers = servers
            .iter()
            .map(|&ip| {
                // UDP first, TCP for a truncated answer — what c-ares does for dns.ts.
                let mut ns = NameServerConfig::udp_and_tcp(ip);
                for conn in &mut ns.connections {
                    conn.port = self.port;
                }
                ns
            })
            .collect();
        let mut opts = ResolverOpts::default();
        opts.timeout = self.query_timeout;
        opts.attempts = 0; // no retry inside hickory: the retry is the OS fallback (see QUERY_TIMEOUT)
        // The servers only, as c-ares's resolve4/resolve6 ask them: /etc/hosts belongs to the OS fallback, which
        // reads it anyway, and reading it here would answer a LAN name without ever asking the servers.
        opts.use_hosts_file = ResolveHosts::Never;
        // No search domains either (from_name_servers): a bare name the servers cannot answer falls back to the OS
        // resolver, which applies the container's own search list.
        let config = ResolverConfig::from_name_servers(name_servers);
        let built = TokioResolver::builder_with_config(config, TokioRuntimeProvider::default()).with_options(opts).build();
        match built {
            Ok(resolver) => Some(resolver),
            Err(e) => {
                let list = join(servers);
                log::error(TAG, "", || format!("could not build a resolver for {list} ({e}) — using the OS resolver"));
                None
            }
        }
    }

    /// The servers in force (empty = the OS resolver).
    pub fn servers(&self) -> Vec<IpAddr> {
        self.active.read_ok().servers.clone()
    }
}

#[cfg(test)]
impl UpstreamDns {
    /// Test-only: no nameservers, and an "OS resolver" that knows exactly `table` and counts every question it is
    /// asked — so a test can tell which clients resolve through this instance without any real DNS.
    pub(crate) fn over_fake_os(table: &[(&str, &str)]) -> (Self, Arc<std::sync::atomic::AtomicU32>) {
        let (os, asked) = tests::fake_os(table);
        (Self::with_parts(os, DNS_PORT, QUERY_TIMEOUT, SERVERS_DOWN_WINDOW), asked)
    }
}

impl Resolve for UpstreamDns {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let active = self.active.read_ok().clone();
        let seen = self.seen.clone();
        let os = self.os.clone();
        let down_window = self.down_window;
        Box::pin(async move {
            let ips = lookup(&host, &active, &os, &seen, down_window).await?;
            // Port 0: reqwest puts the URL's (or the scheme's) port on every address.
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// One lookup, by the semantics in the module doc.
async fn lookup(
    host: &str,
    active: &Arc<Active>,
    os: &OsLookup,
    seen: &Mutex<HashMap<String, String>>,
    down_window: Duration,
) -> Result<Vec<IpAddr>, BoxError> {
    if let Some(ip) = ip_literal(host) {
        return Ok(vec![ip]); // never hit a resolver — getaddrinfo's own semantics
    }
    // The `localhost.` zone is the OS resolver's, never hickory's: hickory answers every name in it with loopback
    // without asking a server, which made an upstream-supplied `x.localhost` dial this box. dns.ts's servers answer
    // NXDOMAIN and its getaddrinfo fallback decides; so does this.
    if in_localhost_zone(host) {
        return Ok(os(host.to_string()).await?);
    }
    let Some(resolver) = &active.resolver else {
        return Ok(os(host.to_string()).await?);
    };
    // Inside a down window the servers are not asked at all — the window's own warn already said why.
    if active.servers_down() {
        return Ok(os(host.to_string()).await?);
    }
    // The servers are asked on a task of their own, so what they did is recorded even when the connection that
    // asked has given up. reqwest's connect timeout — and fetch_with_retry's read timeout — wrap this resolve, and
    // the operator can set either below QUERY_TIMEOUT: the lookup is then dropped mid-query, and with it the only
    // code that could open the down window, so every later connection paid the same dead query and failed the same
    // way — the very case the window exists for. The task outlives its caller by at most one query timeout.
    let asking = {
        let (resolver, host, active) = (resolver.clone(), host.to_string(), active.clone());
        tokio::spawn(async move {
            let asked = ask_servers(&resolver, &host).await;
            match &asked {
                Ok(_) => {
                    if active.heal() {
                        log::info(TAG, "", || {
                            format!("the configured nameserver(s) answer again ({host}) — asking them first once more")
                        });
                    }
                }
                // Servers that did not answer at all are left alone for a window, rather than taxing every connection
                // until they come back. Only the lookup that opened the window says so.
                Err(failed) if failed.unanswered && active.trip(down_window) => {
                    log::warn(TAG, "", || {
                        format!(
                            "configured nameserver(s) {} not answering ({}) — the OS resolver answers alone for \
                             the next {}s",
                            join(&active.servers),
                            failed.code,
                            down_window.as_secs()
                        )
                    });
                }
                Err(_) => {}
            }
            asked
        })
    };
    let failed = match asking.await {
        Ok(Ok(ips)) => {
            if admit_trace(seen, log::level(), host, &trace_key(&ips)) {
                log::info(TAG, "", || {
                    format!("{host} → {} (family {}) via {}", join(&ips), family(&ips), join(&active.servers))
                });
            }
            return Ok(ips);
        }
        Ok(Err(failed)) => failed,
        // The query task panicked: nothing was answered, and the OS resolver still gets its turn below.
        Err(e) => CustomFailure { code: "EINTERNAL".to_string(), err: Box::new(e), unanswered: false },
    };
    // The configured servers failed (blocked egress to 8.8.8.8, SERVFAIL, NXDOMAIN for a LAN name, …). Ask the OS
    // resolver, so one filtered nameserver cannot silently break every upstream; only a double failure fails.
    match os(host.to_string()).await {
        Ok(ips) if !ips.is_empty() => {
            log::warn(TAG, "", || format!("{host}: custom resolver failed ({}), fell back to OS resolver", failed.code));
            Ok(ips)
        }
        _ => {
            log::error(TAG, "", || format!("{host} resolve failed (custom + OS resolver): {}", failed.code));
            Err(failed.err)
        }
    }
}

/// Why the configured servers produced no address: the short code the log lines carry (`failure_code`), and the
/// error itself — what the connect fails with when the OS resolver cannot answer either.
struct CustomFailure {
    code: String,
    err: BoxError,
    /// The servers never ANSWERED (see `unanswered`), as opposed to answering "nothing here".
    unanswered: bool,
}

impl From<NetError> for CustomFailure {
    fn from(e: NetError) -> Self {
        Self { code: failure_code(&e), unanswered: unanswered(&e), err: e.into() }
    }
}

/// A failure of the TRANSPORT — no reply arrived at all (a timeout), or none could be asked for (unreachable, no
/// connection) — rather than a reply that said no. The distinction is what the AAAA skip and the down window key
/// on: an NXDOMAIN, a SERVFAIL, an empty answer all come from a server that is up.
fn unanswered(e: &NetError) -> bool {
    matches!(e, NetError::Timeout | NetError::NoConnections | NetError::Io(_))
}

/// A, then AAAA only when A yields nothing. When both yield nothing, the A failure is the one surfaced, as dns.ts
/// does: the family asked first is the one the operator's servers were expected to answer.
async fn ask_servers(resolver: &TokioResolver, host: &str) -> Result<Vec<IpAddr>, CustomFailure> {
    let a_failed = match resolver.ipv4_lookup(host).await {
        Ok(found) => {
            let ips = addresses(found.answers(), true);
            if !ips.is_empty() {
                return Ok(ips);
            }
            // An answer with no address at its end (a dangling CNAME): no data, in the resolver's own words.
            CustomFailure { code: "ENODATA".to_string(), err: format!("{host}: no A records").into(), unanswered: false }
        }
        // The servers did not answer the A query at all. They will not answer AAAA either, and asking would only
        // spend a second query timeout of the caller's connect budget before the OS resolver gets its turn.
        Err(e) if unanswered(&e) => return Err(e.into()),
        Err(e) => e.into(),
    };
    // Always a warn, independent of level — a fallback is a notable event (dns.ts).
    log::warn(TAG, "", || format!("{host}: A empty, trying AAAA"));
    match resolver.ipv6_lookup(host).await {
        Ok(found) => {
            let ips = addresses(found.answers(), false);
            if ips.is_empty() {
                Err(a_failed)
            } else {
                Ok(ips)
            }
        }
        Err(_) => Err(a_failed),
    }
}

/// A failure named the way c-ares names it — the `err.code` dns.ts logs — so the drawer describes both
/// resolvers' failures in one vocabulary, and a line reads "ENOTFOUND" rather than hickory's whole query dump.
fn failure_code(e: &NetError) -> String {
    match e {
        NetError::Dns(DnsError::NoRecordsFound(no)) if no.response_code == ResponseCode::NXDomain => "ENOTFOUND".into(),
        NetError::Dns(DnsError::NoRecordsFound(_)) => "ENODATA".into(),
        NetError::Dns(DnsError::ResponseCode(ResponseCode::ServFail)) => "ESERVFAIL".into(),
        NetError::Dns(DnsError::ResponseCode(ResponseCode::Refused)) => "EREFUSED".into(),
        NetError::Timeout => "ETIMEOUT".into(),
        NetError::Io(io) if io.kind() == io::ErrorKind::ConnectionRefused => "ECONNREFUSED".into(),
        other => other.to_string(),
    }
}

/// The addresses of one family out of an answer section. A CNAME chain rides along in the answers (hickory keeps
/// intermediates); only the address records at its end are wanted.
fn addresses(answers: &[hickory_resolver::proto::rr::Record], v4: bool) -> Vec<IpAddr> {
    answers.iter().filter_map(|r| r.data.ip_addr()).filter(|ip| ip.is_ipv4() == v4).collect()
}

/// getaddrinfo on a blocking thread — the same call reqwest's default resolver makes.
fn system_lookup() -> OsLookup {
    Arc::new(|host: String| -> OsAnswer {
        Box::pin(async move { Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.map(|sa| sa.ip()).collect()) })
    })
}

/// Split a nameserver list the way dns.ts's `parseServers` does: comma-separated, trimmed, blanks dropped, and
/// anything that is not an IP literal set aside — returned so the caller can warn about each once. Order is kept:
/// it is the operator's preference order.
fn parse_servers(raw: &str) -> (Vec<IpAddr>, Vec<String>) {
    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.parse::<IpAddr>() {
            Ok(ip) => valid.push(ip),
            Err(_) => invalid.push(part.to_string()),
        }
    }
    (valid, invalid)
}

/// A host that is already an address — bare, or an IPv6 literal still in its URL brackets.
fn ip_literal(host: &str) -> Option<IpAddr> {
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    bare.parse().ok()
}

/// Is `host` in the `localhost.` zone — `localhost` itself or any name under it, with or without the root dot, in
/// any case? RFC 6761 §6.3 lets a resolver answer every such name with loopback on its own, and hickory does.
///
/// Shared with the SSRF gate (`proxy::is_private_host`), which has to refuse exactly the names a resolver may
/// place on this box: the gate is literal-only, and `x.localhost` is a loopback literal in all but spelling.
pub(crate) fn in_localhost_zone(host: &str) -> bool {
    let h = host.strip_suffix('.').unwrap_or(host).as_bytes();
    const ZONE: &[u8] = b"localhost";
    h.eq_ignore_ascii_case(ZONE) || (h.len() > ZONE.len() + 1 && h[h.len() - ZONE.len() - 1..].eq_ignore_ascii_case(b".localhost"))
}

/// dns.ts's `traceResolution` gate: 3 → every resolution; 2 → the first per host and whenever its answer changes;
/// 1 → none. Pure over its level so the ladder can be pinned without touching the process-global one.
fn admit_trace(seen: &Mutex<HashMap<String, String>>, level: u8, host: &str, key: &str) -> bool {
    match level {
        0 | 1 => false,
        2 => {
            let mut m = seen.lock_ok();
            if m.get(host).is_some_and(|k| k == key) {
                return false;
            }
            if m.len() >= SEEN_MAX && !m.contains_key(host) {
                m.clear();
            }
            m.insert(host.to_string(), key.to_string());
            true
        }
        _ => true,
    }
}

fn trace_key(ips: &[IpAddr]) -> String {
    format!("{}|{}", family(ips), join(ips))
}

fn family(ips: &[IpAddr]) -> u8 {
    if ips.first().is_some_and(IpAddr::is_ipv6) {
        6
    } else {
        4
    }
}

fn join(ips: &[IpAddr]) -> String {
    ips.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// What the loopback responder answers for one question.
    #[derive(Clone)]
    enum Answer {
        A(Vec<Ipv4Addr>),
        Aaaa(Vec<Ipv6Addr>),
        /// NOERROR with an empty answer section — the name exists, the family does not.
        NoData,
        NxDomain,
        ServFail,
        /// Never answers: the blackholed-nameserver case.
        Silent,
    }

    const A: u16 = 1;
    const AAAA: u16 = 28;

    /// A plain-UDP DNS responder on a loopback port, scripted per (name, type), recording every question it was
    /// asked. Enough of RFC 1035 to answer hickory: the query's id and question echoed back, then the records.
    struct Responder {
        port: u16,
        asked: Arc<Mutex<Vec<(String, u16)>>>,
    }

    impl Responder {
        async fn start(script: impl Fn(&str, u16) -> Answer + Send + Sync + 'static) -> Responder {
            let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.expect("bind a loopback UDP port");
            let port = sock.local_addr().expect("a bound address").port();
            let asked = Arc::new(Mutex::new(Vec::new()));
            let log = asked.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1500];
                while let Ok((n, peer)) = sock.recv_from(&mut buf).await {
                    let query = &buf[..n];
                    let Some((name, qtype, end)) = question(query) else { continue };
                    log.lock_ok().push((name.clone(), qtype));
                    if let Some(reply) = reply(query, end, script(&name, qtype)) {
                        let _ = sock.send_to(&reply, peer).await;
                    }
                }
            });
            Responder { port, asked }
        }

        fn asked(&self) -> Vec<(String, u16)> {
            self.asked.lock_ok().clone()
        }
    }

    /// The first question of a query: (lowercased name without the root dot, qtype, offset past qclass).
    fn question(q: &[u8]) -> Option<(String, u16, usize)> {
        let mut i = 12;
        let mut labels = Vec::new();
        loop {
            let len = *q.get(i)? as usize;
            i += 1;
            if len == 0 {
                break;
            }
            labels.push(String::from_utf8_lossy(q.get(i..i + len)?).to_ascii_lowercase());
            i += len;
        }
        let qtype = u16::from_be_bytes([*q.get(i)?, *q.get(i + 1)?]);
        Some((labels.join("."), qtype, i + 4))
    }

    fn reply(q: &[u8], end: usize, answer: Answer) -> Option<Vec<u8>> {
        let (rcode, records): (u8, Vec<(u16, Vec<u8>)>) = match answer {
            Answer::A(ips) => (0, ips.iter().map(|ip| (A, ip.octets().to_vec())).collect()),
            Answer::Aaaa(ips) => (0, ips.iter().map(|ip| (AAAA, ip.octets().to_vec())).collect()),
            Answer::NoData => (0, Vec::new()),
            Answer::NxDomain => (3, Vec::new()),
            Answer::ServFail => (2, Vec::new()),
            Answer::Silent => return None,
        };
        let mut out = Vec::with_capacity(512);
        out.extend_from_slice(&q[0..2]); // the query's id
        out.push(0x80 | (q[2] & 0x01)); // QR, echoing RD
        out.push(0x80 | rcode); // RA + rcode
        out.extend_from_slice(&1u16.to_be_bytes()); // one question…
        out.extend_from_slice(&(records.len() as u16).to_be_bytes()); // …its answers…
        out.extend_from_slice(&[0, 0, 0, 0]); // …no authority, no additional
        out.extend_from_slice(&q[12..end]); // the question, verbatim
        for (rtype, rdata) in records {
            out.extend_from_slice(&[0xC0, 0x0C]); // the name: a pointer back to the question's
            out.extend_from_slice(&rtype.to_be_bytes());
            out.extend_from_slice(&1u16.to_be_bytes()); // IN
            out.extend_from_slice(&60u32.to_be_bytes()); // TTL
            out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            out.extend_from_slice(&rdata);
        }
        Some(out)
    }

    /// A stand-in for getaddrinfo: answers from a fixed table (anything else fails, as getaddrinfo would for an
    /// unknown name) and counts how often it was asked.
    pub(super) fn fake_os(table: &[(&str, &str)]) -> (OsLookup, Arc<AtomicU32>) {
        let table: HashMap<String, IpAddr> =
            table.iter().map(|(h, ip)| (h.to_string(), ip.parse().expect("a table address"))).collect();
        let calls = Arc::new(AtomicU32::new(0));
        let counted = calls.clone();
        let os: OsLookup = Arc::new(move |host: String| -> OsAnswer {
            counted.fetch_add(1, Ordering::SeqCst);
            let found = table.get(&host).copied();
            Box::pin(async move {
                let unknown = || io::Error::new(io::ErrorKind::NotFound, format!("{host}: unknown to the OS"));
                found.map(|ip| vec![ip]).ok_or_else(unknown)
            })
        });
        (os, calls)
    }

    /// A test-short query timeout — and the down window every test but the one about it keeps at production length.
    const TEST_QUERY: Duration = Duration::from_millis(300);

    /// An instance whose "configured servers" are the responder on 127.0.0.1, on a test-short query timeout.
    fn dns_via(responder: &Responder, os: OsLookup) -> UpstreamDns {
        let dns = UpstreamDns::with_parts(os, responder.port, TEST_QUERY, SERVERS_DOWN_WINDOW);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        dns
    }

    async fn resolve(dns: &UpstreamDns, host: &str) -> Result<Vec<IpAddr>, String> {
        let name = Name::from_str(host).map_err(|_| format!("{host}: not a name reqwest would pass"))?;
        match dns.resolve(name).await {
            Ok(addrs) => Ok(addrs.map(|sa| sa.ip()).collect()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|s| s.parse().expect("a test address")).collect()
    }

    #[test]
    fn a_nameserver_list_is_read_the_way_dns_ts_reads_it() {
        assert_eq!(parse_servers("8.8.8.8,8.8.4.4"), (ips(&["8.8.8.8", "8.8.4.4"]), vec![]), "Node's canonical form");
        assert_eq!(parse_servers(" 1.1.1.1 , 2606:4700::1111 "), (ips(&["1.1.1.1", "2606:4700::1111"]), vec![]));
        assert_eq!(parse_servers("9.9.9.9,1.1.1.1").0, ips(&["9.9.9.9", "1.1.1.1"]), "the operator's order is kept");
        assert_eq!(parse_servers(""), (vec![], vec![]), "unset: the OS resolver");
        assert_eq!(parse_servers(" , ,"), (vec![], vec![]), "blanks are dropped, not errors");
        // What Node's isIP() refuses is refused here too — a name, a port, URL brackets — and handed back to warn.
        let (valid, invalid) = parse_servers("8.8.8.8,dns.google,1.2.3.4:53,[::1]");
        assert_eq!(valid, ips(&["8.8.8.8"]));
        assert_eq!(invalid, vec!["dns.google", "1.2.3.4:53", "[::1]"]);
    }

    #[tokio::test]
    async fn an_ip_literal_never_reaches_a_resolver() {
        let r = Responder::start(|_, _| Answer::A(vec![Ipv4Addr::new(203, 0, 113, 99)])).await;
        let (os, os_calls) = fake_os(&[]);
        let dns = dns_via(&r, os);
        assert_eq!(resolve(&dns, "10.1.2.3").await.unwrap(), ips(&["10.1.2.3"]));
        assert_eq!(resolve(&dns, "[2001:db8::1]").await.unwrap(), ips(&["2001:db8::1"]), "bracketed, as a URL spells it");
        assert_eq!(ip_literal("::1"), Some("::1".parse().unwrap()), "bare v6");
        assert!(r.asked().is_empty(), "the configured servers were never asked");
        assert_eq!(os_calls.load(Ordering::SeqCst), 0, "nor the OS resolver");
    }

    #[tokio::test]
    async fn the_configured_servers_answer_before_the_os_resolver() {
        let r = Responder::start(|name, qtype| match (name, qtype) {
            ("cdn.example.test", A) => Answer::A(vec![Ipv4Addr::new(203, 0, 113, 7), Ipv4Addr::new(203, 0, 113, 8)]),
            _ => Answer::NxDomain,
        })
        .await;
        // The OS would answer differently — split-horizon — and must not be the one heard.
        let (os, os_calls) = fake_os(&[("cdn.example.test", "198.51.100.1")]);
        let dns = dns_via(&r, os);
        assert_eq!(resolve(&dns, "cdn.example.test").await.unwrap(), ips(&["203.0.113.7", "203.0.113.8"]));
        assert_eq!(os_calls.load(Ordering::SeqCst), 0);
        assert_eq!(r.asked(), vec![("cdn.example.test".to_string(), A)], "one A query, and no AAAA once A answered");
    }

    #[tokio::test]
    async fn aaaa_is_asked_only_when_a_comes_back_empty() {
        let r = Responder::start(|name, qtype| match (name, qtype) {
            ("v6only.example.test", AAAA) => Answer::Aaaa(vec!["2001:db8::7".parse().unwrap()]),
            ("v6only.example.test", A) => Answer::NoData,
            _ => Answer::NxDomain,
        })
        .await;
        let (os, os_calls) = fake_os(&[]);
        let dns = dns_via(&r, os);
        assert_eq!(resolve(&dns, "v6only.example.test").await.unwrap(), ips(&["2001:db8::7"]));
        assert_eq!(
            r.asked(),
            vec![("v6only.example.test".to_string(), A), ("v6only.example.test".to_string(), AAAA)],
            "A first, then AAAA"
        );
        assert_eq!(os_calls.load(Ordering::SeqCst), 0, "an AAAA answer is still the custom servers' answer");
    }

    /// The load-bearing half of the contract: whatever goes wrong at the configured servers, the OS resolver gets
    /// the last word — which is what keeps `.local`, LAN and compose-service names working.
    #[tokio::test]
    async fn any_custom_failure_falls_back_to_the_os_resolver() {
        for (case, answer) in [
            ("nxdomain", Answer::NxDomain),
            ("servfail", Answer::ServFail),
            ("no records in either family", Answer::NoData),
            ("a server that never answers", Answer::Silent),
        ] {
            let r = Responder::start(move |_, _| answer.clone()).await;
            let (os, os_calls) = fake_os(&[("nas.local", "192.168.1.20")]);
            let dns = dns_via(&r, os);
            assert_eq!(resolve(&dns, "nas.local").await, Ok(ips(&["192.168.1.20"])), "{case}");
            assert_eq!(os_calls.load(Ordering::SeqCst), 1, "{case}: asked the OS once");
            assert!(!r.asked().is_empty(), "{case}: the servers were asked first");
        }

        // A server with nothing listening at all (its port bound, then released).
        let gone = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let (os, _) = fake_os(&[("compose-service", "172.18.0.4")]);
        let dns = UpstreamDns::with_parts(os, gone, TEST_QUERY, SERVERS_DOWN_WINDOW);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        assert_eq!(resolve(&dns, "compose-service").await, Ok(ips(&["172.18.0.4"])), "unreachable nameserver");
    }

    /// A nameserver that never answers costs ONE query timeout, not two: it left the A query unanswered, so it is
    /// not asked AAAA. The next lookup — for any host — does not ask it at all: the OS resolver answers alone until
    /// the down window lapses, and then the servers get their turn again. Before, every new upstream connection
    /// paid A + AAAA timeouts out of its connect budget, for as long as the server stayed dead.
    #[tokio::test]
    async fn a_server_that_does_not_answer_is_asked_once_and_then_left_alone_for_a_window() {
        let r = Responder::start(|_, _| Answer::Silent).await;
        let (os, os_calls) = fake_os(&[("nas.lan", "192.168.1.20"), ("cdn.example.test", "198.51.100.1")]);
        let window = Duration::from_millis(800);
        let dns = UpstreamDns::with_parts(os, r.port, TEST_QUERY, window);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));

        assert_eq!(resolve(&dns, "nas.lan").await, Ok(ips(&["192.168.1.20"])));
        let asked = r.asked();
        assert!(!asked.is_empty(), "the servers were asked first");
        assert!(asked.iter().all(|(_, q)| *q == A), "an unanswered A query is not followed by an AAAA one: {asked:?}");

        assert_eq!(resolve(&dns, "cdn.example.test").await, Ok(ips(&["198.51.100.1"])));
        assert_eq!(r.asked().len(), asked.len(), "inside the window the dead servers are not asked at all");
        assert_eq!(os_calls.load(Ordering::SeqCst), 2, "the OS resolver answered both");

        tokio::time::sleep(window).await;
        assert_eq!(resolve(&dns, "nas.lan").await, Ok(ips(&["192.168.1.20"])));
        assert!(r.asked().len() > asked.len(), "once the window lapses the servers are asked again");
    }

    /// reqwest's connect timeout (and the fetch read timeout) wrap the resolve, and the operator can set either
    /// below the query timeout. The connection that asked a dead server then gives up mid-query — and what the
    /// server did must still be recorded: before, the dropped lookup took the window with it, so every later
    /// connection asked the same dead server, ran out of budget the same way, and never reached the OS resolver.
    #[tokio::test]
    async fn a_caller_that_gives_up_mid_query_still_opens_the_down_window() {
        let r = Responder::start(|_, _| Answer::Silent).await;
        let (os, os_calls) = fake_os(&[("cdn.example.test", "198.51.100.1")]);
        let dns = UpstreamDns::with_parts(os, r.port, TEST_QUERY, SERVERS_DOWN_WINDOW);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        let budget = TEST_QUERY / 3; // a connect timeout shorter than one query

        let first = tokio::time::timeout(budget, resolve(&dns, "cdn.example.test")).await;
        assert!(first.is_err(), "the first connection runs out of budget while the servers are asked");
        assert_eq!(os_calls.load(Ordering::SeqCst), 0, "it never got as far as the fallback");

        tokio::time::sleep(TEST_QUERY + Duration::from_millis(200)).await; // the abandoned query times out on its own
        let asked = r.asked().len();
        let next = tokio::time::timeout(budget, resolve(&dns, "cdn.example.test")).await;
        assert_eq!(next.expect("inside the window the OS resolver answers within the budget"), Ok(ips(&["198.51.100.1"])));
        assert_eq!(r.asked().len(), asked, "and the dead servers are not asked again");
    }

    /// The window is for servers that do not ANSWER. One that answers "no such name" is up — the name may simply be
    /// a LAN one — so every lookup still asks it first, A then AAAA, exactly as before.
    #[tokio::test]
    async fn a_server_that_answers_no_is_not_down() {
        let r = Responder::start(|_, _| Answer::NxDomain).await;
        let (os, _) = fake_os(&[("a.lan", "192.168.1.20"), ("b.lan", "192.168.1.21")]);
        let dns = dns_via(&r, os);
        assert_eq!(resolve(&dns, "a.lan").await, Ok(ips(&["192.168.1.20"])));
        assert_eq!(resolve(&dns, "b.lan").await, Ok(ips(&["192.168.1.21"])));
        let for_b: Vec<u16> = r.asked().into_iter().filter(|(n, _)| n == "b.lan").map(|(_, q)| q).collect();
        assert_eq!(for_b, vec![A, AAAA], "the second lookup still asked the servers, both families");
    }

    /// RFC 6761 lets a resolver answer the whole `localhost.` zone with loopback on its own, and hickory does — so
    /// an upstream-supplied `x.localhost` used to be dialled on this box. The zone is the OS resolver's to answer
    /// now, as it is for dns.ts; getaddrinfo refuses the made-up names, and the servers are never asked.
    #[tokio::test]
    async fn a_name_in_the_localhost_zone_is_the_os_resolvers_to_answer() {
        let r = Responder::start(|_, _| Answer::A(vec![Ipv4Addr::new(203, 0, 113, 99)])).await;
        let (os, os_calls) = fake_os(&[("localhost", "127.0.0.1")]);
        let dns = dns_via(&r, os);
        let active = dns.active.read_ok().clone();
        let seen = Mutex::new(HashMap::new());
        assert!(resolve(&dns, "evil.localhost").await.is_err(), "through the resolver reqwest calls");
        for host in ["x.localhost", "a.b.LOCALHOST", "evil.localhost."] {
            let got = lookup(host, &active, &dns.os, &seen, SERVERS_DOWN_WINDOW).await;
            assert!(got.is_err(), "{host}: what getaddrinfo refuses is refused, never answered with loopback");
        }
        let own = lookup("localhost", &active, &dns.os, &seen, SERVERS_DOWN_WINDOW).await.expect("the OS knows localhost");
        assert_eq!(own, ips(&["127.0.0.1"]), "`localhost` itself comes from the OS resolver's own table");
        assert!(r.asked().is_empty(), "the configured servers were never asked about the zone");
        assert_eq!(os_calls.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn the_localhost_zone_is_matched_on_whole_labels() {
        for h in ["localhost", "LOCALHOST", "localhost.", "x.localhost", "a.b.localhost.", "Evil.LocalHost"] {
            assert!(in_localhost_zone(h), "{h} is in the zone");
        }
        for h in ["localhost.example.com", "notlocalhost", "xlocalhost.", "localhost.com", "cdn.example.test", ""] {
            assert!(!in_localhost_zone(h), "{h} is not");
        }
    }

    #[tokio::test]
    async fn a_lookup_fails_only_when_the_os_resolver_fails_too() {
        let r = Responder::start(|_, _| Answer::NxDomain).await;
        let (os, os_calls) = fake_os(&[]);
        let dns = dns_via(&r, os);
        let err = resolve(&dns, "nowhere.example.test").await.expect_err("both resolvers refused the name");
        assert_eq!(os_calls.load(Ordering::SeqCst), 1);
        assert!(!err.contains("unknown to the OS"), "the custom servers' error is the one surfaced, got: {err}");
    }

    #[tokio::test]
    async fn with_no_servers_configured_every_name_goes_to_the_os_resolver() {
        let (os, os_calls) = fake_os(&[("pluto.example.test", "198.51.100.9")]);
        let dns = UpstreamDns::with_parts(os, DNS_PORT, QUERY_TIMEOUT, SERVERS_DOWN_WINDOW);
        assert!(dns.servers().is_empty(), "a fresh instance asks nobody but the OS");
        assert_eq!(resolve(&dns, "pluto.example.test").await, Ok(ips(&["198.51.100.9"])));
        assert_eq!(os_calls.load(Ordering::SeqCst), 1);
    }

    /// The echo is read every flush — a few times a second under load — so the unchanged case must cost nothing
    /// and keep the resolver (and its answer cache); only a real change may retarget it, and "no opinion" (an
    /// older Node, a malformed value) must never be read as "no servers".
    #[test]
    fn the_echo_retargets_the_resolver_only_when_it_says_something_new() {
        let dns = UpstreamDns::new();
        let active = |d: &UpstreamDns| d.active.read_ok().clone();

        dns.apply_echo(&serde_json::json!({ "logLevel": 2, "nameservers": "192.0.2.1,192.0.2.2" }));
        assert_eq!(dns.servers(), ips(&["192.0.2.1", "192.0.2.2"]));
        let installed = active(&dns);

        dns.apply_echo(&serde_json::json!({ "logLevel": 2, "nameservers": "192.0.2.1,192.0.2.2" }));
        assert!(Arc::ptr_eq(&installed, &active(&dns)), "the steady-state echo swaps nothing");

        dns.apply_echo(&serde_json::json!({ "logLevel": 2 }));
        dns.apply_echo(&serde_json::json!({ "nameservers": 53 }));
        assert!(Arc::ptr_eq(&installed, &active(&dns)), "an absent or malformed value is no opinion");

        dns.apply_echo(&serde_json::json!({ "nameservers": "192.0.2.1, 192.0.2.2" }));
        assert_eq!(dns.servers(), ips(&["192.0.2.1", "192.0.2.2"]), "a new spelling of the same list");

        dns.apply_echo(&serde_json::json!({ "nameservers": null }));
        assert!(dns.servers().is_empty(), "null is Node's word for the OS resolver");
        assert!(active(&dns).resolver.is_none());

        dns.apply_echo(&serde_json::json!({ "nameservers": "not-an-ip" }));
        assert!(dns.servers().is_empty(), "a list with nothing valid in it is the OS resolver too");
    }

    /// A reqwest client built ONCE with the shared resolver follows every retarget — the property that lets
    /// `client_for`'s cached clients, the default client and the probe all track Settings with no rebuild.
    #[tokio::test]
    async fn a_client_built_once_follows_every_retarget() {
        let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let web_port = web.local_addr().unwrap().port();
        tokio::spawn(async move {
            let app = axum::Router::new().route("/", axum::routing::get(|| async { "upstream" }));
            let _ = axum::serve(web, app).await;
        });
        let r = Responder::start(|name, qtype| match (name, qtype) {
            ("origin.example.test", A) => Answer::A(vec![Ipv4Addr::LOCALHOST]),
            _ => Answer::NxDomain,
        })
        .await;
        let (os, _) = fake_os(&[]); // the OS knows no such name
        let dns = Arc::new(UpstreamDns::with_parts(os, r.port, TEST_QUERY, SERVERS_DOWN_WINDOW));
        let client = reqwest::Client::builder()
            .dns_resolver(dns.clone())
            .pool_max_idle_per_host(0) // every request dials — so every request resolves
            .build()
            .unwrap();
        let url = format!("http://origin.example.test:{web_port}/");
        let fetch = || async { client.get(&url).send().await.map(|resp| resp.status().as_u16()) };

        assert!(fetch().await.is_err(), "no servers: only the OS resolver, which cannot place the name");
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        assert_eq!(fetch().await.ok(), Some(200), "retargeted: the same client now resolves through the servers");
        dns.apply_echo(&serde_json::json!({ "nameservers": null }));
        assert!(fetch().await.is_err(), "and back to the OS resolver just as live");
    }

    #[test]
    fn a_failure_is_named_in_the_c_ares_words_dns_ts_logs() {
        use hickory_resolver::net::NoRecords;
        use hickory_resolver::proto::op::Query;
        use hickory_resolver::proto::rr::{Name as DnsName, RecordType};
        let none = |rc| {
            let q = Query::query(DnsName::from_ascii("nas.lan.").unwrap(), RecordType::A);
            NetError::Dns(DnsError::NoRecordsFound(NoRecords::new(q, rc)))
        };
        assert_eq!(failure_code(&none(ResponseCode::NXDomain)), "ENOTFOUND");
        assert_eq!(failure_code(&none(ResponseCode::NoError)), "ENODATA", "the name exists, the family does not");
        assert_eq!(failure_code(&NetError::Dns(DnsError::ResponseCode(ResponseCode::ServFail))), "ESERVFAIL");
        assert_eq!(failure_code(&NetError::Dns(DnsError::ResponseCode(ResponseCode::Refused))), "EREFUSED");
        assert_eq!(failure_code(&NetError::Timeout), "ETIMEOUT", "the blackholed nameserver");
        let refused = io::Error::from(io::ErrorKind::ConnectionRefused);
        assert_eq!(failure_code(&NetError::Io(Arc::new(refused))), "ECONNREFUSED");
        // Anything without a c-ares name keeps hickory's own words rather than a made-up code.
        assert_eq!(failure_code(&NetError::NoConnections), NetError::NoConnections.to_string());
    }

    #[test]
    fn a_success_is_traced_on_dns_ts_s_level_ladder() {
        let seen = Mutex::new(HashMap::new());
        assert!(!admit_trace(&seen, 1, "a.test", "4|203.0.113.1"), "level 1: lifecycle and warnings only");
        assert!(admit_trace(&seen, 2, "a.test", "4|203.0.113.1"), "level 2: the first answer for a host");
        assert!(!admit_trace(&seen, 2, "a.test", "4|203.0.113.1"), "…not the same answer again");
        assert!(admit_trace(&seen, 2, "a.test", "4|203.0.113.2"), "…but a changed one");
        assert!(admit_trace(&seen, 2, "b.test", "4|203.0.113.2"), "hosts are deduped apart");
        assert!(admit_trace(&seen, 3, "a.test", "4|203.0.113.2"), "level 3: every resolution");
        assert!(admit_trace(&seen, 3, "a.test", "4|203.0.113.2"));
    }

    #[test]
    fn the_level_two_dedupe_stays_bounded() {
        let seen = Mutex::new(HashMap::new());
        for i in 0..(SEEN_MAX * 3) {
            admit_trace(&seen, 2, &format!("host-{i}.test"), "4|203.0.113.1");
        }
        assert!(seen.lock_ok().len() <= SEEN_MAX);
    }
}
