---
name: fofa-recon
description: 【Recon】Bulk-map a target's internet-facing assets with the FOFA API (domain/IP/port/title/fingerprint); ships a rate-limited client — strictly single-threaded, minimum interval, backoff retry, so 45012 is never triggered
whenToUse: During recon, when the internet-facing asset surface of an organisation or domain must be laid out quickly
role: recon
category: Recon
tags: [external, asset, fofa]
enabled: true
---

# FOFA Asset Mapping (Rate-Limited Safe Edition)

## Credentials
- API Key: read from the environment variable `FOFA_KEY` (**never commit any key into the repository**; every script in this skill reads environment variables only)
- Endpoint: `GET https://fofa.info/api/v1/search/all`
- Parameters: `key`, `qbase64` (base64 of the query statement), `size`, `page`, `fields`

## Official Quotas (fofa.info/vip, verified 2026-09)

| Plan | Query requests | Data volume | **Search API concurrency** |
|---|---|---|---|
| Registered user (free) | No API (web UI 300/month) | 3,000 records/month via web UI | — |
| Personal | 10,000/month | 100,000 records/month | **1 request/second** |
| Professional | 80,000/month | 800,000 records/month | **1 request/second** |
| Business | 900,000/month | 9,000,000 records/month | **2 requests/second** |
| Enterprise V2 | 5,000,000/month | 50,000,000 records/month | **5 requests/second** |

## Observed Behaviour (empirically verified)
- Rapid consecutive requests → **HTTP 429**, response body `{"error":true,"errmsg":"[45012] request rate too high"}`
- Bad key → HTTP 200 + `{"error":true,"errmsg":"[-700] invalid account"}`
- A single page with `size` up to 1000 works fine; with a request interval of ≥1 second, consecutive requests all return 200
- Conclusion: **operate conservatively at 1 request/second, never concurrently**; on 45012 you must back off — do not retry immediately

## Operating Discipline (important)
1. **Precise queries first**: narrow the scope with `domain=` / `cert=` / `org=` first, then consider broad clauses such as `body=` / `title=`. Broad clauses return hundreds of thousands of records — meaningless, and they burn quota.
2. **Do not page through everything**: by default take only the first 1–3 pages (100 records per page) — enough to obtain the mapping entry points.
3. **Single process, single thread**: only one collection task runs at a time; multiple queries queue up serially.
4. **Cache results to disk**: do not re-pull the same query; first check whether `runs/fofa-*.jsonl` already exists.
5. **Run long tasks in the background**: use `run_in_background`; do not block the conversation.
6. When quota is exhausted or you are rate-limited, switch to another data source (certificate transparency, DNS, search engines) instead of hammering away.

## Rate-Limited Client (use this; do not hand-write curl loops)
```bash
cat > runs/fofa_client.py <<'PY'
#!/usr/bin/env python3
"""FOFA collection (rate-limited safe): single thread + minimum interval + exponential backoff + result cache.

Usage:
  python3 runs/fofa_client.py 'domain="example.com"' --pages 2 --size 100 --interval 2.0
Output:
  runs/fofa-<slug>.jsonl   one asset per line {host,ip,port,title,domain,server,protocol}
"""
import argparse, base64, hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request

KEY = os.environ["FOFA_KEY"]
API = "https://fofa.info/api/v1/search/all"
FIELDS = "host,ip,port,title,domain,server,protocol"
RETRY_BACKOFF = [5, 15, 45]          # backoff seconds on 45012
HARD_BUDGET = 30                      # maximum requests per run


def fetch(query, page, size, timeout=30):
    qs = urllib.parse.urlencode({
        "key": KEY, "qbase64": base64.b64encode(query.encode()).decode(),
        "size": size, "page": page, "fields": FIELDS,
    })
    req = urllib.request.Request(API + "?" + qs, headers={"User-Agent": "redteam-recon/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": True, "errmsg": body[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--pages", type=int, default=2, help="maximum pages to fetch (default 2)")
    ap.add_argument("--size", type=int, default=100, help="records per page (default 100, do not increase)")
    ap.add_argument("--interval", type=float, default=2.0, help="minimum interval between requests in seconds (default 2.0)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    slug = hashlib.md5(args.query.encode()).hexdigest()[:8]
    out = args.out or f"runs/fofa-{slug}.jsonl"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f"[cache] {out} already exists ({os.path.getsize(out)} bytes); delete it first to re-fetch", file=sys.stderr)
        return 0

    seen, rows, requests_made, last_ts = set(), [], 0, 0.0
    for page in range(1, args.pages + 1):
        # ---- rate limit: guarantee at least `interval` seconds between two requests ----
        wait = args.interval - (time.time() - last_ts)
        if wait > 0:
            time.sleep(wait)

        status, data = None, None
        for attempt, backoff in enumerate([0] + RETRY_BACKOFF):
            if attempt:
                print(f"[backoff] retrying after {backoff}s (page={page})", file=sys.stderr)
                time.sleep(backoff)
            last_ts = time.time()
            requests_made += 1
            if requests_made > HARD_BUDGET:
                print(f"[stop] request budget {HARD_BUDGET} reached", file=sys.stderr)
                break
            status, data = fetch(args.query, page, args.size)
            if status == 200 and not data.get("error"):
                break
            errmsg = str(data.get("errmsg", ""))
            if "45012" in errmsg or status == 429:
                continue                      # rate limited -> back off and retry
            print(f"[stop] non-retryable error http={status} {errmsg}", file=sys.stderr)
            data = None
            break
        if data is None:
            break

        results = data.get("results") or []
        print(f"[page {page}] {len(results)} records (size={data.get('size')}, consumed_fpoint={data.get('consumed_fpoint')})", file=sys.stderr)
        for item in results:
            if isinstance(item, str):
                item = [item]
            host = item[0] if len(item) > 0 else ""
            ip = item[1] if len(item) > 1 else ""
            port = item[2] if len(item) > 2 else ""
            key = (host, ip, port)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "host": host, "ip": ip, "port": port,
                "title": item[3] if len(item) > 3 else "",
                "domain": item[4] if len(item) > 4 else "",
                "server": item[5] if len(item) > 5 else "",
                "protocol": item[6] if len(item) > 6 else "",
            })
        if len(results) < args.size:
            break                              # reached the last page

    with open(out, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[done] {len(rows)} assets -> {out} ({requests_made} requests total)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
```

### Usage
```bash
mkdir -p runs
python3 runs/fofa_client.py 'domain="example.com"' --pages 2 --size 100 --interval 2.0
python3 runs/fofa_client.py 'cert="example.com"' --pages 3 --interval 2.0
python3 runs/fofa_client.py 'org="Example Technology Co Ltd"' --pages 2 --interval 2.0
```

### Persisting to the Asset Store
Read `runs/fofa-*.jsonl` and call `redteam_asset_add` for each record: `provenance="passive"`, `tool="fofa"`, with `url=host`, `title`, `product=server` on the port entry; write the domain into `names`.

## Common Query Statements
| Purpose | Statement |
|---|---|
| All assets of a domain | `domain="example.com"` |
| Certificate contains the domain | `cert="example.com"` |
| A given /24 block | `ip="203.0.113.0/24"` |
| Organisation name | `org="Example Technology Co Ltd"` |
| Find admin panels by title | `title="login" && domain="example.com"` |
| By body signature | `body="/seeyon/"` |
| Specific port | `ip="203.0.113.0/24" && port="3306"` |

> Broad clauses (using `body=` / `title=` on their own) return huge result sets and burn quota fast — always combine them with a domain or IP restriction.
