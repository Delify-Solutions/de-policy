---
name: nuclei-scan
description: 【Validation】nuclei templated vulnerability scanning: 13,000+ templates covering CVE/exposure/misconfiguration/default credentials, the primary detection method for Nday and 1day
whenToUse: After obtaining the live asset list in the vulnerability discovery phase, to run Nday/1day batch detection; or when a component version is known and you want to quickly confirm whether a ready-made template exists
role: vuln-scan
category: Validation
tags: [vuln, nuclei, template]
enabled: true
---

# nuclei (Templated Vulnerability Detection)

> Priority: **RCE/upload/deserialization/middleware templates first (P0, they get you into the internal network)**, then unauthorized-access/data-interface templates (P1); do not fill the budget with low-severity templates.

`nuclei` is the **workhorse** of the vulnerability discovery phase: run it only against **T0/T1** assets; T2 needs user confirmation, T3 is off-limits. One command covers CVEs, exposures, misconfigurations, default credentials, unauthorized access.
The local template library is in place (paths below) — **do not go online looking for POCs again**.

## Local Binary and Templates

| Item | Value |
| --- | --- |
| Binary | `/usr/bin/nuclei` (v3.11.1) |
| Template library | `~/.local/nuclei-templates` (**13,742 templates**) |
| Template version | v10.4.9 (updated 2026-09-18) |
| Config | `~/.config/nuclei/config.yaml`, `.templates-config.json` |

Template distribution (cite by class when writing reports): `http/` 11,364 (of which `http/cves` 4,320, `http/misconfiguration` 981,
`http/vulnerabilities` 961, `http/exposures` 707, `http/default-logins` 307), `cloud/` 663, `file/` 447,
`network/` 282, `dast/` 251.

**Update templates**: `nuclei -update-templates` (no more than once a week; after updating run `-tl` first to confirm nothing broke).

## Basic Usage

```bash
# 1) Quick single-target health check (see what would match first, without actually firing)
nuclei -u https://target.example.com -severity critical,high,medium -rl 30 -c 15

# 2) Batch: live URL list exported from the asset database
nuclei -l runs/alive-urls.txt -severity critical,high -rl 50 -c 25 \
  -jsonl -o runs/nuclei-$(date +%m%d-%H%M).jsonl

# 3) Specific templates (known component version → precise strike, higher hit rate, less noise)
nuclei -u http://target:8080 -t http/cves/2021/CVE-2021-44228.yaml
nuclei -u http://target -t http/exposures/ -t http/default-logins/

# 4) Batch by tags
nuclei -l runs/alive-urls.txt -tags seeyon,weaver,panel,exposure -rl 20

# 5) Only list the templates that would run (send nothing, evaluate coverage first)
nuclei -l runs/alive-urls.txt -tags cve -tl
```

## Key Parameters (common in this scenario)

| Parameter | Purpose | Recommendation |
| --- | --- | --- |
| `-rl` | Max requests per second | 30–50 on the internet side; drop to 5 once a WAF notices you |
| `-c` | Concurrent templates | 15–25; too high will knock over small sites |
| `-severity` | Run only the given levels | Exercises only care about `critical,high` (medium/low score nothing) |
| `-tags` / `-t` | Template filtering | Prefer when you have fingerprint clues; do not blast everything |
| `-jsonl -o` | Structured output | **must land in `runs/`**, the report cites it |
| `-proxy` | Go through a proxy | Use `cn-proxy-pool` for noise reduction; **for internal targets go through the suo5 tunnel and add `-proxy socks5://127.0.0.1:1080`** |
| `-H` | Custom headers | Carry Cookie/Token to test post-login functionality |
| `-duc` | Disable template update checks | Saves time on batch runs |
| `-stats -si 30` | Progress output | Watch progress on long jobs |

## Working with the Knowledge Base (search before firing; no duplicate work)

Before starting, run `redteam_poc_search` (by CVE / component / version / body signature) — it queries two layers at once: **the local POC knowledge base + the local nuclei template library**.
On a hit use `redteam_poc_get` to fetch the full text or directly `nuclei -t <template>`; only when both layers miss do you search online, and hand-crafting comes last.

Backfill validated new templates/EXPs into the knowledge base with `redteam_poc_add` (with `category` + `engagement` + `asset_target` + `verified` + `verified_note`, scrubbing this target's identifying information).

## Noise Reduction and Self-Protection (important)

1. **The default ignore file already excludes dangerous tags**: `~/.config/nuclei/.nuclei-ignore` ignores `dos`, `local`, `fuzz`, `bruteforce`, `txt-service` by default —
   **do not remove these ignores "to test more thoroughly"**; DoS templates will kill production systems and destroy the exercise outright.
2. **Probe before firing**: run a `-severity critical,high` pass first; only after hits do you go deeper on specific findings — never full-blast from the start.
3. **WAF/ban handling**: when blocked, first drop `-rl` to 5 and add `--delay 1s`, rotate the UA (`-H "User-Agent: ..."`),
   and if necessary use the `cn-proxy-pool` skill to change egress; **if the same target bans you >3 times cumulative, abandon it immediately** (`redteam_asset_test` status=abandoned + blocked=true) and move to the next target.
4. **Avoid business peak hours on production systems**: templates that act like scheduled/batch jobs (e.g. triggering a sync or index rebuild) must be validated on test/staging assets first.

## Output and Storage (mandatory)

Store immediately after the run, **do not accumulate until the end**:

1. Read `runs/nuclei-*.jsonl` and call `redteam_vuln_add` for each entry:
   - `title` (template name + match point), `severity`, `cve` (the template's `classification.cve-id`), `target` (**with port**),
     `evidence` (match output/response characteristics/matched-at), `confidence=confirmed` (a nuclei hit means confirmed at the response level),
     `gained` (what it can get you), `agent=vuln-scan`.
2. When confirming a vulnerability, put the full request/response into `redteam_vuln_add`'s `request`/`response` (HTTP evidence is stored automatically); when scoring, put the actual command/output into `redteam_score_hit`'s `command`/`result`.
4. Right after testing an asset, write back with `redteam_asset_test`: `status` (testing/tested/no_surface/blocked), `test` (appended conclusions), `surface` (what is still testable).
5. **Record only score-relevant surface**: information leaks, version exposure, CORS/CSRF, SSL and response-header issues unrelated to scoring get **at most a one-line exclusion note** — do not dig deeper, do not re-run.

## Common Pitfalls

| Symptom | Cause | Handling |
| --- | --- | --- |
| Zero hits | The target is not HTTP, or templates were ignored | Add `-tl` to see which templates actually ran; confirm protocol `-t http/` vs `network/` |
| Lots of `could not resolve` | Dead links in the URL list | Filter liveness first with `pd-httpx`: `pd-httpx -l all.txt -o alive-urls.txt -silent` |
| A pile of low/info hits | severity not limited | Add `-severity critical,high,medium` for exercises |
| Target knocked offline | Concurrency too high / a dos template ran | Lower `-rl`/`-c`; confirm the ignore file was not modified |
| Internal targets unreachable | Not going through a tunnel | Add `-proxy socks5://127.0.0.1:<suo5 port>` (skill `suo5-tunnel`) |
