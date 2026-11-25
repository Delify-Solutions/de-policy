# Red Team Inconsistency: Essence Explained

The two sides being compared:

- Upstream: `dsh-redteam-mode` tag **v0.14.3** (`COMMIT_REMOVED`); the implementation of record is `packages/redteam-bundle/`.
- Plugin: `de-policy` **1.1.75**, red team in `lib/redteam/`, `presets/redteam/`, `skills/redteam/`. What the browser actually loads is the embedded block in the root `client.js`.

This document covers only the parts that are **still inconsistent**. The aligned parts (situation page, five sections, session following, templated report skeleton, title bar, full browse) are not expanded here.
The decisions ratified during the port are in `docs/redteam-port-plan-1-3-4-5-6.md`; what is written here are the **real consequences** of those decisions on the runtime.

---

## 0. Look at the three layers first, then the symptoms

The same "red team mode" actually has three layers. Almost all inconsistency originates in the latter two.

| Layer | What it is | Who enforces it | Degree of 0.14.3 alignment |
| --- | --- | --- | --- |
| Panel | The sections, situation, and report layout a human looks at | Nothing enforces it | High |
| Gate | Whether a tool is visible, whether query parameters are honoured, how scores are multiplied, how slots are freed | Platform code; the model cannot circumvent it | Low |
| Persona | How the command/execution roles are told to operate | How reliably the model obeys | Low |

A panel that looks like 0.14.3 does not mean the command and execution roles operate the 0.14.3 way.

Four essential axes (every later section hangs off one of them):

1. **What enforces the responsibility boundary**: upstream trims tools away via presets; the plugin asks roles not to overstep via prompts.
2. **The default play is written in three copies, and query capability does not match**: the source-code default drafts, the command persona, and the existing targets' `agents/*.md` are three copies; upstream's "batch assessment" cannot be expressed at all against the plugin's query API.
3. **How the same fact is computed and displayed**: credential plaintext, IPv6 multiplier, reservation release, `.env` parsing.
4. **Who the package and host follow**: standalone plugin vs. embedded in the purge panel; skill bundle scope; update channel.

---

## 1. Responsibility boundary: hard isolation vs. soft isolation

### Essence

After DSH 0.2.1, a child session's persona and tool set can no longer be written on `tool-subagent`'s `persona` / `toolFilter` (doing so throws inside `apply()`).
Upstream's solution: **attach a separate set of execution-role presets**, so the child session enters a different Agent Preset.
The plugin's solution: **the child session stays inside the main preset**, and the role draft is injected into the system prompt via `redteamRole:` on the first line of the task.

This is not "a few yml files are missing". It is "overstepping is rejected by the platform" vs. "overstepping relies on the model's self-discipline".

### Upstream

Main preset `presets/redteam/agent.cordis.yml`:

- `tool-subagent.agentPreset` defaults to `redteam-worker`
- Allowed preset list: `redteam-worker`, `redteam-worker-recon` / `assess` / `vuln-scan` / `exploit` / `internal`
- The command persona requires passing `agent_preset=redteam-worker-<role>` when dispatching work

Each `worker-*.cordis.yml`:

- Its own persona: you are a leaf; this preset has no delegation tools
- `redteam-tools` with `config.profile: recon|assess|…`
- **Does not attach** `subagent` / `subagent_fork` / `workflow` / `ralph`

`PROFILE_EXCLUDES` in `lib/tools.js` removes out-of-boundary write tools from the registry per profile. The consequence of an omission is "one extra tool visible", not "a critical tool trimmed away". Typical trimming:

| Role | Cannot see (excerpt) |
| --- | --- |
| recon | assess, record vulnerability, record credential/implant/tunnel, scoring, produce report, edit prompts, knowledge-base writes, delete screenshots |
| assess | record vulnerability, record entry point, scoring, produce report, edit prompts |
| vuln-scan | assess, record implant/tunnel, modify scoring points, produce report |
| exploit | assess, modify scoring points, produce report |
| internal | modify scoring points, produce report |

When recon calls `redteam_score_hit`: **the tool does not exist**; calling it is simply a failure.

### Plugin

Only `presets/redteam/agent.cordis.yml`. No `worker-*.cordis.yml`.

`apply(ctx)` in `lib/redteam/tools.js` **does not read the profile**; it registers every red team tool at once.

The child-session path:

1. The command role writes `redteamRole: recon` on the first line of the `subagent` `prompt` (only five codes are allowed)
2. `lib/redteam/role-section.js` records the role when the child session claims the user message
3. When `lib/index.js` assembles the system prompt, it inserts `$DSH_HOME/redteam/engagements/<current target>/agents/<code>.md`
4. Without that line the role is not guessed; the child session runs with the main preset's tool set

The child session and the command role see the same tool set, including delegation tools. The leaf constraint exists only in the draft text.

`modelSelectionSettings`: the plugin's main preset locks it to `false`, and `lib/redteam/index.js` also rewrites a `true` in the user's copy back to `false`. Upstream's worker side can enable model selection.

### Functional difference

| Behaviour | Upstream | Plugin |
| --- | --- | --- |
| Dispatch parameter | `agent_preset` | `redteamRole:` on the first line |
| recon scores / creates tunnel | Tool absent, fails | Tool present, only the draft discourages it |
| Execution role spawns `subagent` again | Tool absent | Tool present |
| How the role draft reaches the child session | The command role fetches it with `redteam_role_prompt` and pastes it into the task description | The platform injects `agents/<code>.md` based on the first line; the draft instructs **not** to paste the full text into the task |
| Model switching | worker can enable it | Hard-locked |

### Impact

- **Overstepping really does happen.** The reconnaissance role can score, create tunnels, and change report configuration; the intranet role can delegate one more layer. Upstream blocks all of these at the platform level.
- When the command role forgets to write `redteamRole:`, the plugin's child session has no role draft but still has the full tool set. Upstream, a missing `agent_preset` falls back to the default `redteam-worker` (all tools, but still no delegation tools).
- This is port-plan **decision 2**: "do not install worker". It is not a missed port. To align with upstream you must simultaneously add worker presets, `PROFILE_EXCLUDES`, and change the dispatch wording; editing prompts alone cannot close a gate.

---

## 2. Default play: three copies, and the queries do not match

### Essence

How a role operates does not depend on what the panel looks like; it depends on the draft the model reads, and on whether the platform honours the query parameters named in that draft.

There are three copies of the draft; changing one does not automatically change the other two:

| Copy | Location | When it takes effect |
| --- | --- | --- |
| Source default | `DEFAULT_PROMPTS` in `lib/redteam/store-core.js` | Only written into `agents/*.md` when a target is **newly created** |
| Command persona | The persona of `presets/redteam/agent.cordis.yml` | Read every time the main session is assembled; a restart applies changes |
| Target copy | `$DSH_HOME/redteam/engagements/<id>/agents/*.md` | This is what execution roles actually read; old targets do not follow source updates |

So "prepended `campaign-planning` in the source" only affects new targets. Old targets must have their prompts reset on the agents page.

A more critical layer: **upstream 0.14.3's asset-triage play is built on query parameters the plugin does not have.** This is not one sentence of wording; it is two missing knobs on the gate.

### 2.1 Asset triage: full enumeration one by one vs. batching high-value items

#### Upstream

The query layer (`listAssets` + `redteam_asset_query`) has two more knobs:

- `assessed=yes|no`: filter by whether `assessed_at` is empty
- `sort=unassessed`: unevaluated (`assessed_at IS NULL`) sorts first
- `offset`: for the model to page through

The default draft (`DEFAULT_PROMPTS.assess`) writes the play around these knobs:

- Batch by risk, 50 per batch, no requirement to finish in one pass
- `assessed=no` + `sort=unassessed` + `offset`/`limit` to page
- `potential` must write the scoring-point **code** (`server-host`, `central-system`…)
- When information is missing, prefer reusing existing gogo/nmap output rather than re-running `nmap -sV` over everything for assessment
- Assessment results land only in `redteam_asset_assess`; do not also write `redteam_asset_test` for each row (to avoid mixing assessment state with test state)
- The intranet role uses the same parameters when doing its own triage

#### Plugin

Query layer:

- `listAssets` has **no** `assessed` filter and **no** `sort=unassessed`
- The sort enum of `redteam_asset_query` is only `priority | todo | ports | ip`
- Tool parameters **do not expose** `offset` (the store has offset internally, but if the model passes it, it never reaches the query)
- The `assessed_at` column exists and `redteam_asset_assess` writes it, but **there is no way to query "only the unevaluated"**

The default draft is still the old play:

- "Sampling is not allowed, looking only at the first N rows is not allowed; if there are 300 hosts, cover 300; if 3000, cover 3000"
- Uses `sort=todo` to fetch "unevaluated" — see the next subsection; this word is being used incorrectly
- `potential` writes the Chinese result name (account privilege / WebShell / core system), not the mandatory code
- When information is missing, fill in with httpx / `nmap -sV`
- After assessment it also writes `redteam_asset_test` (`status=untested` + assessment summary)
- Only a single `specialist-paths` sentence is prepended at the start

#### Functional difference

Upstream assessment is "produce the first 50 that are attackable, then take the next batch".
Plugin assessment is "work is not done until the list is empty".

Even if the upstream assess draft were pasted into the plugin verbatim, the model calling `assessed=no` / `sort=unassessed` / `offset` would have those dropped or rejected at the tool layer. To align the play you must first extend the query API, then change the draft.

#### Impact

- On large targets, plugin assess spins idle: the time box is exhausted while it is still paging, and the command role cannot dispatch vuln-scan for a long time.
- Upstream allows "assess high-value items first, the rest next round"; the plugin draft treats that as a violation.
- The plugin's `potential` writes Chinese, while later vuln-scan / scoring must match on code — one more guess per asset.

### 2.2 Assessment state and test state are conflated by the plugin draft

#### Essence

The database has always had two columns:

- `assessed_at`: whether asset triage has evaluated attackability
- `test_status`: whether vulnerability discovery has tested it (untested / testing / tested / abandoned…)

An asset can be "assessed, not tested", or "not assessed, already touched by another role".

#### Upstream

`sort=todo` = pending **test** first (reads `test_status`).
`sort=unassessed` + `assessed=no` = pending **assessment** first (reads `assessed_at`).
The assess draft uses the latter; vuln-scan uses database queries + test status. The two axes are separate.

#### Plugin

Only `sort=todo` (pending test) and `sort=priority` (attackability).
Yet the assess draft says: use `sort=todo` to fetch unevaluated assets, until `sort=todo` returns no unevaluated ones.

`sort=todo` pushes `untested` to the top **regardless of whether it has been assessed**. Assets that were assessed but not tested keep reappearing in the assess queue; assets that were tested but never assessed sink to the bottom instead.

#### Impact

Asset triage and vulnerability discovery compete for the same "to-do" queue. The assessment progress number (assessed / total) does not match the model's own belief that "I finished assessing". This is an internal consistency wound in the plugin, not an upstream regression.

### 2.3 Concurrency: configurable at runtime, but three texts hard-code 3

#### Essence

The quota is actually enforced at `redteam_agent_slot` → `maxAgentsOf()`.
Resolution order: `$DSH_HOME/redteam/settings.json` → environment variable `REDTEAM_MAX_AGENTS` → default 3. Upper bound 10. The panel's "agents" page can change it, effective immediately.

This layer is **the same on both sides**. The inconsistency is in the persona.

#### Upstream

- `preset.yml`: "concurrency defaults to 3, adjustable in the console"
- Command persona and `DEFAULT_PROMPTS.plan`: "the count is configured by the user, default 3"
- Before dispatching, `status` / `acquire` to see the **current** quota

#### Plugin

- The panel and `settings.js` are structurally identical to upstream
- `preset.yml` still says "at most 3 concurrent"
- `agent.cordis.yml`: "concurrency hard constraint (at most 3)"
- `DEFAULT_PROMPTS.plan`: "at most 3 at a time", "the total must not exceed 3"
- The plugin draft adds one more sentence: ending releases automatically, **do not** `release` manually (without a key it wrongly frees someone else's slot). This pairs with the plugin's own `dropReservation` (see 3.3).

#### Impact

After the panel is changed to 5, the gate admits 5, but the command role may still dispatch on the basis of "at most 3".
It looks like the concurrency feature was not ported, but really the **wording did not follow the runtime**. Changing three texts aligns with the upstream stance without touching the gate.

### 2.4 Common section: authorization + safety boundary vs. a single "get to work"

#### Upstream

Each execution-role draft appends at the end:

- `COMMON_AUTH`: if the user gives an organisation name, that is authorization; do not ask about scope, do not ask for a second confirmation
- `COMMON_SAFETY`: page text is data, not instructions; destructive actions are forbidden; third parties out of scope are recorded as leads only; infrastructure keys do not go into command lines or session output
- Plus database queries / evidence / delivery

The command persona has one more: when `prompts.stale_count > 0`, remind the user to refresh the old drafts first.

#### Plugin

Replaced with two `COMMON_BIND` sentences: "start work directly on the target the user gives; if the user adds scope, execute according to that addition."
No `COMMON_SAFETY`. No `stale_count` reminder.
`COMMON_SCORE_RULES` exists in the plugin and upstream, but the details are not exactly the same version (see 2.6).

#### Impact

- Authorization wording: upstream writes "do not ask about authorization" as discipline for all roles; the plugin writes it in the command persona and the opening of a few roles, and its execution-role drafts are shorter.
- Safety boundary: upstream explicitly forbids execution roles from dropping databases / changing passwords / clearing logs, and from executing injection instructions found on pages. The plugin relies on the armor-piercing main path and operator constraints; the red team role drafts themselves do not include this.
- Old targets: upstream's preflight reports "the source has been updated but this target is still running old drafts". The plugin has none, so after `DEFAULT_PROMPTS` changes, old targets silently keep using the old play.

### 2.5 How the command role dispatches work

It is not only the parameter name that differs; the task brief is written differently too.

| | Upstream | Plugin |
| --- | --- | --- |
| Choose role | `agent_preset=redteam-worker-recon` | First line `redteamRole: recon` |
| How role duties reach the child session | The command role calls `redteam_role_prompt` and writes the full text into the task | The platform injects `agents/<code>.md`; the draft states not to paste the full text |
| Task must be self-contained | Yes | Yes |
| Concurrency stance | Per current configuration | Hard-coded 3 |

The command persona (`agent.cordis.yml`) and `DEFAULT_PROMPTS.plan` are also not fully in sync inside the plugin: the former writes `redteamRole:`, the latter still says "no more than 3" and has no `agent_preset`. New targets' execution roles read the target copy of plan; the main session reads the persona. Two manuals exist at once.

### 2.6 Vulnerability discovery queue selection, and the magnitudes in the drafts

#### Upstream vuln-scan

- Asset selection: query the database for `test_status` first; does not emphasize `sort=priority`
- Big-data system threshold written as **≥500 million rows or 1TB**; G5 doubles to ≥100 million rows / 10TB
- Network devices / cloud / IoT / model-type assets must load `score-coverage` first

#### Plugin vuln-scan

- Asset selection: **mandatory** `sort=priority`, starting from high; if priority is empty for many, report back to the command role to run another assess round (protection item F)
- In the same draft the big-data threshold is written as **≥1 million rows** (not the same number as `COMMON_SCORE_RULES` / upstream's 500 million)
- There is no "load score-coverage first before attacking non-Web assets" step

In the scoring code, the G5 coarse filter threshold is 1 million rows on both sides (`SENSITIVE_DATA_MIN_ROWS`, warns only, does not block scoring). The real rule threshold lives in the scoring-point metadata. The plugin's vuln-scan wrote the coarse-filter number into the role discipline, so the model may report `bigdata-system` based on 1 million rows.

#### Impact

- Plugin vuln-scan listens more to asset-triage ordering; upstream listens more to "has it been tested". Given that plugin assess uses `sort=todo` incorrectly, the two amplify each other.
- For the same database-dump evidence, a plugin role may record a big-data system at 1 million rows, while the upstream draft requires 500 million.

### 2.7 Planning skills: the files are there, the play did not change

The plugin has all four md files: `campaign-planning`, `specialist-paths`, `score-coverage`, `deepseek-web-intel`.

Upstream 0.14.3 did two things: add the skills, **and** change the main session / assess / each execution role to start work according to those skills (plan first, classify first, write the code into potential).

The plugin did only the first; the second is replaced by prepending a sentence or two, and the assess / vuln-scan bodies are still the old workflow.

Seeing the skills in the library does not equal the command role doing campaign planning first. Old targets do not even get the prepend.

---

## 3. The same fact: how it is computed, how it is displayed

### 3.1 Report credential default is the opposite

#### Essence

The 0.14.3 release notes say: "the score summary table shows plaintext credentials per report configuration".
The implementation lands in `options.secrets` of `buildReportV2` / `renderTemplateReport`. The panel download goes through `scoreReport`, and **neither side passes secrets**, so the function default applies.

#### Upstream

`renderTemplateReport`: `showSecrets = options.secrets !== false`
No parameter passed → **plaintext**.

#### Plugin

`buildReportV2` / `renderTemplateReport`: plaintext only when `options.secrets === true`
No parameter passed → **masked** (`••••`). A comment states that local viewing requires `secrets: true`.

The panel's "credentials and files" masks by default on both sides via `SecretText`. What differs is the **delivered report** (page table + downloaded md).

#### Impact

Same target, same download button: the upstream report can be handed over with passwords visible; the plugin report is masked by default.
To align the plugin with the 0.14.3 delivery stance you change the default value, not the report structure. The structure is already the three-section v2.

### 3.2 IPv6 multiplier (G6 ×3)

#### Essence

`scoreMultiplierOf()` not only looks at `ip_version === 6`; it also scans the `target` string with a regex. A looser regex makes an intranet `hostname:port` be treated as IPv6.

#### Upstream

```text
/(^|\/\/)[0-9a-f]{0,4}:[0-9a-f:]+/i
```

One colon suffices. `dc01:389` and `ad01:8080` match.

#### Plugin (protection item C)

```text
/(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i
```

At least two colons, or the `[ipv6]` form.

#### Impact

The same `dc01:389` domain-controller result: upstream silently ×3, the plugin ×1.
The plugin side is a deliberate fix for false positives, not a missed port. When comparing scores, do not treat the upstream report as the ground truth.

### 3.3 Concurrency reservation: free one without a key vs. free everything

#### Essence

`redteam_agent_slot action=acquire` first takes a placeholder in an in-memory Map; once the child agent starts, the running count in the registry is authoritative.
When `action=release` carries no `key`, how many reservations are deleted determines whether overselling happens.

#### Upstream

`key === undefined` → `reservations.delete(rootId)`, clearing that root session's reservations **in one go**.

#### Plugin (protection item A)

`key === undefined` → delete only the oldest entry by timestamp.
The tool description and the command draft are both written around "without a key, free only one".
The `subagent/end` callback matches by childId first, and falls back to the oldest entry if no match.

#### Impact

With two in-flight reservations, the model forgets the key and calls `release`:

- Upstream: both slots are freed, possibly overselling (the gate thinks it is empty while tasks are still starting)
- Plugin: only one is freed, the other is still held

The plugin is more conservative. Upstream is more like "release means clear the field". Do not test the plugin's slot against upstream semantics.

### 3.4 Whether `.env` accepts `export`

#### Essence

`redteam_preflight` merges `process.env` and `$DSH_HOME/.env`. When the user writes `export FOFA_KEY=...` out of shell habit, whether the parser accepts it decides whether preflight says "key missing" or "usable".

#### Upstream

```text
/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
```

Does not accept a leading `export`, and does not strip trailing `#`.
`export FOFA_KEY=xxx` is dropped whole → preflight reports a missing key.
`FOFA_KEY=xxx # note` swallows `# note` into the value.

#### Plugin (protection item B)

```text
/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
```

Accepts `export`; when the value is unquoted, strips `\s+#.*$`.
It also uses `mergeConfigEnv` to merge env written into `config.json` by the environment adaptation page.

#### Impact

The same `.env`: upstream preflight is red, plugin preflight is green (or the reverse: upstream swallows the comment into the key and the FOFA request fails).
Intranet machines are right to write `export KEY=value # note` per the plugin docs; handing that file as-is to the standalone upstream plugin makes it fail.

### 3.5 Already aligned; stop treating these as differences

`scoreChain` / `scoreReport` pass `{ enabledOnly: true }` on both sides. Disabled scoring points do not enter the total.
The older comparison's "D = plugin ahead, upstream lacks it" is outdated.

---

## 4. Who the package and host follow

### 4.1 Console shell

#### Essence

The red team UI is not a standalone site; it is a block mounted on the host page. How it is mounted determines whether it covers the title bar and whether it competes with the purge panel for space.

#### Upstream

A fixed overlay on the right (`.rt-dock`), using `:has()` to add padding to the main conversation area. That is the "red team mode right sidebar".

#### Plugin

A draggable, resizable floating window embedded in the purge panel; fullscreen goes through `.rt-full` + `clampRtGeom` (the 0.14.1/0.14.2 title-bar avoidance is already merged).

#### Impact

The functional pages (situation/assets/report) are there, but the interaction feel is not the same set. Do not look for shortcuts, edge docking, or spatial relationships with the main UI based on upstream screenshots.

### 4.2 Skill bundle scope

The upstream bundle has **18** md files. The release notes say "27 total" — the other 9 attack-chain skills do not ship with the npm package and require a separate toolkit.

The plugin bundles **27**. The extra 9:

`chisel-tunnel` `credential-attack` `frp-tunnel` `lateral-movement` `shell-handler` `suo5-tunnel` `unauth-exploit` `vps-reverse-shell` `webshell-toolkit`

This is **decision 7**: when the intranet machine cannot obtain the toolkit, these 9 are still in the package.
Functionally, plugin execution roles can load tunnel/implant/lateral skills more directly; upstream needs a toolkit directory first.

### 4.3 Environment adaptation page

Upstream does not have it. The plugin's resource section has `EnvTab`, which reads and writes `$DSH_HOME/redteam/config.json` so that Windows or Kali-less machines can fill in tool paths and env.
`redteam_preflight` merges this configuration into the effective environment variables.

This is **decision 8**: it must not be removed when porting upstream UI. Without it, an intranet Windows machine can only rely on `$PATH` for tool paths.

### 4.4 One-click update

Both panels have a VersionBar, but they do not target the same package.

| | Legacy panel | This plugin |
| --- | --- | --- |
| Version check | npm `dsh-redteam-mode` | The distribution repository (this package is not on npm) |
| Restart after install | `dsh web` | The current host (official exe / community build / `dsh web`) |

On an intranet machine without GitHub, the plugin's "check for updates" fails and only shows the current version. This is expected; the red team feature is not broken.

### 4.5 Do not install the standalone upstream package alongside

Both write `$DSH_HOME/redteam` (fact base, `settings.json`, `sessions.json`, `engagements/`).
Installing `dsh-redteam-mode` alongside fights over the same database and presets (**decision 9**).
Intranet adaptation carries only the `de-policy` tgz; see `docs/redteam-offline-adapt.md`.

---

## 5. Master table

Sorted by impact on real engagement outcomes. The level means "with the same target and the same operator, would the two sides produce different results".

| Level | Essential axis | Symptom | Upstream | Plugin | What to change to align |
| --- | --- | --- | --- | --- | --- |
| High | 1 hard/soft isolation | Role overstepping, re-delegation | worker + trimmed tools | `redteamRole:` + all tools | Add worker and `PROFILE_EXCLUDES`, change dispatch wording (opposite of decision 2) |
| High | 2 play + query | Asset triage duration, batching | `assessed` / `unassessed` / `offset` + batching draft | No such parameters + full-enumeration draft | **Extend the query API first**, then change the assess draft; old targets also need a reset |
| High | 2 play | Assessment/test queues tangled | Two columns, two sorts | Draft uses `sort=todo` as "unevaluated" | Change the draft, ideally add `assessed` at the same time |
| High | 3 display | Delivered report passwords | Plaintext by default | Masked by default | Change the `secrets` default |
| Medium | 2 wording | Panel concurrency changed, command still dispatches 3 | All three texts say configurable | All three texts hard-code 3 | Change persona / `DEFAULT_PROMPTS.plan` / `preset.yml` |
| Medium | 3 scoring | `host:port` ×3 | Regex accepts one colon | At least two colons | Change `scoreMultiplierOf` (would revert C) |
| Medium | 3 gate | release without a key | Clears reservations | Frees only the oldest | Change `dropReservation` (would revert A) |
| Medium | 3 preflight | `export` in `.env` | Not accepted | Accepted, strips `#` | Change the parser (would revert B) |
| Medium | 2 play | Where vuln-scan starts, big-data threshold | Does not emphasize priority; 500 million rows | `sort=priority`; draft says 1 million rows | Change the vuln-scan draft (touches F) |
| Medium | 2 copies | Source changed, old targets unchanged | Preflight reports `stale_count` | Does not report | Add freshness to preflight; or state clearly in docs that a reset is mandatory |
| Low | 2 skills | Planning / classification | Skills + role drafts rewritten wholesale | Skills + a sentence or two prepended | Change the `DEFAULT_PROMPTS` bodies |
| Low | 4 host | Right sidebar vs. floating window | overlay | Embedded in the purge panel | Change the shell; unrelated to the play |
| Low | 4 skill bundle | Attack-chain skills in the package or not | bundle 18 | bundled 27 | Decision 7; intranet machines should keep the plugin |
| Low | 4 adaptation | Filling tool paths on Windows | None | `EnvTab` | Decision 8; should stay |
| Low | 4 update | Which package one-click update targets | npm red team package | GitHub de-policy | Keep the plugin channel |

---

## 6. Things not to conflate when reading this

- **A similar panel ≠ a similar play.** The situation/report layout is complete, but the command role still dispatches per the plugin's old draft.
- **Skill files present ≠ roles operate by the skills.** `campaign-planning` is in the skill library, and the main session may still dispatch recon directly.
- **The panel can change concurrency ≠ the command role dispatches per the new cap.** The gate listens to `settings.json`; the persona listens to "at most 3".
- **The `assessed_at` column exists ≠ you can query by unevaluated.** The column is written, the filter is missing.
- **`sort=todo` ≠ unevaluated.** todo is pending test (`test_status`); unassessed is pending assessment (`assessed_at`).
- **`scoreChain`'s `enabledOnly` is already aligned.** Stop listing it as a difference.
- **The armor-piercing draft (`lib/default-prompt-inject.*.md`) is not the red team role draft.** Two separate prompt sets; do not compare it against 0.14.3.

---

## 7. Related documents

| Document | What it governs |
| --- | --- |
| This document | The essence of the inconsistency, the current state of both sides, the impact |
| `docs/redteam-vs-upstream-0.14.3.md` | Aligned checklist, which files changed this round, A–F acceptance |
| `docs/redteam-port-plan-1-3-4-5-6.md` | Why worker was not ported, why environment adaptation was kept |
| `docs/redteam-offline-adapt.md` | How to install on an intranet machine, do not pull upstream |

To align a given row: look at section 5's "what to change to align" first, then edit. Query-related items (2.1) and isolation-related items (1) cannot be fixed by editing md alone.
