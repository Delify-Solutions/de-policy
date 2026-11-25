---
name: asset-deep-scan
description: [Validation] Single-asset deep dive: complete the five checks surface / web / auth / cve / app item by item on one asset, produce candidate vulnerabilities and unverified hypotheses, and avoid batch scanning missing details
whenToUse: When the main session dispatches a vulnerability discovery task for a single asset, or when "scanned a batch" needs to become "understood one asset"
role: vuln-scan
category: Validation
tags: [asset, deep-scan, vulnerability, coverage]
enabled: true
---

# Single-asset deep dive

> Handle only one asset at a time. Batch nuclei/ffuf only produces candidates; this skill requires all five checks finished item by item and written into `redteam_asset`, otherwise you may not close.

## 0. Create the package

```text
redteam_asset op=coverage asset_id=<id>
redteam_asset_next asset_id=<id>
```

First look at the asset's ports/services/versions/URLs/title and the current state of `surface/web/auth/cve/app`. Fill in whatever is missing.

## 1. surface (ports/services/versions/fingerprints)

- Ports, protocols, services, products, versions, banners, URLs, titles;
- Fingerprints: framework/CMS/middleware/language/cloud components;
- Known component version → matching CVE/POC; if the version is unknown, record "cannot confirm" — do not guess.

When done:

```text
redteam_asset op=update asset_id=<id> surface=done
```

## 2. web (paths/interfaces/frontend)

- Root path, robots/sitemap, login/register/upload/export/report;
- APIs in JS, Swagger/OpenAPI, GraphQL, actuator, druid;
- Parameters and objects: `id/userId/tenantId/orderId`, `pageSize`, `export`;
- Directory bruteforce only with a small targeted wordlist; do not burn time on large dictionaries.

When done `web=done`; if there is no Web service, `not_applicable`.

## 3. auth (authentication surface)

- Unauthenticated access: no token/expired token/low-privilege token;
- Default passwords, weak passwords (strict rate limiting, no blind bruteforcing);
- Reuse of existing credentials; only `redteam_access_add` after a successful login;
- Privilege escalation: a normal account reaching admin endpoints, swapping tenant/user ids.

When done `auth=done`; if there is no login surface, `not_applicable`; if locked out/banned, record `blocked` with the reason.

## 4. cve (known vulnerabilities)

- Look up `redteam_poc_search` by component/version, prioritizing P0 RCE/upload/deserialization;
- Confirm with minimal verification; do not go straight to destructive payloads;
- On a hit, write `redteam_vuln_add` (status=candidate/confirmed, with request/response);
- Record unconfirmed items as "unverified hypothesis" — never as confirmed.

When done `cve=done`.

## 5. app (business logic/data interfaces)

- Upload/download/export/batch query/pagination limits;
- IDOR/privilege escalation/mass assignment/amount/order/approval bypass;
- Data interface fields, record counts, whether PII triples are included; at P1 use `redteam_data_proof`;
- Take only the sample needed as proof; do not pull the whole database.

When done `app=done`; if there is no business surface, `not_applicable`.

## 6. Candidates and handoff

For each candidate write:

```text
redteam_vuln_add {
  asset_id, title, severity, target, evidence,
  status: candidate|confirmed,
  request, response
}
```

- For candidates, write "what verification is still missing"; do not turn candidate into confirmed for speed;
- If exploitation needs a chain/credentials/tunnel to verify, write it into `needs` and hand off to `exploit`;
- If exploitation fails, `exploit` must come back requesting a specific `web/auth/app` item be supplemented — do not just switch assets.

## 7. Closing

After all five items are `done/blocked/not_applicable`:

```text
redteam_asset op=close asset_id=<id>
```

If close reports missing items, fill them in; do not skip. The asset is only considered reviewed once close succeeds.

## Discipline

- One asset at a time; do not batch-scan dozens of assets in the same task;
- Do not write "XX red team test", team identifiers, fake identities, XSS/popups/guestbook messages, or any data that cannot yield access;
- Do not treat "scanned" as "understood"; candidates without evidence stay candidate;
- Do not delete/encrypt/restart/bulk-change passwords/clear logs.
