---
name: recon-pipeline
description: 【Recon】ProjectDiscovery information-gathering pipeline: subfinder→dnsx→naabu→httpx→katana, rolling out a domain's asset surface in one pass
whenToUse: In the information-gathering phase, once you have a domain/organization name, systematically expand subdomains→resolution→ports→liveness→pages and interfaces
role: recon
category: Recon
tags: [external, subdomain, pipeline]
enabled: true
---

# External Information-Gathering Pipeline (ProjectDiscovery)

Turning "one domain" into "a list of live assets with titles, tech stacks and ports" is the standard move of the information-gathering phase.
The four tools have a **fixed order**: enumerate subdomains → resolve → probe ports → determine liveness → finally scrape pages and interfaces.

## Local Tools

| Tool | Path | Version | Purpose |
| --- | --- | --- | --- |
| subfinder | `$DSH_HOME/redteam/toolkit/subfinder/subfinder` | v2.16.0 | Passive subdomain enumeration (multi-source aggregation) |
| dnsx | `$DSH_HOME/redteam/toolkit/dnsx/dnsx` | v1.3.1 | Batch resolution, DNS bruteforce, wildcard filtering |
| naabu | `$DSH_HOME/redteam/toolkit/naabu/naabu` | v2.6.1 | High-speed port scanning (SYN needs root, otherwise `-scan-type c`) |
| httpx | `$DSH_HOME/redteam/toolkit/httpx/httpx` (wrapper `~/.local/bin/pd-httpx`) | v1.12.0 | HTTP liveness/title/tech stack/status code |
| katana | ❌ Not installed (use the `browser-automation` skill if scraping is needed) | — | Crawler for pages and interfaces |
| ksubdomain | `$DSH_HOME/redteam/toolkit/ksubdomain/ksubdomain` | v0.7 | Stateless subdomain bruteforce (faster than dnsx bruteforce) |
| OneForAll | `$DSH_HOME/redteam/toolkit/oneforall/OneForAll-0.4.5/` (source, needs `.venv`) | v0.4.5 | Subdomain collection all-in-one (large wordlist, slow but thorough) |

> ⚠️ **`/usr/bin/httpx` is the CLI of the Python httpx library, not ProjectDiscovery's** — you must use `pd-httpx` or the absolute path.

## Standard Pipeline

```bash
mkdir -p runs
TK=$DSH_HOME/redteam/toolkit
D=example.com

# ① Subdomain enumeration (passive, multi-source)
$TK/subfinder/subfinder -d $D -all -silent -o runs/subfinder-$D.txt
# Supplement: stateless bruteforce (when a wordlist is available)
# $TK/ksubdomain/ksubdomain -d $D -f /usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt

# ② Wildcard filtering + resolution liveness (dnsx removes wildcard noise; this step is critical)
cat runs/subfinder-$D.txt | $TK/dnsx/dnsx -silent -a -resp -o runs/dnsx-$D.txt
awk '{print $1}' runs/dnsx-$D.txt | sort -u > runs/alive-domains-$D.txt

# ③ Port scanning (top100 for a quick pass first, then all ports on live hosts)
$TK/naabu/naabu -l runs/alive-domains-$D.txt -top-ports 100 -silent -o runs/naabu-$D.txt
# All ports (slow; confirm scope before doing it): -p - -rate 1000

# ④ HTTP liveness and fingerprinting (title/status code/tech stack/web server)
$TK/httpx/httpx -l runs/alive-domains-$D.txt -ports 80,443,8080,8443,8000,8888,9000 \
  -title -status-code -tech-detect -web-server -follow-redirects -silent \
  -json -o runs/httpx-$D.jsonl

# ⑤ Consolidate into an asset list (the URL list feeds directory bruteforce/vulnerability scanning)
python3 - <<'PY'
import json
out=set()
for line in open('runs/httpx-'+'$D'+'.jsonl'):
    try: j=json.loads(line)
    except: continue
    if j.get('url'): out.add(j['url'])
open('runs/alive-urls.txt','w').write('\n'.join(sorted(out)))
print('live URLs:', len(out))
PY
```

## Single-Command Cheatsheet (when you do not need the whole pipeline)

```bash
# Subdomains only
$TK/subfinder/subfinder -d example.com -all -silent

# Live URLs only (domain list already available)
pd-httpx -l domains.txt -silent -o alive.txt

# Ports only (single IP, all ports)
nmap -sS -p- --min-rate 1000 -T4 1.2.3.4 -oX runs/nmap-1.2.3.4.xml   # skill active-scan
$TK/naabu/naabu -host 1.2.3.4 -p - -rate 1000 -silent
```

## Division of Labor with Other Skills

| Scenario | Which to use |
| --- | --- |
| Organization name/domain → internet asset surface (including unregistered and same-entity assets) | **`fofa-recon`** (mapping; finds the most) |
| Domain → subdomains → liveness → fingerprint | **this skill** (pipeline, standardized) |
| No contact with the target (purely passive) | `passive-recon` (crt.sh/dig/whois) |
| Large internal network segment mapping | `gogo-intranet` (**do not use this skill against internal networks**) |
| SPA/JS-rendered pages, interface inventories | `browser-automation` / `kimi-webbridge` |
| Live host ports/service versions | `active-scan` (nmap/masscan) |

**Recommended order**: `fofa-recon` lays out the surface (get the full asset picture for the organization) → this skill runs the pipeline per domain (get liveness and fingerprints) → `active-scan` pins versions on key IPs.

## Discipline

1. **Test only targets within the authorized scope**: naabu all-port scans and ksubdomain bruteforce are **active** actions — confirm scope before running them.
2. **Rate limiting**: start at `naabu -rate 1000`; `subfinder` with passive sources and without `-all` is quieter (and consumes less quota).
3. **Wildcards**: `dnsx` filters them; if the results contain many random subdomains pointing at the same IP, the target has wildcard DNS — switch to `-wd` or change the bruteforce wordlist.
4. **API keys (optional enhancement)**: configuring `~/.config/subfinder/provider-config.yaml` lets `subfinder` use
   sources like Shodan/Censys/VirusTotal (**the user must provide keys**, see the `redteam-setup` skill); free sources work without keys.

## Output and Storage (mandatory)

1. **Call `redteam_asset_add` per entry**: `target` (domain/IP), `names` (domain), `ports` (with `url=host`, `title`, `product=server`),
   `provenance=passive` (subfinder/dnsx phase) or `active` (naabu/httpx active probing), `tool` (the specific tool name).
2. **Auto-create /24 C-segments** (`redteam_asset_add` already handles this) → use `redteam_asset_link` to establish
   `resolves` (domain→IP) and `contains` (C-segment→IP) relationships, forming a graph (skill `asset-correlation`).
3. Write key commands/counts into the asset's `test`; when scoring put them into `redteam_score_hit`'s `command`/`result` — no separate chain needed.
   (e.g. `subfinder hit 42 subdomains → dnsx live 31 → naabu 87 open ports → httpx 19 live sites`).
4. **Flag edge assets**: test/staging environments (test/dev/uat/pre/staging), legacy systems, non-standard ports,
   sites on the same C-segment/IP but under a different registered entity — write them into `note`; these are high-priority targets in the asset-triage phase.
5. When reporting conclusions to the commander **give numbers**: subdomain count / live IP count / open port count / live site count / how many of those are high priority.
