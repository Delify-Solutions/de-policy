---
name: dir-bruteforce
description: [Validation] Directory and file bruteforcing: admin panels, backup files, config leaks, source code and VCS exposure (ffuf/feroxbuster/dirsearch/gobuster)
whenToUse: When a Web service is confirmed alive but fingerprints show no direct Nday lead; when hidden paths such as admin panels, backups, configs, source code and upload points must be found
role: vuln-scan
category: Validation
tags: [web, dir, backup]
enabled: true
---

# Directory and file bruteforcing (the workhorse for finding entry points)

**In real engagements most entry points were not reached through a CVE — they were found by directory bruteforcing**: admin panels `/admin`, backups `www.zip`, configs `.env`,
source `.git/`, API docs `swagger-ui.html`, upload points, debug pages, actuator/druid consoles.
This skill covers the four tools already provisioned locally; **do not use only one** — their wordlists and decision logic differ, and they complement each other.

## Local tools

| Tool | Path | Version | Characteristics |
| --- | --- | --- | --- |
| **feroxbuster** | `/usr/bin/feroxbuster` | 2.13.1 | Rust, strongest recursive bruteforcing, follows directory depth automatically, **first choice** |
| **ffuf** | `/usr/bin/ffuf` | 2.1.0-dev | Fastest and most flexible, supports multiple wordlists/vhost/parameter fuzzing |
| **dirsearch** | `$DSH_HOME/redteam/toolkit/dirsearch/dirsearch` | v0.5.0 | Python, complete wordlist, report friendly, ships its own runtime |
| **gobuster** | `/usr/bin/gobuster` | — | Lightweight and stable, dir/dns/vhost three modes |

## 1. feroxbuster (first choice: recursion + automatic filtering)

```bash
feroxbuster -u https://target.example.com \
  -w /usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt \
  -x php,asp,aspx,jsp,html,js,zip,tar.gz,bak,sql,txt,xml,json,config \
  -d 3 -t 30 --rate-limit 80 --timeout 10 \
  --filter-status 404 --filter-size 0 \
  -o runs/ferox-target.txt --json -o runs/ferox-target.json
```

Key points: do not set `-d 3` (recursion depth) too high; let the server breathe via `--rate-limit`; the `-x` extension list must include **backup and config** types.

## 2. ffuf (fastest, multiple wordlists / vhost / parameters)

```bash
# Directories and files (two rounds: directories first, then append extensions to hit directories)
ffuf -u https://target/FUZZ -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt \
  -mc 200,204,301,302,307,401,403,500 -fc 404 -t 40 -rate 80 -timeout 10 \
  -o runs/ffuf-dir.json -of json

# Sensitive files (backups/configs/source/keys)
ffuf -u https://target/FUZZ -w /usr/share/seclists/Discovery/Web-Content/quickhits.txt \
  -mc all -fc 404 -t 40 -o runs/ffuf-quick.json -of json

# vhost discovery (multiple sites on one IP; edge assets often surface here)
ffuf -u https://target/ -H "Host: FUZZ.example.com" \
  -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt \
  -fs 0 -mc all -t 50 -o runs/ffuf-vhost.json -of json
```

## 3. dirsearch (complete wordlist, good for gap-filling)

```bash
$DSH_HOME/redteam/toolkit/dirsearch/dirsearch \
  -u https://target.example.com -e php,asp,aspx,jsp,zip,bak,txt,sql,json \
  --random-agent -t 30 --delay 0.1 --exclude-status 404 \
  -r -R 3 --format json -o runs/dirsearch-target.json
```

## 4. gobuster (lightweight fallback)

```bash
gobuster dir -u https://target -w /usr/share/seclists/Discovery/Web-Content/common.txt \
  -x php,asp,aspx,jsp,zip,bak -t 30 -k -o runs/gobuster-target.txt
```

## Wordlists (already local, prefer these)

| Purpose | Path |
| --- | --- |
| Large directory wordlist | `/usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt` |
| Medium directory wordlist | `/usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt` |
| Common files | `/usr/share/seclists/Discovery/Web-Content/common.txt` |
| Sensitive files (quickhits) | `/usr/share/seclists/Discovery/Web-Content/quickhits.txt` |
| Subdomains (for vhost) | `/usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt` |

Wordlist directories: `/usr/share/seclists`, `/usr/share/wordlists`. **When wordlists are missing**, build a small custom
wordlist from the organization terms already collected in `redteam_credential_list` (brand names, pinyin abbreviations) — a targeted wordlist often has a higher hit rate than a generic large one.

## High-priority targets (follow through once hit)

| Hit | Next step |
| --- | --- |
| `/admin`, `/manage`, `/login`, admin paths | Hand to the account/permission route: default/weak passwords (skill `credential-attack`) |
| `.git/`, `.svn/`, `.env`, `config.php.bak`, `www.zip`, `web.rar` | **Source and config leak**: pull them and look for DB connection strings, keys, hardcoded accounts → `redteam_credential_add` |
| `swagger-ui.html`, `/v2/api-docs`, `/openapi.json` | Extract the full API inventory → unauthenticated and IDOR probing (skill `unauth-exploit`) |
| `actuator`, `druid`, `/console`, `/jmx` | Unauthenticated consoles, often a straight path to RCE or databases |
| Upload points, import, backup restore, template/report design | Hand to the exploitation role to chain a getshell |
| `.ssh/`, `id_rsa`, `*.pem`, `*.jks` | Private key leak → try logging in directly (`ssh -i`) |

## Noise reduction and self-protection

1. **Must filter soft 404s first**: request a non-existent random path first, note the status code and response length, and use them for `--filter-size` / `-fs`.
2. **Rate limiting**: start with `-rate 80` / `--delay 0.1` / `-t 30`; if blocked by a WAF (mass 403/429), drop to 5–10 req/s first.
3. **Do not touch dangerous paths**: `/logout`, `/reboot`, `/shutdown`, `/delete*`, `/reset*` and similar state-changing paths must not be bruteforced;
   exclude them if they appear in the wordlist (they cause business interruption, and the engagement scoring does not credit them).
4. **Abandon the asset after >3 bans** (`redteam_asset_test` status=abandoned + blocked=true), move to the next one.
5. **Route internal targets through tunnels**: feroxbuster `--proxy socks5://127.0.0.1:1080`, ffuf `-x socks5://127.0.0.1:1080`
   (skill `suo5-tunnel`).

## Output and persistence (mandatory)

1. **A hidden path itself is not a scoring item**, but **every path that yields something must be persisted**:
   - Admin panel/upload point/API docs found → record into that asset's `redteam_asset_test` `surface` (append-only), and hand to the next vulnerability discovery/exploitation action;
   - Leaked source/config/keys/credentials → `redteam_credential_add` (`source=config leak`, `tool` carries the path and command, plaintext goes into `secret_value`);
   - Unauthenticated interfaces/consoles → `redteam_vuln_add` directly (`evidence` output + `request`/`response` raw requests).
2. Immediately write back `status`/`test`/`surface` via `redteam_asset_test` after finishing — anyone who does not write status will certainly re-scan later.
3. Wordlists and result files always go into `runs/` (the report must be reproducible).
