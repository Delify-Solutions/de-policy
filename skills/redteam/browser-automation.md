---
name: browser-automation
description: 【Recon】Dependency-free driving of Chrome/Chromium to scrape JS-rendered pages, take screenshots, execute JS, and harvest interface inventories (headless fallback + playwright-cli)
whenToUse: When you need to render an SPA / get JS-generated content / capture screenshots as evidence / scrape pages in bulk (first choice when the Kimi extension is unavailable)
role: recon
category: Recon
tags: [browser, js, screenshot]
enabled: true
---

# Browser Automation (headless Chrome)

Local machine: `/usr/bin/chromium` 150.0.7871.181, `DISPLAY=:10.0`, Node v22.23.2.

## 1. Zero dependencies: chromium command line (most reliable)
```bash
CHROME=/usr/bin/chromium
FLAGS="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --virtual-time-budget=8000"

# 1) Grab the rendered DOM (works for SPAs too)
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null > runs/page.html

# 2) Extract plain text only
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null \
  | python3 -c "import sys,re;h=sys.stdin.read();print(re.sub(r'<[^>]+>',' ',re.sub(r'(?is)<(script|style).*?</\1>',' ',h)))" | head -200

# 3) Screenshot as evidence
$CHROME $FLAGS --window-size=1440,900 --screenshot=runs/shot-$(date +%s).png "https://target.example.com/"

# 4) Access with cookies (reuse a login state: export cookies from Burp/browser, then write them in)
$CHROME $FLAGS --user-data-dir=/tmp/rt-profile --dump-dom "https://target.example.com/admin"

# 5) Generate a PDF
$CHROME $FLAGS --print-to-pdf=runs/page.pdf "https://target.example.com/"
```

### Harvesting the frontend interface inventory (the core of information gathering)
```bash
# Run a bit of JS with chromium and output the result
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null > runs/page.html
python3 - <<'PY'
import re, json, pathlib
html = pathlib.Path('runs/page.html').read_text(errors='ignore')
paths = set(re.findall(r'["\'](/(?:api|rest|v[0-9]|admin|user|order|upload|file)[A-Za-z0-9_\-/{}.:]{0,80})["\']', html))
print('\n'.join(sorted(paths)))
PY
# Then download each JS resource and extract from it:
grep -oE 'src="[^"]+\.js[^"]*"' runs/page.html | sed 's/src="//;s/"$//' | while read u; do
  case "$u" in http*) url="$u";; /*) url="https://target.example.com$u";; *) url="https://target.example.com/$u";; esac
  curl -s "$url" | grep -oE '["\'](/(api|rest|v[0-9])[A-Za-z0-9_\-/{}.:]{0,80})["\']' | tr -d '"'"'" >> runs/interfaces.txt
done
sort -u runs/interfaces.txt
```

## 2. playwright-cli (when you need interaction/waiting/multiple pages)
**The browser is already installed on this machine** (`~/.cache/ms-playwright/chromium-1243`; the one-time `npx playwright install chromium` has been completed). Note: **using the default chrome channel reports `Chromium distribution 'chrome' is not found`, so you must add `--browser chromium`**.

```bash
PW="npx --yes @playwright/cli@latest"
$PW -s=recon1 open --browser chromium "https://target.example.com/"   # open (-s sets the session name)
$PW -s=recon1 snapshot                                                # accessibility tree + @e element refs
$PW -s=recon1 eval "() => document.title"                             # execute JS
$PW -s=recon1 find "login"                                              # search text in the snapshot
$PW -s=recon1 click "@e5"                                             # click
$PW -s=recon1 fill "@e7" "admin"                                      # fill a form
$PW -s=recon1 screenshot --path runs/pw.png                           # screenshot
$PW -s=recon1 --persistent --profile runs/pw-profile open --browser chromium URL   # reuse login state
$PW -s=recon1 close                                                   # close the session
```

Reusing a login state: `--persistent --profile <dir>`; after the first login that profile keeps the cookies, so later opening with the same profile is already logged in.
Common subcommands: `open / goto / snapshot / find / eval / click / fill / press / upload / screenshot / resize / reload / go-back / close / list`.

## 3. Choosing between them
| Scenario | Which to use |
|---|---|
| Only need page content/screenshot/interface inventory | chromium command line (zero dependencies, fastest) |
| Need clicking/forms/waiting/multiple tabs | playwright-cli (`--browser chromium`)|
| Need to reuse the user's real login state | Kimi WebBridge (skill `kimi-webbridge`, extension required) |

## Notes
- `--no-sandbox` is only for the local exercise environment; do not carry that flag into production.
- Write scraped URLs/titles back via `redteam_asset_add` (`url`/`title` fields); save the interface inventory under `runs/` and reference it in the asset's `test`/`surface`.
- Screenshots and page content may contain sensitive data; keep them only under `runs/`, never write them into the asset database.
