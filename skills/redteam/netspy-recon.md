---
name: netspy-recon
description: 【Internal】Use netspy v0.0.5 on a controlled internal host to quickly discover reachable segments/dual-homed NICs/adjacent segments; supports ICMP/ping/ARP/TCP/UDP probing and outputs live /24 segments as pre-recon for gogo/fscan
whenToUse: When an internal foothold is already established and you need to confirm "which segments this machine can still reach", or you are looking for dual-homed NICs/adjacent segments/new internal networks
role: internal
category: Internal
tags: [internal, segment, icmp]
enabled: true
---

# netspy Internal Reachable Segment Discovery

## What it is

netspy is an **internal reachable-segment discovery** tool — not a vulnerability scanner, not a proxy, not a tunnel.

It starts from a **controlled internal host** and uses multiple protocols to quickly determine which segments the current host can reach:

- ICMP;
- System ping;
- ARP (layer-2 local segments only);
- TCP ports;
- UDP ports.

The output is usually the `/24` segment of live hosts, for example:

```text
10.20.30.0/24
172.16.8.0/24
```

## Binary and installation

Already installed locally:

```text
$DSH_HOME/redteam/toolkit/netspy/netspy
```

Verify:

```bash
NETSPY="$DSH_HOME/redteam/toolkit/netspy/netspy"
"$NETSPY" version
```

Current version: **v0.0.5** (official release).

> Tools are prepared by the user; this skill does not provide download addresses or installation tutorials. When the path does not exist, write `needs`; do not use binaries of unknown origin.

## The most important thing: where to run it

netspy uses **raw sockets/the local protocol stack**; it is not a SOCKS client.

Therefore:

- **It must run on a controlled host on the target side**, e.g. uploaded to a jump host, a WebShell host, or a Linux/Windows host already landed;
- **Never** run ICMP, ARP, or UDP probing from the attack machine through `proxychains` / SOCKS5 — the traffic will not enter the target's internal network as expected;
- If you only have an HTTP/WebShell channel, execute on the target side first; only fall back to the limited scenarios covered by `pingspy`/`tcpspy` when binaries cannot be executed;
- Windows targets use `netspy_windows_amd64.zip`; Linux targets use `netspy_linux_amd64.zip`;
- Scenarios needing root/administrator: ICMP/ARP/raw sockets; when privileges are insufficient, try `pingspy` or `tcpspy` first.

## Look at routing before choosing ranges

Do not run netspy's default full probe of `10/8`, `172.16/12`, `192.168/16` directly on the target. Look first:

```bash
ip -br addr
ip route
# Windows:
ipconfig /all
route print
```

Candidate ranges:

1. The segment the current host sits in;
2. The segment containing the default gateway;
3. Static routes/next-hop segments in the routing table;
4. Segments reachable through already-discovered WebShells/tunnels;
5. The second NIC segment on dual-homed hosts.

Probe only candidates **within the authorized scope**; outside the scope, record leads only.

## Basic usage

```bash
NETSPY="$DSH_HOME/redteam/toolkit/netspy/netspy"

# 1) Verify the tool first
"$NETSPY" version

# 2) ICMP probe against explicit candidate segments (the recommended starting point; -s prints only live segments)
"$NETSPY" -c 10.20.30.0/24 -c 172.16.8.0/24 \
  -t 80 -m 100 -r 1 -s \
  -o runs/netspy-<target>-<time>.txt is

# 3) Fast mode: probe only in-segment gateways, good for finding direction first (low coverage, do not treat as a full result)
"$NETSPY" -x -s -o runs/netspy-gateway-<target>-<time>.txt is

# 4) TCP port probe (when ICMP is blocked; global flags go before the subcommand)
"$NETSPY" -c 10.20.30.0/24 -t 60 -m 120 -s \
  -o runs/netspy-tcp-<target>-<time>.txt ts -p 22 -p 80 -p 3389 -p 445

# 5) UDP probe (DNS/SNMP etc., mind the noise)
"$NETSPY" -c 10.20.30.0/24 -t 40 -m 150 -s \
  -o runs/netspy-udp-<target>-<time>.txt us -p 53 -p 161
```

### Parameter discipline

| Parameter | Usage |
| --- | --- |
| `-c CIDR` | Explicitly specify candidate segments; repeatable; **prefer small segments** |
| `-r N` | Probe N random host-octet values per /24; default 1 |
| `-t N` | Concurrency; default CPU×20; start at 40–100 on internal networks |
| `-m N` | Timeout in milliseconds; default 100; raise it moderately for cross-segment probes |
| `-s` | Print only live segments, convenient for recording |
| `-o FILE` | **Must** be specified, to avoid overwriting the default `alive.txt` |
| `-x` | Fast mode; probes gateways only, limited coverage |
| `-f 255` | Force probing all IPs in the /24; **extremely noisy, forbidden by default** |
| `-i` | Special internal network; use only when the scope is confirmed |

## Result handling

### 1. Parse live segments

```bash
grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' \
  runs/netspy-<target>-<time>.txt | sort -u
```

### 2. Record "discoveries", not "results"

netspy can only prove **reachable/live**; it cannot prove you have permissions, and it cannot directly earn `boundary-*` / `internal` points.

- For each specific IP that responds, record it with `redteam_asset_add`: `provenance=active`, `tool=netspy`, `state=live`;
- Append to the `test` field of `redteam_asset_test`: "netspy found reachable, not yet tested", keeping the state `untested`;
- Put key commands and output paths into the asset `test`, or into `command`/`result` of `redteam_score_hit` when scoring;
- **Do not** record a boundary breach just because traffic "can be routed there"; you must actually access the target asset and keep the response.

### 3. Hand off to gogo/fscan to continue

Advance segment by segment in priority order; do not scan every segment at full volume at once:

```bash
# First gogo to map the surface (ports/services/fingerprints/key information)
gogo -i 10.20.30.0/24 -p top2,win,db -o runs/gogo-10.20.30.0_24.txt

# Then fscan to exploit footholds (weak passwords/unauthorized/high-risk)
fscan -h 10.20.30.0/24 -o runs/fscan-10.20.30.0_24.txt
```

For each newly discovered segment, loop through "gogo maps the surface → fscan exploits footholds → record to the database → assess" until there are no new segments/live hosts.

## OPSEC

- Small segments, low concurrency, short time windows first; expand only after confirming no business anomalies;
- Prefer `-s`, explicit `-c`, `-r 1`; never default to full volume;
- Use `-f 255`, `-i`, and large `/8` ranges only after confirming offline that the noise level is acceptable;
- Record the source host, egress NIC, and time window; this makes reconciliation easy for the blue team/user;
- Stop immediately on account lockouts, business anomalies, traffic alerts, or a ban by the target;
- netspy only performs discovery; it does not exploit vulnerabilities, does not persist, and does not change target configuration.

## Common failures

| Symptom | Handling |
| --- | --- |
| `permission denied` / raw socket | Run as root/administrator; or switch to `pingspy`/`tcpspy` |
| No ICMP responses at all | The target blocks ICMP; use `ts -p 22/80/443/445/3389` or `us -p 53/161` |
| No ARP results | ARP is only valid for the local layer-2 segment; use ICMP/TCP/UDP across segments |
| No results when run through SOCKS | netspy must execute on the target side; do not run raw probing inside proxychains on the attack machine |
| Too many results/too slow | Narrow `-c`, lower `-t`, raise `-m`; use `-x` to find gateways first, then refine |
| Output file overwritten | Always use an `-o` path containing the target name/timestamp |

## Delivery checklist

- [ ] Run on a target-side host, not locally through SOCKS on the attack machine;
- [ ] Only authorized candidate segments were probed;
- [ ] An explicit `-c` and a dedicated `-o` were used;
- [ ] Output files were saved under `runs/`;
- [ ] Live IPs were recorded in the asset database with state untested, not as already-compromised;
- [ ] Follow-up was handed to gogo/fscan and advanced segment by segment;
- [ ] "Reachable" was not written up as a "boundary breach" or "internal privileges".
