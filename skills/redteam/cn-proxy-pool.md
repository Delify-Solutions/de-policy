---
name: cn-proxy-pool
description: 【Infrastructure】Domestic free HTTP/SOCKS5 proxy pool: harvesting, liveness checks, on-demand rotation; use command-level proxy parameters only, never modify the host's network or proxy configuration
whenToUse: When the target has WAF/IP-ban risk, or you need high-frequency requests (interface brute force, directory scanning, password spraying)
role: vuln-scan
category: Infrastructure
tags: [proxy, egress, rate-limit]
enabled: true
---

# Domestic Free IP Proxy Pool

Free proxies are unstable; the point is **reducing ban risk**, not hiding identity. For key targets prefer your own egress or a suo5 tunnel.

## ⛔ Iron rule: never touch the host's network and proxy configuration

Using a proxy is **only allowed as a temporary, per-command specification**; under no circumstances modify host configuration. The following are all prohibited:

| Prohibited | Description |
|---|---|
| Setting a system proxy | GNOME/KDE network settings, `gsettings set org.gnome.system.proxy …`, `networksetup -setwebproxy`, Windows `netsh winhttp set proxy` |
| Writing global environment variables | Modifying `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` in `/etc/environment`, `/etc/profile`, `/etc/profile.d/*`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.zshrc` |
| Changing tool global config | proxy entries in `~/.curlrc`, `~/.wgetrc`, `~/.npmrc`, `/etc/apt/apt.conf.d/*proxy*`, `/etc/pip.conf`, `~/.docker/config.json`, `~/.gitconfig` |
| Changing proxychains global config | Do not modify `/etc/proxychains4.conf`, `~/.proxychains/proxychains.conf`; when truly needed, point `-f` at a temporary config under `runs/` and delete it afterwards |
| Touching system networking | iptables/nftables rules, routing table, DNS (`/etc/resolv.conf`), NetworkManager, starting/stopping VPN/tun devices |
| Persisting exports | Do not `export http_proxy=…` in a shell so it stays in the session; to pass it, **inline** it before that single command |

**Correct approach** (all command-level and one-shot):

```bash
P=$(shuf -n1 runs/live-proxies.txt)

# Option 1: the tool's own proxy parameter (preferred)
curl -s --proxy "http://$P" --max-time 15 -I "https://target.example.com/"
nuclei -u https://target.example.com/ -proxy "http://$P" -rate-limit 20
sqlmap -u "https://target.example.com/item?id=1" --proxy="http://$P" --batch --random-agent
ffuf -u https://target.example.com/api/FUZZ -w wordlist.txt -x "http://$P" -rate 20

# Option 2: inline environment variables for this command only (no export, gone when the process exits)
http_proxy="http://$P" https_proxy="http://$P" curl -s --max-time 15 "https://target.example.com/"

# Option 3: tools that only support raw TCP → use a suo5 SOCKS5 tunnel (skill suo5-tunnel),
#        do not change the system proxy for them; for proxychains use a temporary config file:
proxychains4 -f runs/proxychains.tmp.conf -q nmap -sT -Pn -p 80,443 10.0.0.5
```

## 1. Harvesting (merge multiple sources)
```bash
mkdir -p runs && cd runs
curl -s --max-time 20 "https://www.89ip.cn/tqdl.html?api=1&num=50&port=&address=%E4%B8%AD%E5%9B%BD&isp=" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{2,5}' >> raw-proxies.txt
curl -s --max-time 20 "http://www.ip3366.net/free/?stype=1" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}</td>[[:space:]]*<td>[0-9]{2,5}' \
  | sed -E 's#</td>[[:space:]]*<td>#:#' >> raw-proxies.txt
curl -s --max-time 20 "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/CN/data.txt" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{2,5}' >> raw-proxies.txt
sort -u raw-proxies.txt -o raw-proxies.txt && wc -l raw-proxies.txt
```

## 2. Validation (concurrent liveness testing, keep the working ones)
```bash
cat > runs/check_proxy.py <<'PY'
import concurrent.futures, sys, urllib.request
TARGET = "http://www.baidu.com"   # connectivity test only, carries no sensitive data
def ok(proxy):
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://" + proxy, "https": "http://" + proxy}))
        with op.open(TARGET, timeout=6) as r:
            return proxy if r.status == 200 else None
    except Exception:
        return None
with open(sys.argv[1]) as f:
    cands = [l.strip() for l in f if l.strip()]
with concurrent.futures.ThreadPoolExecutor(max_workers=50) as ex:
    for res in ex.map(ok, cands):
        if res: print(res, flush=True)
PY
python3 runs/check_proxy.py runs/raw-proxies.txt > runs/live-proxies.txt
wc -l runs/live-proxies.txt
```

## 3. Rotation and Rate Limiting
- Pick a random proxy per request; on failure drop it automatically and move to the next.
- Still rate-limit on the target side (`-rate-limit` / `--delay`); a proxy only changes the egress IP, it is not an accelerator.
- Record success/failure per egress IP; if the same target bans you 3 times in a row, **abandon that target** per the rules in the vulnerability-detection prompt.

## 4. Notes
- **Do not transmit credentials, cookies, or uploaded shells through free proxies** — free proxies may log traffic.
- Liveness testing is connectivity-only; do not test with real business requests.
- Before high-frequency brute force, confirm the target has no account lockout policy; stop proactively before triggering a lockout.
- Clean up temporary configs under `runs/` afterwards (such as `proxychains.tmp.conf`); leave no proxy traces in the system.
- Use only within the scope of an authorized exercise.
