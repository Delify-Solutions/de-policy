---
name: campaign-planning
description: [Planning] Red team campaign planning: turn a "target name" into objectives, a scope whitelist, attack hypotheses, time boxes, noise budget, stop conditions and a cleanup plan; fix the approach before acting, instead of mechanically scanning a score checklist
whenToUse: When starting a new target, advancing a phase, facing repeated failures, or when the next path to take must be decided
role: plan
category: Planning
tags: [planning, hypothesis, scope]
enabled: true
---

# Red team campaign planning (define objectives first, then act)

## Why this is needed

Unplanned "scan + find vulnerabilities" degenerates into three things: repeated hits, excessive noise, and only picking the easy-to-score bugs.
A real red team answers first: **for what, where to hit, how to hit, when to stop, how to prove it, how to wrap up**.

## 1. The 7 things that must be produced before starting

1. **Objectives and success criteria**
   - Scoring objectives: current score, remaining high-value points, phases that must be taken;
   - Business objectives (if provided by the user): core systems, data, domain controller/cloud control plane;
   - Write success criteria as verifiable outcomes, not "hit as much as possible".

2. **Scope whitelist**
   - Domains, IP/CIDR, cloud accounts, vendors/subsidiaries, time window;
   - Only attack assets inside the whitelist; assets outside the scope are recorded as clues only, with no active probing;
   - Vendors/third parties/cloud services require explicit user confirmation; never assume "same organization" by default.
   - **Asset grading**: T0 direct ownership / T1 strongly related (needs evidence) / T2 weakly related (same C-segment, neighbor site, same favicon, shared hosting, vendor, etc.) / T3 unrelated; request T2 only after T0/T1 are exhausted, T3 is off limits.
   - **Exhaustion standard**: RCE/intranet entry, data interfaces/databases, and credential reuse paths have all been tried and failures/blockers recorded — not just "ports scanned".

3. **Asset type inventory**
   - Classify as `Web / server / database / identity and AD / boundary device / network device / cloud and K8s / IoT/OT / files and backups / AI/Agent / supply chain`;
   - For each class answer at least: where is the entry point, who can reach it, what evidence exists now, what score is most likely obtainable.

4. **Attack hypotheses (multiple paths)**
   - Write at least 2–3 mutually independent initial access paths;
   - For each path write: entry → required conditions → expected evidence → failure signal → alternative path;
   - Do not stake all resources on a single Nday or a single admin-panel weak password.

5. **Time boxes and budget**
   - Maximum duration, request volume, concurrency per phase/asset class;
   - State explicitly "when to abandon this path" to avoid endless bruteforcing/retries;
   - Prioritize high-score paths with clear evidence requirements, but do not hammer accounts on one service to pad the score.

6. **OPSEC and stop conditions**
   - Scan rate, source IP/egress, User-Agent, tool fingerprints, account lockout risk;
   - Which actions trigger EDR/IDS/honeypots/bans;
   - Stop immediately when: account locked out, target business anomaly, explicit ban, collateral damage to non-targets, or the user asks to stop;
   - No destructive actions; back up and keep rollback values before config changes.

7. **Verification and delivery**
   - High-value results must be **independently re-verified**: a different command, a fresh login, another agent reproducing it;
   - Mark evidence status as `self` (self-tested) or `verified` (re-verified); the report treats only verified as strong conclusions;
   - Reproduction material: commands/Yakit request dumps/screenshots/attack file paths;
   - Wrap-up: clean temporary files/sessions/tunnels, keep necessary evidence, do not clear target logs.

## 2. Campaign rhythm

```text
Intelligence and scope → asset classification → attack hypotheses → small-step verification → expand results → independent re-verification → delivery/cleanup
```

- At the end of each phase, review persisted records and evidence before deciding the next phase;
- Failed paths must record "why it failed and what is still missing"; do not silently switch targets;
- Newly discovered dual-NIC hosts/cloud credentials/AD paths go back to the planning layer for re-prioritization.

## 3. Coordination with existing tools/skills

- `redteam_preflight`: resource and skill availability;
- `redteam_score_list` / `redteam_asset_stats` / `redteam_sessions`: current facts;
- `redteam_asset_query` / `redteam_vuln_query`: avoid duplication;
- `redteam_score_hit`'s `command`/`result`: record "hypothesis → action → result" together with the score; no separate chain write-up needed;
- `specialist-paths`: when the asset is not Web/server, switch the approach by type;
- `score-coverage`: map the approach to scoring points;
- `deepseek-web-intel`: public intelligence search and page text extraction;
- `browser-automation` / `kimi-webbridge`: when real login/interactive verification is needed.

## 4. Common mistakes

- Only pushing on easy-to-scan Web assets while ignoring VPN/VDI/Exchange/AD/cloud;
- Retrying one entry point over and over without recording the failure reason;
- Hammering multiple accounts on the same service for score (the service already scored; no points);
- No stop conditions — scanning until banned;
- Treating self-testing as the result, with no independent re-verification;
- A report with only scores, no objectives, impact, cleanup and uncovered items.
