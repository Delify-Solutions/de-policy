/**
 * Cloud sync of intel data: pull a `cve.db.gz` from a configured address and
 * replace the local `kb/cve.db` with it.
 *
 * Why a separate layer:
 *   - Code and data are different things. Code ships with the package, data must
 *     be updatable separately (47k EXP + 400k CVE entries cannot mean re-releasing
 *     a 55MB package for every plugin change).
 *   - **Data no longer ships with the package** (same as upstream): build it
 *     yourself, or point at a mirror you host.
 *
 * Protocol (minimal, self-hostable):
 *   GET  <base>/intel/manifest.json   -> `{ version, built_at, sha256, size, sources }`
 *   GET  <base>/intel/cve.db.gz       -> the compressed database itself
 * **No default base**: this repo does not carry that data, and "default to some
 * GitHub repo" would simply 404 forever. To use it, set `REDTEAM_INTEL_BASE`
 * (a mirror / self-hosted / your own static server).
 *
 * Three hard rules:
 *   1. **No swap without validation**: sha256 mismatch, incomplete download,
 *      failed extraction -- keep the old database in every case;
 *   2. **Atomic replace**: write `.tmp` in the same directory first, rename over
 *      the target only after validation passes;
 *   3. **Silent throughout**: no network / no base / no cloud data is only a
 *      "skip" and never makes a tool fail.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { cveDbStatus, resetCveDbCache, validateCveDbFile, withCveDbWrite } from './cve-db.js'

/** No default source: the repo does not carry this data; a hardcoded address only 404s.
 *  To use it, set `REDTEAM_INTEL_BASE` (without a trailing slash). */
const DEFAULT_BASE = ''

/** Single-download cap: the compressed DB is ~53MB now; 400MB leaves headroom
 *  (a full uncompressed copy in the cloud still fits). */
const MAX_BYTES = 400 * 1024 * 1024

/** Sync throttle: at most one automatic manifest check per machine per day. 0 = disable auto check. */
const AUTO_CHECK_HOURS = 24

export function intelBaseUrl(env = process.env) {
  const raw = String(env.REDTEAM_INTEL_BASE || '').trim()
  return (raw || DEFAULT_BASE).replace(/\/+$/, '')
}

/** No configured source means disabled -- otherwise every startup logs a line
 *  for an address bound to 404. */
export function intelSyncEnabled(env = process.env) {
  if (String(env.REDTEAM_INTEL_SYNC ?? '') === '0') return false
  return String(env.REDTEAM_INTEL_BASE || '').trim() !== ''
}

/** Locally recorded sync state (under kb/, not in the database -- it must not be swapped with the DB). */
function statePath(root) { return join(root, 'kb', 'intel-sync.json') }
function dbPath(root) { return join(root, 'kb', 'cve.db') }

function readState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')) } catch { return {} }
}

function writeState(root, patch) {
  try {
    mkdirSync(join(root, 'kb'), { recursive: true })
    writeFileSync(statePath(root), JSON.stringify({ ...readState(root), ...patch }, null, 2))
  } catch { /* a failed write does not affect the data itself */ }
}

/** GET a URL -> Buffer (follows redirects, with timeout and size cap). */
function fetchBuffer(url, timeoutMs, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) { reject(new Error('redirect')); return }
    const lib = url.startsWith('http:') ? http : https
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'de-policy-redteam',
        /* raw.githubusercontent degrades requests without Accept; ask for binary explicitly */
        Accept: 'application/octet-stream, application/json, */*',
      },
    }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        resolve(fetchBuffer(new URL(res.headers.location, url).href, timeoutMs, hops + 1))
        return
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return }
      const chunks = []
      let bytes = 0
      res.on('data', (c) => {
        bytes += c.length
        if (bytes > MAX_BYTES) { req.destroy(); reject(new Error('too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

async function fetchJson(url, timeoutMs) {
  const buf = await fetchBuffer(url, timeoutMs)
  return JSON.parse(buf.toString('utf8'))
}

/**
 * Remote manifest. Returns `{ ok:false }` when unavailable -- callers skip on that, no error.
 * @returns `{ ok, version, built_at, sha256, size, sources, url, error? }`
 */
export async function fetchIntelManifest(options = {}) {
  const base = options.base || intelBaseUrl()
  /* No configured source: treat as unavailable instead of requesting a relative
     address (which throws a URI parse error). */
  if (!base) return { ok: false, url: '', error: 'no-base', note: 'Chưa cấu hình nguồn dữ liệu (REDTEAM_INTEL_BASE)' }
  const url = base + '/intel/manifest.json'
  try {
    const raw = await fetchJson(url, options.timeoutMs || 20000)
    const sha = String(raw?.sha256 || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, url, error: 'invalid-manifest-sha256' }
    const size = Number(raw?.size)
    if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, url, error: 'invalid-manifest-size' }
    const file = String(raw?.file || 'cve.db.gz')
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return { ok: false, url, error: 'invalid-manifest-file' }
    return {
      ok: true,
      url,
      version: Number(raw?.version) || 0,
      built_at: Number(raw?.built_at) || 0,
      sha256: sha,
      size,
      file,
      sources: raw?.sources ?? null,
    }
  } catch (error) {
    return { ok: false, url, error: String(error?.message ?? error) }
  }
}

/** Local database "identity": version + build time, compared against the remote manifest. */
export function localIntelInfo(root) {
  const st = cveDbStatus(root)
  const state = readState(root)
  return {
    available: st.available === true,
    path: dbPath(root),
    version: Number(st.version) || 0,
    built_at: Number(st.built_at) || 0,
    count: Number(st.count) || 0,
    sha256: String(state.sha256 || ''),
    synced_at: Number(state.synced_at) || 0,
    source: String(state.source || ''),
  }
}

/**
 * Remote vs local: one comparison shared by the panel / preflight / tools.
 * The local side is readable without network; the remote side is filled in by
 * `fetchIntelManifest`.
 */
export function intelCompare(local, remote) {
  if (!remote || remote.ok !== true) {
    return { state: 'unknown', reason: remote?.error || 'Không lấy được manifest trên cloud' }
  }
  if (!local || local.available !== true) {
    return { state: 'remote_newer', reason: 'Máy này chưa có cơ sở dữ liệu khả dụng, cần cài lần đầu' }
  }
  if (remote.sha256 && local.sha256 && remote.sha256 === local.sha256) {
    return { state: 'same', reason: 'Máy này và cloud là cùng một bản (sha256 giống nhau)' }
  }
  if (remote.built_at > 0 && local.built_at > 0) {
    if (remote.built_at > local.built_at) {
      return { state: 'remote_newer', reason: 'Cloud mới hơn (' + ageText(remote.built_at, local.built_at) + ')' }
    }
    if (remote.built_at < local.built_at) {
      return { state: 'local_newer', reason: 'Máy này mới hơn cloud (bản này dựng cục bộ hoặc cloud chưa đồng bộ)' }
    }
    return { state: 'same', reason: 'Thời điểm dựng giống nhau' }
  }
  return { state: 'unknown', reason: 'Thiếu thời điểm dựng, không so sánh được' }
}

function ageText(a, b) {
  const days = Math.abs(a - b) / 86400000
  if (days < 1) return 'chưa tới một ngày'
  if (days < 30) return Math.round(days) + ' ngày'
  return Math.round(days / 30) + ' tháng'
}

/**
 * Sync cloud data to this machine.
 *
 * @param root red team data root
 * @param options `{ force, base, dryRun, timeoutMs }`
 *   - force: ignore the throttle and the "remote is older" check; swap whenever a
 *     download succeeds
 *   - dryRun: compare only, no download and no replace
 * @returns `{ action, reason?, remote?, local?, bytes?, sha256?, error? }`
 *   action: `updated` | `skipped` | `failed`
 */
export async function syncIntel(root, options = {}) {
  if (!root) return { action: 'skipped', reason: 'no-root' }
  /* An explicit base counts as enabled: the caller (tool / test) already named the
     source, so an environment variable is not required. */
  if (!options.base && !intelSyncEnabled() && options.force !== true) return { action: 'skipped', reason: 'disabled' }
  return withCveDbWrite(root, () => syncIntelUnlocked(root, options))
}

async function syncIntelUnlocked(root, options = {}) {
  const remote = await fetchIntelManifest(options)
  const local = localIntelInfo(root)
  const cmp = intelCompare(local, remote)

  if (options.dryRun === true) {
    return { action: 'skipped', reason: 'dry-run', remote, local, compare: cmp }
  }
  if (remote.ok !== true) {
    return { action: 'skipped', reason: 'no-manifest', remote, local, compare: cmp, error: remote.error }
  }
  if (options.force !== true) {
    if (cmp.state === 'same') return { action: 'skipped', reason: 'up-to-date', remote, local, compare: cmp }
    /* Local is newer: do not downgrade by default. Overwriting from the cloud is
       allowed only under force. */
    if (cmp.state === 'local_newer' && options.allowDowngrade !== true) {
      return { action: 'skipped', reason: 'local-newer', remote, local, compare: cmp }
    }
  }

  const base = options.base || intelBaseUrl()
  const url = base + '/intel/' + (remote.file || 'cve.db.gz')
  const dst = dbPath(root)
  const tempToken = `${process.pid}-${randomUUID()}`
  const tmp = `${dst}.sync-${tempToken}.tmp`
  const tmpDb = `${dst}.sync-probe-${tempToken}.db`
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000

  try {
    try { rmSync(tmp, { force: true }); rmSync(tmpDb, { force: true }) } catch { /* temp is disposable */ }
    const buf = await fetchBuffer(url, timeoutMs)
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== remote.sha256) {
      throw new Error('sha256 không khớp (cloud ' + remote.sha256.slice(0, 12) + ', tải về ' + sha.slice(0, 12) + ')')
    }
    if (buf.length !== remote.size) {
      throw new Error('Kích thước không khớp (manifest ' + remote.size + ', tải về ' + buf.length + ')')
    }
    mkdirSync(join(root, 'kb'), { recursive: true })
    /* The download is **gz**, so validate and decompress first -- renaming the gz
       bytes to cve.db directly yields a database that cannot be opened (SQLite only
       recognizes the decompressed header). */
    writeFileSync(tmp, buf)
    const { createReadStream, createWriteStream } = await import('node:fs')
    const { createGunzip } = await import('node:zlib')
    const { pipeline } = await import('node:stream/promises')
    await pipeline(createReadStream(tmp), createGunzip(), createWriteStream(tmpDb))
    const checked = validateCveDbFile(tmpDb)
    if (!checked.ok) throw new Error('Kiểm tra SQLite thất bại: ' + checked.error)
    /* Validate the decompressed DB first, then atomically replace it with rename;
       never rm the old DB first. */
    resetCveDbCache()
    try {
      renameSync(tmpDb, dst)
    } catch (error) {
      return {
        action: 'deferred', reason: 'locked', remote, local, compare: cmp,
        error: String(error?.message ?? error),
        hint: 'Cơ sở dữ liệu trên máy này đang bị tiến trình khác chiếm, hãy khởi động lại rồi đồng bộ tiếp',
      }
    }
    writeState(root, {
      sha256: sha, synced_at: Date.now(), source: url,
      version: remote.version, built_at: remote.built_at,
    })
    resetCveDbCache()
    const after = localIntelInfo(root)
    return { action: 'updated', remote, local: after, compare: cmp, bytes: buf.length, sha256: sha }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return {
      action: 'failed',
      error: String(error?.message ?? error),
      remote, local, compare: cmp,
      note: 'Đồng bộ thất bại, tiếp tục dùng bản trên máy này; không ảnh hưởng truy vấn nào',
    }
  } finally {
    try { rmSync(tmp, { force: true }); rmSync(tmpDb, { force: true }) } catch { /* keep old DB */ }
  }
}

function rotateHours() {
  const raw = Number(process.env.REDTEAM_INTEL_CHECK_HOURS)
  return Number.isFinite(raw) && raw >= 0 ? raw : AUTO_CHECK_HOURS
}

/**
 * Age-based check at startup: compare the manifest only, and actually download
 * only when the cloud is newer. Failures are silent (returns skipped) and never
 * block work.
 */
export async function syncIntelIfStale(options = {}) {
  /* Same as syncIntel: an explicit base means enabled. */
  if (!options.base && !intelSyncEnabled()) return { action: 'skipped', reason: 'disabled' }
  const root = options.root
  if (!root) return { action: 'skipped', reason: 'no-root' }
  const hours = rotateHours()
  if (hours === 0 && options.force !== true) return { action: 'skipped', reason: 'auto-off' }
  if (options.force !== true) {
    const state = readState(root)
    const last = Number(state.checked_at) || 0
    if (last > 0 && Date.now() - last < hours * 3600000) {
      return { action: 'skipped', reason: 'fresh', age_hours: Math.round(((Date.now() - last) / 3600000) * 10) / 10 }
    }
  }
  writeState(root, { checked_at: Date.now() })
  /* Compare the manifest first: download only on a difference, so no wasted 53MB
     pull every 24 hours */
  const remote = await fetchIntelManifest(options)
  const local = localIntelInfo(root)
  const cmp = intelCompare(local, remote)
  if (remote.ok !== true) return { action: 'skipped', reason: 'no-manifest', compare: cmp, error: remote.error }
  if (cmp.state !== 'remote_newer' && options.force !== true) {
    return { action: 'skipped', reason: cmp.state, compare: cmp }
  }
  return syncIntel(root, { ...options, force: options.force === true })
}

/** Status summary: shared by the panel row / preflight / tools. Offline it reports local only. */
export function intelSyncStatus(root) {
  const local = localIntelInfo(root)
  const state = readState(root)
  return {
    enabled: intelSyncEnabled(),
    base: intelBaseUrl(),
    auto_check_hours: rotateHours(),
    last_checked_at: Number(state.checked_at) || 0,
    last_synced_at: Number(state.synced_at) || 0,
    local,
  }
}

