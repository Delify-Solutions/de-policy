---
name: api-data-exfil
description: [Validation] API data exfiltration and IDOR: OpenAPI/GraphQL/JS endpoints, IDOR/privilege escalation, export/pagination endpoints, structured proof of sensitive data (name + national ID + phone) at ≥10,000 records
whenToUse: When a Web/APP/miniprogram backend, Swagger/OpenAPI/GraphQL, or authenticated or unauthenticated endpoints are found and bulk export of names/ID numbers/phone numbers is suspected
role: exploit
category: Validation
tags: [api, idor, pii, data]
enabled: true
---

# API Data Exfiltration and Privilege Escalation

> This is the P1 main line: **first prove that sensitive data such as the three-element identity set is reachable at ≥10,000 records**, then discuss everything else. Take only the sample needed for proof, do not bulk-dump the whole database; do not perform destructive operations such as deletion or password changes.

## Prerequisites and tools

| Tool | Purpose |
| --- | --- |
| `browser-automation` / `kimi-webbridge` | Capture JS, endpoints, login state |
| `curl` / Burp / Yakit | Replay, modify parameters, inspect responses |
| `ffuf` | Endpoint/parameter enumeration (rate-limited) |
| `redteam_data_proof` | Structured proof of fields/row count/samples/source |
| `redteam_credential_list` / `redteam_access_list` | Existing accounts and Cookie/Token |

## Endpoint discovery

1. Extract paths from JS (axios/fetch, webpack chunks, SourceMap);
2. `swagger-ui.html`, `v2/api-docs`, `openapi.json`, `graphql`, `actuator`, `druid`;
3. Miniprogram/APP traffic capture, H5 routes, export/report/batch-query entry points;
4. Watch these parameters: `userId`, `tenantId`, `orderId`, `pageSize`, `export`, `download`, `fields`.

## Validation order

1. **Unauthorized**: request without a token / with an expired token / with a low-privilege token; returned data is the proof;
2. **Privilege escalation**: swap `userId`/`tenantId`, or access admin endpoints with a normal account;
3. **Bulk export**: raise `pageSize`/`limit`, or find `export`/`download`/`report` endpoints;
4. **Database/backup**: exposed DB, backup files, ES indices; read-only first.
5. **Proof threshold**: fields include name/ID number/phone number and other three-element data, actually exportable at ≥10,000 rows; below 10,000 record it as ordinary data and do not force a P1.

## Evidence and scoring

- Vulnerability: `redteam_vuln_add` (title/severity/target/evidence/status=confirmed; `request`/`response` automatically stores HTTP evidence);
- Data proof:
  ```text
  redteam_data_proof op=add
    target=... source=api interface=/api/users
    fields=["name","national_id","phone"] row_count=12000
    sample="Zhang* / 110*** / 138****"
    query="GET /api/users?pageSize=1000&page=1"
    evidence_ref="runs/api-users-12000.jsonl"
  ```
- Scoring: `web-app` (account/backend), `db-credential` (database), data counted per G2; write commands/requests into the `command`/`result` of `score_hit`;
- The report cites the data_proof row count and fields; do not write empty phrases like "database dumped".

## OPSEC and boundaries

- Rate-limit; small pages first, then larger pages; do not pull the whole database in one shot;
- Do not export fields unrelated to the proof; redact samples;
- Do not modify/delete business data; write operations only as the minimal verifiable, rollback-able test;
- Third-party/supplier data outside the authorized scope is recorded as leads only.

## Handoff

Report back: endpoint/parameters, authorization method, fields, actual row count, sample path, what privileges are obtainable; in `needs` state the missing accounts/Tokens/scope clearly.
