---
name: passive-recon
description: [Recon] Passive information gathering: no contact with target hosts, public data sources only
whenToUse: When target asset intelligence must be collected without exposing yourself
role: recon
category: Recon
tags: [osint, passive, dns]
enabled: true
---



## Data sources
- Certificate Transparency logs (crt.sh): `curl -s "https://crt.sh/?q=%25.<domain>&output=json" | jq -r '.[].name_value' | sort -u`
- DNS records: `dig +short <domain> A/AAAA/MX/TXT/NS`
- whois: registrant, netblock, ASN
- Search engines and code hosting platforms: leaked subdomains, keys, internal addresses
- Public port-scanning datasets (Shodan/Censys/FOFA etc., API authorization required)

## Persistence requirements
For every finding call redteam_asset_upsert, with provenance fixed to `passive`, and tool recording the specific data source.

