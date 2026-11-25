---
name: kimi-webbridge
description: [Recon] Use the Moonshot Kimi browser extension (WebBridge) to drive the user's real Chrome/Chromium: navigate, read pages, click, fill forms, execute JS, screenshot
whenToUse: When you need to reuse the browser login state to access a backend / need JS-rendered pages / need a real browser fingerprint
role: recon
category: Recon
tags: [browser, logged-in, js]
enabled: true
---

# Kimi WebBridge (browser extension + local daemon)

Installed and running: daemon **v2.0.8** (systemd service `kimi-webbridge`, starts on boot), listening on `127.0.0.1:10086`, binary `~/.kimi-webbridge/bin/kimi-webbridge`.

## Current state (verified 2026-09)
- Daemon: **managed by systemd** (`/etc/systemd/system/kimi-webbridge.service`, `enabled` + `active`, `Restart=on-failure`).
  Check status: `systemctl status kimi-webbridge`; restart with `sudo systemctl restart kimi-webbridge`.
  **Do not manually run `kimi-webbridge start`/`upgrade` any more** — that spawns a stray process and systemd goes inactive instead; to upgrade use
  `sudo systemctl stop kimi-webbridge && ~/.kimi-webbridge/bin/kimi-webbridge upgrade && sudo systemctl start kimi-webbridge`.
- Extension: **Kimi WebBridge v2.0.8, force-installed from the Chrome Web Store by enterprise policy** (extension ID `fldmhceldgbpfpkbgopacenieobmligc`).
  The policy files `/etc/opt/chrome/policies/managed/kimi-webbridge.json` and `/etc/chromium/policies/managed/kimi-webbridge.json`
  both set `ExtensionSettings.force_installed` + `ExtensionInstallForcelist`, so **any Chrome / Chromium profile comes with the extension on open, auto-updates, and stays enabled**.
- Chrome 137+ ignores `--load-extension` (the `--disable-features=…` escape hatch also no longer works), so **do not go back to the unpacked-load route**.
- If `status` shows `extension_connected: false`: 99% of the time it just means **no browser is running**; start any browser (`kimi-chrome` or click the Chrome/Chromium icon directly) and it connects within 5 seconds.
- For simple page content retrieval prefer the skill `browser-automation` (faster, no browser window needed); **when a real login state must be reused you must use this skill**

## Prerequisites
1. The daemon is running: `~/.kimi-webbridge/bin/kimi-webbridge status` should show `"running": true` (starts on boot, normally no intervention needed).
2. **A browser must be running** (the extension only keeps the connection while the browser process is alive). The launcher `~/.local/bin/kimi-chrome`:
   - By default starts Chrome with the **default profile** (carrying the real login state — that is where the bridge's value lies);
   - `KIMI_BROWSER=chromium kimi-chrome` switches to Chromium; `KIMI_PROFILE=/path kimi-chrome` specifies an isolated profile (no login state).
3. Check the connection:
```bash
curl -s http://127.0.0.1:10086/status | python3 -m json.tool
# "extension_connected": true must be present, otherwise subsequent commands will fail
```

## Invocation
```bash
WB=http://127.0.0.1:10086/command
call() { printf '%s' "$2" > /tmp/wb.json; curl -s -X POST $WB -H 'Content-Type: application/json' --data-binary @/tmp/wb.json; }
```
> JSON containing non-ASCII characters must always go through a temp file + `--data-binary`, never inline with echo/heredoc.

### Common actions
```bash
# Open a page (new tab)
call navigate '{"action":"navigate","args":{"url":"https://target.example.com/login","newTab":true,"group_title":"recon"},"session":"recon1"}'

# Read page plain text (most common)
call evaluate '{"action":"evaluate","args":{"code":"(() => document.body.innerText.slice(0,6000))()"},"session":"recon1"}'

# Get the accessibility tree (with @e element references, convenient for later click/fill)
call snapshot '{"action":"snapshot","args":{},"session":"recon1"}'

# Execute arbitrary JS: grab the front-end endpoint list (a recon/endpoint-discovery workhorse)
call evaluate '{"action":"evaluate","args":{"code":"(() => {const s=new Set();for(const e of performance.getEntriesByType(\"resource\"))s.add(e.name);const m=document.documentElement.innerHTML.match(/[\\\"\\x27]\\/(api|v[0-9])\\/[a-zA-Z0-9_\\-\\/{}]+/g)||[];m.forEach(x=>s.add(x));return [...s].slice(0,200).join(\"\\n\")})()"},"session":"recon1"}'

# Click / fill
call click '{"action":"click","args":{"ref":"@e12"},"session":"recon1"}'
call fill  '{"action":"fill","args":{"ref":"@e15","value":"admin"},"session":"recon1"}'

# Screenshot (returns a file path, not base64)
call screenshot '{"action":"screenshot","args":{"path":"$DSH_HOME/redteam/engagements/<target>/runs/shot.png"},"session":"recon1"}'

# Capture network requests (find endpoints)
call network '{"action":"network","args":{},"session":"recon1"}'

# List/close tabs
call list_tabs '{"action":"list_tabs","args":{},"session":"recon1"}'
call close_session '{"action":"close_session","args":{},"session":"recon1"}'
```
Raw CDP passthrough (advanced): `{"action":"cdp","args":{"method":"Network.getAllCookies"}}`.

## Usage in the red team flow
- **Endpoint discovery**: open the site → `evaluate` to grab resource timing + endpoint paths in page JS → hand the endpoint list to the vulnerability-detection role for IDOR/unauthorized testing.
- **Logged-in pages**: for backends the user has already logged into in the browser, `navigate` + `evaluate` reads the content directly, with no re-login needed.
- **JS-rendered sites**: more realistic than curl, and you get the DOM after SPA rendering.
- Discovered URLs/titles are written back via `redteam_asset_add` as usual (`tool="kimi-webbridge"`).

## Limitations (must know)
- **No headless**: a graphical session is required (`DISPLAY=:10.0` is available on this machine).
- Only Chrome/Edge are supported; cross-origin iframes are not; `click`/`fill` are synthetic events, so captchas/banking controls do not work.
- The extension and daemon versions are tightly coupled: if `update_available` in `status` is non-empty, upgrade the daemon via the systemd stop → `upgrade` → start flow above; the extension auto-updates to the latest version by policy.
- Linux is not in the official support matrix (works but not guaranteed).

## Fallback without the extension
See skill `browser-automation` (zero-dependency headless chromium approach).
