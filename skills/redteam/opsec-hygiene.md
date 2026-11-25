---
name: opsec-hygiene
description: 【Infrastructure】OPSEC and wrap-up — noise budget, account lockout, infrastructure separation, log boundaries, payload/tunnel/account cleanup and pre-delivery checks
whenToUse: When setting the noise level and time box before starting, when a ban/lockout occurs, after a long scan, or before delivery when confirming no entry points were left behind
role: internal
category: Infrastructure
tags: [opsec, cleanup, noise, lockout]
enabled: true
---

# OPSEC and Wrap-Up

> The goal is not "being stealthier" but **not turning the exercise into an incident**: do not lock accounts, do not disrupt business, do not leave uncontrolled entry points, and be able to state exactly what was placed and what was cleaned at delivery.

## Before starting

- Noise budget: requests per second per target, concurrency, brute-force attempts, allowed scan windows;
- Account lockout policy: confirm the threshold/observation window first, then throttle online attempts strictly; stop after 5 failures on the same account;
- Infrastructure separation: C2/scanning/callbacks/proxies must not reuse the target organization's domains or IPs;
- Time box and stop conditions: what triggers an immediate stop (business anomaly, ban, alert, crossing the boundary);
- Record the scope/vendor/cloud services the user confirmed.

## Test data discipline

- Do not write "XX red team test", team/attacker identifiers, fake names/phone numbers/addresses, XSS/popups/messages/comments, or any other data that gains no privilege into the target's business systems;
- Prefer read-only evidence gathering; when a write is truly needed, obtain the user's consent first, use a unique harmless marker, keep it reversible, and register it with `redteam_cleanup`;
- Do not let file/account naming reveal the exercise, and clean up the data you wrote once testing is done.

## During operation

- Read-only first, writes later; back up/record original values before any write;
- WAF/bans: slow down, rotate UA, and change the egress if needed (`cn-proxy-pool` / `egress-ip-rotate`); do not retry endlessly;
- If the same target accumulates more than 3 bans, give up and document the remaining surface;
- Never delete/encrypt/reboot/bulk-change passwords/clear logs;
- Third parties/vendors outside scope: record leads only.

## Cleanup ledger

Register with `redteam_cleanup`:

```text
redteam_cleanup op=add kind=webshell target=... location=/upload/x.jsp
redteam_cleanup op=add kind=account target=... detail=temporary account
redteam_cleanup op=add kind=tunnel target=... location=127.0.0.1:1080
redteam_cleanup op=list status=open
redteam_cleanup op=update id=... status=done
```

Before delivery **open must be 0**, or each item must state kept and the reason (an entry point the user asked to keep).

## Cleanup order

1. Close/delete the tunnels, WebShells, scheduled tasks, and uploaded files you created;
2. Disable/delete temporary accounts and restore the configuration you changed (per the backed-up original values);
3. Shut down local listeners, callback services, and C2 listeners;
4. Purge sensitive data in `runs/` (except evidence the user asked to retain);
5. Do not clean the target's logs; only clean up what you yourself placed on the target.

## Evidence and handoff

- Cleanup records go into `redteam_cleanup`; the report/delivery notes state clearly what was "kept/cleaned";
- Never write credentials/keys into the cleanup detail;
- Handoff report: noise/bans, lockouts, the count of open cleanup items, reasons for anything not cleaned, and retained items that need user confirmation.

## Red lines

- Do not clean target logs, delete target data, or damage business operations;
- Do not treat "cleanup" as "covering tracks"; the exercise records must stay auditable;
- Any entry point the user wants retained must be confirmed in writing and registered as kept.
