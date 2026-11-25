---
name: redteam-setup
description: 【Infrastructure】First-run onboarding — confirm whether FOFA_KEY, the VPS login method, and the DeepSeek API Key have been provided, and report the gaps from preflight; does not provide tool downloads, install links, or tutorials, tools are prepared by the user
whenToUse: The first time the user enters red-team mode; or when redteam_preflight reports onboarding.incomplete or missing environment variables/resources
role: plan
category: Infrastructure
tags: [setup, env]
enabled: true
---

# First-Run Onboarding

> **This plugin does not provide tool downloads, installation links, or installation tutorials**. Tools are prepared by the user; `redteam_preflight` only reports what is missing — it does not download, install, or hand out acquisition addresses.

## Triggers

- `redteam_preflight` returns `onboarding.complete=false`;
- `FOFA_KEY`, the VPS login method, or the DeepSeek API Key is missing;
- The user explicitly says "the environment is not set up".

## What the user must provide

| What | Purpose | Where it goes |
| --- | --- | --- |
| `FOFA_KEY` | Asset mapping; without it, edge/unregistered assets are missed | Environment variable `FOFA_KEY` or `$DSH_HOME/.env` |
| VPS login method | Reverse shell, payload delivery, tunnel relay | `REDTEAM_VPS_HOST` (`user@host`), `REDTEAM_VPS_KEY` (private key path) |
| `DEEPSEEK_API_KEY` (optional) | Public intelligence search / web page fetching | Environment variable `DEEPSEEK_API_KEY` |
| Other mapping platform keys (optional) | Multi-source asset cross-validation | The corresponding environment variable |

List everything at once and wait for the user to fill it in; do not drip-feed questions one at a time.

## Verification

```bash
# Only checks whether the variables exist; does not print values
for k in FOFA_KEY DEEPSEEK_API_KEY REDTEAM_VPS_HOST REDTEAM_VPS_KEY; do
  [ -n "$(printenv "$k")" ] && echo "$k=set" || echo "$k=missing"
done
```

- Run `redteam_preflight` once more and confirm `onboarding.complete=true`;
- Do not provide tool installation commands, download addresses, or tutorials; when a tool is missing, only write `needs` and let the user prepare it;
- Never output keys/private keys in commands, reports, or evidence.

## Degradation

- No `FOFA_KEY`: passive collection / public intelligence only; asset coverage will drop;
- No VPS: do not dispatch tasks that need a reverse shell or tunnel relay;
- No DeepSeek Key: `deepseek-web-intel` is unavailable; other skills are unaffected;
- Missing tools: mark the corresponding skill unavailable; do not pretend it can run.
