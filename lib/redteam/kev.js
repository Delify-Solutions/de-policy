/**
 * Advisory layer: local cache of CISA KEV (known exploited vulnerabilities).
 *
 * Why just this layer:
 *   - the template layer (nuclei-templates) is refreshed to learn "which checks exist";
 *   - the knowledge base (poc table) is locally verified "experience" and does not
 *     carry "latest";
 *   - the advisory layer answers a different question: **is anyone actually
 *     exploiting this CVE right now**.
 *
 * The source is static JSON, unauthenticated, ~16k entries; one fetch to disk is
 * enough. Failures are always silent (return unavailable) and never block any
 * tool -- offline machines keep working.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'

const KEV_URLS = [
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json?download=1',
]

/** Cache age that counts as expired (hours). 0 or REDTEAM_KEV=0 disables the layer. */
const KEV_TTL_HOURS = 24

function kevEnabled(env = process.env) {
  return String(env.REDTEAM_KEV ?? '') !== '0'
}

function kevPath(root) {
  return join(root, 'kb', 'cve-kev.json')
}

/** In-process cache: { root -> { mtimeMs, data } }, so lookups do not parse 16k JSON entries each time. */
const memo = new Map()

function normalizeCve(text) {
  const m = String(text ?? '').match(/CVE-\d{4}-\d{4,7}/i)
  return m ? m[0].toUpperCase() : ''
}

function fetchJson(url, timeoutMs, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('redirect')); return }
    const lib = url.startsWith('http:') ? http : https
    const req = lib.get(url, { headers: { 'User-Agent': 'de-policy-redteam' } }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        resolve(fetchJson(new URL(res.headers.location, url).href, timeoutMs, hops + 1))
        return
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return }
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        /* A single file should not exceed 64MB: an abnormal size means an error
           page or a mirror index, so give up */
        if (bytes > 64 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

/** Collapse the raw CISA JSON into a minimal structure (raw fields are long; no need to keep them all). */
function slim(body) {
  const list = Array.isArray(body?.vulnerabilities) ? body.vulnerabilities : []
  const items = []
  for (const row of list) {
    const cve = normalizeCve(row?.cveID)
    if (!cve) continue
    items.push({
      cve,
      vendor: String(row.vendorProject ?? ''),
      product: String(row.product ?? ''),
      name: String(row.vulnerabilityName ?? ''),
      added: String(row.dateAdded ?? ''),
      ransomware: String(row.knownRansomwareCampaignUse ?? '') === 'Known',
    })
  }
  return { fetched_at: Date.now(), count: items.length, items }
}

/**
 * Read the cache. Returns `{ available, fetched_at, age_hours, stale, count, note }`;
 * matched lookups build their index separately via `lookupKev()`.
 */
export function kevStatus(root) {
  if (!kevEnabled()) return { available: false, enabled: false, note: 'Lớp công bố KEV đã tắt (REDTEAM_KEV=0)' }
  const path = kevPath(root)
  if (!existsSync(path)) return { available: false, enabled: true, count: 0, note: 'Chưa có dữ liệu công bố (chạy một lần redteam_template_refresh action=refresh hoặc chờ tự động làm mới)' }
  try {
    const stat = statSync(path)
    const cached = memo.get(root)
    const data = cached && cached.mtimeMs === stat.mtimeMs ? cached.data : JSON.parse(readFileSync(path, 'utf8'))
    if (!cached || cached.mtimeMs !== stat.mtimeMs) memo.set(root, { mtimeMs: stat.mtimeMs, data })
    const ageHours = Math.max(0, (Date.now() - Number(data.fetched_at || 0)) / 3600000)
    return {
      available: true,
      enabled: true,
      count: Number(data.count || (data.items || []).length),
      fetched_at: Number(data.fetched_at || 0),
      age_hours: Math.round(ageHours * 10) / 10,
      stale: ageHours > KEV_TTL_HOURS,
      note: ageHours > KEV_TTL_HOURS ? 'Dữ liệu công bố đã hết hạn, kết quả trùng khớp chỉ để tham khảo' : undefined,
    }
  } catch (error) {
    return { available: false, enabled: true, count: 0, note: 'Không đọc được dữ liệu công bố: ' + String(error?.message ?? error) }
  }
}

/**
 * Look up "is this known to be exploited in the wild" by CVE id.
 *
 * @param root - red team data root ($DSH_HOME/redteam)
 * @param cves - any array of strings; CVE ids are filtered out internally
 * @returns hit list; empty array when there is no data or the switch is off
 *   (callers need not distinguish the two)
 */
export function lookupKev(root, cves) {
  if (!kevEnabled() || !root) return []
  const wanted = new Set()
  for (const raw of Array.isArray(cves) ? cves : [cves]) {
    for (const hit of String(raw ?? '').match(/CVE-\d{4}-\d{4,7}/gi) || []) wanted.add(hit.toUpperCase())
  }
  if (wanted.size === 0) return []
  const path = kevPath(root)
  if (!existsSync(path)) return []
  try {
    const stat = statSync(path)
    const cached = memo.get(root)
    const data = cached && cached.mtimeMs === stat.mtimeMs ? cached.data : JSON.parse(readFileSync(path, 'utf8'))
    if (!cached || cached.mtimeMs !== stat.mtimeMs) memo.set(root, { mtimeMs: stat.mtimeMs, data })
    return (data.items || []).filter((item) => wanted.has(item.cve)).slice(0, 50)
  } catch { return [] }
}

/**
 * Fetch by age (default 24h). `force` ignores freshness.
 * Returns `{ action: 'refreshed'|'skipped'|'failed', reason?, count? }` and **never throws**.
 */
export async function refreshKevIfStale(options = {}) {
  if (!kevEnabled()) return { action: 'skipped', reason: 'disabled' }
  const root = options.root
  if (!root) return { action: 'skipped', reason: 'no-root' }
  if (options.force !== true) {
    const status = kevStatus(root)
    if (status.available && status.stale !== true) {
      return { action: 'skipped', reason: 'fresh', age_hours: status.age_hours }
    }
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000
  let lastError = ''
  for (const url of KEV_URLS) {
    try {
      const body = await fetchJson(url, timeoutMs)
      const payload = slim(body)
      if (payload.count === 0) throw new Error('Phản hồi không có mục lỗ hổng nào')
      mkdirSync(join(root, 'kb'), { recursive: true })
      writeFileSync(kevPath(root), JSON.stringify(payload), 'utf8')
      memo.delete(root)
      return { action: 'refreshed', count: payload.count }
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }
  return { action: 'failed', error: lastError || 'Kéo dữ liệu công bố thất bại' }
}

/** For tests: clear the in-process cache (no need to wait for an mtime change after swapping files). */
export function resetKevMemo() {
  memo.clear()
}
