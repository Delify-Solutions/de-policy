/**
 * Red-team sessions enable the official Agent Teams task board by default.
 *
 * The official plugin made "use the team task board or not" a **session-level
 * switch**, not a preset-level one:
 *   TeamService.isEnabled(caller) in dsh-agent-team reads the `team/mode`
 *   event projection on ctx.subagents.rootOf(caller).session;
 *   `defaultEnabled` is false by default, so that event absent = always off.
 *   The four tools (team_task_create/list/get/update) register with
 *   `when: ({agent}) => enabled(agent)`, so they never enter the catalog when off.
 *
 * That is, the official plugin already gets "standard mode does not use it" right -
 * it relies on conditional absence, not on deleted code. What red team wants by
 * "default on" is exactly **one extra team/mode written on the red-team root session**.
 *
 * Three boundaries that must hold:
 *   1. Write **root sessions only**. isEnabled reads only rootOf's projection, so
 *      writing on a child session is useless, and a child write becomes noise on
 *      its own root state.
 *   2. Write **once**. If a team/mode event already exists (even enabled:false)
 *      never touch it again - after the user turns it off manually we must not
 *      switch it back on every time.
 *   3. Write **for red-team sessions only**. Not one line for other presets,
 *      otherwise the isolation breaks.
 */
import { isRedteamPresetId, isRedteamSession } from '../identity.js'

/** Sessions already checked, so we do not rescan events every step. Process-local; a restart rescans. */
const checked = new WeakSet()
const CHECKED_CAP = 2000
let checkedCount = 0

/** Session event table. Both sources are tried; host versions differ in field names. */
function eventsOf(session) {
  const out = []
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const got = session.snapshotEvents()
      if (Array.isArray(got)) out.push(...got)
    }
  } catch { /* unreadable history: fall back to session.events */ }
  try {
    if (Array.isArray(session?.events)) out.push(...session.events)
  } catch { /* no events array */ }
  return out
}

/** Whether the session log already has team/mode; if so the user (or we) spoke, so stay out. */
function hasTeamModeEvent(session) {
  return eventsOf(session).some((event) => event && event.type === 'team/mode')
}

/**
 * Whether we can be sure this session "is definitely not red team".
 *
 * The preset id may not have landed on the header in the instant the session is
 * created; treating "unreadable" as "not red team" would permanently miss the
 * session, so the empty case is separated out here and rejudged next time.
 */
function presetKnown(session) {
  const header = session?.header
  if (!header) return false
  if (String(header.agentPreset || '').trim()) return true
  return eventsOf(session).some((event) => event && event.type === 'agent-preset/selected')
}

/**
 * Whether this session is the root of its own collaboration tree.
 *
 * Only trust the two signals the host `rootOf()` uses: delegation origin
 * `origin`, and delegation depth.
 * **Do not look at `parentSession`** - the host's "resume from history / branch"
 * also writes it, but such sessions keep `delegationDepth` at 0 and are their own
 * root at runtime (`rootOf(itself) === itself`).
 * Earlier versions used `!header.parentSession` as the test and judged every
 * resumed red-team session on the server to be a subagent, so not a single
 * `team/mode` was ever written.
 */
function isRootSession(session) {
  const header = session?.header
  if (!header) return true
  const origin = String(header.origin || '').toLowerCase()
  if (origin === 'subagent' || origin === 'teammate' || origin === 'delegate') return false
  return Number(header.delegationDepth ?? 0) <= 0
}

/**
 * Idempotent: if a red-team root session never spoke up, append
 * `team/mode { enabled: true }`.
 *
 * **Do not pin "not red team for now".** Users switch presets mid-session: the
 * session is created as standard, then `agent-preset/selected: redteam` arrives.
 * An earlier version recorded such a session in `checked` and never looked at it
 * again, so after the switch `team/mode` was never written - which is exactly how
 * the observed SESSION_REMOVED case was missed (no team_task_* among 99 tools).
 *
 * Only two outcomes may be pinned:
 *   - a stance was already recorded (a team/mode event exists, or we just wrote one)
 *   - clearly determined to be non-root (a subagent never gets to write; rescanning is pointless)
 * Everything else (not red team / preset undecided / error) is not pinned, so the
 * caller judges again next round.
 *
 * @param {object} session - Target Session (with an append method).
 * @returns {'enabled'|'skip-not-redteam'|'skip-unknown-preset'|'skip-not-root'
 *   |'skip-already'|'skip-no-session'|'error'}
 */
export function ensureRedteamTeamMode(session, check) {
  if (!session || typeof session.append !== 'function') return 'skip-no-session'
  /* A team/mode event already exists (a manual user switch-off counts as a
     recorded stance), so leave it alone. This is more reliable than `checked`:
     it reads the truth, not our own cache. */
  if (hasTeamModeEvent(session)) {
    markChecked(session)
    return 'skip-already'
  }
  if (checked.has(session)) return 'skip-already'
  let redteam = false
  try {
    redteam = check ? check({ agent: { session } }) : isRedteamSession({ agent: { session } })
  } catch {
    redteam = false
  }
  if (!redteam) {
    /* The preset has not landed on the session yet - do not pin it, leave it to the next round. */
    if (!presetKnown(session)) return 'skip-unknown-preset'
    /* The preset is clearly not red team: **do not pin**. The user may switch to
       red team at any time, and pre-step must be able to judge again after that. */
    return 'skip-not-redteam'
  }
  if (!isRootSession(session)) {
    markChecked(session)
    return 'skip-not-root'
  }
  markChecked(session)
  try {
    session.append('team/mode', { enabled: true })
    return 'enabled'
  } catch {
    return 'error'
  }
}

/**
 * Release the check once after the session switches preset.
 *
 * The host only emits `agent-preset/selected` on a preset switch and
 * **does not emit `agent/created`**, so a session judged as standard at creation
 * time must be let through again here.
 */
export function forgetTeamModeCheck(session) {
  try { checked.delete(session) } catch { /* ignore */ }
}

/**
 * Decide whether this host version uses the "session-level switch" Team model.
 *
 * Before 0.2.2-rc.2 it was `dsh-experimental-agent-team`: no projection, no
 * `team/mode`, and the four team tools were always on via `tryMembership()`
 * (the root session is naturally the lead).
 * From rc.2 on it is `dsh-agent-team`: `team/mode` projection +
 * `defaultEnabled:false` + tool `when` gating, so no event means no tools.
 *
 * Guessing the version wrong does not crash, but it stuffs a `team/mode` the host
 * does not understand into the session log, and rc.1 does not need it at all -
 * so do not write.
 */
function hostUsesTeamGate(ctx) {
  try {
    const team = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : ctx?.agentTeams
    if (team === void 0 || team === null) return true /* unreadable: assume new host; safe side */
    /* rc.2+ has isEnabled (reads the projection); rc.1 experimental only has membership/tryMembership. */
    return typeof team.isEnabled === 'function'
  } catch {
    return true
  }
}

function markChecked(session) {
  checked.add(session)
  checkedCount += 1
  /* WeakSet reclaims entries itself; this only stops one batch of sessions
     being counted repeatedly. */
  if (checkedCount > CHECKED_CAP) checkedCount = 0
}

/**
 * Attach to host events.
 *
 * Three entry points cover every timing of "when the preset gets attached":
 *   - `agent/created`    - the common path where the session header already
 *                          carries agentPreset (synchronous write)
 *   - `agent-preset/selected` on `session/event`
 *                        - the user switches preset mid-session (the host does
 *                          not emit agent/created)
 *   - `agent/pre-step`   - the fallback; every step can judge again
 *
 * All are global: the host dispatches by `scopeTarget(agent, agent)`, so without
 * global it does not reach a listener on the plugin's own ctx. The check itself
 * falls back to isRedteamSession and never writes for non-red-team sessions.
 */
export function installTeamMode(ctx, config = {}) {
  if (config.redteamTeamMode === false) return () => {}
  if (typeof ctx?.on !== 'function') return () => {}
  /* rc.1's experimental team is always on anyway; not a single line is needed. */
  if (!hostUsesTeamGate(ctx)) return () => {}

  const offs = []
  const decided = new WeakSet()

  const handle = (agent, check) => {
    const session = agent?.session
    if (!session) return 'skip-no-session'
    try { return ensureRedteamTeamMode(session, check) } catch { return 'error' }
  }

  try {
    offs.push(ctx.on('agent/created', ({ agent }) => {
      /* No child sessions (isRootSession blocks them too); block once here to skip the event scan. */
      if (!isRootSession(agent?.session)) return
      /* Write synchronously, no microtask: the host emits this event inside the
         announce serial dispatch and we are part of that await chain. Only a
         synchronous append guarantees it lands in the log before createAgent
         returns - so tools.resolve in the first step of round one sees team_task_*.
         The official defaultEnabled also calls setEnabled right in this event, same
         ordering. A throwing listener fails serial registration, so wrap it in try. */
      try { handle(agent) } catch { /* ignore */ }
    }, { global: true, prepend: true }))
  } catch { /* old host has no agent/created */ }

  /*
   * User switches preset inside a session: the host only appends
   * `agent-preset/selected`, **does not emit `agent/created`, and has no
   * dedicated cordis hook** (the write point is `select()` in
   * dsh-agent-preset-registry, which calls `session.append` directly).
   * The only observable entry point is the generic `session/event`.
   *
   * Do not write synchronously here: appending again inside the
   * `session.append` handling chain is rejected by the host.
   * Push it to a microtask; landing before the player's next message goes out is
   * enough - after switching preset the human still has to type.
   */
  try {
    offs.push(ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'agent-preset/selected') return
        const data = event.data || {}
        const preset = data.agentPreset ?? data.preset ?? data.name
        /* Release on a switch to non-red-team too: the user may go red -> standard -> back. */
        forgetTeamModeCheck(session)
        decided.delete(session)
        if (!isRedteamPresetId(preset)) return
        if (!isRootSession(session)) return
        /* The event already answered "is it red team now", so do not let
           ensureRedteamTeamMode re-read the session header and judge again - the
           header is stuck on `standard` from creation, and a rejudge would mark the
           session that just switched over as non-red-team. */
        queueMicrotask(() => {
          try { handle({ session }, () => true) } catch { /* ignore */ }
        })
      } catch { /* observers must not throw */ }
    }, { global: true }))
  } catch { /* old host has no session/event */ }

  try {
    offs.push(ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      /* No longer limited to step === 1: the preset switch can happen at any
         step. Real idempotence is held by `hasTeamModeEvent` inside
         ensureRedteamTeamMode - once written it never writes again - so the cost
         of scanning the event table per step is acceptable (a session usually has
         a few dozen events). */
      const session = agent?.session
      if (session && !decided.has(session)) {
        const outcome = handle(agent)
        /* Only a conclusion that "knows whether to turn it on" pins this step; an
           undecided preset / error is looked at next round. */
        if (outcome === 'enabled' || outcome === 'skip-already' || outcome === 'skip-not-root') decided.add(session)
      }
      return typeof next === 'function' ? next() : undefined
    }, { global: true, prepend: true }))
  } catch { /* old host has no agent/pre-step */ }

  return () => {
    for (const off of offs) {
      try { off() } catch { /* already released */ }
    }
  }
}
