---
name: web-fingerprint
description: [Recon] Web service fingerprinting: frameworks, middleware, CMS, component versions
whenToUse: When an HTTP/HTTPS service is found and the tech stack must be identified
role: recon
category: Recon
tags: [web, fingerprint, httpx]
enabled: true
---

## Method
1. Response headers: `Server`, `X-Powered-By`, `Set-Cookie` characteristics.
2. Page characteristics: favicon hash, static resource paths, error pages, robots.txt.
3. Active probing: nuclei tech-detection template `nuclei -u <url> -tags tech`; for HTTP liveness and stack summary use `~/.local/bin/pd-httpx -l urls.txt -tech-detect -title -status-code -web-server` (**the ProjectDiscovery build must be pd-httpx; `/usr/bin/httpx` is the Python library CLI**).
4. For bulk fingerprinting of large netblocks use the skill `gogo-intranet` (`gogo -i <cidr> -p top2 -v --af`; active fingerprinting requires `-v`).
5. Version comparison: infer product and version from the fingerprint, preparing for vulnerability detection.

## Persistence requirements
Write into the fingerprint table: category (framework/middleware/CMS/component), vendor, product, version, evidence.
