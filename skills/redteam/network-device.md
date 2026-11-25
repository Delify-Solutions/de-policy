---
name: network-device
description: 【Internal】Network and boundary devices: SNMP, default credentials, configuration and routing-table forensics on VPNs/firewalls/routers/switches/network gates (netdev scoring)
whenToUse: When the asset is a VPN/firewall/router/switch/network gate/bastion host, or when you need to read routes/policies/cross-zone paths from network devices
role: internal
category: Internal
tags: [network, snmp, vpn, netdev]
enabled: true
---

# Network Devices / Boundary Devices

> Network devices are high-value targets for **boundary breaches and lateral pivots**, but they are also the easiest to "break with one change": read-only first, back up first, no reload/erase/reboot.

## Prerequisites and Tools

| Tool | Purpose |
| --- | --- |
| `snmpwalk` / `onesixtyone` | SNMP v1/v2c/v3 enumeration |
| `ssh` / `telnet` / `nc` | Management plane login and port verification |
| `nuclei` | Vendor CVE / default credential templates |
| `curl` | Web management plane, VPN portal |
| Vendor CLI | `show running-config` / `show route` / `show arp` |

When a tool is missing confirm with `command -v`; if the vendor MIB is missing, record the OID and output — do not guess.

## Identification and Read-only Enumeration

```bash
# SNMP v2c (try read-only communities first; never do a set)
snmpwalk -v2c -c public <ip> 1.3.6.1.2.1.1
snmpwalk -v2c -c public <ip> 1.3.6.1.2.1.4.20   # IP address table
snmpwalk -v2c -c public <ip> 1.3.6.1.2.1.4.21   # routing table

# Management plane
curl -k -I https://<ip>/
nc -nv <ip> 22
```

- Focus on: device model/firmware, management port exposure, default credentials, SNMP writability, VPN portal, HA pair, routing table/policy, cross-zone interfaces;
- First determine whether it is a **boundary device** or an ordinary internal device; a boundary device's routing table/policy is part of `boundary-*` evidence.

## Common Paths

1. **Default/weak-credential management plane**: try only vendor defaults and a small targeted dictionary; after logging in look at read-only pages first, record model/version/privilege;
2. **SNMP**: read the routing table, ARP, interfaces, CPU/memory; if the community is writable, **do not change configuration** — only record the fact that it is writable;
3. **Web management plane CVEs**: use `nuclei` vendor templates or `redteam_poc_search`; verify existence first, do not exploit directly;
4. **Config/backup leaks**: look for `config.bin`, `running-config`, VPN configuration files; before downloading confirm they contain no unrelated third-party data;
5. **Routing/policy forensics**: `show ip route`, `show running-config`, `show arp`, NAT/ACL; save screenshots/text under `runs/`.

## Evidence and Scoring

- Assets: `redteam_asset_add` (vendor/product/version, management port, web title);
- Credentials: `redteam_credential_add` (source=default credential/SNMP/config leak);
- Scoring: `netdev` 100 for ordinary / 200 for administrator; redirection/business hijacking +200, implanting remote control +1000 scored separately;
- Boundary: record `boundary-*` only when crossing an isolation zone; within the same zone record only `internal`;
- Evidence: routing table/policy/connection-count screenshots (G7); put commands into `score_hit`'s `command`/`result`.

## OPSEC and Boundaries

- Do not change routes/ACLs/NAT, do not reload, do not erase, do not upgrade firmware; when a change is unavoidable, back up first and record the original values;
- Do not scan management ports in bulk, to avoid triggering lockouts/alerts;
- Configurations may contain third-party credentials/keys: take only the fragments needed for proof and store them desensitized;
- Clean up files/temporary accounts you uploaded and register `redteam_cleanup`.

## Handover

Report: device type/model/firmware, management privileges, key routing/policy points, cross-zone paths, interfaces usable as pivots, blockers not yet broken through; in `needs` state clearly the missing MIBs/accounts/authorization.
