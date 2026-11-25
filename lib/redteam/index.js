/**
 * de-policy workbench bootstrap (host side)
 *
 * Asset store, tools, presets and skills all live inside this plugin directory. This file:
 *   1. seeds `presets/redteam` into `$DSH_HOME/.agent-presets/redteam/` on first run
 *   2. copies bundled skills to `$DSH_HOME/redteam/skills`, which presets reach via `dshHomePath`
 *   3. for existing user presets, fixes only stale paths / old package names, never overwrites all
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'
import { installTeamMode } from './team-mode.js'
import { holdOwnedPresetAlive, scheduleOwnedSelectedDefaultSweep } from '../preset-default.js'

/** Cordis plugin name. */
export const name = 'de-policy-redteam'

/** As in Liang Shen: no hard dependency on agentPresets; soft-get and declare once ready. */
export const inject = []

/** Preset id shown in the mode dropdown (directory name / registry id). */
const REDTEAM_PRESET_ID = 'redteam'

/** Plugin root (lib/redteam → two levels up). */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills', 'redteam'),
    setupScript: join(root, 'scripts', 'redteam-setup.sh'),
  }
}

/** `$DSH_HOME` may be the plugin env or `homedir()/.dsh`. Repair both when both exist. */
function dshHomeCandidates() {
  const out = []
  const push = (p) => {
    if (!p) return
    const n = String(p).replace(/[\\/]+$/, '')
    if (!n || !existsSync(n)) return
    const key = n.replace(/\\/g, '/').toLowerCase()
    if (out.some((x) => x.replace(/\\/g, '/').toLowerCase() === key)) return
    out.push(n)
  }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

/** Environment data directory (same convention store/tools use). */
export function redteamDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * Drop the bundled environment install script at `$DSH_HOME/redteam/setup.sh`.
 *
 * Marketplace users end up with only node_modules; the repo is not on disk, so a preflight
 * that only says "fetch the script from the repo" leaves them without it and onboarding breaks.
 * The script ships with the bundle; a runnable copy is written at startup.
 * Semantics: missing -> install; differs -> overwrite (no user state);
 *       same content -> leave it (no disk write on every start).
 * @returns `{ action: 'installed'|'updated'|'kept'|'missing', path }`
 */
export function installSetupScript() {
  const paths = packagePaths()
  const primary = join(redteamDataDir(), 'setup.sh')
  if (!existsSync(paths.setupScript)) return { action: 'missing', path: primary }
  let wanted
  try {
    wanted = readFileSync(paths.setupScript, 'utf8')
  } catch {
    return { action: 'missing', path: primary }
  }
  const writeOne = (target) => {
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      let current
      try { current = readFileSync(target, 'utf8') } catch { current = '' }
      if (current === wanted) {
        try { chmodSync(target, 0o755) } catch { /* ignore */ }
        return 'kept'
      }
      writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
      return 'updated'
    }
    writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
    return 'installed'
  }
  try {
    const homes = dshHomeCandidates()
    const targets = homes.length
      ? homes.map((home) => join(home, 'redteam', 'setup.sh'))
      : [primary]
    let action = 'kept'
    for (const target of targets) {
      const one = writeOne(target)
      if (one === 'installed' && action === 'kept') action = 'installed'
      if (one === 'updated') action = 'updated'
    }
    return { action, path: primary }
  } catch (error) {
    return { action: 'missing', path: primary, error: error && error.message ? error.message : String(error) }
  }
}

/** User preset root (matches USER_PRESET_DIR in dsh-agent-presets). */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * Placeholder for the skills directory in the preset template (build.mjs writes it into the
 * packaged preset; substituted at install time). Any other extension form breaks substitution.
 */
const SKILLS_PLACEHOLDER = '{{REDTEAM_SKILLS_DIR}}'

/** The customSkillDirs line that looks like this package's skills/ dir (old absolute paths count too). */
function isSkillsDirLine(line) {
  const text = line.trim().replace(/^-\s*/, '')
  if (text === SKILLS_PLACEHOLDER) return true
  return /[/\\](dsh-redteam-mode|redteam-bundle)[/\\]skills\/?$/.test(text)
    || /[/\\]vendor[/\\]redteam[/\\]skills\/?$/.test(text)
    || /[/\\]skills[/\\]redteam\/?$/.test(text)
}

/** The bundled-skills line in the preset. Resolved against the current DSH_HOME, no local absolute path. */
const BUNDLED_SKILLS_EXPR = "!!js dshHomePath('redteam/skills')"

/**
 * Rewrite the placeholder or hardcoded local path to `dshHomePath('redteam/skills')`.
 *
 * A placeholder left in YAML parses as an object and the whole preset fails to mount. A
 * hardcoded `profiles/desktop/node_modules/...` only works on that one desktop install —
 * web, another machine, or a moved install all point nowhere. installBundledSkills puts
 * the skill files under `$DSH_HOME/redteam/skills`.
 */
function renderSkillsDir(text) {
  if (text.includes(SKILLS_PLACEHOLDER)) {
    return { text: text.split(SKILLS_PLACEHOLDER).join(BUNDLED_SKILLS_EXPR), changed: true, reason: 'placeholder' }
  }
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!isSkillsDirLine(line)) return line
    const indent = /^(\s*)/.exec(line)[1]
    const wanted = indent + '- ' + BUNDLED_SKILLS_EXPR
    if (line === wanted) return line
    changed = true
    return wanted
  }).join('\n')
  return { text: out, changed, reason: changed ? 'stale-path' : 'none' }
}

/**
 * Skill sync targets (first is primary, the rest are best-effort copies).
 *
 * `$DSH_HOME` has two sources: the plugin `process.env.DSH_HOME || homedir()/.dsh` and
 * the home host `dshHomePath()` resolves. On moved disks, switched profiles or an empty
 * `HOME` they diverge: skills land on one side while the preset points at the other, so
 * they "install but never list". Always write the primary; add the other real home only.
 */
function skillSyncTargets() {
  const primary = join(redteamDataDir(), 'skills')
  const dirs = [primary]
  for (const home of dshHomeCandidates()) {
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

function existingRedteamPresetFiles() {
  return dshHomeCandidates()
    .map((home) => join(home, '.agent-presets', 'redteam', 'agent.cordis.yml'))
    .filter((fp) => existsSync(fp))
}

/**
 * Sync packaged `skills/redteam/*.md` to `$DSH_HOME/redteam/skills` (both homes when they
 * diverge); same-named files take the packaged content. User copies in `$DSH_HOME/skills` stay.
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/** After migrating from the standalone redteam package, tool row package names must follow. */
function renderToolsPackage(text) {
  const src = String(text || '')
  // Old package names must all normalize to the current one. Matching only dsh-redteam-mode
  // leaves `dsh-purge/redteam/tools` / `dsh-purgee/redteam/tools` in early user copies unresolvable →
  // redteam-tools is always never started → the whole preset is registered-broken →
  // the mode dropdown never shows "redteam mode" at all.
  let next = src
  for (const pattern of [
    /dsh-redteam-mode\/tools/g,
    /dsh-purgee\/redteam\/tools/g,
    /dsh-purge\/redteam\/tools/g,
    /dsh-purge\/tools/g,
  ]) {
    next = next.replace(pattern, 'de-policy/redteam/tools')
  }
  if (next === src) return { text: src, changed: false }
  return { text: next, changed: true }
}

/**
 * 0.2.2+ folded `list_agents` into the dsh-tool-subagent-control entry; the
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents` subpath is no longer exported.
 * An old preset keeping that row makes the registry report never started forever (the tool
 * is still registered by the main package), marking the whole preset registered-broken.
 */
function disableUnavailableListAgents(text) {
  const id = 'tool-subagent-list-agents'
  if (!text.includes(id)) return { text, changed: false }
  let available = false
  try {
    available = hostHasPackage('@deepseek-ai/dsh-tool-subagent-control/list-agents')
  } catch {
    available = false
  }
  if (available) return { text, changed: false }
  return setRowDisabled(text, id, true)
}

/**
 * 0.2.1 `dsh-tool-subagent` throws on seeing config.toolFilter and the whole preset becomes
 * registered-broken. Strip only that key and its nested allow/deny; leave the rest untouched.
 */
function stripDeprecatedToolFilter(text) {
  const src = String(text || "")
  const nl = src.includes("\r\n") ? "\r\n" : "\n"
  const lines = src.split(/\r?\n/)
  const out = []
  let skipping = -1
  let changed = false
  for (const line of lines) {
    if (skipping >= 0) {
      if (!line.trim()) continue
      const indent = line.match(/^([ \t]*)/)[1].length
      if (indent > skipping) continue
      skipping = -1
    }
    const key = line.match(/^([ \t]*)toolFilter:[ \t]*(?:#.*)?$/)
    if (key) {
      changed = true
      skipping = key[1].length
      continue
    }
    if (/^[ \t]*toolFilter:[ \t]+[^#\s]/.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  if (!changed) return { text: src, changed: false }
  return { text: out.join(nl), changed: true }
}

/** 0.2: a child on Claude keeps official identity, so inject = jailbreak; lock spawn leaves only. */
function disableSubagentModelSelection(text) {
  const src = String(text || "")
  const idLine = "- id: tool-subagent"
  let next = src
  let changed = false
  let from = 0
  while (from < next.length) {
    const at = next.indexOf(idLine, from)
    if (at < 0) break
    const endId = at + idLine.length
    const ch = next[endId] || "\n"
    if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
      from = endId
      continue
    }
    const rest = next.slice(endId)
    const endRel = rest.search(/\n[ \t]*- id: /)
    const block = endRel < 0 ? rest : rest.slice(0, endRel)
    if (!/toolName:\s*(?:subagent\b|['"]subagent['"])/.test(block)) {
      from = endId + block.length
      continue
    }
    let patched = block
    if (/modelSelectionSettings:\s*(?:true\b|['"]true['"])/.test(patched)) {
      patched = patched.replace(/modelSelectionSettings:\s*(?:true\b|['"]true['"])/, "modelSelectionSettings: false")
    } else if (!/modelSelectionSettings\s*:/.test(patched)) {
      patched = patched.replace(
        /^([ \t]+)toolName:\s*(?:subagent\b|['"]subagent['"])[^\n]*/m,
        (line, indent) => `${line}\n${indent}modelSelectionSettings: false`,
      )
    }
    if (patched !== block) {
      next = next.slice(0, endId) + patched + next.slice(endId + block.length)
      changed = true
      from = endId + patched.length
      continue
    }
    from = endId + block.length
  }
  return { text: next, changed }
}

/**
 * The "team task board / waiting" sections of the red-team commander prompt. They pair with
 * the Team switch and tool-schedule: without a shared task board the model must not look for
 * `team_task_*` (a missing tool fails the call), and without `wait_agent` it must not block.
 *
 * Insert by marker, never overwrite the whole section: user text in between is preserved.
 */
const TEAM_BOARD_MARK = "## Shared task board (Agent Teams"
/* Legacy headings: presets installed by older builds still carry the Chinese section titles.
   They must count as "already present", or the installer appends a second copy of the block. */
const TEAM_BOARD_MARK_LEGACY = "## 共享任务板（Agent Teams"
const WAIT_MARK = "## Waiting and polling (do not spin)"
const WAIT_MARK_LEGACY = "## 等待与轮询（不要空转）"
/* The fingerprint sentence of the current version. `noProgress` only exists since rc.1 and
   the old wording has none of it, so it is the most reliable "already new" test. Update it with the text. */
const WAIT_FRESH_MARK = "noProgress"
const WAIT_SECTION_BLOCK = [
  "      ## Waiting and polling (do not spin)",
  "      Wait only while **subagents are still running**: once the work is dispatched and nothing can "
  + "proceed in parallel, call `wait_agent` (`timeout_ms` 300000) and block. **If no subagent is running, do "
  + "not wait** — hand the conclusion to the user.",
  "      Detect new input via `timedOut`: real input means `timedOut: false` **and no `noProgress` "
  + "field**. Older hosts return `timedOut: false` + `noProgress` immediately when no peer is active — that "
  + "is not a message, it tells you nobody is left to wait for; see it and stop, do not treat it as a "
  + "wake-up.",
  "      It only waits for input **entering the current turn**: subagent messages, subagent completion "
  + "notices, and words sent by the user through steer (interrupting the current turn). **A message the user "
  + "sends with a plain Enter queues for the next turn and does not interrupt this wait** — if you keep "
  + "waiting after they press Enter, they can only watch.",
  "      Do not use `sleep`, do not poll `list_agents` repeatedly, do not invent a block of text for the "
  + "user and call it \"progress\".",
  "      **Wait at most 2 times** (about 10 minutes total): if the second wait still yields nothing, stop "
  + "and state \"where it is stuck, what resource it waits for, what comes next\", then hand control back to "
  + "the user.",
].join("\n")
const TEAM_BOARD_BLOCK = [
  "",
  "      ## Shared task board (Agent Teams, on by default for red team)",
  "      Team collaboration is enabled in this session; use `team_task_create` / `team_task_list` / "
  + "`team_task_get` / `team_task_update` to maintain one shared task board.",
  "      **Creating a card is not dispatching work**: the board is only a coordination ledger, and a card "
  + "built by `team_task_create` never starts on its own; real work must be dispatched separately through "
  + "`subagent`. **Fixed order: create the card, then dispatch with `subagent`, then mark in_progress with "
  + "`team_task_update` once it is open, then mark completed after the subagent reports and you verify.**",
  "      Its only purpose is \"so you do not drop work\"; never use it in place of dispatching:",
  "      - Before starting, split the user's target into 3-8 cards (subject says \"what to do\", "
  + "description carries scope + acceptance criteria + permitted asset tier).",
  "      - `write_scopes` is a hint for collaborators, **not a lock**; red team runs at most 3 executors "
  + "at once, and real conflicts are serialized by your `redteam_agent_slot` order.",
  "      - **Task ids are generated by the host, shaped like `task-1`, `task-2`** (not the bare number "
  + "`1`). `blocked_by` and the `task_id` of `team_task_update` must reuse the id returned at creation "
  + "verbatim; passing `\"1\"` is rejected by the host with `blocker task \"1\" not found`.",
  "      - Card state must match real progress: do not mark completed before the subagent reports, and "
  + "write `blocked_by` when blocked.",
  "      - Advance one or two cards at a time; do not create 30 and then tick them off one by one.",
  "",
  WAIT_SECTION_BLOCK,
].join("\n")
/* Inserted before the role index: user presets may hold old-version text, so try several anchors in order. */
const TEAM_BOARD_ANCHORS = [
  "## The six roles",
  "## Deciding how to start based on user input",
  "## Concurrency hard constraint",
  "## Command responsibilities",
  // Legacy Chinese headings: older user presets still carry them, so they stay as fallbacks.
  "## 六个角色",
  "## 按用户输入决定怎么开工",
  "## 并发硬约束",
  "## 指挥职责",
]

function insertTeamBoardGuidance(text) {
  const src = String(text || "")
  if (src.includes(TEAM_BOARD_MARK) || src.includes(TEAM_BOARD_MARK_LEGACY)) {
    return { text: src, changed: false }
  }
  for (const anchor of TEAM_BOARD_ANCHORS) {
    const at = src.indexOf(anchor)
    if (at < 0) continue
    /* The anchor line's indentation is the section indentation; use it for the whole block. */
    const lineStart = src.lastIndexOf("\n", at - 1) + 1
    const indent = src.slice(lineStart, at)
    const block = indent ? TEAM_BOARD_BLOCK.split("\n      ").join("\n" + indent) : TEAM_BOARD_BLOCK
    /* An anchor may already be preceded by a blank line; appending "\n\n" then yields three blanks.
       So strip the leading blank lines first, then add exactly two. */
    const head = src.slice(0, lineStart).replace(/(?:\r?\n[ \t]*)+$/, "")
    const body = block.replace(/^\n+/, "").trimEnd()
    return { text: head + "\n\n" + body + "\n\n" + src.slice(lineStart), changed: true }
  }
  return { text: src, changed: false }
}

/**
 * Fix the earlier, wrong "waiting" section.
 *
 * Early versions told the model `wait_agent` waits for "the user to speak" — wrong. Host
 * 0.2.2-rc.3 waitForInput only reads `agent.inbox.nextStep`; a plain Enter goes through
 * prompt(mode:"queue") -> followup -> `next-turn` and never reaches nextStep. Only child
 * messages, completion notices and explicit steers wake it, so a model following the wrong
 * text waits forever. Rewrite by section fingerprint, swapping only this section.
 */
function fixStaleWaitGuidance(text) {
  const src = String(text || "")
  if (!src.includes(WAIT_MARK) && !src.includes(WAIT_MARK_LEGACY)) return { text: src, changed: false }
  if (src.includes(WAIT_FRESH_MARK)) return { text: src, changed: false }
  const at = src.indexOf(WAIT_MARK)
  const lineStart = src.lastIndexOf("\n", at - 1) + 1
  const indent = src.slice(lineStart, at)
  /* Section boundary: the next blank line, or the next heading at the same level. */
  const lines = src.slice(lineStart).split("\n")
  let end = lines.length
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) { end = i; break }
    if (line.trimStart().startsWith("## ")) { end = i; break }
  }
  const block = indent ? WAIT_SECTION_BLOCK.split("\n      ").join("\n" + indent) : WAIT_SECTION_BLOCK
  const tail = src.slice(lineStart + lines.slice(0, end).join("\n").length)
  return { text: src.slice(0, lineStart) + block + tail, changed: true }
}

/**
 * Self-heal: commander-duty heading plus re-enabling classic subagent under the Agent Teams
 * profile. Also strips the toolFilter deprecated in 0.2.1. Never overwrites the whole preset.
 */
function repairDelegation(text) {
  let next = String(text || "")
  let delegationChanged = false
  if (next.includes("## 你是谁、你不做什么")) {
    next = next.split("## 你是谁、你不做什么").join("## 指挥职责（硬约束）")
    delegationChanged = true
  }
  /* Backticks are escaped in the packaged template but plain in presets written by hand or by
     older builds, so compare with backslashes stripped: either spelling means "already repaired".
     Without this the wording is re-inserted on every start and the line duplicates. */
  const unescape = (t) => String(t).replace(/\\/g, "")
  const mark = "**Delegation MUST use the native `subagent` tool**"
  const markLegacy = "**必须用原生 `subagent` 工具派活**"
  const dutyLegacy = "## 指挥职责"
  const dutyCurrent = "## Command responsibilities (hard constraint)"
  const hay = unescape(next)
  if ((next.includes(dutyLegacy) || next.includes(dutyCurrent))
    && !hay.includes(mark) && !hay.includes(markLegacy)) {
    const needle = "`redteam_session_info`。"
    const at = next.indexOf(needle)
    if (at >= 0) {
      next =
        next.slice(0, at + needle.length) +
        "\n      " + mark +
        "; do not switch to Agent Teams' `spawn_teammate` (the red-team role prompt, concurrency "
        + "gate and leaf constraint all hang off the `subagent` path)." +
        next.slice(at + needle.length)
      delegationChanged = true
    }
  }
  /*
   * These four rows must stay enabled (red-team tasking rides the tool-subagent path).
   * `tool-subagent-list-agents` is the exception: disableUnavailableListAgents decides it from
   * whether the host exports that subpath. Forcing it on here and then off in the next step
   * makes delegationChanged true on every start — content is identical yet each round rewrites
   * the file and logs "repaired", which looks like endless repair.
   */
  for (const id of [
    "tool-subagent-control",
    "tool-subagent",
    "tool-subagent-fork",
  ]) {
    const idLine = `- id: ${id}`
    let from = 0
    while (from < next.length) {
      const at = next.indexOf(idLine, from)
      if (at < 0) break
      const endId = at + idLine.length
      const ch = next[endId] || "\n"
      // avoid matching tool-subagent-control / fork / codex
      if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
        from = endId
        continue
      }
      const after = endId
      const rest = next.slice(after)
      const endRel = rest.search(/\n[ \t]*- id: /)
      const block = endRel < 0 ? rest : rest.slice(0, endRel)
      if (/disabled:\s*false/.test(block)) break
      if (/disabled:\s*true/.test(block)) {
        const patched = block.replace(/disabled:\s*true/, "disabled: false")
        next = next.slice(0, after) + patched + next.slice(after + block.length)
        delegationChanged = true
        break
      }
      const indentMatch = /\n([ \t]+)name:/.exec(block)
      const indent = indentMatch ? indentMatch[1] : "      "
      next = next.slice(0, after) + `\n${indent}disabled: false` + next.slice(after)
      delegationChanged = true
      break
    }
  }
  const stripped = stripDeprecatedToolFilter(next)
  if (stripped.changed) next = stripped.text
  const locked = disableSubagentModelSelection(next)
  if (locked.changed) next = locked.text
  const composition = repairComposition(next)
  if (composition.changed) next = composition.text
  const listAgents = disableUnavailableListAgents(next)
  if (listAgents.changed) next = listAgents.text
  const teamBoard = insertTeamBoardGuidance(next)
  if (teamBoard.changed) next = teamBoard.text
  /* When the deployed preset already has the task-board section, insertTeamBoardGuidance skips
     it; the waiting section inside may still be the wrong old text, so fix that separately. */
  const staleWait = fixStaleWaitGuidance(next)
  if (staleWait.changed) next = staleWait.text
  return {
    text: next,
    changed: delegationChanged || stripped.changed || locked.changed || composition.changed
      || listAgents.changed || teamBoard.changed || staleWait.changed,
    delegationChanged,
    strippedToolFilter: stripped.changed,
    lockedModelSelection: locked.changed,
    compositionChanged: composition.workflowChanged,
    scheduleInserted: composition.scheduleInserted,
    teamBoardInserted: teamBoard.changed,
    waitGuidanceFixed: staleWait.changed,
    listAgentsDisabled: listAgents.changed,
  }
}

function addRequireCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function hostRequireCandidates() {
  const list = []
  try {
    considerBinRequire(list, process.argv[1])
  } catch { /* ignore */ }
  for (const home of dshHomeCandidates()) {
    addRequireCandidate(list, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default', 'headless']) {
      addRequireCandidate(list, join(home, 'profiles', profile, 'package.json'))
      addRequireCandidate(list, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  addRequireCandidate(list, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addRequireCandidate(list, join('D:', 'DeepseekHarnessDesktop', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return list
}

function considerBinRequire(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* fall back to the original path */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addRequireCandidate(list, `${text.slice(0, at + needle.length - 1)}/package.json`)
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addRequireCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  addRequireCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addRequireCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function hostHasPackage(id) {
  for (const pkg of hostRequireCandidates()) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      createRequire(pkg).resolve(id)
      return true
    } catch { /* try next */ }
  }
  try {
    createRequire(import.meta.url).resolve(id)
    return true
  } catch {
    return false
  }
}

let workflowCapCtx = null

/**
 * If the red-team combo workflow row lacks its package / ptcRuntime, Cordis stays pending and
 * host registry.list() waits for every preset mount, so standard / PTC / minimal vanish too.
 */
function detectWorkflowCaps() {
  const ptc = hostHasPackage('@deepseek-ai/dsh-workflow-ptc')
  const runtimePkg = hostHasPackage('@deepseek-ai/dsh-ptc-runtime-node')
    || hostHasPackage('@deepseek-ai/dsh-ptc-runtime')
  const worker = hostHasPackage('@deepseek-ai/dsh-workflow-worker-thread')
  const tool = hostHasPackage('@deepseek-ai/dsh-tool-workflow')
  let runtimeLive = null
  const ctx = workflowCapCtx
  if (ctx && typeof ctx.get === 'function') {
    try { runtimeLive = ctx.get('ptcRuntime') != null } catch { runtimeLive = false }
  }
  const ptcOk = ptc && (runtimeLive === true || (runtimeLive === null && runtimePkg))
  const engine = ptcOk ? 'ptc' : worker ? 'worker' : 'none'
  return {
    ptc: engine === 'ptc',
    worker: engine === 'worker',
    tool: engine !== 'none' && tool,
  }
}

function rowBlockBounds(text, id, from = 0) {
  const idLine = `- id: ${id}`
  const at = text.indexOf(idLine, from)
  if (at < 0) return null
  const endId = at + idLine.length
  const ch = text[endId] || '\n'
  if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') {
    return rowBlockBounds(text, id, endId)
  }
  const rest = text.slice(endId)
  const endRel = rest.search(/\n[ \t]*- id: /)
  const block = endRel < 0 ? rest : rest.slice(0, endRel)
  return { at, endId, block }
}

function setRowDisabled(text, id, disabled) {
  const hit = rowBlockBounds(text, id)
  if (!hit) return { text, changed: false }
  const want = disabled ? 'true' : 'false'
  if (new RegExp(`disabled:\\s*${want}\\b`).test(hit.block)) return { text, changed: false }
  let patched = hit.block
  if (/disabled:\s*(true|false)/.test(patched)) {
    patched = patched.replace(/disabled:\s*(true|false)/, `disabled: ${want}`)
  } else {
    const indentMatch = /\n([ \t]+)name:/.exec(patched)
    const indent = indentMatch ? indentMatch[1] : '      '
    if (/name:/.test(patched)) {
      patched = patched.replace(
        /(name:\s*'[^']+'[^\n]*)/,
        `$1\n${indent}disabled: ${want}`,
      )
    } else {
      patched = `\n${indent}disabled: ${want}` + patched
    }
  }
  if (patched === hit.block) return { text, changed: false }
  return {
    text: text.slice(0, hit.endId) + patched + text.slice(hit.endId + hit.block.length),
    changed: true,
  }
}

function readWorkflowPtcFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return ''
  }
  const start = template.indexOf('    - id: workflow-ptc')
  if (start < 0) return ''
  const rest = template.slice(start)
  const next = rest.slice(1).search(/\n    - id: /)
  return (next < 0 ? rest : rest.slice(0, next + 1)).trimEnd()
}

function insertWorkflowPtcInGroup(text) {
  if (/\bid:\s*workflow-ptc\b/.test(text)) return { text, changed: false }
  const block = readWorkflowPtcFromTemplate()
  if (!block) return { text, changed: false }
  const needle = '- id: tool-workflow'
  const at = text.indexOf(needle)
  if (at < 0) return { text, changed: false }
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const rendered = block.endsWith('\n') ? block : `${block}\n`
  return {
    text: `${text.slice(0, lineStart)}${rendered}\n${text.slice(lineStart)}`,
    changed: true,
  }
}

/**
 * Red team needs the schedule tools. The host web layer always serves dsh-schedule
 * and the four model-side rows come from presets; official standard / cordis / ptc have
 * them while red team did not, so "official can schedule, red team cannot".
 *
 * **Adds a row only when missing** and never overwrites user config. Placed before
 * `tool-ask-user`; no anchor -> append (cordis row order carries no load semantics).
 */
const SCHEDULE_ROW_MARK = '- id: tool-schedule'
const SCHEDULE_ROW_BLOCK = [
  '',
  '# Scheduled reminders (official dsh-tool-schedule): schedule_create / list / view / edit.',
  '# Sub-session calls are rejected by the host (only the command root session can schedule),'
  + ' which fits red-team division of labour.',
  '- id: tool-schedule',
  "  name: '@deepseek-ai/dsh-tool-schedule'",
].join('\n')

function insertScheduleRow(text) {
  const src = String(text || '')
  if (new RegExp(`^[ \\t]*- id: tool-schedule\\b`, 'm').test(src)) return { text: src, changed: false }
  const anchor = '\n- id: tool-ask-user'
  const at = src.indexOf(anchor)
  if (at >= 0) {
    return { text: src.slice(0, at) + '\n' + SCHEDULE_ROW_BLOCK + src.slice(at), changed: true }
  }
  const tail = src.endsWith('\n') ? '' : '\n'
  return { text: src + tail + SCHEDULE_ROW_BLOCK + '\n', changed: true }
}

function repairComposition(text) {
  let next = String(text || '')
  let changed = false
  const caps = detectWorkflowCaps()
  if (caps.ptc) {
    const inserted = insertWorkflowPtcInGroup(next)
    if (inserted.changed) {
      next = inserted.text
      changed = true
    }
  }
  const rows = [
    ['workflow-ptc', !caps.ptc],
    ['workflow-worker-thread', !caps.worker],
    ['tool-workflow', !caps.tool],
    ['tool-ralph', true],
  ]
  for (const [id, disabled] of rows) {
    const patched = setRowDisabled(next, id, disabled)
    if (patched.changed) {
      next = patched.text
      changed = true
    }
  }
  const schedule = insertScheduleRow(next)
  if (schedule.changed) next = schedule.text
  return { text: next, changed: changed || schedule.changed, workflowChanged: changed, scheduleInserted: schedule.changed }
}

/** Marks the in-package anchor gate vs. the preset template; adds a row to user presets without overwrite. */
const ANCHOR_ROW_MARK = '- id: anchor-gate'
// Current template heading; the Chinese heading below is the legacy form older presets carry.
const ANCHOR_BLOCK_START = '# Anchor gate'
const ANCHOR_BLOCK_START_LEGACY = '# 锚点门'
const REDTEAM_TOOLS_MARK = '- id: redteam-tools'

function anchorBlockBounds(ymlText) {
  let start = ymlText.indexOf(ANCHOR_BLOCK_START)
  if (start === -1) start = ymlText.indexOf(ANCHOR_BLOCK_START_LEGACY)
  const end = ymlText.indexOf(REDTEAM_TOOLS_MARK)
  if (start === -1 || end === -1 || start >= end) return null
  return { start, end }
}

function readAnchorBlockFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return null
  }
  const bounds = anchorBlockBounds(template)
  if (!bounds) return null
  return template.slice(bounds.start, bounds.end).trim()
}

/**
 * The anchor gate script is always overwritten from the packaged copy (no user state);
 * the YAML anchor block is replaced when it differs from the template (bootstrapMaxTokens).
 * @returns {'inserted'|'updated'|'config-updated'|'kept'|'missing'}
 */
function syncAnchorGate(targetDir) {
  const src = join(packagePaths().presetDir, 'anchor-gate.mjs')
  const dest = join(targetDir, 'anchor-gate.mjs')
  if (!existsSync(src)) return 'missing'
  mkdirSync(targetDir, { recursive: true })
  const wanted = readFileSync(src, 'utf8')
  let current = ''
  try { current = readFileSync(dest, 'utf8') } catch { current = '' }
  let script = 'kept'
  if (current !== wanted) {
    writeFileSync(dest, wanted, 'utf8')
    script = 'updated'
  }
  const presetFile = join(targetDir, 'agent.cordis.yml')
  if (!existsSync(presetFile)) return script
  let text
  try { text = readFileSync(presetFile, 'utf8') } catch { return script }
  const templateBlock = readAnchorBlockFromTemplate()
  if (!templateBlock) return script
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = templateBlock.replace(/\r\n/g, '\n').replace(/\n/g, nl)

  if (text.includes(ANCHOR_ROW_MARK)) {
    const bounds = anchorBlockBounds(text)
    if (!bounds) return script
    const currentBlock = text.slice(bounds.start, bounds.end).trim()
    if (currentBlock === rendered.trim()) return script
    const next = text.slice(0, bounds.start) + rendered + nl + nl + text.slice(bounds.end)
    writeFileSync(presetFile, next, 'utf8')
    return script === 'updated' ? 'updated' : 'config-updated'
  }

  const at = text.indexOf(REDTEAM_TOOLS_MARK)
  const next = at === -1
    ? text.replace(/\s*$/, '') + nl + nl + rendered + nl
    : text.slice(0, at) + rendered + nl + nl + text.slice(at)
  writeFileSync(presetFile, next, 'utf8')
  return 'inserted'
}

function samePath(a, b) {
  return String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase()
}

/** Remove only the full tool block the old installer wrote by mistake; keep user metadata and newlines. */
function repairPresetMetadata(targetDir, log) {
  const file = join(targetDir, 'preset.yml')
  let text
  try { text = readFileSync(file, 'utf8') } catch { return false }
  let next = text
  for (const nl of ['\r\n', '\n']) {
    const block = (SCHEDULE_ROW_BLOCK + '\n').replace(/\n/g, nl)
    next = next.split(block).join('')
  }
  if (next === text) return false
  writeFileSync(file, next, 'utf8')
  log(`${file}: đã dọn khối công cụ tool-schedule do trình cài cũ ghi nhầm (giữ nguyên metadata người dùng)`)
  return true
}

function repairExistingPresetFile(presetFile, log) {
  const metadataChanged = repairPresetMetadata(dirname(presetFile), log)
  let text
  try {
    text = readFileSync(presetFile, 'utf8')
  } catch (error) {
    log(`Đọc ${presetFile} thất bại: ${error && error.message ? error.message : String(error)}`)
    return { action: 'kept', repaired: [] }
  }
  const rendered = renderSkillsDir(text)
  const tools = renderToolsPackage(rendered.text)
  const delegation = repairDelegation(tools.text)
  const notes = []
  if (rendered.changed || tools.changed || delegation.changed) {
    writeFileSync(presetFile, delegation.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
    if (rendered.changed) {
      notes.push(rendered.reason === 'placeholder'
        ? 'Preset vẫn còn ' + SKILLS_PLACEHOLDER + ' (khiến cả preset không mount được), '
          + 'đã đổi thành dshHomePath(\'redteam/skills\')'
        : 'Thư mục skill trong preset ghi thành đường dẫn tuyệt đối của máy, '
          + 'đã đổi thành dshHomePath(\'redteam/skills\')')
    }
    if (tools.changed) notes.push('đã đổi tên gói công cụ thành de-policy/redteam/tools')
    if (delegation.strippedToolFilter) notes.push('đã bỏ toolFilter đã ngừng dùng từ 0.2.1')
    if (delegation.lockedModelSelection) notes.push('subagent đã khoá theo model cha')
    if (delegation.compositionChanged) notes.push(
      'đã bật/tắt workflow engine theo host máy này (thiếu gói thì tắt, tránh dropdown chế độ bị rỗng)')
    if (delegation.scheduleInserted) notes.push(
      'đã bổ sung dòng công cụ tool-schedule chính thức (redteam trước đây thiếu dòng này)')
    if (delegation.teamBoardInserted) notes.push(
      'đã bổ sung bảng việc chung / kỷ luật chờ wait_agent (khớp Team bật mặc định)')
    if (delegation.waitGuidanceFixed) notes.push(
      'đã sửa mô tả chờ của wait_agent (bản cũ nói nhầm là chờ tin nhắn thường; '
      + 'thực tế chỉ chờ đầu vào next-step)')
    if (delegation.listAgentsDisabled) notes.push(
      'host không có nhánh con list-agents, đã tắt dòng đó '
      + '(list_agents do gói chính đăng ký, không mất chức năng)')
    if (delegation.delegationChanged) notes.push('đã sửa ràng buộc giao việc của chỉ huy / bật lại subagent')
    if (notes.length) log(`${presetFile}：${notes.join('；')}`)
  }
  const targetDir = dirname(presetFile)
  const anchor = syncAnchorGate(targetDir)
  if (anchor === 'inserted') log(`đã thêm anchor gate vào preset hiện có ${targetDir} (giữ nguyên phần còn lại)`)
  else if (anchor === 'updated') log(`đã cập nhật script anchor gate ${targetDir}`)
  else if (anchor === 'config-updated') log(`đã đồng bộ cấu hình anchor gate ${targetDir}`)
  const repaired = [
    metadataChanged ? 'metadata' : null,
    rendered.changed ? rendered.reason : null,
    tools.changed ? 'tools-package' : null,
    delegation.strippedToolFilter ? 'toolFilter' : null,
    delegation.lockedModelSelection ? 'model-lock' : null,
    delegation.compositionChanged ? 'composition' : null,
    delegation.scheduleInserted ? 'tool-schedule' : null,
    delegation.teamBoardInserted ? 'team-board-guidance' : null,
    delegation.waitGuidanceFixed ? 'wait-guidance' : null,
    delegation.listAgentsDisabled ? 'list-agents' : null,
    delegation.delegationChanged ? 'delegation' : null,
    anchor === 'inserted' ? 'anchor-gate' : null,
    anchor === 'updated' ? 'anchor-script' : null,
    anchor === 'config-updated' ? 'anchor-config' : null,
  ].filter(Boolean)
  return { action: repaired.length > 0 ? 'repaired' : 'kept', repaired }
}

function writePresetTemplate(target, log, skillCount, bundledPath) {
  const paths = packagePaths()
  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    let rendered = renderToolsPackage(renderSkillsDir(text).text).text
    if (file === 'agent.cordis.yml') rendered = repairDelegation(rendered).text
    rendered = rendered.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    writeFileSync(join(target, file), rendered, 'utf8')
  }
  syncAnchorGate(target)
  log(`đã cài preset vào ${target} (${skillCount} skill kèm gói, thư mục ${bundledPath})`)
}

/**
 * Install the packaged preset into the user preset root.
 *
 * `$DSH_HOME` and `homedir()/.dsh` diverge. Fixing only one side leaves toolFilter /
 * modelSelectionSettings on the other to recur exactly as before next start. Existing copies
 * self-heal in place; the full template is written only to the current process's primary home.
 *
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept'|'repaired', dir, skillsDir, skills, repaired? }`
 */
export function installPreset(options = {}) {
  const prevCapCtx = workflowCapCtx
  if (Object.prototype.hasOwnProperty.call(options, 'ctx')) workflowCapCtx = options.ctx || null
  try {
    return installPresetBody(options)
  } finally {
    workflowCapCtx = prevCapCtx
  }
}

function installPresetBody(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const primaryDir = join(userPresetRoot(), 'redteam')
  const primaryFile = join(primaryDir, 'agent.cordis.yml')
  const existing = existingRedteamPresetFiles()
  const uniqueTags = (rows) => [...new Set(rows.flatMap((row) => row.repaired))]

  if (options.force === true) {
    writePresetTemplate(primaryDir, log, skillCount, bundled.path)
    const others = existing
      .filter((fp) => !samePath(fp, primaryFile))
      .map((fp) => repairExistingPresetFile(fp, log))
    const repaired = uniqueTags(others)
    return {
      action: 'installed',
      dir: primaryDir,
      skillsDir: bundled.path,
      skills: skillCount,
      ...(repaired.length ? { repaired: repaired.join('+') } : {}),
    }
  }

  if (existing.length > 0) {
    const rows = existing.map((fp) => repairExistingPresetFile(fp, log))
    if (!existsSync(primaryFile)) {
      writePresetTemplate(primaryDir, log, skillCount, bundled.path)
      const repaired = uniqueTags(rows)
      return {
        action: 'installed',
        dir: primaryDir,
        skillsDir: bundled.path,
        skills: skillCount,
        ...(repaired.length ? { repaired: repaired.join('+') } : {}),
      }
    }
    const repaired = uniqueTags(rows)
    if (repaired.length > 0) {
      return {
        action: 'repaired',
        dir: primaryDir,
        skillsDir: bundled.path,
        skills: skillCount,
        repaired: repaired.join('+'),
      }
    }
    log(`đã có preset riêng của người dùng ${primaryDir}, giữ nguyên `
      + '(muốn ghi đè: chạy một lần với REDTEAM_PRESET_REFRESH=1)')
    return { action: 'kept', dir: primaryDir, skillsDir: bundled.path, skills: skillCount }
  }

  writePresetTemplate(primaryDir, log, skillCount, bundled.path)
  return { action: 'installed', dir: primaryDir, skillsDir: bundled.path, skills: skillCount }
}

/**
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1',
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
      ctx,
    })
  } catch (error) {
    ctx.logger?.error?.('redteam-mode: cài preset thất bại: %s',
      error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: join(redteamDataDir(), 'skills'), skills: 0 }
  }
  let setupResult
  try {
    setupResult = installSetupScript()
  } catch (error) {
    setupResult = { action: 'missing', error: error && error.message ? error.message : String(error) }
  }
  if (setupResult.action === 'installed' || setupResult.action === 'updated') {
    ctx.logger?.info?.('redteam-mode: script cài môi trường đã sẵn sàng %s (%s)',
      setupResult.path, setupResult.action)
  }
  void import('./bootstrap-runtime.js').then((mod) => (
    mod.ensureRedteamRuntime({ download: true, background: true })
  )).then((rt) => {
    ctx.logger?.info?.('redteam-mode: kho tri thức runtime %s, mẫu nuclei %s', rt.knowledgePath, rt.templates)
  }).catch((error) => {
    ctx.logger?.warn?.('redteam-mode: thích ứng runtime thất bại: %s',
      error && error.message ? error.message : String(error))
  })

  /*
   * Web 0.1.7+ mode dropdown only reads agent-preset registry.register(); a disk scan of
   * .agent-presets never shows up there (same as Liang Shen).
   */
  const statusFile = join(redteamDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(redteamDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('redteam-mode: undeclare failed: %s', error?.message || String(error))
    }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), 'redteam')
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {}, ctx })
    }
    const readyDir = existsSync(join(userPresetRoot(), 'redteam', 'agent.cordis.yml'))
      ? join(userPresetRoot(), 'redteam')
      : paths.presetDir
    return readPresetDefinition(REDTEAM_PRESET_ID, readyDir)
  }
  const registerOnce = (registry) => {
    let definition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('redteam-mode: read preset failed: %s', error?.message || String(error))
      return
    }
    writeStatus({
      ok: false,
      phase: 'registering',
      id: definition.id,
      name: definition.name,
      plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
    })
    Promise.resolve()
      .then(async () => {
        let broken = null
        let current = definition
        for (let round = 0; round < 2; round += 1) {
          if (round === 1) {
            try { installPreset({ force: false, log: () => {}, ctx }) } catch { /* self-heal once more */ }
            current = buildDefinition()
          }
          await undeclare()
          releaseDeclared = await registry.register(current)
          broken = null
          try {
            const row = (await registry.list()).find((p) => p.id === REDTEAM_PRESET_ID)
            broken = row?.broken || null
          } catch { /* ignore */ }
          if (!broken) break
        }
        writeStatus({
          ok: !broken,
          phase: broken ? 'registered-broken' : 'registered',
          id: current.id,
          name: current.name,
          plugins: Array.isArray(current.plugins) ? current.plugins.length : -1,
          broken,
        })
        if (broken) ctx.logger?.warn?.('redteam-mode: declared but broken: %s', broken)
        else ctx.logger?.info?.('redteam-mode: declared for mode dropdown: %s', current.name || REDTEAM_PRESET_ID)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('redteam-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    // Marks "one more instance is still alive in this process". Hot reload disposes before apply,
    // so the count only reaches zero on a real disable (no new apply replaced it).
    const releaseHold = holdOwnedPresetAlive('redteam')
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
      releaseHold()
      // Teardown only schedules a delayed recheck: hot reload (patchReload: live) also lands here,
      // and clearing selectedDefault right away sends the user's "redteam mode" default back to standard.
      try { scheduleOwnedSelectedDefaultSweep({ ctx }) } catch { /* a failed reset never blocks disabling */ }
    }
  }, 'de-policy-redteam: declare agent preset')

  /*
   * Red-team sessions enable the official Agent Teams task board by default.
   * Official defaultEnabled:false uses a `when` condition to keep the four team_task_* tools
   * absent; red team needs them present, so add a `team/mode` entry for red-team **root**
   * sessions. See the three boundaries at the top of team-mode.js.
   */
  try {
    const off = installTeamMode(ctx)
    if (typeof off === 'function') ctx.effect(() => off, 'de-policy-redteam: team mode default')
  } catch (error) {
    ctx.logger?.warn?.('redteam-mode: team mode install failed: %s', error?.message || String(error))
  }

  ctx.provide('redteamMode', Object.freeze({ paths, preset: result, setup: setupResult }))
  ctx.logger?.info?.(
    'redteam-mode: sẵn sàng (thư mục dữ liệu mặc định $DSH_HOME/redteam; preset %s; thư mục skill %s)',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
