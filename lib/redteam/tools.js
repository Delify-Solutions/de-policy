/**
 * RedTeam agent tool set (preset plane)
 *
 * These rows only register model-visible tools with `tools` and publish no service, so no isolate
 * realm is needed; they resolve the host-plane `ctx.redteam` (published by dsh-redteam-store).
 *
 * Design rules:
 *   · Writes go through redteam_asset_add / redteam_asset_link; agents never touch SQL.
 *   · Every finding carries provenance (passive|active) and tool for trustworthy attribution.
 *   · **Targets are isolated per root session**: the bind key is the root ancestor id; children
 *     inherit via `session.header.parentSession`, so parallel sessions never cross-write and
 *     reports are never polluted (the pre-v0.9.0 global pointer was the cross-write source).
 *   · Hard limit: `redteam_agent_slot` reads real running counts from `ctx.subagents.listChildren`
 *     to cap "3 executor agents per target" and rejects the excess instead of trusting prompts.
 */
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* Skill availability has one implementation: the panel skill-library tab shares it (see that header) */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
/* Template freshness: status and refresh live in bootstrap-runtime; this only wraps the tool surface */
import { templatesStatus, refreshTemplateLibrary } from './bootstrap-runtime.js'
/* Advisory layer (CISA KEV): a light index of "is this CVE exploited in the wild"; silent on failure */
import { kevStatus, lookupKev, refreshKevIfStale } from './kev.js'
/* Slot hold state: the tool layer writes, the panel reads, one shared source (see that header) */
import { isParked, parkAgent, unparkAgent } from './slot-state.js'

/**
 * link: the source package is not inside the profile node_modules tree, so a static import of
 * `@deepseek-ai/dsh-tools` fails → the preset row fiber is undefined (never started) → the whole
 * "red team mode" is filtered out of the dropdown. Resolve with createRequire from the dsh path.
 */
function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* fall back to the original path */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm global argv is often …/bin/dsh, with the real package in the adjacent lib/node_modules. */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('de-policy/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineTool = loadDefineTool()

/** Cordis plugin name. */
export const name = 'de-policy-redteam-tools'

/** Hard dependency on the tool registry; `redteam` is published by the store on the host plane. */
export const inject = ['tools']

/**
 * Plain text of a child agent's last message.
 * Host `subagent/end.lastAssistantMessage` is a content-block array (`[{type:'text',text}]`),
 * but may be a string or `{content:[...]}`; all three handled, '' when nothing is found.
 */
function textOfAssistantMessage(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const blocks = Array.isArray(message) ? message : (Array.isArray(message.content) ? message.content : null)
  if (blocks !== null) {
    return blocks.map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b.text === 'string') return b.text
      return ''
    }).join('\n')
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

/** Root session id → engagementId binding (stable in a session; the agent rebinds after a restart). */
const bindings = new Map()
/** Concurrency gate: root session id → Map(child key → reservation time); auto-released at child end. */
const reservations = new Map()

/** FIFO cap: long sessions pile up dead session ids, so the oldest go first (FIFO, roughly LRU). */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** Concurrency limit: reads settings.json each call → REDTEAM_MAX_AGENTS → default 3. */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** Session resolution result for one call. */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/** Session id (compatible with older call sites). */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * Resolve the "root session": walk parentSession up to the topmost session id.
 * Child agents of a main session share one bind key, while **different main sessions stay
 * isolated**. Every id along the chain is returned so bindings can be cached on child sessions.
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* Parent session no longer in memory (reclaimed / cold start): the parent id is a stable root key */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** Bind key plus session chain. */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * Resolve which target this call acts on (session-isolated version).
 *
 * Order: (1) explicit argument → (2) binding on this session/parent chain → (3) global pointer
 * (only when no other session holds it; if held, error and ask for an explicit binding).
 *
 * Erroring instead of picking at random is deliberate: **never silently cross-write**.
 * A wrong pick files one unit's results under another.
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          'Phiên này chưa gắn mục tiêu, còn "mục tiêu hiện tại" toàn cục ' + active + ' đã bị phiên khác chiếm; '
          + 'để tránh nhiều phiên cùng ghi vào một thư viện mục tiêu, hãy gắn tường minh: redteam_engagement_open (tạo mới / mở)'
          + ' hoặc redteam_session_bind (gắn vào mục tiêu đã có).',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('Chưa gắn mục tiêu: hãy gọi redteam_engagement_open và truyền tên đơn vị mục tiêu')
}

/** Binding state of the current session (used by redteam_session_info and the panel). */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** Comma/whitespace separated list → deduped array. */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** Compress an asset row into a compact model-readable shape (never dump raw store rows into context). */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* Discovery time: when this asset first entered this store (used for timelines) */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** Legal values of role codes (written into tool descriptions so the model need not guess). */
const ROLE_HINT = 'Role codes: ' + ROLE_ORDER.map((r) => '`' + r + '` (' + ROLE_TITLES[r] + ')').join(', ')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

function recordSessionBinding(store, exec, engagementId, name) {
  if (typeof store.setSessionBinding !== 'function') return
  const { rootId, sessionId } = bindingKeyOf(exec)
  const key = rootId || sessionId
  if (!key) return
  try { store.setSessionBinding(String(key), String(engagementId), name) } catch { /* panel fallback */ }
}

/** Live concurrency usage: counts direct child sessions actually running in the subagents registry. */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, parked: 0, error: 'Sổ đăng ký subagents không khả dụng (không đối chiếu được số chạy thực tế, chỉ đếm theo chỗ đã giữ)' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const runningAll = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    /* Holds (blocked/waiting) take no slot: idle holders would deadlock concurrency */
    const running = runningAll.filter((e) => !isParked(rootSessionId, e.id))
    const parkedRows = runningAll.filter((e) => isParked(rootSessionId, e.id))
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      parked: parkedRows.length,
      parked_labels: parkedRows.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, parked: 0, error: 'Liệt kê phiên con thất bại: ' + (error && error.message ? error.message : String(error)) }
  }
}

/** Reservations not yet covered by the subagents registry (e.g. just acquired, not started). */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* No key releases the earliest entry only; clearing all would oversell slots */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * Agent role that produced this record: explicit value wins, otherwise it books to the main
 * session. The value lands in the `agent` column, which is how reports say who did each step.
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** Shared agent argument for write tools (the role-code whitelist hint goes into the description). */
const AGENT_PARAM = {
  type: 'string',
  description: '[Recommended] Role that produced this record — ' + ROLE_HINT
    + '. The report uses it to mark "who did this step"; omit it and the step books to the main session.',
}

/**
 * Converge exceptions thrown by the store layer into structured failure returns.
 *
 * Why: the same class of error (missing object / invalid argument) had two shapes — some tools
 * `return { ok:false, error }`, others threw. A model can retry the former with new arguments,
 * but usually abandons the call on the latter. Standardize on the former; **never swallow it**.
 * @param tool - the defineTool return value.
 * @returns the same tool definition wrapped in try/catch.
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* Argument errors are reported apart from "not found" so the model may retry or abort */
        // The message may be written in Chinese, English or Vietnamese — an error this
      // file raises is Chinese, but an engine or host error passed through is not.
      /* Store-layer errors are still raised in Chinese: match them by \u escape so no Han literal sits in this file */
      const kind = /invalid|required|not found|missing|không hợp lệ|bắt buộc|không được để trống|không tìm thấy|không tồn tại|chưa gắn|chỉ nhận|chỉ chấp nhận|vượt quá|sai định dạng|phải trong khoảng|không xác định|\u975E\u6CD5|\u4E0D\u80FD\u4E3A\u7A7A|\u4E0D\u5B58\u5728|\u53EA\u63A5\u53D7|\u53EA\u7531/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? 'Đây là vấn đề về tham số hoặc định danh đối tượng: kiểm tra tên tham số và giá trị (có thể dùng các tool *_list / *_query tương ứng để xem id thực tế), sửa rồi thử lại.'
            : 'Tool chạy thất bại, nội dung lỗi gốc xem ở trường error; đừng lặng lẽ bỏ qua, hãy nói rõ điểm tắc cho người dùng hoặc người chỉ huy trước.',
        }, null, 2)
      }
    },
  })
}

/* ════════════════════════════════════════════════════════════════════════
   Scope check and tunnel verification (ported in v0.15)
   Target scope is the only source of truth for the authorization boundary; bulk asset/vuln
   intake and scope queries pass through here, skipping out-of-scope rows instead of writing them.
   ════════════════════════════════════════════════════════════════════════ */

/** Parse IPv4 to an integer; return null when it is not IPv4. */
function ipv4Int(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (m === null) return null
  const n = m.slice(1).map(Number)
  if (n.some((x) => x > 255)) return null
  return ((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3]
}

/** IPv4 findable in a target string (URL / host:port / bare IP); null when not found. */
function targetIpv4(target) {
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(target || ''))
  return m === null ? null : m[1]
}

function ipInCidr(ip, cidr) {
  const [base, bitsText] = String(cidr || '').split('/')
  const a = ipv4Int(ip)
  const b = ipv4Int(base)
  const bits = Number(bitsText)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  return (a & mask) >>> 0 === (b & mask) >>> 0
}

function scopeOfEngagement(store, id) {
  try {
    const row = store.listEngagements().find((e) => e.id === id)
    return Array.isArray(row && row.scope) ? row.scope : []
  } catch { return [] }
}

/** Scope: no scope → 'unscoped'; scope set and IP matches → in; IP absent → out; domain → unresolved. */
function scopeCheck(store, id, target) {
  const scope = scopeOfEngagement(store, id)
  if (scope.length === 0) return { status: 'unscoped', scope, ip: null }
  const ip = targetIpv4(target)
  if (ip === null) return { status: 'unresolved', scope, ip: null }
  const hit = scope.find((cidr) => ipInCidr(ip, cidr))
  return { status: hit === undefined ? 'out' : 'in', scope, ip, cidr: hit || null }
}

/** One CONNECT probe through a SOCKS5 proxy (suo5/chisel local listeners both support it). */
function socks5Probe(listen, target, timeoutMs = 6000) {
  const proxy = String(listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
  const pi = proxy.lastIndexOf(':')
  const ph = pi > 0 ? proxy.slice(0, pi) : '127.0.0.1'
  const pp = Number(pi > 0 ? proxy.slice(pi + 1) : proxy)
  const ti = target.lastIndexOf(':')
  const th = ti > 0 ? target.slice(0, ti) : target
  const tp = Number(ti > 0 ? target.slice(ti + 1) : 0)
  if (!Number.isFinite(pp) || pp <= 0 || !Number.isFinite(tp) || tp <= 0) {
    return Promise.resolve({ ok: false, target, error: 'Không phân giải được cổng listen/target' })
  }
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    let stage = 'greeting'
    const socket = createConnection({ host: ph, port: pp })
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ ok, target, listen, latency_ms: Date.now() - started, error: error || undefined })
    }
    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || 6000, 1000), 20000))
    socket.on('timeout', () => finish(false, 'timeout'))
    socket.on('error', (e) => finish(false, String((e && e.code) || (e && e.message) || e)))
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        if (buf.length < 2 || buf[0] !== 5 || buf[1] !== 0) return finish(false, 'SOCKS5 greeting failed')
        stage = 'connect'
        const ip = ipv4Int(th)
        let req
        if (ip !== null) {
          const b = Buffer.alloc(10); b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 1
          b.writeUInt32BE(ip >>> 0, 4); b.writeUInt16BE(tp, 8); req = b
        } else {
          const hb = Buffer.from(th, 'utf8')
          const b = Buffer.alloc(7 + hb.length); b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 3; b[4] = hb.length
          hb.copy(b, 5); b.writeUInt16BE(tp, 5 + hb.length); req = b
        }
        socket.write(req)
        return
      }
      if (buf.length >= 2 && buf[0] === 5 && buf[1] === 0) finish(true)
      else finish(false, 'SOCKS5 connect rejected')
    })
  })
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('redteam store unavailable') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* ── child agent ends: release the concurrency slot + persist the structured report ───────────── */
  /* wrapped in ctx.effect → unbind subagent/end on dispose, else handlers linger and reload doubles them. */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined) unparkAgent(rootId, childId)
        /* Structured report: the host puts the child agent's last message in info.lastAssistantMessage.
           Parse and persist it here — only then does "who is waiting on me, and for what" become a
           queryable fact (see attentionQueue). If it cannot be parsed, write nothing — never guess. */
        try {
          const text = textOfAssistantMessage(info && info.lastAssistantMessage)
          const parsed = text === '' ? null : store.parseAgentReport?.(text)
          if (parsed) {
            const bound = bindings.get(rootId) ?? bindings.get(String(parentSession?.id ?? ''))
            if (bound !== undefined) {
              store.recordAgentReport(bound, {
                session_id: childId,
                parent_session: rootId,
                role: parsed.role ?? null,
                label: info && (info.label || info.id) ? String(info.label || info.id) : null,
                status: parsed.status,
                blocked_reason: parsed.blocked_reason,
                needs: parsed.needs,
                team_task_id: parsed.team_task_id,
                summary: text.slice(-1500),
              })
            }
            /* Waiting/blocked report: give the slot back too (covers a missing release) */
            if (parsed.status === 'blocked' || parsed.status === 'waiting') parkAgent(rootId, childId)
          }
        } catch { /* parse/persist failure never blocks slot release */ }
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* Registry keys may differ from runId: fall back to clearing the earliest reservation by time */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* when the event is unavailable only auto-release is affected; manual release still works */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: 'Open or create one red-team exercise target (by organization name) and bind **the current session** to it (subagents inherit it automatically). All later asset tools act on it by default. If the target already exists, its asset library is reused. Only this session\'s binding is written; targets other sessions are using are left untouched.',
    parameters: {
      target: { type: 'string', required: true, description: 'Target organization name, for example "Example Technology Co., Ltd."' },
      scope: {
        type: 'array',
        description: 'Authorized scope CIDR list (optional: if the user did not provide it, do not ask; proceed autonomously over the publicly visible asset surface)',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false — leave the global pointer alone: it causes cross-writing */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      recordSessionBinding(store, exec, engagement.id, args.target)
      const view = bindingViewOf(exec)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: 'Đã gắn vào phiên này (cách ly phiên: gắn của phiên khác không bị ảnh hưởng); subagent sẽ kế thừa mục tiêu này.'
          + (view.is_subagent ? ' Lưu ý: phiên này là subagent, thường không cần open nữa, cứ kế thừa mục tiêu của phiên cha.' : ''),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: 'Bind an **existing** target to the current session (used when sessions run in parallel: each session binds its own target, with no cross-writing). Accepts a target id or organization name; omit to list the bindable targets.',
    parameters: {
      engagement: { type: 'string', description: 'Target id or organization name; omit to list candidates only' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: 'Hãy truyền engagement (id mục tiêu hoặc tên đơn vị) để hoàn tất việc gắn.',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: 'Mục tiêu không tồn tại: ' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      recordSessionBinding(store, exec, hit.id, hit.name)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: 'Phiên này đã gắn vào "' + hit.name + '"; các tool và báo cáo về sau chỉ tác động lên nó.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: 'Show **which target the current session is bound to** (session id, parent session, root session, binding chain). When several sessions start at the same time, run this first to confirm you are not writing into someone else\'s target.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: 'Việc gắn là trạng thái trong tiến trình: sau khi dsh khởi động lại, mỗi phiên cần gắn lại một lần (redteam_engagement_open / redteam_session_bind).',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '[Run once before starting work] Platform skill and resource self-check: verifies each red-team skill\'s required environment variables (such as FOFA_KEY for FOFA mapping), local tools and binaries (suo5 / fscan / gogo / frp / Behinder / Godzilla / nmap / nuclei...), and external infrastructure (the VPS used for reverse shells). Returns an available/broken list plus, for every broken skill, what is missing and how to fix it. **When a key / VPS is missing, ask the user for it directly or switch to an alternative; never pretend it can run.**',
    parameters: {
      include: { type: 'string', description: 'Only check these skills (comma separated); omit to check every red-team skill' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      const plat = platformSummary()
      /* Template freshness: preflight reports how stale the local template library is, plus missing tools */
      let tplStatus = null
      try { tplStatus = templatesStatus(store.root) } catch { tplStatus = null }
      /* Advisory layer: status only, never blocks (unreachable means unavailable) */
      let kevInfo = null
      try { kevInfo = kevStatus(store.root) } catch { kevInfo = null }
      /* The intel layer reports local status only; a missing DB or module degrades silently, never blocks. */
      let cveDb = null
      try {
        const cve = await import('./cve-db.js')
        cveDb = typeof cve.cveDbStatus === 'function'
          ? cve.cveDbStatus(store.root)
          : { available: false, count: 0, note: 'Trạng thái kho lỗ hổng công khai không khả dụng' }
      } catch {
        cveDb = { available: false, count: 0, note: 'Module kho lỗ hổng công khai không khả dụng' }
      }
      let intelSyncInfo = null
      try {
        const sync = await import('./intel-sync.js')
        intelSyncInfo = typeof sync.intelSyncStatus === 'function'
          ? sync.intelSyncStatus(store.root)
          : { enabled: false, base: '', note: 'Trạng thái đồng bộ tình báo không khả dụng' }
      } catch {
        intelSyncInfo = { enabled: false, base: '', note: 'Module đồng bộ tình báo không khả dụng' }
      }
      const cfg = loadPlatformConfig()
      /* Real sources of env vars: process env + $DSH_HOME/.env + platform config.json env */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = mergeConfigEnv({ ...process.env }, cfg)
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            /* Accepts shell habits: `export KEY=value`; strips unquoted trailing comments (`KEY=v # note`) */
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            let raw = m[2].trim()
            if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
            const value = raw.replace(/^["']|["']$/g, '').trim()
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* an unreadable .env does not affect the main flow */ }

      const toolkit = toolkitDirOf(cfg)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* ignore */ }

      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const setupScript = redteamDir + '/setup.sh'
      const hasMarker = existsSync(markerFile)
      const hasSetupScript = existsSync(setupScript)
      const toolkitHint = 'Plugin này không tải hay cài tool thay người dùng. Trên Windows và khi không có setup.sh, vào "Thích ứng môi trường" của Bảng diễn tập để điền đường dẫn, FOFA_KEY và VPS; khi máy đã có `$DSH_HOME/redteam/setup.sh`, để chính người dùng chạy `--check`, đừng để agent chạy `--yes` đi tải binary.'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + (plat.runtime.windows ? '\\vps\\id_rsa' : '/vps/id_rsa'))
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''
      const hasVps = existsSync(vpsKey)
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY (đo đạc tài sản: điền ở trang "Thích ứng môi trường", hoặc ghi vào $DSH_HOME/.env)')
      if (!hasVps) {
        missing.push(plat.runtime.windows
          ? 'Khóa riêng VPS (điền đường dẫn REDTEAM_VPS_KEY và REDTEAM_VPS_HOST ở "Thích ứng môi trường"; Windows không phụ thuộc setup.sh)'
          : 'Cách đăng nhập VPS — đặt khóa riêng vào ' + vpsKey + ', và đặt REDTEAM_VPS_HOST (các bước xem skill redteam-setup, hoặc "Thích ứng môi trường" của Bảng diễn tập)')
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '…' + fofaKey.slice(-4) : '(đã cấu hình)'
      const runtimeHint = plat.runtime.windows
        ? 'Hiện đang ở **chế độ thích ứng Windows**: hãy cấu hình đường dẫn tool / thư mục tìm kiếm và FOFA/VPS ở trang "Thích ứng môi trường" của Bảng diễn tập; đừng giả định có Kali/`bash setup.sh`. Vẫn nên dùng máy chuyên cho diễn tập, đừng đặt khóa riêng và scanner trên máy công việc hằng ngày.'
        : 'Chế độ này nên chạy trong **máy ảo Kali dành riêng cho diễn tập**, đừng chạy trên máy tính công việc / máy host hằng ngày'
          + ' (máy sẽ chứa khóa riêng VPS và webshell, lưu lượng quét cũng đi ra từ IP thoát quen dùng; diễn tập xong có thể bỏ luôn máy ảo).'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* Desktop often has no skills inject: still return platform tool probes so preflight is not wasted */
        const toolMissing = (plat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        if (toolMissing.length) {
          missing.push('Tool chưa phân giải được (điền đường dẫn hoặc thêm thư mục tìm kiếm ở "Thích ứng môi trường"): ' + toolMissing.slice(0, 12).join(', '))
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
            vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
            vps_host: vpsHost,
            env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          missing,
        }
        return JSON.stringify({
          ok: missing.length === 0 && toolMissing.length === 0,
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: 'Dịch vụ skills của host không khả dụng: đã bỏ qua bước kiểm tra nội dung skill, chỉ trả về dò tool của nền tảng. Hãy vào "Thích ứng môi trường" để cấu hình đường dẫn.',
          cve_db: cveDb,
          intel_sync: intelSyncInfo,
          next: plat.runtime.windows
            ? 'Mở Bảng diễn tập > "Thích ứng môi trường": ① điền binDirs (thư mục tool của bạn) hoặc từng đường dẫn tools ② điền FOFA_KEY / VPS ③ lưu rồi chạy lại preflight. Đừng tải tool thay người dùng.'
            : (hasSetupScript
              ? 'Có thể để chính người dùng chạy bash "$DSH_HOME/redteam/setup.sh" --check, hoặc vào "Thích ứng môi trường" tự điền đường dẫn. Đừng để agent tải tool.'
              : 'Máy này không có setup.sh, đây là chuyện bình thường. Vào Bảng diễn tập > "Thích ứng môi trường" tự điền đường dẫn, hoặc cấu hình từng mục theo skill redteam-setup.'),
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: 'Đọc thư mục skill thất bại: ' + (error && error.message ? error.message : String(error)), platform: plat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* With include, only named skills are checked, so an unrelated broken skill cannot drag ok to false */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          // `skill-availability.js` is the only source of these strings, and it emits
          // `biến môi trường <NAME>` and `VPS address` / `VPS hostname`. Matching on a
          // Han character was wrong for both: it never fired for the env-var form, and
          // it fired for nothing else either. Match the prefixes as emitted, plus the
          // Chinese form so a skill body that still carries one reads correctly.
          needs_user: verdict.needs_user.map((n) => {
            const envVar = /^(?:biến môi trường|环境变量)\s+(\S+)/i.exec(n)
            if (envVar) {
              return 'Biến môi trường ' + envVar[1]
                + (plat.runtime.windows
                  ? ' (có thể điền ở trang "Thích ứng môi trường")'
                  : ' (sau khi có thì export và khởi động lại dsh web)')
            }
            if (/^VPS\s+(address|hostname|地址|主机名)/i.test(n)) {
              const which = /address|地址/i.test(n) ? 'địa chỉ VPS' : 'tên máy VPS'
              return 'Thông tin ' + which
                + ' dùng cho reverse shell / đưa payload (trong skill vẫn còn là placeholder)'
            }
            return n
          }),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => only.length === 0 || only.includes(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (plat.tools.items || []).filter((t) => !t.path)
      if (toolMissing.length) {
        missing.push('Tool trên máy chưa phân giải được ("Thích ứng môi trường" để điền đường dẫn): ' + toolMissing.slice(0, 10).map((t) => t.id).join(', '))
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        missing,
      }
      let next
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next = 'Windows: mở Bảng diễn tập > "Thích ứng môi trường" để cấu hình đường dẫn toolkit/binDirs/tools và FOFA/VPS, lưu rồi chạy lại redteam_preflight; khi nội dung skill thiếu đường dẫn thì ưu tiên dùng đường dẫn tuyệt đối của tool đã phân giải được.'
      } else if (!hasMarker && !hasSetupScript) {
        next = 'Dùng lần đầu, và máy này không có script cài đặt ' + setupScript + ' (đây là chuyện bình thường, không phải lỗi). '
          + toolkitHint + ' Liệt kê onboarding.missing cho người dùng một lần duy nhất; nếu không bù đủ thì nói rõ phương án giảm cấp: không có FOFA thì dùng crt.sh / DNS thụ động, không có VPS thì chỉ làm phần kết quả không cần hạ tầng.'
      } else if (!hasMarker) {
        next = '**Dùng lần đầu**: để chính người dùng chạy `bash ' + setupScript + ' --check`, hoặc mở Bảng diễn tập > "Thích ứng môi trường". Đừng để agent chạy --yes đi tải tool.'
      } else if (missing.length > 0) {
        next = 'Còn thiếu: liệt kê onboarding.missing cho người dùng một lần duy nhất. Trên Windows hoặc khi không có setup.sh thì đi theo "Thích ứng môi trường"; khi có script thì cũng chỉ để người dùng tự chạy, đừng tải tool thay người dùng.'
      } else if (allBroken.length > 0) {
        next = 'Liệt kê needs_user trong broken cho người dùng một lần duy nhất; nếu không bù đủ thì nói rõ phương án giảm cấp.'
      } else {
        next = 'Tất cả đều dùng được, có thể bắt đầu làm việc.'
      }

      const summary = summarizeSkills(checked)
      return JSON.stringify({
        /* include mode: ok reflects only the named skills; missing recon keys/VPS are notes, not failures */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes, note: 'ok chỉ phủ các skill được nêu tên; onboarding.missing là tham chiếu toàn cục, không ảnh hưởng ok lần này' } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: plat,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: 'Các bước sửa do người dùng thực hiện (hoặc qua trang "Thích ứng môi trường"); đừng tải/cài tool.' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        templates: tplStatus,
        kev: kevInfo,
        cve_db: cveDb,
        intel_sync: intelSyncInfo,
        skills_root_hint: 'Ở đây chỉ kiểm tra skill red team. Skill chính thức nằm ở $DSH_HOME/skills, không đánh giá là không khả dụng theo đường dẫn tool red team.',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '[Use before and after the main session hands out work, or when a subagent is stuck] Executor-agent concurrency gate: at most **3 running at once** per target (configurable with REDTEAM_MAX_AGENTS). action=status shows the remaining slots and who is running; action=acquire takes one slot (rejected outright when full, **do not retry and force it**); action=release frees one. **When a subagent reports blocked / waiting (waiting for a key, a VPS, a scope), call action=release key=<its own session id> yourself to hand the slot back**, do not sit there holding it; once unblocked, the main session assigns work again.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status to view / acquire to take a slot / release to free it' },
      label: { type: 'string', description: 'Task label for acquire, for example "recon: main domain and C segments"' },
      key: { type: 'string', description: 'Key to release: the main session passes the key returned by acquire, a subagent passes its own session id' },
      status: { type: 'string', enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'], description: '[Subagents only] Status of this report. blocked / waiting also parks this session and hands its concurrency slot back; progress / ready unparks it.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: 'Không lấy được id phiên: không thống kê được số chạy song song (hãy xác nhận lời gọi tool có kèm ngữ cảnh agent).' }, null, 2)
      }
      /* When a child agent calls itself (sessionId ≠ owner), it holds its own slot */
      const selfChild = sessionId !== undefined && sessionId !== owner ? sessionId : undefined
      const reportStatus = typeof args.status === 'string' ? args.status : ''
      if (reportStatus !== '') {
        if (selfChild === undefined) {
          return JSON.stringify({ ok: false, error: 'status chỉ do subagent thực thi điền; phiên chính dùng label/key để thao tác chỗ.' }, null, 2)
        }
        if (reportStatus === 'blocked' || reportStatus === 'waiting') {
          parkAgent(owner, selfChild)
        } else if (reportStatus === 'progress' || reportStatus === 'ready') {
          unparkAgent(owner, selfChild)
        }
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* Child sessions marked running already include in-flight ones; reservations cover "just
         claimed, not yet in the registry". Take the larger value: no double count, no undercount. */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        parked: live.parked ?? 0,
        parked_labels: live.parked_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? 'Hết chỗ: đợi agent hiện có báo cáo rồi mới giao tiếp (mỗi lần giao một cái, đẩy theo thứ tự là nhịp ổn định nhất).'
            : 'Còn ' + free + ' chỗ. Mặc định giao từng cái một; chỉ chạy song song những việc thật sự không phụ thuộc nhau.',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: 'Đã đầy chỗ chạy song song (tối đa ' + cap + '): hiện không giao được agent mới. Hãy đợi agent đang chạy báo cáo, hoặc release những cái đã kết thúc trước.',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(cap - used - 1, 0) }, {
          hint: 'Đã giữ chỗ (' + key + '). **Giao xong nhớ**: subagent kết thúc sẽ tự nhả; nếu bạn giao việc thất bại (ví dụ tool báo lỗi), hãy tự nhả bằng redteam_agent_slot action=release key=' + key + '.',
        }), null, 2)
      }
      /* release: a child passing its own key releases itself; the main session passes acquire's key.
         With no key a child releases only its own entry, never the earliest (that frees main's hold). */
      const wanted = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined
      let dropped = false
      if (wanted !== undefined) dropped = dropReservation(owner, wanted)
      else if (selfChild !== undefined) dropped = dropReservation(owner, selfChild)
      else dropped = dropReservation(owner, undefined)
      /* In the same round status=blocked/waiting just held itself; do not strip it here */
      const holding = reportStatus === 'blocked' || reportStatus === 'waiting'
      if (selfChild !== undefined && !holding && unparkAgent(owner, selfChild)) dropped = true
      /* Flags above moved, so base.used may be stale: recompute before reporting */
      const liveNow = await liveRunningChildren(ctx, owner)
      const usedNow = Math.max(liveNow.running, reservationList(owner).length)
      return JSON.stringify(Object.assign(base, {
        ok: true, released: dropped,
        used: usedNow, free: Math.max(cap - usedNow, 0),
        parked: liveNow.parked ?? base.parked,
        parked_labels: liveNow.parked_labels ?? base.parked_labels,
        note: dropped ? undefined : 'Không tìm thấy chỗ nào để nhả (có thể đã được subagent/end tự nhả). Nếu bạn đang chờ người khác cấp tài nguyên, cứ kết thúc lượt và báo cáo là được.',
      }), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: 'Write an asset with its ports/services/fingerprints into the asset library (idempotent upsert). Every finding must declare provenance: passive for passive collection, active for active probing, plus tool (data source or tool name).',
    parameters: {
      engagement: { type: 'string', description: 'Target id; omit to use the target bound to the current session' },
      ip: { type: 'string', required: true, description: 'Asset IP (IPv4)' },
      state: { type: 'string', description: 'live | dead | unknown, defaults to unknown' },
      primary_name: { type: 'string', description: 'Primary domain/hostname' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: 'Source of this finding: passive or active' },
      tool: { type: 'string', description: 'Data source or tool name, for example crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '[Optional] Discovery time of this asset (ISO, e.g. 2026-09-17T09:30:00Z). When omitted it is recorded as the moment the asset first entered the library; passing the historical first-seen time reported by the data source is more accurate. **Repeated collection never overwrites it**.' },
      first_seen: { type: 'string', description: '[Optional] First-seen time reported by the data source/tool (recorded separately from the discovery time)' },
      names: {
        type: 'array',
        description: 'Domain/certificate name associated with this asset',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn, defaults to domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: 'Open ports with their services/fingerprints',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp (default) | udp' },
            service: { type: 'string', description: 'Service name, for example http / mysql' },
            product: { type: 'string', description: 'Product name, for example nginx' },
            version: { type: 'string', description: 'Version, for example 1.24.0' },
            banner: { type: 'string', description: 'Raw banner snippet' },
            url: { type: 'string', description: 'Full URL the web service can be reached at, for example https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web page title (obtained by HTTP probing), for example "Seeyon OA login"' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web server | middleware | framework | CMS | database | VPN gateway ...' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: 'Basis for the judgement, for example response header / path / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* Discovery time: when omitted the server records the first intake moment automatically; pass a
           historical time when the source has one (FOFA first_seen etc.) for a better report timeline. */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: 'Thời điểm phát hiện của tài sản này đã ghi là ' + (written && written.discovered_at ? written.discovered_at : '(chưa rõ)')
          + '; thu thập lặp lại chỉ làm mới last_seen, không thay đổi thời điểm phát hiện.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: 'Write one relation edge into the asset library (shared by the graph and later lateral analysis). relation examples: resolves / exposes / contains / trusts / shares_cert.',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: 'Query the asset library. Supports filtering by C segment, port, service, fingerprint, provenance, internal/external dimension (scope), sorting (sort), and keyword (full text, covering IP/domain/banner/service/fingerprint). Returns compact results with each asset\'s open ports, fingerprints and internal/external attribution.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C segment, for example 203.0.113.0/24' },
      port: { type: 'number', description: 'Open port' },
      service: { type: 'string', description: 'Service/product name keyword, for example nginx' },
      fingerprint: { type: 'string', description: 'Fingerprint keyword, for example Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: 'Only look at a passive or active provenance' },
      q: { type: 'string', description: 'Full-text search terms (space separated, multiple terms are ANDed)' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: 'Internal/external dimension: internal=intranet/private address, external=internet reachable' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip'], description: 'Sort: priority=easiest to exploit first (default), todo=untested first, ports=most ports first, ip=by IP' },
      limit: { type: 'number', description: 'Maximum number of rows, defaults to 50, max 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: 'Fetch full details for a single asset: every port and service, fingerprints, collection provenance timeline, relation edges. Used to analyze one target in depth.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'Asset id (from a redteam_asset_query result)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: 'Asset mapping overview: C segment count, asset count (live), open ports, services, fingerprints, passive/active provenance counts, and the detail of each C segment.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: 'Export the asset graph (C segment -> asset -> open ports, including domain resolution edges) for topology reasoning and lateral movement path planning. When the node count exceeds the cap, narrow by C segment.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'Only take the subgraph of one C segment' },
      maxNodes: { type: 'number', description: 'Node cap, defaults to 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Đồ thị có quá nhiều node (' + graph.nodes.length + ' > ' + maxNodes + '), hãy chỉ định cidr để thu hẹp phạm vi',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: 'Fetch the system prompt currently in effect for a red-team role, read-only. Do not paste the whole text into a task when assigning work; write redteamRole: <code> on the first line of the subagent prompt and the role draft enters the child session\'s system prompt.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* Role whitelist **derived from ROLE_ORDER**;
          hardcoding 4 values once dropped assess, while the preset requires the main session to
          fetch the triage prompt here; the enum then rejected it. Derivation cannot miss a role again. */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: 'List red-team roles and their responsibility titles (recon / vulnerability detection / exploitation / intranet penetration).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: 'Record test status for an asset: what was tested this round (`test`, append-only), what attack surface remains (`surface`, overwrite), the current test status, and whether WAF blocked you. **Call it once before starting on an asset (status=testing) and once when done or abandoned** — the asset mapping page shows "untested / testing / tested / blocked / abandoned / no_surface" from it. Ruled-out conclusions, login failure reasons and re-test reasons all go in `test`.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: 'Asset id (either this or ip; asset_id takes precedence)' },
      ip: { type: 'string', description: 'Asset IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: 'Test status: untested/testing/tested/blocked/abandoned/no_surface' },
      test: { type: 'string', description: 'What was tested this round (**appended** to the test record, for example "nmap all ports + nuclei cve templates + API IDOR"). Ruled-out conclusions, login failure reasons and re-test reasons also go here.' },
      notes: { type: 'string', description: 'Compatibility alias for test (used by older prompts); behaves like test and is appended to the test record as well.' },
      surface: { type: 'string', description: 'What attack surface remains (overwrite, for example "SMB 445 untested; Web /api IDOR not done")' },
      blocked: { type: 'boolean', description: 'Whether this round was blocked by a WAF/protection (true increments the block counter)' },
      updated_by: { type: 'string', description: 'Recording role, for example recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))


  /* ================================================================== template freshness
     The `poc` table holds self-verified experience, not "latest"; CVE currency comes from the local
     nuclei library. This gives status + manual refresh; startup runs a separate age-based refresh. */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_template_refresh',
    description: 'Template library freshness: show the template count / CVE template count / last refresh time of the local nuclei template library, and refresh it. **Check action=status before refreshing**; refresh replaces the whole directory (download into staging, swap only when the count matches), and keeps the old library on failure. Only the plugin\'s own copy ($DSH_HOME/redteam/toolkit/) is refreshed; the user-maintained ~/.local/nuclei-templates is never touched.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'refresh'], description: 'status only shows state; refresh decides whether to download based on the freshness window' },
      force: { type: 'boolean', description: 'refresh re-downloads unconditionally (ignoring the freshness window)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (args.action === 'status') {
        let status = null
        try { status = templatesStatus(store.root) } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2)
        }
        let kev = null
        try { kev = kevStatus(store.root) } catch { kev = null }
        return JSON.stringify({ ok: true, status, kev }, null, 2)
      }
      const out = await refreshTemplateLibrary({ force: args.force === true })
      /* The advisory layer is fetched with the templates: both are intel freshness, one click is enough */
      let kevOut = null
      try { kevOut = await refreshKevIfStale({ root: store.root, force: args.force === true }) } catch { kevOut = null }
      return JSON.stringify(Object.assign({ ok: out.action !== 'failed' }, out, { kev: kevOut }), null, 2)
    },
  })))
  /* ================================================================== coverage (single asset / host)
     0.15.8: makes "bulk scan then hand off" and "pop one point then wrap up" structurally
     impossible. These two op queues only answer "what is still missing" — no network, no auto-exploit. */

  const COVERAGE_STATES = ['untested', 'partial', 'done', 'blocked', 'not_applicable']

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset',
    description: '[Single-asset deep scan] External asset coverage: op=coverage shows which of surface/web/auth/cve/app are missing; op=update marks progress; op=close finalizes (rejected when incomplete). Use it to advance one asset at a time; do not replace deep scanning with bulk scanning (skill asset-deep-scan).',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['coverage', 'update', 'close'], required: true },
      asset_id: { type: 'number', required: true },
      surface: { type: 'string', enum: COVERAGE_STATES },
      web: { type: 'string', enum: COVERAGE_STATES },
      auth: { type: 'string', enum: COVERAGE_STATES },
      cve: { type: 'string', enum: COVERAGE_STATES },
      app: { type: 'string', enum: COVERAGE_STATES },
      note: { type: 'string' },
      status: { type: 'string', enum: ['closed', 'blocked'], description: 'op=close' },
      reason: { type: 'string', description: 'Required for op=close blocked' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'coverage') {
        return JSON.stringify({ ok: true, engagement: id, coverage: store.getAssetCoverage(id, args.asset_id) }, null, 2)
      }
      if (args.op === 'update') {
        const patch = {}
        for (const k of ['surface', 'web', 'auth', 'cve', 'app', 'note', 'blocked_reason']) {
          if (args[k] !== undefined) patch[k] = args[k]
        }
        return JSON.stringify({ ok: true, engagement: id, coverage: store.updateAssetCoverage(id, args.asset_id, patch, agentOf(args)) }, null, 2)
      }
      const coverage = store.closeAssetCoverage(id, args.asset_id, { status: args.status, reason: args.reason, actor: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, coverage }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_next',
    description: 'External single-asset deep-scan queue: returns assets that are not finished yet plus the missing items (surface/web/auth/cve/app). The main session uses it to assign vuln-scan per asset; it is not a scanner.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: 'Only look at one asset (optional)' },
      limit: { type: 'number', description: 'Defaults to 8, max 30' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const out = store.assetNextActions(id, { assetId: args.asset_id, limit: args.limit })
      return JSON.stringify(Object.assign({ ok: true, engagement: id }, out), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_host',
    description: '[Host post-exploitation] Host coverage and structured findings: op=coverage shows which of file/credential/privesc/web/db/lateral this host still misses; op=finding records file/credential/privesc/lateral/web/db/config/share findings; op=update marks manually; op=close finalizes (rejected while incomplete). Skill host-post-exploit.',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['coverage', 'finding', 'update', 'close'], required: true },
      asset_id: { type: 'number', required: true },
      kind: { type: 'string', enum: ['file', 'credential', 'privesc', 'lateral', 'web', 'db', 'config', 'share'], description: 'Required for op=finding' },
      title: { type: 'string' },
      detail: { type: 'string' },
      evidence_ref: { type: 'string' },
      access: { type: 'string', description: 'op=update: none/user/admin/root, etc.' },
      files: { type: 'string', enum: COVERAGE_STATES },
      privesc: { type: 'string', enum: COVERAGE_STATES },
      web: { type: 'string', enum: COVERAGE_STATES },
      db: { type: 'string', enum: COVERAGE_STATES },
      lateral: { type: 'string', enum: COVERAGE_STATES },
      credentials: { type: 'number', description: 'op=update: number of known credentials' },
      status: { type: 'string', enum: ['open', 'closed', 'blocked'] },
      reason: { type: 'string', description: 'op=close: blocked/reason for finalizing' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'coverage') {
        return JSON.stringify({ ok: true, engagement: id, coverage: store.getHostCoverage(id, args.asset_id) }, null, 2)
      }
      if (args.op === 'finding') {
        const out = store.addHostFinding(id, Object.assign({}, args, { created_by: agentOf(args) }))
        return JSON.stringify(Object.assign({ ok: true, engagement: id }, out), null, 2)
      }
      if (args.op === 'update') {
        const patch = {}
        for (const k of ['access', 'files', 'privesc', 'web', 'db', 'lateral', 'credentials', 'blocked_reason']) {
          if (args[k] !== undefined) patch[k] = args[k]
        }
        if (args.reason !== undefined && patch.blocked_reason === undefined) patch.blocked_reason = args.reason
        return JSON.stringify({ ok: true, engagement: id, coverage: store.updateHostCoverage(id, args.asset_id, patch, agentOf(args)) }, null, 2)
      }
      const coverage = store.closeHostCoverage(id, args.asset_id, { status: args.status, reason: args.reason, actor: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, coverage }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_next_action',
    description: 'Intranet next-action queue: returns what is still missing (files, credentials, privesc, web, db, lateral) per asset/service/current score. It is not automatic exploitation. Keep working while actions remain; finalize only when the queue is empty.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: 'Only look at one host (optional)' },
      limit: { type: 'number', description: 'Defaults to 8, max 30' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const out = store.hostNextActions(id, { assetId: args.asset_id, limit: args.limit })
      return JSON.stringify(Object.assign({ ok: true, engagement: id }, out), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attention',
    description: '[Run once per round before the main session reports] "Who are we waiting on right now": sorts each executor agent\'s latest **unprocessed** structured report by who needs a person most, together with what they need (key / VPS / scope / credentials / tools). If awaiting_person is returned, list every requirement to the user in one pass; if pending_coverage>0 is returned, nobody is waiting but work remains, so assign the next agent; only when both are zero is the round finished. **Call action=ack after handling one** (session_id=that report\'s session), otherwise it keeps counting as "someone is waiting" and the same paragraph is regenerated repeatedly.',
    parameters: {
      engagement: { type: 'string', description: 'Target id; omit to use the target bound to the current session' },
      limit: { type: 'number', description: 'Maximum rows to return, defaults to 20' },
      action: { type: 'string', enum: ['list', 'ack'], description: 'list (default) reads the queue; ack removes already-handled reports from it' },
      session_id: { type: 'string', description: 'ack: which executor session this report belongs to (removes its latest one)' },
      ids: { type: 'array', items: { type: 'number' }, description: 'ack: remove precisely by report row number' },
      all: { type: 'boolean', description: 'ack: finalize the whole queue' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.action === 'ack') {
        const ack = store.acknowledgeAgentReports(id, { session_id: args.session_id, ids: args.ids, all: args.all === true })
        if (ack.error) return JSON.stringify({ ok: false, engagement: id, error: ack.error }, null, 2)
        return JSON.stringify(Object.assign({ ok: true, engagement: id, ack }, store.attentionQueue(id, { limit: args.limit })), null, 2)
      }
      return JSON.stringify(Object.assign({ ok: true, engagement: id }, store.attentionQueue(id, { limit: args.limit })), null, 2)
    },
  })))

  /* ================================================================== vulnerability detection */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: 'Record a vulnerability finding (vulnerability-detection role). With cve it upserts idempotently by (asset_id, cve, target). severity: critical|high|medium|low|info; status: candidate (unverified)|confirmed (verified)|false-positive|exploited|fixed. Evidence is mandatory (request/response snippet, reproduction command, evidence file path).',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: 'Asset id (from redteam_asset_query)' },
      cve: { type: 'string', description: 'CVE / CNVD id (may be omitted when there is none)' },
      title: { type: 'string', required: true, description: 'Vulnerability title' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: 'Affected target, such as https://host:443/path or ip:port' },
      source: { type: 'string', description: 'Discovery method: nuclei / sqlmap / curl / manual ...' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: 'Evidence: request/response summary, commands, evidence file path' },
      found_by_agent: { type: 'string', description: 'Discovery role, defaults to vuln-scan' },
      gained: { type: 'string', description: '[Important] What access/result this vulnerability obtained; write score-style short labels, separating multiple items with commas, for example "server access, intranet tunnel" / "backend administrator account" / "database access"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: 'Query the vulnerability library: filter by severity, status, CVE, asset, C segment or keyword. Used to pick exploitation targets or to verify false positives.',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: 'Title/CVE/target/evidence keyword' },
      limit: { type: 'number', description: 'Defaults to 50, max 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: 'Update vulnerability status/severity/evidence (for example confirmed after verification, exploited after successful exploitation, false-positive for a false alarm).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'Vulnerability id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: 'What access/result this vulnerability obtained (score-style short labels, separate multiple items with commas)' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== exploitation / internal pivoting */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: 'Record a credential (exploitation/intranet-penetration role). **The password/key plaintext must go into secret_value** — the panel shows plaintext so it can be reused at any time; also point secret_ref at the evidence file under runs/. Note: this library is local only; never commit the library file or any export to a repository.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: 'Owning host (IP or domain)' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string, defaults to password' },
      secret_value: { type: 'string', description: '[Required] Credential plaintext: password / hash / private key / token / connection string' },
      secret_ref: { type: 'string', description: 'Evidence reference path, for example runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: 'Privilege level of this credential, such as admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: 'Source: exploit / dump / config-leak ...' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: 'Register an evidence screenshot: copy the image into the target directory and link it to a score point/hit (expanding the score point in the panel shows the image, and reports embed it too). For bulk score points (such as terminal access) show at most 3 representative images per point; there is no need to screenshot every host.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: 'Path of the image on this machine (relative to the target directory or absolute); either this or data_base64' },
      data_base64: { type: 'string', description: 'Image content (base64, may carry a data: prefix); use this when the screenshot tool did not write a file' },
      label: { type: 'string', description: 'Image caption, for example "domain controller WEB-SHDC1 atexec output nt authority\\system"' },
      kind: { type: 'string', description: 'screenshot (on-site screenshot, default) | card (evidence excerpt card generated from records, marked as such in reports)' },
      point_code: { type: 'string', description: 'Linked score point code, such as terminal-access / central-system' },
      hit_id: { type: 'number', description: 'Link to one specific score hit (score_hit id); with it the image hangs only on that hit' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: 'Target this image corresponds to (IP / URL)' },
      note: { type: 'string', description: 'Additional note: what this image proves' },
      source_ref: { type: 'string', description: 'Original source: the screenshot\'s output path or an evidence file under runs/' },
      captured_at: { type: 'string', description: 'Screenshot time (ISO); defaults to now' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: 'List registered evidence screenshots (with their score point, target, type and output file).',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: 'Delete one evidence screenshot (and its file on disk).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id (the id returned by redteam_shot_list)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: 'List collected credentials (including plaintext secret_value) for credential reuse and lateral movement.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: 'Record a successfully obtained access session (the starting point for lateral movement). method examples: vnc/rdp/ssh/web-shell/webshell/db; privilege examples: admin/user/system.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: 'How access was obtained' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: 'Session/evidence reference, for example runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: 'List obtained access sessions.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: 'Restore a role system prompt to the built-in default (the new template). Use it when an older target should pick up the latest role prompts; omit role to reset all four roles.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* Role whitelist **derived from ROLE_ORDER**;
          hardcoding 4 values once dropped assess, while the preset requires the main session to
          fetch the triage prompt here; the enum then rejected it. Derivation cannot miss a role again. */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell and internal tunnels: reuse during the op, never forget an entry ---------- */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '[Read before and after every decision] One-screen overview of every reusable entry point available right now: live WebShells, usable intranet tunnels (with listen addresses and reachable segments), credentials, access sessions, plus online/offline counts. Check here before attacking the intranet: do not rebuild what exists, and do not forget existing tunnels.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: 'Khi tunnel status=active có thể đưa thẳng cho scanner dùng: -socks5 <listen> hoặc --proxy socks5://<listen>; khi webshell status=online thì kết nối bằng client tương ứng.'
          + ' Lưu ý legit=false (entry_kind=self-only, chỉ trên VPS/máy chủ tự dựng của mình) **không tính là vượt ranh giới mục tiêu, không tính là đột phá**; legit=null nghĩa là chưa khai báo entry_kind, hãy dùng redteam_tunnel_update bổ sung đầu phía mục tiêu.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: 'Register a live WebShell. **You must upload an encrypted Behinder (behinder) or Godzilla (godzilla) shell** — the user connects directly with the matching client, and one-liner/self-written/MemShell shells cannot be used by it, so they do not count as a deliverable entry point. shell_type accepts only godzilla | behinder; if another form truly is the only option, use other and explain why in note. Registering the same url+pass_key again merges and refreshes the record. Once registered, every role agent can reuse it — do not plant it twice.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'Full WebShell URL' },
      shell_type: { type: 'string', description: 'godzilla (Godzilla) | behinder (Behinder); use antsword/other only for other forms, and explain why' },
      pass_key: { type: 'string', description: 'Connection password / key (Behinder shells use pass, Godzilla shells use key)' },
      privilege: { type: 'string', description: 'Current privilege, for example www-data / root / iis' },
      secret_ref: { type: 'string', description: 'Credential/evidence reference, for example runs/ws-10.0.0.5.txt (do not write plaintext passwords into the library)' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: 'List registered WebShells (with online status and last check time).',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: 'Update WebShell status (deleted/offline/privilege change) or add a note.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell record id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: 'Register an intranet tunnel. **Before entering the intranet you must first use the suo5-tunnel skill to build socks5 over WebShell/HTTP (kind=suo5)**; without a tunnel, do not hand-roll intranet probing scripts. listen carries the locally usable address (e.g. 127.0.0.1:1080), reach carries the segments it can reach. After registering, scanners can use -socks5 <listen> directly.\n\n**Red line: your own VPS / a server you configured yourself does not count as a tunnel.** A socks5, frp server or proxy opened only on your own server, never touching the target, **does not count as crossing the target boundary, nor as a boundary or intranet break** (record these with entry_kind=self-only, and they are marked "not a break"). **You must state the target-side end**:\n- target-outbound — the target connects out to us (**your own server receives the target\'s reverse shell**; frp/Stowaway client running on the target);\n- target-http — through the target\'s WebShell/HTTP channel (suo5, Neo-ReGeorg, reGeorg);\n- target-agent — forwarded through a process/session already controlled on the target (SSH -R initiated by the target, etc.).',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5 (preferred, over WebShell/HTTP) | socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: 'Local listen address host:port' },
      entry: { type: 'string', description: 'Entry point: WebShell URL / jump host / command' },
      reach: { type: 'string', description: 'Reachable segment, for example 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '[Important] What the target-side end of the channel is: target-outbound (the target reverses a shell to us / runs an frp client on the target) | target-http (over the target WebShell\'s suo5/Neo-ReGeorg) | target-agent (forwarded through a process already controlled on the target) | self-only (only on your own VPS/self-hosted server, **not a break**)' },
      webshell_id: { type: 'number', description: 'Which WebShell established it' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: 'Setup command, for easy rebuild' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: 'List registered intranet tunnels (with status, listen address, reachable segments, entry_kind and the legit verdict). **legit=false means the channel is opened only on your own VPS/self-hosted server: it does not cross the target boundary and is not a break**; legit=null means entry_kind was not declared.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: 'Update tunnel status (closed/dead/listen address change) or supply the entry_kind verdict. Once a tunnel is no longer needed, always mark it down and say so, to avoid later misuse. **For old records that never declared the entry side (legit=null, shown as "unconfirmed" in the UI), fill in the target-side end with entry_kind** — only then do they count as break evidence.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: 'Entry point: WebShell URL / jump host / command' },
      entry_kind: { type: 'string', description: 'Declare the target-side end: target-outbound | target-http | target-agent | self-only (only on your own server, not a break)' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: 'Live-test connectivity of every WebShell and tunnel (the host side really opens HTTP / TCP connections) and write the online/offline status back to the database. Run it before starting work and again after long tasks.',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Single probe timeout, defaults to 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell trực tuyến ${online}/${result.webshells.length}, tunnel dùng được ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: 'Export the attack graph: asset topology + vulnerability nodes + owned assets (meta.owned). Used for lateral movement path planning and result reporting. When there are too many nodes, narrow the range with cidr.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: 'Defaults to 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Đồ thị có quá nhiều node (' + graph.nodes.length + ' > ' + maxNodes + '), hãy chỉ định cidr để thu hẹp phạm vi',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== domain / web assets */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: 'List web assets (with directly reachable URL and page title). Check here before web penetration work and start from the APIs.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: 'Aggregate assets by domain: which IPs/assets each domain is associated with. Used to map the relationship between main domains, subdomains and C segments.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== scoring targets */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: 'View the score target panel: every score point (name/category/points/captured or not/hit evidence) and overall progress. **Look here before planning each next step** and decide what to attack first by point value.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* Grouped by the merged 8 categories: what is untouched, and how much of each cap is spent */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* Tier notes for the merged version (multi-tier rows need points to pick the tier score) */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* Rows that scored nothing due to scope / cap (a stop signal, do not farm one row) */
          capped: p.capped,
          /* Each field has its own job: service_summary explains the whole "hits but no score" story;
             capped_reason is for **per-hit** specifics in hits[]. Never pass the summary off as that. */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + ': ' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: 'Record one score. The scoring rules were rebuilt per the Break-and-Intrusion Scoring Rules (merged edition) into **25 items** (I. Obtaining access, 21 items + II. Breaking the network boundary, 4 items, in 8 categories), '
      + 'plus 8 general rules G1-G8 that cut across all items. **Before scoring, first read the actual code and that item\'s cap/criteria with `redteam_score_list`**; do not write from memory.\n\n'
      + '**Evidence states results only**: target asset + what was obtained (account/password/access/data volume); do not write how it was obtained or the path — the attack-chain steps cover the process.'
      + 'Attach vuln_id when it can point at "which vulnerability it came from"; the report then appends that vulnerability\'s original request.\n\n'
      + '**Tiered items use `points` to select the tier**: the merged edition folds several tiers of the same item into one (e.g. "server host access" normal 10 / administrator 50, '
      + '\'domain control access\' tier 1 50 / tier 2 20, "network device access" normal 100 / administrator 200). When scoring, set `points` to the value of the tier actually reached;'
      + 'omitting it uses that item\'s main-tier default. **A single system counts only once at its highest privilege** (G1) — if a normal tier was recorded first and later escalated to administrator,'
      + 'record another administrator-tier hit (points set to the high-tier value) and the system automatically supersedes the normal-tier one.\n\n'
      + '**Red line 1: account-type scores require a live login test first.** After obtaining an account/password, use a browser (browser-automation / kimi-webbridge) or an equivalent session'
      + 'to actually log in successfully and interact with pages before recording account-access points — **credentials alone do not count as an account**; anything that cannot log in goes into the `test` argument of redteam_asset_test.\n\n'
      + '**Red line 2: accounts you registered yourself do not count as scored access.** Self-service signup, users/roles/backend accounts you created yourself, and permissions you granted yourself do not count —'
      + 'exercise scoring is about **obtaining accounts and access that already belong to others**. Record these with self_created=true (process only): no points, no count, not in the report.\n\n'
      + '**Red line 3: mind each item\'s counting rule (G1/G3).** Every score point carries its own rule:'
      + '`one system counts only once at its highest privilege` / `one service counts only its highest item` / `the whole target counts once` (boundary break) / `counted per host/card/instance` (terminals, cloud nodes, compute cards).'
      + 'Each item also has its own **cap** (e.g. server host 600 points, web application 2000 points, centralized system 4000 points); past the cap the same item stops accumulating (G3) —'
      + 'the response tells you "cap reached / superseded" via warning; treat it as a **stop signal**, move on to another item or another asset, and do not farm the same item.\n\n'
      + '**Data results are scored separately (G2)**: mail data, business data, data assets and so on are recorded separately by importance and never mixed with access points;'
      + 'evidence must state the **actual data volume** (e.g. "exported 1,320,000 user records").',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: 'Score point code (or any one of point_id / point_name); verify the actual code with redteam_score_list first' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '[Required for tiered items] Which tier this hit scores (e.g. server host access: normal 10, administrator 50; domain control: tier 1 50, tier 2 20). Omit to use that item\'s main-tier default.' },
      target: { type: 'string', description: 'Target asset: URL / ip:port / hostname (**include the port**; service/system criteria are judged from it)' },
      asset_id: { type: 'number', description: 'Id of the target asset in the library' },
      port: { type: 'number', description: '[Recommended] Which port this score lands on (criteria are judged by "asset + port"; omit when target already carries the port)' },
      vuln_id: { type: 'number', description: '[Recommended] Which vulnerability earned the points (the report attaches the original request from it)' },
      step_id: { type: 'number', description: 'Corresponding attack-chain step id (optional)' },
      evidence: { type: 'string', required: true, description: '[Required] Result: what was obtained, e.g. "backend administrator tomcat/Tomcat@2024 (browser login verified)" / "database account root/xxx" / "exported 1.32 million user records". For tiered items, state the tier (such as "administrator access").' },
      self_created: { type: 'boolean', description: '[Important] Is this account/access **self-registered or self-created**? If so pass true — it is process only, not scored and not in the report. Do not set it for accounts/access obtained from others (defaults to false).' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: 'Add or modify a score point (points/name/category/description/enabled). Users also edit these in the UI; agents use it only when necessary (for example when the rules contain a score item that is not recorded yet). With id it modifies, without id it adds.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: 'Existing score point id (pass when modifying)' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: 'Short code (recommended on add, makes scoring easier to record)' },
      category: { type: 'string', description: 'Category, such as account access / server access / database / network break / data / core target' },
      points: { type: 'number', description: 'Points' },
      description: { type: 'string', description: 'Scoring-condition description' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: 'Run an "exploitability assessment" on an asset: which results are expected (account access/RCE/server access/database access/sensitive data/boundary break), how high the priority is, and the reasoning. Call it once per asset when recon wraps up, so the commander can rank by cost-effectiveness.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high easily yields results / medium average / low hard or low value' },
      potential: { type: 'string', description: 'Expected results, such as "account access + RCE" / "database access" / "large volume of sensitive information"' },
      reason: { type: 'string', description: 'Reasoning: fingerprint version matches an Nday, unauthenticated API, weak password, exposed database, strong or weak WAF, etc.' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== evidence / attack chain / report */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: 'Save an HTTP evidence entry: the raw request and response. Reports render it as a raw message you can paste into Burp Suite / Yakit, so request must be a complete, replayable raw request (request line, Host and other headers, and body when needed).',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: 'Linked vulnerability id (recommended)' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: 'Purpose of this evidence, for example "IDOR read of the user list"' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: 'Response status code' },
      request: { type: 'string', required: true, description: 'Full raw request text (pasteable into Burp)' },
      response: { type: 'string', description: 'Full response or key excerpt' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: 'Collecting role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: 'Record one attack-chain step. **"How did this step come about" in the report depends entirely on this record**: how the account and password were obtained, how the Behinder shell was uploaded, how the tunnel was built — write all of it here with `tool` (the actual command text) + `detail` (why it was done, where the lead came from) + `result` (the actual output/result). The attack-chain page and reports display steps ordered by seq.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: 'Action type (compatibility field): recon information gathering | vuln vulnerability discovery | exploit exploitation | access obtaining access | pivot intranet break | data sensitive data | other. **Stage attribution uses stage_code**; this field is a fallback for old data only.' },
      title: { type: 'string', required: true, description: 'One sentence on what this step did, for example "uploaded a Behinder shell through the backend template upload point" / "built a socks5 tunnel with suo5"' },
      detail: { type: 'string', description: 'Why it was done and where the lead came from, for example "login page leaks version Coremail XT 5.0 -> matches CVE-2023-xxxx -> backend template management allows upload"' },
      tool: { type: 'string', description: '[Key for report reproduction] **The actual command text executed**, for example `nuclei -t CVE-2021-xxxx.yaml -u http://x`, `suo5-linux-amd64 -t http://x/shell.jsp -l 1080`, `sqlmap -u "http://x?id=1" --dump`. Without it this step cannot be reproduced from the report.' },
      result: { type: 'string', description: '[Key for report reproduction] Summary of the actual result/output, for example `uid=0(root) gid=0(root)`, "returned 200 with 12,000 user records", "backend administrator tomcat logged in successfully"' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: 'Evidence file/session reference, for example runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '[Fill when this step scored] Score point code (such as rce / webshell / boundary); the server records one score automatically and links the step and the score to each other. **evidence is required or nothing is scored** (the step is still stored).' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: 'Operation stage this belongs to (only these 5 legal values): recon(information gathering) | internet(internet asset access) | boundary(boundary break - build tunnel) | internal(intranet asset access) | target(target system access). Other values (such as external/foothold/tunnel/privilege, common with external tools) are ignored and fall back to stage, so the step lands in no stage.' },
      evidence: { type: 'string', description: 'Used with point_code: what this score obtained (target asset + account/access/data volume) — **no value means no score**.' },
      self_created: { type: 'boolean', description: 'Used with point_code: is the account/access from this step **self-registered/self-created**? If so true (process only, not scored)' },
      target: { type: 'string', description: 'Used with point_code: target asset' },
      seq: { type: 'number', description: 'Omit to append to the end of the chain automatically' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* After persisting a step: did you record the tool/result the report needs, and log its score */
      const hints = []
      if (!args.tool) hints.push('Bước này chưa ghi `tool` (lệnh thực tế): mục "đã làm thế nào" trong báo cáo sẽ bị trống, nên bổ sung một bước ghi lệnh vào.')
      if (!args.result) hints.push('Bước này chưa ghi `result` (kết quả/output thực tế): khi tái hiện báo cáo sẽ thiếu bằng chứng "đã thông hay chưa".')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: 'Read the full attack chain (in step order), for reporting and for checking whether the chain closes (entry -> access -> intranet break).',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: 'Save an **actually working** attack file (script/POC/EXP/wordlist) into the target folder for reuse and delivery. Layout: attack-files/<IP|URL host|C segment>/<file name>. evidence is required and must state the verified effect (for example "output uid=0", "unauthenticated request returns 200 with data") — **do not put in scripts that never worked or were only tried**.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: 'Target: IP, URL or C segment (several ports on the same IP go into that IP\'s folder)' },
      name: { type: 'string', required: true, description: 'File name, for example cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: 'Type: poc verification / exp exploitation / script / wordlist' },
      description: { type: 'string', description: 'What this file does (one sentence)' },
      evidence: { type: 'string', required: true, description: 'Effectiveness evidence: the output/result/impact actually achieved, or the matching vulnerability/evidence id' },
      content: { type: 'string', description: 'File content (either this or path)' },
      path: { type: 'string', description: 'Path of an existing file (relative to the target directory or absolute); it is copied into the target folder (either this or content)' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: 'List saved attack files (grouped by target folder). Check here before attacking a target, to avoid rebuilding what exists.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: 'Only look at one target' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '[Deprecated, use redteam_score_report] View result reports per target (one per IP / URL / C segment): result vulnerabilities (with raw requests pasteable into Burp/Yakit), obtained access, credentials, attack files, attack chain. Used for per-target reporting or for checking what a target still misses.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: 'Only look at one target\'s report' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: 'Attack chain: the five stages chained by attack-surface position — (1) information gathering (internet side) -> (2) internet asset access -> (3) boundary break (build tunnel) -> (4) intranet asset access -> (5) target access. Returns each stage\'s goal, **how many points were actually earned and the running total**, the assets involved, and the real tunnels of the boundary-break stage. Read it when starting work to know "which stage we are in and which stage to attack next", and report conclusions stage by stage.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* Rows that scored nothing under per-service capping: account and DB access */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + ': ' + (x.items || []).join(', ')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(nội bộ)' : '(bên ngoài)') + ' đóng góp ' + a.points + ' điểm'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] tới được ' + (t.reach || '—')),
        })),
        hint: 'Giai đoạn tính điểm được suy ra tự động (core-system→mục tiêu, boundary→vượt ranh giới, còn lại theo tài sản thuộc mạng trong hay ngoài); khi ghi bước của chuỗi tấn công phải kèm stage_code (chỉ nhận recon/internet/boundary/internal/target) thì số bước mới rơi vào đúng giai đoạn, ghi giá trị khác sẽ bị bỏ qua. Quyền tài khoản và quyền cơ sở dữ liệu bị chặn trần theo "cùng tài sản cùng cổng": một dịch vụ đạt quyền cao nhất là tính đủ, cùng dịch vụ trúng lặp lại sẽ bị đánh dấu capped=true và không tính điểm.',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: 'Attack score-chain reproduction report: includes only results that "earned points" (vulnerabilities without points are excluded), and each item carries, where possible, a raw request pasteable into Yakit Repeater for reproduction. Use this instead of redteam_report when a deliverable report is needed.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: 'Maximum number of items, defaults to 500' },
      markdown: { type: 'boolean', description: 'true=return the full markdown (default true); false=return item summaries only' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '[Deprecated, use redteam_score_report] Generate a result report (Markdown): includes only **verified/exploited result vulnerabilities of medium severity or above** (each with a raw request pasteable into Burp/Yakit), the attack chain, obtained access and credentials, and remediation advice. The recon asset inventory, unverified/false-positive items, and low/info-severity findings never appear in the report. To get a finding into the report: first set it to confirmed (verification passed) or exploited (exploitation succeeded) with redteam_vuln_update, then add the raw request with redteam_http_evidence_add.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* ── knowledge base (POC/EXP): globally shared, reused across targets ───────────────────────
     Why a separate group: general POC/EXP is a one-time investment reused long-term. Check here
     before chasing Nday/1day to skip "search the internet + hand-write + debug"; verified POC/EXP
     must be written back so later targets and agents can use it directly. */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '[First step before attacking an Nday/1day] Check the two "ready-made" layers first: (1) **the knowledge base** (general POC/EXP accumulated locally, shared across targets, sorted by "verified -> reuse count") and (2) **the local nuclei template library** (tens of thousands of templates, hit directly by CVE/component name). Use a hit: fetch the full text from the knowledge base with redteam_poc_get, or run templates directly with `nuclei -t <relative path>`. **Do not search the internet again or hand-roll a duplicate**. If neither layer has it, then search the internet or write it yourself, and once verified working backfill the knowledge base with redteam_poc_add.',
    parameters: {
      q: { type: 'string', description: 'Keyword: component + version, vulnerability name, path fragment, or a characteristic string from the body all work' },
      cve: { type: 'string', description: 'CVE / CNVD id, for example CVE-2023-21839' },
      component: { type: 'string', description: 'Component/product name, for example Weblogic, Shiro, Weaver OA, Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: 'Filter by **category** (multiple allowed, comma separated): rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: 'Filter by **source target** (target id or name keyword): only experience "verified against one organization"' },
      asset_target: { type: 'string', description: 'Filter by **discovered asset** (IP / domain / URL fragment)' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web (from the internet) | self (hand-written) | manual (by hand) | nuclei-template' },
      verified: { type: 'boolean', description: 'true shows only live-verified items (prefer these)' },
      templateLimit: { type: 'number', description: 'Maximum local nuclei templates to return, defaults to 20' },
      limit: { type: 'number', description: 'Knowledge base entry cap, defaults to 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() both scan the template dir: **compute once per call**.
         This snippet previously ran templateStats() three times (a 13k-template dir walked each time). */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      /* Template freshness: let the model know how stale its local library is */
      let tplFresh = null
      try { tplFresh = templatesStatus(store.root) } catch { tplFresh = null }
      /* Advisory layer: is this CVE exploited in the wild. Only ids in the search terms, no full compare. */
      let kev = null
      let kevHits = []
      try {
        kev = kevStatus(store.root)
        const cvePool = [q, args.cve, args.component].concat((tpl.items || []).map((t) => (t.path || '') + ' ' + (t.name || '')))
          .concat(items.map((x) => (x.cve || '') + ' ' + (x.title || '')))
        kevHits = lookupKev(store.root, cvePool)
      } catch { kev = null; kevHits = [] }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* Category overview: how much of each weapon class is stockpiled, and what is missing */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + ' (đã xác minh ' + c.verified + ')'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          refreshed_at: tplFresh ? tplFresh.refreshed_at : null,
          age_hours: tplFresh ? tplFresh.age_hours : null,
          stale: tplFresh ? tplFresh.stale : false,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: (hit
          ? 'Đã trúng cái có sẵn: mục trong kho tri thức thì dùng redteam_poc_get lấy toàn văn; template nuclei thì dùng thẳng `nuclei -t <đường dẫn tương đối của template>`. Dùng xong nhớ redteam_poc_use ghi một lần tái sử dụng.'
          : 'Cả kho tri thức lẫn kho template trên máy đều không có: hãy tìm trên internet (web_search / GitHub / ExploitDB / thông báo của hãng) hoặc tự viết, xác minh hiệu lực xong nhất định phải redteam_poc_add ghi lại vào kho tri thức (kèm category + engagement + asset_target + verified_note).')
          + (tplFresh && tplFresh.stale
            ? (tplFresh.age_hours === null
              ? ' 【Kho template trên máy chưa có ghi nhận làm mới (cài xong chưa cập nhật lần nào), hãy redteam_template_refresh trước rồi hãy quyết định】'
              : ' 【Kho template trên máy đã quá hạn dùng tốt (' + tplFresh.age_hours + ' giờ), hãy redteam_template_refresh trước rồi hãy quyết định】')
            : '')
          + (kevHits.length > 0
            ? ' 【Trúng KEV: ' + kevHits.map((k) => k.cve + ' ' + k.product).join(', ') + ' đã bị khai thác ngoài thực tế, đẩy ưu tiên lên mức cao nhất】'
            : ''),
        kev: {
          available: kev ? kev.available === true : false,
          fetched_at: kev ? kev.fetched_at ?? null : null,
          age_hours: kev ? kev.age_hours ?? null : null,
          stale: kev ? kev.stale === true : false,
          note: kev ? kev.note : 'Lớp thông báo không khả dụng',
        },
        kev_hits: kevHits,
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* Provenance: which experience, which target, which asset, and when it was created */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: 'Fetch the **full content** of one knowledge base POC/EXP (body + usage + verification record + output path) to use as-is or adapt into a target-specific script. Without id you may use code (the code field in redteam_poc_search results).',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry id' },
      code: { type: 'string', description: 'Stable identifier of the knowledge base entry (the code in search results)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: 'Kho tri thức không có mục này (hãy dùng redteam_poc_search để tìm trước)' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: 'Store a **general, reusable** POC/EXP in the knowledge base (shared across targets). Anything obtained from the internet, written yourself, or already validated and working goes here — include only what really works, and state the source and verification evidence. Rule of thumb: if it **still works on a different target**, it goes into the knowledge base; scripts that only work for this one target go through redteam_attack_file_add (attack files page). The same name (same code) merges and refreshes, which can be used to update a version.\n\n**Backfill trio (without them the panel has no category and cannot trace the source)**: (1) `category` classification; (2) `engagement` + `asset_target` — which target and which asset this knowledge was discovered and verified on; (3) `verified` + `verified_note` verification evidence.',
    parameters: {
      title: { type: 'string', required: true, description: 'Title: component + vulnerability name/id, for example "Weblogic T3 deserialization CVE-2023-21839"' },
      kind: { type: 'string', description: 'poc (verification) | exp (exploitation) | script | template | payload' },
      category: { type: 'string', description: '[Category, recommended and effectively required] rce remote command execution | deserialization | file-upload file upload getshell | sqli SQL injection | unauthorized unauthenticated access | auth-bypass authentication bypass/IDOR | weak-password | ssrf | xxe | path-traversal directory traversal/arbitrary file read | info-leak information disclosure | privesc privilege escalation/lateral | tunnel tunnel/proxy | other' },
      cve: { type: 'string', description: 'CVE / CNVD id' },
      component: { type: 'string', description: 'Component/product name (for retrieval by component)' },
      versions: { type: 'string', description: 'Affected version range' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web (scraped from the internet) | self (hand-written) | manual (by hand) | nuclei-template' },
      source_url: { type: 'string', description: 'Source link (required for internet sources, for review)' },
      description: { type: 'string', description: 'What this POC does, the key principle, and preconditions' },
      usage: { type: 'string', description: 'Usage: a complete command line example + the parameters that need replacing' },
      content: { type: 'string', description: 'Body: script/POC source, raw request packet, nuclei template, invocation steps' },
      path: { type: 'string', description: 'You may also give a path to an existing local file (relative to pocs/ or absolute) and the knowledge base reads the body from it' },
      filename: { type: 'string', description: 'File name to save the body under; defaults by language (poc.py / poc.sh / poc.yaml...)' },
      verified: { type: 'boolean', description: 'Whether it is live-verified (**set true only when verified against a real target**)' },
      verified_note: { type: 'string', description: 'Verification evidence: which target, what output/result, whether authentication is required' },
      engagement: { type: 'string', description: '[Source target] Which target this knowledge was discovered/verified on (target id or organization name)' },
      asset_target: { type: 'string', description: '[Discovered asset] Which asset/target it was actually verified on, for example 10.1.2.3:8080 or http://oa.demo.com' },
      found_by_agent: { type: 'string', description: 'Role code that discovered it (recon / assess / vuln-scan / exploit / internal)' },
      tags: { type: 'string', description: 'Comma-separated tags, for example "java,deserialization,rce"' },
      created_by: { type: 'string', description: 'Which role/agent accumulated it' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      /* Here engagement means "source target", not "target to act on", so resolveEngagement must not
         be used; only name completion runs, keeping id and Chinese label for panel grouping. */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: 'Đã vào kho tri thức (phân loại: ' + (r.poc.category || 'other') + ', thời điểm tạo: ' + r.poc.created_at + '), '
          + 'agent của bất kỳ mục tiêu nào về sau dùng redteam_poc_search đều trúng trực tiếp; kho tri thức hiện có ' + stats.total + ' mục.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: 'List the POC/EXP in the knowledge base (filterable by kind/source/component/verified; no conditions means all). Used to inventory "which ready-made weapons we already hold", avoiding duplicate collection.',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: 'Update a knowledge base entry: add the verification conclusion (verified + verified_note), fix the affected version, add usage or body, change tags. **After verifying on a real target, always come back and set verified to true with clear evidence** — later agents prefer verified items.',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry id' },
      code: { type: 'string', description: 'Or specify the entry by code' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: 'Convenience form: pass verified directly' },
      verified_note: { type: 'string', description: 'Convenience form: pass verification evidence directly' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: 'Record one reuse of a knowledge base POC/EXP (which target/asset it was used on). Entries with a high reuse count sort first, so later agents pick battle-tested weapons first.',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: 'Where it was used: target name / target IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== scope / bulk / tunnel / P1 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_scope_check',
    description: 'Check whether an IP/URL/domain is inside the current target\'s authorized scope (scope comes from redteam_engagement_open). Returns unresolved when the domain cannot be resolved; returns unscoped when the scope is empty (not blocking, but prompts the user to supply a range).',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: 'The IP / URL / domain to check' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const check = scopeCheck(store, id, args.target)
      const ok = check.status === 'in' || check.status === 'unscoped' || check.status === 'unresolved'
      return JSON.stringify({ ok, engagement: id, target: args.target, ...check }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_batch',
    description: 'Bulk insert to cut per-item calls: kind=assets bulk assets (max 500, reusing asset_add\'s fields and dedup); kind=assess bulk assessment (max 200); kind=vulns bulk vulnerabilities (max 200; with request/response the HTTP evidence is stored automatically). Items outside scope are skipped and explained in rejected.',
    parameters: {
      engagement: { type: 'string' },
      kind: { type: 'string', required: true, enum: ['assets', 'assess', 'vulns'] },
      items: {
        type: 'array', required: true,
        description: 'assets: [{ip, provenance, tool, state, primary_name, names, ports, discovered_at}]；assess: [{asset_id|ip, priority, potential, reason}]；vulns: [{title, severity, asset_id, cve, target, evidence, status, gained, request, response, method}]',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const kind = String(args.kind || '')
      const items = Array.isArray(args.items) ? args.items : []
      const limit = kind === 'assets' ? 500 : 200
      if (items.length === 0 || items.length > limit) throw new Error('redteam_batch: số lượng items phải trong khoảng 1..' + limit)
      const rejected = []
      const results = []
      if (kind === 'assets') {
        const accepted = []
        for (const it of items) {
          if (!it || typeof it.ip !== 'string' || it.ip.trim() === '') { rejected.push({ item: it, reason: 'ip required' }); continue }
          const check = scopeCheck(store, id, it.ip)
          if (check.status === 'out') { rejected.push({ ip: it.ip, reason: 'out_of_scope', scope: check.scope }); continue }
          accepted.push(it)
        }
        const out = accepted.length > 0
          ? store.importBundle(id, { scan: { tool: 'redteam_batch', argv: ['assets'] }, assets: accepted })
          : { counts: { assets: 0 } }
        return JSON.stringify({ ok: true, engagement: id, kind, accepted: accepted.length, rejected: rejected.length, counts: out.counts, rejected }, null, 2)
      }
      if (kind === 'assess') {
        for (const it of items) {
          try { results.push(store.assessAsset(id, it || {})) }
          catch (error) { rejected.push({ item: it, reason: error && error.message ? error.message : String(error) }) }
        }
        return JSON.stringify({ ok: true, engagement: id, kind, assessed: results.length, rejected: rejected.length, results, rejected }, null, 2)
      }
      if (kind === 'vulns') {
        for (const it of items) {
          const check = scopeCheck(store, id, it && it.target)
          if (check.status === 'out') { rejected.push({ target: it && it.target, reason: 'out_of_scope', scope: check.scope }); continue }
          try {
            const v = store.addVuln(id, { ...it, engagement: undefined, agent: agentOf(args), found_by_agent: it.found_by_agent || it.agent || 'vuln-scan' })
            let httpEvidenceId = null
            const request = typeof it.request === 'string' ? it.request.trim() : ''
            if (request !== '') {
              try {
                const ev = store.addHttpEvidence(id, { vuln_id: v.id, asset_id: it.asset_id, label: it.title, method: it.method || 'GET', url: it.target, request, response: it.response, captured_by: agentOf(args) })
                httpEvidenceId = ev.id
              } catch { /* The vuln is already persisted; an evidence failure does not block it */ }
            }
            results.push({ id: v.id, updated: v.updated === true, http_evidence_id: httpEvidenceId })
          } catch (error) { rejected.push({ item: it, reason: error && error.message ? error.message : String(error) }) }
        }
        return JSON.stringify({ ok: true, engagement: id, kind, inserted: results.length, rejected: rejected.length, results, rejected }, null, 2)
      }
      throw new Error('redteam_batch.kind chỉ nhận assets / assess / vulns')
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_pivot_probe',
    description: 'Live-test several intranet targets (host:port) through a local SOCKS5 tunnel and return a reachability matrix. Used to tell whether "the tunnel process is alive" really reaches the intranet.',
    parameters: {
      engagement: { type: 'string' },
      listen: { type: 'string', required: true, description: 'Tunnel\'s local SOCKS5 listener, such as 127.0.0.1:1080' },
      targets: { type: 'array', required: true, items: { type: 'string' }, description: 'List of intranet target host:port, max 50' },
      timeoutMs: { type: 'number', description: 'Per-target timeout, defaults to 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const targets = (Array.isArray(args.targets) ? args.targets : []).filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 50)
      if (targets.length === 0) throw new Error('redteam_pivot_probe.targets required')
      const probes = []
      for (const target of targets) probes.push(await socks5Probe(args.listen, target, args.timeoutMs))
      return JSON.stringify({ ok: true, engagement: id, listen: args.listen, reachable: probes.filter((x) => x.ok).length, total: probes.length, probes }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_data_proof',
    description: 'Structured proof of P1 sensitive data: op=add records fields/row count/samples/source (row_count>=10000 marks meets_threshold); op=list queries. More checkable than free-text evidence; reports and reviews use it.',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['add', 'list'], required: true },
      target: { type: 'string', description: 'Target where the data resides (IP/URL/system name)' },
      source: { type: 'string', description: 'api / db / file / backup' },
      interface: { type: 'string', description: 'API path / database table / file path' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Leaked fields, for example full name / national ID number / phone number' },
      row_count: { type: 'number', description: 'Actual row count (P1 threshold 10000)' },
      sample: { type: 'string', description: 'Redacted samples (1-3 rows)' },
      query: { type: 'string', description: 'Reproducible query/request' },
      evidence_ref: { type: 'string', description: 'Evidence file path' },
      pii_type: { type: 'string', description: 'pii / three-factor ID / other' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      note: { type: 'string' },
      limit: { type: 'number', description: 'Rows returned by op=list, defaults to 100' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, ...store.listDataProofs(id, args) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, proof: store.addDataProof(id, { ...args, created_by: agentOf(args) }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_cleanup',
    description: 'Cleanup ledger: op=add records uploaded shells/temporary accounts/tunnels/files/scheduled tasks; op=list lists un-cleaned items; op=update marks done. Use it before delivery to confirm no leftover entry points.',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['add', 'list', 'update'], required: true },
      id: { type: 'number', description: 'Ledger id for op=update' },
      kind: { type: 'string', description: 'webshell / account / tunnel / file / task / other' },
      target: { type: 'string' },
      location: { type: 'string', description: 'URL / path / host:port' },
      detail: { type: 'string' },
      status: { type: 'string', enum: ['open', 'done', 'kept'], description: 'Defaults to open' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, ...store.listCleanup(id, args) }, null, 2)
      if (args.op === 'update') return JSON.stringify({ ok: true, engagement: id, item: store.updateCleanup(id, args) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, item: store.addCleanup(id, { ...args, created_by: agentOf(args) }) }, null, 2)
    },
  })))

  /* ================================================================== asset discovery timeline */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: 'Asset "discovery time" view: aggregates by day "how many assets were collected on which day" (internal/external separated), and lists recently discovered assets. Used to answer "when was this asset discovered", to check for gaps in collection, and to verify this round\'s collection when wrapping up.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: 'Number of recent assets, defaults to 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: 'Thời điểm phát hiện = lúc tài sản này **lần đầu vào kho này**; thu thập lặp lại chỉ làm mới last_seen.'
          + ' Phụ lục báo cáo và trang đo đạc tài sản đều sắp xếp theo nó.',
      }, null, 2)
    },
  })))
}
