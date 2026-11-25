---
name: supply-chain
description: 【Internal】Supply chain and CI/CD channels — Jenkins/GitLab/Nexus/Artifactory, CI tokens, dependency confusion, vendor VPN/operations channels (boundary-supply)
whenToUse: When Jenkins/GitLab/Nexus/Artifactory, a CI token, or a vendor operations entry point is found, or when you suspect the main defended organization's internal network can be reached through a third-party channel
role: exploit
category: Internal
tags: [supply-chain, ci, vendor, boundary]
enabled: true
---

# Supply Chain / CI-CD Channels

> Supply chain is a **boundary-breach** path, not ordinary web foothold work: the user must confirm the vendor/cloud service is within the authorized scope; reaching only the vendor's internal network does not count — you must prove entry into the **main defended organization's** internal network.

## Prerequisites and tools

| Tool | Purpose |
| --- | --- |
| `curl` / `jq` | Jenkins/GitLab/Nexus/Artifactory API |
| `nuclei` | CI/artifact repository/middleware templates |
| `gitleaks` / `git-secrets` | Secrets in repositories/build logs |
| `redteam_scope_check` | Whether the vendor domain/segment is in scope |
| `redteam_pivot_probe` | Live test of the vendor channel into the main defended internal network |

## Identification

- Jenkins: `/script`, `/manage`, `/computer`, anonymous read, default credentials, credentials in build logs;
- GitLab: open registration, public projects, CI/CD variables, Runner token, personal access token;
- Nexus/Artifactory: anonymous browsing, default credentials, upload/overwrite permissions, dependency confusion;
- Vendor channels: VPN, remote operations platform, frp/reverse proxy, bastion host, dedicated line;
- What a CI token can do: pull code, modify pipelines, publish artifacts, read Secrets, deploy to production.

## Verification order

1. Read-only confirmation: version, anonymous access, current permissions, visible projects/builds;
2. Find credentials: build logs, environment variables, config files, Git history;
3. Prove impact: can read source/Secrets, can modify builds, can deploy to the target environment (minimal verification only);
4. Reach the main defended internal network through the vendor channel: use `redteam_pivot_probe` to actually test the target IP:port and keep the response;
5. Do not poison production dependencies or break builds; verify dependency confusion only when authorized and reversible.

## Scoring and evidence

- `boundary-supply`: user-confirmed scope + evidence of entry into the main defended organization's internal network (`scope_confirmed=true`, the four boundary questions);
- CI server/artifact repository: `server-host` (normal/administrator);
- Source code/keys/data obtained: score under `web-app`/`db-credential`/`file-storage` plus G2;
- Evidence: `redteam_vuln_add` + `request`/`response`; `redteam_access_add`; do not call `redteam_chain_add` separately any more — put the command into `command`/`result` of `score_hit`.

## OPSEC and boundaries

- Get the user's written confirmation for the vendor/cloud service first; without confirmation, only record leads;
- Do not modify production pipelines, publish malicious artifacts, or overwrite dependencies;
- Read build logs/Secrets only, and export the minimal sample;
- Store vendor-side accounts/keys according to the credential policy; never put them on the command line;
- Clean up uploaded artifacts/temporary accounts (`redteam_cleanup`).

## Handoff

Report: entry point, permissions, what can be read, the path into the main defended internal network with live-test evidence, and unconfirmed scope; write the needed user confirmation/vendor authorization into `needs`.
