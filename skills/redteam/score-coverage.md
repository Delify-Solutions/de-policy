---
name: score-coverage
description: 【Scoring】Identification, path selection and evidence requirements for the 25 score-point categories; network devices, cloud, IoT, industrial internet, security devices, file storage, models/compute, domain names, terminals and boundary breaches beyond servers/web/databases are all chosen from here
whenToUse: When the asset is not an ordinary server/web app/database, or when you need to decide "which code this device/platform can score, and where to hit first"
role: exploit
category: Scoring
tags: [score, routing, evidence]
enabled: true
---

# Score-Point Coverage and Path Selection

> First run `redteam_score_list` to get the actual codes/caps/tiers for the current target, and read the `evidence_need` (judgment standard) and `evidence_proof` (self-justifying material) returned for each entry; this skill only covers "how to identify, what to hit first, what evidence is needed" and does not replace what the tools return.
> Principle: **compute value ÷ effort first**, then decide which entry to hit; server privileges are a springboard into the internal network, not the only goal.

## 0. Quick classification table

| What the asset looks like | Preferred code | First entry point | Key evidence |
| --- | --- | --- | --- |
| Domain registration/DNS/subdomain takeover | `domain-control` | Registrar, DNS provider, subdomain CNAME | Domain console screenshot, resolution records, WHOIS |
| Camera/printer/WiFi/PC/phone/large display | `terminal-access` | Default credentials, admin console, MDM | Proof of device ownership (page/asset tag/organization name) |
| Linux/Windows host, WebShell | `server-host` | RCE/upload/weak password/privesc | Command output, WebShell connection, privileges |
| MySQL/Redis/MSSQL/ES/Mongo | `db-credential` | Unauthorized access, weak password, SQLi | Successful connection, databases/tables, data volume |
| OA/mail/ERP/business backend | `web-app` | Login surface, default credentials, IDOR | Successful browser login, backend page, account tier |

> **Account-type red line**: `web-app` / `central-system` scoring must carry `access_id` (a real login session from `redteam_access_add`); merely detecting an unauthorized API, finding data in a response, or obtaining credentials alone does not count as account privileges — score it as a vulnerability or `data_proof`, not as account points.
| Bastion host/domain controller/SSO/endpoint management | `central-system` | Admin console, credential reuse | Administrator page, 20% of managed nodes (20 hosts max) |
| Hadoop/Hive/Spark/ES/Kafka | `bigdata-system` | Management side, unauthorized API | Administrator privileges, data volume ≥500 million records/1TB |
| VPN/firewall/router/switch/gateway isolation device | `netdev` | Management port, default credentials, SNMP, CVE | Routing table/connection-count screenshot; redirection +200, implant +1000 |
| SCADA/HMI/PLC/connected vehicles/smart manufacturing | `iiot` | Admin console, exposed industrial protocols | Administrator console, number of managed devices |
| K8S/OpenShift/cloud console/AK-SK | `cloud-platform` | API Server, console, metadata | Proof of administrator operations; nodes <100 scored as web-app |
| Camera/access control/IoT management platform | `iot-platform` | Platform backend, default credentials, API | Platform control, connection count; entry into the core network +5000 |
| WAF/IPS/IDS/audit devices | `secdev` | Management port, default credentials, CVE | Administrator privileges (non-centralized class) |
| FTP/NAS/OSS/enterprise cloud drive | `file-storage` | Account/AK-SK, default credentials (anonymous does not count as privilege) | Successful login/invocation, account tier |
| Model agent/skill/Agent platform | `ai-agent` | Management side, prompt injection, tool abuse | Evidence of operable agent, depth of control |
| Jupyter/Kubeflow/MLflow/Ray/knowledge base | `model-compute` | Unauthorized access, weak password, API | System administrator privileges; knowledge base/huge data ×2 |
| Model weights/training data/inference service | `model-data` | Management side, object storage, API | Administrator privileges; doubled without a knowledge base |
| Compute platform/GPU pool | `computepower-admin` / `computepower-cards` | Platform backend, scheduling API | Administrator 500; 10 points/card |
| Isolated internal network/gateway/physical isolation | `boundary-logical|strong|physical` | Tunnel/jump host/isolation device | The four questions: entry zone/landing zone/isolation device/target internal asset |
| Vendor/cloud service operations channel | `boundary-supply` | Vendor frp/VPN/operations platform | User-confirmed scope + entry into the main defended organization's internal network |

## 1. Domain control (domain-control)

- Identify: the registrar, DNS hosting, CNAME, certificates, WHOIS of the target's primary domain/subdomains.
- Path: weak passwords or stolen credentials on the registrar/DNS console → change resolution/add subdomains; subdomain takeover (CNAME pointing at an unclaimed cloud resource); DNS zone transfer; certificate issuance abuse.
- Evidence: console screenshot, resolution records before/after, WHOIS/registration entity; 50 for primary / 20 for secondary, scored by domain type.
- Note: only change records you control and keep evidence; do not perform destructive DNS changes; do not touch non-target domains.

## 2. Terminals (terminal-access)

- Identify: printers, WiFi routers, cameras, electronic displays, PCs/Pads/phones, MDM/endpoint management consoles.
- Path: default credentials/unauthorized management pages → device control; phishing/endpoint management console → bulk terminals; AD/MDM managed nodes.
- Evidence: the device page + its relationship to the target organization (asset tag, organization name, page footer); printers/WiFi 5 points/unit, PCs/Pads/phones/cameras/large displays 10 points/unit; for bulk, 3 representative images suffice.
- Note: do not lock devices en masse; do not touch control commands directly tied to production operations.

## 3. Network devices (netdev)

- Identify: VPN/SSL-VPN, firewalls, routers, switches, network gateways, optical gateways, ferry machines.
- Path: default/weak credentials on the management port, SNMP community strings, known CVEs, configuration file disclosure; once you have access, look at routing tables/policies/connection counts.
- Evidence (G7): routing table, policy configuration, connection-count screenshots; 100 for normal / 200 for administrator; network redirection/business hijacking +200; implant a remote-control tool and successfully continue the attack +1000.
- Note: back up and record original values before changing routes/policies; do not perform network-disrupting operations.

## 4. Cloud management platforms (cloud-platform)

- Identify: K8S/OpenShift, cloud consoles, PaaS management side, AK/SK, metadata services.
- Path: API Server unauthorized access/weak password, console weak password, AK/SK leakage, SSRF against metadata, CI/CD credentials.
- Evidence: screenshots of administrator operations (adding nodes/changing permissions); administrator 500; cloud hosts/containers 10 points/unit; nodes <100 scored as `web-app`, nodes earn no points.
- Note: bulk control through AK/SK only earns node points by default unless administrator privileges can be proven.

## 5. IoT / industrial internet (iot-platform / iiot / iot-corenet)

- Identify: camera/NVR/access control/sensor platforms, SCADA/HMI/PLC, connected vehicles/smart manufacturing/remote diagnostics.
- Path: platform default credentials/unauthorized APIs, exposed device firmware/protocols, vendor operations channels; lateral movement from endpoint devices into the core network.
- Evidence: platform console, connection count, device inventory; platform 200, connection points 10/unit; breaking into the core network through an endpoint device and controlling business production +5000 (recorded as a separate entry).
- Note: do not operate production control commands; gather evidence on read-only pages first.

## 6. Security devices (secdev)

- Identify: WAF/IPS/IDS/audit/logging platforms (non-centralized class).
- Path: default credentials on the management port, CVEs, unauthorized APIs; once you have access, look at policies/logs/asset-discovery capability.
- Evidence: administrator page, device model/privileges; administrator 200, cap 1000.
- Note: the centralized class (bastion hosts/domain controllers/SSO/endpoint management) goes to `central-system`; do not mix them up.

## 7. File storage (file-storage)

- Identify: FTP, SMB/NAS, object storage (OSS/S3/MinIO), enterprise cloud drives.
- Path: accounts/AK-SK, default credentials, backend login; anonymous listing/read-write only counts as a vulnerability or data, not as storage-system privileges.
- Evidence: successful login/invocation, account tier, file listing; administrator 50 / normal 10; data is scored separately (G2).

## 8. Models / compute (ai-agent / model-compute / model-data / computepower-*)

- Identify: Agent/skill platforms, Jupyter/Kubeflow/MLflow/Ray, training data/knowledge bases, model weights, compute platforms/GPU pools.
- Path: weak passwords/unauthorized access on the management side, unauthorized APIs, prompt injection/tool abuse, object storage AK/SK, scheduling APIs.
- Evidence: screenshots of controlling/operating the agent, system administrator privileges, knowledge base/data volume, card count; `ai-agent` 100–500; `model-compute`/`model-data` 500; knowledge base/over 100 million records or 10TB ×2; compute administrator 500, 10 points/card.
- Note: do not actually poison or damage training; gather evidence with read-only or reversible operations.

## 9. Boundary breaches (boundary-*)

Before scoring you must answer four questions (write them into the `boundary` object: entry_zone/target_zone/isolation/target_asset; for supply add scope_confirmed=true):

1. Entry zone: internet/DMZ/office/production/isolated?
2. Landing zone: which zone does the tunnel/jump host actually reach?
3. What isolation was crossed: firewall/network gateway/optical gateway/physical isolation/multi-NIC jump host? Evidence?
4. The target internal asset actually accessed: IP:port + output/protocol interaction.

Same zone, or any one of the four questions missing → record only `internal`. Logical isolation 1000, strong isolation 10000, physical isolation 30000; `boundary-supply` additionally requires the user to confirm the vendor/cloud service is in scope and proof of entry into the main defended organization's internal network (not merely the vendor's internal network).

## 10. General rules quick reference

- **G1 take the highest**: the same system/host/database counts only once at the highest privilege; record the lower tier first and then escalate, using `points` for the higher tier.
- **G2 data scored separately**: mail/business/data assets are recorded separately by importance; `evidence` states the actual record count/size. Sensitive information such as PII triples **≥10,000 records** takes priority; fetch only the sample needed as proof, do not drag out the whole database.
- **G3 caps**: each rule has a cap; warning is a stop signal — switch entries or switch assets.
- **G4 per unit**: terminals, cloud nodes, IoT connection points, and compute cards accumulate by count.
- **G5 doubling**: big data systems count as big data only at ≥500 million records/1TB; G5 doubling at ≥100 million records/10TB or a knowledge base — pass `data_scale` when scoring.
- **G6 IPv6**: IPv6 results ×3; pass `ip_version=6` when scoring.
- **G7 proof**: boundaries need an isolation device/screenshot of internal access; network devices need a routing table/connection count; terminals need proof of ownership; centralized managed nodes need 20% (20 hosts max).
- **T2/T3 earn no points**: weakly related assets such as sibling sites/same C-segment/shared hosting are scored under the corresponding code only after being upgraded to T0/T1 (same ICP/certificate/registrant/contract evidence) or explicitly confirmed by the user; T3 never scores.
- **G8 fallback**: for systems not covered by the rules, add a custom point with `redteam_score_point_save` and state the judgment criteria.

## 11. Selection order (operational priority, not just point value)

1. **P0 can enter the internal network**: RCE / command execution / upload / deserialization is possible and the landing point can serve as a jump host (boundary/edge, VPN/firewall/bastion host/operations platform, dual-homed, externally facing middleware/upload points); first obtain server privileges, build a tunnel, and actually test entry into the internal network.
2. **P1 sensitive data**: internet/internal unauthorized APIs, APIs reachable with an obtained account, databases/backups, exporting PII triples such as names/ID numbers/phone numbers **≥10,000 records**; fetch only the sample needed as proof and count the total.
3. Centralized/big data/business systems you can log into directly (500–1000 points).
4. Network devices/cloud platforms/IoT/security devices (200–500 points).
5. Server hosts/databases/file storage (10–50 points; becomes the main goal when you cannot enter the internal network).
6. Domain names/terminals (10–50 points, bulk or single).
7. Boundary breaches (1000–30000 points, but all four questions must be complete; do not force it with "the tunnel is reachable").

> P0/P1 is the **effort order**, not a rewrite of point values; the concrete values/caps still follow `redteam_score_list`.

> When one asset hits multiple codes, record one entry by "highest privilege/highest value + strongest evidence"; do not farm the same class of result on the same service just to pad the score.
