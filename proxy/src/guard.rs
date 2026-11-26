use crate::sync::RwExt;
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{LazyLock, RwLock};

#[derive(Default)]
struct Control {
    names: HashSet<String>,
    ips: HashSet<IpAddr>,
    endpoint: Option<(String, u16)>,
}

static CONTROL: LazyLock<RwLock<Control>> = LazyLock::new(|| RwLock::new(Control::default()));

fn norm(host: &str) -> String {
    let h = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    h.strip_suffix('.').unwrap_or(h).to_ascii_lowercase()
}

pub(crate) fn parse_tcp_endpoint(value: &str) -> Option<(String, u16)> {
    let rest = value.trim().strip_prefix("tcp://").or_else(|| value.trim().strip_prefix("http://"))?;
    let rest = rest.trim_end_matches('/');
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (h, p) = v6.split_once("]:")?;
        (h, p)
    } else {
        rest.rsplit_once(':')?
    };
    if host.is_empty() || host.contains('/') {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    Some((norm(host), port))
}

pub(crate) fn add_control_endpoint(host: &str, port: u16) {
    let h = norm(host);
    let mut c = CONTROL.write_ok();
    if let Ok(ip) = h.parse::<IpAddr>() {
        c.ips.insert(ip);
    }
    c.names.insert(h.clone());
    c.endpoint = Some((h, port));
}

pub(crate) fn add_control_ip(ip: IpAddr) {
    CONTROL.write_ok().ips.insert(canonical(ip));
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

pub(crate) fn is_control_ip(ip: IpAddr) -> bool {
    CONTROL.read_ok().ips.contains(&canonical(ip))
}

pub(crate) fn is_control_host(host: &str) -> bool {
    let h = norm(host);
    if let Ok(ip) = h.parse::<IpAddr>() {
        return is_control_ip(ip);
    }
    CONTROL.read_ok().names.contains(&h)
}

pub(crate) fn host_blocked(host: &str, allow_private: bool) -> bool {
    is_control_host(host) || (!allow_private && crate::proxy::is_private_host(host))
}

pub(crate) fn redirect_policy(max: usize, allow_private: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > max {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        let ok_scheme = matches!(url.scheme(), "http" | "https");
        match url.host_str() {
            Some(h) if ok_scheme && !host_blocked(h, allow_private) => attempt.follow(),
            _ => {
                let to = url.host_str().unwrap_or("").to_string();
                attempt.error(format!("redirect to a blocked upstream host ({to})"))
            }
        }
    })
}

pub(crate) fn init_from_env() {
    if std::env::var("DOCKER_SOCK_ACCESS").map(|v| v.trim() == "1").unwrap_or(false) {
        if let Some((host, port)) = std::env::var("MASQ_DOCKER_HOST").ok().as_deref().and_then(parse_tcp_endpoint) {
            add_control_endpoint(&host, port);
            crate::log::info("proxy", "", || {
                format!("Docker control endpoint {host}:{port} is never a valid upstream (name + resolved addresses)")
            });
            tokio::spawn(refresh_control_ips());
        }
    }
}

async fn refresh_control_ips() {
    loop {
        let endpoint = CONTROL.read_ok().endpoint.clone();
        if let Some((host, port)) = endpoint {
            if let Ok(addrs) = tokio::net::lookup_host((host.as_str(), port)).await {
                for a in addrs {
                    add_control_ip(a.ip());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const CTL_NAME: &str = "docker-sock-proxy.guard-test";
    const CTL_IP: &str = "203.0.113.250";

    fn configure() {
        add_control_endpoint(CTL_NAME, 2375);
        add_control_ip(CTL_IP.parse().unwrap());
    }

    #[test]
    fn a_tcp_docker_host_is_parsed_and_anything_else_is_not() {
        assert_eq!(parse_tcp_endpoint("tcp://docker-sock-proxy:2375"), Some(("docker-sock-proxy".into(), 2375)));
        assert_eq!(parse_tcp_endpoint("http://10.0.0.5:2375/"), Some(("10.0.0.5".into(), 2375)));
        assert_eq!(parse_tcp_endpoint("tcp://[fd00::1]:2375"), Some(("fd00::1".into(), 2375)));
        for v in ["unix:///var/run/docker.sock", "/var/run/docker.sock", "", "tcp://nohost", "tcp://h:notaport"] {
            assert_eq!(parse_tcp_endpoint(v), None, "{v}");
        }
    }

    #[test]
    fn the_docker_control_endpoint_is_refused_even_where_lan_reach_is_allowed() {
        configure();
        for h in [CTL_NAME, "Docker-Sock-Proxy.Guard-Test.", CTL_IP, "[::ffff:203.0.113.250]"] {
            assert!(is_control_host(h), "{h} is the control endpoint");
            assert!(host_blocked(h, true), "{h} is refused with allowPrivate");
            assert!(host_blocked(h, false), "{h} is refused without allowPrivate");
        }
        assert!(is_control_ip(CTL_IP.parse().unwrap()));
    }

    #[test]
    fn ordinary_names_and_lan_reach_keep_their_old_verdicts() {
        configure();
        for h in ["nas", "notlocalhost", "rebel-iptv", "cdn.example.com", "100.101.102.103"] {
            assert!(!host_blocked(h, false), "{h} still passes");
        }
        for h in ["192.168.1.10", "127.0.0.1", "localhost"] {
            assert!(host_blocked(h, false), "{h} still needs allowPrivate");
            assert!(!host_blocked(h, true), "{h} passes with allowPrivate");
        }
    }

    async fn redirector(location: String) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { return };
                let loc = location.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = s.read(&mut buf).await;
                    let req = String::from_utf8_lossy(&buf);
                    let resp = if req.starts_with("GET /final") {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string()
                    } else {
                        format!("HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    };
                    let _ = s.write_all(resp.as_bytes()).await;
                });
            }
        });
        port
    }

    fn client(allow_private: bool) -> reqwest::Client {
        reqwest::Client::builder().redirect(redirect_policy(10, allow_private)).build().unwrap()
    }

    #[tokio::test]
    async fn a_redirect_hop_is_judged_by_the_same_gate_as_the_entry() {
        configure();
        let to_private = redirector("http://127.0.0.1:9/final".into()).await;
        let url = format!("http://127.0.0.1:{to_private}/start");
        let err = client(false).get(&url).send().await.expect_err("a redirect into a private literal is refused");
        assert!(err.is_redirect(), "refused as a redirect, not a connect error: {err}");

        let final_port = redirector(String::new()).await;
        let to_lan = redirector(format!("http://127.0.0.1:{final_port}/final")).await;
        let ok = client(true).get(format!("http://127.0.0.1:{to_lan}/start")).send().await.expect("allowPrivate follows LAN hops");
        assert_eq!(ok.status().as_u16(), 200);

        let to_ctl = redirector(format!("http://{CTL_NAME}:2375/containers/json")).await;
        let err = client(true).get(format!("http://127.0.0.1:{to_ctl}/start")).send().await.expect_err("never into the control endpoint");
        assert!(err.is_redirect(), "{err}");
    }

    #[tokio::test]
    async fn the_redirect_limit_still_holds() {
        let self_loop = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let p = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                loop {
                    let Ok((mut s, _)) = listener.accept().await else { return };
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let _ = s.read(&mut buf).await;
                        let r = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{p}/again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = s.write_all(r.as_bytes()).await;
                    });
                }
            });
            p
        };
        let err = reqwest::Client::builder()
            .redirect(redirect_policy(3, true))
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{self_loop}/start"))
            .send()
            .await
            .expect_err("an endless redirect stops at the limit");
        assert!(err.is_redirect(), "{err}");
    }
}
