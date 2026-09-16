
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

const TAG: &str = "proxy:dns";

const DNS_PORT: u16 = 53;

const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

const SERVERS_DOWN_WINDOW: Duration = Duration::from_secs(30);

const SEEN_MAX: usize = 1024;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

type OsLookup = Arc<dyn Fn(String) -> OsAnswer + Send + Sync>;
type OsAnswer = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

struct Active {
    raw: String,
    servers: Vec<IpAddr>,
    resolver: Option<TokioResolver>,
    down_until: Mutex<Option<Instant>>,
}

impl Active {
    fn new(raw: String, servers: Vec<IpAddr>, resolver: Option<TokioResolver>) -> Self {
        Self { raw, servers, resolver, down_until: Mutex::new(None) }
    }

    fn os_only() -> Self {
        Self::new(String::new(), Vec::new(), None)
    }

    fn servers_down(&self) -> bool {
        self.down_until.lock_ok().is_some_and(|until| Instant::now() < until)
    }

    fn trip(&self, window: Duration) -> bool {
        let now = Instant::now();
        let mut until = self.down_until.lock_ok();
        let opened = !until.is_some_and(|t| now < t);
        *until = now.checked_add(window);
        opened
    }

    fn heal(&self) -> bool {
        self.down_until.lock_ok().take().is_some()
    }
}

pub struct UpstreamDns {
    active: RwLock<Arc<Active>>,
    seen: Arc<Mutex<HashMap<String, String>>>,
    os: OsLookup,
    port: u16,
    query_timeout: Duration,
    down_window: Duration,
}

impl UpstreamDns {
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

    pub fn init_from_env(&self) {
        let raw = std::env::var("MASQ_NAMESERVERS").unwrap_or_default();
        self.swap(&raw, "env", true);
    }

    pub fn apply_echo(&self, echo: &Value) {
        match echo.get("nameservers") {
            Some(Value::String(list)) => self.swap(list, "seam echo", false),
            Some(Value::Null) => self.swap("", "seam echo", false),
            _ => {}
        }
    }

    fn swap(&self, raw: &str, from: &str, announce: bool) {
        if !announce && self.active.read_ok().raw == raw {
            return;
        }
        let (servers, invalid) = parse_servers(raw);
        let changed = {
            let mut active = self.active.write_ok();
            if !announce && active.raw == raw {
                return;
            }
            let changed = active.servers != servers;
            let resolver = if changed { self.build(&servers) } else { active.resolver.clone() };
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

    fn build(&self, servers: &[IpAddr]) -> Option<TokioResolver> {
        if servers.is_empty() {
            return None;
        }
        let name_servers = servers
            .iter()
            .map(|&ip| {
                let mut ns = NameServerConfig::udp_and_tcp(ip);
                for conn in &mut ns.connections {
                    conn.port = self.port;
                }
                ns
            })
            .collect();
        let mut opts = ResolverOpts::default();
        opts.timeout = self.query_timeout;
        opts.attempts = 0;
        opts.use_hosts_file = ResolveHosts::Never;
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

    pub fn servers(&self) -> Vec<IpAddr> {
        self.active.read_ok().servers.clone()
    }
}

#[cfg(test)]
impl UpstreamDns {
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
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

async fn lookup(
    host: &str,
    active: &Arc<Active>,
    os: &OsLookup,
    seen: &Mutex<HashMap<String, String>>,
    down_window: Duration,
) -> Result<Vec<IpAddr>, BoxError> {
    if let Some(ip) = ip_literal(host) {
        return Ok(vec![ip]);
    }
    if in_localhost_zone(host) {
        return Ok(os(host.to_string()).await?);
    }
    let Some(resolver) = &active.resolver else {
        return Ok(os(host.to_string()).await?);
    };
    if active.servers_down() {
        return Ok(os(host.to_string()).await?);
    }
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
        Err(e) => CustomFailure { code: "EINTERNAL".to_string(), err: Box::new(e), unanswered: false },
    };
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

struct CustomFailure {
    code: String,
    err: BoxError,
    unanswered: bool,
}

impl From<NetError> for CustomFailure {
    fn from(e: NetError) -> Self {
        Self { code: failure_code(&e), unanswered: unanswered(&e), err: e.into() }
    }
}

fn unanswered(e: &NetError) -> bool {
    matches!(e, NetError::Timeout | NetError::NoConnections | NetError::Io(_))
}

async fn ask_servers(resolver: &TokioResolver, host: &str) -> Result<Vec<IpAddr>, CustomFailure> {
    let a_failed = match resolver.ipv4_lookup(host).await {
        Ok(found) => {
            let ips = addresses(found.answers(), true);
            if !ips.is_empty() {
                return Ok(ips);
            }
            CustomFailure { code: "ENODATA".to_string(), err: format!("{host}: no A records").into(), unanswered: false }
        }
        Err(e) if unanswered(&e) => return Err(e.into()),
        Err(e) => e.into(),
    };
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

fn addresses(answers: &[hickory_resolver::proto::rr::Record], v4: bool) -> Vec<IpAddr> {
    answers.iter().filter_map(|r| r.data.ip_addr()).filter(|ip| ip.is_ipv4() == v4).collect()
}

fn system_lookup() -> OsLookup {
    Arc::new(|host: String| -> OsAnswer {
        Box::pin(async move { Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.map(|sa| sa.ip()).collect()) })
    })
}

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

fn ip_literal(host: &str) -> Option<IpAddr> {
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    bare.parse().ok()
}

pub(crate) fn in_localhost_zone(host: &str) -> bool {
    let h = host.strip_suffix('.').unwrap_or(host).as_bytes();
    const ZONE: &[u8] = b"localhost";
    h.eq_ignore_ascii_case(ZONE) || (h.len() > ZONE.len() + 1 && h[h.len() - ZONE.len() - 1..].eq_ignore_ascii_case(b".localhost"))
}

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

    #[derive(Clone)]
    enum Answer {
        A(Vec<Ipv4Addr>),
        Aaaa(Vec<Ipv6Addr>),
        NoData,
        NxDomain,
        ServFail,
        Silent,
    }

    const A: u16 = 1;
    const AAAA: u16 = 28;

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
        out.extend_from_slice(&q[0..2]);
        out.push(0x80 | (q[2] & 0x01));
        out.push(0x80 | rcode);
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&(records.len() as u16).to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&q[12..end]);
        for (rtype, rdata) in records {
            out.extend_from_slice(&[0xC0, 0x0C]);
            out.extend_from_slice(&rtype.to_be_bytes());
            out.extend_from_slice(&1u16.to_be_bytes());
            out.extend_from_slice(&60u32.to_be_bytes());
            out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            out.extend_from_slice(&rdata);
        }
        Some(out)
    }

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

    const TEST_QUERY: Duration = Duration::from_millis(300);

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

        let gone = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let (os, _) = fake_os(&[("compose-service", "172.18.0.4")]);
        let dns = UpstreamDns::with_parts(os, gone, TEST_QUERY, SERVERS_DOWN_WINDOW);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        assert_eq!(resolve(&dns, "compose-service").await, Ok(ips(&["172.18.0.4"])), "unreachable nameserver");
    }

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

    #[tokio::test]
    async fn a_caller_that_gives_up_mid_query_still_opens_the_down_window() {
        let r = Responder::start(|_, _| Answer::Silent).await;
        let (os, os_calls) = fake_os(&[("cdn.example.test", "198.51.100.1")]);
        let dns = UpstreamDns::with_parts(os, r.port, TEST_QUERY, SERVERS_DOWN_WINDOW);
        dns.apply_echo(&serde_json::json!({ "nameservers": "127.0.0.1" }));
        let budget = TEST_QUERY / 3;

        let first = tokio::time::timeout(budget, resolve(&dns, "cdn.example.test")).await;
        assert!(first.is_err(), "the first connection runs out of budget while the servers are asked");
        assert_eq!(os_calls.load(Ordering::SeqCst), 0, "it never got as far as the fallback");

        tokio::time::sleep(TEST_QUERY + Duration::from_millis(200)).await;
        let asked = r.asked().len();
        let next = tokio::time::timeout(budget, resolve(&dns, "cdn.example.test")).await;
        assert_eq!(next.expect("inside the window the OS resolver answers within the budget"), Ok(ips(&["198.51.100.1"])));
        assert_eq!(r.asked().len(), asked, "and the dead servers are not asked again");
    }

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
        let (os, _) = fake_os(&[]);
        let dns = Arc::new(UpstreamDns::with_parts(os, r.port, TEST_QUERY, SERVERS_DOWN_WINDOW));
        let client = reqwest::Client::builder()
            .dns_resolver(dns.clone())
            .pool_max_idle_per_host(0)
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
