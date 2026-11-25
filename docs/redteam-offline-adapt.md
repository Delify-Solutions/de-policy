# Intranet Machine Adaptation: Red Team Port Package (No Internet, No Upstream Repository)

This document is for the computer that has **intranet-only** access. The package already contains all the code to be ported from upstream v0.14.1–0.14.3; **do not** pull `dsh-redteam-mode` from GitHub again, and **do not** install that standalone red team plugin alongside it.

You only need to carry over one file:

```
de-policy-1.1.75.tgz
```

The docs, skills, and drill-ground sources are all inside this package. Copying the whole repository also works and gives the same result.

Where it differs from upstream and what the impact is: `docs/redteam-inconsistency-essence.md`. The intranet machine only needs to install per this document; there is no need to modify anything against the upstream repository.

---

## 0. First confirm on this internet-connected machine that the package is complete

Before copying it out, run this once in the repository root (no network access):

```sh
node scripts/verify-redteam-port.mjs
```

Once everything reports `OK`, copy `de-policy-1.1.75.tgz`. If the intranet machine has no Node, you can skip this and verify through the UI after installing per section 3.

To repackage:

```sh
node scripts/build-client.mjs
node scripts/verify-redteam-port.mjs
npm pack
```

This overwrites `de-policy-1.1.75.tgz` in the root directory.

---

## 1. What to bring to the intranet machine

Minimum:

| File | Purpose |
| --- | --- |
| `de-policy-1.1.75.tgz` | For installation |
| This document, `docs/redteam-offline-adapt.md` | Cross-check after installing (also inside the tgz) |

Optional references (none of them require upstream source):

- `docs/redteam-vs-upstream-0.14.3.md` — where it differs from upstream, and what was deliberately not ported
- `docs/redteam-port-plan-1-3-4-5-6.md` — the review criteria used when porting 1/3/4/5/6
- `release-notes.md` — every change in 1.1.75

Do not bring:

- `.scratch/dsh-redteam-mode/` (an upstream clone, useless on the intranet)
- `node_modules/`
- Old `de-policy-1.1.74.tgz` and other historical packages

---

## 2. Prerequisites on the intranet machine

- The official DeepSeek Harness is already installed (Web `dsh web` and/or the desktop EXE)
- You know the `$DSH_HOME` in use (it contains `profiles/`)
- `dsh-redteam-mode` must **not** be installed. If it was, uninstall it first; the two will fight over `$DSH_HOME/redteam`
- Node ≥ 18 locally is better (convenient for running self-checks); the plugin can still be installed without it

Windows desktop `dsh` is often not on PATH; use:

```
<desktop install root>\resources\runtime\cli\bin\dsh.cmd
```

For example `D:\DeepseekHarnessDesktop\resources\runtime\cli\bin\dsh.cmd`. For a portable directory, first run:

```powershell
$env:DSH_HOME = "D:\DeepSeek Harness\.dsh"   # change to the actual one
```

---

## 3. Installation (local tgz, no internet access)

Put the tgz into any directory on the intranet machine, for example `C:\temp\de-policy-1.1.75.tgz`.

**Web:**

```sh
dsh plugin --profile web add C:\temp\de-policy-1.1.75.tgz
```

**Desktop:**

```sh
dsh plugin --profile desktop add C:\temp\de-policy-1.1.75.tgz
```

If `dsh` is not on PATH, use the full path to `dsh.cmd`. If a profile does not exist, skip that command.

If the command line fails, do it manually:

1. Extract the tgz (gzip + tar). It usually extracts to `package/`; rename it to `de-policy` and put the whole folder at `$DSH_HOME/plugins/de-policy`
2. Only **append**, never overwrite the profile's `package.json` wholesale:
   - add `"de-policy": "file:../../plugins/de-policy"` to `dependencies`
   - append `"de-policy"` to the end of `dsh.profile.bundles` (skip if it is already there)
3. For Web edit `profiles/web/package.json`; for desktop edit `profiles/desktop/package.json`

After installing you must:

1. **Quit the host you just installed into completely, then start it again**: for Web, stop `dsh web` and start it; for desktop, exit from the tray and start the EXE again
2. Next to the session title, click **de-policy → purge → apply**
3. A successful "apply" restarts once more. The Web button only touches Web; the desktop one only touches the desktop

Skill files are synced by the plugin at startup into `$DSH_HOME/redteam/skills`, overwriting bundled skills of the same name. The user's own copies live in `$DSH_HOME/skills` and are left untouched.

---

## 4. What you should see in the UI after installing

Open the red team drill ground:

| Location | Expected |
| --- | --- |
| Default page | **Situation**, not asset mapping |
| Top-level sections | Situation / Assets / Results / Report / Resources |
| Resource section | Session tunnels, credentials and files, knowledge base, skill library, agents, **environment adaptation** |
| Skill library | `campaign-planning`, `specialist-paths`, `deepseek-web-intel`, `score-coverage` are visible |
| Report page | With scores present it is the three templated blocks: asset ownership proof → score summary → scoring-point reproduction |
| Download report | The filename carries the target name in Chinese, not a string of underscores |
| Full browse | Web prefers a new window; desktop goes fullscreen in the same window, Esc exits; it must not cover the window's minimize/close buttons |
| Switching session on the left | The target on the right follows (for bound sessions); child agents still show the parent session's target |

The `engagements/<id>/agents/*.md` of existing targets **is not changed automatically**. To carry the campaign-planning sentence: reset the prompts on the agents page, or open a new target.

---

## 5. Offline self-check on the intranet machine (when Node is available)

If you copied the whole repository, or have already extracted the plugin into `plugins/de-policy`:

```sh
cd $DSH_HOME/plugins/de-policy
node scripts/verify-redteam-port.mjs
```

Then confirm the skills have landed in the data directory:

```
$DSH_HOME/redteam/skills/campaign-planning.md
$DSH_HOME/redteam/skills/specialist-paths.md
$DSH_HOME/redteam/skills/deepseek-web-intel.md
$DSH_HOME/redteam/skills/score-coverage.md
```

If these four files are missing: quit the host completely and start it once more so `installBundledSkills` can sync. If they are still missing, copy them over from `skills/redteam/` inside the package.

---

## 6. Places not to touch during adaptation

These are the plugin's own rules; do not revert them even when "aligning with upstream" on the intranet machine:

- `dropReservation` in `lib/redteam/tools.js` (without a key it frees only one entry)
- `.env` reading in the same file (accepts `export`, strips trailing `#`)
- The IPv6 multiplier in `lib/redteam/score-rules.js` (at least two colons)
- `enabledOnly: true` on `scoreChain` / `scoreReport` in `store-core.js`
- `sort=priority` in the `vuln-scan` / `exploit` drafts, and `central-system` for `internal`
- `presets/redteam/agent.cordis.yml` (`redteamRole:`, no worker allowed, no model switching allowed)
- The environment adaptation page, `platform-config.js`
- The armor-piercing main path, `lib/default-prompt-inject.*.md`

Credentials are masked by default. For plaintext: pass `secrets: true` through the API; panel downloads stay masked.

Legacy six-section report: add `layout: 'legacy'` to `scoreReport`. The panel does not expose this button.

---

## 7. Where the code lives in the package (edit these when adapting)

| Capability | File |
| --- | --- |
| Report model / markdown | `lib/redteam/store-core.js` (`buildReportV2`, `renderTemplateReport`, `scoreReport`) |
| Report page, situation, full browse, title bar | `lib/redteam/client.js`; after editing you must run `node scripts/build-client.mjs`, because what is actually loaded is the root `client.js` |
| Session binding | `sessions.json` in `store-core.js`; `tools.js` writes one row to disk; `resolveRootSessionId` in `ui.js` |
| Skill bodies | `skills/redteam/*.md` |
| Skill fixes | `lib/redteam/skill-fixes.js` |
| Default role drafts | `DEFAULT_PROMPTS` in `store-core.js` |
| Presets | `presets/redteam/` |

Editing only `lib/redteam/client.js` without rebuilding will not change the desktop/Web UI.

---

## 8. Relationship with upstream (no need to pull it on the intranet machine)

Already ported in:

- 0.14.1 desktop title-bar avoidance
- 0.14.2 desktop full browse in the same window
- 0.14.3 templated report, `campaign-planning`, `specialist-paths`

Deliberately not ported: worker, per-role tool trimming, model switching, moving the 9 attack-chain skills out of the package.

What the plugin adds: environment adaptation, A–F, 27 bundled skills (the upstream bundle has 18).

See `redteam-vs-upstream-0.14.3.md` in the same directory for details.

---

## 9. Common blockers

| Symptom | Handling |
| --- | --- |
| New skills missing from the skill library | Quit the tray completely and start again; or manually copy the md files from the package into `$DSH_HOME/redteam/skills` |
| Report still shows the old cards | The root `client.js` was not rebuilt, or an old tgz is installed. Check whether the embedded block contains `function ReportV2` |
| Role draft lacks the planning sentence | Existing targets are not changed automatically; reset the prompts or open a new target |
| It fights the standalone red team over the database | Uninstall `dsh-redteam-mode` |
| Desktop will not open / title bar is covered | Confirm this 1.1.75 build is installed; full browse uses the same window, Esc exits |
| Marketplace says `already queued` | Do not use the marketplace; only the local tgz + command line |

The fact-base table schema was not migrated. Existing targets' assets, scores, and knowledge base keep working.
