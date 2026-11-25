---
name: c2-infra
description: 【Tunnel】C2 and redirector infrastructure: Sliver/Havoc/ligolo-ng, redirectors, multi-hop tunnels, payload delivery and OPSEC (long-haul control)
whenToUse: When you need long-term stable control, the target can only egress HTTP/HTTPS, a single suo5/chisel channel is not enough, or you must cross multiple internal network tiers
role: internal
category: Tunnel
tags: [c2, redirector, ligolo, long-haul]
enabled: true
---

# C2 / Redirector / Multi-hop Tunnels

> C2 binaries and traffic have obvious signatures and easily trigger EDR/NDR. Use only in authorized exercises; prefer reusing existing suo5/chisel/frp instead of reaching for C2 first.

## Selection

| Scenario | First choice | Alternative |
| --- | --- | --- |
| Already have a WebShell, only need SOCKS5 | `suo5-tunnel` | Neo-ReGeorg |
| Only command execution, HTTP egress | `chisel-tunnel` | Sliver HTTP |
| Long-term stability, port mapping for the user | `frp-tunnel` | Sliver + redirector |
| TUN layer / multi-tier internal network | `ligolo-ng` | chisel + multi-hop |
| Need session management / multiple beacons | Sliver / Havoc | Commercial C2 (requires authorization/procurement) |

- Obtain tools from official Releases and verify checksums; never run `curl|bash`;
- Record server/client versions, listening ports, certificates/domains, and the redirect chain.

## Redirection and Egress

- **Domain fronting/CDN**: only when authorized and permitted by the provider's terms; record domains and certificates;
- **Redirector**: nginx/HAProxy on the VPS forwards only C2 traffic to hide the real server; do not let the redirector be directly identifiable;
- **Egress ports**: prefer 443/80/8443; HTTP/WebSocket punches through more easily than raw TCP;
- **Multi-hop**: open only the necessary ports at each hop, record parent/child relationships, avoid single points of failure.

## Payloads and Delivery

- Prefer fileless/in-memory execution; staged files go into `runs/` with hashes recorded;
- Do not install services/drivers/kernel modules on the target unless the task requires it and it can be rolled back;
- Deliver payloads through existing WebShell/vulnerability/scheduled task; do not build separate phishing infrastructure (unless authorized);
- For every payload record: target, path, hash, persistence method, cleanup method (`redteam_cleanup`).

## Sessions and Evidence

- Tunnels/sessions: `redteam_tunnel_add` (kind/listen/entry/reach/entry_kind/command); `redteam_session_check` with `probe_targets` to actually test the internal network;
- Access: `redteam_access_add`; credentials: `redteam_credential_add`;
- Scoring: `internal`/`boundary-*`; put commands into `score_hit`'s `command`/`result`;
- Run session_check before and after long-running tasks; if a session drops, fix it first before continuing.

## OPSEC

- Separate the C2 server from the target organization's infrastructure; do not reuse the target's domains/certificates;
- Control beacon interval, jitter, and working hour windows; avoid on-the-hour/high-frequency patterns;
- Do not leave obvious commands in target logs; do not clear target logs;
- At the end of the exercise, shut down listeners, delete payloads/accounts, and file the cleanup ledger.

## Handover

Report: C2 type/version, listeners and redirect chain, session count, reachable network segments, persistence and cleanup status; in `needs` state clearly the missing domains/certificates/VPS/authorization.
