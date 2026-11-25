---
name: active-scan
description: [Recon] Active port and service scanning (nmap/masscan), strictly within the authorized scope
whenToUse: When asset liveness and open ports need to be confirmed
role: recon
category: Recon
tags: [external, scan, nmap]
enabled: true
---

> Scan **T0/T1** only; T2 neighbor sites / same C-segment require explicit user consent, T3 is off limits.

## Preflight checks
1. Confirm the target CIDR is within the authorized scope.
2. Confirm the current time window allows active scanning.

## Commands
- Fast liveness: `nmap -sn <cidr>`
- All ports (rate limited): `nmap -sS -p- --min-rate 1000 -T4 <target> -oX runs/nmap-full.xml`
- Service versions: `nmap -sV -sC -p <ports> <target> -oX runs/nmap-svc.xml`

## Locally provisioned tools (absolute paths, prefer them, do not hand-roll)
| Purpose | Command |
| --- | --- |
| Port scanning | `nmap` / `masscan` / `~/.dsh/redteam/toolkit/naabu/naabu` (SYN needs root, otherwise add `-scan-type c`) |
| Internal network sweep | `~/.dsh/redteam/toolkit/fscan/fscan` (skill fscan-intranet) |
| Internal network mapping / fingerprinting | `~/.dsh/redteam/toolkit/gogo/gogo` (skill gogo-intranet) |
| HTTP probing (ProjectDiscovery) | `~/.local/bin/pd-httpx` (**note: `/usr/bin/httpx` is the CLI of the Python httpx library, not this one**) |
| Subdomain / resolution | `~/.dsh/redteam/toolkit/subfinder/subfinder`, `~/.dsh/redteam/toolkit/dnsx/dnsx` |
| POC scanning | `nuclei` (templates already in `~/.local/nuclei-templates`) |
| Directory bruteforce | `ffuf`, `~/.dsh/redteam/toolkit/dirsearch/dirsearch` |
| Tunnels | `~/.dsh/redteam/toolkit/suo5/suo5-linux-amd64`, `toolkit/chisel/chisel`, `toolkit/frp/{frpc,frps}` |
| Full inventory | `~/.dsh/redteam/toolkit/inventory.md`, `skills-tool-inventory.md` |

## Persistence requirements
provenance = `active`, tool = `nmap`/`masscan`, record a scan_run.
