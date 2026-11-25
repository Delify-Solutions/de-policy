/**
 * Red team platform adaptation config (inside the plugin, no .ps1)
 *
 * On disk: `$DSH_HOME/redteam/config.json`
 * Purpose:
 *   - on Windows / non-Kali machines the user fills in absolute tool paths or
 *     search directories;
 *   - preflight / skill availability / nuclei template directory all go through here;
 *   - nothing is ever written into the official `$DSH_HOME/skills`.
 *
 * Borrowed from Z3r0: system config is centralized and editable in the UI
 * (FOFA / path settings) instead of relying on shell bootstrapping.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'

/** Config file path. */
export function configPathOf(root) {
  return join(root || redteamRoot(), 'config.json')
}

export function redteamRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/** Default toolkit directory. */
export function defaultToolkitDir(root) {
  return join(root || redteamRoot(), 'toolkit')
}

/**
 * Built-in tool catalog: id -> possible executable names (including Windows .exe).
 * The user can override with an absolute path in config.tools[id], or drop whole
 * tool directories into binDirs.
 */
export const TOOL_CATALOG = [
  { id: 'nmap', label: 'Nmap', names: ['nmap.exe', 'nmap'] },
  { id: 'nuclei', label: 'Nuclei', names: ['nuclei.exe', 'nuclei'] },
  { id: 'masscan', label: 'Masscan', names: ['masscan.exe', 'masscan'] },
  { id: 'fscan', label: 'fscan', names: ['fscan.exe', 'fscan'] },
  { id: 'gogo', label: 'gogo', names: ['gogo.exe', 'gogo'] },
  { id: 'suo5', label: 'suo5', names: ['suo5.exe', 'suo5-windows-amd64.exe', 'suo5-linux-amd64', 'suo5'] },
  { id: 'frpc', label: 'frp client', names: ['frpc.exe', 'frpc'] },
  { id: 'frps', label: 'frp server', names: ['frps.exe', 'frps'] },
  { id: 'chisel', label: 'chisel', names: ['chisel.exe', 'chisel'] },
  { id: 'ffuf', label: 'ffuf', names: ['ffuf.exe', 'ffuf'] },
  /* names are candidate filenames, not absolute paths of one machine. adapt holds
     common distro aliases; use them only when found in the directory. */
  { id: 'httpx', label: 'httpx', names: ['httpx-toolkit', 'pd-httpx', 'httpx.exe', 'httpx'], rejectPython: true, adapt: [/^httpx-toolkit$/, /^pd-httpx$/, /^httpx$/] },
  { id: 'dnsx', label: 'dnsx', names: ['dnsx.exe', 'dnsx'] },
  { id: 'subfinder', label: 'subfinder', names: ['subfinder.exe', 'subfinder'] },
  { id: 'ksubdomain', label: 'ksubdomain', names: ['ksubdomain.exe', 'ksubdomain'] },
  { id: 'impacket', label: 'impacket (directory or entry)', names: ['impacket-secretsdump', 'impacket-secretsdump.exe', 'secretsdump.py', 'impacket'], adapt: [/^impacket-secretsdump$/, /^secretsdump\.py$/] },
]

const EMPTY = () => ({
  version: 1,
  /* auto | windows | linux -- auto follows Node process.platform */
  platform: 'auto',
  toolkitDir: '',
  nucleiTemplatesDir: '',
  /* Extra search directories: the user's own Kali toolkit / portable tool folder */
  binDirs: [],
  /* id -> absolute path; an empty string means unspecified */
  tools: Object.fromEntries(TOOL_CATALOG.map((t) => [t.id, ''])),
  env: {
    FOFA_KEY: '',
    REDTEAM_VPS_HOST: '',
    REDTEAM_VPS_KEY: '',
  },
  notes: '',
  /* Allow normal conversation after the user confirms "not configuring tools now" */
  envAdaptSkip: false,
  /* Template freshness: last successful refresh time / template count / commit
     (machines without git only have the first two). Used for hints and throttling
     only, never for any decision -- unreadable means 0 and work goes on. */
  templatesRefreshedAt: 0,
  templatesCommit: '',
  templatesCount: 0,
  templatesLastError: '',
  /* The user has saved / assigned a folder once in environment adaptation */
  envAdaptConfigured: false,
  updated_at: null,
})

function isWinLike(cfg) {
  const p = (cfg && cfg.platform) || 'auto'
  if (p === 'windows') return true
  if (p === 'linux') return false
  return osPlatform() === 'win32'
}

export function loadPlatformConfig(root) {
  const base = EMPTY()
  const file = configPathOf(root)
  if (!existsSync(file)) return Object.assign({}, base, { path: file, exists: false })
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const tools = Object.assign({}, base.tools, raw.tools && typeof raw.tools === 'object' ? raw.tools : {})
    const env = Object.assign({}, base.env, raw.env && typeof raw.env === 'object' ? raw.env : {})
    const binDirs = Array.isArray(raw.binDirs)
      ? raw.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    return {
      version: Number(raw.version) || 1,
      platform: ['auto', 'windows', 'linux'].includes(raw.platform) ? raw.platform : 'auto',
      toolkitDir: typeof raw.toolkitDir === 'string' ? raw.toolkitDir.trim() : '',
      nucleiTemplatesDir: typeof raw.nucleiTemplatesDir === 'string' ? raw.nucleiTemplatesDir.trim() : '',
      binDirs,
      tools,
      env,
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      templatesRefreshedAt: Number(raw.templatesRefreshedAt) || 0,
      templatesCommit: typeof raw.templatesCommit === 'string' ? raw.templatesCommit : '',
      templatesCount: Number(raw.templatesCount) || 0,
      templatesLastError: typeof raw.templatesLastError === 'string' ? raw.templatesLastError : '',
      envAdaptSkip: !!raw.envAdaptSkip,
      envAdaptConfigured: !!raw.envAdaptConfigured,
      updated_at: raw.updated_at || null,
      path: file,
      exists: true,
    }
  } catch (error) {
    return Object.assign({}, base, {
      path: file,
      exists: true,
      error: error && error.message ? error.message : String(error),
    })
  }
}

export function savePlatformConfig(patch, root) {
  const dir = root || redteamRoot()
  mkdirSync(dir, { recursive: true })
  const prev = loadPlatformConfig(dir)
  const next = {
    version: 1,
    platform: ['auto', 'windows', 'linux'].includes(patch.platform) ? patch.platform : (prev.platform || 'auto'),
    toolkitDir: typeof patch.toolkitDir === 'string' ? patch.toolkitDir.trim() : (prev.toolkitDir || ''),
    nucleiTemplatesDir: typeof patch.nucleiTemplatesDir === 'string'
      ? patch.nucleiTemplatesDir.trim()
      : (prev.nucleiTemplatesDir || ''),
    binDirs: Array.isArray(patch.binDirs)
      ? patch.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : (prev.binDirs || []),
    tools: Object.assign({}, prev.tools || {}, patch.tools && typeof patch.tools === 'object' ? patch.tools : {}),
    env: Object.assign({}, prev.env || {}, patch.env && typeof patch.env === 'object' ? patch.env : {}),
    notes: typeof patch.notes === 'string' ? patch.notes : (prev.notes || ''),
    templatesRefreshedAt: patch.templatesRefreshedAt !== undefined
      ? (Number(patch.templatesRefreshedAt) || 0)
      : (Number(prev.templatesRefreshedAt) || 0),
    templatesCommit: typeof patch.templatesCommit === 'string'
      ? patch.templatesCommit
      : (prev.templatesCommit || ''),
    templatesCount: patch.templatesCount !== undefined
      ? (Number(patch.templatesCount) || 0)
      : (Number(prev.templatesCount) || 0),
    templatesLastError: typeof patch.templatesLastError === 'string'
      ? patch.templatesLastError
      : (prev.templatesLastError || ''),
    envAdaptSkip: patch.envAdaptSkip !== undefined ? !!patch.envAdaptSkip : !!prev.envAdaptSkip,
    envAdaptConfigured: patch.envAdaptConfigured !== undefined
      ? !!patch.envAdaptConfigured
      : !!prev.envAdaptConfigured,
    updated_at: new Date().toISOString(),
  }
  /* Keep the full catalog of tool keys even when empty, so the panel can edit them */
  for (const t of TOOL_CATALOG) {
    if (next.tools[t.id] === undefined || next.tools[t.id] === null) next.tools[t.id] = ''
    else next.tools[t.id] = String(next.tools[t.id]).trim()
  }
  const file = configPathOf(dir)
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return loadPlatformConfig(dir)
}

/** Effective toolkit root. */
export function toolkitDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.toolkitDir) return resolve(c.toolkitDir)
  return defaultToolkitDir(root)
}

/** Effective nuclei templates directory (may be null). */
export function nucleiTemplatesDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.nucleiTemplatesDir && existsSync(c.nucleiTemplatesDir)) return resolve(c.nucleiTemplatesDir)
  return null
}

/**
 * Find an executable name in a directory (one shallow level + the common bin/ subdirectory).
 */
function looksLikePythonCli(file) {
  let fd
  try {
    const buf = Buffer.alloc(96)
    fd = openSync(file, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    return head.startsWith('#!') && /python/i.test(head)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function findInDir(dir, names, options = {}) {
  if (!dir || !existsSync(dir)) return null
  const tryOne = (base) => {
    for (const name of names) {
      const p = join(base, name)
      if (existsSync(p)) {
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          if (options.rejectPython && looksLikePythonCli(p)) continue
          return p
        } catch { /* continue */ }
      }
    }
    return null
  }
  const hit = tryOne(dir) || adaptInDir(dir, options)
  if (hit) return hit
  for (const sub of ['bin', 'Bins', 'tools', 'Tools']) {
    const nested = tryOne(join(dir, sub)) || adaptInDir(join(dir, sub), options)
    if (nested) return nested
  }
  return null
}

/** When the exact filename is absent, match distro aliases in this directory level. */
function adaptInDir(dir, options) {
  const patterns = options.adapt
  if (!dir || !Array.isArray(patterns) || patterns.length === 0 || !existsSync(dir)) return null
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const pattern of patterns) {
    for (const name of names) {
      if (!pattern.test(String(name).toLowerCase())) continue
      const file = join(dir, name)
      try {
        if (!statSync(file).isFile()) continue
        if (options.rejectPython && looksLikePythonCli(file)) continue
        return file
      } catch { /* continue */ }
    }
  }
  return null
}

/** which over PATH (synchronous, no shell spawn). */
function findOnPath(names, env = process.env, options = {}) {
  const pathVar = env.PATH || env.Path || ''
  const parts = pathVar.split(delimiter).filter(Boolean)
  for (const part of parts) {
    const hit = findInDir(part, names, options)
    if (hit) return hit
  }
  return null
}

/** dsh's PATH is often shorter than a login shell's. On Linux add distro and user dirs. */
function linuxFallbackDirs(env = process.env) {
  const home = env.HOME || homedir()
  const dirs = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/bin', '/snap/bin']
  if (home) {
    dirs.push(
      join(home, 'go', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.pdtm', 'go', 'bin'),
    )
  }
  return dirs
}

/**
 * Resolve a single tool: user path -> toolkit -> binDirs -> PATH.
 * @returns `{ id, label, path, source: 'config'|'toolkit'|'binDir'|'path'|'missing', names }`
 */
export function resolveTool(id, options = {}) {
  const root = options.root || redteamRoot()
  const cfg = options.config || loadPlatformConfig(root)
  const env = options.env || process.env
  const def = TOOL_CATALOG.find((t) => t.id === id)
  if (!def) {
    return { id, label: id, path: null, source: 'missing', names: [] }
  }
  const configured = cfg.tools && typeof cfg.tools[id] === 'string' ? cfg.tools[id].trim() : ''
  if (configured) {
    const abs = isAbsolute(configured) ? configured : resolve(configured)
    if (existsSync(abs)) {
      return { id, label: def.label, path: abs, source: 'config', names: def.names }
    }
    return { id, label: def.label, path: null, source: 'missing', names: def.names, configured: abs, note: 'Đường dẫn trong config không tồn tại: ' + abs }
  }
  const findOpts = { rejectPython: !!def.rejectPython, adapt: def.adapt }
  const toolkit = toolkitDirOf(cfg, root)
  const fromToolkit = findInDir(toolkit, def.names, findOpts)
  if (fromToolkit) return { id, label: def.label, path: fromToolkit, source: 'toolkit', names: def.names }

  for (const dir of cfg.binDirs || []) {
    const hit = findInDir(dir, def.names, findOpts)
    if (hit) return { id, label: def.label, path: hit, source: 'binDir', names: def.names, binDir: dir }
  }

  const fromPath = findOnPath(def.names, env, findOpts)
  if (fromPath) return { id, label: def.label, path: fromPath, source: 'path', names: def.names }

  if (!isWinLike(cfg)) {
    for (const dir of linuxFallbackDirs(env)) {
      const hit = findInDir(dir, def.names, findOpts)
      if (hit) return { id, label: def.label, path: hit, source: 'path', names: def.names }
    }
  }

  return { id, label: def.label, path: null, source: 'missing', names: def.names }
}

export function resolveAllTools(options = {}) {
  return TOOL_CATALOG.map((t) => resolveTool(t.id, options))
}

/**
 * Merge the configured env into effectiveEnv (values already present in the
 * process / .env win and are not overwritten).
 */
export function mergeConfigEnv(effectiveEnv, cfg) {
  const out = Object.assign({}, effectiveEnv || {})
  const env = (cfg && cfg.env) || {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    const val = v.trim()
    if (val === '') continue
    if (out[k] === undefined || out[k] === '') out[k] = val
  }
  return out
}

/**
 * Platform summary: consumed by the panel and preflight.
 */
export function platformSummary(root) {
  const cfg = loadPlatformConfig(root)
  const win = isWinLike(cfg)
  const tools = resolveAllTools({ root, config: cfg })
  const found = tools.filter((t) => t.path)
  const missing = tools.filter((t) => !t.path)
  const toolkit = toolkitDirOf(cfg, root)
  const nuclei = nucleiTemplatesDirOf(cfg, root)
    || (existsSync(join(toolkit, 'nuclei-templates')) ? join(toolkit, 'nuclei-templates') : null)
  const adapt = envAdaptStatus(root)
  return {
    ok: true,
    config: cfg,
    runtime: {
      nodePlatform: osPlatform(),
      effective: win ? 'windows' : 'linux',
      windows: win,
      sep,
    },
    toolkitDir: toolkit,
    toolkitExists: existsSync(toolkit),
    nucleiTemplatesDir: nuclei,
    tools: {
      total: tools.length,
      found: found.length,
      missing: missing.length,
      items: tools,
    },
    adapt,
    hint: adapt.kali
      ? 'Đã phát hiện Kali. Gói hệ thống được nhận theo tên tệp của bản phân phối: impacket-secretsdump, httpx-toolkit (không coi /usr/bin/httpx của Python là scanner). fscan, gogo, suo5, frp, chisel, dnsx, subfinder, ksubdomain không phải lệnh có sẵn của Kali, nếu không đặt vào /usr/bin hoặc ~/go/bin sẽ hiện là không tìm thấy.'
      : (win
        ? 'Hiện thích ứng theo Windows. Đường dẫn công cụ đã có vẫn dùng tiếp, cái nào không có thì bỏ qua, không chặn hội thoại. Có thể bổ sung đường dẫn hoặc chọn cả thư mục gói ngay trên trang này.'
        : 'Hiện thích ứng theo Linux. Công cụ đã có vẫn dùng tiếp, cái nào không có thì bỏ qua. Cũng có thể tự điền hoặc gán cả thư mục ngay trên trang này.'),
    egress: {
      http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
      https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      all_proxy: process.env.ALL_PROXY || process.env.all_proxy || '',
      no_proxy: process.env.NO_PROXY || process.env.no_proxy || '',
      note: 'Chỉ đọc môi trường tiến trình; đổi proxy của hệ thống/terminal thì phải khởi động lại host. Cần proxy ở mức lệnh thì dùng kỹ năng cn-proxy-pool, không đổi cấu hình mạng của máy này.',
    },
  }
}

/** Detect whether this machine is Kali / a related training distro. */
export function detectKali() {
  if (osPlatform() !== 'linux') {
    return { kali: false, source: null, detail: 'Host không phải Linux' }
  }
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    if (/ID\s*=\s*"?kali"?/i.test(text) || /ID_LIKE\s*=[^\n]*kali/i.test(text) || /NAME\s*=\s*".*Kali/i.test(text)) {
      return { kali: true, source: 'os-release', detail: 'os-release ghi rõ Kali' }
    }
  } catch { /* ignore */ }
  const markers = [
    '/usr/share/kali-menu',
    '/etc/apt/sources.list.d/kali.list',
    '/usr/share/kali-defaults',
  ]
  for (const p of markers) {
    if (existsSync(p)) return { kali: true, source: 'paths', detail: p }
  }
  return { kali: false, source: null, detail: null }
}

const NAME_TO_IDS = (() => {
  const map = new Map()
  for (const t of TOOL_CATALOG) {
    for (const name of t.names) {
      const key = String(name).toLowerCase()
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(t.id)
    }
  }
  return map
})()

/**
 * Recursively scan a folder for tool names (depth-limited), returning id -> absolute path.
 */
export function scanFolderForTools(dir, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 6)
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 8000, 100), 20000)
  const root = resolve(String(dir || '').trim())
  const assigned = {}
  const hits = []
  if (!root || !existsSync(root)) {
    return { ok: false, error: 'Thư mục không tồn tại: ' + root, assigned, hits }
  }
  let st
  try { st = statSync(root) } catch {
    return { ok: false, error: 'Không đọc được thư mục: ' + root, assigned, hits }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'Không phải thư mục: ' + root, assigned, hits }
  }

  let scanned = 0
  const ranks = {}
  const walk = (base, depth) => {
    if (scanned >= maxFiles || depth > maxDepth) return
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= maxFiles) break
      const name = ent.name
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') || name === 'node_modules' || name === '.git') continue
      const full = join(base, name)
      let isDir = false
      let isFile = false
      try {
        if (typeof ent.isDirectory === 'function') {
          isDir = ent.isDirectory()
          isFile = ent.isFile()
        } else {
          const s = statSync(full)
          isDir = s.isDirectory()
          isFile = s.isFile()
        }
      } catch { continue }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!isFile) continue
      scanned += 1
      const key = name.toLowerCase()
      const ids = NAME_TO_IDS.get(key)
      if (!ids) continue
      for (const id of ids) {
        const def = TOOL_CATALOG.find((t) => t.id === id)
        if (def && def.rejectPython && looksLikePythonCli(full)) continue
        const rank = def ? def.names.findIndex((n) => n.toLowerCase() === key) : 99
        const prevRank = ranks[id] === undefined ? 99 : ranks[id]
        if (assigned[id] && rank >= prevRank) continue
        ranks[id] = rank < 0 ? 99 : rank
        assigned[id] = full
        hits.push({ id, path: full, name })
      }
    }
  }
  walk(root, 0)

  /* Pick up a nuclei-templates directory along the way */
  let nucleiTemplatesDir = ''
  const tryNuclei = [
    join(root, 'nuclei-templates'),
    join(root, 'nuclei', 'templates'),
  ]
  for (const p of tryNuclei) {
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory()) { nucleiTemplatesDir = p; break }
      } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    dir: root,
    scanned,
    assigned,
    hits,
    nucleiTemplatesDir,
    assignedCount: Object.keys(assigned).length,
  }
}

/**
 * Write a whole tool folder into config: toolkitDir + the matched tool paths.
 */
export function assignToolkitFolder(dir, root) {
  const scan = scanFolderForTools(dir)
  if (!scan.ok) return Object.assign({ ok: false }, scan)
  const prev = loadPlatformConfig(root)
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(scan.assigned)) {
    tools[id] = path
  }
  const binDirs = Array.isArray(prev.binDirs) ? prev.binDirs.slice() : []
  if (!binDirs.includes(scan.dir)) binDirs.unshift(scan.dir)
  const patch = {
    toolkitDir: scan.dir,
    binDirs,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: false,
  }
  if (scan.nucleiTemplatesDir) patch.nucleiTemplatesDir = scan.nucleiTemplatesDir
  const cfg = savePlatformConfig(patch, root)
  const summary = platformSummary(root)
  return {
    ok: true,
    assigned: scan.assigned,
    assignedCount: scan.assignedCount,
    hits: scan.hits,
    scanned: scan.scanned,
    dir: scan.dir,
    nucleiTemplatesDir: scan.nucleiTemplatesDir || null,
    config: cfg,
    tools: summary.tools,
    adapt: summary.adapt,
  }
}

/**
 * Environment gate state before a red team send.
 * Kali -> ready immediately; otherwise tools must be configured/assigned, or the
 * user must confirm a skip.
 */
export function envAdaptStatus(root) {
  const cfg = loadPlatformConfig(root)
  const kaliInfo = detectKali()
  const tools = resolveAllTools({ root, config: cfg })
  const foundItems = tools.filter((t) => t.path)
  const missingItems = tools.filter((t) => !t.path)
  const found = foundItems.length
  const skipped = !!cfg.envAdaptSkip
  /* Only recorded paths count as configured. A lone envAdaptConfigured may come
     from an empty automatic initialization. */
  const savedPaths = !!(cfg.toolkitDir && String(cfg.toolkitDir).trim())
    || (cfg.binDirs && cfg.binDirs.length > 0)
    || TOOL_CATALOG.some((t) => cfg.tools && cfg.tools[t.id] && String(cfg.tools[t.id]).trim())

  let reason = 'need-config'
  let ready = false
  let message = ''

  if (kaliInfo.kali) {
    ready = true
    reason = 'kali'
    message = 'Đã phát hiện Kali, mặc định dùng thẳng công cụ của máy này (PATH / tìm kiếm mặc định).'
  } else if (skipped) {
    ready = true
    reason = 'skipped'
    message = 'Công cụ máy này không có đã được bỏ qua, vẫn hội thoại bình thường. Đường dẫn đã có vẫn dùng tiếp.'
  } else if (savedPaths) {
    ready = true
    reason = 'configured'
    message = 'Đường dẫn công cụ đã lưu vẫn còn. Hiện tìm thấy ' + found + '/' + tools.length + ' cái; cái nào không có đã bỏ qua.'
  } else if (found >= 1) {
    ready = true
    reason = 'tools-found'
    message = 'Máy này đã tìm thấy ' + found + ' công cụ; số còn lại không có đã bỏ qua.'
  } else {
    ready = true
    reason = 'skipped-missing'
    message = 'Máy này không có công cụ quét, đã bỏ qua cổng kiểm tra môi trường. Khi có công cụ sẽ dùng tiếp, kỹ năng nào thiếu công cụ thì không khả dụng.'
  }

  return {
    ok: true,
    ready,
    reason,
    message,
    kali: !!kaliInfo.kali,
    kaliSource: kaliInfo.source,
    kaliDetail: kaliInfo.detail,
    skipped,
    configured: savedPaths,
    found,
    missing: missingItems.length,
    total: tools.length,
    foundIds: foundItems.map((t) => t.id),
    missingIds: missingItems.map((t) => t.id),
  }
}

export function markEnvAdaptSkip(root, skip = true) {
  savePlatformConfig({ envAdaptSkip: !!skip }, root)
  return envAdaptStatus(root)
}

export default {
  TOOL_CATALOG,
  configPathOf,
  redteamRoot,
  loadPlatformConfig,
  savePlatformConfig,
  resolveTool,
  resolveAllTools,
  platformSummary,
  mergeConfigEnv,
  toolkitDirOf,
  nucleiTemplatesDirOf,
  detectKali,
  scanFolderForTools,
  assignToolkitFolder,
  envAdaptStatus,
  markEnvAdaptSkip,
}
