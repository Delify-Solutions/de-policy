---
name: asset-correlation
description: [Recon] Asset correlation: graphing domain ↔ IP ↔ C-segment ↔ certificate ↔ service
whenToUse: When recon reaches a closing milestone and an asset relationship view is needed
role: recon
category: Recon
tags: [asset, graph, c-segment]
enabled: true
---

## Correlation rules
- Domain resolution → `resolves` edge (domain → asset)
- C-segment ownership → `contains` edge (segment → asset)
- Port open → `exposes` edge (asset → port)
- Certificate SAN shared → `shares_cert` edge

## C-segment feature comparison (finding hidden assets)
Within the same /24, compare confirmed assets one by one on title, footer copyright / organizational signature, ICP filing number, favicon hash, certificate CN/SAN, and the combination of open ports; an IP matching the same features but not resolved by public DNS is marked as a hidden asset, registered via `redteam_asset_add`, and then recorded as one clue line in `redteam_asset_test`.
- The favicon hash can be reverse-looked-up with FOFA `icon_hash=`, or taken from httpx/browser results for the same icon hash.
- Do not claim ownership purely on "same C-segment"; stack at least one more feature (title / filing / certificate / footer).

## T0–T3 grading (avoid hitting the wrong target)
| Level | Determination | Action |
| --- | --- | --- |
| T0 direct ownership | ICP / WHOIS / certificate CN/SAN / footer / organizational signature clearly belong to the target; official primary domain, official IP, official App backend | Collect, evaluate, and attack first |
| T1 strongly related | Controlling subsidiary / branch / same legal representative / same registrant / same certificate subject / provable official operations contract | Attackable, write the evidence in reason |
| T2 weakly related | Same C-segment / same ASN / same IP neighbor site / same favicon / same title / shared hosting / CDN neighbor / vendor / test environment / historical domain | Clue only; evaluate for attack **only after T0/T1 are exhausted and the user confirms** |
| T3 unrelated | Other organizations / individuals / public infrastructure | Do not touch |

- Same C-segment, same favicon, same title are **only clues**; a neighbor site sharing the same ICP/certificate/registrant should be upgraded to T0, not T2.
- Write the grading into `redteam_asset_test`'s `test` (`relatedness=T0|T1|T2|T3`) with the ownership evidence attached;
- Assets without ownership evidence default to T2 and must not be attacked directly.

## Proof of ownership (mandatory for scored assets)
At least one of: ICP filing number, certificate CN/SAN, WHOIS registrant, homepage footer copyright / organizational signature, unit name on the system login page.
Write it into `redteam_asset_test`'s `test` (`ownership_proof: ...`), and keep a homepage/filing screenshot with `redteam_shot_add`; the first report section grades strength based on this.

## Persistence requirements
Write into the edge table via redteam_asset_link; duplicate relationships are idempotent.
