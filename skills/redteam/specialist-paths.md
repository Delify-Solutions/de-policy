---
name: specialist-paths
description: 【Planning】Specialist path selection for non-web/non-server assets: AD/identity, VPN/VDI/Exchange, network and security devices, cloud/K8s, IoT/OT, file and backup, AI/Agent; identify the asset type first, then decide which playbook to use, so not every asset falls back to web scanning
whenToUse: When the asset is a centralized control system, boundary device, cloud platform, network device, IoT/OT, file storage, AI/Agent, or when web scanning keeps failing
role: assess
category: Planning
tags: [routing, ad, cloud]
enabled: true
---

# Specialist Asset Path Selection

## Principles

- **Classify first, then pick the path**: the asset type determines entry points, tools, evidence and risk;
- Check the corresponding code and evidence requirements in `score-coverage` before deciding where to invest;
- One asset may have several scoring points, but score only the highest privilege actually obtained;
- Every path must first satisfy authorization, scope and OPSEC constraints; no destructive actions;
- If you cannot get in, write down the blocker and alternative paths clearly; do not pass web-scan results off as specialist results.

## Quick Classification and Entry Points

| Asset form | Confirm first | Typical entry points/clues | Key evidence |
| --- | --- | --- | --- |
| VPN / SSL VPN / VDI / remote access | Product and version, auth method, MFA, public ports | Login portal, client download page, version advisories, config leaks | Screenshot of successful login/admin plane, tunnel actually reachable |
| Exchange / OWA / mail gateway | Version, OWA/ECP, Autodiscover, MAPI | OWA login surface, ECP, version vulnerabilities, credential reuse | Mailbox/admin plane access, mail data proof |
| Firewall / router / switch / network gate | Vendor, model, firmware, management port, SNMP | HTTPS/SSH/Telnet/SNMP management plane, config backups | Device admin page, routing table/ACL, configuration evidence |
| AD / domain controller / SSO / bastion host / endpoint management | Domain name, DC, LDAP, Kerberos, CA, SCCM/Intune | Domain enumeration, auth services, delegation/ACL, certificate services, admin console | Domain admin/node control, policy/certificate/managed-object evidence |
| Cloud platform / object storage / K8s | Cloud vendor, account, IAM, bucket, API Server | Console, AK/SK, metadata, container API, CI/CD | Console privileges, bucket/objects, cluster/node evidence |
| Database / big data | Type, port, auth, source of connection strings | Config leaks, weak passwords, unauthorized access, SQLi, linked server | Successful login, DB/table/data volume, query output |
| File storage / backup / NAS | Protocol, share permissions, anonymous access, backup jobs | SMB/NFS/FTP/object storage/backup management console | Directory/bucket listings, file contents, admin privileges |
| Cameras / printers / access control / IoT | Vendor, management console, default credentials, protocol | Admin page, ONVIF/RTSP, default accounts | Device control page, video/config/attribution proof |
| ICS / SCADA / PLC | Protocol, HMI, engineering station, isolation | Management console, engineering software, exposed protocols | Read-only status/configuration evidence; must not affect production |
| AI / Agent / model platform | Management console, tool invocation, knowledge base, API | Console, API, Agent tool chain, prompt injection | Evidence of operable Agent/knowledge base/model data |
| Supply chain / MSP / ops outsourcing | Relationship evidence, ops channel, cloud services | Supplier entry point, remote ops, CI/CD, shared accounts | User-confirmed scope + evidence of entering the primary defense unit's internal network |

## AD / Identity Specialist Path (high priority)

Proceed as "discover → validate → evidence", never jump straight to destructive actions:

1. Domain/forest/DC/CA/trust relationships and DNS;
2. Accounts, groups, ACLs, delegation, GPOs, service accounts;
3. Auth surface: Kerberos, LDAP, SMB, WinRM, RDP, Exchange;
4. Certificate services/ADCS, SCCM/Intune, vCenter/ESXi and other centralized systems;
5. After obtaining an entry point, first prove "what it can manage", then decide the lateral path;
6. Evidence: domain admin/node/policy/certificate/managed objects + actual operation output.

Prefer finding centralized planes where "one entry point controls a whole area" instead of only scanning single hosts.

## Boundary and Network Device Specialist Path

- First confirm device ownership and whether it is in scope;
- Management plane first: HTTPS/SSH/SNMP/config backups;
- Version, default credentials, config leaks, ACL/routing;
- Proving "the device is controllable" matters more than "the port is open";
- Do not reboot, do not change routes, do not lock admin accounts; back up before any change and record rollback values.

## Cloud / K8s Specialist Path

- Cloud: console/IAM/AK-SK/object storage/metadata/functions/CI-CD;
- K8s: API Server, kubelet, Dashboard, RBAC, Secret, CI/CD;
- Read-only first, prove the privilege boundary;
- Do not delete resources, do not create backdoors, do not export more data than the proof requires.

## Alternative Paths After Failure

- All external web paths fail → pivot to VPN/VDI/Exchange/supply chain/identity surface;
- Cannot get into a single host → look for centralized systems/dual-homed NICs/backups/ops channels;
- Cannot get domain admin from AD → look for indirect paths via ACL/delegation/ADCS/Exchange/SCCM;
- Cannot get the cloud console → look for AK/SK, CI/CD, metadata, object storage;
- All paths fail → write down the failure signals and the resources that should be added; do not rescan repeatedly.

## Output Requirements

Every result must answer:

1. What type of asset is this?
2. From which entry point, what privilege was obtained?
3. What is the evidence (page/command/packet/screenshot)?
4. Is it within the authorized scope?
5. Has it been independently reviewed?
6. Which scoring code does it correspond to, and has it been stored?
