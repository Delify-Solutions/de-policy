/**
 * RedTeam console — host side
 *
 * Role: expose a package-private HTTP bridge `POST /redteam/api` to the browser side:
 *   · asset-library ops are forwarded to `ctx.redteam` (process-level store service);
 *   · session reachability ops (probeSessions) run real TCP/HTTP probes on the host;
 *   · skill catalog ops (skillCatalog / skillRead) read `ctx.skills` using the redteam
 *     preset standing scope — skills are managed by the native DSH skill system
 *     ($DSH_HOME/skills, project .dsh/skills, .agents/skills); the console only browses.
 *
 * Why webServer instead of typert/@Remote: this package and the store package keep
 * zero external dependencies (node_modules is unresolvable under profile), and a named
 * route is the smallest stable seam. Cross-origin requests are blocked by Origin/Host
 * checks (same-origin POST only).
 */
import { checkEndpoint } from './endpoint-gate.js'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { dispatch, dispatchAsync } from './store-core.js'
/* Skill availability shares one implementation with redteam_preflight (env / paths / placeholders) */
import { checkSkill, officialSkillSummaries, skillLibraryOf, summarizeSkills } from './skill-availability.js'
import {
  maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT,
  readSettings, writeSettings,
} from './settings.js'
/* Parked-slot state is shared with the tool layer (written by tools.js, read here) */
import { isParked } from './slot-state.js'
import { startClock, clockConfig, claimedAt } from './orchestrator-clock.js'
import { mergeTeamBoardTasks } from './team-board.js'
import {
  loadPlatformConfig, mergeConfigEnv, redteamRoot, envAdaptStatus, markEnvAdaptSkip,
  platformSummary, savePlatformConfig, assignToolkitFolder,
} from './platform-config.js'

/** Read-only snapshot of the last teamBoard, keyed by root session, for the clock. */
const lastTeamTasksByRoot = new Map()
let lastTeamTasks = []

/**
 * Walk `parentSession` up to the root session id (max 64 hops, loop guarded).
 *
 * The panel "follow session" feature needs it: host bindings are keyed by **root
 * session**, while the session a user opens in the UI may be a subagent's.
 *
 * @param ctx - plugin context (reads the sessions registry; input id if unavailable).
 * @param sessionId - any session id.
 * @returns root session id (returned unchanged when it cannot be resolved).
 */
export function resolveRootSessionId(ctx, sessionId) {
  const id = String(sessionId || '')
  if (!id) return id
  let sessions = null
  try { sessions = ctx.get('sessions') } catch { sessions = null }
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return id
  let list = []
  try { list = sessions.list() } catch { return id }
  const byId = new Map()
  for (const s of Array.isArray(list) ? list : []) {
    const sid = s && s.id !== undefined ? String(s.id) : ''
    if (sid) byId.set(sid, s)
  }
  let cur = id
  let lastKnown = id
  for (let guard = 0; guard < 64; guard += 1) {
    const node = byId.get(cur)
    if (node === undefined) {
      return byId.has(id) ? lastKnown : cur
    }
    lastKnown = cur
    const header = node.header
    const parent = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : ''
    if (!parent) return cur
    if (parent === cur) return cur
    cur = parent
  }
  return cur
}

/** DSH_HOME: explicit env wins; HOME is often empty on Windows, so fall back to homedir(). */
function dshHomeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * Candidate skill directories shipped inside this package.
 * When desktop loads us through profile/node_modules symlinks, resolving relative
 * paths from import.meta.url alone can point nowhere (spaces, unresolved junctions);
 * so probe several and realpath. packagePaths is not imported from index.js, to keep
 * from dragging in the cordis plugin entry.
 */
/** The two possible `$DSH_HOME` sources (plugin env and host dshHomePath can diverge). */
function dshHomeCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

function resolvePluginSkillsDir() {
  const candidates = []
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    candidates.push(join(root, 'skills', 'redteam'))
  } catch { /* ignore */ }
  try {
    candidates.push(resolve(fileURLToPath(new URL('../../skills/redteam/', import.meta.url))))
  } catch { /* ignore */ }
  /* installBundledSkills target: skills stay listable when the in-package path is gone.
     Both candidate homes are probed. */
  for (const home of dshHomeCandidates()) {
    candidates.push(join(home, 'redteam', 'skills'))
    for (const profile of ['desktop', 'web', 'headless']) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', 'de-policy', 'skills', 'redteam'))
    }
  }
  /* No scan of official $DSH_HOME/skills: only this package / synced copies count. */
  for (const raw of candidates) {
    if (!raw) continue
    try {
      if (!existsSync(raw)) continue
      const real = realpathSync(raw)
      const md = readdirSync(real).filter((f) => f.endsWith('.md'))
      if (md.length > 0 || /skills[/\\]redteam$/i.test(real) || /[/\\]skills$/i.test(real)) return real
    } catch { /* try next */ }
  }
  return null
}

const PLUGIN_SKILLS_DIR = resolvePluginSkillsDir()

function readOfficialSkill(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'name required' }
  const found = officialSkillSummaries().find((skill) => skill.name === name)
  if (!found) return { ok: false, error: 'skill not found: ' + name }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    path: found.path,
    content: found.content,
    library: 'official',
  }
}

function officialCatalogItems() {
  return officialSkillSummaries().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    dir: skill.resourceBase && skill.resourceBase.path,
    path: skill.path,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: false,
    library: 'official',
    availability: 'listed',
    problems: [],
    needs_user: [],
  }))
}

function withBothLibraries(payload) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const redteam = payload.items.map((item) => Object.assign({ library: 'redteam' }, item, {
    library: item.library === 'official' ? 'official' : 'redteam',
  }))
  const seen = new Set(redteam.filter((item) => item.library === 'official').map((item) => item.name))
  const official = officialCatalogItems().filter((item) => !seen.has(item.name))
  const items = redteam.concat(official)
  return Object.assign({}, payload, {
    items,
    total: items.length,
    libraries: {
      redteam: items.filter((item) => item.library !== 'official').length,
      official: items.filter((item) => item.library === 'official').length,
    },
  })
}
/** Normalize before comparing dirs: registry gives `/a/b/skills`, URL paths may add a slash. */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try {
    const left = existsSync(a) ? realpathSync(a) : resolve(a)
    const right = existsSync(b) ? realpathSync(b) : resolve(b)
    return left === right
  } catch {
    try { return resolve(a) === resolve(b) } catch { return false }
  }
}

/** Cordis plugin name. */
export const name = 'de-policy-redteam-ui'

/**
 * Keep hard dependencies to the asset library + HTTP only.
 * skills / agentPresets load later or under different names on desktop; declaring them
 * hard would unmount the whole `/redteam/api`, so skill library / knowledge base /
 * SQLite all become unreadable in the UI.
 */
export const inject = ['redteam', 'webServer']

/** Request body cap (asset imports can be large). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------- version & update */

/** Run a shell command with a timeout; returns `{ code, stdout, stderr, timedOut }`. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ All three bit us before:
         · env must be passed explicitly as process.env — spawn defaults to an empty
           environment, and an empty PATH makes npm/pnpm fail with `spawn npm ENOENT`
           (version checks then always fail);
         · cwd must be a **real** directory — a nonexistent path is also ENOENT
           (the error looks like "command not found", easy to misdiagnose);
         · on Windows npm/npx/pnpm/yarn are .cmd shims, and Node's spawn without a
           shell cannot find the executable — `shell: true` (or a .cmd suffix) is
           required to resolve PATHEXT, else the redteam "check for updates" panel
           always reports code=-1. */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      const isWin = process.platform === 'win32'
      const needsShim = isWin && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(command)
      child = spawn(needsShim ? `${command}.cmd` : command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: needsShim,
        windowsHide: isWin,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const CHILD_IO_CAP = 1 << 20 // cap stdout/stderr at 1MB each: runaway children can OOM the host
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const cleanupPipes = () => {
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } catch { /* ignore */ }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    }
    // Kill the tree: child.kill only hits the direct child; grandchildren
    // (npm → node → tool) survive. Windows uses taskkill /T, POSIX falls back to
    // SIGKILL plus a process-group kill attempt.
    const killTree = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 2000,
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* not a group leader, ignore */ }
        }
      } catch { /* taskkill failure is fine: child.kill already fired */ }
    }
    const timer = setTimeout(() => {
      killTree()
      cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => {
      if (settled) return
      if (stdout.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stdout' }); return
      }
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      if (settled) return
      if (stderr.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stderr' }); return
      }
      stderr += c.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr })
    })
  })
}

/** Package identity (the store shell attaches it from package.json; unknown if absent). */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'de-policy',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/**
 * profile directory: DSH's `ctx.baseUrl` is exactly that (the base for
 * loader.internal.import(name, profileDir)).
 * ⚠️ `ctx.baseUrl` is really a `file:///...` URL — passing it straight to join/existsSync
 *    glues `node_modules` onto the URL, making `updatePreflight` report `devLinked` true
 *    forever, after which the panel's "update" button stays greyed out permanently.
 *    It must go through fileURLToPath back to a system path.
 */
function profileDirOf(ctx) {
  try {
    const raw = ctx && typeof ctx.baseUrl === 'string' ? ctx.baseUrl : ''
    if (raw) return raw.startsWith('file://') ? fileURLToPath(raw) : raw
  } catch { /* ignore: conversion failure falls back to the default path */ }
  return join(dshHomeOf(), 'profiles', 'web')
}

/**
 * Env-adapt op: the panel's EnvTab reads/writes `$DSH_HOME/redteam/config.json`.
 * @returns JSON result, or undefined when this is not that op.
 */
function handlePlatformOp(store, request, ctx = null) {
  const op = request && request.op
  if (op !== 'platformConfigGet' && op !== 'platformConfigSave' && op !== 'platformAssignToolkit'
    && op !== 'platformEnvAdaptStatus' && op !== 'platformEnvAdaptSkip') {
    return undefined
  }
  const root = (store && store.root) || redteamRoot()
  // EnvAdaptSendGate polls readiness / "configure later"; without this branch the
  // front end never sees ready.
  if (op === 'platformEnvAdaptStatus') return Object.assign({ ok: true }, envAdaptStatus(root))
  if (op === 'platformEnvAdaptSkip') {
    return Object.assign({ ok: true }, markEnvAdaptSkip(root, request.skip === undefined ? true : !!request.skip))
  }
  if (op === 'platformConfigGet') {
    // Every read of the platform summary carries the endpoint verdict, so the panel
    // can put the banner up on the first poll instead of after the user tries to
    // apply and gets refused.
    // Resolve against the *active* provider, not "any configured endpoint": a
    // machine can hold several, and only the selected one is about to be used.
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
    return Object.assign(platformSummary(root), { endpoint: checkEndpoint({ llm }) })
  }
  if (op === 'platformConfigSave') {
    savePlatformConfig(request.config || {}, root)
    return platformSummary(root)
  }
  return assignToolkitFolder(request.dir, root)
}

/** Read the profile package.json (dependency declarations + dsh.profile.bundles). */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** Package manager: pnpm when the profile has pnpm-lock / pnpm-workspace, else npm. */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}



/** Read the full request body; abort as soon as the cap is exceeded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // destroy with an Error → socket RST immediately, client stops sending, clean end.
        const err = new Error('request body too large')
        done(reject, err)
        try { req.destroy(err) } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => done(reject, err))
  })
}

/** Uniform JSON response. */
/** Local interface addresses (loopback / `::ffff:` mapped), to tell if a request is local. */
function selfAddressSet() {
  const norm = (a) => String(a || '').replace(/^::ffff:/i, '')
  const set = new Set(['127.0.0.1', '::1', '::', '0.0.0.0'])
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const it of list || []) {
        if (it && it.address) set.add(norm(it.address))
      }
    }
  } catch { /* no interfaces readable: loopback only */ }
  return { has: (a) => set.has(norm(a)) }
}

/** Desktop webview origins: custom protocol / local file / extension pages — no host to compare. */
const APP_ORIGIN_RE = /^(app|file|blob|data|about|chrome-extension|moz-extension|ms-browser-extension|tauri|capacitor|ionic):/i

/** Log one line per 403 so the rejected origin is visible (no body, no cookie). */
function logCorsReject(req, detail) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'redteam')
    mkdirSync(dir, { recursive: true })
    const line = [new Date().toISOString(), detail.path || '', 'remote=' + detail.remote,
      'host=' + detail.host, 'origin=' + (detail.origin === undefined ? '(none)' : String(detail.origin)),
      'site=' + (detail.site || '')].join('\t')
    writeFileSync(join(dir, 'cors-reject.log'), line + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* logging failure does not affect the rejection */ }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Skill availability cache: `{ at, scope, byName: Map }`; reused for 30 seconds. */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * Fetch a Cordis service safely: without inject, ctx.get and property access both
 * throw, and it must not bubble up as a 400.
 */
function softService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* not injected */ }
  try {
    return ctx[name]
  } catch { /* proxy throw */ }
  return undefined
}

/**
 * Availability per skill (read the body → shared verdict module).
 * @param skillsSvc - the resolved skills service (may be null).
 * @param list - return of `skills.list()` (SkillSummary[]).
 * @param scope - current scope.
 * @param force - true skips the cache.
 */
async function skillAvailabilityOf(skillsSvc, list, scope, force) {
  const now = Date.now()
  // scope in the cache key: switching presets changes scope, and a stale cache would
  // hold a wrong availability snapshot.
  const scopeSig = scope == null ? '' : String(scope)
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length
    && skillAvailabilityCache.scope === scopeSig) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const rootsWith = new Map()
  for (const x of list) {
    const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
    if (dir === null) continue
    if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
    if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try {
      def = skillsSvc && typeof skillsSvc.get === 'function'
        ? await skillsSvc.get(summary.name, { scope })
        : undefined
    } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
      { env: mergeConfigEnv(process.env, loadPlatformConfig(redteamRoot())), sameNameIn: rootsWith.get(summary.name) || [] })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, scope: scope == null ? '' : String(scope), size: list.length, byName }
  return { at: now, cached: false, byName }
}

/**
 * Skill catalog: desktop reads this package's `skills/redteam/*.md` by default;
 * the native registry is used only when both skills and agentPresets are available.
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined

  /* Desktop must never let "without inject" bubble: always softService + file fallback. */
  const skillsSvc = softService(ctx, 'skills')
  const presetsSvc = softService(ctx, 'agentPresets')

  let scope = null
  let registryReady = false
  if (skillsSvc && typeof skillsSvc.list === 'function' && presetsSvc) {
    const standing = presetsSvc.standingKeyFor
    if (typeof standing === 'function') {
      try {
        scope = await standing.call(presetsSvc, 'redteam')
        registryReady = scope != null
      } catch {
        registryReady = false
      }
    }
  }

  if (!registryReady) {
    return withBothLibraries(handleSkillOpFromPluginDir(request))
  }

  if (request.op === 'skillCatalog') {
    let list = []
    try {
      list = await skillsSvc.list({ scope })
    } catch {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      return withBothLibraries(handleSkillOpFromPluginDir(request))
    }
    const redteamList = list.filter((s) => skillLibraryOf(s) !== 'official')
    const availability = await skillAvailabilityOf(skillsSvc, redteamList, scope, request.refresh === true)
    const pluginDir = resolvePluginSkillsDir()
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? '(nguồn không phải hệ thống tệp)' : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      const library = skillLibraryOf(s) === 'official' ? 'official' : 'redteam'
      const avail = availability.byName.get(s.name)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        category: s.category || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, pluginDir),
        library,
        availability: library === 'official' ? 'listed' : (avail ? avail.status : 'unknown'),
        problems: library === 'official' ? [] : (avail ? avail.problems : ['chưa kiểm tra']),
        needs_user: library === 'official' ? [] : (avail ? avail.needs_user : []),
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: 'Khả dụng = tệp kỹ năng tồn tại và đọc được toàn bộ nội dung. Thiếu công cụ, thiếu khóa, placeholder VPS chỉ ghi vào phần thiếu hụt, không đánh dấu cả kỹ năng là không khả dụng.',
      },
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: 'Kỹ năng redteam tách riêng khỏi kỹ năng chính thức. Chỉ kỹ năng redteam mới kiểm tra đường dẫn công cụ; kỹ năng chính thức nằm ở $DSH_HOME/skills, do host gọi theo nhiệm vụ.',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  try {
    const skill = await skillsSvc.get(request.name, { scope })
    if (skill !== undefined) {
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        category: skill.category || '',
        provider: skill.provider,
        source: skill.source,
        path: skill.path || null,
        content: skill.content || '',
      }
    }
  } catch { /* fall through */ }
  return handleSkillOpFromPluginDir(request)
}

/** Build a catalog from this package's skills/redteam dir with real availability checks
 *  (does not depend on host skills injection). */
function handleSkillOpFromPluginDir(request) {
  const dir = resolvePluginSkillsDir() || PLUGIN_SKILLS_DIR
  if (!dir || !existsSync(dir)) {
    return { ok: false, error: 'Thư mục skills/redteam của gói này không tồn tại, và dịch vụ skills của host không khả dụng' }
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  const parseMeta = (text) => {
    const out = { description: '', whenToUse: '', category: '' }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) {
      const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || ''
      out.description = first.replace(/^#\s*/, '').trim()
      return out
    }
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      if (kv[1] === 'description') out.description = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'when_to_use' || kv[1] === 'whenToUse') out.whenToUse = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'category') out.category = kv[2].trim().replace(/^['"]|['"]$/g, '')
    }
    return out
  }
  /* Env: process + platform config.json (empty fields do not override) */
  const cfg = loadPlatformConfig(redteamRoot())
  const checkEnv = mergeConfigEnv(process.env, cfg)

  if (request.op === 'skillCatalog') {
    const byName = new Map()
    const items = files.map((file) => {
      const name = file.replace(/\.md$/i, '')
      const path = join(dir, file)
      let description = ''
      let whenToUse = ''
      let category = ''
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
        const meta = parseMeta(content)
        description = meta.description
        whenToUse = meta.whenToUse
        category = meta.category
      } catch { /* ignore */ }
      const verdict = checkSkill(
        { name, content, path, root: dir },
        { env: checkEnv },
      )
      byName.set(name, verdict)
      return {
        name,
        description,
        whenToUse,
        category,
        provider: 'de-policy',
        source: 'plugin',
        dir,
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: true,
        library: 'redteam',
        availability: verdict.status,
        problems: verdict.problems,
        needs_user: verdict.needs_user,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
    const availSummary = summarizeSkills(Array.from(byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.length,
      availability: {
        summary: availSummary,
        checked_at: Date.now(),
        cached: false,
        broken: Array.from(byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: 'Tự kiểm tra theo tệp kỹ năng của gói này (gồm cả config.json thích ứng môi trường). Đường dẫn công cụ, khóa và placeholder VPS chỉ ghi vào phần thiếu hụt, không đánh dấu cả kỹ năng là không khả dụng.',
      },
      bySource: [{ key: 'plugin', n: items.length }],
      byDir: [{ key: dir, n: items.length }],
      note: 'Gói này có tổng cộng ' + items.length + ' kỹ năng trong skills/redteam; khả dụng đã được kiểm tra theo nội dung và cấu hình máy này.',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  const file = join(dir, request.name.endsWith('.md') ? request.name : (request.name + '.md'))
  if (!existsSync(file)) return { ok: false, error: 'skill not found: ' + request.name }
  let content = ''
  try { content = readFileSync(file, 'utf8') } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
  const meta = parseMeta(content)
  return {
    ok: true,
    name: request.name.replace(/\.md$/i, ''),
    description: meta.description,
    whenToUse: meta.whenToUse,
    category: meta.category,
    provider: 'de-policy',
    source: 'plugin',
    path: file,
    content,
  }
}

/** Read/write the host-side read-only orchestration settings. */
export async function handleOrchestratorOp(ctx, request) {
  if (request.op !== 'orchestratorSettings' && request.op !== 'setOrchestratorSettings') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  const snapshot = () => {
    const clock = clockConfig(readSettings(root))
    return { board: true, clockMinutes: clock.minutes }
  }
  if (request.op === 'orchestratorSettings') return Object.assign({ ok: true }, snapshot())
  const patch = {}
  if (request.stallMinutes !== undefined) {
    const n = Number(request.stallMinutes)
    patch.stallMinutes = Number.isFinite(n) && n > 0
      ? Math.min(Math.max(Math.round(n), 1), 240)
      : 0
  }
  try {
    writeSettings(root, patch)
  } catch (error) {
    return { ok: false, error: 'Lưu thất bại: ' + (error && error.message ? error.message : String(error)) }
  }
  return Object.assign({ ok: true }, snapshot())
}

function sessionRowsOf(sessions) {
  return sessions.list().map((s) => {
    const header = s && s.header ? s.header : {}
    return {
      id: String(s && s.id !== undefined ? s.id : header.id || ''),
      parentId: header.parentSession ? String(header.parentSession) : null,
      preset: header.agentPreset ? String(header.agentPreset) : '',
      title: header.title ? String(header.title) : '',
    }
  })
}

function sessionEngagement(store, rootId, requested) {
  try {
    if (store && typeof store.sessionBinding === 'function') {
      const bound = store.sessionBinding(rootId)
      if (typeof bound === 'string' && bound) return bound
    } else if (store && typeof store.activeEngagementId === 'function') {
      /* Legacy stores had no per-root binding API.  Keep the old single-pointer
         fallback only for that API shape; current stores must stay root-bound. */
      const active = store.activeEngagementId()
      if (typeof active === 'string' && active) return active
    }
  } catch { /* use the safe fallback below */ }
  return requested || ''
}

/**
 * Shared task board + structured report view.  This function is intentionally
 * read-only: it only reads session projections and report rows, then returns
 * a derived JSON view.
 */
export async function handleTeamBoardOp(ctx, request) {
  if (request.op !== 'teamBoard') return undefined
  const sessions = ctx.get('sessions')
  const projections = ctx.get('sessionProjections')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'Sổ đăng ký sessions không khả dụng', sessions: [], tasks: [] }
  }

  let rows = []
  try {
    rows = sessionRowsOf(sessions)
  } catch (error) {
    return {
      ok: false,
      error: 'Liệt kê phiên thất bại: ' + (error && error.message ? error.message : String(error)),
      sessions: [],
      tasks: [],
    }
  }
  const roots = rows.filter((row) => row.id && !row.parentId)
  const store = (() => { try { return ctx.redteam } catch { return undefined } })()
  const requestedEngagement = typeof request.engagement === 'string' && request.engagement.trim()
    ? request.engagement.trim()
    : ''
  const selectedRoot = typeof request.session === 'string' && request.session.trim() !== ''
    ? resolveRootSessionId(ctx, request.session.trim())
    : ''
  if (selectedRoot && !roots.some((root) => root.id === selectedRoot)) {
    lastTeamTasksByRoot.delete(selectedRoot)
    lastTeamTasks = Array.from(lastTeamTasksByRoot.values()).flat()
    return {
      ok: false,
      error: 'Phiên không tồn tại hoặc không phải phiên gốc nhìn thấy được',
      root_sessions: [],
      tasks: [],
      sessions: rows.filter((row) => row.id),
      failures: [],
    }
  }
  const boundEngagementOf = (rootId) => {
    try {
      if (store && typeof store.sessionBinding === 'function') return store.sessionBinding(rootId) || ''
    } catch { /* treat an unreadable binding as absent */ }
    return ''
  }
  const candidateRoots = selectedRoot ? roots.filter((root) => root.id === selectedRoot) : roots
  /* An explicit engagement is a filter, not a binding override.  A root that
     is already bound to another workspace is omitted instead of reading that
     other workspace's reports under the caller's requested id. */
  const visibleRoots = candidateRoots.filter((root) => {
    const bound = boundEngagementOf(root.id)
    return !requestedEngagement || !bound || bound === requestedEngagement
  })
  const tasks = []
  const reports = []
  const failures = []

  for (const root of visibleRoots) {
    let state = null
    try {
      const live = typeof sessions.get === 'function' ? sessions.get(root.id) : null
      state = live && projections && typeof projections.stateOf === 'function'
        ? projections.stateOf(live, 'agentTeam')
        : null
    } catch {
      state = null
    }
    if (!state || typeof state !== 'object') continue
    if (state.failure) {
      failures.push({ root: root.id, failure: String(state.failure) })
      continue
    }
    if (state.enabled !== true) continue
    const engagement = sessionEngagement(store, root.id, requestedEngagement)
    for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
      if (!task) continue
      tasks.push({
        id: String(task.id || ''),
        root: root.id,
        engagement,
        subject: String(task.subject || ''),
        description: String(task.description || ''),
        status: String(task.status || 'pending'),
        ownerId: task.ownerId ? String(task.ownerId) : null,
        ownerName: task.ownerName ? String(task.ownerName) : null,
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
        writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.map(String) : [],
        revision: Number(task.revision) || 0,
      })
    }
    if (store && engagement && typeof store.latestAgentReports === 'function') {
      try {
        const rowsForRoot = store.latestAgentReports(engagement, root.id, {
          limit: 200,
          byTask: true,
        })
        for (const report of Array.isArray(rowsForRoot) ? rowsForRoot : []) {
          reports.push(Object.assign({}, report, { root: root.id, engagement }))
        }
      } catch { /* missing/old report tables should not hide the board */ }
    }
  }

  const rootPath = (() => { try { return store && store.root } catch { return undefined } })()
  const clockMinutes = clockConfig(readSettings(rootPath)).minutes
  const staleMs = clockMinutes > 0 ? clockMinutes * 60 * 1000 : 0
  const merged = mergeTeamBoardTasks(tasks, reports, {
    staleMs,
    claimedAt: (task) => claimedAt(task),
  }).filter((task) => task.status !== 'deleted')
  const visibleRootIds = new Set(visibleRoots.map((root) => root.id))
  for (const rootId of visibleRootIds) {
    lastTeamTasksByRoot.set(rootId, merged.filter((task) => task.root === rootId))
  }
  /* A complete unfiltered scan is authoritative for root disappearance.  A
     selected-root or engagement-filtered scan must preserve other roots so a
     sidebar refresh cannot erase their stall timestamps. */
  if (!selectedRoot && !requestedEngagement) {
    const liveRootIds = new Set(roots.map((root) => root.id))
    for (const rootId of Array.from(lastTeamTasksByRoot.keys())) {
      if (!liveRootIds.has(rootId)) lastTeamTasksByRoot.delete(rootId)
    }
  }
  lastTeamTasks = Array.from(lastTeamTasksByRoot.values()).flat()
  const engagementValues = Array.from(new Set(tasks.map((task) => task.engagement).filter(Boolean)))
  return {
    ok: true,
    engagement: engagementValues.length === 1
      ? engagementValues[0]
      : (requestedEngagement && visibleRoots.length ? requestedEngagement : null),
    root_sessions: visibleRoots.map((root) => root.id),
    tasks: merged,
    sessions: rows.filter((row) => row.id),
    failures,
    note: merged.length === 0
      ? 'Phiên redteam chưa bật bảng nhiệm vụ chia sẻ, hoặc vòng này chưa giao việc.'
      : 'Sắp theo "cần người nhất"; stage là kết luận duy nhất sau khi hợp nhất trạng thái nhiệm vụ chính thức với báo cáo của plugin này.',
  }
}

/**
 * Agent concurrency state (for the "Agents" tab): reads child sessions actually
 * running in the subagents registry. Same rules as the tool-layer
 * `redteam_agent_slot`, but read-only and never parks a slot.
 * @param ctx - plugin context.
 * @param request - `{ op: 'agentsStatus' }`.
 * @returns JSON result, or undefined when this is not that op.
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus' && request.op !== 'setAgentsMax') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  if (request.op === 'setAgentsMax') {
    const next = saveMaxAgents(root, request.max)
    return {
      ok: true, max: next, source: 'settings', limit: MAX_AGENTS_LIMIT,
      note: 'Đã lưu thành ' + next + ' tác tử thực thi đồng thời, **có hiệu lực ngay** (giao việc sẽ xét theo giá trị mới, không cần khởi động lại dsh web).',
    }
  }
  const max = maxAgentsOf(root, process.env)
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'Sổ đăng ký subagents / sessions không khả dụng: không đọc được mức chiếm dụng đồng thời.', max }
  }
  const children = []
  try {
    /*
     * We need the sessions that are children of nobody, then listChildren on each.
     * The test must match identity.isChildAgentContext: delegation origin / depth only.
     * An earlier `parentSession == null` root filter silently dropped redteam sessions
     * resumed or branched from history (delegationDepth 0 but with parentSession), so
     * their subagents were not counted and `redteam_agent_slot` let over-allocation
     * through.
     */
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      if (!header) return false
      const origin = String(header.origin || '').toLowerCase()
      if (origin === 'subagent' || origin === 'teammate' || origin === 'delegate') return false
      return Number(header.delegationDepth ?? 0) <= 0
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ id: String(k.id), parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* skip a session that cannot be read */ }
    }
  } catch (error) {
    return { ok: false, error: 'Liệt kê phiên con thất bại: ' + (error && error.message ? error.message : String(error)), max }
  }
  /* Same parked state as the tool layer: waiting/blocked agents yield their slot and
     are listed only, not counted in used */
  const runningRows = []
  const parkedRows = []
  for (const c of children) {
    if (c.activity !== 'running') continue
    if (isParked(c.parent, c.id)) parkedRows.push({ parent: c.parent, label: c.label, activity: c.activity, mode: c.mode })
    else runningRows.push({ parent: c.parent, label: c.label, activity: c.activity, mode: c.mode })
  }
  return {
    ok: true, max, used: runningRows.length, free: Math.max(max - runningRows.length, 0),
    running: runningRows.slice(0, 20), total_children: children.length,
    parked: parkedRows.length, parked_labels: parkedRows.map((p) => p.label).slice(0, 20),
    source: maxAgentsSourceOf(root, process.env),
    limit: MAX_AGENTS_LIMIT,
    default_max: DEFAULT_MAX_AGENTS,
    note: 'Cùng một phiên (mục tiêu) tối đa ' + max + ' tác tử thực thi đồng thời; mặc định giao việc tuần tự.'
      + (parkedRows.length ? ' (thêm ' + parkedRows.length + ' cái đang chờ người cấp tài nguyên, đã nhường suất)' : ''),
  }
}

/**
 * Version and update ops (the panel's "version + auto update" in the top right).
 * Does not touch the asset library; works on the profile and npm/pnpm, all host side.
 * @param ctx - plugin context.
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`.
 * @returns JSON result, or undefined when this is not an update op.
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  /* Private pinned version: no npm / GitHub lookup, no install, no host restart. */
  const pkg = pluginIdentity(ctx)
  return {
    ok: false,
    sealed: true,
    current: pkg.version,
    plugin: pkg,
    latest: null,
    updateAvailable: false,
    localAhead: false,
    install: { mode: 'sealed', packageManager: null },
    blockers: [],
    notes: ['Bản riêng cố định, đã tắt cập nhật.'],
    error: 'Bản riêng cố định, đã tắt cập nhật',
    running_agents: [],
  }
}


/**
 * @param ctx - plugin context (redteam / webServer / skills / agentPresets available).
 */
export function apply(ctx) {
  const store = ctx.redteam

  /* Read-only stall observation.  It consumes the last board snapshot only;
     it never lists sessions, dispatches agents, sends messages, or performs
     network access. */
  ctx.effect(() => {
    const root = (() => { try { return store && store.root } catch { return undefined } })()
    const dispose = startClock(
      ctx,
      () => lastTeamTasks,
      () => clockConfig(readSettings(root)),
    )
    return () => { try { dispose() } catch { /* already disposed */ } }
  }, 'de-policy: orchestrator clock')

  /* Hard backstop after send in a redteam session: reject step one when the env is not
     ready, so work cannot start unprepared */
  try {
    if (!ctx.__dshpEnvAdaptPreStep) {
      ctx.__dshpEnvAdaptPreStep = true
      const root = store && store.root ? store.root : redteamRoot()
      const hook = async (payload, next) => {
        try {
          const agent = payload && payload.agent
          const header = agent && agent.session && agent.session.header
          const preset = header && header.agentPreset
          if (preset === 'redteam') {
            const turn = Number(payload && payload.turn) || 0
            const step = Number(payload && payload.step) || 0
            if (turn <= 1 && step <= 1) {
              const status = envAdaptStatus(root)
              if (!status.ready) {
                return {
                  kind: 'reject',
                  reason: status.message
                    || 'Môi trường chưa thích ứng: hãy mở de-policy → công cụ cấu hình thích ứng môi trường, hoặc xác nhận tạm không cấu hình rồi gửi lại.',
                  messages: [],
                }
              }
            }
          }
        } catch { /* gate errors must not block */ }
        return next()
      }
      // Wrapped in ctx.effect → the hook unbinds on plugin dispose, so no event handler
      // fires into unloaded code. The installed flag prevents duplicate registration
      // (cordis allows the same handler twice, which fires multiple times).
      ctx.effect(() => {
        let installed = false
        let disposer = null
        const install = () => {
          if (installed) return
          try {
            disposer = ctx.on('agent/pre-step', hook, { global: true, prepend: true })
            installed = true
          } catch { /* ignore */ }
        }
        install()
        queueMicrotask(install)
        const timer = setTimeout(install, 800)
        return () => {
          clearTimeout(timer)
          try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
          delete ctx.__dshpEnvAdaptPreStep
        }
      })
    }
  } catch { /* ignore */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      /* Origin check: local loopback is always allowed (official desktop Origin is
         usually app:// / file://, and the old logic nulled Origin.host then returned
         403, breaking skill library / knowledge base / SQL).
         Origin and Host must match only for non-loopback peers.
         Also: when desktop is reached via a local LAN address (Host not localhost)
         the peer is still local and Origin is app:// / file:// / null — allow it too;
         only a genuinely foreign peer is checked strictly for same-origin. */
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      const originText = typeof origin === 'string' ? origin.trim() : ''
      const originMissing = origin === undefined || originText === ''
      const nullOrigin = originText === 'null'
      const appOrigin = APP_ORIGIN_RE.test(originText)
      const selfConn = loopback || selfAddressSet().has(remote)
      const originOk = (() => {
        if (loopback) return true
        /* Local connection + custom protocol / no Origin: desktop; excludes `null`
           (sandboxed iframes can send null too, kept as a CSRF boundary) */
        if (selfConn && (originMissing || appOrigin)) return true
        /* Official desktop: Origin is usually app:// / null, Host still 127.0.0.1:port */
        if (hostLocal) {
          if (nullOrigin || appOrigin) return true
          try {
            const oh = new URL(origin).host
            if (oh === host || oh === '' ) return true
          } catch { /* fall through */ }
        }
        if (typeof origin !== 'string' || origin === '') return false
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        return originHost !== null && originHost === host
      })()
      if (!originOk) {
        logCorsReject(req, {
          path: '/redteam/api', remote, host, origin,
          site: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : '',
        })
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        const platformResult = handlePlatformOp(store, request, ctx)
        if (platformResult !== undefined) {
          sendJson(res, 200, platformResult)
          return
        }
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const boardResult = await handleTeamBoardOp(ctx, request)
        if (boardResult !== undefined) {
          sendJson(res, 200, boardResult)
          return
        }
        const orchResult = await handleOrchestratorOp(ctx, request)
        if (orchResult !== undefined) {
          sendJson(res, 200, orchResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        let skillResult
        try {
          skillResult = await handleSkillOp(ctx, request)
        } catch (skillErr) {
          /* Never return 400 when inject is missing on desktop: file fallback */
          if (request && (request.op === 'skillCatalog' || request.op === 'skillRead')) {
            skillResult = handleSkillOpFromPluginDir(request)
            if (!skillResult || skillResult.ok === false) {
              skillResult = {
                ok: false,
                error: 'Đọc kỹ năng thất bại: ' + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
              }
            }
          } else {
            throw skillErr
          }
        }
        const withRoot = (typeof request.session === 'string' && request.session)
          ? Object.assign({}, request, { resolveRoot: (sid) => resolveRootSessionId(ctx, sid) })
          : request
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, withRoot) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
