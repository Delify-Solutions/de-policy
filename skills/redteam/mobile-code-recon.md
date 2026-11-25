---
name: mobile-code-recon
description: 【Recon】Mobile and code-leak reconnaissance: extract APIs and keys from APK/IPA/mini-programs, GitHub/Gitee/GitLab code leaks, frontend SourceMaps (public clues only)
whenToUse: When the target has an APP/mini-program/H5, or you need to find interfaces, keys, and internal addresses from public code repositories/frontend bundles
role: recon
category: Recon
tags: [mobile, apk, code-leak, api]
enabled: true
---

# Mobile / Code-Leak Reconnaissance

> Use only publicly obtainable installers/repositories/frontend assets; do not crack, do not pirate, do not touch third-party code unrelated to the target. When a key is found, record it first — do not use it directly.

## Prerequisites and Tools

| Tool | Purpose |
| --- | --- |
| `jadx` / `apktool` | APK decompilation, resources/Manifest |
| `MobSF` (optional) | Static/dynamic analysis |
| `gitleaks` / `git-secrets` | Repository secret scanning |
| `curl` / `browser-automation` | Frontend JS/SourceMap, mini-program packages |
| `fofa-recon` / `deepseek-web-intel` | Public assets and intelligence |

## Android / iOS

```bash
# APK: look at Manifest, strings, assets, native libs first
jadx -d runs/apk-<name> app.apk
apktool d app.apk -o runs/apk-<name>-smali
grep -RInE 'https?://|api[_-]?key|secret|token|access[_-]?key' runs/apk-<name> | head -100
```

- Focus on: API base URL, internal addresses, AK/SK, push/map/payment keys, WebView entry points, certificate pinning;
- iOS: `class-dump`/`strings`/`plutil` to inspect Mach-O and Info.plist; do not perform jailbroken-device operations;
- Mini-programs: extract `app-service.js`, `wx.config`, and request domains from the cache/package; grab public packages only.

## Code Leaks

- GitHub/Gitee/GitLab searches: organization name, domain, project name, `internal`, `jdbc:`, `AKID`, `password`;
- Focus: CI configuration (`.gitlab-ci.yml`, `Jenkinsfile`), `.env`, `config.*`, `docker-compose`, test scripts;
- For matched keys record only the source and a screenshot; do not log in directly; when validation is needed, run `redteam_scope_check` first and go through user confirmation.

## Frontend / SourceMap

- In JS look for `baseURL`, `/api/`, `/v2/`, `/internal/`, WebSocket;
- Restore source from `.map` files to find interfaces and hardcoded keys;
- Write results into the asset's `test`/`surface`, save the interface list under `runs/`.

## Evidence and Storage

- Assets: `redteam_asset_add` / `redteam_batch kind=assets` (APP backend domains/IPs, mini-program APIs);
- Clues: write interfaces/keys/internal addresses into `redteam_asset_test`'s `surface`;
- Attribution: ICP/certificate/footer/organization name, per `asset-correlation`;
- Do not write keys in plaintext into reports/sessions; store them per credential conventions.

## OPSEC and Boundaries

- Download only public packages/public repositories; do not crack paid applications, do not steal third-party code;
- Do not send unauthorized bulk requests against production APIs; run scope check before validation;
- Third-party code/supplier assets outside scope: record clues only;
- Do not treat individual developer repositories as target assets unless attribution can be proven.

## Handover

Report: APP/mini-program entry points, API base, types of leaked keys (no plaintext), usable interfaces, attribution evidence, uncovered platforms; in `needs` state clearly the missing tools/authorization.
