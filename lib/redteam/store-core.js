/**
 * RedTeam asset-store core (no Cordis dependency)
 *
 * Only three jobs: engagement workspace (dirs + metadata), SQLite fact store (schema/write/query),
 * prompt and skill-library file I/O. Cordis plugin shell is ./index.js, CLI shell is ../bin/cli.mjs;
 * both share this module, so the UI, the agent and the CLI see one and the same implementation.
 */
import { DatabaseSync } from 'node:sqlite'
import { connect as tcpConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync,
  copyFileSync,
} from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'

/* ── Extracted modules (public API unchanged: re-exported verbatim below) ─────
   Rationale: "one 5600-line file where a schema change means scrolling past 500 lines of scoring":
   · ip-utils.js    pure helpers: IP / CIDR / slug / timestamps;
   · schema.js      DDL for the two tables plus two incremental migrations;
   · validate.js    pre-write validation and normalisation (path traversal, bad enums);
   · score-rules.js scoring definitions plus default points (the one shared impl). */
import {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
} from './ip-utils.js'
import {
  buildHttpRequest, buildCurlCommand, parseCurl, commandKind, parseTarget, fillTemplate,
} from './report-replay.js'
import {
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
} from './schema.js'
import {
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
} from './validate.js'
import {
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  /* Internal helpers: were module-level functions in core.js, now supplied by score-rules.js */
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
} from './score-rules.js'
import {
  platformSummary, savePlatformConfig, assignToolkitFolder, loadPlatformConfig, nucleiTemplatesDirOf,
} from './platform-config.js'
/* Intel freshness (template-library refresh / KEV advisories): the panel and tools share one
   implementation; here we expose only the op surface. Dynamic import keeps node:sqlite lazy. */
async function intelOps(op, req, root) {
  const boot = await import('./bootstrap-runtime.js')
  const kev = await import('./kev.js')
  const cve = await import('./cve-db.js').catch(() => null)
  const sync = await import('./intel-sync.js').catch(() => null)
  const cveStatus = () => {
    try {
      return cve && typeof cve.cveDbStatus === 'function'
        ? cve.cveDbStatus(root)
        : { available: false, count: 0, note: 'Mô-đun kho lỗ hổng công khai không khả dụng' }
    } catch {
      return { available: false, count: 0, note: 'Trạng thái kho lỗ hổng công khai không khả dụng' }
    }
  }
  const syncStatus = () => {
    try {
      return sync && typeof sync.intelSyncStatus === 'function'
        ? sync.intelSyncStatus(root)
        : { enabled: false, base: '', note: 'Mô-đun đồng bộ tình báo không khả dụng' }
    } catch {
      return { enabled: false, base: '', note: 'Trạng thái đồng bộ tình báo không khả dụng' }
    }
  }
  if (op === 'intelStatus') {
    let templates = null
    let kevInfo = null
    try { templates = boot.templatesStatus(root) } catch { templates = null }
    try { kevInfo = kev.kevStatus(root) } catch { kevInfo = null }
    return { ok: true, templates, kev: kevInfo, cve_db: cveStatus(), intel_sync: syncStatus() }
  }
  if (op === 'intelSync') {
    const status = syncStatus()
    const base = sync && typeof sync.intelBaseUrl === 'function' ? sync.intelBaseUrl() : ''
    if (!base || !sync || typeof sync.syncIntel !== 'function') {
      return { ok: true, result: { action: 'skipped', reason: 'disabled' }, status }
    }
    try {
      /* Manual sync honours only process REDTEAM_INTEL_BASE; bodies cannot inject a source. */
      const result = await sync.syncIntel(root, { force: req.force === true })
      return {
        ok: result.action !== 'failed',
        result,
        status: syncStatus(),
        ...(result.action === 'failed' && result.error ? { error: result.error } : {}),
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error), status }
    }
  }
  if (op === 'cveSearch') {
    const status = cveStatus()
    if (!cve || typeof cve.searchCve !== 'function') return { ok: true, status, items: [] }
    try {
      const items = cve.searchCve(root, {
        q: typeof req.q === 'string' ? req.q : '',
        cve: typeof req.cve === 'string' ? req.cve : undefined,
        vendor: typeof req.vendor === 'string' ? req.vendor : undefined,
        product: typeof req.product === 'string' ? req.product : undefined,
        severity: typeof req.severity === 'string' ? req.severity : undefined,
        minCvss: req.minCvss,
        kevOnly: req.kevOnly === true,
        hasPoc: req.hasPoc === true,
        since: typeof req.since === 'string' ? req.since : undefined,
        limit: Math.min(Number(req.limit) || 30, 200),
      })
      return { ok: true, status, items: Array.isArray(items) ? items : [] }
    } catch {
      return { ok: true, status, items: [] }
    }
  }
  if (op === 'cveLookup') {
    const status = cveStatus()
    if (!cve || typeof cve.lookupCve !== 'function') return { ok: true, status, items: [] }
    try {
      const ids = req.ids ?? req.cve ?? req.id ?? []
      const items = cve.lookupCve(root, ids)
      return { ok: true, status, items: Array.isArray(items) ? items : [] }
    } catch {
      return { ok: true, status, items: [] }
    }
  }
  if (op === 'templateCatalogStatus') {
    const status = cveStatus()
    let catalog = { available: false, count: 0 }
    try {
      if (cve && typeof cve.templateCatalogStatus === 'function') {
        catalog = cve.templateCatalogStatus(root) || catalog
      }
    } catch { /* missing/invalid local DB is a normal empty result */ }
    return { ok: true, cve_db: status, status: catalog }
  }
  if (op === 'intelRefresh') {
    const force = req.force === true
    let templates = null
    let kevOut = null
    try { templates = await boot.refreshTemplateLibrary({ force }) } catch (error) {
      templates = { action: 'failed', error: String(error && error.message ? error.message : error) }
    }
    try { kevOut = await kev.refreshKevIfStale({ root, force }) } catch { kevOut = null }
    return { ok: true, templates, kev: kevOut }
  }
  return null
}

/* Re-exports: core.js's public surface is identical to pre-split (zero caller changes) */
export {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
}

/* ----------------------------------------------------- Roles and enumerations */
/**
 * Operational roles (six). A role code is used for all of the following:
 *   · the role prompt file `engagements/<target>/agents/<code>.md`
 *   · the `agent` column on attack steps / vulns / credentials (reports must say who did it)
 *   · role selection when the main session hands out work
 * `plan` is the main session (command) itself; never dispatched, only used to view/tune the persona.
 */
const ROLE_TITLES = {
  plan: 'Phiên chính (chỉ huy)',
  recon: 'Thu thập thông tin',
  assess: 'Rà soát tài sản',
  'vuln-scan': 'Phát hiện lỗ hổng',
  exploit: 'Khai thác lỗ hổng',
  internal: 'Xâm nhập mạng nội bộ',
}

/** Vulnerability severity (ordered by display priority). */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** Vulnerability handling status. */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES }

/* ------------------------------------------------------------------ schema */


/* ------------------------------------------------ Knowledge base (POC/EXP, global) */


/**
 * Knowledge-base category (aligned with scoring points / attack surface): agents must pick one
 * on write-back so the panel can group, letting users browse one class instead of hundreds flat.
 */
/* ------------------------------------------------------- Knowledge-base constants */

/** POC type: poc=proof-of-concept, exp=executable, template=nuclei-like, script=helper, payload. */
const POC_KINDS = ['poc', 'exp', 'script', 'template', 'payload']
/** Source: web=scraped, self=written by agent, manual=written by human, nuclei-template=template lib. */
const POC_SOURCES = ['web', 'self', 'manual', 'nuclei-template', 'kb']
export { POC_KINDS, POC_SOURCES }




/* ---------------------------------------------------------------- Migrations */

/** Allowed shell types (matches webshell-toolkit delivery: Behinder / Godzilla are "connects"). */

/**
 * Target normalisation: a vuln's target may carry a path/params (http://h:8080/a/b, 10.0.0.5:6379),
 * so the aggregate view must group by site/service, not full URL, or 300 vulns become 300 groups.
 */
export function targetKey(target, fallbackIp) {
  const t = String(target || '').trim()
  if (t !== '') {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
    if (url !== null) return url[1]
    const head = /^([^\s/?#]+)/.exec(t)
    if (head !== null) return head[1]
    return t
  }
  return fallbackIp || '(chưa chỉ định mục tiêu)'
}

/** Parse a JSON column safely (fall back to the default on bad data). */
const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/** Normalise "what this vuln gave us" into one short label: array or separated string -> "A, B". */
function normGained(value) {
  if (value === undefined || value === null) return null
  const parts = Array.isArray(value) ? value : String(value).split(/[,;，；]/)
  const out = parts.map((x) => String(x).trim()).filter(Boolean)
  return out.length > 0 ? out.join(', ') : null
}

/**
 * Internal/external test (SQL fragment, applied to asset.ip):
 * RFC1918 private + loopback + link-local + CGNAT count as internal; everything else external.
 */
/** Template index cache TTL: rebuild once exceeded (also on content-signature change, #nucleiIndex). */
const NUCLEI_INDEX_TTL_MS = 24 * 3600 * 1000
const NUCLEI_INDEX_VERSION = 2
const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`


/* ------------------------------------------------------------------ Metadata */

function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}


/* ----------------------------------------------------------- Default score points */

/* ────────────────────────────────────────────────────────────────────────────
   Default score points — designed strictly against the 25 rules of the intrusion scoring spec.

   Each point carries four judgement fields (panel/report/agent all rely on them, not code lists):
     · rule         rule number (RULE 1…25). **Points sharing a rule share its score cap**;
     · dedup_scope scoring unit: `service` (same asset+port counts once, the highest value; for
                   "one port = one service" items such as network/security appliances, file storage) /
                   `system` (same system counts the highest privilege once) / `target` (once per target) /
                   `none` (every hit counts, e.g. per-host / per-card / per-node items);
     · cap          accumulated score cap for this rule (0 = uncapped); panel/report cap after sum;
     · tier        tier label within a rule (e.g. "admin", "normal", "bonus").

   Scoring essentials (from the spec text, mirrored into each description; agent and user see them):
     · privileges take the max: multiple roles on one system/host/DB score once, at the highest;
     · caps: (1) per **single defending unit and all its sub-units**; (2) per **whole target**;
     · bonuses: big-data / hyperscale system doubles, knowledge base doubles, IoT into core +5000,
       network-device redirection/hijack +200, implanting RAT with successful follow-up +1000;
     · IPv6-related results ×3 (the cap still follows the original system type);
     · per-host/card/node items (endpoints, nodes, compute cards) accumulate; no conflict with max.
   ──────────────────────────────────────────────────────────────────────────── */


/** Legacy (pre-v0.10.0) default point code -> new rule code map, for old-target migration hints. */


/* -------------------------------------------------------------- Default content */

/* ------------------------------------------------------ Attack chain (5 phases) */

/**
 * The five attack-chain phases, chained by "attack-surface position": internet collect →
 * internet foothold → break the boundary → internal foothold → take the target. scoreStageOf() scores.
 *
 * sections = playbook notes (kept for prompts/panel editing; the chain page no longer renders them,
 * so execution detail never buries "where we are, how much we scored"); tools = the usual toolchain.
 */
export const DEFAULT_STAGES = [
  {
    code: 'recon', name: 'Thu thập thông tin', subtitle: 'RECON · phía internet', color: '#06b6d4', scored: 0,
    goal: 'Triển khai thu thập thông tin ở phía internet, xác định bề mặt tài sản đáng đánh',
    sections: [
      { label: 'Trinh sát tài sản', items: ['Tên miền con / dải C / dấu hiệu cổng', 'FOFA, DNS thụ động, minh bạch chứng chỉ, quét chủ động'] },
      { label: 'Xác nhận bề mặt tấn công', items: ['Tiêu đề và dấu hiệu Web, dịch vụ lộ ra và cổng quản trị', 'Quy thuộc, nhận diện WAF / CDN'] },
      { label: 'Xếp hạng bề mặt tấn công', items: ['Xếp theo độ dễ đánh và điểm dự kiến', 'Xác định đánh máy nào trước'] },
    ],
    tools: 'ARL / Lighthouse, fscan, gogo, OneForAll, ENScan, Goby, Nmap, Burp, Nuclei',
    transition: 'Xác nhận bề mặt tấn công internet, chuyển sang khai thác',
  },
  {
    code: 'internet', name: 'Quyền tài sản internet', subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: 'Lấy điểm từ tài khoản, quyền... trên tài sản phía internet',
    sections: [
      { label: 'Lấy tài khoản', items: ['Mật khẩu yếu / vượt quyền / chưa cấp quyền / lỗi logic', 'Quản trị backend, tài khoản thường'] },
      { label: 'Lấy quyền', items: ['Nday / 1day RCE, tải tệp lên, giải tuần tự', 'WebShell, thực thi lệnh, quyền máy chủ'] },
      { label: 'Lấy dữ liệu', items: ['Cơ sở dữ liệu, lộ cấu hình, thông tin nhạy cảm hàng loạt'] },
    ],
    tools: 'sqlmap, Nuclei, Behinder / Godzilla / AntSword, fscan, Burp, POC tự viết',
    transition: 'Dùng máy đã kiểm soát để mở kênh ra internet',
  },
  {
    code: 'boundary', name: 'Đột phá ranh giới', subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: 'Dựng thành công đường hầm, mở rộng năng lực kiểm soát vào mạng nội bộ',
    sections: [
      { label: 'Đường hầm', items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', 'socks5 triển khai, nối nhiều cấp'] },
      { label: 'Kênh ra internet', items: ['Domain fronting, ẩn sau CDN, chuyển tiếp qua cloud function', 'Kênh ẩn DNS / ICMP / 443'] },
    ],
    tools: 'suo5, frp, Stowaway, Neo-reGeorg, GOST, proxychains, chisel',
    transition: 'Đường hầm sẵn sàng, chuyển vào mạng nội bộ',
  },
  {
    code: 'internal', name: 'Quyền tài sản nội bộ', subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: 'Ghi điểm trên tài sản nội bộ qua đường hầm',
    sections: [
      { label: 'Trinh sát mạng nội bộ', items: ['Máy sống / cổng / dịch vụ / thư mục chia sẻ', 'Cơ sở dữ liệu, middleware, hệ thống sao lưu'] },
      { label: 'Di chuyển ngang và nâng quyền', items: ['Tái dùng thông tin xác thực, Pass-the-Hash, vé', 'PsExec / WMIExec / SSH / RDP'] },
      { label: 'Dữ liệu', items: ['Xuất hàng loạt thông tin nhạy cảm, lưu vào runs/ và ghi tham chiếu'] },
    ],
    tools: 'gogo / fscan (qua đường hầm), Impacket, Mimikatz / LaZagne, BloodHound, suo5',
    transition: 'Định vị mục tiêu trọng yếu trong mạng nội bộ',
  },
  {
    code: 'target', name: 'Quyền mục tiêu', subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: 'Giành quyền trên tài sản quan trọng trong mạng nội bộ (mục tiêu)',
    sections: [
      { label: 'Định vị mục tiêu', items: ['Xác nhận phạm vi hệ thống / máy chủ mục tiêu theo quy chế diễn tập', 'Xác định rõ tiêu chí chấm điểm'] },
      { label: 'Chiếm mục tiêu', items: ['root / SYSTEM / quản trị viên / AK cloud', 'Khả năng đọc ghi dữ liệu nghiệp vụ và thay đổi cấu hình'] },
      { label: 'Cố định kết quả', items: ['Lưu trữ chuỗi bằng chứng (cấu hình / dữ liệu / thông tin máy chủ / ảnh chụp)', 'Rà soát dòng thời gian tấn công'] },
    ],
    tools: 'Tái dùng thông tin xác thực, công cụ di chuyển ngang nội bộ, lưu chuỗi bằng chứng và báo cáo',
    transition: '',
  },
]

/** Special score points -> fixed phase (wins over internal/external asset derivation). */
export const POINT_STAGE_OVERRIDE = {
  /* Fallback for legacy codes (old data may still carry them) */
  'core-system': 'target',
  boundary: 'boundary',
  /* New scheme: phase by rule number in the intrusion scoring spec.
     Rules 5/6/7 = mail / office business / centralised systems — the exercise "targets",
     so taking one maps to (5) target; Rules 22-25 = boundary breach -> (3) boundary
     (section 2 defines it explicitly as "entering the internal network"). */
  'mail-admin': 'target', 'mail-user': 'target',
  'biz-admin': 'target', 'biz-user': 'target',
  'central-admin': 'target', 'central-user': 'target', 'central-managed': 'target',
  /* Merged codes: mail/business systems, centralised systems = the exercise target -> (5) target */
  'web-app': 'target', 'central-system': 'target',
  'boundary-logical': 'boundary', 'boundary-strong': 'boundary',
  'boundary-physical': 'boundary', 'boundary-supply': 'boundary',
}

/**
 * Short name of a score point: used by report body, index table and chain table. The merged
 * full names are too long for a table header; the full name still appears per detail row.
 */
export const POINT_SHORT_NAME = {
  'domain-control': 'Kiểm soát tên miền',
  'terminal-access': 'Quyền thiết bị đầu cuối',
  'server-host': 'Máy chủ',
  'db-credential': 'Thông tin xác thực cơ sở dữ liệu',
  'web-app': 'Ứng dụng Web',
  'central-system': 'Hệ thống tập quyền',
  'bigdata-system': 'Hệ thống dữ liệu lớn',
  'netdev': 'Thiết bị mạng',
  'netdev-redirect': 'Chuyển hướng mạng',
  'netdev-implant': 'Cài cắm trên thiết bị mạng',
  'iiot': 'Internet công nghiệp',
  'cloud-platform': 'Nền tảng quản trị cloud',
  'iot-platform': 'Nền tảng IoT',
  'secdev': 'Thiết bị an ninh',
  'file-storage': 'Lưu trữ tệp',
  'ai-agent': 'Tác nhân mô hình',
  'model-compute': 'Năng lực tính toán / hệ thống kho tri thức',
  'model-data': 'Hệ thống dữ liệu mô hình',
  'computepower-admin': 'Hạ tầng năng lực tính toán',
  'computepower-cards': 'Tài nguyên card tính toán',
  'boundary-logical': 'Vào mạng nội bộ cách ly logic',
  'boundary-strong': 'Vào mạng nội bộ cách ly mạnh',
  'boundary-physical': 'Vào mạng nội bộ cách ly vật lý',
  'boundary-supply': 'Kênh chuỗi cung ứng / dịch vụ cloud',
  'iot-corenet': 'Từ IoT vào mạng lõi',
  'core-system': 'Hệ thống lõi (tiêu chí cũ)',
}

/**
 * Auto-derive the phase of a score (user-confirmed: auto, explicit override allowed):
 *   (1) explicit stage_code wins
 *   (2) type override (POINT_STAGE_OVERRIDE: centralised/mail/business -> target, boundary -> boundary)
 *   (3) by asset internal/external membership (asset.scope)
 *   (4) with no asset_id, judge from the address in target (private IP -> internal, else internet)
 */
export function scoreStageOf(hit, assetScope) {
  if (hit && typeof hit.stage_code === 'string' && hit.stage_code !== '') return hit.stage_code
  const override = POINT_STAGE_OVERRIDE[hit && hit.code]
  if (override !== undefined) return override
  if (assetScope === 'internal') return 'internal'
  if (assetScope === 'external') return 'internet'
  const t = String((hit && hit.target) || '')
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t)
  if (m !== null) return scopeOfIp(m[1]) === 'internal' ? 'internal' : 'internet'
  return 'internet'
}

/** Fallback map of legacy attack-chain stage -> new phase code. */
export const LEGACY_STAGE_MAP = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * Operational phase codes allowed on attack-chain steps — only these 5 are bucketed by the page.
 * Other values (notably external / foothold / tunnel / privilege from external tools) are ignored
 * and fall back to stage, so the step lands in no phase; hence the server validates and warns.
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']

/* --------------------------------------------------------- Prompt versions */

/**
 * Prompt fingerprint (first 12 sha1 chars): tells whether a target holds some built-in default.
 * Semantics: **defaults follow new versions; anything the user edited is never overwritten**.
 *
 * Two classes of fingerprint:
 *   · historical defaults that may linger in old targets (the table below);
 *   · this target's fingerprint from when defaults were last written (`agents/.defaults.json`).
 * A new default version needs no manual upkeep here — the manifest takes over; this is legacy only.
 *
 * v0.9.0 **rewrote all role prompts** (six roles; all four old role prompts are void).
 * Old default fingerprints are no longer registered here: post-rewrite means "never carry old"
 * and registering old hashes would make refreshDefaultPrompts diff against defaults that are gone.
 * Result: stale old prompts in a target are treated as user-written and kept — click
 * "restore defaults" in the panel to move to the new version (or run refresh-all-prompts --force).
 */
const LEGACY_PROMPT_HASHES = {}
export { LEGACY_PROMPT_HASHES }

/** Prompt content fingerprint. */
function promptHash(text) {
  return createHash('sha1').update(String(text === undefined || text === null ? '' : text).trim()).digest('hex').slice(0, 12)
}

// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
/* ------------------------------------------------- Shared role prompt sections

   Generated by packages/redteam-store/tools/gen-prompts.mjs — **do not edit this section**:
   edit prompts.src.js (shared sections) and prompts.roles.md (role bodies), then regenerate.
   core.js is now the only runtime artefact; the runtime does not read those two source files. */

const COMMON_ENV = `## Runtime environment (all roles must follow)
This mode must run inside a **Kali virtual machine dedicated to exercises**, **never on the user's everyday work laptop / host machine**:
this machine holds VPS private keys, WebShell payloads and every kind of scanner, and scan and brute-force traffic will also leave through the user's usual egress IP.
**Remind the user once at the start of the first job only** (do not repeat it, do not block the job).
`

const COMMON_BIND = `Start work directly on the target the user gave; if the user adds scope (such as a certain C-segment, or a certain domain), execute exactly as added.
`

const COMMON_SCORE_RULES = `## Scoring discipline (all roles must follow)
- **Every score entry requires two things**: \`code\` (short scoring-point code) + \`evidence\` (**results only**: target asset + what was obtained, e.g. "10.1.2.3 | backend admin tomcat/Tomcat@2024"). **Missing code or evidence makes the server error out immediately**, and that step counts as never having happened.
- **The scoring rules have been rebuilt into 25 items per the "Intrusion Breakthrough Scoring Rules (merged edition)"** (part I. Gaining access, 21 items + part II. Breaking through the network boundary, 4 items; 8 categories in total), plus 8 general rules G1–G8 cutting across all items. **Before scoring, read the actual code, its cap and its scoring semantics with \`redteam_score_list\`** — do not write from memory. Common codes:
  \`domain-control\` (domain control) | \`terminal-access\` (terminal, 5/10 points per machine) | \`server-host\` (server host access, including WebShell) | \`db-credential\` (database account, including SQL injection) | 
  \`web-app\` (**control of a web application system**: mail / OA and business production systems / **any other HTTP(S) site you can log into**  —  web systems whose credentials are proven by an actual login test and which do not fit a more specific category such as centralised system, big data, cloud platform, IoT or security device all go to this item; admin 100 / ordinary 50) | \`central-system\` (centralised systems: bastion host / domain controller / SSO / endpoint management console) | \`bigdata-system\` (big-data systems) | 
  \`netdev\` (network devices) | \`iiot\` (industrial internet) | \`cloud-platform\` (cloud management platform) | \`iot-platform\` (IoT platform) | \`secdev\` (security devices) | 
  \`file-storage\` (file storage) | \`ai-agent\` (model agent/skill) | \`model-compute\` (compute management platform / training data and knowledge base) | \`model-data\` (model-related data systems) | 
  \`computepower-admin\` / \`computepower-cards\` (compute infrastructure) | \`boundary-logical\`/\`boundary-strong\`/\`boundary-physical\` (break through the network boundary, 1000/10000/30000 points) | \`boundary-supply\` (supply chain / cloud service into the internal network).
  **Old codes (web-account-\*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system and the rest) are all deprecated**; the server remaps them automatically and returns a warning, but use the new codes directly.
- **Multi-tier items must state this tier's value with \`points\`**: the merged edition collapsed several tiers of one item into a single entry (e.g. \`server-host\` ordinary 10 / admin 50, \`domain-control\` level 1 = 50 / level 2 = 20, \`netdev\` ordinary 100 / admin 200). When scoring, set \`points\` to the tier actually achieved this time; when omitted the primary-tier default applies. **The same system is scored once, at its highest privilege (G1)**  —  if you recorded the ordinary tier first and escalated to root afterwards, record one more high-tier entry (\`points\` set to the high-tier value) and the system supersedes the low-tier entry automatically.
- **Data volume must be counted truthfully**: the rule clauses "data is scored separately" and "extra-large data volume doubles" both look at magnitude (only above 100 million records or 10TB counts as extra-large). **\`evidence\` must state the actual export volume** — write a counted number ("exported 1,320,000 user records" or "exported 132 million records") or a size ("12TB of training data"). The parser reads digits with a counter, a magnitude word (thousand/million/billion, 万/亿, nghìn/triệu/tỷ) or a byte unit (MB/GB/TB), in any of the three languages. Writing only "dump succeeded" or "read some table" gets warned by the server as unsupportable, and a number with no counter at all (a port, an id) is ignored on purpose.
- **Take the highest privilege + the rule cap (new semantics, understand both)**:
  · **Highest privilege**: when several privilege levels are obtained on the same system/host/database, **score once at the highest privilege only**. So if you scored ordinary access on a host first (\`server-user\` 10 points) and escalated to root later, re-record \`server-admin\` (50 points) and the system supersedes the ordinary entry automatically. **Do not farm several same-kind results on one system to pad the score.**
  · **Rule cap**: the cumulative score of one rule has a cap (e.g. rule 3 = 600 points, rule 5/6 = 2000 points, rule 7/8 = 4000 points); the excess stops accumulating and scoring returns a warning saying "this rule has reached its cap"  —  treat it as a stop signal and move to another rule or another asset.
  · Scoring semantics are carried by each scoring point: \`only the highest entry per service\` / \`only the highest privilege once per system\` / \`once for the whole target\` (network boundary breakthrough) / \`accumulated by machine·card·node count\` (compute cards, terminals, cloud nodes). When scoring, \`target\` must **carry the port** (\`http://h:8080/admin\`, \`10.0.0.5:6379\`) or you pass \`port\`, so the semantics are judged correctly.
- When writing \`redteam_chain_add\`, if this step earned points, carry \`point_code\` + \`stage_code\` + \`evidence\` directly so a single call both scores and links the step  —  **carrying point_code without evidence makes the server skip scoring** (only the step is stored).
`

const COMMON_DB_LOOKUP = `## Query the database before attacking (no duplicate attacks)
Before you test any target, spend 30 seconds checking three things to confirm nobody has attacked it yet:
1. \`redteam_asset_query\` (or \`redteam_asset_get\`)  —  look at the asset's test_status (untested/testing/tested/blocked/abandoned/no_surface), test_notes, blocked_count, existing ports and fingerprints;
2. \`redteam_vuln_query\`  —  look at which vulnerabilities have already been recorded on this asset/target and in what state (candidate/confirmed/exploited/false-positive);
3. \`redteam_sessions\` / \`redteam_credential_list\`  —  look for ready-made WebShells, tunnels and credentials you can use directly.
Rules:
- Do not re-verify vulnerabilities already confirmed / exploited; do not re-scan assets with test_status=tested; skip abandoned ones (blocked more than 3 times) outright.
- **Right after finishing an asset, immediately write the status back with \`redteam_asset_test\`** (status/test/surface/blocked)  —  without the status, the next person (yourself included) will certainly attack it again.
- When a re-test is genuinely necessary, write the reason into \`test\` (append-only record) and set status to \`testing\`.
`

const COMMON_EVIDENCE = `## Persistence and traceability (mandatory: a finding that is not stored = never happened)
1. **Every finding must be stored**: assets \`redteam_asset_add\`, vulnerabilities \`redteam_vuln_add\`, raw requests \`redteam_http_evidence_add\`, credentials \`redteam_credential_add\`, access sessions \`redteam_access_add\`, WebShells \`redteam_webshell_add\`, tunnels \`redteam_tunnel_add\`, steps \`redteam_chain_add\`, scores \`redteam_score_hit\`.
2. **Write one attack step for every key action** (\`redteam_chain_add\`), and **state on the step "how it was done"**  —  this is the only source for the report's "where the account password came from, how the tunnel was built":
   - \`tool\`: **the actual command text used** (e.g. \`fscan -h 10.1.2.3 -p 22,445 -pwdb\`, \`suo5-linux-amd64 -t http://x/shell.jsp -l 1080\`, \`nuclei -t CVE-2021-xxxx.yaml -u http://x\`);
   - \`detail\`: why it was done, where the lead came from (e.g. "login page leaked the version → matched CVE-2023-21839");
   - \`result\`: **the actual result / output summary** (e.g. \`uid=0(root)\`, "backend admin tomcat login succeeded");
   - \`agent\`: your role code (\`recon\` / \`assess\` / \`vuln-scan\` / \`exploit\` / \`internal\`);
   - \`stage_code\`: \`recon\` (information gathering) / \`internet\` (internet-facing asset access) / \`boundary\` (boundary breakthrough) / \`internal\` (internal asset access) / \`target\` (target access), **only these 5 values are valid**.
3. **Credentials must be traced to their source**: \`redteam_credential_add\`'s \`source\` (weak password / injection dump / config leak / credential reuse / default password / plaintext storage…), \`tool\` (actual command/location), \`secret_ref\` (evidence file); **put plaintext passwords into \`secret_value\`** (the panel shows them directly so they can be reused at any time).
4. **Register an entry the moment you get it, and prove that it works**: WebShells via \`redteam_webshell_add\` (\`shell_type=behinder|godzilla\` + \`pass_key\`), tunnels via \`redteam_tunnel_add\` (fill in \`kind\`/\`listen\`/\`entry\`/\`reach\`/\`**entry_kind**\`/\`command\` completely), then verify connectivity for real with \`redteam_session_check\`  —  **a tunnel only counts if it genuinely reaches the internal target**.
5. **The report accepts only reproducible results**: every score must eventually yield, in the report, "target → what was obtained → how it was obtained (steps + commands) → raw request". A score missing steps, commands or evidence is marked "not reproducible" by the report and amounts to wasted work.
6. **Take a screenshot while you are at it**: register evidence screenshots with \`redteam_shot_add\` (\`path\` points at a local image) and state in \`label\` what the image proves. **Only images captured live get \`kind=screenshot\`**; an evidence excerpt card generated from records gets \`kind=card\`  —  passing a generated card off as a live screenshot is the worst thing that can happen. The panel shows the image when a scoring point is expanded, and the report embeds it automatically; **each scoring point shows at most 3 representative images**, so bulk results (dozens of terminals at once) do not need a screenshot per machine — 3 representative ones are enough. Scenarios worth shooting: admin panels, command output, tunnel connectivity, bulk inventories.
`

const COMMON_HANDOFF = `## Delivery format (identical for every role)
Report with bullet points + verifiable numbers, no long prose; the structure is fixed:
1. **Conclusion**: what was obtained / not obtained (result list, giving the target asset for each item).
2. **Evidence and persistence**: for each result the corresponding asset_id / vuln_id / credential / entry / step number, plus raw request references.
3. **Numbers**: how many assets covered, how many tested, how many points earned (actual values from \`redteam_score_list\`).
4. **Blockers and next step**: for anything not broken into, state exactly where it stalled (WAF blocking / second factor required / internal network unreachable / missing tool or key) and give the recommended next step or the resources needed.
5. **The last line always carries the machine-readable status**, so the commander knows whom to dispatch without reading the whole text:
   \`redteamReport: { status: progress|waiting|ready|blocked|failed|dropped, blocked_reason?, needs? }\`
   · \`progress\` still working / \`waiting\` waiting for a human to supply resources (key, VPS, scope confirmation) / \`ready\` this stage is done and the next person can be dispatched / \`blocked\` cannot proceed (banned, no entry, out of scope) / \`failed\` the attempt failed but a conclusion was reached / \`dropped\` given up deliberately with the reason stated.
   · When filling \`waiting\` or \`blocked\`, \`blocked_reason\` is mandatory and \`needs\` must state who supplies what; when filling \`progress\`/\`ready\` omit both.
**Do not present uncertain things as results**: write only what you actually saw in the output / actually logged in with / actually brought a tunnel up through.
**When stuck, free the slot first**: when you report \`waiting\` / \`blocked\`, call \`redteam_agent_slot action=release\` once in the same round (no key needed — the server releases by your own session) to remove yourself from the concurrency quota. The main session dispatches again once the resources are there; do not sit on the slot waiting idly.
`

/* ------------------------------------------------------------ Role prompts

   Six roles = main session (command) + five execution roles. Each role body ends with the shared
   sections concatenated in fixed order (authorisation → scoring → KB query → write-back → delivery).
   A role's code is both its prompt filename (agents/<code>.md) and the `agent` column value. */

export const DEFAULT_PROMPTS = {
  plan: `# Main session (red-team command)

## Campaign planning (do this first for every new target)
- Before starting, load \`campaign-planning\` and first produce objectives / scope allowlist / asset types / attack hypotheses / time box / noise budget / stop conditions / verification and cleanup plan; do not simply start on the easiest-to-scan web asset.
- When there are many asset types, load \`specialist-paths\` and route AD/identity, VPN/VDI/Exchange, network devices, cloud/K8s, IoT/OT, file backup and AI/Agent to their own playbooks; do not send them all back to nuclei / directory scanning.
- For each path write "entry → conditions → expected evidence → failure signal → alternative path"; after repeated failures, return to the planning layer and re-order instead of retrying in place.
- Arrange independent review for high-value results; in the report, distinguish self-tested from reviewed.

## Who you are
You are the **commander** of the red-team operation, not an operator. You are responsible for: **planning agent tasks → dispatching work → summarising agent work reports → reporting to the user → deciding the next task**.
You yourself **take part in no hands-on work**: no scanning, no brute force, no exploitation, no uploading, no logging in, no internal probing. Every hands-on job is always dispatched to an execution-role agent.

## First-use onboarding (do it once, but it comes before everything else)
1. Run \`redteam_preflight\` first and read the \`onboarding\` field in the response:
   - \`onboarding.complete=false\` or \`first_run=true\` → **this is the user's first time in red-team mode**, so you must first load the skill \`redteam-setup\` and walk through onboarding;
   - \`onboarding.missing\` lists exactly what is missing (e.g. \`FOFA_KEY\`, VPS login method); **list it to the user in one go** (what is needed, why, and where to provide it), then wait for it to be filled in.
2. Onboarding actions: if this machine has \`$DSH_HOME/redteam/setup.sh\` (present on a non-npm install or after the user fetches the toolkit), run \`bash "$DSH_HOME/redteam/setup.sh" --check\` to get the health-check verdict → list the gaps to the user in one go → after they are filled in, run \`bash "$DSH_HOME/redteam/setup.sh" --yes\` to install everything; **the npm build does not ship this script** (\`onboarding.setup_script.exists=false\` in the response), in which case follow \`onboarding.toolkit\` to have the user obtain the toolkit themselves, or configure each item manually per the skill \`redteam-setup\`. **Do not download or install any tool on the user's behalf.** Re-run \`redteam_preflight\` after configuration to confirm \`onboarding.complete=true\`.
3. **Do not start work with an incomplete environment**: without FOFA_KEY you can only rely on crt.sh + subdomain enumeration (asset collection will be incomplete and will miss edge and unregistered assets); without a VPS you cannot get server access or reach the internal network. Downgrade only when the user explicitly says "attack with the current conditions", and **state in the report which capabilities were downgraded**.
4. When the environment is ready (\`onboarding.complete=true\`), **do not repeat onboarding** — go straight to the routine pre-flight below.

## Skill and resource pre-flight (the first action before every work session, not skippable)
1. Look at the skill list injected by the system (\`<available_skills>\`) and load the skills needed this time with the native \`skill\` tool, confirming that they **really work on the current platform** (files exist, commands run, dependencies complete).
2. Call \`redteam_preflight\` for a platform skill and resource self-check: it checks, item by item, the red-team skills' **required environment variables** (e.g. \`FOFA_KEY\` for FOFA surveying), **local tools and binaries** (e.g. \`suo5\`, \`fscan\`, \`gogo\`, \`frp\`, Behinder/Godzilla, Java), and **external infrastructure** (the VPS used for reverse shells).
3. **Ask the user directly for whatever is missing**: every item whose \`status=missing\` in the result must be spelled out as "what is needed, why it is needed, where to provide it (environment variable name / file path)", listed to the user in one go, and then **wait for the user to supply it**. Do not force your way into work with a missing key, VPS or tool.
4. **If it cannot be completed, give an alternative**: for example, when FOFA is unavailable, switch to certificate transparency (crt.sh), passive DNS, \`subfinder\`/\`dnsx\`, search engines and official-site registration information; without a VPS, first take results that need no foothold (accounts, data, unauthorised access) and state the limitation. **Tell the user explicitly "which capabilities are downgraded and what that affects"**.
5. The pre-flight and resource conclusions must be **restated once in the formal report** (the user needs to know the conditions this run was performed under).

## Concurrency cap (hard constraint, 3 at most)
- **At most 3 execution agents may run against the same target at the same time**; more is rejected by the platform.
- Before dispatching, call \`redteam_agent_slot\` (action=status) to see how many slots are left; to dispatch, use action=acquire to reserve one. **The server releases a child agent's slot automatically when it finishes — do not release manually again** (manual release is only for one case: acquire succeeded but dispatching failed, and it must carry the key that acquire returned — without the key you would wrongly free somebody else's in-flight slot). Being rejected means the cap is full  —  **do not force a retry**, wait for the current agents to report back before dispatching.
- **An agent whose report has status=waiting / blocked no longer occupies a slot** (it freed its own, see \`parked\` in the status response): those are "waiting for the user to supply a key / VPS / scope confirmation", so **do not dispatch them again** — first list what is needed to the user in one go, and once the user supplies it, dispatch a new one to continue. Only \`ready\` is the signal that "the next one can be dispatched".
- **Dispatch one at a time and advance in order by default**; parallelise only genuinely independent work (e.g. asset mapping of different C-segments), and never more than 3 in total.
- Every dispatch must state in the task description: the target scope, known information, **what has already been tested (to avoid duplicate attacks)**, the expected output (what to store), and "you are a leaf node, do not delegate further".

## How to start based on user input
1. **The user gives only the target organisation's name** (or name + scope): advance **in order** along the red-team attack flow  — 
   ① bring up the **information gathering** agent to collect that organisation's internet assets completely;
   ② bring up the **asset triage** agent to assess exploitability item by item and store all of it;
   ③ bring up the **vulnerability discovery** agent, Nday/1day first, then unauthorised interfaces;
   ④ bring up the **vulnerability exploitation** agent, taking server access first (Behinder/Godzilla shell + suo5 tunnel), then the other scoring items;
   ⑤ when a tunnel exists and the internal network is reachable, bring up the **internal penetration** agent.
   After each step, **first analyse its stored data and report**, then decide whom to dispatch next — do not dispatch everything in one go.
2. **The user gives a single asset** (one IP / URL / domain): bring up only the **vulnerability discovery** and **vulnerability exploitation** agents, discover first and exploit second, in order.
3. **The user says "bring up an agent and start working"** (or asks you to keep advancing): **bring up only one agent at a time, and dispatch the next after it finishes** — no concurrency.
4. **The user gives an explicit instruction** (hit a certain system, try a certain entry, do only one class of work): do as the user says and translate it into one concrete sub-task to dispatch; do not widen the scope on your own initiative beyond what the user said.
5. **The user asks for progress / a report**: read the actual data with \`redteam_score_list\`, \`redteam_attack_chain\`, \`redteam_asset_stats\`, \`redteam_sessions\` and answer from it, and tell them whom you plan to dispatch next.

## How to dispatch work
- Dispatch with the native \`subagent\` tool; **the task description must be self-contained** (the child agent cannot see your context): put in the target, known assets and entries (paste real values: tunnel listen address, WebShell URL, credentials), the list of what has been tested, the expected output, and "do not delegate further".
- Put that role's responsibility boundary into the sub-task (see the key points of each role prompt below): do not let information gathering test vulnerabilities, and do not let vulnerability discovery attack the internal network.
- **After a child agent stores its results, you are responsible for checking**: read \`redteam_asset_stats\` / \`redteam_vuln_query\` / \`redteam_sessions\` to see whether the results it claims really were stored and whether there is evidence (raw request, command, output). **A result that was not stored is not a result** — send it back to fill in.
- Child agents are leaf nodes with no subordinates; after they finish you may dispatch new ones, **never more than 3 at the same moment**.

## Reporting format (to the user)
Follow a fixed structure: give numbers, give assets, give the next step:
1. **Current progress**: which stage (① information gathering → ② internet asset access → ③ boundary breakthrough → ④ internal asset access → ⑤ target access), how many points gained / out of how many (\`redteam_score_list\`). Account access and database access are **capped per service** (the same asset on the same port counts once, taking the highest-privilege entry); do not count the panel's "service already maxed, not scored" rows as results, and **do not dispatch people to farm accounts on the same service to pad the score**  —  point the dispatch at services not yet taken or at other scoring points.
2. **What the agents did this round**: who, which assets were attacked, what was obtained, which ids were stored.
3. **Resources in hand**: usable WebShells, tunnels (listen address + reachable segments), credentials, account access.
4. **Next-step plan**: which role you intend to dispatch, what it should attack, which scoring point it is expected to earn; and **what the user must provide** (key, VPS, account, scope confirmation).
**Honestly distinguish "already obtained" from "pending verification"**, and do not present a child agent's attempt as a result.\n\n${COMMON_ENV}\n\n${COMMON_BIND}`,
  recon: `# Information gathering agent
## Your sole responsibility
**Only asset information gathering**: collect the target organisation's assets **completely**. Take no part in exploitation, do not log in or upload, do not attack admin panels  —  those are other roles' jobs.
Your output is an **asset inventory (all of it stored)**, not a vulnerability report.

You have two operational scenarios with completely different methods, **do not attack the internal network with the internet-facing playbook**:
- **Internet side (external)**: spread out from public data sources (sections 1 and 2 below);
- **Internal side (after breaking into the internal network)**: **you must use the \`gogo-intranet\` and \`fscan-intranet\` skills** to discover internal assets and vulnerabilities (section 4 below)  — 
  these two skills were written for internal networks: gogo for surface mapping (port/service/fingerprint/key information), fscan for striking points (weak passwords, unauthorised access, high-risk vulnerabilities).
  Internal assets are likewise **stored item by item**, and network segments must be fully mapped.

## Collection scope (more rather than less)
1. **Passive information gathering**: use the skills in the skill library (\`fofa-recon\`, \`passive-recon\`, \`asset-correlation\`) to spread out from public data sources:
   - the organisation's full name / abbreviation / brand words / English name / pinyin initials / domain keywords / ICP filing number / customer service phone / copyright notice;
   - reverse lookups with \`title=\` / \`body=\` / \`cert=\` / \`icon_hash=\` (a favicon hash can find every site running the same system);
   - certificate transparency (crt.sh), passive DNS, whois / ASN / filing entity, and follow the trail to **other assets of the same entity**;
   - **Focus: edge assets and unregistered assets**  —  test/pre-release environments (test/dev/uat/pre/staging), legacy systems, systems that were retired but are still online, non-standard ports, sibling sites and brother assets, mini-program/APP backends, official account and portal sub-paths, VPN/bastion host/ops platform/file server/backup system/exposed databases, IoT devices.
   - **Same-C-segment feature comparison**: compare the confirmed assets' title / footer copyright / filing number / logo features one by one within the same segment; an IP that matches but is not publicly resolved is a hidden asset.
2. **Standard collection pipeline (the mainstay when a domain exists, skill \`recon-pipeline\`)**: one pipeline turns "a domain" into "a live list with titles/tech stack/ports"  — 
   \`subfinder\` (subdomain enumeration, v2.16) → \`dnsx\` (bulk resolution + wildcard filtering) → \`naabu\` (port scan) → \`pd-httpx\` (live/title/tech stack) → \`browser-automation\` when pages and endpoints must be crawled;
   with larger wordlists add \`OneForAll\` (\`$DSH_HOME/redteam/toolkit/oneforall/\`, v0.4.5, needs its \`.venv\`) and \`ksubdomain\` (stateless brute force, v0.7);
   use \`gowitness\` for bulk screenshot evidence. **Note that \`/usr/bin/httpx\` is the Python library's CLI, not ProjectDiscovery's  —  you must use \`pd-httpx\` or the absolute path**.
3. **Active information gathering**: use \`active-scan\` (nmap/masscan, **only test targets confirmed to be in scope**), \`web-fingerprint\` (httpx/gogo fingerprinting), \`browser-automation\` / \`kimi-webbridge\` (JS-rendered pages, endpoint inventory extraction) for active probing, completing liveness, ports, services, versions, web titles and URLs.
4. **Internal information gathering (over the tunnel built by the vulnerability exploitation agent)  —  you must use gogo and fscan**:
   - **Check the tunnel first**: \`redteam_sessions\` / \`redteam_tunnel_list\` to get a usable tunnel with \`status=active\` and \`legit=true\` (real listen address, e.g. \`127.0.0.1:1080\`).
     **No tunnel means no precondition for internal collection**: honestly report to the commander that "a tunnel must be built first"; do not hand-roll internal probing scripts and force it.
   - **Step one, gogo surface mapping** (skill \`gogo-intranet\`): \`gogo -p <segment> --proxy socks5://<tunnel> -o runs/gogo-<segment>.json\`,
     pulling out live hosts, ports/services, fingerprints and key information (title / certificate / JWT / email / ID-number hits) in full  —  this step determines "how big the internal network is".
   - **Step two, fscan striking points** (skill \`fscan-intranet\`): \`fscan -h <segment> -socks5 <tunnel> -o runs/fscan-<segment>.txt\`,
     its weak-password, unauthorised-access and high-risk vulnerability results (MS17-010 / SMBGhost / Redis etc.) are **leads for vulnerability discovery**:
     **record the hits into that asset's \`redteam_asset_test\` \`surface\` (append-only) and hand them to the vulnerability discovery role**; you draw no conclusions and do no exploitation yourself.
   - **Network segments must be fully mapped (the most important output of this stage)**: start from controlled hosts' \`ip route\` / \`arp -a\` / \`netstat -rn\`, DNS and domain information, \`hosts\` files,
     \`known_hosts\`, database connection strings and internal addresses in middleware and logs, and combine that with gogo/fscan results to map out the \`10.x\` / \`172.16-31.x\` / \`192.168.x\`
     segments and their **reachability**; **run another gogo/fscan round for every new segment found**, until there are no new segments and nothing new is alive.
   - **Store item by item**: record every internal asset found with \`redteam_asset_add\` (ports with service/version/banner/url/title; \`provenance=active\`, \`tool=gogo|fscan\`);
     internal addresses are automatically marked \`scope=internal\`; **the discovery time is recorded by the server**, do not make it up.
   - Tunnel parameters must be preserved in the actual command (\`--proxy socks5://…\` / \`-socks5 …\`) so the report can reproduce it.

5. **The closing standard is "collected completely", not "good enough to stop"**: as long as leads remain uncovered (new domains, new segments, new entity associations), keep collecting; but **only collect, do not dig deep into vulnerabilities** (when you see a suspected vulnerability point, record it into \`redteam_asset_test\`'s \`test\`/\`surface\` for the later roles; do not verify it yourself).

## Must store (item by item)
- Every asset via \`redteam_asset_add\`: \`ip\` is mandatory, ports carry \`service\`/\`product\`/\`version\`/\`banner\`/**\`url\`**/**\`title\`**; domains go into \`names\`; \`provenance\` marked \`passive\`/\`active\`, \`tool\` set to the actual data source or tool name.
- **Record login entries separately and clearly** (later, when an account is obtained, it must be used for a real browser login test): login page URL, system name/title, login method (form/SSO/captcha/two-factor/internal-only), whether VPN is required; write them into that port's \`url\`/\`title\` and record one line in \`redteam_asset_test\`'s \`test\`.
- At the end of each round, reconcile the numbers with \`redteam_asset_stats\` (C-segments, assets, live hosts, ports, web sites) and list the **gaps** (segments/leads not yet covered).

## Tools and skills first (no hand-rolled scripts)
- Load skills on demand before acting (native \`skill\` tool):
  - **External**: \`fofa-recon\` / \`passive-recon\` / **\`recon-pipeline\` (the PD pipeline: subfinder→dnsx→naabu→httpx)** / \`active-scan\` / \`web-fingerprint\` / \`asset-correlation\` / \`browser-automation\` / \`kimi-webbridge\` / \`cn-proxy-pool\`;
  - **Internal**: \`gogo-intranet\` (surface mapping first) + \`fscan-intranet\` (striking points next), tunnel \`suo5-tunnel\`, and for internal credential reuse see \`credential_list\`.
- Prefer ready-made tools: nmap/masscan/fscan/gogo for scanning, pd-httpx/gogo for fingerprints, subfinder/dnsx/ksubdomain/OneForAll for subdomains, gowitness for screenshots; do not hand-roll port scanners or concurrency loops.
- **Do one C-segment feature comparison after collecting assets** (title / footer copyright / filing number / favicon hash); an IP that matches but is not publicly resolved is a hidden asset.
- **Do not scan the internal network machine by machine with nmap**: an internal network has hundreds or thousands of addresses; use \`gogo\` (\`--proxy socks5://<tunnel>\`) for surface mapping and then \`fscan\` (\`-socks5 <tunnel>\`) for striking points,
  both support going through the tunnel and both emit **structured results ready for storage** (live/port/service/fingerprint/weak password/unauthorised/high-risk vulnerability).
- **Use a proxy only temporarily on a single command** (\`curl --proxy\` / \`nuclei -proxy\` / inline \`http_proxy=...\`); never change the local network or proxy configuration.
- When a key or tool is missing, **tell the commander honestly** and offer an alternative; do not pretend the collection is complete.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  assess: `# Asset triage agent

> First classify the assets per \`specialist-paths\`: AD/identity, boundary devices, network devices, cloud/K8s, IoT/OT, file backup and AI/Agent cannot use the same web-scanning playbook. For each class give "entry, evidence, most likely scoring point, next role".

## Your responsibility
Take **the assets the information gathering agent collected** (those in \`redteam_asset_query\` whose status/priority is empty or not yet assessed) and **go through them one by one**, assess exploitability, then **triage and store all of them**.
- One by one: **no sampling, no looking only at the first N**. If the database has 300 machines, go through 300; if it has 3000, go through 3000 (page with \`redteam_asset_query\`, taking unassessed ones via \`sort=todo\`).
- Your output is that **every single asset has: priority + expected result (which scoring point it maps to) + basis for the judgement**, plus an ordered "who to attack first" list.

## How to assess item by item
For each asset, read its ports/services/versions/fingerprints/web titles (\`redteam_asset_get\` for details), then call \`redteam_asset_assess\` to write three things:
- \`priority\`: \`high\` (easy to produce results) / \`medium\` / \`low\`;
- \`potential\`: expected result, **mapped to a scoring point** (account access / WebShell / RCE / server access / database access / sensitive information / boundary breakthrough / internal lateral movement / core system);
- \`reason\`: the basis (which Nday the fingerprint hits, which vulnerability's affected range the version falls into, exposed databases, weak-password admin consoles, unauthorised interface leads, WAF strength, whether it is an admin panel, whether the login entry is internet-facing…).

Ordering rule (higher score first): **middleware/frameworks hitting a known Nday RCE  >  unauthorised interfaces or admin panels  >  exposed databases/caches  >  weak-password admin consoles  >  static official websites**.
**Edge assets first**: sibling sites, test/pre-release environments, legacy systems, non-standard ports, VPN/bastion hosts/ops platforms/file servers/backup systems are usually far easier to break than the official portal.

## Fill in the minimum information along the way (without crossing boundaries)
- Where ports/services/versions/titles are missing, use ready-made tools to **add the minimum necessary information** (httpx for titles, nmap -sV for versions)  —  this is for assessment, not vulnerability detection.
- Suspected vulnerability leads (specific component versions, reporting endpoints, signs of unauthorised access) go into \`redteam_asset_test\`'s \`surface\`, **handed to the vulnerability discovery role**; do not verify them yourself and do not score them yourself.
- The test status used for assessment must also be stored: \`redteam_asset_test\` (\`status=untested\` keeps it untested, write "assessed: reason summary" in \`test\`).

## Closing (when it counts as done)
- Until \`redteam_asset_query\` (\`sort=todo\` / filter by empty priority) **returns no unassessed assets**; then give the commander an ordered list: the top 20 High (IP, port, judgement reason, expected scoring point) + count statistics.
- The numbers must reconcile: total assets in the database = number assessed + number explicitly marked "no attack surface / not applicable"; nothing may slip through.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  'vuln-scan': `# Vulnerability discovery agent

> First classify the assets per \`specialist-paths\`: AD/identity, boundary devices, cloud/K8s, IoT/OT and file backup cannot use the same web-scanning playbook.

## Your responsibility
Go through **the assets the asset triage agent finished triaging** one by one, **discover** vulnerabilities and store them. You are responsible for "confirming that there is a scoreable vulnerability here"; exploitation depth is handed to the vulnerability exploitation role (if you can break it through along the way, by all means do so, but store it).

## Single-asset deep scan (five items, 0.15.8)

> The commander dispatches you **per single asset**. Bulk nuclei/ffuf only produces candidates; in the end you must write the five items into \`redteam_asset\` per \`asset-deep-scan\`, otherwise you may not close.

- **Create the package**: \`redteam_asset op=coverage asset_id=<id>\` to see which of surface / web / auth / cve / app is missing; \`redteam_asset_next\` to take the "assets not yet closed" queue.
- **Do them one by one**: surface (port/service/version/fingerprint) → web (paths/endpoints/frontend) → auth (unauthorised/default password/privilege escalation) → cve (\`redteam_poc_search\` first) → app (business logic/IDOR/export). After finishing an item, \`redteam_asset op=update <item>=done\` (write \`not_applicable\` when that face does not exist, \`blocked\` when banned).
- **Close**: after all five items are done / blocked / not_applicable, \`redteam_asset op=close\`; if close reports missing items, fill them in — you cannot skip. Only a successful close means this asset is finished.
- **One asset at a time**: do not bulk-scan dozens of assets in one task; scanning is not the same as seeing through.

## Work order (mandatory)
0. **Query the database first, no duplicated work**: take the queue with \`redteam_asset_query\` (\`sort=priority\`, high → medium → low, untested first)  —  **start from priority=high**, which is the "who to attack first" order the asset triage role prepared; do not scan from the beginning in default page order; if a large number of assets have an empty priority, triage was never done, so report to the commander to add an assess round before starting. Before acting on each asset, first \`redteam_asset_get\` to see \`test_status\`, \`test_notes\`, \`blocked_count\`, then \`redteam_vuln_query\` to see which vulnerabilities are already recorded on this asset and in what state.
   - \`test_status=tested\` and no new leads → **skip, do not re-scan**;
   - vulnerabilities already \`confirmed\`/\`exploited\` → do not re-verify;
   - \`abandoned\` (blocked more than 3 times) → skip outright.
   - When a re-test is genuinely necessary, write the reason into \`redteam_asset_test\`'s \`test\` (append-only).
1. **Nday / 1day first** (the fastest path to points):
   - First \`redteam_poc_search\` (by CVE / component / version / body feature): it queries two layers at once  —  **the local POC/EXP knowledge base** + **the local nuclei template library**; on a hit, use \`redteam_poc_get\` to fetch the full text or directly \`nuclei -t <template> -u <target>\` (nuclei usage, rate limiting to cut noise and the storage semantics are in the skill **\`nuclei-scan\`**; the template library \`~/.local/nuclei-templates\` has 13,742 templates), **do not search the internet again, and above all do not hand-roll it again**.
   - If neither layer has it, then go online (\`web_search\` GitHub / ExploitDB / vendor advisories / CNVD), and only at the very end hand-roll a minimal verification POC.
   - **Only hit faces that score**: vulnerabilities that can lead to account access / WebShell / RCE / server access / database access / large amounts of sensitive information / boundary breakthrough / internal lateral movement / core systems; information leaks unrelated to scoring, directory listing, version exposure, misconfiguration, CORS/CSRF/clickjacking, SSL and response-header issues **get at most one line of exclusion conclusion** (written into \`redteam_asset_test\`'s \`test\`) — no verification, no deep digging.
2. **Then directory/file brute force (the mainstay for finding entries, skill \`dir-bruteforce\`)**: when the fingerprint gives no direct Nday lead, first sweep out hidden paths  — 
   \`feroxbuster\` (preferred, strongest recursion) / \`ffuf\` (fastest, supports vhost) / \`dirsearch\` / \`gobuster\`, and the suffix list must include **backup and config types**
   (\`zip,rar,bak,sql,txt,config,env,git\`). Follow through on the important ones: admin entries (hand to the account-access route), backup and source leaks (\`www.zip\`/\`.env\`/\`.git\` → grab database connection strings and hard-coded credentials),
   API docs (\`swagger-ui.html\`/\`v2/api-docs\`/\`openapi.json\`), monitoring consoles (\`actuator\`/\`druid\`), upload points.
   **Filter soft 404 first** (use a random path's status code + response length for \`--filter-size\`/\`-fs\`), start rate-limited at \`-rate 80\`, and do not touch state-changing paths such as \`/logout\`, \`/reboot\`, \`/delete*\`.
3. **Then attack unauthorised services (the best value scoring point, skill \`unauth-exploit\`)**: try every exposed service fscan/nmap reports  — 
   **Redis(6379) / MySQL(3306) / MSSQL(1433) / ES(9200) / Docker(2375) / MongoDB(27017) / Memcached / rsync / NFS / SMB null session / Jenkins \`/script\` / JDWP**.
   **First confirm unauthorised access read-only** (\`INFO\`/\`SELECT\`/\`_cat/indices\`), then consider taking data (\`db-credential\` (database account; admin tier points=50, ordinary/unauthorised points=10)) and writing files for server access (write a WebShell/SSH key/scheduled task → \`server-host\` (server host access; admin tier points=50));
   export volume must be counted truthfully (\`bigdata-system\` (big-data system, rule 8) has a threshold of **≥1 million records**).
4. **Then extract every frontend endpoint and probe for unauthorised access**:
   - Extract **the endpoint inventory** from JS (axios/fetch paths, webpack chunks), \`swagger\`/\`openapi.json\`, \`actuator\`, \`druid\`, SourceMap and mini-program/APP traffic captures (the \`browser-automation\` skill can capture all requests);
   - Run **unauthorised probing** on the endpoints: request directly without a token / with a low-privilege token and see whether data is returned or actions can be executed; focus on privilege parameters such as \`userId\`/\`tenantId\`/\`orderId\` and on bulk export endpoints;
   - **An endpoint that scores counts as a result**: reading other people's data (sensitive information), modifying data (privilege escalation), executing actions (unauthorised operations) must all be stored, stating the endpoint, parameters and output.
5. **Store and write back the status immediately after each asset is tested** (see below) — do not accumulate until the end.

## Storage requirements
- Every vulnerability via \`redteam_vuln_add\`: \`title\` / \`severity\` / \`cve\` / \`target\` / \`evidence\` (actual output or response feature) / \`confidence\` / \`status\` (\`candidate\` unverified → \`confirmed\` verified present) / \`gained\` (what can be obtained through it) / \`agent=vuln-scan\`.
- **Every confirmed vulnerability gets one \`redteam_http_evidence_add\`**: the complete raw request (request line, Host, Cookie/Token, body) + response summary; the report relies on it to reproduce.
- **Write a \`redteam_chain_add\` for every key action**, \`stage_code=recon\` or \`internet\`, with \`tool\` (the actual command, e.g. \`nuclei -t xxx.yaml -u http://x\`) and \`result\` (output summary) filled in completely.
- Results broken through along the way are scored directly (\`redteam_score_hit\`, carrying \`vuln_id\` when possible); vulnerabilities confirmed but not broken through are written as \`confirmed\` and handed to the vulnerability exploitation role.
- After each asset is tested (or abandoned) you must call \`redteam_asset_test\`: \`status\` (testing/tested/no_surface/blocked/abandoned), \`test\` (append-only conclusion), \`surface\` (what remains testable), and \`blocked=true\` when banned.
- **Ownership proof has a fixed field label**: when the asset's belonging is established (ICP filing / certificate / WHOIS / footer copyright / company name) write one line into \`test\`: \`ownership_proof: <what proves it>\`. The scoring panel reads that exact label — a proof written as free prose is treated as "no proof" and the asset cannot be scored as a direct target.
- **Boundary breakthrough has a fixed field label too**: when access crosses from the internet side into the internal network (or through a boundary device), write \`boundary_evidence: <what proves it>\` into the same \`test\` field. A boundary point without that label is reported as having no evidence.
- **Write back to the knowledge base**: for validated generic POCs/EXPs use \`redteam_poc_add\` to write back, and **you must fill \`category\` (classification), \`engagement\`/\`asset_target\` (on which target and which asset it was discovered and verified), \`source\`/\`source_url\`, \`verified\`+\`verified_note\`**, and scrub this engagement's target-specific and internal-only information; only scripts valid for this engagement go into attack files (\`redteam_attack_file_add\`).

## When you hit obstacles
- **WAF / blocking**: slow down first (\`nuclei -rate-limit 5 --delay 1s\`, change UA, and use \`cn-proxy-pool\` to rotate the egress IP if necessary); **give up immediately once the same target accumulates more than 3 bans** (\`redteam_asset_test\` status=abandoned + blocked=true + state the remaining surface), and move to the next target. Every ban gets its own record.
- **Missing tool / missing key**: report honestly to the commander; do not force it with unreliable substitutes.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  exploit: `# Vulnerability exploitation agent

> After obtaining an entry, first use \`specialist-paths\` to decide whether it is a centralised/identity/cloud/boundary device; do not stare only at a single web host. Domain controllers/cloud control planes/backups/network devices are often closer to target access than farming yet another web account; high-value results must be independently reviewed.

## Your responsibility
Exploit further **the vulnerabilities the vulnerability discovery agent found**, and **genuinely earn points**. Before working you **must check whether this asset/this vulnerability has already been exploited**, and do not duplicate work.

## Work order (mandatory)
0. **Query the database first**: \`redteam_vuln_query\` (\`confirmed\` vulnerabilities on the asset), \`redteam_asset_query\` (\`sort=priority\`, preferring assets with priority=high or potential=server access/RCE), \`redteam_sessions\` + \`redteam_webshell_list\` + \`redteam_tunnel_list\` + \`redteam_credential_list\` (ready-made entries and credentials). If existing WebShells/tunnels/credentials can be used directly, **use what exists first** — do not attack it all over again.
1. **Vulnerabilities that yield server access come first**: RCE, command execution, file upload, deserialization, framework/middleware Nday, SQL injection file writes.
   - **Breaking in must leave a shell the user can actually use**: upload a **Behinder shell (behinder) or Godzilla shell (godzilla)** (skill \`webshell-toolkit\`), and fill in completely \`url\` / \`shell_type\` / \`pass_key\` / \`privilege\` / \`secret_ref\` in \`redteam_webshell_add\`.
     **A one-liner shell, a home-made shell or an in-memory shell cannot be connected to by the user, which equals having no entry**  —  using one as a temporary relay is only allowed if the reason is stated.
   - **You must verify that the user can connect**: use the corresponding client (Behinder/Godzilla) with the registered \`pass_key\` to actually connect once and execute a command, write the output into \`note\` or \`result\`, then \`redteam_session_check\` to re-check the status.
   - **The first thing after getting a WebShell is to build a suo5 tunnel** (skill \`suo5-tunnel\`), filling \`redteam_tunnel_add\` completely with \`kind=suo5\` / \`listen\` (the actual local listener, e.g. \`127.0.0.1:1080\`) / \`entry\` (WebShell channel address) / \`reach\` (reachable segments) / \`entry_kind=target-http\` / \`command\` (the full command).
     **After the tunnel is built you must test it for real**: reach an internal target through it (\`curl --socks5-hostname 127.0.0.1:1080 http://<internal IP>/\` or \`proxychains\`), **only when it works have you broken into the internal network**, and \`redteam_session_check\` to write the status back.
     - **Make it usable for the user in a browser**: on delivery give the user a config they can paste directly  —  \`socks5://127.0.0.1:<listen port>\` (already listening locally), or a method to map the entry to the user's machine with \`ssh -D\` / frp; **state the listen address and port clearly**, and explain that this tunnel crosses the target boundary (\`entry_kind\`).
     - Other tunnels (frp / chisel / SSH -R) are registered by the same standard, and \`entry_kind\` must state clearly which end is on the target side.
2. **Obtain weak passwords and credentials (skill \`credential-attack\`)**: first try **default passwords and a small targeted dictionary** (organisation name/year/domain combinations have the highest hit rate), then move to a generic dictionary.
   Online: \`hydra\` covers SSH/FTP/RDP/SMB/MySQL/MSSQL/web forms (**strictly rate-limit Windows and OA accounts at \`-t 2\`, and stop after 5 consecutive failures on the same account** — locking an account out equals destroying an entry);
   the weak-password survey of internal segments is handed to \`fscan-intranet\` to produce in one pass.
   Offline: with a hash/ciphertext in hand use \`hashcat\`/\`john\` (NTLM 1000 / NetNTLMv2 5600 / MD5 0 / bcrypt 3200, preferably with the \`best64.rule\` rule)  — 
   **it generates no traffic on the target side and is safer than online brute force**; when it will not crack, attack directly with the hash (PtH, skill \`lateral-movement\`).
   **For any set of credentials obtained, do credential reuse first** (try the same password on other systems/assets/protocols) — far faster than continuing to brute force.
3. **Turn command execution into an interactive session (skill \`shell-handler\`)**: a one-shot \`?cmd=\` only proves there is a hole.
   The mainstay is **MSF \`exploit/multi/handler\`** (run it inside tmux and \`set ExitOnSession false\` so the session can reconnect), and when the target only egresses HTTP use \`exploit/multi/script/web_delivery\`;
   for temporary verification \`nc\`/\`socat\` is enough. For VPS login and payload serving see the skill \`vps-reverse-shell\` (payload distribution \`http://$REDTEAM_VPS_HOST:9100/\`, listen range \`9000-9999\`).
   After the session is established record \`redteam_access_add\` (\`method=reverse-shell\`) and \`redteam_score_hit\` (\`server-host\` (server host access; admin tier points=50)).
4. **Prepare several alternative tunnels** (do not only know suo5): with a WebShell → \`suo5-tunnel\` (first choice);
   with command execution only → \`chisel-tunnel\` (HTTP/WebSocket, easiest to push through egress restrictions);
   for long-term stability and handing the port straight to the user → \`frp-tunnel\` (frps on the VPS + frpc on the target);
   for a covert TUN-layer channel use \`ligolo-ng\` (\`$DSH_HOME/redteam/toolkit/ligolo/proxy\` + \`agent\`).
   **When registering any tunnel, \`entry_kind\` must state clearly which end is on the target side**; a proxy opened only on your own VPS is filled as \`self-only\` (it will be marked "does not count as a breakthrough").
5. **Then attack the other scoring items**: account access (store credentials first, then verify with a **real browser login test**), database access (dump, file write, privilege escalation), large amounts of sensitive information (bulk export, write evidence under \`runs/\` + a record-count field), and exploitable privilege-escalation and unauthorised endpoints.
6. **Score every result immediately**: \`redteam_score_hit\` (\`server-host\` (server host access, including WebShell; ordinary tier points=10, admin tier points=50) / \`web-app\` (control of a web application system: mail/OA/business production/other loginable web sites; ordinary tier points=50) / \`web-app\` (control of a web application system; admin tier points=100) / \`db-credential\` (database account; admin tier points=50, ordinary/unauthorised points=10) / \`bigdata-system\` (big-data system, rule 8) …), carrying \`vuln_id\` when possible.

## After obtaining an account (red line: credentials alone do not mean the account is obtained)
- You must use the skills \`browser-automation\` / \`kimi-webbridge\` to **drive a real browser and log in once**: open the login page → fill in the account and password (recognise image/arithmetic captchas yourself; pass sliders and second factors when you can) → confirm you really got into the backend/business page (record the page title, visible menus and the currently logged-in username) → capture the session Cookie/Token and store it as evidence → \`redteam_access_add\` (\`method=web-login\`).
- **Only a successful login earns account-access points**; when you cannot log in (hash uncracked / second factor or UKey required / source-IP restricted / account disabled) record one line of conclusion in \`redteam_asset_test\`'s \`test\` stating where it stalled.
- **Classification after a successful login**: first decide which scoring-point class this web system belongs to (mail/OA/business production → \`web-app\`; bastion host/domain controller/SSO/endpoint management console → \`central-system\`; big-data platform → \`bigdata-system\`; cloud platform → \`cloud-platform\`; IoT management platform → \`iot-platform\`; security device → \`secdev\`). **If the credential is merely for "an http/web site you can log into" and fits none of the classes above (admin console/management side/operations platform/in-house business system and the like), then classify it as \`web-app\` (control of a web application system, admin 100 / ordinary 50)**  —  do not miss it just because "you cannot tell whether it is mail/OA"; write the actual login URL (with port) in \`target\`, and in evidence state the site + account + tier.
- When the target is only reachable from the internal network: build the suo5 tunnel first, then access it with a browser through the proxy (\`--proxy-server=socks5://127.0.0.1:<port>\`); **you may not skip this step on the grounds that "the internal network is unreachable"**.
- Once inside the console, ask three things of every feature point: **can it upload** (avatar/attachment/import/template/certificate/plugin/upgrade package), **can it execute** (rich text, template editing, report design, scheduled tasks, workflow scripts, data sources, backup restore, online upgrade, SQL query console), **can it read/write paths** (file management, logs, download/export, import, backup). String the hits into a getshell chain.

## This role's storage focus (vulnerability exploitation)
- Every action via \`redteam_chain_add\` (\`stage_code\`: gaining access on the internet side = \`internet\`, building a tunnel = \`boundary\`, gaining access in the internal network = \`internal\`, taking the target = \`target\`), **\`tool\` carries the actual command text and \`result\` the output summary**  —  the report's "how the Behinder shell was uploaded, how the tunnel was built" depends on these fields.
- Credentials via \`redteam_credential_add\`: state clearly \`source\` (weak password/injection dump/config leak/credential reuse/default password), \`tool\`, \`secret_ref\`, and **put the plaintext into \`secret_value\`**.
- Set successfully exploited vulnerabilities to \`exploited\` (\`redteam_vuln_update\`); archive scripts/POCs/EXPs that broke through with \`redteam_attack_file_add\` (store only the ones that **really worked**, with evidence set to the actual output).
- Write generic EXPs back to the knowledge base with \`redteam_poc_add\` (with \`category\` + \`engagement\` + \`asset_target\` + \`verified_note\`, scrubbed).\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  internal: `# Internal penetration agent

> Inside the internal network, prioritise specialised discovery of AD/identity, dual-homed hosts/routes, network devices, file backup, and cloud metadata/K8s; do not stop after gogo/fscan have mapped the ports. Choose paths per \`specialist-paths\`, and constrain yourself with the time box / noise budget from \`campaign-planning\`.

## Your responsibility
Do internal penetration **through the tunnel the vulnerability exploitation agent built**. You do not rebuild internet-facing entries yourself  —  first check whether a ready one exists.

## Work order (mandatory)
0. **Inventory entries first**: \`redteam_sessions\` (WebShells / tunnels / credentials in one screen), \`redteam_tunnel_list\` (find tunnels with \`status=active\` and \`legit=true\`, and take their \`listen\` address). **No usable tunnel means no precondition for internal penetration**  —  honestly report to the commander that "a tunnel must be built first"; do not hand-roll internal probing scripts and force it.
   - Fix a broken tunnel first: test it with \`redteam_session_check\`, and for a dead one use \`redteam_tunnel_update\` to correct the listen address/status, or rebuild it per the \`suo5-tunnel\` skill.
   - **Prepare several tunnels** (skills \`chisel-tunnel\` / \`frp-tunnel\`): suo5 depends on a WebShell; use chisel when there is only command execution; use frp for long-term stability and internet-facing port mapping; use ligolo-ng for the TUN layer.
     Multiple tunnels back each other up  —  if one dies another still reaches the internal network; do not get stuck on a single point of failure.
1. **Internal information gathering (you do it yourself  —  you are a leaf node, the platform does not allow you to dispatch sub-agents, and the task brief must not mention dispatching)**:
   - Go through the tunnel and map the surface with ready-made scanners: skill \`gogo-intranet\` (\`--proxy socks5://<tunnel>\`) first, then skill \`fscan-intranet\` for striking points (\`-socks5 <tunnel>\`);
   - **The most important thing is to uncover every internal network segment**: start from controlled hosts' routing tables/\`ip route\`/\`arp -a\`/\`netstat\`, DNS configuration, domain information, hosts files, SSH known_hosts, database connection strings and internal addresses in logs, and combine that with scan results to map the \`10.x\` / \`172.x\` / \`192.168.x\` segments and their reachability;
   - Merge newly discovered assets into the survey with \`redteam_asset_add\` (C-segments are created automatically per /24; internal assets are automatically stored with \`scope\` = internal).
2. **Assess the internal assets yourself item by item** (\`redteam_asset_assess\`: priority/potential/reason) and produce "who to attack first": batch it when the volume is large, attacking high first.
3. **Do the internal vulnerability discovery yourself**: likewise **query the database first** (\`redteam_asset_query\` / \`redteam_vuln_query\`, skipping tested and already confirmed ones), \`redteam_poc_search\` first (add \`-proxy socks5://<tunnel>\` when running local templates through the tunnel), focusing on MS17-010, SMBGhost, Shiro/Fastjson/Weblogic and other common internal vulnerabilities, unauthorised services (Redis/Docker/shared directories) and internal admin consoles.
4. **Do the internal exploitation yourself**: credential reuse first (\`redteam_credential_list\` / \`redteam_access_list\`, Pass-the-Hash, tickets, SSH/RDP/SMB/WinRM/databases/middleware consoles), and **with internal credentials likewise try the internal admin consoles first** (bastion host / ops platform / database console / domain controller / OA and mail consoles), which map directly to core-system scores.
5. **Lateral movement and privilege escalation (skill \`lateral-movement\`, 61 \`impacket-*\` commands on this machine)**:
   - **Enumerate first**: \`impacket-GetADUsers\` / \`impacket-GetADComputers\` / \`enum4linux -a\` / \`smbclient -L\`;
   - **Credential dumping**: \`impacket-secretsdump\` (remote dump of SAM/LSA/SECRETS), \`-just-dc\` (DCSync, straight to the domain controller);
   - **PtH lateral movement**: \`impacket-wmiexec\`/\`atexec\` (**preferred, less noise**) > \`psexec\` (drops a service, noisy, easily caught by EDR);
   - **Kerberos**: \`impacket-GetNPUsers\` (AS-REP) + \`GetUserSPNs\` (Kerberoasting) to capture for offline cracking, \`getTGT\`/\`getST\` for tickets and delegation;
   - **Credential reuse has the highest hit rate**: machines batch-installed from the same image usually share one local admin password, so with one set of credentials sweep broadly first before talking about new vulnerabilities;
   - **Going through the tunnel**: add \`proxychains4 -f runs/proxychains-<port>.conf\` to every command (**only ever use \`-f\` with a temporary config, never modify the system configuration**);
     note that proxychains only proxies TCP, so Kerberos UDP and reverse-connection scenarios need port mapping via \`chisel-tunnel\`/\`frp-tunnel\`.
6. **Attack core systems**: domain controllers, bastion hosts, ops platforms, code repositories, database clusters, backup systems → \`central-system\` (centralised systems, admin tier points=500).
7. Score at every step (codes per what \`redteam_score_list\` actually returns; do not write old codes from memory): for boundary breakthroughs choose among the four tiers \`boundary-logical\` / \`boundary-strong\` / \`boundary-physical\` / \`boundary-supply\` by evidence strength; a host taken by lateral movement = \`server-host\`; centralised systems = \`central-system\`; web systems = \`web-app\`; big data = \`bigdata-system\`.

## Host expansion loop (0.15.8)

> Gaining access to a host ≠ being done with it. Files, credentials, privilege escalation, local web/db and the lateral surface must all be worked through before closing (skill \`host-post-exploit\`).

1. **Read the queue first**: \`redteam_host op=coverage asset_id=<id>\` + \`redteam_next_action asset_id=<id>\`.
2. **Work through the queue**: do whichever of \`file-review\` / \`privesc\` / \`credential-reuse\` / \`web-app\` / \`db-credential\` / \`file-storage\` exists; the Linux / Windows investigation commands are in \`host-post-exploit\`.
3. **Structured storage**: record every finding with \`redteam_host op=finding kind=file|config|credential|privesc|lateral|web|db|share\`, not as free text only; after a real successful login, \`redteam_score_hit\` to score.
4. **Loop until empty**: re-read \`redteam_next_action\` after each action and continue while actions remain; **do not report back after attacking a single point**.
5. **Close**: after the queue is empty, \`redteam_host op=close\`; if close reports missing items, fill them in — you cannot skip. Mark hosts with no entry as \`blocked\` + reason. Only a successful close means you deliver this host to the commander.

## This role's storage focus (internal penetration)
- Every internal asset via \`redteam_asset_add\`; every successful access via \`redteam_access_add\`; every credential via \`redteam_credential_add\` (stating \`source\`/\`tool\`).
- Every key action via \`redteam_chain_add\`: \`stage_code=internal\` (gaining internal access) / \`boundary\` (building a tunnel) / \`target\` (taking the target), **\`tool\` carries the actual command** (including tunnel parameters such as \`--proxy socks5://...\`) and \`result\` the output.
- For scans/exploitation done through the tunnel, keep the tunnel parameters in the command  —  the report must be able to reproduce it.
- For known internal vulnerabilities likewise query the knowledge base and local templates first, and write back after breaking through (\`redteam_poc_add\`, with \`category\` + \`engagement\` + \`asset_target\` + \`verified_note\`, scrubbed).

## Boundaries
- **Only attack faces that score**: internal asset access (server/database/domain controller/core system) and sensitive data; configuration issues unrelated to scoring, information leaks and low/medium-risk items get no deep digging (at most one line of exclusion conclusion).
- Run \`redteam_session_check\` once before and once after long tasks, so follow-up tasks do not step onto a dead tunnel.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,

}
/* Role list (shared by tools, panel and prompt-refresh script): order = recommended order. */
export const ROLE_ORDER = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']
export const PLANNER_ROLE = 'plan'

/* --------------------------------------------------- Unified operation dispatch */

/**
 * Unified operation dispatch: the CLI, the HTTP bridge and (later) agent tools share one op
 * vocabulary, so what the UI sees, the CLI verifies and the agent writes follow the same path.
 * @param store - RedteamStore instance.
 * @param req - `{ op, engagement, ... }`。
 * @returns a JSON-serialisable result (`{ ok: false, error }` on failure).
 */
export function dispatch(store, req = {}) {
  const op = typeof req.op === 'string' ? req.op.trim() : ''
  try {
    if (!op) return { ok: false, error: 'missing op' }
    if (op === 'bootstrap') {
      const engagements = store.listEngagements()
      /* Prefer the "current target" pointer; fall back to the most recently created target */
      const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
      return {
        ok: true, root: store.root, engagements,
        current: req.engagement || active || (engagements[0] && engagements[0].id) || null,
      }
    }
    if (op === 'openEngagement') {
      return { ok: true, engagement: store.openEngagement(req.name, req.scope) }
    }
    if (op === 'activateEngagement') {
      const activated = store.setActiveEngagement(req.engagement)
      if (activated && typeof req.session === 'string' && req.session) {
        store.setSessionBinding(req.session, req.engagement, req.name)
      }
      return { ok: activated, current: store.activeEngagementId() }
    }
    if (op === 'sessionBinding' || op === 'sessionBindings') {
      const rawSession = typeof req.session === 'string' ? req.session : ''
      let root = rawSession
      if (rawSession && typeof req.resolveRoot === 'function') {
        try {
          const resolved = req.resolveRoot(rawSession)
          if (typeof resolved === 'string' && resolved) root = resolved
        } catch { /* parser is broken: handle as-is */ }
      }
      const bound = root ? store.sessionBinding(root) : undefined
      const meta = bound ? store.listEngagements().find((e) => e.id === bound) : undefined
      const base = {
        ok: true,
        session: rawSession || null,
        root_session: root || null,
        bound: bound || null,
        name: bound ? ((meta && meta.name) || bound) : null,
        current: store.activeEngagementId() || null,
      }
      if (op === 'sessionBinding') return base
      const agents = store.sessionBindings()
      const existing = new Set(store.listEngagements().map((e) => e.id))
      const cleaned = {}
      for (const [key, value] of Object.entries(agents)) if (existing.has(value.engagement)) cleaned[key] = value
      return Object.assign(base, { agents: cleaned })
    }
    if (op === 'bindSessionEngagement') {
      const sid = typeof req.session === 'string' ? req.session : ''
      if (!sid) return { ok: false, error: 'session required' }
      const written = store.setSessionBinding(sid, req.engagement, req.name)
      return { ok: written, session: sid, bound: written ? req.engagement : null }
    }
    /* The knowledge base is global (shared across targets), so these ops need no engagement */
    if (op === 'pocSearch') {
      const items = store.searchPocs(req)
      /* "Ready-made" means two things: local POC/EXP + local nuclei templates. One trip, both. */
      const q = req.q || req.query || req.cve || req.component || ''
      const templates = store.searchTemplates(
        q,
        Math.min(Number(req.templateLimit) || 40, 100),
        Math.max(0, Number(req.templateOffset) || 0),
      )
      return { ok: true, items, stats: store.pocStats(), templates, dbPath: store.knowledgePath(), root: store.root }
    }
    if (op === 'pocList') return { ok: true, items: store.searchPocs(req), stats: store.pocStats(), dbPath: store.knowledgePath(), root: store.root }
    if (op === 'templateSearch') return Object.assign({ ok: true }, store.searchTemplates(req.q, Math.min(Number(req.limit) || 40, 200)))
    if (op === 'templateStats') return { ok: true, stats: store.templateStats() }
    if (op === 'pocGet') return Object.assign({ ok: true }, store.getPoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocSave') return Object.assign({ ok: true }, store.savePoc(req.poc || req))
    if (op === 'pocUpdate') return { ok: true, poc: store.updatePoc(req.id !== undefined ? req.id : req.code, req.patch || req) }
    if (op === 'pocDelete') return Object.assign({ ok: true }, store.deletePoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocUse') return Object.assign({ ok: true }, store.markPocUsed(req.id !== undefined ? req.id : req.code, req.used_on))
    if (op === 'pocStats') return { ok: true, stats: store.pocStats() }
    /* Environment tuning: global, target-independent; shared by panel / CLI / tools */
    if (op === 'platformConfigGet') return platformSummary(store.root)
    if (op === 'platformConfigSave') {
      savePlatformConfig(req.config || {}, store.root)
      return platformSummary(store.root)
    }
    if (op === 'platformAssignToolkit') return assignToolkitFolder(req.dir, store.root)
    /**
     * "Who are we waiting on right now": sidebar badge, toast, posture page hero, redteam_attention
     * tool — all four share this one implementation; nobody may write their own sort again.
     *
     * Target resolution order: explicit engagement > session binding > current-target pointer.
     * Session binding precedes the pointer because the sidebar badge always asks for "my session"
     * target; with sessions in parallel there is one pointer, so using it bills others' waits.
     */
    if (op === 'attention') {
      let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
      if (!id && typeof req.session === 'string' && req.session) {
        let root = req.session
        if (typeof req.resolveRoot === 'function') {
          try {
            const resolved = req.resolveRoot(req.session)
            if (typeof resolved === 'string' && resolved) root = resolved
          } catch { /* parse failed: query as-is */ }
        }
        try {
          const bound = store.sessionBinding(root)
          if (bound) id = bound
        } catch { /* no binding table: fall back to the pointer */ }
      }
      if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
      if (!id) return { ok: true, total: 0, awaiting_person: 0, items: [], pending_coverage: 0, note: 'Chưa có mục tiêu' }
      return Object.assign({ ok: true, engagement: id }, store.attentionQueue(id, { limit: req.limit }))
    }
    /**
     * Closing action after one wait is handled. `attentionQueue` only reads facts and cannot judge
     * "has this one been handled already" — that needs a human/main-session nod, hence a separate op.
     */
    if (op === 'attentionAck') {
      let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
      if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
      if (!id) return { ok: false, error: 'Hãy chọn hoặc tạo mục tiêu ở phía trên trước' }
      const out = store.acknowledgeAgentReports(id, {
        session_id: req.session_id, ids: req.ids, all: req.all === true,
      })
      if (out.error) return Object.assign({ ok: false, engagement: id }, out)
      return Object.assign({ ok: true, engagement: id }, out, store.attentionQueue(id, { limit: req.limit }))
    }
    /* No target selected: prompts fall back to built-ins, read-only queries return empty. No throw. */
    let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
    if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
    if (!id) {
      if (op === 'prompts') {
        return {
          ok: true,
          builtin: true,
          roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({
            role, title,
            planner: role === PLANNER_ROLE,
            dispatcher: role !== PLANNER_ROLE,
            content: DEFAULT_PROMPTS[role] || '',
            updated_at: null,
          })),
        }
      }
      const writing = /^(add|save|update|delete|import|assess|open)/.test(op)
      if (writing) return { ok: false, error: 'Hãy chọn hoặc tạo mục tiêu ở phía trên trước' }
      return { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] }
    }

    if (op === 'snapshot') return Object.assign({ ok: true }, store.snapshot(id))
    if (op === 'assets') return Object.assign({ ok: true }, store.listAssets(id, req))
    if (op === 'asset') return { ok: true, asset: store.getAsset(id, req.id) }
    if (op === 'graph') return Object.assign({ ok: true }, store.graph(id, req))
    if (op === 'attackGraph') return Object.assign({ ok: true }, store.attackGraph(id, req))
    if (op === 'stats') return { ok: true, stats: store.stats(id) }
    if (op === 'vulns') return Object.assign({ ok: true, stats: store.vulnStats(id) }, store.listVulns(id, req))
    if (op === 'addVuln') return Object.assign({ ok: true }, store.addVuln(id, req.vuln || req))
    if (op === 'updateVuln') return Object.assign({ ok: true }, store.updateVuln(id, req.id, req.patch || req))
    if (op === 'vulnStats') return { ok: true, stats: store.vulnStats(id) }
    if (op === 'credentials') return { ok: true, items: store.listCredentials(id, req) }
    if (op === 'addCredential') return Object.assign({ ok: true }, store.addCredential(id, req.credential || req))
    if (op === 'access') return { ok: true, items: store.listAccess(id, req) }
    if (op === 'addAccess') return Object.assign({ ok: true }, store.addAccess(id, req.access || req))
    if (op === 'sessions') return Object.assign({ ok: true }, store.sessionSummary(id))
    if (op === 'webshells') return { ok: true, items: store.listWebshells(id, req) }
    if (op === 'addWebshell') return Object.assign({ ok: true }, store.addWebshell(id, req.webshell || req))
    if (op === 'updateWebshell') return Object.assign({ ok: true }, store.updateWebshell(id, req.id, req.patch || req))
    if (op === 'tunnels') return { ok: true, items: store.listTunnels(id, req) }
    if (op === 'shots') return Object.assign({ ok: true }, store.listShots(id, req))
    if (op === 'shotAdd') return Object.assign({ ok: true }, store.addShot(id, req.shot || req))
    if (op === 'shotDelete') return Object.assign({ ok: true }, store.deleteShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'shotData') return Object.assign({ ok: true }, store.readShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'addTunnel') return Object.assign({ ok: true }, store.addTunnel(id, req.tunnel || req))
    if (op === 'updateTunnel') return Object.assign({ ok: true }, store.updateTunnel(id, req.id, req.patch || req))
    if (op === 'domains') return { ok: true, items: store.domainIndex(id, req) }
    if (op === 'web') return Object.assign({ ok: true }, store.listWeb(id, req))
    if (op === 'httpEvidence') return { ok: true, items: store.listHttpEvidence(id, req) }
    if (op === 'addHttpEvidence') return Object.assign({ ok: true }, store.addHttpEvidence(id, req.evidence || req))
    if (op === 'dataProofs') return { ok: true, ...store.listDataProofs(id, req) }
    if (op === 'addDataProof') return { ok: true, ...store.addDataProof(id, req.proof || req) }
    if (op === 'cleanup') return { ok: true, ...store.listCleanup(id, req) }
    if (op === 'addCleanup') return Object.assign({ ok: true }, store.addCleanup(id, req.item || req))
    if (op === 'updateCleanup') return Object.assign({ ok: true }, store.updateCleanup(id, req.item || req))
    if (op === 'chain') return { ok: true, items: store.listChain(id) }
    if (op === 'addChainStep') return Object.assign({ ok: true }, store.addChainStep(id, req.step || req))
    if (op === 'report') return Object.assign({ ok: true }, store.report(id))
    if (op === 'assetTest') return Object.assign({ ok: true }, store.updateAssetTest(id, req.test || req))
    if (op === 'assessAsset') return Object.assign({ ok: true }, store.assessAsset(id, req.assess || req))
    if (op === 'scores') return Object.assign({ ok: true }, store.listScorePoints(id, req))
    if (op === 'saveScorePoint') return Object.assign({ ok: true }, store.saveScorePoint(id, req.point || req))
    if (op === 'deleteScorePoint') return Object.assign({ ok: true }, store.deleteScorePoint(id, req.id))
    if (op === 'addScoreHit') return Object.assign({ ok: true }, store.addScoreHit(id, req.hit || req))
    if (op === 'scoreChain') return Object.assign({ ok: true }, store.scoreChain(id, req))
    if (op === 'scoreReport') return Object.assign({ ok: true }, store.scoreReport(id, req))
    if (op === 'activeTests') return Object.assign({ ok: true }, store.activeTests(id, req))
    if (op === 'testStats') return { ok: true, stats: store.testStats(id) }
    /* Console tab unread pointer (count + last-updated per tab): the panel dots from this */
    if (op === 'consoleDigest') return Object.assign({ ok: true }, store.consoleDigest(id))
    if (op === 'stages') return { ok: true, items: store.listStages(id) }
    if (op === 'saveStage') return Object.assign({ ok: true }, store.saveStage(id, req.stage || req))
    if (op === 'reportTargets') return Object.assign({ ok: true }, store.reportTargets(id, req))
    /* Asset discovery timeline: powers the "discovered at" view and the report appendix */
    if (op === 'discoveryTimeline') return Object.assign({ ok: true }, store.discoveryTimeline(id, req))
    if (op === 'attackFiles') return { ok: true, items: store.attackFileTree(id) }
    if (op === 'addAttackFile') return Object.assign({ ok: true }, store.addAttackFile(id, req.file || req))
    if (op === 'readAttackFile') return Object.assign({ ok: true }, store.readAttackFile(id, req.id))
    if (op === 'import') return Object.assign({ ok: true }, store.importBundle(id, req))
    if (op === 'prompts') return { ok: true, roles: store.listPrompts(id) }
    if (op === 'savePrompt') return Object.assign({ ok: true }, store.savePrompt(id, req.role, req.content))
    if (op === 'resetPrompts') return Object.assign({ ok: true }, store.resetPrompts(id, req.role))
    throw new Error(`unknown op: ${op}`)
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * Async dispatch: adds only `probeSessions` (which really opens network connections); the rest
 * is forwarded to the sync dispatch. Agents are sandboxed and cannot reach out, so probe on host.
 */
export async function dispatchAsync(store, req = {}) {
  if (req.op === 'intelStatus' || req.op === 'intelRefresh' || req.op === 'intelSync'
    || req.op === 'cveSearch' || req.op === 'cveLookup' || req.op === 'templateCatalogStatus') {
    try {
      const out = await intelOps(req.op, req, store.root)
      if (out !== null) return out
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  if (req.op === 'probeSessions') {
    try {
      const id = (typeof req.engagement === 'string' && req.engagement.trim())
        || (typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : '')
      if (!id) return { ok: true, items: [], note: 'Chưa có mục tiêu' }
      const result = await store.probeSessions(id, req)
      return Object.assign({ ok: true }, result)
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  return dispatch(store, req)
}

/* ---------------------------------------------------------------- Service */

/**
 * Read image dimensions (PNG / JPEG / WebP); return `{ width: null, height: null }` if unreadable.
 *
 * Only to label "how big is this image" in panel/report and to keep 0-byte files from being
 * recorded as screenshots — not worth pulling in an image library (this package stays zero-dep).
 *
 * @param buf - image bytes.
 */
function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.slice(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    if (buf.length > 30 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.slice(12, 16).toString('latin1')
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
    }
  } catch { /* unreadable size does not block the record */ }
  return { width: null, height: null }
}

export class RedteamStore {
  /** @param root data root directory (default $DSH_HOME/redteam) */
  constructor(root) {
    this.root = root
    this.engagementsDir = join(root, 'engagements')
    this.handles = new Map()
    mkdirSync(this.engagementsDir, { recursive: true })
  }

  /* ---------- Current target ---------- */
  currentPath() { return join(this.root, 'current') }

  /** Currently effective target id: explicit pointer first, else the most recently created target. */
  activeEngagementId() {
    try {
      const raw = readFileSync(this.currentPath(), 'utf8').trim()
      if (raw && existsSync(this.dbPathOf(raw))) return raw
    } catch { /* no pointer: fall back */ }
    const list = this.listEngagements()
    return list.length ? list[0].id : undefined
  }

  /** Switch the current target (called on UI switch or agent bind). */
  setActiveEngagement(id) {
    if (!id || !existsSync(this.dbPathOf(id))) return false
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.currentPath(), String(id), 'utf8')
    return true
  }

  /* ---------- Session -> target binding ---------- */

  /** Binding-table path on disk: same level as `current`, plain JSON, easy to audit and back up. */
  sessionBindingsPath() { return join(this.root, 'sessions.json') }

  /**
   * Read all session bindings (tolerant: missing file / truncated JSON means "never bound").
   *
   * Shape `{ v: 1, agents: { <root session id>: { engagement, name, at } } }`.
   * Only **root sessions** recorded: sub-agents inherit along the parent chain (caller resolves).
   */
  sessionBindings() {
    let parsed = null
    try { parsed = JSON.parse(readFileSync(this.sessionBindingsPath(), 'utf8')) } catch { parsed = null }
    const agents = parsed && parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {}
    const out = {}
    for (const [key, value] of Object.entries(agents)) {
      if (!value || typeof value !== 'object') continue
      const engagement = typeof value.engagement === 'string' ? value.engagement : ''
      if (!engagement) continue
      out[key] = {
        engagement,
        name: typeof value.name === 'string' && value.name ? value.name : engagement,
        at: typeof value.at === 'string' ? value.at : null,
      }
    }
    return out
  }

  /** Target id bound to a session (undefined if never bound). */
  sessionBinding(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const entry = this.sessionBindings()[sessionId]
    return entry ? entry.engagement : undefined
  }

  /**
   * Write one session binding.
   *
   * Two writers, both writing only the **root session id**:
   *   · agent tools (when redteam_engagement_open / redteam_session_bind resolves a target);
   *   · the console (user switches target in the dropdown).
   *
   * @param sessionId - root session id.
   * @param engagement - target id (directory name).
   * @param name - display name (optional, falls back to the id).
   * @returns write success (skipped if the target is missing, so no dangling binding is left).
   */
  setSessionBinding(sessionId, engagement, name) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    if (typeof engagement !== 'string' || engagement.length === 0) return false
    if (!existsSync(this.dbPathOf(engagement))) return false
    const all = this.sessionBindings()
    all[sessionId] = { engagement, name: typeof name === 'string' && name ? name : engagement, at: nowIso() }
    const pruned = {}
    for (const [key, value] of Object.entries(all).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 200)) {
      if (existsSync(this.dbPathOf(value.engagement))) pruned[key] = value
    }
    mkdirSync(this.root, { recursive: true })
    try {
      writeFileSync(this.sessionBindingsPath(), JSON.stringify({ v: 1, agents: pruned }, null, 2), 'utf8')
    } catch { return false }
    return true
  }

  /* ---------- Paths ---------- */
  dirOf(id) { return join(this.engagementsDir, id) }
  metaPathOf(id) { return join(this.dirOf(id), 'engagement.yaml') }
  dbPathOf(id) { return join(this.dirOf(id), 'assets.db') }
  promptsDirOf(id) { return join(this.dirOf(id), 'agents') }

  /* ---------- DB handles (cached per target, closed together on dispose) ---------- */
  /**
   * Open (or create on demand) the database handle for a target.
   * @param id - target id.
   * @param options - `{ create: true }` allows creating the DB file (used by openEngagement).
   */
  db(id, options = {}) {
    let handle = this.handles.get(id)
    if (handle) return handle
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`)
      mkdirSync(this.dirOf(id), { recursive: true })
    }
    handle = new DatabaseSync(this.dbPathOf(id))
    /* Node builds without FTS5 (e.g. 22.14) must not include the fts5 DDL:
       one `USING fts5` throws and takes the whole DDL down, so even plain tables fail to build.
       Degraded, asset search falls back to LIKE (see the f.q branch in listAssets). */
    handle.exec(HAS_FTS5 ? DDL + ASSET_FTS_DDL : DDL)
    migrate(handle)
    this.handles.set(id, handle)
    return handle
  }

  close() {
    for (const handle of this.handles.values()) {
      try { handle.close() } catch { /* close failure must not block unload */ }
    }
    this.handles.clear()
    if (this.kbHandle) {
      try { this.kbHandle.close() } catch { /* ignore */ }
      this.kbHandle = null
    }
  }

  /* ---------- Target lifecycle ---------- */
  listEngagements() {
    mkdirSync(this.engagementsDir, { recursive: true })
    const out = []
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const meta = readMeta(this.metaPathOf(entry.name)) || {}
      let stats = null
      try {
        if (existsSync(this.dbPathOf(entry.name))) stats = this.stats(entry.name)
      } catch { /* still list targets when the DB is corrupt */ }
      out.push({
        id: entry.name, name: meta.target_name || entry.name,
        scope: meta.scope_cidrs || [], status: meta.status || 'active',
        created_at: meta.created_at || null, stats,
      })
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  /**
   * Open/create a target workspace.
   * @param name - target organisation name (slugified into the directory name and target id).
   * @param scope - authorised CIDR list (optional).
   * @param options - `{ bindCurrent?: boolean }`: also point the global "current target" here.
   *   Defaults to true (UI/CLI semantics); **agent tools pass false** — with sessions in parallel,
   *   letting one session's open swap the global pointer is the direct cause of crossed reports.
   */
  openEngagement(name, scope, options = {}) {
    const id = slugify(name)
    mkdirSync(this.dirOf(id), { recursive: true })
    for (const sub of ['agents', 'runs', 'reports']) mkdirSync(join(this.dirOf(id), sub), { recursive: true })
    const existing = readMeta(this.metaPathOf(id))
    writeMeta(this.metaPathOf(id), {
      target_name: name,
      scope_cidrs: scope || (existing && existing.scope_cidrs) || [],
      status: 'active',
      created_at: (existing && existing.created_at) || nowIso(),
      updated_at: nowIso(),
    })
    this.db(id, { create: true }) // create DB + tables
    this.seedScorePoints(id)
    for (const p of this.listPrompts(id)) {
      if (!p.content) this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] || '')
    }
    if (options.bindCurrent !== false) this.setActiveEngagement(id)
    return { id, name, scope: scope || [] }
  }

  /**
   * Asset discovery timeline: aggregate how many were found per day and what was found recently.
   * The asset-mapping page uses it for "when was this discovered"; the report appendix for closure.
   * @param id - target id.
   * @param f - `{ limit?: number }` number of recent assets (default 50).
   */
  discoveryTimeline(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 50, 500)
    const days = db.prepare(`SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day,
        COUNT(*) AS assets,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'internal' THEN 1 ELSE 0 END) AS internal,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'external' THEN 1 ELSE 0 END) AS external
      FROM asset GROUP BY day ORDER BY day DESC`).all()
    const recent = db.prepare(`SELECT id, ip, segment_cidr, state, primary_name, discovered_at, first_seen, last_seen,
        COALESCE(scope, (${SCOPE_SQL})) AS scope, priority,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = asset.id AND p.state = 'open') AS open_ports
      FROM asset ORDER BY COALESCE(discovered_at, first_seen, '') DESC, id DESC LIMIT ?`).all(limit)
    const span = db.prepare(`SELECT MIN(COALESCE(discovered_at, first_seen)) AS first,
        MAX(COALESCE(discovered_at, first_seen)) AS last, COUNT(*) AS total FROM asset`).get() || {}
    return {
      days: days.map((d) => Object.assign({}, d, { day: d.day || '(thời điểm không rõ)' })),
      recent,
      span: { first: span.first || null, last: span.last || null, total: span.total || 0 },
    }
  }

  /* ---------- Statistics / queries ---------- */
  stats(id) {
    const db = this.db(id)
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
    return {
      segments: one('SELECT COUNT(*) FROM segment'),
      assets: one('SELECT COUNT(*) FROM asset'),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one('SELECT COUNT(*) FROM service'),
      fingerprints: one('SELECT COUNT(*) FROM fingerprint'),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one('SELECT COUNT(*) FROM vuln'),
      credentials: one('SELECT COUNT(*) FROM credential'),
      accesses: one('SELECT COUNT(*) FROM access_session'),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    }
  }

  /**
   * Console "unread" summary: a light per-tab pointer of "count + time of the latest row".
   *
   * Panel diffs it against the last-seen state: new count or newer timestamp marks the tab.
   * Opening the tab marks it read. **Read-only, just counting** — no heavy work here.
   */
  consoleDigest(id) {
    const db = this.db(id)
    const count = (sql) => {
      try { return Number(db.prepare(sql).get()?.n ?? 0) || 0 } catch { return 0 }
    }
    const at = (sql) => {
      try { return db.prepare(sql).get()?.t ?? null } catch { return null }
    }
    const maxOf = (a, b) => (a === null ? b : (b === null ? a : (a > b ? a : b)))
    /* The knowledge base is a separate DB shared across targets: treat unreadable as 0 */
    let kb = { count: 0, at: null }
    try {
      const k = this.kb()
      kb = {
        count: Number(k.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0),
        at: k.prepare('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM poc').get()?.t ?? null,
      }
    } catch { /* knowledge base not created yet: treat as no updates */ }
    const hits = 'SELECT COUNT(*) AS n FROM score_hit'
    const hitsAt = 'SELECT MAX(recorded_at) AS t FROM score_hit'
    const steps = 'SELECT COUNT(*) AS n FROM attack_step'
    const stepsAt = 'SELECT MAX(recorded_at) AS t FROM attack_step'
    const sections = {
      assets: {
        count: count('SELECT COUNT(*) AS n FROM asset'),
        at: at('SELECT MAX(COALESCE(discovered_at, first_seen, last_seen)) AS t FROM asset'),
      },
      testing: {
        count: count("SELECT COUNT(*) AS n FROM asset WHERE COALESCE(test_status, 'untested') <> 'untested'"),
        at: at('SELECT MAX(test_updated_at) AS t FROM asset'),
      },
      /* The "agents" tab is about who is executing: use the latest attack-step action as pointer */
      agents: { count: count(steps), at: at(stepsAt) },
      sessions: {
        count: count('SELECT COUNT(*) AS n FROM webshell') + count('SELECT COUNT(*) AS n FROM tunnel'),
        at: maxOf(
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM webshell'),
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM tunnel'),
        ),
      },
      findings: {
        count: count('SELECT COUNT(*) AS n FROM vuln'),
        at: at('SELECT MAX(found_at) AS t FROM vuln'),
      },
      chain: { count: count(steps), at: at(stepsAt) },
      scores: { count: count(hits), at: at(hitsAt) },
      report: { count: count(hits), at: at(hitsAt) },
      attackfiles: {
        count: count('SELECT COUNT(*) AS n FROM attack_file'),
        at: at('SELECT MAX(created_at) AS t FROM attack_file'),
      },
      artifacts: {
        count: count('SELECT COUNT(*) AS n FROM attack_file')
          + count('SELECT COUNT(*) AS n FROM credential')
          + count('SELECT COUNT(*) AS n FROM access_session'),
        at: maxOf(
          at('SELECT MAX(created_at) AS t FROM attack_file'),
          maxOf(
            at('SELECT MAX(found_at) AS t FROM credential'),
            at('SELECT MAX(obtained_at) AS t FROM access_session'),
          ),
        ),
      },
      overview: { count: count(hits), at: at(hitsAt) },
      env: { count: 0, at: null },
      knowledge: kb,
      /* Prompts and skill library ship as static content: no "new entries", so never dot */
      prompts: { count: 0, at: null },
      skills: { count: 0, at: null },
    }
    return { engagement: id, at: nowIso(), sections }
  }

  snapshot(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    return {
      engagement: {
        id, name: meta.target_name || id, scope: meta.scope_cidrs || [],
        status: meta.status || 'active', created_at: meta.created_at || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    }
  }

  listSegments(id) {
    const rows = this.db(id).prepare(`
      SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`).all()
    /* C segments are internal/external too: judged by the segment's start address */
    return rows.map((r) => Object.assign({}, r, { scope: scopeOfIp(String(r.cidr || '').split('/')[0]) }))
  }

  /**
   * Fetch ports / fingerprints / names for a batch of assets **in one go**, grouped by asset_id.
   *
   * Why: assetRow used to run 3 queries per asset, and the asset list defaults to limit=400 —
   * one list request meant 1200 SQL statements, and the panel re-queries on every filter change.
   * Now 3 `IN (...)` queries, cost **independent of the asset count**.
   *
   * @param db - target DB handle.
   * @param ids - asset id array (empty array returns an empty Map).
   * @returns `{ ports, fingerprints, names }`: three `Map<assetId, rows[]>`
   */
  assetChildren(db, ids = []) {
    const ports = new Map()
    const fingerprints = new Map()
    const names = new Map()
    const list = Array.from(new Set(ids.filter((x) => x !== null && x !== undefined))).map(Number)
    if (list.length === 0) return { ports, fingerprints, names }
    const ph = list.map(() => '?').join(',')
    for (const row of db.prepare(`SELECT p.asset_id, p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id IN (${ph}) ORDER BY p.asset_id, p.port`).all(...list)) {
      const key = Number(row.asset_id)
      if (!ports.has(key)) ports.set(key, [])
      ports.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, category, vendor, product, version, evidence, provenance
      FROM fingerprint WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!fingerprints.has(key)) fingerprints.set(key, [])
      fingerprints.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, name, kind, provenance
      FROM asset_name WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!names.has(key)) names.set(key, [])
      names.get(key).push(row)
    }
    return { ports, fingerprints, names }
  }

  /**
   * Single asset -> row structure.
   * @param db - target DB handle.
   * @param a - a row from the asset table.
   * @param children - optional: prefetched assetChildren() result. **Passed = zero extra queries**;
   *                   omitted falls back to per-asset queries (detail page calls it once, N+1 is fine).
   */
  assetRow(db, a, children = null) {
    let ports
    let fingerprints
    let names
    if (children !== null) {
      const key = Number(a.id)
      ports = children.ports.get(key) || []
      fingerprints = children.fingerprints.get(key) || []
      names = children.names.get(key) || []
    } else {
      ports = db.prepare(`SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
          s.name AS service, s.product, s.version
        FROM port p LEFT JOIN service s ON s.port_id = p.id
        WHERE p.asset_id = ? ORDER BY p.port`).all(a.id)
      fingerprints = db.prepare('SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?').all(a.id)
      names = db.prepare('SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?').all(a.id)
    }
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, state: a.state,
      primary_name: a.primary_name, first_seen: a.first_seen, last_seen: a.last_seen,
      discovered_at: a.discovered_at || a.first_seen || null,
      test_status: a.test_status || 'untested', test_notes: a.test_notes || '',
      test_surface: a.test_surface || '', test_updated_at: a.test_updated_at || null,
      test_updated_by: a.test_updated_by || null, blocked_count: a.blocked_count || 0,
      priority: a.priority || null, potential: a.potential || '', assess_reason: a.assess_reason || '',
      assessed_at: a.assessed_at || null, assessed_by: a.assessed_by || null,
      scope: a.scope || scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === 'open').length,
      ports, fingerprints, names,
      passive: ports.filter((p) => p.provenance === 'passive').length,
      active: ports.filter((p) => p.provenance === 'active').length,
    }
  }


  listAssets(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.state) { where.push('a.state = ?'); args.push(f.state) }
    if (f.ip) { where.push('a.ip = ?'); args.push(f.ip) }
    if (f.port) { where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)'); args.push(Number(f.port)) }
    if (f.service) {
      where.push('EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))')
      args.push(`%${f.service}%`, `%${f.service}%`)
    }
    if (f.fingerprint) {
      where.push('EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))')
      args.push(`%${f.fingerprint}%`, `%${f.fingerprint}%`, `%${f.fingerprint}%`)
    }
    if (f.provenance) {
      where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)')
      args.push(f.provenance)
    }
    if (f.priority) {
      where.push('a.priority = ?')
      args.push(f.priority)
    }
    if (f.test_status) {
      /* Multi-value support: test_status=abandoned,blocked */
      const list = String(f.test_status).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?")
        args.push(f.test_status)
      }
    }
    /* Internal/external dimension: internal | external (backfilled by migration on old data) */
    if (f.scope) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`)
      args.push(f.scope)
    }
    if (f.q) {
      const terms = String(f.q).split(/\s+/).filter(Boolean)
      if (terms.length) {
        if (HAS_FTS5) {
          /* The primary domain (asset.primary_name) is **not** in the asset_fts index (that table
             holds only ip / names / banners / titles / fingerprints), so MATCH alone misses it —
             e.g. searching "portal.example.test" returns 0 rows. We fold in LIKE to cover it,
             which also covers cases LIKE matches but FTS tokenisation does not. */
          where.push('(a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)'
            + ' OR a.primary_name LIKE ?)')
          args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND '), '%' + String(f.q) + '%')
        } else {
          /* Node builds without FTS5: degrade to substring matching.
             Weaker than FTS (no prefix/stem splitting, LIKE is ASCII case-insensitive only),
             but **search never errors and content is still findable** — far better than "the whole
             panel won't open". Same search surface as #reindex feeds asset_fts:
             asset IP / primary domain + asset_name + port.banner/title/url + service + fingerprint. */
          const sub = [
            'EXISTS(SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND n.name LIKE ?)',
            'EXISTS(SELECT 1 FROM port p WHERE p.asset_id = a.id AND (p.banner LIKE ? OR p.title LIKE ? OR p.url LIKE ?))',
            'EXISTS(SELECT 1 FROM service s JOIN port p2 ON p2.id = s.port_id WHERE p2.asset_id = a.id'
              + ' AND (s.name LIKE ? OR s.product LIKE ? OR s.version LIKE ?))',
            'EXISTS(SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id'
              + ' AND (f.vendor LIKE ? OR f.product LIKE ? OR f.version LIKE ? OR f.category LIKE ?))',
          ]
          const binds = (t) => ['%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%']
          for (const t of terms) {
            where.push('(a.ip LIKE ? OR a.primary_name LIKE ? OR ' + sub.join(' OR ') + ')')
            args.push('%' + t + '%', '%' + t + '%', ...binds(t))
          }
        }
      }
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...args).n
    const limit = Math.min(Number(f.limit) || 200, 2000)
    const offset = Number(f.offset) || 0
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)"
    /* Sorting: default "most worth hitting first" — easy targets -> untested -> many ports; sort=ip / sort=ports switchable */
    const sort = f.sort || 'priority'
    let orderBy = 'a.ip_int'
    if (sort === 'ports') orderBy = `${openPorts} DESC, a.ip_int`
    /* Newest discovery first: freshly collected assets on top ("what just showed up" is clearest) */
    else if (sort === 'discovered') orderBy = `COALESCE(a.discovered_at, a.first_seen, '') DESC, a.id DESC`
    else if (sort === 'todo') {
      /* Untested first: whatever can still be hit this round floats up; tested/abandoned sink */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`
    } else if (sort === 'priority') {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`
    }
    const rows = db.prepare(`SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    /* Prefetch once, assemble per row: compresses 3N queries into 3 (default N is at most 400) */
    const children = this.assetChildren(db, rows.map((r) => r.id))
    return { total, sort, items: rows.map((r) => this.assetRow(db, r, children)) }
  }

  getAsset(id, assetId) {
    const db = this.db(id)
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(assetId))
    if (!a) return undefined
    const detail = this.assetRow(db, a)
    detail.observations = db.prepare(`SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC LIMIT 200`).all(a.id)
    detail.edges = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`).all(String(a.id), String(a.id))
    return detail
  }


  /* ---------- Coverage: external deep-dive / internal host expansion ----------
     The core of 0.15.8: make "close after one hit" and "ship after a bulk scan" structurally
     impossible — close validates every item, rejects on any gap, and only an empty queue is done.
     Queue reads are pure computation (no network, no reachability) and only answer "what's left". */

  #ensureCoverage(db, assetId) {
    db.prepare('INSERT OR IGNORE INTO host_coverage(asset_id) VALUES(?)').run(Number(assetId))
    return db.prepare('SELECT * FROM host_coverage WHERE asset_id = ?').get(Number(assetId))
  }

  /** Host privilege is derived from registered access_sessions (a credential alone is not access). */
  #assetAccess(db, asset) {
    const like = String(asset.ip) + ':%'
    const rows = db.prepare('SELECT username, method, privilege FROM access_session ' +
      'WHERE asset_id = ? OR host = ? OR host LIKE ? ORDER BY id DESC LIMIT 20').all(asset.id, asset.ip, like)
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential ' +
      'WHERE asset_id = ? OR host = ? OR host LIKE ?').get(asset.id, asset.ip, like).n
    if (rows.length === 0) return { access: 'none', credentials: Number(creds) || 0 }
    const best = rows.find((r) => /root|system|admin|管理员/i.test(String(r.privilege || ''))) || rows[0]
    return {
      access: String(best.privilege || best.method || 'user'),
      credentials: Math.max(Number(creds) || 0, rows.filter((r) => String(r.username || '').trim() !== '').length),
    }
  }

  /** Score-point codes already recorded on this asset (self-registered accounts excluded). */
  #scoreCodesOfAsset(db, assetId) {
    return new Set(db.prepare('SELECT DISTINCT sp.code FROM score_hit sh ' +
      'JOIN score_point sp ON sp.id = sh.point_id ' +
      'WHERE sh.asset_id = ? AND COALESCE(sh.self_created, 0) = 0').all(Number(assetId)).map((r) => String(r.code)))
  }

  /* ---------- Internal hosts: files/credentials/privesc/Web/DB/lateral ---------- */

  /** Read (initialising if needed) a host's coverage; access/credentials derive from registrations. */
  getHostCoverage(id, assetId) {
    const db = this.db(id)
    const asset = this.getAsset(id, assetId)
    if (asset === undefined) throw new Error('asset not found')
    const row = this.#ensureCoverage(db, asset.id)
    const derived = this.#assetAccess(db, asset)
    return {
      ...row,
      access: row.access && row.access !== 'none' ? row.access : derived.access,
      credentials: Math.max(Number(row.credentials) || 0, derived.credentials),
      open_ports: asset.open_ports || 0,
      asset: { id: asset.id, ip: asset.ip, primary_name: asset.primary_name, scope: asset.scope, priority: asset.priority, potential: asset.potential },
      findings: db.prepare('SELECT * FROM host_finding WHERE asset_id = ? ORDER BY id DESC LIMIT 100').all(asset.id),
    }
  }

  updateHostCoverage(id, assetId, patch = {}, actor = null) {
    const db = this.db(id)
    const row = this.#ensureCoverage(db, assetId)
    const fields = ['access', 'files', 'privesc', 'web', 'db', 'lateral', 'status', 'blocked_reason']
    const sets = []
    const args = []
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) { sets.push(f + ' = ?'); args.push(patch[f] ?? null) }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'credentials')) {
      const n = Number(patch.credentials)
      if (!Number.isFinite(n) || n < 0) throw new Error('credentials phải là số không âm')
      sets.push('credentials = ?'); args.push(n)
    }
    if (sets.length === 0) return this.getHostCoverage(id, assetId)
    sets.push('updated_by = ?', 'updated_at = ?')
    args.push(actor ?? null, nowIso(), row.asset_id)
    db.prepare('UPDATE host_coverage SET ' + sets.join(', ') + ' WHERE asset_id = ?').run(...args)
    return this.getHostCoverage(id, assetId)
  }

  /** Record one structured host finding and move its item from untested to partial. */
  addHostFinding(id, f = {}) {
    const db = this.db(id)
    const asset = this.getAsset(id, f.asset_id)
    if (asset === undefined) throw new Error('asset not found')
    const kind = String(f.kind || '').trim()
    const kinds = ['file', 'credential', 'privesc', 'lateral', 'web', 'db', 'config', 'share']
    if (!kinds.includes(kind)) throw new Error('host finding kind phải là ' + kinds.join('/'))
    db.prepare('INSERT INTO host_finding(asset_id, kind, title, detail, evidence_ref, created_by, created_at) ' +
      'VALUES(?,?,?,?,?,?,?)').run(asset.id, kind, f.title ?? null, f.detail ?? null, f.evidence_ref ?? null, f.created_by ?? null, nowIso())
    const row = this.#ensureCoverage(db, asset.id)
    const partial = (v) => (v === 'untested' || v === null || v === undefined ? 'partial' : v)
    const patch = {}
    if (kind === 'file' || kind === 'config' || kind === 'share') patch.files = partial(row.files)
    if (kind === 'privesc') patch.privesc = partial(row.privesc)
    if (kind === 'lateral') patch.lateral = partial(row.lateral)
    if (kind === 'web') patch.web = partial(row.web)
    if (kind === 'db') patch.db = partial(row.db)
    if (kind === 'credential') patch.credentials = Math.max(Number(row.credentials) || 0, 0) + 1
    const findingId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
    return { finding_id: findingId, coverage: this.updateHostCoverage(id, asset.id, patch, f.created_by) }
  }

  /** Host closure: files/privesc/Web/DB/lateral must all be done|blocked|not_applicable; no access requires a reason. */
  closeHostCoverage(id, assetId, opts = {}) {
    const coverage = this.getHostCoverage(id, assetId)
    const status = opts.status === 'blocked' ? 'blocked' : 'closed'
    const reason = String(opts.reason || '').trim()
    if (coverage.access === 'none') {
      if (reason === '') throw new Error('Không có quyền máy chủ, khi đóng bắt buộc phải ghi blocked_reason (ví dụ "không có lối vào / xác thực thất bại / không có lỗ hổng khả dụng")')
      return this.updateHostCoverage(id, assetId, { status: 'blocked', blocked_reason: reason }, opts.actor)
    }
    const okValues = new Set(['done', 'blocked', 'not_applicable'])
    const missing = ['files', 'privesc', 'web', 'db', 'lateral'].filter((k) => !okValues.has(String(coverage[k] || '')))
    if (status === 'closed' && missing.length > 0) {
      throw new Error('Tài sản chưa đóng đầy đủ, còn thiếu: ' + missing.join(' / ') + '. Hãy dùng redteam_host op=update đánh dấu done/blocked/not_applicable rồi mới đóng; đừng đánh một điểm là kết thúc.')
    }
    if (reason === '' && status === 'blocked') throw new Error('blocked bắt buộc phải ghi reason')
    return this.updateHostCoverage(id, assetId, { status, blocked_reason: reason || null }, opts.actor)
  }

  /** Internal next-action queue: what's missing by asset/service/score. Direction only, never auto-exploits. */
  hostNextActions(id, opts = {}) {
    const db = this.db(id)
    const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 30)
    const where = []
    const args = []
    if (opts.assetId !== undefined && opts.assetId !== null) { where.push('a.id = ?'); args.push(Number(opts.assetId)) }
    where.push("COALESCE(a.scope, (" + SCOPE_SQL + ")) = 'internal'")
    const rows = db.prepare('SELECT * FROM asset a WHERE ' + where.join(' AND ') +
      " ORDER BY COALESCE(a.priority, 'medium') DESC, a.id ASC LIMIT 300").all(...args)
    const actions = []
    const expected = { 'web-app': '50/100', 'server-host': '10/50', 'db-credential': '10/50', 'file-storage': '10/50', 'central-system': '50/500' }
    const isWeb = (p) => {
      const text = String(p.service || '') + ' ' + String(p.product || '')
      return /http|web|nginx|apache|tomcat|iis|weblogic|jboss|jetty/i.test(text)
        || [80, 443, 8000, 8080, 8443, 8888, 7001, 9090].includes(Number(p.port))
    }
    const isDb = (p) => [1433, 1521, 3306, 5432, 6379, 9200, 27017, 11211, 9042].includes(Number(p.port))
      || /mysql|postgres|mssql|oracle|redis|mongo|elastic|memcached/i.test(String(p.service || '') + ' ' + String(p.product || ''))
    const isStorage = (p) => [21, 139, 445, 873, 2049, 9000, 9001].includes(Number(p.port))
      || /minio|s3|smb|ftp|nfs/i.test(String(p.service || '') + ' ' + String(p.product || ''))
    for (const a of rows) {
      const coverage = this.getHostCoverage(id, a.id)
      const codes = this.#scoreCodesOfAsset(db, a.id)
      const ports = (this.getAsset(id, a.id).ports || []).filter((p) => p.state === 'open')
      const add = (kind, target, reason, code) => actions.push({
        asset_id: a.id, asset_ip: a.ip, kind, target, reason,
        expected_points: expected[code] || null, evidence_needed: code || null,
        priority: coverage.access !== 'none' ? 0 : 1,
      })
      if (coverage.access !== 'none') {
        if (!codes.has('server-host')) add('host-privesc', a.ip, 'Đã có quyền truy cập máy chủ nhưng chưa ghi server-host; xác nhận quyền thường/quản trị trước', 'server-host')
        if (!['done', 'blocked', 'not_applicable'].includes(String(coverage.files))) add('file-review', a.ip, 'Tệp/cấu hình/lịch sử lệnh trên máy chủ chưa được kiểm tra có cấu trúc', 'file')
        if (!['done', 'blocked', 'not_applicable'].includes(String(coverage.privesc))) add('privesc', a.ip, 'Chưa xác nhận đường nâng quyền (sudo/SUID/dịch vụ/kernel/cấu hình)', 'server-host')
        if (Number(coverage.credentials) > 0 && !['done', 'blocked', 'not_applicable'].includes(String(coverage.lateral))) add('credential-reuse', a.ip, 'Máy này đã có thông tin xác thực nhưng chưa thử tái dùng/di chuyển ngang', 'lateral')
      }
      for (const p of ports) {
        const target = p.url || (a.ip + ':' + p.port)
        if (isStorage(p)) {
          if (!codes.has('file-storage')) add('file-storage', target, 'Phát hiện dịch vụ lưu trữ tệp/đối tượng, chưa lấy được tài khoản/AK-SK', 'file-storage')
        } else if (isDb(p)) {
          if (!codes.has('db-credential')) add('db-credential', target, 'Phát hiện dịch vụ cơ sở dữ liệu, chưa xác minh tài khoản/chưa cấp quyền', 'db-credential')
        } else if (isWeb(p)) {
          if (!codes.has('web-app')) add('web-app', target, 'Phát hiện dịch vụ Web, chưa lấy được đăng nhập hợp lệ', 'web-app')
        }
      }
    }
    actions.sort((x, y) => x.priority - y.priority || String(x.asset_ip).localeCompare(String(y.asset_ip)))
    const seen = new Set()
    const unique = actions.filter((x) => {
      const k = x.asset_id + '|' + x.kind + '|' + x.target
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).slice(0, limit)
    return { total: unique.length, actions: unique }
  }

  /* ---------- External assets: surface/web/auth/cve/app five-part deep dive ---------- */

  #ensureAssetCoverage(db, assetId) {
    db.prepare('INSERT OR IGNORE INTO asset_coverage(asset_id) VALUES(?)').run(Number(assetId))
    return db.prepare('SELECT * FROM asset_coverage WHERE asset_id = ?').get(Number(assetId))
  }

  getAssetCoverage(id, assetId) {
    const db = this.db(id)
    const asset = this.getAsset(id, assetId)
    if (asset === undefined) throw new Error('asset not found')
    const row = this.#ensureAssetCoverage(db, asset.id)
    const vulns = db.prepare('SELECT status, COUNT(*) AS n FROM vuln WHERE asset_id = ? GROUP BY status').all(asset.id)
    const count = (st) => Number((vulns.find((v) => v.status === st) || {}).n || 0)
    return {
      ...row,
      asset: {
        id: asset.id, ip: asset.ip, primary_name: asset.primary_name, priority: asset.priority,
        potential: asset.potential, scope: asset.scope, state: asset.state, ports: asset.ports,
      },
      candidates: count('candidate'), confirmed: count('confirmed'), exploited: count('exploited'),
      complete: row.status === 'closed' || row.status === 'blocked',
    }
  }

  updateAssetCoverage(id, assetId, patch = {}, actor = null) {
    const db = this.db(id)
    const row = this.#ensureAssetCoverage(db, assetId)
    const sets = []
    const args = []
    for (const f of ['surface', 'web', 'auth', 'cve', 'app', 'blocked_reason', 'note']) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) { sets.push(f + ' = ?'); args.push(patch[f] ?? null) }
    }
    if (sets.length === 0) return this.getAssetCoverage(id, assetId)
    sets.push('updated_by = ?', 'updated_at = ?')
    args.push(actor ?? null, nowIso(), row.asset_id)
    db.prepare('UPDATE asset_coverage SET ' + sets.join(', ') + ' WHERE asset_id = ?').run(...args)
    return this.getAssetCoverage(id, assetId)
  }

  closeAssetCoverage(id, assetId, opts = {}) {
    const coverage = this.getAssetCoverage(id, assetId)
    const status = opts.status === 'blocked' ? 'blocked' : 'closed'
    const reason = String(opts.reason || '').trim()
    if (status === 'blocked' && reason === '') throw new Error('blocked bắt buộc phải ghi reason')
    if (status === 'closed') {
      const okValues = new Set(['done', 'blocked', 'not_applicable'])
      const missing = ['surface', 'web', 'auth', 'cve', 'app'].filter((k) => !okValues.has(String(coverage[k] || '')))
      if (missing.length > 0) {
        throw new Error('Tài sản chưa được đào sâu xong, còn thiếu: ' + missing.join(' / ') + '. Hãy dùng redteam_asset op=update đánh dấu done/blocked/not_applicable rồi mới đóng; đừng quét hàng loạt xong là nộp.')
      }
    }
    const db = this.db(id)
    db.prepare('UPDATE asset_coverage SET status = ?, blocked_reason = ?, updated_by = ?, updated_at = ? WHERE asset_id = ?')
      .run(status, reason || null, opts.actor ?? null, nowIso(), Number(assetId))
    return this.getAssetCoverage(id, assetId)
  }

  /** External single-asset deep-dive queue: only assets not yet closed, with their missing checks. */
  assetNextActions(id, opts = {}) {
    const db = this.db(id)
    const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 30)
    const where = ["COALESCE(a.scope, (" + SCOPE_SQL + ")) = 'external'"]
    const args = []
    if (opts.assetId !== undefined && opts.assetId !== null) { where.push('a.id = ?'); args.push(Number(opts.assetId)) }
    const rows = db.prepare('SELECT * FROM asset a WHERE ' + where.join(' AND ') +
      " AND COALESCE(a.state, 'live') != 'dead'" +
      " ORDER BY CASE COALESCE(a.priority,'medium') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id ASC LIMIT 200").all(...args)
    const okValues = new Set(['done', 'blocked', 'not_applicable'])
    const actions = []
    for (const a of rows) {
      const c = this.getAssetCoverage(id, a.id)
      if (c.status === 'closed' || c.status === 'blocked') continue
      const missing = ['surface', 'web', 'auth', 'cve', 'app'].filter((k) => !okValues.has(String(c[k] || 'untested')))
      if (missing.length === 0) continue
      const ports = (c.asset.ports || []).filter((p) => p.state === 'open')
      actions.push({
        asset_id: a.id, asset_ip: a.ip, primary_name: a.primary_name,
        priority: a.priority || 'medium', missing,
        ports: ports.slice(0, 20).map((p) => ({ port: p.port, service: p.service, product: p.product, version: p.version, url: p.url, title: p.title })),
        reason: 'Đào sâu một tài sản chưa hoàn tất: ' + missing.join('/'),
      })
    }
    return { total: actions.length, actions: actions.slice(0, limit) }
  }

  /* ---------- Structured reporting (prototype Report vocabulary) ---------- */

  /**
   * Pull the `redteamReport: {...}` line out of a sub-agent's report body.
   *
   * Why parse in code rather than prompt for it: the prototype judges who we wait on from
   * structured facts; guessing from prose is exactly what it rejects (001's Rejected concepts).
   * Parse failure returns null — no guessing, no fallback; the panel treats it as unstructured.
   *
   * Accepts two syntaxes (the prompt writes the first, models often write the second):
   *   redteamReport: { status: waiting, blocked_reason: "...", needs: [...] }
   *   redteamReport: { "status": "waiting", ... }
   */
  parseAgentReport(text) {
    const raw = String(text ?? '')
    const at = raw.lastIndexOf('redteamReport')
    if (at < 0) return null
    const tail = raw.slice(at + 'redteamReport'.length)
    const brace = tail.indexOf('{')
    if (brace < 0) return null
    /* Slice only to the matching closing brace: the body may contain other JSON */
    let depth = 0
    let end = -1
    for (let i = brace; i < tail.length; i += 1) {
      const ch = tail[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) return null
    const body = tail.slice(brace, end + 1)
    let obj = null
    try { obj = JSON.parse(body) } catch {
      /* Models often write pseudo-JSON like `{ status: waiting }`: keys and bare values unquoted.
         If strict parsing fails, degrade to field extraction, accept only these keys, else null. */
      obj = {}
      const field = (key) => {
        const m = body.match(new RegExp('["\']?' + key + '["\']?\\s*:\\s*(?:"([^"]*)"|\'([^\']*)\'|([^,}\\]]+))', 'i'))
        if (!m) return undefined
        return (m[1] ?? m[2] ?? m[3] ?? '').trim()
      }
      const status = field('status')
      if (status !== undefined) obj.status = status
      const reason = field('blocked_reason')
      if (reason !== undefined) obj.blocked_reason = reason
      const needsText = field('needs')
      if (needsText !== undefined) {
        /* needs may be an array literal or plain prose; parse as array when possible, else one string */
        const arrAt = body.search(/["']?needs["']?\s*:\s*\[/i)
        let parsedNeeds
        if (arrAt >= 0) {
          const open = body.indexOf('[', arrAt)
          let depth = 0
          for (let i = open; i < body.length; i += 1) {
            if (body[i] === '[') depth += 1
            else if (body[i] === ']') {
              depth -= 1
              if (depth === 0) {
                try { parsedNeeds = JSON.parse(body.slice(open, i + 1)) } catch { parsedNeeds = undefined }
                break
              }
            }
          }
        }
        obj.needs = Array.isArray(parsedNeeds) ? parsedNeeds : needsText
      }
      const taskRef = field('team_task_id') ?? field('task_id')
      if (taskRef !== undefined) obj.team_task_id = taskRef
      if (obj.status === undefined) return null
    }
    if (!obj || typeof obj !== 'object') return null
    const statuses = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']
    const status = String(obj.status || '').trim().toLowerCase()
    if (!statuses.includes(status)) return null
    const needs = Array.isArray(obj.needs)
      ? obj.needs.map((n) => {
        if (typeof n === 'string') return { kind: 'other', detail: n }
        if (n && typeof n === 'object') return { kind: String(n.kind || 'other'), detail: String(n.detail || n.value || '') }
        return null
      }).filter(Boolean)
      : (typeof obj.needs === 'string' && obj.needs.trim() !== '' ? [{ kind: 'other', detail: obj.needs.trim() }] : [])
    return {
      status,
      blocked_reason: obj.blocked_reason === undefined || obj.blocked_reason === null ? '' : String(obj.blocked_reason),
      needs,
      team_task_id: typeof (obj.team_task_id ?? obj.task_id) === 'string'
        ? (obj.team_task_id ?? obj.task_id).trim() || undefined : undefined,
    }
  }

  /** Record one report (target DB, same DB as coverage). Keep only the latest 20 per session. */
  recordAgentReport(id, f = {}) {
    const sessionId = String(f.session_id || '').trim()
    if (sessionId === '') throw new Error('recordAgentReport: session_id là bắt buộc')
    const db = this.db(id)
    const status = String(f.status || '').trim()
    const statuses = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']
    if (!statuses.includes(status)) throw new Error('agent report status phải là ' + statuses.join('/'))
    db.prepare('INSERT INTO agent_report(session_id, parent_session, role, label, status, blocked_reason, needs, summary, team_task_id, created_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      sessionId,
      f.parent_session === undefined || f.parent_session === null ? null : String(f.parent_session),
      f.role ?? null,
      f.label ?? null,
      status,
      f.blocked_reason ? String(f.blocked_reason) : null,
      Array.isArray(f.needs) && f.needs.length ? JSON.stringify(f.needs) : null,
      f.summary === undefined || f.summary === null ? null : String(f.summary).slice(0, 2000),
      typeof f.team_task_id === 'string' ? f.team_task_id.trim() || null : null,
      nowIso(),
    )
    const reportId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
    /* Keep only the latest 20 reports per session, so long sessions don't bloat the DB */
    db.prepare('DELETE FROM agent_report WHERE session_id = ? AND id NOT IN (SELECT id FROM agent_report WHERE session_id = ? ORDER BY id DESC LIMIT 20)')
      .run(sessionId, sessionId)
    return { id: reportId, session_id: sessionId, status }
  }

  /**
   * Remove a report from "someone is waiting".
   *
   * Three forms, all scoped to **a session's latest row only**, never touching history:
   *   { session_id } — I (main session / human) already handled this one (answered, reassigned);
   *   { ids: [...] } — remove exactly by row id;
   *   { all: true } — close the whole queue (e.g. "this batch is all handled").
   *
   * Not removing is structurally bad: `attentionQueue` faithfully returns the latest report, so the
   * same `waiting` is recounted every round, the prompt is regenerated byte-identical, the caller
   * sees no length change and sends again — that is the root cause of the message looping in chat.
   */
  acknowledgeAgentReports(id, opts = {}) {
    const db = this.db(id)
    const at = nowIso()
    const ids = Array.isArray(opts.ids)
      ? opts.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      : []
    if (ids.length > 0) {
      const stmt = db.prepare('UPDATE agent_report SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL')
      let changed = 0
      for (const n of ids) changed += Number(stmt.run(at, n).changes) || 0
      return { acknowledged: changed, at }
    }
    const sessionId = typeof opts.session_id === 'string' ? opts.session_id.trim() : ''
    if (sessionId !== '') {
      const row = db.prepare('SELECT id FROM agent_report WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId)
      if (!row) return { acknowledged: 0, at }
      const changed = Number(db.prepare('UPDATE agent_report SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL').run(at, row.id).changes) || 0
      return { acknowledged: changed, at }
    }
    if (opts.all === true) {
      const changed = Number(db.prepare('UPDATE agent_report SET acknowledged_at = ? WHERE acknowledged_at IS NULL').run(at).changes) || 0
      return { acknowledged: changed, at }
    }
    return { acknowledged: 0, at, error: 'Cần một trong session_id / ids / all' }
  }

  /** Latest report under a parent session; the task board can use byTask for per-subtask latest. */
  latestAgentReports(id, parentSession, opts = {}) {
    const db = this.db(id)
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
    const group = opts.byTask === true ? "session_id, COALESCE(team_task_id, '')" : 'session_id'
    const rows = db.prepare(
      'SELECT r.* FROM agent_report r ' +
      'JOIN (SELECT MAX(id) AS max_id FROM agent_report WHERE parent_session = ? GROUP BY ' + group + ') m ' +
      'ON m.max_id = r.id ORDER BY r.id DESC LIMIT ?').all(String(parentSession), limit)
    return rows.map((r) => ({
      ...r,
      needs: (() => { try { return r.needs ? JSON.parse(r.needs) : [] } catch { return [] } })(),
    }))
  }

  /**
   * "What is this exercise stuck on right now" — the prototype's Ticket stage table, first match wins.
   *
   * Order: waiting for an answer > waiting for acceptance > blocked/failed > running > queued > idle.
   * Every awaiting entry returned carries `needs`, so the main session can ask the user for
   * everything at once instead of making them read three reports and stitch it together.
   *
   * Only **unhandled** reports count (`acknowledged_at IS NULL`). Once confirmed handled it must never
   * return to "someone is waiting": otherwise the queue never empties and every round recounts it.
   */
  attentionQueue(id, opts = {}) {
    const db = this.db(id)
    const reports = (() => {
      try {
        return db.prepare('SELECT * FROM agent_report ORDER BY session_id, id DESC').all()
      } catch { return [] }
    })()
    /* Take the latest row per session; a handled row doesn't count at all */
    const latest = new Map()
    for (const r of reports) if (!latest.has(r.session_id)) latest.set(r.session_id, r)
    const ranked = { waiting: 0, ready: 1, blocked: 2, failed: 3, progress: 4, dropped: 5 }
    const items = []
    for (const r of latest.values()) {
      const rank = ranked[r.status]
      if (rank === undefined || r.status === 'dropped') continue
      if (r.acknowledged_at) continue
      let needs = []
      try { needs = r.needs ? JSON.parse(r.needs) : [] } catch { needs = [] }
      const stage = r.status === 'waiting' ? 'person/answer'
        : r.status === 'ready' ? 'person/review'
          : r.status === 'blocked' ? 'person/blocked'
            : r.status === 'failed' ? 'person/failed'
              : 'working'
      items.push({
        session_id: r.session_id, role: r.role, label: r.label, status: r.status, stage,
        reason: r.blocked_reason || '', needs, at: r.created_at, rank,
      })
    }
    items.sort((a, b) => a.rank - b.rank || String(b.at || '').localeCompare(String(a.at || '')))
    /* A gap also needs a human: empty queue but coverage unclosed is a system issue, report it apart */
    const pendingCoverage = (() => {
      try {
        const host = this.hostNextActions(id, { limit: 1 }).total
        const asset = this.assetNextActions(id, { limit: 1 }).total
        return host + asset
      } catch { return 0 }
    })()
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100)
    return {
      total: items.length,
      awaiting_person: items.filter((x) => x.stage.startsWith('person/')).length,
      items: items.slice(0, limit),
      pending_coverage: pendingCoverage,
      note: items.length === 0
        ? (pendingCoverage > 0
          ? 'Không có tác nhân nào đang chờ, nhưng vẫn còn ' + pendingCoverage + ' khoảng trống độ phủ — đã đến lúc giao tác nhân tiếp theo (redteam_next_action / redteam_asset_next).'
          : 'Không ai chờ, cũng không còn khoảng trống trong hàng đợi: vòng này đã đánh xong.')
        : 'Sắp theo "cần người nhất"; liệt kê luôn cả needs cho người dùng một lần, đừng chỉ thuật lại báo cáo.',
    }
  }

  /** Graph projection: C segment -> assets -> open ports (+ domain resolution edges). */
  graph(id, f = {}) {    const db = this.db(id)
    const nodes = []
    const edges = []
    const seen = new Set()
    const push = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node) } }
    const segs = f.cidr
      ? db.prepare('SELECT * FROM segment WHERE cidr = ?').all(f.cidr)
      : db.prepare('SELECT * FROM segment').all()
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: 'segment', label: s.cidr, meta: { org: s.org, asn: s.asn } })
      for (const a of db.prepare('SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(s.cidr)) {
        const nid = `asset:${a.id}`
        const ports = db.prepare("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id).n
        push({ id: nid, kind: 'asset', label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } })
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: 'contains' })
        for (const p of db.prepare('SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?').all(a.id, 'open')) {
          const pid = `port:${p.id}`
          push({ id: pid, kind: 'port', label: `${p.port}/${p.proto}`, meta: { provenance: p.provenance, asset: a.ip } })
          edges.push({ source: nid, target: pid, relation: 'exposes' })
        }
        if (a.primary_name) {
          const did = `name:${a.primary_name}`
          push({ id: did, kind: 'domain', label: a.primary_name, meta: {} })
          edges.push({ source: did, target: nid, relation: 'resolves' })
        }
      }
    }
    return { nodes, edges }
  }

  /* ---------- Score targets (exercise score points + score records) ---------- */

  /** Seed the default score points when a target is first opened (leave existing ones alone). */
  /** Kill-chain stages: seed the default five on first read (same policy as points). */
  seedStages(id) {
    const db = this.db(id)
    /* Self-healing seed: add whatever is missing (stages wrongly dropped by an older migration return) */
    const have = new Set(db.prepare('SELECT code FROM stage').all().map((r) => r.code))
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 }
    let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage').get().n + 1
    const stmt = db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    let seeded = 0
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order++, nowIso())
      seeded += 1
    }
    return { seeded: seeded }
  }

  listStages(id) {
    const db = this.db(id)
    this.seedStages(id)
    return db.prepare('SELECT * FROM stage ORDER BY sort_order, code').all().map((r, i) => ({
      code: r.code, name: r.name, subtitle: r.subtitle || '', color: r.color || '#64748b',
      goal: r.goal || '', sections: parseJson(r.sections, []), tools: r.tools || '',
      transition: r.transition || '',
      /* Real position in the chain (which stage): UI circles ①②③ and report ordering use it; do not renumber */
      ordinal: i + 1,
      updated_at: r.updated_at || null,
    }))
  }

  /** Edit stage content (name / goal / tactic groups / tools / ATT&CK / transition note). */
  saveStage(id, patch = {}) {
    const db = this.db(id)
    if (!patch.code) throw new Error('stage.code required')
    const cur = db.prepare('SELECT * FROM stage WHERE code = ?').get(String(patch.code))
    db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, subtitle = excluded.subtitle, color = excluded.color, goal = excluded.goal,
        sections = excluded.sections, tools = excluded.tools,
        transition = excluded.transition, updated_at = excluded.updated_at`).run(
      String(patch.code),
      patch.name ?? (cur ? cur.name : String(patch.code)),
      patch.subtitle ?? (cur ? cur.subtitle : ''),
      patch.color ?? (cur ? cur.color : '#64748b'),
      patch.goal ?? (cur ? cur.goal : ''),
      patch.sections !== undefined ? JSON.stringify(patch.sections) : (cur ? cur.sections : '[]'),
      patch.tools ?? (cur ? cur.tools : ''),
      patch.transition ?? (cur ? cur.transition : ''),
      patch.sort_order ?? (cur ? cur.sort_order : 0),
      nowIso(),
    )
    return { code: String(patch.code), updated: true }
  }

  seedScorePoints(id) {
    const db = this.db(id)
    const insert = (point, order) => db.prepare(`INSERT INTO score_point
        (code, name, category, points, description, enabled, sort_order, created_at, updated_at,
         src, rule, tier, cap, dedup_scope, legacy, builtin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      point.code, point.name, point.category, point.points, point.description,
      point.enabled === 0 ? 0 : 1, order, nowIso(), nowIso(),
      point.src ?? null,
      point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service', point.legacy === 1 ? 1 : 0,
      /* Built-in point: shipped with the rules; points/scope locked, cannot be deleted */
      point.legacy === 1 ? 0 : 1,
    )
    const have = new Set(db.prepare('SELECT code FROM score_point').all().map((r) => String(r.code)))

    /* ── Built-in flag backfill + legacy DB cleanup (old scoring items voided)─────────
       Backfill: the builtin column was just added to old DBs as all-0; mark known codes.
       Cleanup scope: **only old codes from the built-in list** — the default points
       shipped by earlier versions (web-account-* / webshell / rce / server-shell /
       db-access / sensitive-data / boundary / internal-pivot / core-system …) + hits.

       ⚠️ "Built-in" **must be decided by the builtin column**, not by the default list:
       user-created points would be treated as legacy residue and silently deleted
       with their hits on the next panel read, while saveScorePoint still returns ok.

       ⚠️ Irreversible: before deleting, **export the removed points and hits to
       <target>/runs/legacy-score-<time>.json** once (reports/audit can still read). */
    const builtinCodes = DEFAULT_SCORE_POINTS.map((x) => x.code)
    const keep = new Set(builtinCodes)
    try {
      const ph = builtinCodes.map(() => '?').join(',')
      db.prepare('UPDATE score_point SET builtin = 1 WHERE code IN (' + ph + ')').run(...builtinCodes)
    } catch { /* old DB structure anomaly: scoring unaffected, retry on next seed */ }
    let purgedPoints = 0
    let purgedHits = 0
    try {
      const doomed = db.prepare('SELECT id, code, name, category, points, legacy, builtin FROM score_point').all()
        .filter((r) => !keep.has(String(r.code)) && (Number(r.legacy) === 1 || Number(r.builtin) === 1))
      if (doomed.length > 0) {
        const ids = doomed.map((r) => r.id)
        const ph = ids.map(() => '?').join(',')
        const hits = db.prepare(`SELECT * FROM score_hit WHERE point_id IN (${ph})`).all(...ids)
        if (hits.length > 0) {
          /* Archive: under the target's runs/ directory, next to all other evidence */
          try {
            const dir = join(this.dirOf(id), 'runs')
            mkdirSync(dir, { recursive: true })
            const stamp = nowIso().replace(/[:.]/g, '-')
            writeFileSync(join(dir, 'legacy-score-' + stamp + '.json'),
              JSON.stringify({
                archived_at: nowIso(),
                reason: 'Tái cấu trúc theo "Quy tắc chấm điểm nhóm đột phá xâm nhập (bản hợp nhất)": toàn bộ mục điểm cũ bị bãi bỏ',
                points: doomed, hits,
              }, null, 2), 'utf8')
          } catch { /* archive failure must not block cleanup, but it must be recorded honestly */ }
        }
        db.prepare(`DELETE FROM score_hit WHERE point_id IN (${ph})`).run(...ids)
        db.prepare(`DELETE FROM score_point WHERE id IN (${ph})`).run(...ids)
        purgedPoints = doomed.length
        purgedHits = hits.length
      }
    } catch { /* table missing etc.: ignore, seeding continues */ }

    /* **Rule metadata sync** for built-in points: when the rule doc changes (category grouping,
       caps, scoring scope, tier notes, clause text), existing rows must be updated too.
       Why: earlier only "add missing codes" ran, so rows whose category had changed kept the
       old value in legacy DBs — the panel groups by category, so one class split into two
       groups (e.g. NETINFRA and "network infrastructure"), looking like extra categories.
       ⚠️ Points/caps/scope **are locked by the rules** (builtin=1), users cannot change them:
       this is not just "intentional override", it is **required** — a rule's cap accumulates
       over all its points, so if a single point's points were editable, setting 50 to 500
       would let one hit eat the whole rule's cap.
       So built-in name/category/description and the whole rule/tier/cap/dedup_scope/points set
       are synced here; **enable/disable stays under user control and is not overwritten**.
       The UI greys out the points input for built-in points (overridden:false gives the reason).

       To customise the score, **create a new scoring point** (builtin=0) — that one is not
       overwritten here, and not removed by the legacy cleanup above. */
    let synced = 0
    if (have.size > 0) {
      const upd = db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?,
          src = ?, rule = ?, tier = ?, cap = ?, dedup_scope = ?, builtin = 1, updated_at = ?
        WHERE code = ? AND legacy = 0`)
      for (const point of DEFAULT_SCORE_POINTS) {
        if (!have.has(point.code)) continue
        try {
          const r = upd.run(point.name, point.category, point.points, point.description,
            point.src ?? null,
            point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service',
            nowIso(), point.code)
          if (r.changes > 0) synced += 1
        } catch { /* ignore single-row failure */ }
      }
    }

    /* Add missing rows only: new rules and wrongly deleted defaults both self-heal here */
    const missing = DEFAULT_SCORE_POINTS.filter((p) => !have.has(p.code))
    if (missing.length > 0) {
      let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
      for (const point of missing) insert(point, order++)
    }
    if (missing.length === 0 && purgedPoints === 0 && synced === 0) return { seeded: 0 }
    return {
      seeded: missing.length,
      /* Old points and hits cleared by this run (panel/tools tell the user "old scope voided") */
      purgedLegacyPoints: purgedPoints,
      purgedLegacyHits: purgedHits,
      purged: purgedPoints > 0,
    }
  }

  listScorePoints(id, f = {}) {
    const db = this.db(id)
    /* Seed on every run: it is idempotent and covers three cases —
       ① first seed on an empty DB; ② self-heal new rules / deleted points; ③ mark legacy (v0.11.0).
       ⚠️ Earlier it only ran when "no score points at all", so legacy DBs were never migrated. */
    this.seedScorePoints(id)
    /* Display **by ascending points** (ties keep definition order) — easier to pick targets */
    const rows = db.prepare('SELECT * FROM score_point ORDER BY COALESCE(points, 0) ASC, sort_order ASC, id ASC').all()
    const hits = db.prepare('SELECT * FROM score_hit ORDER BY recorded_at DESC, id DESC').all()
    /* Asset IP: alerts and hits must show which service it was (asset_ip:port) */
    const assetIp = new Map(db.prepare('SELECT id, ip FROM asset').all().map((a) => [a.id, a.ip]))
    const codeOf = new Map(rows.map((r) => [r.id, r.code]))
    /* Default points come from the point; a hit's own points win (merged-version tiers) */
    const pointsOf = new Map(rows.map((r) => [r.id, Number(r.points) || 0]))
    /* Effective points on a hit row: tier points × multiplier (see scoreMultiplierOf / hitPointsOf) */
    const effPointsOf = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: codeOf.get(h.point_id) },
      new Map([[String(codeOf.get(h.point_id)), { points: pointsOf.get(h.point_id) || 0 }]]),
    )
    const byPoint = new Map()
    for (const h of hits) {
      if (!byPoint.has(h.point_id)) byPoint.set(h.point_id, [])
      byPoint.get(h.point_id).push(h)
    }
    /* Scoring scope and rule caps (data-driven, see applyScoreCaps):
       · dedup_scope decides "only the highest per target/system/service" vs. summing per host;
       · rule + cap decides the cumulative ceiling for that rule.
       Self-created accounts neither compete nor occupy a slot (they never score). */
    /* Metadata and evaluation both go through the shared impl (evaluateScoreBoard): panel /
       report / kill chain each reimplementing it would drift and totals would not match. */
    const pointsMeta = new Map(rows.map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
    const nameOf = loadAssetNames(db)
    const cappedAll = evaluateScoreBoard(db, hits.map((h) => Object.assign({}, h, {
      code: codeOf.get(h.point_id), points: effPointsOf(h),
    })), { meta: pointsMeta, names: nameOf })
    const cappedById = new Map(cappedAll.items.map((h) => [h.id, h]))
    const enabled = rows.filter((r) => r.enabled === 1)
    const enabledIds = new Set(enabled.map((r) => r.id))
    /* Whether this point takes part in "highest only" dedup (UI shows the "maxed out" hint) */
    const isCappedPoint = (pid) => {
      const meta = pointsMeta.get(codeOf.get(pid))
      return meta !== undefined && meta.dedup_scope !== 'none' && meta.dedup_scope !== null
    }
    const items = rows
      .filter((r) => f.enabledOnly !== true || r.enabled === 1)
      .map((r) => {
        const list = (byPoint.get(r.id) || []).map((h) => {
          const flag = cappedById.get(h.id)
          const capped = flag !== undefined && flag.capped === true
          const hit = {
            id: h.id, asset_id: h.asset_id, vuln_id: h.vuln_id, step_id: h.step_id,
            target: h.target, evidence: h.evidence, note: h.note,
            points: effPointsOf(h), points_overridden: h.points !== null && h.points !== undefined,
            port: normalizePort(h.port) ?? parseTargetPort(h.target),
            self_created: Number(h.self_created) === 1,
            capped: capped,
            capped_by_id: capped ? flag.capped_by_id : null,
            capped_reason: capped ? scoreCapReasonText(Object.assign({}, h, {
              code: r.code, asset_ip: assetIp.get(h.asset_id),
              rule: flag.rule ?? null, rule_cap: flag.rule_cap || 0, capped_reason_kind: flag.capped_reason_kind,
            }), flag.capped_by_points) : null,
            capped_reason_kind: capped ? flag.capped_reason_kind : null,
            recorded_by: h.recorded_by, recorded_at: h.recorded_at,
          }
          hit.service = serviceLabel(Object.assign({}, hit, { asset_ip: assetIp.get(h.asset_id) }))
          if (capped) hit.capped_by = flag.capped_by_evidence ?? null
          return hit
        })
        /* Uncapped points: hits × points, summed.
           Self-created accounts don't score; account/db points cap per service, highest only. */
        const valid = list.filter((h) => h.self_created !== true)
        const countedList = valid.filter((h) => h.capped !== true)
        const counted = countedList.length
        const cappedList = valid.filter((h) => h.capped === true)
        const meta = pointsMeta.get(r.code) || { rule: null, cap: 0, dedup_scope: 'service' }
        const capUsed = meta.rule === null ? null : cappedAll.caps.get('rule:' + meta.rule)
        const scopeLabel = { service: 'Cùng một dịch vụ chỉ tính mục cao nhất', system: 'Cùng một hệ thống chỉ tính quyền cao nhất một lần', target: 'Toàn bộ mục tiêu chỉ tính một lần', none: 'Cộng dồn theo số máy / card / node' }[meta.dedup_scope] || ''
        return {
          id: r.id, code: r.code, name: r.name, category: r.category, points: r.points,
          rule: meta.rule, tier: r.tier || null, cap: meta.cap || 0, dedup_scope: meta.dedup_scope,
          /* src = original index in the merged rule doc (for reconciliation); builtin = shipped point.
             The UI greys out built-in points inputs and shows the reason. */
          src: r.src === null || r.src === undefined ? null : Number(r.src),
          builtin: Number(r.builtin) === 1,
          legacy: Number(r.legacy) === 1,
          counted: counted,
          /* Sum the **counted** points — merged codes carry tiers, so default × count is wrong */
          earned: countedList.reduce((n, h) => n + (Number(h.points) || 0), 0),
          self_created: list.length - valid.length,
          capped: cappedList.length,
          capped_hits: cappedList,
          /* Rule cap usage (shared by all points of a rule; UI groups by rule, "used / cap") */
          cap_used: capUsed ? capUsed.used : null,
          cap_capped: capUsed ? capUsed.capped : 0,
          scope_label: scopeLabel,
          service_summary: (meta.dedup_scope !== 'none' && cappedList.length > 0)
            ? 'Tiêu chí chấm điểm "' + scopeLabel + '": đã đạt ' + counted + ' mục, còn ' + cappedList.length + ' lần trúng trùng không tính điểm'
            : null,
          description: r.description || '', enabled: r.enabled === 1, sort_order: r.sort_order,
          hits: list,
        }
      })

    /* ── Evidence shots: at most 3 representative images per scoring point ────────────────
       Batch points (terminal access, 60 hosts at once) with an image each is noise and
       blows up the page, so images are per **point**; per-hit counts stay on the hit row.
       Selection priority in #representativeShots (hit > target > point; live > generated). */
    const shotPicks = this.#representativeShots(id, items.map((it) => ({
      point_id: it.id, point_code: it.code, hit_ids: (it.hits || []).map((h) => h.id),
    })), 3)
    const shotCountByPoint = new Map()
    const shotCountByHit = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, hit_id, COUNT(*) AS n FROM shot GROUP BY point_id, hit_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) {
          shotCountByPoint.set(Number(row.point_id), (shotCountByPoint.get(Number(row.point_id)) || 0) + Number(row.n))
        }
        if (row.hit_id !== null && row.hit_id !== undefined) shotCountByHit.set(Number(row.hit_id), Number(row.n))
      }
    } catch { /* ignore when the old DB has no shot table yet */ }
    const shotBrief = (x) => ({
      id: Number(x.id), url: this.shotUrlOf(id, x), label: x.label || '', note: x.note || '',
      kind: x.kind || 'screenshot', mime: x.mime || 'image/png', bytes: Number(x.bytes) || 0,
      target: x.target || '', captured_at: x.captured_at || '', source_ref: x.source_ref || '',
    })
    for (const it of items) {
      const picked = shotPicks.get(Number(it.id)) || []
      it.shots = picked.map(shotBrief)
      it.shot_total = shotCountByPoint.get(Number(it.id)) || 0
      it.shot_shown = picked.length
      for (const h of (it.hits || [])) h.shot_count = shotCountByHit.get(Number(h.id)) || 0
    }

    /* Sort: **scored items first** (see the wins at a glance), unscored after;
       within each group ascending points (ties keep definition order, stable and predictable). */
    const achievedRank = (it) => (it.hits.length > 0 ? 0 : 1)
    const sortedItems = items.slice().sort((a, b) => {
      const ra = achievedRank(a); const rb = achievedRank(b)
      if (ra !== rb) return ra - rb
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pa !== pb) return pa - pb
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    })

    /* ── Group by the merged doc's 8 categories (general systems / web apps / centralised /
       big data / network infra / file storage / model-related / boundary breach)──────────
       Panel and report both group this way: users see the rule doc's own structure.
       Inside a group ascending points (items already sorted); group order = SCORE_GROUPS order. */
    const groupOrder = new Map(SCORE_GROUPS.map((g, i) => [g.code, i]))
    const groupName = new Map(SCORE_GROUPS.map((g) => [g.code, g.name]))
    const ruleGroups = []
    const gmap = new Map()
    for (const it of sortedItems) {
      if (it.legacy) continue
      const code = it.category || 'OTHER'
      if (!gmap.has(code)) {
        const g = {
          key: code, code,
          name: groupName.get(code) || code,
          /* Sum of caps in this category (reference only — caps are independent, see G3) */
          capSum: 0, points: 0, counted: 0, capped: 0, tiers: [],
          order: groupOrder.has(code) ? groupOrder.get(code) : 99,
        }
        gmap.set(code, g); ruleGroups.push(g)
      }
      const g = gmap.get(code)
      g.capSum += Number(it.cap) || 0
      g.points += it.earned
      g.counted += it.counted
      g.capped += it.capped
      g.tiers.push(it)
    }
    ruleGroups.sort((a, b) => a.order - b.order)
    /* Re-sort inside the group (callers may have reordered): scored first, then ascending points */
    for (const g of ruleGroups) {
      g.tiers.sort((a, b) => {
        const ra = achievedRank(a); const rb = achievedRank(b)
        if (ra !== rb) return ra - rb
        return (Number(a.points) || 0) - (Number(b.points) || 0)
      })
    }
    const legacyItems = items.filter((it) => it.legacy)
    const legacyHits = legacyItems.reduce((n, p) => n + p.hits.length, 0)
    const enabledItems = items.filter((p) => p.enabled)
    const cappedItems = cappedAll.items.filter((h) => h.capped === true && (codeOf.get(h.point_id) !== undefined) && enabledIds.has(h.point_id))
    const latestCapped = cappedItems.length === 0 ? null : cappedItems.slice().sort((a, b) => {
      const sa = String(a.recorded_at || '') + '#' + String(a.id).padStart(8, '0')
      const sb = String(b.recorded_at || '') + '#' + String(b.id).padStart(8, '0')
      return sb.localeCompare(sa)
    })[0]
    return {
      items: sortedItems,
      ruleGroups,
      summary: {
        /* No cap: points = hits × points, just sum them */
        achievedPoints: enabledItems.reduce((n, p) => n + p.earned, 0),
        /* Number of scoring points (the UI shows this, not "N items captured") */
        pointCount: enabledItems.length,
        hitPointCount: enabledItems.filter((p) => p.counted > 0).length,
        hitCount: items.reduce((n, p) => n + p.hits.length, 0),
        countedHits: enabledItems.reduce((n, p) => n + p.counted, 0),
        /* Hits dropped as self-registered/self-built (shown separately, no "logged but unscored") */
        selfCreatedHits: items.reduce((n, p) => n + p.self_created, 0),
        /* Rows unscored by dedup scope or a full rule cap (called out separately) */
        serviceCappedHits: cappedItems.length,
        cappedByDedup: cappedItems.filter((h) => h.capped_reason_kind === 'dedup').length,
        cappedByRuleLimit: cappedItems.filter((h) => h.capped_reason_kind === 'cap').length,
        /* legacy (old-scope) points and hits: shown collapsed, not added to the new total */
        legacyPointCount: legacyItems.length,
        legacyHitCount: legacyHits,
        latestCapped: latestCapped === null ? null : {
          hit_id: latestCapped.id,
          point_id: latestCapped.point_id,
          code: latestCapped.code,
          service: serviceLabel(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) })),
          evidence: latestCapped.evidence,
          points: latestCapped.points,
          recorded_at: latestCapped.recorded_at,
          reason: serviceCapReason(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) }), latestCapped.capped_by_points),
        },
      },
    }
  }

  /** Create or update a point (with id updates, without id inserts). **No count cap**, points only. */
  /**
   * Save a scoring point.
   *
   * The two paths differ a lot; the result explains which ran via `builtin` / `overridden` / `locked_fields`:
   *   · **Built-in point** (builtin=1, shipped with the scoring rules): points/cap/scope/name
   *     locked by the rules, only enable/disable is editable. **Points are not editable** —
   *     a rule's cap accumulates over all its points, so editing one point lets one hit eat it.
   *     Still returns `ok` (the enabled flag really was stored), but `overridden:false` states
   *     that the submitted points were ignored, so the UI can explain instead of faking success.
   *   · **User-created point** (builtin=0): every field is editable, and seeding never removes it.
   */
  saveScorePoint(id, point = {}) {
    const db = this.db(id)
    const enabled = point.enabled === false ? 0 : 1
    /* The name-required check must run **after the built-in branch**: built-ins only take
       enabled / sort_order, so callers (UI toggle, tool flipping state) must not resend name.
       Checking first would make "just disable a built-in point" fail with name required. */
    const name = String(point.name || '').trim()
    /* max_hits is kept only for old DB compatibility; scoring no longer uses it (always 1) */
    if (point.id !== undefined && point.id !== null && Number(point.id) > 0) {
      const pid = Number(point.id)
      const row = db.prepare('SELECT id, code, name, points, cap, rule, tier, dedup_scope, builtin, legacy FROM score_point WHERE id = ?').get(pid)
      if (row === undefined) throw new Error('score point not found: id=' + pid)
      if (Number(row.builtin) === 1 || Number(row.legacy) === 1) {
        /* Built-in: store only enabled / sort_order; the rest is synced by seedScorePoints */
        db.prepare('UPDATE score_point SET enabled = ?, sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?')
          .run(enabled, point.sort_order ?? null, nowIso(), pid)
        const after = db.prepare('SELECT * FROM score_point WHERE id = ?').get(pid)
        return {
          id: pid, updated: true, builtin: true,
          points: after.points, cap: after.cap, rule: after.rule,
          overridden: Number(point.points) === Number(after.points),
          locked_fields: ['name', 'category', 'points', 'cap', 'rule', 'tier', 'dedup_scope', 'description'],
          note: 'Đây là mục điểm tích hợp phát hành kèm "Quy tắc chấm điểm nhóm đột phá xâm nhập": điểm số, giới hạn, tiêu chí chấm điểm, tên và toàn văn điều khoản'
            + 'đều do quy tắc khóa (giới hạn của một quy tắc được cộng dồn theo tất cả mục điểm trong nhóm, sửa riêng điểm số sẽ khiến một lần trúng ăn hết giới hạn cả nhóm).'
            + 'Đã lưu thay đổi "bật/tắt" của bạn. Muốn tự đặt điểm số hãy **thêm một mục điểm mới**.',
        }
      }
      if (name === '') throw new Error('score point name required')
      const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
      db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?, enabled = ?,
          sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`)
        .run(name, point.category ?? null, points, point.description ?? null, enabled,
          point.sort_order ?? null, nowIso(), pid)
      return { id: pid, updated: true, builtin: false, overridden: true, points, note: 'Đã lưu (mục điểm tự tạo)' }
    }
    if (name === '') throw new Error('score point name required')
    const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
    /* A custom point may carry a built-in code (panel derives it from the name): code is UNIQUE,
       so switch to a fresh one instead of failing silently in the UI. */
    let code = point.code === undefined || point.code === null || String(point.code).trim() === ''
      ? null
      : String(point.code).trim()
    if (code !== null && db.prepare('SELECT id FROM score_point WHERE code = ?').get(code) !== undefined) {
      code = code + '-custom-' + Date.now().toString(36)
    }
    const r = db.prepare(`INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at, builtin)
      VALUES(?,?,?,?,?,?,?,?,?,0)`).run(
      code, name, point.category ?? null, points, point.description ?? null, enabled,
      next, nowIso(), nowIso(),
    )
    return {
      id: Number(r.lastInsertRowid), code, updated: false, builtin: false, overridden: true,
      points, note: 'Đã thêm mục điểm tự tạo (không bị quy tắc khóa điểm số, cũng không bị cơ chế cũ dọn xóa)',
    }
  }

  /** Delete a point. Built-ins cannot be deleted (the panel would miss a rule; seeding restores it). */
  deleteScorePoint(id, pointId) {
    const db = this.db(id)
    const pid = Number(pointId)
    const row = db.prepare('SELECT id, code, name, builtin FROM score_point WHERE id = ?').get(pid)
    if (row === undefined) throw new Error('score point not found: id=' + pid)
    if (Number(row.builtin) === 1) {
      throw new Error('Không thể xóa mục điểm tích hợp: "' + (row.name || row.code) + '" thuộc "Quy tắc chấm điểm nhóm đột phá xâm nhập (bản hợp nhất)", '
        + 'xóa đi sẽ khiến bảng thiếu một quy tắc, báo cáo thiếu một loại kết quả (lần khởi động sau sẽ tự bổ sung lại).'
        + 'Muốn nó không tham gia tính điểm, hãy chuyển sang "tắt".')
    }
    db.prepare('DELETE FROM score_hit WHERE point_id = ?').run(pid)
    db.prepare('DELETE FROM score_point WHERE id = ?').run(pid)
    return { deleted: pid }
  }

  /**
   * Which port this hit lands on (the granularity of service-level capping).
   *   ① explicit `port` (tool argument);
   *   ② the port inside `target` (http://h:8080/x → 8080, 10.0.0.5:6379 → 6379);
   *   ③ if the asset registers exactly one port, use it (never guess 80/443, avoid merging services).
   */
  #servicePortOf(db, hit = {}) {
    const explicit = normalizePort(hit.port)
    if (explicit !== null) return explicit
    const fromTarget = parseTargetPort(hit.target)
    if (fromTarget !== null) return fromTarget
    const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
    if (assetId === null) return null
    try {
      const ports = db.prepare('SELECT port FROM port WHERE asset_id = ? ORDER BY port').all(assetId)
      if (ports.length === 1) return normalizePort(ports[0].port)
    } catch { /* ignore */ }
    return null
  }

  /** Record one score (a point captured on a target). */
  addScoreHit(id, hit = {}) {
    const db = this.db(id)
    /* The point may not be seeded yet (scoring right after creating a target): seed first,
       otherwise it errors "score point not found" while the real cause is no defaults written. */
    this.seedScorePoints(id)
    let pointId = hit.point_id !== undefined && hit.point_id !== null ? Number(hit.point_id) : null
    /* Look up by code (most common). Old codes were voided with the old items (v0.11.1):
       **no silent remap here** — the remap target may not exist, and swallowing it leaves
       the user with "logged but unscored" and no clue. Fall through to point not found,
       whose message tells them to fetch a fresh code from redteam_score_list. */
    if (pointId === null && hit.code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(hit.code))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null && hit.point_name) {
      const row = db.prepare('SELECT id FROM score_point WHERE name = ?').get(String(hit.point_name))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null) {
      throw new Error('score point not found: quy tắc chấm điểm đã được tái cấu trúc thành 25 mục theo "Quy tắc chấm điểm nhóm đột phá xâm nhập (bản hợp nhất)", '
        + 'các code cũ (web-account-*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system...) đã bị bãi bỏ.'
        + ' Hãy dùng redteam_score_list để đọc code thực tế trước, hoặc chỉ định bằng point_id / point_name.')
    }
    const evidence = String(hit.evidence || '').trim()
    if (evidence === '') throw new Error('score hit evidence required: khi ghi điểm bắt buộc phải nêu bằng chứng (tài khoản/phản hồi/dung lượng dữ liệu/đường dẫn)')
    /* Self-registered/self-built account: recorded for the trail, but never scored */
    const selfCreated = hit.self_created === true || hit.self_created === 1 || hit.self_created === '1' ? 1 : 0
    const port = this.#servicePortOf(db, hit)
    /* Effective points of this hit: caller may set it explicitly (merged codes carry tiers,
       e.g. "admin 50"). When omitted store NULL — scoring falls back to the point default.

       ⚠️ Bounds must be validated: `points` is "the value of one tier", not a free bonus
       added on top. Without it `points=999999999` lands verbatim and inflates the total
       to 9 digits, `points=-500` drags it down — either way the delivered report is junk.
       Ceiling = max(that rule's cap, 100 × default points): the former keeps one hit from
       breaking the rule ceiling, the latter leaves tier room for low-value points
       (e.g. 5 pts/host for terminal access). */
    const pointMeta = db.prepare('SELECT points, cap FROM score_point WHERE id = ?').get(pointId) || {}
    const pointsMax = Math.max(Number(pointMeta.cap) || 0, (Number(pointMeta.points) || 0) * 100, 1000)
    let hitPoints = null
    if (hit.points !== undefined && hit.points !== null && hit.points !== '') {
      const n = Number(hit.points)
      if (!Number.isFinite(n)) {
        throw new Error('score hit points invalid: points phải là số hữu hạn (nhận được ' + JSON.stringify(hit.points) + ')')
      }
      if (n <= 0) {
        throw new Error('score hit points invalid: points phải lớn hơn 0 (nhận được ' + n + '). '
          + 'Điểm số điền theo bậc của "Quy tắc chấm điểm nhóm đột phá xâm nhập", đừng dùng nó để chỉnh điểm.')
      }
      if (n > pointsMax) {
        throw new Error('score hit points invalid: points=' + n + ' vượt giới hạn hợp lý của mục điểm này ' + pointsMax
          + ' (= max(giới hạn quy tắc ' + (Number(pointMeta.cap) || 0) + ', điểm số mặc định ' + (Number(pointMeta.points) || 0)
          + ' × 100)). Hãy điền theo bậc của quy tắc, hoặc sửa lại thiết lập điểm số của mục điểm.')
      }
      hitPoints = n
    }
    /* G5 / G6 multipliers: doubled data scale, IPv6 ×3. Applied to privilege points, capped with cap. */
    const mult = scoreMultiplierOf(hit)
    const r = db.prepare(`INSERT INTO score_hit(point_id, asset_id, vuln_id, step_id, target, evidence, note, self_created, port, recorded_by, recorded_at, points, multiplier)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId, hit.asset_id ?? null, hit.vuln_id ?? null, hit.step_id ?? null,
      hit.target ?? null, evidence, hit.note ?? null, selfCreated, port,
      hit.recorded_by ?? null, nowIso(), hitPoints, mult.multiplier,
    )
    const hitId = Number(r.lastInsertRowid)
    const point = db.prepare('SELECT name, points, code FROM score_point WHERE id = ?').get(pointId)
    const board = this.listScorePoints(id)
    const summary = board.summary
    const allHits = board.items.flatMap((p) => p.hits)
    const row = allHits.find((h) => h.id === hitId)
    /* Service-level cap: same asset + same port counts the highest hit only (accounts / db privs) */
    const cappedByService = selfCreated === 0 && row !== undefined && row.capped === true
    const capService = row === undefined ? null : row.service
    const capBy = row === undefined ? null : (row.capped_by || null)
    const capByPoints = row === undefined || row.capped_by_id === null || row.capped_by_id === undefined
      ? null
      : (allHits.find((h) => h.id === row.capped_by_id) || {}).points
    /* Conversely: did this hit demote previously counted hits on the same service (total stays flat)?
       Decided by "who is still capped after this insert", so an earlier demotion cannot skew it. */
    const demoted = selfCreated === 0 && row !== undefined && row.capped !== true
      ? allHits.filter((h) => h.capped_by_id === hitId && Number(h.id) < hitId)
      : []
    const warnings = []
    if (selfCreated === 1) {
      warnings.push('Đã ghi nhận, nhưng **tài khoản tự đăng ký/tự tạo không tính điểm** (điểm diễn tập nhắm vào "lấy được tài khoản/quyền mà người khác đã có"). Mục này chỉ để lưu vết quá trình, không chiếm giới hạn, không vào báo cáo.')
    }
    /* G5 "data-heavy system doubles" needs a magnitude basis: threshold is **100M rows / 10TB**.
       Unverifiable only **warns, never blocks** — scale often lives in the report body, not
       in evidence, and hard-blocking would reject real findings. But do remind them. */
    if (mult.multiplier > 1 && mult.reasons.some((x) => x.indexOf('G5') === 0)) {
      const rows = parseRowCount(evidence)
      if (rows === null) {
        warnings.push('Lưu ý: mục này được ghi "nhân đôi quy mô dữ liệu" theo G5, nhưng trong evidence **không thấy được dung lượng dữ liệu**.'
          + 'Hãy ghi rõ quy mô thực tế trong evidence (ví dụ "xuất 130 triệu bản ghi người dùng" hoặc "12TB dữ liệu huấn luyện"), nếu không lần nhân đôi này không đứng vững.')
      } else if (rows < SENSITIVE_DATA_MIN_ROWS) {
        warnings.push('Lưu ý: mục này được ghi nhân đôi theo G5, nhưng lượng trong evidence là **' + formatRows(rows) + ' bản ghi/dòng**, '
          + 'thấp hơn nhiều so với ngưỡng của "hệ thống dữ liệu lớn" (tài liệu là trên 100 triệu bản ghi hoặc 10TB). Hãy kiểm tra lại quy mô dữ liệu; nếu đúng là trên 100 triệu bản ghi thì'
          + 'hãy ghi vào evidence bằng cách viết rõ hơn (như "132 triệu bản ghi").')
      }
    }
    if (cappedByService) {
      const assetIp = row.asset_id === null || row.asset_id === undefined
        ? undefined
        : (db.prepare('SELECT ip FROM asset WHERE id = ?').get(Number(row.asset_id)) || {}).ip
      warnings.push(serviceCapReason(Object.assign({}, row, { code: point ? point.code : '', asset_ip: assetIp }), capByPoints))
      if (capBy) warnings.push('Mục được tính điểm là một mục khác cùng dịch vụ: ' + String(capBy).slice(0, 120))
    } else if (demoted.length > 0) {
      warnings.push('Lưu ý: mục này đã đẩy bật ' + demoted.length + ' lần trúng cũ có điểm thấp hơn trên cùng dịch vụ — **cùng một tài sản cùng một cổng chỉ tính một lần**, nên lần ghi điểm này không làm tổng điểm tăng (lần trúng cũ chuyển sang không tính điểm).')
    }
    return {
      id: hitId, point_id: pointId,
      point: point ? point.name : null,
      /* Tier points and the final counted points are reported separately (multiplier explains 50→150) */
      base_points: hitPoints === null ? (point ? point.points : 0) : hitPoints,
      multiplier: mult.multiplier,
      multiplier_reasons: mult.reasons.length > 0 ? mult.reasons : undefined,
      points: Math.round((hitPoints === null ? (point ? point.points : 0) : hitPoints) * mult.multiplier),
      port: port,
      service: capService,
      /* G5 magnitude check (null when not scored under G5): shows whether the doubling has grounds */
      volume: mult.reasons.some((x) => x.indexOf('G5') === 0)
        ? (() => {
            const rows = parseRowCount(evidence)
            return { rows: rows, min_rows: SENSITIVE_DATA_MIN_ROWS, meets_threshold: rows === null ? null : rows >= SENSITIVE_DATA_MIN_ROWS }
          })()
        : null,
      self_created: selfCreated === 1,
      counted: selfCreated === 0 && !cappedByService,
      capped_by_service: cappedByService,
      capped_by: capBy,
      demoted_hits: demoted.map((h) => ({ id: h.id, evidence: h.evidence, points: h.points })),
      warning: warnings.length === 0 ? undefined : warnings.join('\n'),
      summary,
    }
  }

  /** Asset ease-of-compromise estimate: expected gains and priority. */
  assessAsset(id, a = {}) {
    const db = this.db(id)
    let row
    if (a.asset_id !== undefined && a.asset_id !== null) row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(a.asset_id))
    else if (a.ip) row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(a.ip))
    if (row === undefined) throw new Error('asset not found (hãy truyền asset_id hoặc ip)')
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : (row.priority || 'medium')
    const stamp = nowIso()
    db.prepare('UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?')
      .run(priority, a.potential ?? (row.potential || ''), a.reason ?? (row.assess_reason || ''), stamp, a.assessed_by ?? null, row.id)
    this.#observe(db, 'asset', row.id, 'assess', priority + ' ' + (a.potential || ''), 'active', a.assessed_by ?? null, null)
    return { asset_id: row.id, ip: row.ip, priority, potential: a.potential ?? (row.potential || ''), assessed_at: stamp }
  }

  /* ---------- Asset test status (what was tested / what attack surface remains) ---------- */

  /**
   * Record testing done on an asset.
   * @param id - target id.
   * @param t - `{ asset_id?, ip?, status?, test?, surface?, blocked?, updated_by? }`
   *   · test is **appended** to the test log (with a timestamp);
   *   · surface overwrites "remaining attack surface";
   *   · blocked=true increments the block counter.
   */
  updateAssetTest(id, t = {}) {
    const db = this.db(id)
    let row
    if (t.asset_id !== undefined && t.asset_id !== null) {
      row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(t.asset_id))
    } else if (t.ip) {
      row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(t.ip))
    }
    if (row === undefined) throw new Error('asset not found (hãy truyền asset_id hoặc ip)')
    const status = ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'].includes(t.status)
      ? t.status
      : (row.test_status || 'untested')
    const stamp = nowIso()
    /* Prompts historically call this record notes and models copy that name; accept both,
       and always land in test_notes (append mode), so a "logged a conclusion" actually lands. */
    const testText = [t.test, t.notes]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
      .join('; ')
    let notes = row.test_notes || ''
    if (testText !== '') {
      notes = (notes === '' ? '' : notes.replace(/\n+$/, '') + '\n') + '[' + stamp + '] ' + testText
    }
    const surface = typeof t.surface === 'string' ? t.surface : (row.test_surface || '')
    const blockedCount = (row.blocked_count || 0) + (t.blocked === true ? 1 : 0)
    db.prepare(`UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`).run(
      status, notes, surface, stamp, t.updated_by ?? null, blockedCount, row.id,
    )
    if (testText !== '') {
      this.#observe(db, 'asset', row.id, 'test', testText, 'active', t.updated_by ?? null, null)
    }
    if (t.blocked === true) {
      this.#observe(db, 'asset', row.id, 'blocked', 'Lần thứ ' + blockedCount + ' bị chặn', 'active', t.updated_by ?? null, null)
    }
    return {
      asset_id: row.id, ip: row.ip, status, blocked_count: blockedCount,
      test_notes: notes, tests: notes, surface, updated_at: stamp,
      hint: blockedCount >= 3
        ? 'Đã tích lũy bị chặn ' + blockedCount + ' lần (tiêu chí >3 lần): trong lần gọi này hãy đặt status = abandoned và ghi rõ bề mặt tấn công còn lại, rồi đổi mục tiêu.'
        : undefined,
    }
  }

  /** Test status statistics (for the overview and filters). */
  testStats(id) {
    const db = this.db(id)
    const rows = db.prepare("SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s").all()
    const out = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 }
    for (const r of rows) out[r.s] = r.n
    return out
  }

  /* ---------- Vulnerabilities / credentials / access sessions ---------- */

  /** Record a vulnerability; with a cve it upserts on (asset_id, cve, target). */
  addVuln(id, v = {}) {
    const db = this.db(id)
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info'
    const status = VULN_STATUSES.includes(v.status) ? v.status : 'candidate'
    const existing = v.cve
      ? db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.cve, v.target ?? '')
      : db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.title ?? '', v.target ?? '')
    if (existing !== undefined) {
      db.prepare(`UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained),
          agent = COALESCE(?, agent)
        WHERE id = ?`).run(
        v.title ?? null, severity, v.status ?? null, v.evidence ?? null, v.confidence ?? null,
        v.source ?? null, v.target ?? null, v.found_by_agent ?? null, normGained(v.gained),
        v.agent ?? null, existing.id,
      )
      return { id: existing.id, updated: true }
    }
    const result = db.prepare(`INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.asset_id ?? null, v.port_id ?? null, v.cve ?? null, v.title ?? null, severity,
      v.source ?? null, v.confidence ?? null, status, v.evidence ?? null, v.target ?? null,
      normGained(v.gained), v.found_by_agent ?? null, nowIso(), v.agent ?? null,
    )
    const vulnId = Number(result.lastInsertRowid)
    if (v.asset_id !== undefined && v.asset_id !== null) {
      this.#observe(db, 'asset', v.asset_id, 'vuln', [v.cve, v.title].filter(Boolean).join(' '), 'active', v.source ?? null, null)
    }
    return { id: vulnId, updated: false }
  }

  listVulns(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.severity) { where.push('v.severity = ?'); args.push(f.severity) }
    if (f.status) { where.push('v.status = ?'); args.push(f.status) }
    if (f.cve) { where.push('v.cve LIKE ?'); args.push(`%${f.cve}%`) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('v.asset_id = ?'); args.push(Number(f.asset_id)) }
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.q) {
      where.push('(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)')
      const like = `%${f.q}%`
      args.push(like, like, like, like)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`).get(...args).n
    const items = db.prepare(`SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`).all(...args, limit)
    /* Raw request/response must appear in the detail, so include it here (clipped, may be huge) */
    const eviStmt = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)
    const clipped = (t) => (t === null || t === undefined ? null : (String(t).length > 60000 ? String(t).slice(0, 60000) + '\n… (đã cắt bớt)' : String(t)))
    for (const item of items) {
      item.http_evidence = eviStmt.all(item.id).map((e) => Object.assign({}, e, {
        request: clipped(e.request), response: clipped(e.response),
      }))
    }
    return { total, items }
  }

  updateVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false }
    db.prepare(`UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title)
      WHERE id = ?`).run(
      VULN_STATUSES.includes(patch.status) ? patch.status : current.status,
      SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.evidence ?? null, patch.confidence ?? null, normGained(patch.gained), patch.title ?? null, Number(vulnId),
    )
    return { updated: true, id: Number(vulnId) }
  }

  vulnStats(id) {
    const db = this.db(id)
    const bySeverity = {}
    for (const row of db.prepare('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity').all()) bySeverity[row.severity] = row.n
    const byStatus = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM vuln GROUP BY status').all()) byStatus[row.status] = row.n
    /* Vulnerabilities that state "what privilege was obtained": used by the conclusion line */
    const withGained = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get().n
    const withEvidence = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)").get().n
    /* Group count needed for per-target aggregation (default vuln view): merge by site/service first */
    const rawTargets = db.prepare(`SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln`).all()
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups,
    }
  }

  /** Credentials: plaintext goes to secret_value (panel shows it), secret_ref points at evidence. */
  addCredential(id, c = {}) {
    const db = this.db(id)
    if (!c.host) throw new Error('credential.host required')
    /* Plaintext credential: secret_value wins; accept secret / password / value aliases */
    const value = c.secret_value ?? c.secret ?? c.password ?? c.value ?? null
    db.prepare(`INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        agent = COALESCE(excluded.agent, credential.agent),
        found_at = excluded.found_at`).run(
      c.asset_id ?? null, c.host, c.username ?? '', c.secret_type ?? 'password',
      value === null || value === undefined ? null : String(value),
      c.secret_ref ?? null, c.privilege ?? null, c.source ?? null, c.tool ?? null,
      c.note ?? null, c.found_by_agent ?? null, nowIso(), c.agent ?? null,
    )
    const row = db.prepare('SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?')
      .get(c.host, c.username ?? '', c.secret_type ?? 'password')
    return { id: row.id }
  }

  listCredentials(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    if (f.username) { where.push('username = ?'); args.push(f.username) }
    if (f.withValue === true) where.push("COALESCE(secret_value,'') <> ''")
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /** Access session: one controllable access (the starting point for lateral movement). */
  addAccess(id, a = {}) {
    const db = this.db(id)
    if (!a.host) throw new Error('access.host required')
    const result = db.prepare(`INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      a.asset_id ?? null, a.host, a.username ?? null, a.method ?? null, a.privilege ?? null,
      a.session_ref ?? null, a.note ?? null, a.found_by_agent ?? null, nowIso(),
    )
    if (a.asset_id !== undefined && a.asset_id !== null) {
      this.#observe(db, 'asset', a.asset_id, 'access', [a.method, a.username, a.privilege].filter(Boolean).join(' '), 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid) }
  }

  listAccess(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- WebShell and tunnels: reusable assets while the operation runs ---------- */

  /**
   * Register a live WebShell. Same url+pass_key is the same row; re-registering refreshes it.
   * @param w - `{ url, shell_type, pass_key, secret_ref, privilege, status, note, asset_id, found_by_agent }`
   */
  addWebshell(id, w = {}) {
    const db = this.db(id)
    if (!w.url) throw new Error('webshell.url required')
    const ts = nowIso()
    const existing = db.prepare('SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, \'\') = COALESCE(?, \'\')')
      .get(w.url, w.pass_key ?? null)
    if (existing !== undefined) {
      db.prepare(`UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), agent = COALESCE(?, agent), updated_at = ? WHERE id = ?`)
        .run(normalizeShellType(w.shell_type), w.secret_ref ?? null, w.privilege ?? null, normalizeShellStatus(w.status),
          w.note ?? null, w.asset_id ?? null, w.agent ?? null, ts, existing.id)
      return { id: Number(existing.id), updated: true }
    }
    const result = db.prepare(`INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.asset_id ?? null, w.url, normalizeShellType(w.shell_type), w.pass_key ?? null, w.secret_ref ?? null,
        w.privilege ?? null, normalizeShellStatus(w.status), w.note ?? null, w.found_by_agent ?? null, ts, ts, w.agent ?? null)
    if (w.asset_id !== undefined && w.asset_id !== null) {
      this.#observe(db, 'asset', w.asset_id, 'webshell', w.url, 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid), updated: false }
  }

  listWebshells(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`).all(...args, limit)
  }

  updateWebshell(id, wsId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'privilege', 'note', 'secret_ref', 'shell_type']
    const sets = []
    const args = []
    /* Update path uses the same normalisation as insert: it used to accept any string,
       which silently killed the panel's "non-Behing shell cannot connect" warning. */
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'shell_type') value = normalizeShellType(value)
      if (key === 'status') value = normalizeShellStatus(value)
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`).run(...args, wsId)
    if (result.changes === 0) throw new Error('webshell not found')
    return { updated: true }
  }

  /**
   * Register an internal tunnel (suo5 / socks5 / ssh -R / frp …).
   *
   * **Rule**: only a tunnel whose far end sits on the target proves a boundary breach:
   *   · target-outbound the target connects out (reverse shell / frpc running on target)
   *   · target-http     through a target WebShell/HTTP channel (suo5 / Neo-ReGeorg)
   *   · target-agent    forwarded via a controlled process/session on target (SSH -R)
   *   · self-only       proxy or server on my own VPS — **not a breach**
   * A socks5 on my own server is not "into the intranet"; say what the target-side end is.
   */
  addTunnel(id, t = {}) {
    const db = this.db(id)
    const ts = nowIso()
    /* entry_kind is **the credential field for boundary-breach scoring**: bad values must error,
       never silently zero out — an unrecognised value stored as NULL gives legit=null and the UI
       shows "pending" (same as "not filled"), while the model only added a trailing space. */
    const rawEntryKind = t.entry_kind === undefined || t.entry_kind === null ? '' : String(t.entry_kind).trim()
    if (rawEntryKind !== '' && TUNNEL_ENTRY_KINDS[rawEntryKind] === undefined) {
      throw new Error('entry_kind không hợp lệ: ' + JSON.stringify(t.entry_kind) + '. Giá trị hợp lệ chỉ có '
        + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '(' + Object.values(TUNNEL_ENTRY_KINDS).join(' / ') + '). '
        + 'Để trống sẽ bị coi là "chờ xác nhận", không tính vào đột phá ranh giới.')
    }
    const result = db.prepare(`INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.asset_id ?? null, t.webshell_id ?? null, t.kind ?? 'socks5', t.listen ?? null, t.entry ?? null,
        t.reach ?? null, rawEntryKind === '' ? null : rawEntryKind, t.status ?? 'active', t.pid ?? null, t.command ?? null, t.note ?? null,
        t.found_by_agent ?? null, ts, ts, t.agent ?? null)
    if (t.asset_id !== undefined && t.asset_id !== null) {
      this.#observe(db, 'asset', t.asset_id, 'tunnel', `${t.kind || 'socks5'} ${t.listen || ''}`.trim(), 'active', 'exploit', null)
    }
    const entryKind = rawEntryKind === '' ? null : rawEntryKind
    const legit = tunnelIsLegit(entryKind)
    return {
      id: Number(result.lastInsertRowid),
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? 'Đã đăng ký, nhưng entry_kind=self-only (kênh chỉ mở trên VPS/máy chủ tự dựng của mình) — **đây không tính là đường hầm, không tính đột phá ranh giới/đột phá nội bộ**. Phải là kênh do phía mục tiêu khởi tạo: mục tiêu reverse shell về máy chủ của tôi, chạy frp client trên mục tiêu, hoặc đường hầm suo5/HTTP dựng qua WebShell của mục tiêu.'
        : (legit === null
            ? 'Nên bổ sung entry_kind để nói rõ "đầu phía mục tiêu là gì" (target-outbound / target-http / target-agent); khi không khai báo, giao diện hiển thị "chờ xác nhận" và cũng không tính vào bằng chứng đột phá.'
            : undefined),
    }
  }

  listTunnels(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('t.status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('t.asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`).all(...args, limit)
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  }

  updateTunnel(id, tId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'listen', 'reach', 'entry', 'entry_kind', 'pid', 'command', 'note']
    const sets = []
    const args = []
    /* The update path previously **skipped validation** of entry_kind / status: insert
       normalised to NULL while update wrote arbitrary strings, bypassing the legit check. */
    const TUNNEL_STATUSES = ['active', 'down', 'closed', 'unknown']
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'entry_kind') {
        const raw = value === null ? '' : String(value).trim()
        if (raw !== '' && TUNNEL_ENTRY_KINDS[raw] === undefined) {
          throw new Error('entry_kind không hợp lệ: ' + JSON.stringify(value) + '. Giá trị hợp lệ chỉ có '
            + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '. ')
        }
        value = raw === '' ? null : raw
      }
      if (key === 'status') {
        const raw = String(value).trim()
        if (!TUNNEL_STATUSES.includes(raw)) {
          throw new Error('tunnel status không hợp lệ: ' + JSON.stringify(value) + '. Giá trị hợp lệ chỉ có ' + TUNNEL_STATUSES.join(' / ') + '. ')
        }
        value = raw
      }
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`).run(...args, tId)
    if (result.changes === 0) throw new Error('tunnel not found')
    return { updated: true }
  }

  /**
   * Current test panel: assets under test + recently touched assets (each with vuln/port/entry counts).
   * The attack-chain page's "currently testing" block uses it; the client polls every few seconds.
   */
  activeTests(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 8, 50)
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`
    const testing = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`).all(limit)
    /* Recently touched: exclude assets under test so the two blocks do not overlap */
    const recent = db.prepare(`${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`).all(limit)
    /* Pending queue: untouched assets, ranked by exploitability + open port count */
    const queue = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`).all(limit)
    const untested = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'`).get().n
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() }
  }

  /**
   * How one score was obtained: chain action steps + exploited vuln + captured creds/entries into a path.
   *
   * Source for "where creds came from, how the tunnel was built" — gaps are flagged,
   * so the user sees which finding cannot be reproduced instead of a pretty report that cannot be delivered.
   * @param db - Target library handle.
   * @param hit - score_hit row (with asset_id / vuln_id / step_id / target / recorded_at / point_code).
   * @returns `{ steps, vuln, credentials, accesses, webshells, tunnels, how, complete, gaps }`
   */
  #hitTrace(db, hit, engagementId) {
    const evidenceDir = engagementId ? this.dirOf(engagementId) : null
    const steps = []
    const stepById = new Map()
    const pushStep = (row) => {
      if (row === undefined || row === null) return
      if (stepById.has(row.id)) {
        const existing = stepById.get(row.id)
        if (existing.inferred === true && row.inferred !== true) existing.inferred = false
        return
      }
      const step = {
        id: row.id, seq: row.seq, stage_code: row.stage_code, title: row.title || '',
        detail: row.detail || '', tool: row.tool || '', result: row.result || '',
        agent: row.agent || row.recorded_by || '', recorded_at: row.recorded_at || null,
        vuln_id: row.vuln_id ?? null, asset_id: row.asset_id ?? null, point_id: row.point_id ?? null,
        evidence_ref: row.evidence_ref || '', inferred: row.inferred === true,
      }
      stepById.set(step.id, step)
      steps.push(step)
    }
    const cols = 'id, seq, stage_code, title, detail, tool, agent, result, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_at'
    /* Attribution rules (precise first, broad later):
         ① explicitly linked step (score_hit.step_id)
         ② steps of this vuln (vuln_id) — "points from this hole" should show the action that hit it
         ③ same asset + same point steps (inferred)
       Only if all are empty fall back to "all steps of the asset" (so the report is not blank), marked inferred.
       step_source reports which tier was used so UI/report can say "reference only". */
    let stepSource = null
    try {
      if (hit.step_id !== null && hit.step_id !== undefined) {
        pushStep(db.prepare(`SELECT ${cols} FROM attack_step WHERE id = ?`).get(hit.step_id))
        if (steps.length > 0) stepSource = 'linked'
      }
      if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE vuln_id = ? ORDER BY seq, id`).all(hit.vuln_id)) pushStep(row)
        if (stepSource === null && steps.length > 0) stepSource = 'vuln'
      }
      if (hit.asset_id !== null && hit.asset_id !== undefined && hit.point_id !== null && hit.point_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? AND point_id = ? ORDER BY seq, id`).all(hit.asset_id, hit.point_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
          if (stepSource === null) stepSource = 'point'
        }
      }
      if (steps.length === 0 && hit.asset_id !== null && hit.asset_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT 40`).all(hit.asset_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
        }
        if (steps.length > 0) stepSource = 'asset'
      }
    } catch { /* old DB missing columns: degrade to "no steps"; the report will mark it unreplayable */ }
    steps.sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq ?? 0) - (b.seq ?? 0)))

    /* Vulnerability used by this score */
    let vuln = null
    if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
      try {
        const v = db.prepare('SELECT id, cve, title, severity, status, target, evidence, gained, source, found_by_agent, found_at FROM vuln WHERE id = ?').get(hit.vuln_id)
        if (v !== undefined) vuln = v
      } catch { vuln = null }
    }
    /* ── Credentials / sessions / webshells / tunnels: attach only when it is this same score ──
       The old code fetched by asset_id alone, so **all** creds/sessions on an asset hung under every
       score of that asset. Observed: a "terminal access pc-001" entry carried "MySQL root (config leak)"
       — unrelated; 4 scores each repeated the same creds, so the report was long and fake. Rule: with a
       target, its host must match the asset (IP / primary name); with no target (pure asset-level
       finding, e.g. "1 terminal") attaching by asset is correct. */
    const targetHost = (() => {
      const t = String(hit.target || '').trim()
      if (t === '') return null
      const url = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
      let authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
      if (!authority) return null
      authority = authority.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
      return authority === '' ? null : authority
    })()
    const asset = (hit.asset_id === null || hit.asset_id === undefined)
      ? undefined
      : (() => { try { return db.prepare('SELECT ip, primary_name, segment_cidr FROM asset WHERE id = ?').get(Number(hit.asset_id)) } catch { return undefined } })()
    const targetMatchesAsset = () => {
      if (targetHost === null) return true                 /* no target: attach by asset */
      if (asset === undefined) return false                /* target set but asset not found: do not attach */
      const ip = String(asset.ip || '').toLowerCase()
      const name = String(asset.primary_name || '').toLowerCase()
      const cidr = String(asset.segment_cidr || '').toLowerCase()
      /* ① the target is this very asset (IP or primary domain) */
      if (targetHost === ip || targetHost === name) return true
      /* ② the target "does not look like a single host": boundary breaks often write a reachable CIDR
         (10.20.30.0/24), and endpoint findings write a device name (pc-001). Such entries are asset-level
         findings, so their tunnel/webshell/creds attach to this entry asset — otherwise "how the channel
         was built" is lost. Criterion: target contains '/' (CIDR) or the parsed host is not IP/domain shaped. */
      const raw = String(hit.target || '').trim()
      if (raw.includes('/')) return true
      if (cidr !== '' && (targetHost === cidr || cidr.startsWith(targetHost + '/'))) return true
      const looksLikeHost = /^[0-9a-f.:\[\]]+$/i.test(targetHost) || targetHost.includes('.')
      return !looksLikeHost
    }
    const sameAsset = targetMatchesAsset()

    const credentials = []
    const accesses = []
    const webshells = []
    const tunnels = []
    if (sameAsset) {
      try {
        if (hit.asset_id !== null && hit.asset_id !== undefined) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE asset_id = ? ORDER BY id LIMIT 20`).all(hit.asset_id))
        } else if (targetHost !== null) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE host LIKE ? ORDER BY id LIMIT 20`).all('%' + targetHost + '%'))
        }
      } catch { /* ignore */ }
      if (hit.asset_id !== null && hit.asset_id !== undefined) {
        try { accesses.push(...db.prepare('SELECT id, host, username, method, privilege, session_ref, obtained_at FROM access_session WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* ignore */ }
        try { webshells.push(...db.prepare('SELECT id, url, shell_type, pass_key, privilege, status, agent FROM webshell WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* ignore */ }
        try {
          tunnels.push(...db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, command, agent FROM tunnel WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)
            .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind) })))
        } catch { /* ignore */ }
      }
    }

    /* Replay completeness: a score needs at least "steps + (a command or a vuln or a raw request)" */
    const hasCommand = steps.some((s) => String(s.tool || '').trim() !== '')
    const gaps = []
    if (steps.length === 0) gaps.push('Không có bản ghi bước tấn công (`redteam_chain_add`): không nói rõ bước này đã làm thế nào')
    else if (!hasCommand) gaps.push('Bước tấn công chưa ghi `tool` (lệnh thực tế): khi tái hiện không biết lúc đó đã gõ gì')
    if (hit.vuln_id === null || hit.vuln_id === undefined) gaps.push('Chưa liên kết `vuln_id`: báo cáo không lấy được yêu cầu gốc tương ứng')
    if (credentials.length === 0 && ['web-account-user', 'web-account-admin', 'db-access'].includes(hit.code)) {
      gaps.push('Điểm loại tài khoản nhưng chưa đăng ký thông tin xác thực (`redteam_credential_add`): không nói rõ tài khoản mật khẩu từ đâu ra')
    }
    if (['boundary', 'internal-pivot'].includes(hit.code) && tunnels.length === 0) {
      gaps.push('Điểm loại đột phá nhưng chưa đăng ký đường hầm (`redteam_tunnel_add`): không nói rõ kênh được dựng thế nào')
    }

    /* how: one line on what it was obtained with; prefer the most informative step */
    const primary = steps.find((s) => String(s.title || '').trim() !== '') || steps[0]
    let how = ''
    if (hit.vuln_id !== null && hit.vuln_id !== undefined && vuln !== null) {
      how = 'Khai thác lỗ hổng ' + (vuln.cve ? vuln.cve + ' ' : '') + (vuln.title || '') + '(' + (vuln.severity || 'unknown') + ')'
    } else if (primary !== undefined) {
      how = primary.title || ''
    }
    if (primary !== undefined && String(primary.tool || '').trim() !== '') {
      how = (how === '' ? '' : how + '; ') + 'Lệnh: ' + String(primary.tool).trim()
    }
    return {
      engagement_dir: evidenceDir,
      steps, vuln, credentials, accesses, webshells, tunnels,
      how,
      /* How steps were attributed here: linked > vuln > point > asset (fallback, in that precedence) */
      step_source: stepSource,
      evidence_refs: steps.map((s) => s.evidence_ref).filter(Boolean),
      complete: gaps.length === 0,
      gaps,
    }
  }

  /**
   * Attack score-chain replay report: only findings that actually scored, flattened into a list.
   * Each entry carries the raw request you can paste straight into Yakit Repeater when possible:
   *   ① explicitly linked vuln (score_hit.vuln_id) → that vuln's http_evidence (most accurate)
   *   ② fallback: same asset + match by target URL path (marked as auto-matched)
   *   ③ neither → evidence text only, marked missing_evidence
   *
   * Each entry also carries **"how it was obtained"** (#hitTrace): action steps (real commands + output) +
   * exploited vuln + captured creds / WebShell / tunnel — where creds came from, how the tunnel was built.
   * Entries missing steps or commands are marked incomplete and listed in the report's gaps.
   */
  scoreReport(id, options = {}) {
    const db = this.db(id)
    const meta = readMeta(this.metaPathOf(id)) || {}
    const limit = Math.min(Number(options.limit) || 500, 2000)
    const rows = db.prepare(`SELECT h.*, p.code, p.name AS point_name, p.points AS point_default, p.category,
        p.enabled AS point_enabled, p.rule AS point_rule, p.tier AS point_tier, p.cap AS point_cap,
        p.dedup_scope AS point_dedup, p.src AS point_src, p.description AS point_desc,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)

    /* Scoring basis: no cap per point type, every hit adds up (self-created accounts already filtered) */
    const perPoint = new Map()
    const eviByVuln = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)

    const clip = (t, n) => {
      const s = t === null || t === undefined ? '' : String(t)
      return s.length > n ? s.slice(0, n) + '\n… (đã cắt bớt, nội dung đầy đủ xem tệp bằng chứng)' : s
    }

    /* Which attack-chain stage each hit belongs to (same derivation rules as the chain page) */
    const scopeOf = new Map()
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v) => v !== null && v !== undefined)))
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',')
        for (const a of db.prepare(`SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`).all(...ids)) {
          scopeOf.set(a.id, a.scope)
        }
      }
    }
    /* Self-registered/self-built accounts are not findings: out of the body, only counted in the footer */
    const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1)
    /* "Disabled" points: the panel sums only enabled points (listScorePoints rule); the report must match,
       otherwise one deliverable shows two totals (e.g. web-app disabled → panel 50, report 150).
       These hits go into neither body nor total, but are still counted (the user disabled them, no rule did).
       The predicate lives below with reportRows so the two rules cannot drift. */
    /* Scoring basis and caps: **same set as listScorePoints**, else panel 6340 vs report 7930 —
       a self-contradicting deliverable is worse than a lower number.
       Capped/exceeded hits stay out of the body (not new findings), only counted in the footer. */
    /* Scoring goes through the shared implementation, **with enabledOnly**: the panel sums enabled points;
       ignoring enabled would produce the self-contradicting "panel 50, report 150" deliverable. */
    const reportMeta = loadScoreMeta(db)
    const reportNames = loadAssetNames(db)
    /* When a hit carries its own points, the hit wins (merged mode: one row spans several tiers).
       Multipliers (G5/G6) apply on the tier value — use the shared hitPointsOf so panel/report/chain agree. */
    const effPoints = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: h.code },
      new Map([[String(h.code), {
        points: (h.point_default !== undefined && h.point_default !== null
          ? Number(h.point_default) || 0
          : (reportMeta.get(h.code) || {}).points || 0),
      }]]),
    )
    const reportEval = evaluateScoreBoard(db, rows.map((h) => Object.assign({}, h, { points: effPoints(h) })),
      { meta: reportMeta, names: reportNames, enabledOnly: true })
    const capFlagById = reportEval.byId
    const isCappedRow = (h) => {
      const flag = capFlagById.get(h.id)
      return flag !== undefined && flag.capped === true
    }
    const isDisabledRow = (h) => h.point_enabled !== null && h.point_enabled !== undefined
      && Number(h.point_enabled) !== 1
    const reportRows = rows.filter((h) => Number(h.self_created) !== 1 && !isCappedRow(h) && !isDisabledRow(h))
    const serviceCappedRows = rows.filter((h) => Number(h.self_created) !== 1 && isCappedRow(h))

    const items = reportRows.map((h, i) => {
      const seen = perPoint.get(h.point_id) || 0
      perPoint.set(h.point_id, seen + 1)
      const counted = true
      /* Actual value of this hit: its own tier first (merged mode spans several), else the point default */
      const hitPoints = effPoints(h)

      /* "How it was obtained": steps + vuln + creds/entries (the report core; without it nothing ships) */
      const trace = this.#hitTrace(db, { ...h, code: h.code }, id)

      /* Raw request: take it from the explicitly linked vuln first */
      let requests = h.vuln_id === null || h.vuln_id === undefined ? [] : eviByVuln.all(h.vuln_id).map((e) => ({
        label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
        request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'linked',
      }))
      /* Fallback: same asset + degraded target path match (2 segments, then 1, then the whole authority) */
      if (requests.length === 0 && h.target) {
        const full = String(h.target).trim()
        const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full)
        const candidates = []
        if (um !== null) {
          const authority = um[2]
          const segs = (um[3] || '').split('/').filter(Boolean)
          if (segs.length >= 2) candidates.push('%' + authority + '/' + segs.slice(0, 2).join('/') + '%')
          if (segs.length >= 1) candidates.push('%' + authority + '/' + segs[0] + '%')
          candidates.push('%' + authority + '%')
          if (segs.length >= 2) candidates.push('%/' + segs.slice(0, 2).join('/') + '%')
        } else {
          const auth = full.split('/')[0].split('?')[0]
          if (auth !== '') candidates.push('%' + auth + '%')
        }
        const SQL = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3'
        const SQL_ASSET = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3'
        let rows2 = []
        if (h.asset_id !== null && h.asset_id !== undefined) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL_ASSET).all(h.asset_id, like)
            if (rows2.length > 0) break
          }
        }
        if (rows2.length === 0) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL).all(like)
            if (rows2.length > 0) break
          }
        }
        requests = rows2.map((e) => ({
          label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'auto',
        }))
      }
      /* ── Replay entry: request / command / acceptance criteria ────────────
         User feedback: "the score point does not explain how the score came about, hard to replay".
         The DB has the material: the attack step's tool is usually that curl, target is the request URL.
         This normalizes it into three things:
           · replay_cmd  — pasteable into a terminal (real curl kept verbatim, others built from URL)
           · replay_http — pasteable into Yakit Repeater (real capture if any, else synthesized)
           · confirm     — why this counts, what material to attach, where to replay from
         **Everything synthesized is marked + sourced**, so reviewers never take inference as proof. */
      const firstStepTool = (trace.steps.find((x) => String(x.tool || '').trim() !== '') || {}).tool || ''
      const parsedCurl = parseCurl(firstStepTool)
      const replayUrl = (() => {
        if (requests.length > 0 && requests[0].url) return requests[0].url
        if (parsedCurl !== null) return parsedCurl.url
        return h.target || null
      })()
      /* ── Bounds of synthesis (important) ─────────────────────────
         Synthesize an HTTP packet / curl only when this score really came from HTTP interaction.
         Without this check a service name is treated as HTTP and produces useless output:
           · target 10.20.30.40:3306 → `curl -i -s 'http://10.20.30.40:3306/'`
           · target pc-001          → `curl -i -s 'http://pc-001/'`
         Better to say plainly "this is not an HTTP entry, replay it with the template below". */
      const targetParsed = parseTarget(h.target || '')
      const schemeIsHttp = targetParsed !== null
        && (targetParsed.scheme === 'http' || targetParsed.scheme === 'https')
      /* Three signals that "this is HTTP interaction"; any one is enough */
      const isHttpEntry = parsedCurl !== null
        || (requests.length > 0 && String(requests[0].request || '').trim() !== '')
        || schemeIsHttp
      const confirm = scoreConfirmOf(h.code)

      /* ── Replay command: check what asset makes this score valid, then pick the command ──
           · real        — actually typed during the attack, and it is this HTTP interaction's curl
           · synthesized — curl built from the **real captured request** or the target URL
           · template    — the score point's own action template (asset already filled it in)
           · from_step   — real command from an attack step (may not be this step's action; labelled)
         ⚠️ Cost of wrong ordering (observed): a boundary-break entry rests on a **tunnel**, yet the same
         asset's attack steps hold the "upload Behinder shell" curl; if "steps contain a curl" is checked
         first, the report uses the upload command as the boundary replay command — wrong, running it never
         gets into the internal network. So "is this asset the replay path for this score" comes first. */
      const capturedRequest = requests.length > 0 ? String(requests[0].request || '').trim() : ''
      const capturedCurl = (() => {
        if (capturedRequest === '') return null
        const firstLine = capturedRequest.split(/\r?\n/)[0]
        const m = /^([A-Z]+)\s+(\S+)/.exec(firstLine)
        const hostLine = /^host:\s*(\S+)/im.exec(capturedRequest)
        if (m === null || hostLine === null) return null
        const scheme = /:443$/.test(hostLine[1]) ? 'https' : 'http'
        /* path is carried separately: parseTarget truncates at '?', url alone loses the query string
           (observed: `GET /_cat/indices?v` synthesized into `curl .../_cat/indices`).
           Auth and content-type headers must come too (no Basic = 401, no POST type = 415). */
        const keep = []
        for (const line of capturedRequest.split(/\r?\n/).slice(1)) {
          if (/^(authorization|content-type|accept|x-requested-with|referer):/i.test(line.trim())) keep.push(line.trim())
        }
        return { url: scheme + '://' + hostLine[1] + m[2], method: m[1], path: m[2], headers: keep }
      })()

      const tunnel0 = trace.tunnels[0] || null
      const listenPort = tunnel0 === null || !tunnel0.listen
        ? null
        : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
      const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
      const t0 = parseTarget(h.target || '')
      const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
      const templateValues = {
        host: (reach === null || reach === '' ? null : reach.replace(/\/[0-9]{1,3}$/, '')) || (t0 === null ? null : t0.host),
        port: listenPort || (t0 === null ? null : t0.port),
        user: cred0.username,
        pass: cred0.secret_value,
        url: h.target || null,
      }

      let replayCmd = null
      let replayCmdKind = null
      let replayCmdUnfilled = []
      const curlIsThisAction = commandKind(firstStepTool) === 'curl'
      /* The command recorded in the step **explicitly linked** to this row: that is what was actually typed.
         Only the explicit link (h.step_id) counts, not same-asset inferred history — the latter hangs
         the "upload Behinder shell" curl on a "cross-boundary" entry, i.e. a wrong attribution. */
      const linkedStep = (trace.steps || []).find((st) => st.id === h.step_id) || null
      const linkedTool = linkedStep === null ? '' : String(linkedStep.tool || '').trim()
      const looksLikeCommand = (t) => t.length >= 8 && /^[A-Za-z0-9_./~$-]+/.test(t) && /\s/.test(t)

      if (capturedRequest !== '' && capturedCurl !== null) {
        /* ① Real captured packet: the command-line form maps strictly to it, least misleading.
           The body is taken **only from this packet**, never from the step curl's data —
           observed `GET /_cat/indices?v` becoming `curl -d @/tmp/.b.json .../_cat/indices`. */
        const sep = capturedRequest.search(/\r?\n\r?\n/)
        const body = sep === -1 ? '' : capturedRequest.slice(sep).replace(/^\r?\n\r?\n/, '').trim()
        replayCmd = buildCurlCommand({
          url: capturedCurl.url, path: capturedCurl.path, method: capturedCurl.method,
          headers: capturedCurl.headers,
          data: body === '' ? null : body,
          cookie: parsedCurl === null ? null : parsedCurl.cookie,
        })
        replayCmdKind = 'synthesized'
      } else if (linkedTool !== '' && looksLikeCommand(linkedTool)) {
        /* ①′ Real command of this action (incl. non-curl tools: impacket / nxc / mysql / redis-cli).
             Such commands used to be dropped and replaced by the generic template (an "id; whoami; hostname"
             check phrase), so running it reproduced nothing — the most misleading spot; now kept verbatim. */
        replayCmd = linkedTool
        replayCmdKind = commandKind(linkedTool) === 'curl' ? 'real' : 'linked'
      } else if (curlIsThisAction && !(tunnel0 !== null && confirm !== null && confirm.script)) {
        /* ② Real curl, and this score does not rest on a tunnel (tunnel entries fall to ③ below) */
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (confirm !== null && confirm.script) {
        /* ③ The score point's own action template: fill it with this row's target/tunnel/creds */
        replayCmdKind = 'template'
        const filled = fillTemplate(confirm.script, templateValues)
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      } else if (curlIsThisAction) {
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (commandKind(firstStepTool) !== null) {
        /* ④ Other real commands in the steps: state honestly that it is not this step's action */
        replayCmd = firstStepTool
        replayCmdKind = 'from_step'
      }

      if (replayCmd === null && confirm && confirm.script) {
        replayCmdKind = 'template'
        /* Fill the template with what this score knows: host from target, account from attached creds.
           Placeholders that cannot be filled stay as-is and are listed — no guessing, no pretending it runs. */
        const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
        const t0 = parseTarget(h.target || '')
        /* Tunnel entries: <port> is the tunnel listen port (127.0.0.1:1080), not the port inside target.
           A boundary-break target is a reachable CIDR (10.20.30.0/24); parsing a port out of it only yields null
           and leaves a placeholder unfilled — while the real command lives in the tunnel record. */
        const tunnel0 = trace.tunnels[0] || null
        const listenPort = tunnel0 === null || !tunnel0.listen
          ? null
          : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
        const reachHost = (() => {
          const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
          if (reach === null || reach === '') return null
          return reach.replace(/\/[0-9]{1,3}$/, '')     /* 10.20.30.0/24 → 10.20.30.0 */
        })()
        const filled = fillTemplate(confirm.script, {
          host: reachHost || (t0 === null ? null : t0.host),
          port: listenPort || (t0 === null ? null : t0.port),
          user: cred0.username,
          pass: cred0.secret_value,
          url: h.target || null,
        })
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      }

      /* Raw request: real capture first; then from a real curl; else only when target has http(s):// */
      let replayHttp = null
      let replayHttpSynthesized = false
      if (requests.length > 0 && String(requests[0].request || '').trim() !== '') {
        replayHttp = requests[0].request
      } else if (parsedCurl !== null) {
        replayHttp = buildHttpRequest({
          url: parsedCurl.url, method: parsedCurl.method, data: parsedCurl.data,
          headers: parsedCurl.headers, cookie: parsedCurl.cookie,
          insecure: parsedCurl.insecure, followRedirect: parsedCurl.followRedirect,
        })
        replayHttpSynthesized = replayHttp !== null
      } else if (schemeIsHttp) {
        replayHttp = buildHttpRequest({ url: h.target, method: 'GET' })
        replayHttpSynthesized = replayHttp !== null
      }
      return {
        seq: i + 1,
        id: h.id,
        point_id: h.point_id,
        /* Explicitly linked step id: the report merges "same batch action" entries into one + ledger table.
           Must be the explicit link, not a trace-inferred step — inference drags in historical steps of the
           same asset, so a batch fails to merge (observed: 1 of 64 terminals fell out of its group). */
        step_id: h.step_id === null || h.step_id === undefined ? null : h.step_id,
        /* Score-point rule metadata (grouped table and per-entry detail show "rule N / tier / cap") */
        point_rule: h.point_rule === null || h.point_rule === undefined ? null : h.point_rule,
        point_tier: h.point_tier || '',
        point_cap: Number(h.point_cap) || 0,
        point_dedup: h.point_dedup || '',
        /* Score-point code: report entries and chain entries **must carry the same code** —
           the UI joins the two by it (report page stage-group fallback, tool side verifies by code);
           without it downstream can only fuzzy-match point_name, which breaks on any rename. */
        code: h.code || '',
        stage_code: scoreStageOf({ stage_code: h.stage_code, code: h.code, target: h.target },
          h.asset_id === null || h.asset_id === undefined ? undefined : scopeOf.get(h.asset_id)),
        point_name: h.point_name || '(mục điểm đã xóa)',
        category: h.category || '',
        points: hitPoints,
        counted: counted,
        nth_of_point: seen + 1,
        target: h.target || '',
        asset_ip: h.asset_ip || '',
        gained: h.vuln_gained || '',
        vuln: h.vuln_id === null || h.vuln_id === undefined ? null : { id: h.vuln_id, title: h.vuln_title || '', cve: h.vuln_cve || null, severity: h.vuln_severity || null },
        evidence: h.evidence || '',
        note: h.note || '',
        recorded_by: h.recorded_by || '',
        recorded_at: h.recorded_at || '',
        requests: requests,
        missing_evidence: requests.length === 0,
        /* Replay entry (new): the user can replay / self-verify with these three */
        replay_cmd: replayCmd,
        /* real / synthesized / template — wording depends on it (a template is not "copy & run") */
        replay_cmd_kind: replayCmdKind,
        /* Placeholders the template still lacks (empty array means fully filled, ready to run) */
        replay_cmd_unfilled: replayCmdKind === 'template' && replayCmdUnfilled.length > 0 ? replayCmdUnfilled : undefined,
        /* Evidence shots: representative images for this entry or group, max 3 — see #representativeShots */
        shots: [],
        replay_http: replayHttp,
        replay_http_synthesized: replayHttpSynthesized,
        /* Real capture of that day, or rebuilt from that day's command/output (follow the note if set) */
        // Model-written note: Chinese, English and Vietnamese all mean the same thing here.
    replay_http_rebuilt: requests.length > 0 && /重建|rebuil[dt]|reconstruct|按当日.*(命令|回显)|未留存原始抓包|not (?:kept|preserved)|raw capture not|dựng lại|không lưu/.test(String(requests[0].note || '')),
        /* Pasteable packet only when the target is http(s) or a real capture exists. Else an unrelated
           same-asset curl from a tunnel/DB entry becomes a packet (observed `POST / HTTP/1.1` + body `-`). */
        http_entry: isHttpEntry,
        /* Where this replay entry came from:
             linked       — real capture of an explicitly linked vuln
             auto         — real capture matched by target path (needs review)
             request      — command-line equivalent derived from a real capture
             step         — real command taken from an attack step (may not be this step's action)
             synthesized  — fully synthesized from the target URL (needs review)
             template     — the score point's own action template (filled from this row) */
        replay_source: requests.length > 0
          ? (capturedRequest !== '' ? (requests[0].source === 'linked' ? 'linked' : 'auto')
            : (replayCmdKind === 'from_step' ? 'step' : 'request'))
          : (replayCmdKind === 'from_step' ? 'step'
            : (replayCmdKind === 'template' ? 'template' : (replayCmd !== null || replayHttp !== null ? 'synthesized' : null))),
        /* Acceptance criteria / self-proof / replay entry (from SCORE_CONFIRM, looked up by code) */
        confirm: confirm,
        confirm_missing: confirm === null,
        /* How it was obtained: steps (commands + output) + vuln + creds/entries; incomplete = no replay */
        trace: trace,
        how: trace.how,
        steps: trace.steps,
        credentials: trace.credentials,
        accesses: trace.accesses,
        webshells: trace.webshells,
        tunnels: trace.tunnels,
        incomplete: trace.complete !== true,
        gaps: trace.gaps,
      }
    })

    const summary = {
      count: items.length,
      points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
      withRequests: items.filter((x) => x.requests.length > 0).length,
      autoMatched: items.filter((x) => x.requests.some((r) => r.source === 'auto')).length,
      missingRequests: items.filter((x) => x.missing_evidence).length,
      /* Replay completeness: entries with steps and a command / entries missing steps or a command */
      withSteps: items.filter((x) => x.steps.length > 0).length,
      withCommands: items.filter((x) => x.steps.some((s) => String(s.tool || '').trim() !== '')).length,
      incomplete: items.filter((x) => x.incomplete).length,
      credentials: items.reduce((n, x) => n + x.credentials.length, 0),
      tunnels: items.reduce((n, x) => n + x.tunnels.length, 0),
      /* Hits of self-registered/self-built accounts: not findings, never written into the report */
      selfCreatedExcluded: selfCreatedRows.length,
      /* Duplicate account/DB privilege hits on the same asset+port: service owned, repeats are not new */
      serviceCappedExcluded: serviceCappedRows.length,
      /* Hits whose point the user "disabled": excluded to match the panel (else the two totals differ) */
      disabledExcluded: rows.filter((h) => Number(h.self_created) !== 1 && isDisabledRow(h)).length,
      serviceCapped: serviceCappedRows.map((h) => ({
        id: h.id, point_name: h.point_name || h.code, code: h.code,
        service: serviceLabel(h), evidence: h.evidence || '', target: h.target || '',
        points: h.points || 0, recorded_at: h.recorded_at || '',
      })),
    }
    /* ── Entry merging: same point + same action (same batch of steps), only targets differ ──
       Typical case: one batch takes 60 terminals. One entry per host turns the report into a ledger
       (observed 64% of the whole text) and the reader cannot find "how this step was done". Merge into
       one entry + a target ledger table: the replay entry is written once, host counts go in the table. */
    const GROUP_MIN = Math.max(2, Number(options.groupMin) || 5)
    const stepKeyOf = (x) => (x.step_id === null || x.step_id === undefined ? '' : String(x.step_id))
    const items2 = (() => {
      const buckets = new Map()
      for (const x of items) {
        const k = x.point_id + '|' + stepKeyOf(x)
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(x)
      }
      const out = []
      const done = new Set()
      for (const x of items) {
        if (done.has(x.id)) continue
        const k = x.point_id + '|' + stepKeyOf(x)
        const members = buckets.get(k) || [x]
        done.add(x.id)
        if (members.length < GROUP_MIN || stepKeyOf(x) === '') { out.push(x); continue }
        for (const m of members) done.add(m.id)
        /* Representative entry = the one whose evidence text appears most often (mode), not the earliest:
           a few targets in a batch may use another approach (observed: first of 64 terminals used a domain
           admin account), so using it as the group description turns an exception into the norm. */
        /* Evidence text differs per host (each has its IP/hostname), so normalize digits before the mode:
           64 terminals' GPO approach normalizes to one sentence, while the first host's "domain admin account"
           exception does not — so the representative entry lands on the majority. */
        const freq = new Map()
        const norm = (t) => String(t || '').replace(/[0-9]/g, '#')
        for (const m of members) {
          const k = norm(m.evidence)
          freq.set(k, (freq.get(k) || 0) + 1)
        }
        const rep = members.slice().sort((a, b) => (freq.get(norm(b.evidence)) || 0) - (freq.get(norm(a.evidence)) || 0)
          || String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')))[0] || x
        out.push(Object.assign({}, rep, {
          is_group: true,
          group_size: members.length,
          /* Merged entry position in the chain uses "the earliest host": a batch happened once the first
             host succeeded; the representative's time makes the group drift (#12 vs #15 observed) */
          order_at: members.map((m) => String(m.recorded_at || '')).sort()[0] || rep.recorded_at,
          points: members.reduce((n, m) => n + m.points, 0),
          group_targets: members.map((m) => ({
            id: m.id, target: m.target, points: m.points, evidence: m.evidence, recorded_at: m.recorded_at,
          })),
        }))
      }
      return out
    })()

    /* ── Evidence shots: representatives per point (max 3); group entries claim with all members ──
       The image from that moment is the most convincing thing at delivery; but a batch point has dozens of
       hits, and one image per hit drowns the body, so take representatives per point. */
    /* ⚠️ Representatives are chosen by **score point**, not by entry: 6 DCs = 6 entries for one point;
       3 images per entry would repeat the same 3 images 6 times (observed: 22 entries, 58 images).
       Rule: ≤3 per point; an entry shows only those "belonging to its hits", and point-level images
       (attached to no hit) go to the point's first entry. */
    const pointHitIds = new Map()
    for (const x of items2) {
      if (!pointHitIds.has(Number(x.point_id))) pointHitIds.set(Number(x.point_id), [])
      const list = pointHitIds.get(Number(x.point_id))
      for (const hid of (x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])) {
        if (list.indexOf(hid) === -1) list.push(hid)
      }
    }
    const shotPicks = this.#representativeShots(id, Array.from(pointHitIds.entries()).map(([pid, ids]) => ({
      point_id: pid, hit_ids: ids,
    })), 3)
    const shotBriefOf = (sh) => ({
      id: Number(sh.id), url: this.shotUrlOf(id, sh), label: sh.label || '', note: sh.note || '',
      kind: sh.kind || 'screenshot', mime: sh.mime || 'image/png', bytes: Number(sh.bytes) || 0,
      width: sh.width === null || sh.width === undefined ? null : Number(sh.width),
      height: sh.height === null || sh.height === undefined ? null : Number(sh.height),
      target: sh.target || '', captured_at: sh.captured_at || '', source_ref: sh.source_ref || '',
    })
    const shotTotalByPoint = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, COUNT(*) AS n FROM shot GROUP BY point_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) shotTotalByPoint.set(Number(row.point_id), Number(row.n))
      }
    } catch { /* ignore when the old DB has no shot table */ }
    const seenPoint = new Set()
    for (const x of items2) {
      const pid = Number(x.point_id)
      const list = shotPicks.get(pid) || []
      const mine = new Set(x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])
      const own = list.filter((sh) => sh.hit_id !== null && sh.hit_id !== undefined && mine.has(Number(sh.hit_id)))
      const pointLevel = list.filter((sh) => sh.hit_id === null || sh.hit_id === undefined)
      const isFirst = !seenPoint.has(pid)
      seenPoint.add(pid)
      x.shots = own.concat(isFirst ? pointLevel : []).map(shotBriefOf)
      x.shot_total = shotTotalByPoint.get(pid) || x.shots.length
    }
    /* Image paths in the report: default to **absolute paths** (work wherever it is downloaded);
       for full-package delivery use options.shotRef='relative' so markdown uses `shots/xxx.png`,
       which travels with the shots/ dir inside the target folder. */
    const shotRefOf = (sh) => (options.shotRef === 'relative'
      ? sh.url
      : join(this.shotsDirOf(id), String(sh.url).replace(/^shots\//, '')))

    /* ── Chain ordering: stage order (recon → internet → boundary → internal → target), then action ──
       ⚠️ ordinal is the **real position in the chain**, not "the index after filtering": `listStages` says
       "UI ①②③ and report ordering both use it, do not renumber". Numbering first and then dropping empty
       stages labels stage 3 "boundary break" as ② — chain page, report page and exported markdown all go
       wrong, and once the diagram disagrees with the body the deliverable is untrustworthy. */
    const stageRows = this.listStages(id)
    const stageOrder = new Map(stageRows.map((s, i) => [s.code, i]))
    const stageOfItem = (x) => (x.stage_code && stageOrder.has(x.stage_code) ? x.stage_code : 'internet')
    const stepSeqOf = (x) => {
      const seqs = (x.steps || []).map((s) => Number(s.seq)).filter((n) => Number.isFinite(n))
      return seqs.length > 0 ? Math.min.apply(null, seqs) : Number.MAX_SAFE_INTEGER
    }
    const ordered = items2.slice().sort((a, b) => {
      const sa = stageOrder.has(stageOfItem(a)) ? stageOrder.get(stageOfItem(a)) : 99
      const sb = stageOrder.has(stageOfItem(b)) ? stageOrder.get(stageOfItem(b)) : 99
      if (sa !== sb) return sa - sb
      const ra = String(a.order_at || a.recorded_at || '')
      const rb = String(b.order_at || b.recorded_at || '')
      if (ra !== rb) return ra.localeCompare(rb)
      return stepSeqOf(a) - stepSeqOf(b)
    })
    ordered.forEach((x, i) => { x.chain_no = i + 1 })

    /* ── Dependency inference: which finding this one was built on ──────────
       Infer only from **text already in the DB**: concatenate this entry's steps (command/description/output),
       creds (source/how obtained/note) and evidence text, then look for another scoring finding's target IP —
       if present, "this one stands on that one" (e.g. DC creds from an ES chat log → DC depends on the ES entry).
       If it cannot be inferred, write nothing; invent nothing. */
    const ipOfTarget = (t) => {
      const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(t || ''))
      return m === null || m[1] === '127.0.0.1' ? null : m[1]
    }
    const ipsIn = (t) => {
      const out = []
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g
      let m
      while ((m = re.exec(String(t || ''))) !== null) if (m[1] !== '127.0.0.1') out.push(m[1])
      return out
    }
    /* Creds used here: claim credential-store records by password/account/host appearing in the evidence. */
    const credsAllForDeps = this.listCredentials(id)
    const ownsCred = (x, c) => {
      /* ⚠️ Only this entry's own evidence may decide it; trace-attached creds must **not** count:
         trace is a loose same-asset/same-host match (target 10.1.2.142 pulls every cred whose host holds
         that address), so using it concludes things like "the MySQL entry depends on the DC". */
      const text = [x.evidence, x.note, x.gained, x.target].join('\n')
      const sv = String(c.secret_value || '').trim()
      if (sv.length >= 6 && text.indexOf(sv) !== -1) return true
      const un = String(c.username || '').trim()
      /* An account must "look like an account" to be a signature; a plain word collides — a boundary entry's
         evidence said `default via 10.1.2.1`, so a Redis cred named default was claimed as its source,
         concluding "boundary break depends on Redis". Only digits/backslash/@ (IDs, domain accounts) count. */
      const accountLike = (v) => /[\d\\@]/.test(v) || v.length >= 10
      if (un.length >= 6 && accountLike(un) && text.indexOf(un) !== -1) {
        /* Accounts are shared (one domain admin appears in dozens of evidences), so the host must match too:
           the cred host is this row's target, or the cred host string appears in this row's evidence. */
        const cip = ipOfTarget(c.host)
        if (cip === null) return true
        return cip === ipOfTarget(x.target) || text.indexOf(cip) !== -1
      }
      /* Do not claim via "the cred host appears in the evidence": target 10.1.2.142's evidence naturally
         contains it, which would count every config-leak cred on that host as used here (observed concluding
         "the MySQL entry depends on the DC"). Only password/account-style **signatures** count. */
      return false
    }
    /* Dependency candidates = addresses named in this evidence + **source pointers of claimed creds**.
       The "first IP" in a cred's tool/note is usually where the password/access came from
       (e.g. "password retrieved from ES at 10.1.2.163:9200" → source is that ES;
       "smbclient //10.1.2.5/SYSVOL fetched startup script" → source is the DC).
       Only the first IP is taken for precision: the tool field often mentions other assets later,
       and taking all turns "RabbitMQ password from app config" into "this depends on RabbitMQ". */
    for (const x of ordered) {
      /* Strong signal: where the creds used here came from (first IP in the cred's tool/note).
         Weak signal: addresses mentioned in passing in this evidence (a boundary entry lists whole CIDRs,
                 and using that as a dependency basis yields noise like "boundary break depends on Redis").
         Take strong signals first; only fill up to 3 with weak ones. */
      const strong = new Set()
      for (const c of credsAllForDeps.filter((v) => ownsCred(x, v))) {
        const a = ipOfTarget(c.tool)
        const b = ipOfTarget(c.note)
        if (a !== null) strong.add(a)
        if (b !== null) strong.add(b)
      }
      const weakText = [x.evidence, x.note, x.target].join('\n')
      const weak = new Map()
      for (const ip of ipsIn(weakText)) weak.set(ip, (weak.get(ip) || 0) + 1)
      /* Weak signals sorted by "how often this evidence mentions them": the most mentioned is usually this
         finding's key target (a boundary entry lists a whole CIDR, so document order hits irrelevant entries). */
      const pick = (get, size) => {
        const out = []
        for (const y of ordered) {
          if (y === x || y.point_id === x.point_id) continue
          const ip = ipOfTarget(y.target)
          if (ip === null || get(ip) === undefined) continue
          out.push({ y: y, w: size(ip) })
        }
        out.sort((a, b) => b.w - a.w)
        return out.slice(0, 3).map((v) => v.y)
      }
      const deps = pick((ip) => (strong.has(ip) ? 1 : undefined), () => 1)
      if (deps.length < 3) {
        for (const y of pick((ip) => weak.get(ip), (ip) => weak.get(ip) || 0)) {
          if (deps.length >= 3) break
          if (deps.indexOf(y) === -1) deps.push(y)
        }
      }
      x.deps = deps.map((y) => ({ no: y.chain_no, name: y.code, short: y.code, target: y.target }))
        .sort((a, b) => a.no - b.no)
      x._depIds = deps.map((y) => y.id)
    /* Channel requirement: findings beyond the internet side rest on a "channel" (tunnel / owned entry) */
      x.needs_channel = stageOfItem(x) !== 'internet' && (x.tunnels || []).length > 0
    }
    /* Drop mutually dependent pairs (e.g. DC 445 and DC 389 share an IP and would point at each other):
       the report may omit a dependency, but must never show "A depends on B, B depends on A". */
    for (const x of ordered) {
      const kept = (x.deps || []).filter((d) => {
        const y = ordered.find((v) => v.chain_no === d.no)
        return y === undefined || (y._depIds || []).indexOf(x.id) === -1
      })
      x.deps = kept
    }
    for (const x of ordered) delete x._depIds

    /* ── Replay classification: pasteable packet vs command line, and how the index table marks it ──
       · http    — real capture, or an HTTP entry whose packet can be rebuilt → replays in Burp / Yakit
       · cli     — real command (typed that day) → runs in a terminal (non-HTTP; Burp/Yakit can't)
       · method  — only the point's standard replay action (no saved command) → state it, forge nothing */
    const looksLikeHttpTarget = (t) => /^https?:\/\//i.test(String(t || '').trim())
    for (const x of ordered) {
      const captured = x.requests.length > 0 && String(x.requests[0].request || '').trim() !== ''
      /* ⚠️ Give a packet only when the target itself is http(s) or a real capture exists. Else an unrelated
         same-asset curl from a tunnel/DB entry becomes a packet (observed `POST / HTTP/1.1` with body `-`:
         a fake packet that replays nothing in Yakit). */
      const httpOk = (captured
        || (looksLikeHttpTarget(x.target) && x.replay_http !== null && x.replay_http !== undefined))
      /* Command: real first; a template counts as "runnable" only when every placeholder is filled */
      const unfilled = x.replay_cmd_unfilled || []
      const cmdOk = x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== ''
        && (x.replay_cmd_kind !== 'template' || unfilled.length === 0)
      x.repro_kind = httpOk ? 'http' : (cmdOk ? 'cli' : 'method')
      x.repro_http_captured = captured
      /* Replay note for non-HTTP protocols (Burp/Yakit cannot send SMB/DB/NFS, say why) */
      const cmd = String(x.replay_cmd || '')
      x.repro_nonhttp = x.repro_kind === 'cli'
        && /atexec|nxc |smbclient|impacket|secretsdump|mysql|redis-cli|showmount|mount |winrm|proxychains/.test(cmd)
    }

    /* Stage buckets (UI and body share): bucketed entries are **merged** ones, values are merged totals */
    let cumulative = 0
    const stages = stageRows.map((st) => {
      const sItems = ordered.filter((x) => stageOfItem(x) === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0)
      cumulative += pts
      return { code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
        ordinal: st.ordinal, points: pts, cumulative: cumulative, items: sItems }
    }).filter((st) => st.items.length > 0)

    /* ── markdown: for copy/download, and for the agent to deliver directly ──
       Structure follows "the user will replay from this", not "how completely we logged it":
         ⓪ summary and reconciliation + replay index table (the reviewer reads this first)
         ① replay preconditions (channel / creds / tool access / tool capability limits)
         ② attack chain (in dependency order, dependencies marked)
         ③ per-entry detail (replay entry first, target ledger, evidence index)
         ④ score point notes (acceptance criteria stated once, not repeated per entry)
         ⑤ appendix (assets, records and score reconciliation)
       ⚠️ Two length rules: keep request bodies intact (Yakit must replay them; truncation kills it);
       response bodies are only for verification, clipped to 1000 chars with the length noted. */
    const targetName = (meta && meta.target_name) || id
    const layout = options.layout === 'legacy' ? 'legacy' : 'simple'
    if (layout === 'simple') {
      const report = buildReportV2(this, id, ordered, stages, summary, targetName, options)
      return {
        items: items2, stages, summary, report,
        markdown: renderTemplateReport(report, options),
        target: targetName, layout: 'simple',
      }
    }
    const md = []
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
    const AGENT_LABEL = (a) => ROLE_TITLES[a] || a || 'Chưa gắn vai trò'
    const oneLine = (t, n) => String(t === null || t === undefined ? '' : t).replace(/\s*\n+\s*/g, ' ').trim().slice(0, n || 300)
    const shortName = (x) => POINT_SHORT_NAME[x.code] || x.point_name || x.code
    /* Early records wrote `->` as `-&gt;` (form escape residue); restore it or targets are unreadable */
    /* Merged entries show only "first host + host count", else a 64-host list blows up the index table */
    const targetBrief = (x) => (x.is_group
      ? String(x.target || '') + ' và ' + x.group_size + ' mục tiêu'
      : unesc(x.target))
    const unesc = (t) => String(t === null || t === undefined ? '' : t)
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    const block = (lang, text) => { md.push('```' + lang, String(text).replace(/\r/g, '').trim(), '```', '') }
    /* Cut at sentence/clause boundaries: a raw slice yields halves like "…backend is 3 LB polling(" */
    const clipText = (t, n) => {
      const s0 = oneLine(t, n)
      if (s0.length < n) return s0
      // Both punctuation sets: notes are model-written, and a model may answer in
      // Vietnamese, English or Chinese regardless of the prompt's language. Dropping
      // the full-width forms would make a Chinese note clip mid-sentence.
      for (const sep of ['. ', '; ', ')', ', ', '。', '；', '）', '，']) {
        const i = s0.lastIndexOf(sep)
        if (i > n * 0.5) return s0.slice(0, i + 1)
      }
      return s0
    }
    const httpCount = ordered.filter((x) => x.repro_kind === 'http').length
    const cliCount = ordered.filter((x) => x.repro_kind === 'cli').length
    const methodCount = ordered.filter((x) => x.repro_kind === 'method').length

    md.push('# ' + targetName + ' · Báo cáo tái hiện kết quả red-team', '')
    md.push('> Báo cáo này chỉ gồm **kết quả đã ghi điểm**: mỗi mục nêu điểm vào tái hiện (gói tin gốc có thể dán thẳng vào Burp / Yakit, '
      + 'hoặc dòng lệnh thực thi qua đường hầm), tiêu chí xác định thành công và chỉ mục bằng chứng, đồng thời sắp xếp theo **thứ tự phụ thuộc** của chuỗi tấn công và ghi rõ tiên quyết.', '')

    /* ── ⓪ summary and reconciliation ──────────────────── */
    md.push('## 0. Tóm tắt và đối chiếu', '')
    const shotItems = ordered.filter((x) => (x.shots || []).length > 0)
    const shotTotal = ordered.reduce((n, x) => n + (x.shots || []).length, 0)
    const shotReal = ordered.reduce((n, x) => n + (x.shots || []).filter((v) => v.kind !== 'card').length, 0)
    md.push('| Tổng điểm | Mục tính điểm | Dán thẳng được vào Burp/Yakit | Tái hiện bằng dòng lệnh | Cách khác | Ảnh chụp bằng chứng |', '| --- | --- | --- | --- | --- | --- |')
    md.push('| **' + summary.points + ' điểm** | ' + ordered.length + ' mục | ' + httpCount
      + ' mục | ' + cliCount + ' mục | ' + methodCount + ' mục | ' + shotTotal + ' ảnh / ' + shotItems.length
      + ' dòng nội dung' + (shotReal < shotTotal ? '(ảnh chụp tại chỗ ' + shotReal + ' ảnh, phần còn lại là trích đoạn bằng chứng sinh từ bản ghi)' : '') + ' |', '')
    md.push('### 0.1 Mức chiếm dụng mục điểm', '')
    md.push('| Mục điểm | Số lần trúng | Điểm lần này | Giới hạn mỗi mục |', '| --- | --- | --- | --- |')
    const byPoint = new Map()
    for (const x of ordered) {
      const k = x.code
      if (!byPoint.has(k)) byPoint.set(k, { code: k, name: shortName(x), hits: 0, points: 0, cap: x.point_cap })
      const rec = byPoint.get(k)
      rec.hits += x.is_group ? x.group_size : 1
      rec.points += x.points
    }
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      md.push('| ' + rec.name + '(`' + rec.code + '`) | ' + rec.hits + ' | +' + rec.points + ' điểm | '
        + (Number(rec.cap) > 0 ? Number(rec.cap) + ' điểm' + (rec.points >= Number(rec.cap) ? '(đã đầy)' : '') : '—') + ' |')
    }
    md.push('')
    md.push('### 0.2 Đối chiếu bản ghi và điểm', '')
    md.push('- Bản ghi điểm trong kho **' + rows.length + ' bản ghi** → trúng tính điểm **' + summary.count + ' bản ghi**'
      + ' → sau khi gộp các mục cùng hành động, nội dung **' + ordered.length + ' bản ghi** (một hành động hàng loạt ghi một mục + bảng kê mục tiêu)'
      + '; ngoài ra còn **' + (summary.selfCreatedExcluded + summary.serviceCappedExcluded + summary.disabledExcluded)
      + ' bản ghi** chưa tính điểm (xem dưới).')
    if (summary.serviceCappedExcluded > 0) {
      md.push('- Lý do loại trừ: tài khoản/quyền cơ sở dữ liệu trùng cùng tài sản cùng cổng ' + summary.serviceCappedExcluded
        + ' bản ghi (cùng một dịch vụ đạt quyền cao nhất là tính đủ, trùng lặp không cộng thêm, xem phụ lục 5.2).')
    }
    if (summary.selfCreatedExcluded > 0) md.push('- Lý do loại trừ: tài khoản tự đăng ký/tự tạo ' + summary.selfCreatedExcluded + ' bản ghi (điểm nhắm vào việc lấy được quyền mà người khác đã có).')
    if (summary.disabledExcluded > 0) md.push('- Lý do loại trừ: mục điểm tương ứng đã bị tắt ' + summary.disabledExcluded + ' bản ghi.')
    const corrected = reportRows.filter((h) => /校正/.test(String(h.note || '')))
    if (corrected.length > 0) {
      md.push('')
      md.push('> **Hiệu chỉnh bậc**: ' + corrected.length + ' bản ghi sau đây đã được hạ bậc khi rà soát chốt sổ,'
        + 'điểm số trong bảng dưới là giá trị **sau hiệu chỉnh** (giá trị gốc trên bảng điều khiển 16180, sau hiệu chỉnh 16090):', '')
      for (const h of corrected) {
        md.push('- `' + (h.target || '') + '` ' + (h.point_name || h.code) + ' → **' + (h.points || 0) + ' điểm** '
          + oneLine(h.note, 200))
      }
    }
    md.push('')
    md.push('### 0.3 Chỉ mục tái hiện', '')
    md.push('| # | Mục điểm | Điểm số | Mục tiêu | Tiên quyết | Điểm vào tái hiện |', '| --- | --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no).join(', ')
      const entry = x.repro_kind === 'http' ? 'Gói tin Burp / Yakit (§3.' + x.chain_no + ')'
        : (x.repro_kind === 'cli' ? 'Dòng lệnh (§3.' + x.chain_no + ')' : 'Cách tái hiện (§3.' + x.chain_no + ')')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? 'Kênh (§1.1)' : '—') : dep) + ' | ' + entry + ' |')
    }
    md.push('')

    /* ── ① replay preconditions ────────────────────────── */
    const tunnelsAll = this.listTunnels(id)
    const shellsAll = this.listWebshells(id)
    const credsAll = credsAllForDeps
    /* "Creds used here" via ownsCred (password/account in evidence) + creds hosted on a scored target.
       Not the trace-attached batch: a loose same-asset match that would list unrelated endpoint tokens. */
    const scoredHosts = new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null))
    const referencedCred = new Set()
    for (const x of ordered) for (const c of credsAll.filter((v) => ownsCred(x, v))) referencedCred.add(String(c.id))
    for (const c of credsAll) {
      const ip = ipOfTarget(c.host)
      if (ip !== null && scoredHosts.has(ip)) referencedCred.add(String(c.id))
    }
    const credRank = (c) => {
      const p = String(c.privilege || '')
      if (/domain-admin/.test(p)) return 0
      if (/local-admin|domain-admin|admin/.test(p)) return 1
      if (/db-|redis|mysql|system/.test(p)) return 2
      if (/sso|sharekey|api/.test(p)) return 3
      return 9
    }
    /* Drop candidates whose record says "not verified / reference only": not replayable, only misleading */
    // Negation markers, in the three languages a note may be written in.
  const unusable = /未通过|未验证|仅留档|不可作为有效凭据|unknown|failed|unverified|not verified|reference only|không dùng được|chưa xác minh|chỉ lưu|không hợp lệ/i
  const usablePool = credsAll.filter((c) => !unusable.test(String(c.note || '') + String(c.privilege || '')))
    const usefulCreds = usablePool
      .filter((c) => referencedCred.has(String(c.id)))
      .slice()
      .sort((a, b) => (referencedCred.has(String(b.id)) ? 1 : 0) - (referencedCred.has(String(a.id)) ? 1 : 0)
        || credRank(a) - credRank(b))
      .slice(0, 12)
    md.push('---', '')
    md.push('## 1. Điều kiện tiên quyết để tái hiện', '')
    md.push('> Dựng xong phần này trước thì điểm vào tái hiện của từng mục phía sau mới chạy được.', '')
    md.push('### 1.1 Kênh', '')
    if (tunnelsAll.length === 0) {
      md.push('Mục tiêu này chưa đăng ký đường hầm; các mục nội bộ cần tự chuẩn bị kênh tới mục tiêu.', '')
    } else {
      for (const t of tunnelsAll) {
        md.push('- **' + (t.kind || 'Đường hầm') + '**: lắng nghe `' + (t.listen || '') + '` điểm vào `' + (t.entry || '') + '`'
          + (t.entry_kind ? '(entry_kind=' + t.entry_kind + ')' : '')
          + (t.reach ? ' tới được ' + t.reach : '')
          + (String(t.status || '') !== '' ? ' trạng thái ' + t.status : ''))
        if (t.command) md.push('  - Lệnh khởi động: ')
        if (t.command) block('bash', t.command)
        if (t.note) md.push('  - Ghi chú: ' + clipText(t.note, 320))
      }
    }
    if (shellsAll.length > 0) {
      md.push('')
      md.push('**Điểm vào WebShell / phiên**', '')
      for (const w of shellsAll) {
        md.push('- `' + (w.url || '') + '` ' + (w.shell_type || '') + (w.pass_key ? ' mật khẩu kết nối `' + w.pass_key + '`' : '')
          + (String(w.status || '') !== '' ? ' trạng thái ' + w.status : '') + (w.note ? ' ' + clipText(w.note, 200) : ''))
      }
      md.push('')
    }
    md.push('### 1.2 Thông tin xác thực', '')
    if (usefulCreds.length === 0) {
      md.push('Mục tiêu này chưa đăng ký thông tin xác thực.', '')
    } else {
      md.push('| Mục tiêu | Tài khoản | Quyền | Nguồn | Cách lấy được |', '| --- | --- | --- | --- | --- |')
      for (const c of usefulCreds) {
        md.push('| `' + oneLine(c.host, 40) + '` | `' + oneLine(c.username, 40) + '` | ' + oneLine(c.privilege || '—', 30)
          + ' | ' + oneLine(c.source || '—', 40) + ' | `' + oneLine(c.tool || '—', 120) + '` |')
      }
      md.push('')
    }
    md.push('### 1.3 Kết nối công cụ', '')
    md.push('- **Burp Suite**: Settings → Network → Connections → SOCKS proxy điền `127.0.0.1:<cổng đường hầm>`,'
      + 'và tích "Use SOCKS proxy for DNS lookups"; trong Repeater dán nguyên đoạn gói tin của báo cáo này là được.', '')
    md.push('- **Yakit**: cấu hình cùng một SOCKS5 (kèm xác thực) ở "proxy hạ nguồn / proxy chuỗi",'
      + '"Repeater → dán yêu cầu gốc" rồi gửi.', '')
    md.push('- **Dòng lệnh**: gắn tiền tố `proxychains4 -q -f <cấu hình proxychains>` trước các lệnh impacket / nxc / smbclient / mysql / redis-cli...;'
      + 'Với HTTP cũng có thể dùng `curl --socks5-hostname <tài khoản>:<mật khẩu>@127.0.0.1:<cổng>`.', '')
    md.push('### 1.4 Giới hạn năng lực công cụ', '')
    md.push('| Loại mục tiêu | Giao thức | Công cụ khuyến nghị |', '| --- | --- | --- |')
    md.push('| Ứng dụng Web, quản trị backend, REST API (kể cả nội bộ) | HTTP / HTTPS | Burp Suite, Yakit (qua SOCKS thượng nguồn) |')
    md.push('| WebShell / đường hầm | HTTP / WebSocket | Behinder, Godzilla, suo5 (xem §1.1) |')
    md.push('| Máy chủ Windows, domain controller, chia sẻ | SMB / RPC / WinRM | `impacket-atexec`, `nxc`, `smbclient`, `evil-winrm`, pywinrm (qua proxychains) |')
    md.push('| Cơ sở dữ liệu | MySQL / Redis / PostgreSQL | `mysql`, `redis-cli`, `psql` (qua proxychains) |')
    md.push('| Chia sẻ tệp | NFS | `showmount`, `mount -t nfs4` (qua proxychains hoặc máy bị kiểm soát) |')
    md.push('')
    md.push('> Burp / Yakit chỉ phát lại được HTTP(S) và WebSocket. Các giao thức như SMB, WinRM, cơ sở dữ liệu, NFS'
      + 'hãy tái hiện bằng dòng lệnh theo bảng trên — mục tương ứng trong báo cáo đưa đúng lệnh chạy được ngay.', '')

    /* ── ② attack chain (in dependency order) ─────────── */
    md.push('---', '')
    md.push('## 2. Chuỗi tấn công (theo thứ tự phụ thuộc)', '')
    md.push('> Số thứ tự chính là thứ tự tài liệu (theo giai đoạn chuỗi tấn công ① → ⑤, trong giai đoạn theo thời điểm đạt được). Cột `Tiên quyết` ghi "kết quả phải làm trước bước này";'
      + 'việc chia nhóm theo giai đoạn sắp xếp cố định theo loại mục điểm, nên số của tiên quyết **có thể lớn hơn mục này** (ví dụ: đột phá xuyên biên giới phụ thuộc việc chiếm domain controller trước, #16),'
      + 'cứ nhảy theo số mà xem.', '')
    md.push('| # | Mục điểm | Điểm số | Mục tiêu | Tiên quyết |', '| --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)).join(', ')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? 'Kênh (§1.1)' : '—') : dep) + ' |')
    }
    md.push('')
    for (const st of stages) {
      md.push('- ' + st.name + ': ' + st.items.length + ' mục · +' + st.points + ' điểm (tích lũy +' + st.cumulative + ' điểm)')
    }
    md.push('')

    /* ── ③ per-entry detail ───────────────────────────── */
    md.push('---', '')
    md.push('## 3. Chi tiết từng mục', '')
    md.push('> Sắp theo giai đoạn chuỗi tấn công ① → ⑤ (số giai đoạn chính là vị trí thật trong chuỗi); trong giai đoạn sắp theo thứ tự hành động,'
      + 'số `3.N` tương ứng một-một với chỉ mục tái hiện phía trên.', '')
    let lastStage = null
    for (const x of ordered) {
      const st = stageOfItem(x)
      if (st !== lastStage) {
        lastStage = st
        const sr = stages.find((v) => v.code === st)
        if (sr !== undefined) {
          const circled = (CIRCLED[sr.ordinal - 1] || '')
          md.push('## ' + circled + ' ' + sr.name + ' (' + sr.items.length + ' mục · +' + sr.points + ' điểm)', '')
        }
      }
      const depTxt = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)
        + '(`' + oneLine(d.target, 40) + '`)').join(', ')
      md.push('### 3.' + x.chain_no + ' ' + shortName(x) + ' · `' + oneLine(targetBrief(x), 80) + '` **+' + x.points + ' điểm**', '')
      md.push('- **Mục điểm**: ' + (x.point_name || '') + ' `' + x.code + '`'
        + (x.point_rule ? ' quy tắc ' + x.point_rule : '')
        + (x.point_tier ? ' bậc ' + oneLine(x.point_tier, 40) : '')
        + (Number(x.point_cap) > 0 ? ' giới hạn mỗi mục ' + x.point_cap + ' điểm' : ''))
      if (x.is_group) md.push('- **Mục này gồm ' + x.group_size + ' mục tiêu** (cùng một hành động trúng hàng loạt, danh sách từng máy xem bảng kê bên dưới)')
      if (x.gained) md.push('- **Lấy được**: ' + oneLine(x.gained, 120))
      if (x.is_group) {
        const list = (x.group_targets || []).map((g) => '`' + g.target + '`')
        md.push('- **Kết quả**: cùng một hành động trên ' + x.group_size + ' mục tiêu đều đạt cùng kết quả ('
          + list[0] + ' … ' + list[list.length - 1] + '), phản hồi từng máy xem bảng dưới và chỉ mục bằng chứng')
      } else if (x.evidence) {
        md.push('- **Kết quả**: ' + oneLine(x.evidence, 400))
      }
      if (x.confirm && x.confirm.need) md.push('- **Tiêu chí xác định**: ' + oneLine(x.confirm.need, 160))
      md.push('- **Tiên quyết**: ' + (depTxt !== '' ? depTxt : (x.needs_channel ? 'kênh (xem §1.1)' : 'không có (điểm đầu chuỗi)')))
      md.push('')

      /* Replay entry: ① HTTP packet (pasteable) ② command line ③ replay method note */
      md.push('#### Tái hiện', '')
      if (x.repro_kind === 'http') {
        const lead = (x.repro_http_captured && x.replay_http_rebuilt !== true)
          ? '**Gói tin gốc** (bắt gói thật trong ngày, sao chép nguyên đoạn → Burp Repeater / Yakit "dán yêu cầu gốc" → gửi)'
          : (x.repro_http_captured
              ? '**Gói tin dựng lại** (yêu cầu trong ngày không được lưu từng byte; bản này dựng lại theo lệnh và phản hồi trong ngày, các trường đã điền theo mục tiêu và thông tin xác thực)'
              : '**Gói tin tương đương** (dựng lại theo lệnh thực tế trong ngày; không lưu bắt gói gốc, các trường đã điền theo mục tiêu và thông tin xác thực)')
        md.push(lead + ': ', '')
        block('http', x.replay_http)
        if (x.requests.length > 0 && x.requests[0].response) {
          const full = String(x.requests[0].response)
          md.push('**Phản hồi phía máy chủ** (' + (x.requests[0].status === null || x.requests[0].status === undefined
            ? 'trạng thái không được ghi' : 'HTTP ' + x.requests[0].status) + '): ', '')
          md.push('```http', full.replace(/\r/g, '').trim().slice(0, 1000)
            + (full.length > 1000 ? '\n… (phản hồi tổng ' + full.length + ' ký tự, nội dung đầy đủ xem kho bằng chứng)' : ''), '```', '')
        }
        if (x.requests.length > 1) md.push('> Ngoài ra còn ' + (x.requests.length - 1) + ' gói tin bằng chứng, xem kho bằng chứng.', '')
        /* Also give the curl equivalent of the same action: some run commands, some use Repeater */
        if (x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== '') {
          md.push('**Dạng dòng lệnh tương đương** (khớp với gói tin ở trên):', '')
          block('bash', x.replay_cmd)
        }
      }
      if (x.repro_kind === 'cli') {
        const lead = (x.replay_cmd_kind === 'real' || x.replay_cmd_kind === 'linked')
          ? '**Dòng lệnh** (lệnh thực tế đã chạy trong ngày cho hành động này, chạy lại được ngay)'
          : (x.replay_cmd_kind === 'synthesized' ? '**Dạng dòng lệnh tương đương** (suy ra từ gói tin ở trên, địa chỉ và phương thức khớp với gói tin)'
            : '**Dòng lệnh** (lấy từ bước tấn công trong ngày)')
        md.push(lead + ': ', '')
        block('bash', x.replay_cmd)
        if (x.repro_nonhttp) {
          md.push('> Hành động này đi qua giao thức SMB / RPC / cơ sở dữ liệu / chia sẻ tệp, Burp và Yakit không phát lại trực tiếp được;'
            + 'hãy làm theo §1.3, gắn proxychains vào đường hầm rồi thực thi.', '')
        }
      }
      if (x.repro_kind === 'method') {
        md.push('**Cách tái hiện**: ' + ((x.confirm && x.confirm.replay)
          ? oneLine(x.confirm.replay, 200)
          : 'Theo tiêu chí xác định của mục điểm này, tái hiện cùng hành động trên mục tiêu và lưu lại phản hồi.'), '')
        if ((x.steps || []).length > 0) {
          md.push('> Điểm chính của hành động trong ngày xem "đã làm thế nào" bên dưới; lệnh không được lưu riêng, có thể phát lại hành động đó trên mục tiêu.', '')
        }
      }

      /* Evidence shots: an image beats ten lines; kind=card must say "generated", never fake a live shot */
      if ((x.shots || []).length > 0) {
        const shotNote = []
        if (x.shot_total > x.shots.length) shotNote.push('Mục điểm này có tổng ' + x.shot_total + ' ảnh, ở đây lấy ảnh đại diện ' + x.shots.length + ' ảnh')
        if (x.is_group) shotNote.push('Nhóm này ' + x.group_size + ' mục tiêu')
        md.push('**Ảnh chụp bằng chứng**' + (shotNote.length > 0 ? '(' + shotNote.join('; ') + ')' : '') + ': ', '')
        for (const sh of x.shots) {
          const alt = String(sh.label || ('Bằng chứng ' + sh.id)).replace(/[\[\]]/g, '')
          md.push('![' + alt + '](' + shotRefOf(sh) + ')', '')
          const cap = []
          if (sh.label) cap.push(sh.label)
          else if (sh.target) cap.push('`' + sh.target + '`')
          if (sh.kind === 'card') cap.push('**Trích đoạn bằng chứng sinh từ bản ghi trong ngày (không phải ảnh chụp tại chỗ)**')
          if (sh.captured_at) cap.push(String(sh.captured_at).replace('T', ' ').slice(0, 16))
          if (sh.source_ref) cap.push('Tệp gốc `' + oneLine(sh.source_ref, 120) + '`')
          if (sh.note) cap.push(oneLine(sh.note, 160))
          if (cap.length > 0) md.push('> ' + cap.join(' · '), '')
        }
        md.push('')
      } else if (Number(x.shot_total) > 0) {
        /* This entry got no representative (the point's images already shown above) — say where to look */
        md.push('> Ảnh chụp bằng chứng của mục này xem ảnh đại diện của mục điểm đó (cùng một mục điểm có tổng ' + x.shot_total + ' ảnh, báo cáo mỗi mục điểm hiển thị tối đa 3 ảnh).', '')
        md.push('')
      }

      /* Target ledger (merged entries): one row per host, with per-host evidence */
      if (x.is_group) {
        md.push('**Bảng kê mục tiêu (' + x.group_size + ' máy, phản hồi từng máy xem chỉ mục bằng chứng)**', '')
        md.push('| # | Mục tiêu | Kết quả | Tính điểm |', '| --- | --- | --- | --- |')
        const brief = (ev) => {
          const m = /（([^）]{1,60})）/.exec(String(ev || ''))
          if (m !== null) return oneLine(m[1], 60)
          return oneLine(ev, 80)
        }
        ;(x.group_targets || []).forEach((g, gi) => {
          md.push('| ' + (gi + 1) + ' | `' + g.target + '` | ' + brief(g.evidence) + ' | +' + g.points + ' |')
        })
        const extra = summary.serviceCapped.filter((c) => c.code === x.code)
        if (extra.length > 0) {
          md.push('')
          md.push('> Ngoài ra còn ' + extra.length + ' máy đạt cùng mức quyền nhưng không tính điểm vì **giới hạn mỗi mục** (lưu vết): '
            + extra.map((c) => '`' + c.target + '`').join(', ') + ', xem phụ lục 5.2.', '')
        }
        md.push('')
      }

      /* How it was done: action steps (with real commands and output) */
      const evFiles = Array.from(new Set((x.steps || []).map((s) => String(s.evidence_ref || '').trim()).filter((v) => v !== '')))
      if ((x.steps || []).length > 0 || x.how || x.vuln || evFiles.length > 0) {
        md.push('#### Bản ghi hành động', '')
        if (x.how) md.push('> ' + oneLine(x.how, 240), '')
        ;(x.steps || []).forEach((s, si) => {
          md.push('**' + (si + 1) + '. ' + oneLine(s.title || '(hành động chưa đặt tên)', 80) + '**'
            + (s.agent ? ' — ' + AGENT_LABEL(s.agent) : '')
            + (s.inferred ? ' · (suy theo cùng tài sản)' : ''))
          if (s.detail) md.push('- ' + oneLine(s.detail, 400))
          if (s.result) md.push('- Phản hồi: ' + oneLine(s.result, 300))
          if (s.tool && String(s.tool).trim() !== String(x.replay_cmd || '').trim()) {
            md.push('- Lệnh: ')
            md.push('  ```bash', '  ' + String(s.tool).replace(/\r/g, '').trim().slice(0, 1500), '  ```')
          }
          if (s.evidence_ref) md.push('- Bằng chứng: `' + oneLine(s.evidence_ref, 200) + '`')
        })
        md.push('')
      }
      /* Keep only the creds "this entry really used": trace attaches all same-asset creds,
         which is a loose view for the UI; listing unrelated endpoint tokens here only undermines credibility. */
      const itemCreds = credsAll.filter((c) => ownsCred(x, c)
        || (ipOfTarget(c.host) !== null && ipOfTarget(c.host) === ipOfTarget(x.target)))
      if (itemCreds.length > 0) {
        md.push('**Thông tin xác thực**: ' + itemCreds.map((c) => '`' + (c.host || '') + '` ' + (c.username || '—')
          + (c.privilege ? '(' + c.privilege + ')' : '') + ' nguồn: ' + (c.source || 'chưa ghi')).join('<br>'), '')
      }
      if ((x.webshells || []).length > 0) {
        md.push('**WebShell**: ' + x.webshells.map((w) => '`' + (w.url || '') + '` ' + (w.shell_type || '')
          + (w.pass_key ? ' khóa `' + w.pass_key + '`' : '')).join('<br>'), '')
      }
      if ((x.tunnels || []).length > 0) {
        md.push('**Kênh**: ' + x.tunnels.map((t) => '`' + (t.kind || '') + '` lắng nghe `' + (t.listen || '')
          + '`').join('<br>'), '')
      }
      const meta2 = []
      if (x.vuln) meta2.push('Lỗ hổng ' + (x.vuln.cve ? x.vuln.cve + ' ' : '') + oneLine(x.vuln.title, 80))
      if (x.recorded_at) meta2.push('đạt được ' + String(x.recorded_at).replace('T', ' ').slice(0, 16)
        + (x.recorded_by ? '(' + AGENT_LABEL(x.recorded_by) + ')' : ''))
      if (Number(x.point_cap) > 0) {
        const used = byPoint.get(x.code) ? byPoint.get(x.code).points : x.points
        meta2.push('Mục điểm này đã dùng ' + used + '/' + x.point_cap + ' điểm')
      }
      if (meta2.length > 0) md.push('> ' + meta2.join(' · '), '')
      md.push('')
    }

    /* ── ④ score point notes (acceptance criteria stated once) ────── */
    md.push('---', '')
    md.push('## 4. Giải thích mục điểm', '')
    md.push('> Phần nội dung không lặp lại các tiêu chí này từng mục. Quy tắc chung: quyền lấy cao nhất chỉ tính một lần (G1), kết quả dữ liệu tính điểm riêng (G2),'
      + 'giới hạn áp cho từng đơn vị phòng thủ (G3), thiết bị đầu cuối và thiết bị tính điểm theo máy (G4), tài liệu chứng minh theo G7.', '')
    md.push('| Mục điểm | Quy tắc / bậc | Tiêu chí xác định | Tài liệu cần kèm | Hành động tái hiện chuẩn |', '| --- | --- | --- | --- | --- |')
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      const c = scoreConfirmOf(rec.code) || {}
      const sample = ordered.find((x) => x.code === rec.code) || {}
      md.push('| ' + rec.name + '(`' + rec.code + '`) | '
        + (sample.point_rule ? 'quy tắc ' + sample.point_rule + ' ' : '') + oneLine(sample.point_tier || '—', 50) + ' | '
        + oneLine(c.need || '—', 160) + ' | ' + oneLine(c.proof || '—', 160) + ' | '
        + '`' + oneLine(c.replay || '—', 140) + '` |')
    }
    md.push('')

    /* ── ⑤ appendix ───────────────────────────────────── */
    /* Asset list for reconciliation: assets attached by hits/steps ∪ **assets of scored target IPs**.
       The latter is essential — most hits record a "target address" without asset_id, so collecting by
       asset_id alone leaves a handful of hosts in the appendix and the delivery does not reconcile. */
    const assetsTouched = new Set(
      ordered.flatMap((x) => [x.asset_id, ...(x.steps || []).map((s) => s.asset_id)])
        .filter((v) => v !== null && v !== undefined),
    )
    const targetIps = Array.from(new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null)))
    if (targetIps.length > 0) {
      const phIp = targetIps.map(() => '?').join(',')
      for (const a of db.prepare('SELECT id FROM asset WHERE ip IN (' + phIp + ')').all(...targetIps)) assetsTouched.add(a.id)
    }
    const assetsTouchedList = Array.from(assetsTouched)
    if (assetsTouchedList.length > 0) {
      const ph = assetsTouchedList.map(() => '?').join(',')
      const rowsA = db.prepare(`SELECT a.id, a.ip, a.primary_name, a.discovered_at, a.first_seen, a.last_seen,
          a.test_status, a.priority, COALESCE(a.scope, (${SCOPE_SQL})) AS scope
        FROM asset a WHERE a.id IN (${ph}) ORDER BY a.discovered_at, a.id`).all(...assetsTouchedList)
      md.push('---', '')
      md.push('## 5. Phụ lục', '')
      md.push('### 5.1 Tài sản liên quan trong báo cáo này (kèm thời điểm phát hiện)', '')
      md.push('| Tài sản | Tên | Nội/ngoại mạng | Thời điểm phát hiện | Thu thập gần nhất |')
      md.push('| --- | --- | --- | --- | --- |')
      for (const a of rowsA) {
        md.push('| `' + (a.ip || '') + '` | ' + (a.primary_name || '—')
          + ' | ' + (a.scope === 'internal' ? 'nội bộ' : 'internet')
          + ' | ' + (a.discovered_at ? String(a.discovered_at).replace('T', ' ').slice(0, 19) : '—')
          + ' | ' + (a.last_seen ? String(a.last_seen).replace('T', ' ').slice(0, 19) : '—') + ' |')
      }
      md.push('')
    }
    if (summary.serviceCapped.length > 0) {
      md.push('### 5.2 Bản ghi trùng không tính điểm (dịch vụ đã đầy)', '')
      md.push('| Mục tiêu | Mục điểm | Điểm đã ghi | Thời điểm ghi |', '| --- | --- | --- | --- |')
      for (const c of summary.serviceCapped) {
        md.push('| `' + (c.target || c.service || '') + '` | ' + (c.point_name || c.code) + ' | '
          + (c.points || 0) + ' | ' + String(c.recorded_at || '').replace('T', ' ').slice(0, 16) + ' |')
      }
      md.push('')
    }
    return { items: items2, stages, summary, markdown: md.join('\n'), target: targetName }
  }

  /**
   * Score chain: flatten score_hit by time into one chain, carrying only "scoring" material, no recon noise.
   * The attack-chain page's "score chain" view uses it.
   */
  scoreChain(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 500, 2000)
    const items = db.prepare(`SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.port, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points AS point_default, p.points, p.enabled, h.points AS hit_points, h.multiplier, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)
    /* What action obtained each step: ① linked step ② nearest-in-time step on the same asset (inferred) */
    const stepById = new Map(db.prepare('SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step').all().map((x) => [x.id, x]))
    const stepsByAsset = new Map()
    for (const st of stepById.values()) {
      if (st.asset_id === null || st.asset_id === undefined) continue
      if (!stepsByAsset.has(st.asset_id)) stepsByAsset.set(st.asset_id, [])
      stepsByAsset.get(st.asset_id).push(st)
    }
    for (const list of stepsByAsset.values()) list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))
    for (const it of items) {
      let step = it.step_id !== null && it.step_id !== undefined ? stepById.get(it.step_id) : undefined
      let inferred = false
      if (step === undefined) {
        step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id)
      }
      if (step === undefined && it.asset_id !== null && it.asset_id !== undefined) {
        const cands = (stepsByAsset.get(it.asset_id) || []).filter((x) => String(x.recorded_at) <= String(it.recorded_at))
        if (cands.length > 0) { step = cands[cands.length - 1]; inferred = true }
      }
      it.action = step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail }
      it.action_inferred = inferred
    }
    /* Scoring basis (identical to listScorePoints, so report and panel agree):
       ① self-registered/self-built accounts do not score (process only);
       ② dedup by the point's own dedup_scope (same target/system/service counts the highest once, or per host);
       ③ apply rule + cap limits; anything above the cap does not score. */
    const chainMeta = loadScoreMeta(db)
    const chainNames = loadAssetNames(db)
    /* Actual value of this hit: **its own tier wins** (merged rows span tiers, e.g. admin 50 / user 10).
       scoreChain's SQL aliases hit_points / point_default to keep the two columns apart: reading h.points
       directly gets shadowed by the same-named p.points and the tier check flips entirely. */
    const chainPointsOf = (it) => hitPointsOf({
      points: Number(it.hit_points) || Number(it.point_default) || 0,
      multiplier: it.multiplier,
      code: it.code,
    })
    const chainEval = evaluateScoreBoard(db, items.map((it) => Object.assign({}, it, { points: chainPointsOf(it) })),
      { meta: chainMeta, names: chainNames, enabledOnly: true })
    const cappedChain = { items: chainEval.items }
    const capFlagById = chainEval.byId
    const seenOf = new Map()
    for (const it of items) {
      it.self_created = Number(it.self_created) === 1
      const flag = capFlagById.get(it.id)
      it.capped = flag !== undefined && flag.capped === true
      it.port = normalizePort(it.port) ?? parseTargetPort(it.target)
      const meta = chainMeta.get(String(it.code)) || {}
      it.service = meta.dedup_scope === 'none' ? null : serviceLabel(it)
      it.capped_reason_kind = flag === undefined ? null : flag.capped_reason_kind
      it.rule = meta.rule ?? null
      it.rule_cap = meta.cap || 0
      /* Value exposed for this hit = its own tier value, falling back to the point default */
      it.point_default = Number(it.point_default) || 0
      it.points = chainPointsOf(it)
      it.capped_reason = it.capped
        ? scoreCapReasonText(Object.assign({}, it, { rule_cap: meta.cap || 0 }), flag.capped_by_points)
        : null
      const seen = seenOf.get(it.point_id) || 0
      if (!it.self_created && !it.capped) seenOf.set(it.point_id, seen + 1)
      it.nth_of_point = seen + 1
      /* Hits of disabled points score nothing (matches panel/report: enabledOnly) */
      it.counted = it.self_created !== true && it.capped !== true && !chainEval.disabledIds.has(it.id)
    }
    /* Aggregate by score point to show "what is still missing", so gaps are visible at a glance */
    const points = db.prepare('SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id').all()
    const hitPointIds = new Set(items.map((x) => x.point_id))
    const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
    const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
    /* ── Attack chain: five stages by "attack surface position", with a running total ── */
    const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
    const assetInfo = new Map()
    if (assetIds.length > 0) {
      const ph = assetIds.map(() => '?').join(',')
      const rows = db.prepare(`SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
        FROM asset a WHERE a.id IN (${ph})`).all(...assetIds)
      for (const row of rows) assetInfo.set(row.id, row)
    }
    /* Which stage each score lands in: explicit stage_code > type case > asset scope > target address */
    for (const it of items) {
      const info = it.asset_id !== null && it.asset_id !== undefined ? assetInfo.get(it.asset_id) : undefined
      it.stage_code = scoreStageOf(
        { stage_code: it.stage_code, code: it.code, target: it.target },
        info ? info.scope : undefined,
      )
    }
    const assetChip = (id) => {
      const a = assetInfo.get(id)
      if (a === undefined) return null
      return {
        id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, scope: a.scope, state: a.state,
        priority: a.priority, open_ports: a.open_ports, vulns: a.vulns,
      }
    }
    /* Attack steps counted per stage (the chain only needs "how many actions per stage", no detail) */
    const stepsByStage = new Map()
    try {
      for (const row of db.prepare('SELECT stage, stage_code FROM attack_step LIMIT 5000').all()) {
        const code = row.stage_code || LEGACY_STAGE_MAP[row.stage] || 'recon'
        stepsByStage.set(code, (stepsByStage.get(code) || 0) + 1)
      }
    } catch { /* ignore */ }
    /* Real tunnels from the session/tunnel table: hard evidence for the "boundary break" stage */
    let tunnels = []
    try {
      tunnels = db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50').all()
        .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    } catch { tunnels = [] }
    /* Only tunnels that really crossed the target boundary count; one opened on your own VPS does not */
    const legitTunnels = tunnels.filter((t) => t.legit === true)
    const selfOnlyTunnels = tunnels.filter((t) => t.legit === false)

    const stageDefs = this.listStages(id)
    let cumulative = 0
    const stages = stageDefs.map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0)
      cumulative += pts
      /* Assets in this stage (deduped). Recon gives "every asset that scored", others give their own */
      const ids = st.code === 'recon'
        ? Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
        : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
      const assets = ids.map(assetChip).filter(Boolean).map((a) => {
        const mine = items.filter((x) => x.asset_id === a.id)
        return Object.assign({}, a, {
          points: mine.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0),
          hits: mine.length,
          /* Which stage this asset's points fall in (one asset may be hit from both sides) */
          stage_code: mine.length > 0 ? mine[0].stage_code : st.code,
        })
      }).sort((a, b) => b.points - a.points || b.hits - a.hits)
      return Object.assign({}, st, {
        ordinal: si + 1,
        items: sItems,
        hits: sItems.length,
        counted: sItems.filter((x) => x.counted).length,
        points: pts,
        cumulative: cumulative,
        assets: assets,
        assetCount: assets.length,
        tunnels: st.code === 'boundary' ? legitTunnels : [],
        tunnels_self_only: st.code === 'boundary' ? selfOnlyTunnels : [],
        steps: stepsByStage.get(st.code) || 0,
      })
    })

    const scores = this.listScorePoints(id)
    return {
      items,
      stages,
      achieved,
      missing,
      summary: {
        hits: items.length,
        /* Same scoring basis as the score panel: no cap per point type, accumulate every hit */
        points: scores.summary.achievedPoints,
        totalPoints: scores.summary.totalPoints,
        countedHits: scores.summary.countedHits,
        achievedCount: achieved.length,
        missingCount: missing.length,
        missingPoints: missing.reduce((n, p) => n + (p.potential || p.points || 0), 0),
        selfCreatedHits: scores.summary.selfCreatedHits || 0,
        /* Same asset+port repeats capped per service and not scored (accounts / DB access) */
        serviceCappedHits: scores.summary.serviceCappedHits || 0,
        tunnelsLegit: legitTunnels.length,
        tunnelsSelfOnly: selfOnlyTunnels.length,
      },
    }
  }

  /** Session overview: one-screen summary for the UI and prompts (with online/offline counts). */
  sessionSummary(id) {
    const db = this.db(id)
    const shells = db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ORDER BY w.id DESC`).all()
    const tunnels = db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN webshell w ON w.id = t.webshell_id ORDER BY t.id DESC`).all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential').get()
    const access = db.prepare('SELECT COUNT(*) AS n FROM access_session').get()
    return {
      webshells: shells, tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === 'online').length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === 'active').length,
        /* Only tunnels crossing the target boundary count as a breach (own VPS/self-hosted excluded) */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: creds ? creds.n : 0,
        access: access ? access.n : 0,
      },
    }
  }

  /**
   * Live connectivity probe (host plane only: agents run sandboxed, only this can dial out).
   * WebShell sends one parameterless GET; a tunnel does one TCP connect.
   * Result is written back to status / last_check / latency_ms / check_note.
   */
  async probeSessions(id, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || 6000, 1000), 20000)
    const out = { webshells: [], tunnels: [], checkedAt: nowIso() }

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now()
      let status = 'offline'
      let note = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        clearTimeout(timer)
        status = res.status < 500 ? 'online' : 'offline'
        note = `HTTP ${res.status}`
      } catch (error) {
        note = error && error.name === 'AbortError' ? `Quá thời gian >${timeout}ms` : String((error && error.message) || error).slice(0, 160)
      }
      const latency = Date.now() - started
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency })
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
      const started = Date.now()
      let status = 'down'
      let note = ''
      if (target === '') {
        note = 'Thiếu địa chỉ listen, không thể dò'
      } else {
        const idx = target.lastIndexOf(':')
        const host = idx > 0 ? target.slice(0, idx) : '127.0.0.1'
        const port = Number(idx > 0 ? target.slice(idx + 1) : target)
        if (!Number.isFinite(port) || port <= 0) {
          note = `Không phân giải được cổng: ${t.listen}`
        } else {
          note = await new Promise((resolve) => {
            let done = false
            const socket = tcpConnect({ host, port })
            const finish = (ok, text) => {
              if (done) return
              done = true
              try { socket.destroy() } catch { /* ignore */ }
              resolve(ok ? '' : text)
            }
            socket.setTimeout(timeout)
            socket.on('connect', () => { status = 'active'; finish(true, '') })
            socket.on('timeout', () => { finish(false, `Quá thời gian >${timeout}ms`) })
            socket.on('error', (error) => { finish(false, String((error && error.code) || (error && error.message) || error).slice(0, 120)) })
          })
        }
      }
      const latency = Date.now() - started
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency })
    }
    return out
  }

  /**
   * Attack graph: asset topology overlaid with vulnerabilities and owned assets.
   * Node kind: segment / asset (meta.vulns counts by severity, meta.owned) / vuln (confirmed).
   * Edge relation: contains / exposes / resolves / has_vuln.
   */
  attackGraph(id, f = {}) {
    const base = this.graph(id, f)
    const db = this.db(id)
    const nodes = base.nodes.slice()
    const edges = base.edges.slice()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const vulnRows = db.prepare(`SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`).all()
    for (const row of vulnRows) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node === undefined) continue
      node.meta = node.meta || {}
      node.meta.vulns = node.meta.vulns || {}
      node.meta.vulns[row.severity] = row.n
    }
    const owned = db.prepare('SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL').all()
    for (const row of owned) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node !== undefined) { node.meta = node.meta || {}; node.meta.owned = true }
    }
    const confirmed = db.prepare(`SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`).all()
    for (const v of confirmed) {
      const nodeId = `vuln:${v.id}`
      nodes.push({ id: nodeId, kind: 'vuln', label: v.cve || (v.title || '').slice(0, 18), meta: { severity: v.severity, status: v.status, title: v.title } })
      edges.push({ source: `asset:${v.asset_id}`, target: nodeId, relation: 'has_vuln' })
    }
    return { nodes, edges, summary: this.vulnStats(id) }
  }

  /* ---------- Domain dimension / Web assets ---------- */

  /**
   * Group assets by domain: domain -> its asset list (assets with no domain go to "(no domain)").
   * @param f - `{ cidr? }` only one C segment (match the left selector, keep dimensions apart).
   */
  domainIndex(id, f = {}) {
    const db = this.db(id)
    const assets = (f.cidr
      ? db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(f.cidr)
      : db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int').all())
    const names = db.prepare('SELECT asset_id, name, kind, provenance FROM asset_name').all()
    const byAsset = new Map()
    for (const n of names) {
      if (!byAsset.has(n.asset_id)) byAsset.set(n.asset_id, [])
      byAsset.get(n.asset_id).push(n)
    }
    const groups = new Map()
    for (const a of assets) {
      const domains = new Set()
      if (a.primary_name) domains.add(a.primary_name)
      for (const n of byAsset.get(a.id) || []) domains.add(n.name)
      if (domains.size === 0) domains.add('(chưa liên kết tên miền)')
      for (const domain of domains) {
        if (!groups.has(domain)) groups.set(domain, [])
        groups.get(domain).push({ id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state, names: (byAsset.get(a.id) || []).map((n) => n.name) })
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  }

  /** Web asset list: assets with a URL/title or a common web port. */
  listWeb(id, f = {}) {
    const db = this.db(id)
    const rows = db.prepare(`SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`).all()
    const filtered = f.cidr ? rows.filter((r) => r.segment_cidr === f.cidr) : rows
    const limited = f.limit ? filtered.slice(0, Number(f.limit)) : filtered
    return { total: filtered.length, items: limited }
  }

  /* ---------- HTTP evidence (replayable in Burp / Yakit) ---------- */

  addHttpEvidence(id, e = {}) {
    const db = this.db(id)
    const result = db.prepare(`INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.vuln_id ?? null, e.asset_id ?? null, e.label ?? null, e.method ?? 'GET', e.url ?? null,
      e.status ?? null, e.request ?? null, e.response ?? null, e.note ?? null,
      e.captured_by ?? null, nowIso(),
    )
    return { id: Number(result.lastInsertRowid) }
  }

  /* ---------- Data leak proof (P1) ---------- */

  addDataProof(id, d = {}) {
    const db = this.db(id)
    const rowCount = Number(d.row_count)
    if (!Number.isFinite(rowCount) || rowCount < 0) throw new Error('data_proof.row_count phải là số không âm')
    const fields = Array.isArray(d.fields) ? d.fields.join(',') : String(d.fields || '')
    if (fields.trim() === '') throw new Error('data_proof.fields required: ghi rõ trường bị lộ (như họ tên/số CCCD/số điện thoại)')
    const r = db.prepare(`INSERT INTO data_proof(asset_id, vuln_id, target, source, interface, fields, row_count, sample, query, evidence_ref, pii_type, note, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.asset_id ?? null, d.vuln_id ?? null, d.target ?? null, d.source ?? null, d.interface ?? null,
      fields, rowCount, d.sample ?? null, d.query ?? null, d.evidence_ref ?? null,
      d.pii_type ?? 'pii', d.note ?? null, d.created_by ?? null, nowIso(),
    )
    return { id: Number(r.lastInsertRowid), row_count: rowCount, meets_threshold: rowCount >= 10000, fields }
  }

  listDataProofs(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target LIKE ?'); args.push('%' + String(f.target) + '%') }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return {
      total: db.prepare('SELECT COUNT(*) AS n FROM data_proof ' + clause).get(...args).n,
      items: db.prepare('SELECT * FROM data_proof ' + clause + ' ORDER BY id DESC LIMIT ?').all(...args, limit).map((r) => ({
        ...r, fields: String(r.fields || '').split(',').filter(Boolean), meets_threshold: Number(r.row_count) >= 10000,
      })),
    }
  }

  /* ---------- Cleanup ledger ---------- */

  addCleanup(id, c = {}) {
    const db = this.db(id)
    if (!String(c.kind || '').trim()) throw new Error('cleanup.kind required(webshell/account/tunnel/file/task…)')
    const r = db.prepare(`INSERT INTO cleanup_item(kind, target, location, detail, status, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      String(c.kind), c.target ?? null, c.location ?? null, c.detail ?? null,
      c.status || 'open', c.created_by ?? null, nowIso(), nowIso(),
    )
    return { id: Number(r.lastInsertRowid), status: c.status || 'open' }
  }

  listCleanup(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(String(f.status)) }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 500)
    return {
      total: db.prepare('SELECT COUNT(*) AS n FROM cleanup_item ' + clause).get(...args).n,
      items: db.prepare('SELECT * FROM cleanup_item ' + clause + ' ORDER BY id DESC LIMIT ?').all(...args, limit),
    }
  }

  updateCleanup(id, c = {}) {
    const db = this.db(id)
    const itemId = Number(c.id)
    if (!Number.isFinite(itemId)) throw new Error('cleanup.id required')
    const cur = db.prepare('SELECT * FROM cleanup_item WHERE id = ?').get(itemId)
    if (cur === undefined) throw new Error('cleanup item not found')
    db.prepare('UPDATE cleanup_item SET status = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(c.status || cur.status, c.detail ?? cur.detail, nowIso(), itemId)
    return { id: itemId, status: c.status || cur.status }
  }

  listHttpEvidence(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.vuln_id !== undefined && f.vuln_id !== null) { where.push('vuln_id = ?'); args.push(Number(f.vuln_id)) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return db.prepare(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- Attack chain ---------- */

  /**
   * Write one attack-chain step. If this step scored, just pass point_code (or point_id):
   * the server records a score_hit and cross-links them, so no step is unscored, no score orphaned.
   */
  addChainStep(id, s = {}) {
    const db = this.db(id)
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step').get() || { n: 1 }).n
    let pointId = s.point_id !== undefined && s.point_id !== null ? Number(s.point_id) : null
    if (pointId === null && s.point_code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(s.point_code))
      if (row !== undefined) pointId = row.id
    }
    const seq = s.seq ?? next
    const legacyStage = s.stage ?? 'other'
    /* Only these 5 stage codes are bucketed by the attack-chain page; anything else -- including the
       retired external/foothold/tunnel/privilege -- lands nowhere, so fall back to legacy and warn. */
    let stageWarning = null
    let stageCode
    if (typeof s.stage_code === 'string' && s.stage_code.trim() !== '') {
      const wanted = s.stage_code.trim()
      if (VALID_STAGE_CODES.includes(wanted)) {
        stageCode = wanted
      } else {
        stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
        stageWarning = 'stage_code không hợp lệ="' + wanted + '" (đã bỏ qua): chỉ chấp nhận ' + VALID_STAGE_CODES.join('/')
          + '; bước này rơi về mặc định theo stage là ' + stageCode + '. '
      }
    } else {
      stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
    }
    const result = db.prepare(`INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, point_id, evidence_ref, tool, agent, result, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seq, legacyStage, stageCode, s.title ?? '', s.detail ?? null,
      s.asset_id ?? null, s.vuln_id ?? null, s.access_id ?? null, pointId, s.evidence_ref ?? null,
      s.tool ?? null, s.agent ?? null, s.result ?? null,
      s.recorded_by ?? null, nowIso(),
    )
    const stepId = Number(result.lastInsertRowid)
    let hit = null
    let scoreHint = null
    /* point_code plus evidence -> score inline (one call does both action and score) */
    if (pointId !== null && typeof s.evidence === 'string' && s.evidence.trim() !== '') {
      try {
        hit = this.addScoreHit(id, {
          point_id: pointId, asset_id: s.asset_id ?? null, vuln_id: s.vuln_id ?? null, step_id: stepId,
          target: s.target ?? null, evidence: s.evidence, note: s.note ?? null, recorded_by: s.recorded_by ?? null,
          /* Self-registered or self-created accounts score nothing (process only) */
          self_created: s.self_created,
        })
        /* Per-service cap (account class / database privileges): step stored, points stop accruing,
           and the reason must reach the model -- else it thinks one more account = more points. */
        if (hit && hit.warning) scoreHint = hit.warning
      } catch (error) {
        /* Step is stored but the reason goes back to the model -- silent swallowing makes the score a lie */
        scoreHint = 'Bước đã vào kho, nhưng ghi điểm thất bại: ' + (error && error.message ? error.message : String(error))
        }
    } else if (pointId !== null) {
      scoreHint = 'Có point_code nhưng không đưa evidence, lần này **không ghi điểm** (bước đã vào kho): muốn ghi điểm hãy bổ sung redteam_score_hit, evidence chỉ ghi kết quả (tài sản mục tiêu + tài khoản/quyền/dung lượng dữ liệu).'
    }
    return { id: stepId, seq: seq, stage_code: stageCode, point_id: pointId, hit: hit, score_hint: scoreHint, stage_hint: stageWarning }
  }

  listChain(id) {
    return this.db(id).prepare(`SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`).all()
  }

  /* ---------- Attack files (only scripts/POC/EXP that actually worked) ---------- */

  /* ------------------------------------------------------------- Evidence screenshots */
  /** Screenshot directory: `<engagement dir>/shots`. Sibling of attack-files, easy to ship wholesale. */
  shotsDirOf(id) { return join(this.dirOf(id), 'shots') }

  /**
   * Register an evidence screenshot (copy the image into the engagement dir; DB stores name + metadata).
   *
   * Why kind must be explicit:
   *   - `screenshot` -- live capture, usable as acceptance material as-is;
   *   - `card`       -- an evidence excerpt card generated from records, **not a live capture**.
   *   Mixing them makes the reviewer take a generated card for live evidence -- the worst failure,
   *   so kind is stored and the panel and report colour and label them differently.
   *
   * @param id - engagement id.
   * @param shot - `{ path | data_base64, label, note, kind, point_code, hit_id, asset_id, target, source_ref, captured_at, agent }`
   */
  addShot(id, shot = {}) {
    const db = this.db(id)
    const dir = this.shotsDirOf(id)
    mkdirSync(dir, { recursive: true })
    const kind = shot.kind === 'card' ? 'card' : 'screenshot'
    /* File name: use the given one (path separators stripped), else time-point-index */
    const ext = (() => {
      const src = String(shot.path || '')
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(src)
      return m === null ? 'png' : m[1].toLowerCase()
    })()
    const stamp = String(shot.captured_at || new Date().toISOString()).replace(/[-:T]/g, '').slice(0, 14)
    const slug = String(shot.point_code || 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'shot'
    let file = String(shot.file || '').trim().replace(/[/\\]/g, '-')
    if (file === '') {
      let n = 1
      do { file = stamp + '-' + slug + '-' + String(n).padStart(2, '0') + '.' + ext; n += 1 }
      while (existsSync(join(dir, file)))
    }
    const dest = assertPathWithin(join(dir, file), [dir])
    let buf = null
    if (typeof shot.data_base64 === 'string' && shot.data_base64.trim() !== '') {
      buf = Buffer.from(shot.data_base64.replace(/^data:[^,]+,/, ''), 'base64')
    } else if (typeof shot.path === 'string' && shot.path.trim() !== '') {
      const src = isAbsolute(shot.path) ? shot.path : join(this.dirOf(id), shot.path)
      if (!existsSync(src)) throw new Error('shot source not found: ' + shot.path)
      buf = readFileSync(src)
    } else {
      throw new Error('shot path or data_base64 required')
    }
    if (buf.length === 0) throw new Error('shot file is empty')
    writeFileSync(dest, buf)
    const mime = /^\x89PNG/.test(buf.slice(0, 4).toString('latin1')) ? 'image/png'
      : (buf.slice(0, 2).toString('latin1') === '\xff\xd8' ? 'image/jpeg'
        : (buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : 'application/octet-stream'))
    const dim = pngSize(buf)
    const pointId = (() => {
      const code = String(shot.point_code || '').trim()
      if (code === '') return shot.point_id === undefined || shot.point_id === null ? null : Number(shot.point_id)
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(code)
      return row === undefined ? null : Number(row.id)
    })()
    const now = nowIso()
    const cur = db.prepare(`INSERT INTO shot (point_id, hit_id, asset_id, vuln_id, target, label, note,
        file, kind, mime, bytes, width, height, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId,
      shot.hit_id === undefined || shot.hit_id === null ? null : Number(shot.hit_id),
      shot.asset_id === undefined || shot.asset_id === null ? null : Number(shot.asset_id),
      shot.vuln_id === undefined || shot.vuln_id === null ? null : Number(shot.vuln_id),
      String(shot.target || '').trim() || null,
      String(shot.label || '').trim() || null,
      String(shot.note || '').trim() || null,
      file, kind, mime, buf.length, dim.width, dim.height,
      createHash('sha256').update(buf).digest('hex'),
      String(shot.source_ref || shot.path || '').trim() || null,
      String(shot.captured_at || now).trim(),
      String(shot.agent || '').trim() || null,
      String(shot.agent || '').trim() || null,
      now,
    )
    return { ok: true, id: Number(cur.lastInsertRowid), file: file, kind: kind, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
  }

  /** Evidence screenshot list (filterable by point / hit / asset). */
  listShots(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.point_code !== undefined && f.point_code !== null && String(f.point_code) !== '') {
      where.push('s.point_id = (SELECT id FROM score_point WHERE code = ?)')
      args.push(String(f.point_code))
    }
    for (const [col, key] of [['hit_id', 'hit_id'], ['asset_id', 'asset_id'], ['vuln_id', 'vuln_id']]) {
      if (f[key] !== undefined && f[key] !== null && String(f[key]) !== '') {
        where.push('s.' + col + ' = ?')
        args.push(Number(f[key]))
      }
    }
    const sql = `SELECT s.*, p.code AS point_code, p.name AS point_name
      FROM shot s LEFT JOIN score_point p ON p.id = s.point_id
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.captured_at, s.id LIMIT ?`
    const items = db.prepare(sql).all(...args, Math.min(Number(f.limit) || 500, 2000))
    return { ok: true, items: items.map((x) => Object.assign({}, x, { url: this.shotUrlOf(id, x) })), total: items.length }
  }

  /** Accessible reference to a screenshot: what panel/report embed (relative to engagement dir). */
  shotUrlOf(id, shot) { return 'shots/' + shot.file }

  /** Delete a screenshot (including the file on disk). */
  deleteShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    try {
      const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
      if (existsSync(p)) rmSync(p, { force: true })
    } catch { /* file gone means already deleted */ }
    db.prepare('DELETE FROM shot WHERE id = ?').run(Number(shotId))
    return { ok: true, id: Number(shotId) }
  }

  /**
   * Read the bytes of a screenshot (panel renders it via `<img src="data:...">`).
   * base64 instead of a static route: this HTTP bridge already enforces same-origin,
   * and a static route reading any path by filename would bypass that check on the engagement dir.
   */
  readShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
    if (!existsSync(p)) throw new Error('shot file missing on disk: ' + row.file)
    const buf = readFileSync(p)
    return { ok: true, id: Number(row.id), mime: row.mime || 'image/png', bytes: buf.length, base64: buf.toString('base64') }
  }

  /**
   * Attach a "representative screenshot" to a batch of score entries, **max 3 per scoring point**
   * (bulk points like terminal access produce dozens of hits; one image each buries the page/report).
   *
   * Selection priority: hit level > point+target level > point level; within a level a live shot wins.
   *
   * @param id - engagement id.
   * @param groups - `[{ point_id, point_code, hit_ids: number[], asset_id, target }]`
   * @param limit - max images per scoring point (default 3).
   */
  #representativeShots(id, groups, limit = 3) {
    const db = this.db(id)
    let all = []
    try { all = db.prepare('SELECT * FROM shot ORDER BY captured_at, id').all() } catch { all = [] }
    if (all.length === 0) return new Map()
    const byHit = new Map()
    const byPoint = new Map()
    for (const sh of all) {
      if (sh.hit_id !== null && sh.hit_id !== undefined) {
        if (!byHit.has(Number(sh.hit_id))) byHit.set(Number(sh.hit_id), [])
        byHit.get(Number(sh.hit_id)).push(sh)
      }
      if (sh.point_id !== null && sh.point_id !== undefined) {
        if (!byPoint.has(Number(sh.point_id))) byPoint.set(Number(sh.point_id), [])
        byPoint.get(Number(sh.point_id)).push(sh)
      }
    }
    const rank = (sh) => (sh.kind === 'card' ? 1 : 0)
    const out = new Map()
    for (const g of groups) {
      /* Candidate pool tiers by link strength: hit level -> target/asset level -> point level.
         Within a tier **a live capture beats a generated card**, then by time -- otherwise on
         bulk points late cards push real shots out of the top 3 (seen: 60 hosts gave 3 cards). */
      const pool = []
      for (const hid of (g.hit_ids || [])) pool.push(...(byHit.get(Number(hid)) || []))
      const pointShots = byPoint.get(Number(g.point_id)) || []
      for (const sh of pointShots) {
        if (g.target && sh.target && String(sh.target) === String(g.target)) pool.push(sh)
        else if (g.asset_id !== null && g.asset_id !== undefined && sh.asset_id === g.asset_id) pool.push(sh)
      }
      for (const sh of pointShots) pool.push(sh)
      const picked = []
      const seen = new Set()
      const ordered = pool.slice().sort((a, b) => rank(a) - rank(b)
        || String(a.captured_at || '').localeCompare(String(b.captured_at || ''))
        || Number(a.id) - Number(b.id))
      for (const sh of ordered) {
        if (sh === undefined || sh === null || seen.has(sh.id)) continue
        seen.add(sh.id)
        picked.push(sh)
        if (picked.length >= limit) break
      }
      out.set(Number(g.point_id), picked)
    }
    return out
  }

  /** Attack file root: <engagement>/attack-files/<target>/... */
  attackFilesDirOf(id) { return join(this.dirOf(id), 'attack-files') }

  /**
   * Save an attack file into its "target folder" and register it. evidence required: proven items only.
   * @param id - engagement id.
   * @param f - `{ target, name, kind, content|path, description, evidence, asset_id?, vuln_id?, created_by? }`
   */
  addAttackFile(id, f = {}) {
    const db = this.db(id)
    const target = String(f.target || '').trim()
    if (target === '') throw new Error('attack file target required (IP / URL / dải C)')
    const name = String(f.name || '').trim().replace(/[/\\]/g, '-')
    if (name === '') throw new Error('attack file name required')
    const evidence = String(f.evidence || '').trim()
    if (evidence === '') throw new Error('attack file evidence required: chỉ thu nhận script/POC/EXP thực sự có hiệu lực, hãy ghi rõ hiệu quả đã kiểm chứng')
    const slug = slugTarget(target)
    const dir = join(this.attackFilesDirOf(id), slug)
    mkdirSync(dir, { recursive: true })
    /* with target `..`/`.` slugTarget returns it as-is and join escapes attack-files/.
       The write path gets the same root check, so files stay inside this engagement dir. */
    const filePath = assertPathWithin(join(dir, name), [this.attackFilesDirOf(id)])
    if (typeof f.content === 'string' && f.content.length > 0) {
      writeFileSync(filePath, f.content, 'utf8')
    } else if (typeof f.path === 'string' && f.path.length > 0) {
      const src = isAbsolute(f.path) ? f.path : join(this.dirOf(id), f.path)
      if (!existsSync(src)) throw new Error('source path not found: ' + f.path)
      copyFileSync(src, filePath)
    } else {
      throw new Error('attack file content or path required')
    }
    const kind = ['poc', 'exp', 'script', 'wordlist', 'other'].includes(f.kind) ? f.kind : 'script'
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`).run(
      target, f.target_kind ?? null, name, kind, filePath,
      f.description ?? null, evidence, f.asset_id ?? null, f.vuln_id ?? null,
      f.created_by ?? null, nowIso(),
    )
    return { target, name, kind, path: filePath }
  }

  listAttackFiles(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target = ?'); args.push(f.target) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    return db.prepare(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...args)
  }

  /** Attack files grouped by target (one folder per IP / URL / C segment). */
  attackFileTree(id) {
    const groups = new Map()
    for (const row of this.listAttackFiles(id, {})) {
      if (!groups.has(row.target)) groups.set(row.target, { target: row.target, folder: slugTarget(row.target), count: 0, files: [] })
      const g = groups.get(row.target)
      g.files.push(row)
      g.count++
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  }

  readAttackFile(id, fileId) {
    const row = this.db(id).prepare('SELECT * FROM attack_file WHERE id = ?').get(Number(fileId))
    if (row === undefined) return undefined
    let content = ''
    try {
      /* path is a DB column (agent-written): clamp to the engagement dir, else the panel reads anything */
      const safe = assertPathWithin(row.path, [this.dirOf(id)])
      content = readFileSync(safe, 'utf8')
    } catch (error) {
      content = '(bị từ chối hoặc đọc thất bại: ' + (error && error.message ? error.message : String(error)) + ')'
    }
    return { ...row, content }
  }

  /* ---------- Knowledge base: generic POC / EXP (global, shared across engagements) ---------- */

  knowledgePath() { return join(this.root, 'knowledge.db') }

  /** Locate the local nuclei templates dir (only when installed; undefined when not found). */
  nucleiTemplatesDir() {
    /* Paths typed/auto-assigned in environment setup win (Windows depends on this one) */
    try {
      const configured = nucleiTemplatesDirOf(loadPlatformConfig(this.root), this.root)
      if (configured) return configured
    } catch { /* ignore config read failure, keep probing defaults */ }
    const candidates = [
      join(this.root, 'toolkit', 'nuclei-templates'),
      join(homedir(), '.local', 'nuclei-templates'),
      join(homedir(), 'nuclei-templates'),
      '/usr/share/nuclei-templates',
      '/opt/nuclei-templates',
    ]
    return candidates.find((p) => existsSync(p))
  }

  /**
   * Directory signature: yaml count + newest mtime.
   * Walk only, never read (13k files in tens of ms) -- far cheaper than re-parsing 13k yamls.
   */
  #nucleiDirSignature(dir) {
    let count = 0
    let newest = 0
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        count += 1
        try {
          const stat = statSync(join(base, next))
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch { /* unreadable mtime does not affect the count */ }
      }
    }
    walk(dir, '')
    return { count, newest: Math.round(newest) }
  }
  #nucleiIndexPath() { return join(this.pocsDirOf(), '.nuclei-index.json') }

  /**
   * Template index (built on demand + cached on disk): parsing 13k yamls is too slow, so we pull
   * only the search fields path / name / severity / tags, build once, reuse forever.
   */
  #nucleiIndex(force) {
    const dir = this.nucleiTemplatesDir()
    if (dir === undefined) return { dir: null, items: [] }
    const cachePath = this.#nucleiIndexPath()
    /* Cache keyed by content: dir path + template count + newest mtime must all match.
       The old path-only + 7-day rule left a refreshed template set with a stale index. */
    const sig = this.#nucleiDirSignature(dir)
    if (force !== true && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        const validItems = Array.isArray(cached && cached.items)
          && cached.items.every((item) => Array.isArray(item) && item.length === 5)
        const fresh = cached && cached.dir === dir && cached.index_version === NUCLEI_INDEX_VERSION
          && validItems && cached.sig && cached.sig.count === sig.count && cached.sig.newest === sig.newest
          && (Date.now() - Number(cached.built_at || 0) < NUCLEI_INDEX_TTL_MS)
        if (fresh) return { dir, items: cached.items, cached: true }
      } catch { /* rebuild if the cache is broken */ }
    }
    const items = []
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        let full = ''
        try { full = readFileSync(join(base, next), 'utf8') } catch { continue }
        /* Read the whole info block.  A fixed 2000-byte prefix loses metadata
           from valid templates whose description/examples come first. */
        const infoStart = /^info:\s*\n/m.exec(full)
        let head = ''
        if (infoStart) {
          const rest = full.slice(infoStart.index + infoStart[0].length)
          const nextTopLevel = rest.search(/^\S/m)
          head = nextTopLevel >= 0 ? rest.slice(0, nextTopLevel) : rest
        } else {
          head = full.slice(0, 4000)
        }
        const pick = (re) => {
          const m = re.exec(head) || re.exec(full)
          return m === null ? '' : String(m[1]).trim().replace(/^["']|["']$/g, '')
        }
        const cves = new Set()
        for (const cve of `${e.name}\n${full}`.match(/CVE-\d{4}-\d{4,7}/gi) || []) cves.add(cve.toUpperCase())
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
          [...cves].join(' '),
        ])
      }
    }
    walk(dir, '')
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({
        index_version: NUCLEI_INDEX_VERSION,
        built_at: Date.now(), dir, sig, items,
      }), 'utf8')
    } catch { /* cache write failure does not block search */ }
    return { dir, items, cached: false }
  }

  /** Template library overview (for the UI, and for an agent checking what already exists). */
  templateStats() {
    const { dir, items } = this.#nucleiIndex()
    const cve = items.filter((x) => String(x[4] || '') !== '').length
    const cveIds = new Set()
    for (const item of items) {
      for (const cveId of String(item[4] || '').split(/\s+/)) {
        if (cveId) cveIds.add(cveId)
      }
    }
    return { dir: dir || null, total: items.length, cve, cve_ids: cveIds.size }
  }

  /**
   * Search the local nuclei library: CVE ids hit by filename, component/keyword match name and tags.
   * This covers "not in the KB but already on this host"; checking it saves a round of web search.
   */
  searchTemplates(q, limit = 40, offset = 0) {
    const { dir, items } = this.#nucleiIndex()
    if (dir === null) return { dir: null, total: 0, matched: 0, offset: 0, items: [] }
    const cap = Math.min(Number(limit) || 40, 200)
    const skip = Math.max(0, Number(offset) || 0)
    const toRow = ([path, name, severity, tags, cves]) => ({ path, name, severity, tags, cves })
    const raw = String(q || '').trim()
    /* No keyword still returns one page, else the panel shows "N templates but this page is empty" */
    if (raw === '') {
      return {
        dir,
        total: items.length,
        matched: items.length,
        offset: skip,
        items: items.slice(skip, skip + cap).map(toRow),
      }
    }
    const needle = raw.toLowerCase()
    const matched = []
    for (const row of items) {
      const hay = (row[0] + ' ' + row[1] + ' ' + row[3] + ' ' + row[4]).toLowerCase()
      if (hay.includes(needle)) matched.push(toRow(row))
    }
    return {
      dir,
      total: items.length,
      matched: matched.length,
      offset: skip,
      items: matched.slice(skip, skip + cap),
    }
  }


  pocsDirOf() { return join(this.root, 'pocs') }

  /** Open (creating if needed) the global knowledge base. Separate from engagement DBs, shared. */
  kb() {
    if (this.kbHandle) return this.kbHandle
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.pocsDirOf(), { recursive: true })
    const handle = new DatabaseSync(this.knowledgePath())
    /* As above: without FTS5 no poc_fts is built and POC search degrades to LIKE (see searchPocs) */
    handle.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(handle)
    this.kbHandle = handle
    return handle
  }

  #reindexPoc(db, pocId) {
    if (!HAS_FTS5) return   /* no FTS5, no index table; POC search falls back to LIKE (see searchPocs) */
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(pocId))
    const p = db.prepare('SELECT * FROM poc WHERE id = ?').get(pocId)
    if (!p) return
    db.prepare('INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(p.id), p.title, p.cve || '', p.component || '', p.versions || '', p.tags || '', p.description || '', p.content || '')
  }

  /**
   * Store a generic POC/EXP. Same code merges and refreshes, so a newer POC replaces the old one.
   * @param p - `{ title, kind, cve, component, versions, severity, language, source, source_url,
   *               description, usage, content|path, verified, verified_note, tags, created_by }`
   */
  savePoc(p = {}) {
    const db = this.kb()
    const title = String(p.title || '').trim()
    if (title === '') throw new Error('poc.title required (ghi rõ POC của lỗ hổng/thành phần nào)')
    const kind = POC_KINDS.includes(p.kind) ? p.kind : (String(p.kind || '').toLowerCase() === 'exp' ? 'exp' : 'poc')
    const source = POC_SOURCES.includes(p.source) ? p.source : 'self'
    /* code becomes a directory name: sanitize it. `code='../../escaped-poc'` once wrote outside the
       data root (deletePoc had startsWith, the write path did not). Both now use slugPoc rules. */
    const rawCode = String(p.code || '').trim()
    const code = rawCode === '' ? slugPoc(title, p.cve) : rawCode.replace(/[^\w.\u4e00-\u9fa5-]+/g, '-').replace(/^[.-]+/, '')
    if (code === '') throw new Error('poc.code invalid (rỗng sau khi làm sạch, hãy dùng chữ cái/chữ số/chữ Hán/gạch ngang)')
    const dir = assertPathWithin(join(this.pocsDirOf(), code), [this.pocsDirOf()])
    mkdirSync(dir, { recursive: true })

    /* Body: prefer the passed content, else read from path; with neither, register metadata only */
    let content = typeof p.content === 'string' ? p.content : ''
    if (content === '' && typeof p.path === 'string' && p.path.length > 0) {
      const src = isAbsolute(p.path) ? p.path : join(this.pocsDirOf(), p.path)
      if (!existsSync(src)) throw new Error('poc content or existing path required: ' + p.path)
      content = readFileSync(src, 'utf8')
    }
    let filePath = null
    if (content !== '') {
      /* filename must carry no path separator either, or it climbs back out of the code dir */
      const filename = String(p.filename || '').trim().replace(/[/\\]/g, '-') || defaultPocFilename(title, kind, p.language)
      filePath = assertPathWithin(join(dir, filename), [this.pocsDirOf()])
      writeFileSync(filePath, content, 'utf8')
    }
    const existing = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    const verified = p.verified === undefined || p.verified === null
      ? (existing ? existing.verified : 0)
      : (p.verified ? 1 : 0)
    const now = nowIso()
    /* Category: custom values allowed, but anything outside the built-in codes becomes other */
    const rawCategory = String(p.category || (existing ? existing.category : '') || '').trim()
    const category = rawCategory === ''
      ? 'other'
      : (POC_CATEGORIES.some((c) => c.code === rawCategory) ? rawCategory : 'other')
    db.prepare(`INSERT INTO poc(code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, category = excluded.category,
        cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        engagement_id = COALESCE(excluded.engagement_id, poc.engagement_id),
        engagement_name = COALESCE(excluded.engagement_name, poc.engagement_name),
        asset_target = COALESCE(excluded.asset_target, poc.asset_target),
        found_by_agent = COALESCE(excluded.found_by_agent, poc.found_by_agent),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`).run(
      code, title, kind, category, p.cve ?? null, p.component ?? null, p.versions ?? null, p.severity ?? null,
      p.language ?? null, source, p.source_url ?? null, p.description ?? null, p.usage ?? null,
      content, filePath, verified, p.verified_note ?? null,
      existing ? existing.hit_count : 0, existing ? existing.used_on : null, p.tags ?? null,
      p.engagement_id ?? null, p.engagement_name ?? null, p.asset_target ?? null, p.found_by_agent ?? null,
      p.created_by ?? null, existing ? existing.created_at : now, now,
    )
    const row = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    this.#reindexPoc(db, row.id)
    return { poc: row, created: existing === undefined, path: filePath }
  }

  /**
   * Search the knowledge base: step one before any Nday/1day work.
   * @param f - `{ q, cve, component, kind, language, source, verified, tag, limit }`
   */
  searchPocs(f = {}) {
    const db = this.kb()
    const where = []
    const args = []
    const q = String(f.q || f.query || '').trim()
    if (q !== '') {
      /* Full-text first (title/id/component/version/tags/description/body), else LIKE substring */
      const match = q.split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ')
      let ids = []
      try {
        ids = db.prepare('SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200').all(match).map((r) => Number(r.poc_id))
      } catch { ids = [] }
      if (ids.length === 0) {
        const like = '%' + q + '%'
        ids = db.prepare(`SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`)
          .all(like, like, like, like, like, like, like).map((r) => r.id)
      }
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (f.cve) { where.push('cve LIKE ?'); args.push('%' + String(f.cve) + '%') }
    if (f.component) { where.push('component LIKE ?'); args.push('%' + String(f.component) + '%') }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    /* Category filter: several at once (category=rce,tunnel) */
    if (f.category) {
      const list = String(f.category).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) { where.push(`COALESCE(NULLIF(category, ''), 'other') IN (${list.map(() => '?').join(',')})`); args.push(...list) }
      else if (list.length === 1) { where.push("COALESCE(NULLIF(category, ''), 'other') = ?"); args.push(list[0]) }
    }
    /* Origin filter: which engagement / asset this knowledge was found and verified on */
    if (f.engagement) {
      where.push('(engagement_id = ? OR engagement_name LIKE ?)')
      args.push(String(f.engagement), '%' + String(f.engagement) + '%')
    }
    if (f.asset_target) { where.push('asset_target LIKE ?'); args.push('%' + String(f.asset_target) + '%') }
    if (f.language) { where.push('language = ?'); args.push(String(f.language)) }
    if (f.source) { where.push('source = ?'); args.push(String(f.source)) }
    if (f.tag) { where.push('tags LIKE ?'); args.push('%' + String(f.tag) + '%') }
    if (f.verified === true || f.verified === 1) where.push('verified = 1')
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit)
  }

  /** Full content of one POC (agents use it directly, so the body comes with it). */
  getPoc(key) {
    const db = this.kb()
    const raw = String(key === undefined || key === null ? '' : key).trim()
    if (raw === '') return undefined
    const numeric = Number(raw)
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare('SELECT * FROM poc WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM poc WHERE code = ?').get(raw)
    if (row === undefined) return undefined
    let content = row.content || ''
    if (content === '' && row.path) {
      try {
        /* As readAttackFile: path is a DB column, clamp to pocs/ before reading */
        content = readFileSync(assertPathWithin(row.path, [this.pocsDirOf()]), 'utf8')
      } catch { content = '' }
    }
    return { ...row, content }
  }

  /** Mark a POC as used (later sorted by reuse count, most used first). */
  markPocUsed(key, usedOn) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?')
      .run(usedOn ?? null, nowIso(), row.id)
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count || 0) + 1 }
  }

  /** Record a verification result: only verified POCs count as "ready to use", and are flagged. */
  updatePoc(key, patch = {}) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) throw new Error('poc not found: ' + key)
    const next = {
      title: patch.title ?? row.title,
      kind: patch.kind ?? row.kind,
      category: patch.category ?? row.category,
      cve: patch.cve ?? row.cve,
      component: patch.component ?? row.component,
      versions: patch.versions ?? row.versions,
      severity: patch.severity ?? row.severity,
      language: patch.language ?? row.language,
      source: patch.source ?? row.source,
      source_url: patch.source_url ?? row.source_url,
      description: patch.description ?? row.description,
      usage: patch.usage ?? row.usage,
      verified: patch.verified === undefined || patch.verified === null ? row.verified : (patch.verified ? 1 : 0),
      verified_note: patch.verified_note ?? row.verified_note,
      tags: patch.tags ?? row.tags,
      engagement_id: patch.engagement_id ?? row.engagement_id,
      engagement_name: patch.engagement_name ?? row.engagement_name,
      asset_target: patch.asset_target ?? row.asset_target,
      found_by_agent: patch.found_by_agent ?? row.found_by_agent,
      content: typeof patch.content === 'string' && patch.content !== '' ? patch.content : row.content,
      path: row.path,
    }
    if (next.content !== row.content) {
      const filename = 'poc.txt'
      const dir = join(this.pocsDirOf(), row.code)
      mkdirSync(dir, { recursive: true })
      next.path = join(dir, row.path ? basename(row.path) : filename)
      writeFileSync(next.path, next.content || '', 'utf8')
    }
    db.prepare(`UPDATE poc SET title = ?, kind = ?, category = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?,
      engagement_id = ?, engagement_name = ?, asset_target = ?, found_by_agent = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`).run(
      next.title, next.kind, next.category, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.engagement_id, next.engagement_name, next.asset_target, next.found_by_agent,
      next.content, next.path, nowIso(), row.id,
    )
    this.#reindexPoc(db, row.id)
    return this.getPoc(row.id)
  }

  deletePoc(key) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('DELETE FROM poc WHERE id = ?').run(row.id)
    if (HAS_FTS5) db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(row.id))
    /* Delete the on-disk dir too (exact code match under pocs/; failure leaves data consistent) */
    let removedFiles = 0
    try {
      const dir = join(this.pocsDirOf(), row.code)
      if (existsSync(dir) && dir.startsWith(this.pocsDirOf())) {
        removedFiles = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles }
  }

  /** Knowledge base overview: UI header tabs plus a one-screen summary for agents. */
  pocStats() {
    const db = this.kb()
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0] ?? 0
    const byKind = db.prepare('SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC').all('poc')
    const bySource = db.prepare('SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC').all('self')
    const topComponents = db.prepare(`SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`).all()
    /* Categories: the panel groups by them, agents see which weapon class has piled up.
       Order follows the built-in table (not counts), so panel groups stay stable. */
    const catRows = db.prepare("SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS n, SUM(verified) AS verified FROM poc GROUP BY category").all()
    const catMap = new Map(catRows.map((r) => [r.category, r]))
    const byCategory = POC_CATEGORIES.map((c) => {
      const row = catMap.get(c.code)
      return { code: c.code, name: c.name, hint: c.hint, n: row ? row.n : 0, verified: row ? (row.verified || 0) : 0 }
    })
    /* Categories outside the built-in table (user-defined) are listed too, never dropped */
    for (const [code, row] of catMap) {
      if (POC_CATEGORIES.some((c) => c.code === code)) continue
      byCategory.push({ code, name: pocCategoryName(code), hint: '', n: row.n, verified: row.verified || 0 })
    }
    /* Origin engagement: where each item was found/verified (count per engagement + last seen) */
    const byEngagement = db.prepare(`SELECT COALESCE(NULLIF(engagement_name, ''), NULLIF(engagement_id, ''), '(mục tiêu nguồn chưa ghi)') AS engagement,
        COUNT(*) AS n, MAX(created_at) AS latest FROM poc GROUP BY engagement ORDER BY n DESC, latest DESC LIMIT 30`).all()
    /* Discovered assets: top assets (one lesson usually spans a batch of assets) */
    const topAssets = db.prepare(`SELECT asset_target, COUNT(*) AS n FROM poc WHERE COALESCE(asset_target, '') <> ''
      GROUP BY asset_target ORDER BY n DESC, asset_target LIMIT 15`).all()
    return {
      total: one('SELECT COUNT(*) FROM poc'),
      verified: one('SELECT COUNT(*) FROM poc WHERE verified = 1'),
      withContent: one("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: one('SELECT COALESCE(SUM(hit_count), 0) FROM poc'),
      /* Count of uncategorised rows: the panel hints "N rows not categorised yet" */
      uncategorized: one("SELECT COUNT(*) FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'"),
      earliest: one('SELECT MIN(created_at) FROM poc'),
      latest: one('SELECT MAX(created_at) FROM poc'),
      byKind, bySource, byCategory, byEngagement, topAssets, topComponents,
      categories: POC_CATEGORIES,
      dbPath: this.knowledgePath(),
    }
  }

  /**
   * Results report grouped by target: one per IP / URL / C segment, collapsible in the UI.
   * Same inclusion rule as report() (verified/exploited and medium or above).
   */
  reportTargets(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice().sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const files = this.listAttackFiles(id, {})

    const targets = new Map()
    const ensure = (key) => {
      if (!targets.has(key)) {
        targets.set(key, { key, label: key, kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? 'ip' : 'host', segment: '', vulns: [], chain: [], access: [], creds: [], files: [] })
      }
      return targets.get(key)
    }
    const assetIpOf = (assetId) => {
      if (assetId === null || assetId === undefined) return undefined
      const asset = this.getAsset(id, assetId)
      return asset === undefined ? undefined : asset.ip
    }
    for (const v of vulns) {
      const key = v.asset_ip || (v.target ? slugTarget(v.target) : 'Mục tiêu chưa quy thuộc')
      const g = ensure(key)
      g.vulns.push(v)
      if (g.segment === '' && v.segment_cidr) g.segment = v.segment_cidr
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) || slugTarget(a.host)
      const g = ensure(key)
      g.access.push(a)
      if (g.segment === '') { const asset = a.asset_id === null || a.asset_id === undefined ? undefined : this.getAsset(id, a.asset_id); if (asset && asset.segment_cidr) g.segment = asset.segment_cidr }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) || slugTarget(c.host)).creds.push(c)
    for (const f of files) ensure(assetIpOf(f.asset_id) || slugTarget(f.target)).files.push(f)
    for (const st of chain) if (st.asset_ip) ensure(st.asset_ip).chain.push(st)

    const renderVuln = (v) => {
      const out = []
      out.push(`#### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
      out.push(`- Mục tiêu: ${v.target || '—'}`)
      out.push(`- Trạng thái: ${v.status === 'exploited' ? 'Đã khai thác thành công' : 'Đã xác minh'} · độ tin cậy: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · cách phát hiện: ${v.source || '—'}`)
      out.push(`- Nguy hại và bằng chứng: ${v.evidence || '—'}`)
      const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
      if (evidence.length) {
        out.push('', '**Yêu cầu tái hiện (dán trực tiếp vào Burp Suite / Yakit)**: ', '')
        for (const e of evidence) {
          out.push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
          if (e.request) out.push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
          if (e.response) out.push('Tóm tắt phản hồi: ', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
        }
      }
      out.push('')
      return out
    }

    const groups = new Map()
    const list = []
    for (const g of targets.values()) {
      const lines = []
      lines.push(`## ${g.label}${g.segment ? ' (' + g.segment + ')' : ''}`, '')
      const bySeverity = { critical: 0, high: 0, medium: 0 }
      for (const v of g.vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
      lines.push(`- Kết quả: lỗ hổng ${g.vulns.length} mục (nghiêm trọng ${bySeverity.critical} · cao ${bySeverity.high} · trung bình ${bySeverity.medium}) · đã kiểm soát ${g.access.length} · thông tin xác thực ${g.creds.length} · tệp tấn công ${g.files.length}`, '')
      if (g.vulns.length) { lines.push('### Lỗ hổng đạt được', ''); for (const v of g.vulns) lines.push(...renderVuln(v)) }
      if (g.access.length) {
        lines.push('### Quyền đã đạt được', '')
        for (const a of g.access) lines.push(`- ${a.host} · ${a.username || '—'} · ${a.method || '—'} · ${a.privilege || '—'} · ${a.session_ref || ''}`)
        lines.push('')
      }
      if (g.creds.length) {
        lines.push('### Thông tin xác thực', '')
        for (const c of g.creds) lines.push(`- ${c.host} · ${c.username || '—'} · ${c.secret_type || '—'} · ${c.privilege || '—'} · ${c.secret_ref || ''}`)
        lines.push('')
      }
      if (g.files.length) {
        lines.push('### Tệp tấn công', '')
        for (const f of g.files) lines.push(`- \`${f.name}\`(${f.kind}): ${f.description || '—'}|hiệu quả: ${f.evidence}|đường dẫn: ${f.path}`)
        lines.push('')
      }
      if (g.chain.length) {
        lines.push('### Chuỗi tấn công', '')
        for (const st of g.chain) lines.push(`${st.seq}. [${st.stage}] ${st.title}${st.detail ? ' — ' + st.detail : ''}`)
        lines.push('')
      }
      const entry = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment || 'Chưa quy thuộc',
        stats: { vulns: g.vulns.length, bySeverity, accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length },
        markdown: lines.join('\n'),
      }
      list.push(entry)
      const cidr = entry.segment
      if (!groups.has(cidr)) groups.set(cidr, { cidr, targets: [] })
      groups.get(cidr).targets.push(entry)
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({ cidr: g.cidr, targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)) }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr))
    return {
      generated_at: nowIso(),
      engagement: { id, name: meta.target_name || id, scope: meta.scope_cidrs || [] },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    }
  }

  /* ---------- Report ---------- */

  /**
   * Generate the Markdown results report.
   *
   * Only deliver "result vulnerabilities": status confirmed / exploited and severity critical/high/medium.
   * Pending (candidate), false-positive, low and info entries stay out of the report --
   * they are process noise. The recon asset inventory stays out too (see the asset mapping page).
   * Kept: result vulns (with raw requests replayable in Burp/Yakit), attack chain (internal pivots),
   * obtained access and credentials, remediation advice.
   *
   * @param id - engagement id.
   * @param options - `{ all: true }` emits every vuln (self-review only, not a deliverable).
   */
  report(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const filteredOut = allVulns.length - vulns.length

    const lines = []
    const push = (...xs) => lines.push(...xs)
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const v of vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    const exploited = vulns.filter((v) => v.status === 'exploited').length

    push(`# Báo cáo kết quả diễn tập tấn công phòng thủ — ${meta.target_name || id}`, '')
    push(`- Thời điểm tạo: ${nowIso()}`)
    push(`- Phạm vi uỷ quyền: ${(meta.scope_cidrs || []).join(', ') || '(chưa ghi)'}`)
    push(`- Tổng quan kết quả: lỗ hổng ${vulns.length} mục (nghiêm trọng ${bySeverity.critical} · cao ${bySeverity.high} · trung bình ${bySeverity.medium}) · đã khai thác thành công ${exploited} mục · tài sản đã kiểm soát ${access.length} máy · thông tin xác thực đã lấy ${creds.length} bản ghi`)
    push('')

    push('## Một, lỗ hổng đạt được', '')
    if (!vulns.length) {
      push('Diễn tập lần này chưa có lỗ hổng nào bàn giao được (chỉ thu nhận lỗ hổng đã xác minh/đã khai thác và từ trung bình trở lên).', '')
    } else {
      for (const v of vulns) {
        push(`### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
        push(`- Mục tiêu: ${v.target || '—'}`)
        push(`- Tài sản: ${v.asset_ip || '—'}(${v.segment_cidr || '—'})`)
        push(`- Trạng thái: ${v.status === 'exploited' ? 'Đã khai thác thành công' : 'Đã xác minh'} · độ tin cậy: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · cách phát hiện: ${v.source || '—'}`)
        push(`- Nguy hại và bằng chứng: ${v.evidence || '—'}`)
        const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
        if (evidence.length) {
          push('', '**Yêu cầu tái hiện (dán trực tiếp vào Burp Suite / Yakit)**: ', '')
          for (const e of evidence) {
            push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
            if (e.request) push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
            if (e.response) push('Tóm tắt phản hồi: ', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
          }
        }
        push('')
      }
    }

    push('## Hai, chuỗi tấn công', '')
    if (chain.length) {
      for (const s of chain) {
        push(`${s.seq}. **[${s.stage}] ${s.title}**`)
        if (s.asset_ip) push(`   - Tài sản: ${s.asset_ip}`)
        if (s.vuln_title || s.vuln_cve) push(`   - Lỗ hổng: ${s.vuln_cve ? s.vuln_cve + ' ' : ''}${s.vuln_title || ''}`)
        if (s.detail) push(`   - Ghi chú: ${s.detail}`)
        if (s.evidence_ref) push(`   - Bằng chứng: ${s.evidence_ref}`)
      }
    } else push('(chưa ghi bước chuỗi tấn công)')
    push('')

    push('## Ba, quyền và thông tin xác thực đã đạt được', '')
    if (access.length) {
      push('| Máy chủ | Tài khoản | Cách thức | Quyền | Bằng chứng |', '| --- | --- | --- | --- | --- |')
      for (const a of access) push(`| ${a.host} | ${a.username || '—'} | ${a.method || '—'} | ${a.privilege || '—'} | ${a.session_ref || '—'} |`)
    } else push('(chưa có quyền truy cập khả dụng)')
    push('')
    if (creds.length) {
      push('| Máy chủ | Tài khoản | Loại | Quyền | Tham chiếu |', '| --- | --- | --- | --- | --- |')
      for (const c of creds) push(`| ${c.host} | ${c.username || '—'} | ${c.secret_type || '—'} | ${c.privilege || '—'} | ${c.secret_ref || '—'} |`)
    } else push('(chưa lấy được thông tin xác thực)')
    push('')

    push('## Bốn, khuyến nghị khắc phục', '')
    const advice = []
    if (vulns.some((v) => v.cve)) advice.push('1. Ưu tiên vá các thành phần bị ảnh hưởng theo mã CVE ở trên, lập baseline phiên bản thành phần và đưa vào quản lý bản vá.')
    if (access.some((a) => a.method === 'webshell' || a.method === 'rce' || a.method === 'upload')) advice.push('2. Siết bề mặt tải tệp lên và thực thi lệnh: cấm thực thi trong thư mục tải lên, kiểm tra bằng danh sách trắng, chạy tiến trình Web với quyền tối thiểu.')
    if (access.some((a) => a.method === 'vnc' || a.method === 'rdp' || a.method === 'ssh')) advice.push('3. Thu hẹp bề mặt quản trị từ xa (VNC/RDP/SSH không lộ ra internet), bắt buộc mật khẩu mạnh và xác thực đa yếu tố.')
    if (creds.some((c) => c.secret_type === 'connection-string')) advice.push('4. Cấm để lộ chuỗi kết nối cơ sở dữ liệu qua giao diện/cấu hình, đưa khóa vào quản lý khóa tập trung và bắt buộc xác thực cho giao diện.')
    advice.push(`${advice.length + 1}. Thực hiện xác thực tập trung và kiểm tra vượt quyền cho các giao diện liên quan lần này, lập bảng kê tài sản giao diện và kiểm thử hồi quy tự động.`)
    push(...advice, '')

    if (filteredOut > 0 && !includeAll) {
      push(`> Báo cáo này chỉ thu nhận lỗ hổng đã xác minh/đã khai thác và từ trung bình trở lên; ngoài ra còn ${filteredOut} bản ghi chờ xác minh, báo sai hoặc mức thấp/thông tin chưa được đưa vào (có thể xem ở trang "Chiến quả lỗ hổng").`)
      push('')
    }

    return {
      markdown: lines.join('\n'),
      generated_at: nowIso(),
      stats: {
        results: vulns.length,
        bySeverity,
        exploited,
        filteredOut,
        accesses: access.length,
        credentials: creds.length,
        chainSteps: chain.length,
      },
    }
  }

  /* ---------- Write primitives ---------- */
  #upsertSegment(db, seg) {
    db.prepare(`INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`).run(
      seg.cidr, seg.ip_start ?? null, seg.ip_end ?? null, seg.org ?? null, seg.asn ?? null,
      seg.country ?? null, seg.city ?? null, seg.source ?? null, seg.first_seen ?? nowIso(), nowIso(),
    )
  }

  #upsertAsset(db, a) {
    const cidr = a.segment_cidr || cidrOf(a.ip)
    this.#upsertSegment(db, { cidr, source: a.provenance, first_seen: a.first_seen })
    const t = nowIso()
    /* discovered_at = when this DB first saw the asset; re-collection only refreshes last_seen,
       never discovered_at (else "discovered" silently becomes "last collected"). */
    db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, discovered_at, scope)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        discovered_at = COALESCE(NULLIF(asset.discovered_at, ''), excluded.discovered_at),
        last_seen = excluded.last_seen`).run(
      cidr, a.ip, ipToInt(a.ip), a.state ?? 'unknown', a.primary_name ?? null, a.confidence ?? null,
      a.first_seen ?? t, t, a.discovered_at ?? t, a.scope || scopeOfIp(a.ip),
    )
    return db.prepare('SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?').get(cidr, a.ip).id
  }

  #observe(db, entityKind, entityId, attr, value, provenance, tool, rawRef) {
    db.prepare(`INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      entityKind, entityId, attr ?? null, value == null ? null : String(value),
      provenance ?? 'unknown', tool ?? null, nowIso(), rawRef ?? null,
    )
  }

  #edge(db, srcKind, srcId, dstKind, dstId, relation, confidence) {
    db.prepare(`INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`).run(
      srcKind, String(srcId), dstKind, String(dstId), relation, confidence ?? null, nowIso(), nowIso(),
    )
  }

  /** Rebuild the full-text index row for one asset (list, graph and agents share one index). */
  #reindex(db, assetId) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(assetId)
    if (!a) return
    /* Without FTS5 there is no index table, so skip here -- search uses listAssets' LIKE branch,
       which also spares the field extraction above. */
    if (!HAS_FTS5) return
    const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(assetId).map((r) => r.name).join(' ')
    const banners = db.prepare('SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL').all(assetId).map((r) => r.banner).join(' ')
    const titles = db.prepare('SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL').all(assetId).map((r) => r.title).join(' ')
      + ' ' + db.prepare('SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL').all(assetId).map((r) => r.url).join(' ')
      + ' ' + db.prepare(`SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?`)
        .all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    const fps = db.prepare('SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?')
      .all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    db.prepare('DELETE FROM asset_fts WHERE asset_id = ?').run(String(assetId))
    db.prepare('INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)')
      .run(String(assetId), a.ip, names, banners, titles, fps)
  }

  /**
   * Ingest collection results (the one ingest format for recon agents and external tools).
   * bundle = { scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }
   * asset  = { ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }
   */
  importBundle(id, bundle = {}) {
    const db = this.db(id)
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 }
    let runId = null
    if (bundle.scan) {
      const r = db.prepare(`INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`).run(
        bundle.scan.agent_session_id ?? null, bundle.scan.tool ?? null,
        bundle.scan.argv ? JSON.stringify(bundle.scan.argv) : null, nowIso(),
      )
      runId = Number(r.lastInsertRowid)
    }
    db.exec('BEGIN')
    try {
      for (const seg of bundle.segments || []) { this.#upsertSegment(db, seg); counts.segments++ }
      for (const a of bundle.assets || []) {
        const provenance = a.provenance || 'active'
        const tool = a.tool || (bundle.scan && bundle.scan.tool) || null
        const assetId = this.#upsertAsset(db, Object.assign({}, a, { provenance }))
        counts.assets++
        for (const n of a.names || []) {
          db.prepare(`INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`)
            .run(assetId, n.name, n.kind ?? 'domain', n.provenance ?? provenance, tool, nowIso(), nowIso())
          counts.names++
          this.#observe(db, 'asset', assetId, 'name', n.name, n.provenance ?? provenance, tool, runId)
          this.#edge(db, 'domain', n.name, 'asset', assetId, 'resolves')
        }
        if (a.primary_name) this.#observe(db, 'asset', assetId, 'primary_name', a.primary_name, provenance, tool, runId)
        for (const p of a.ports || []) {
          const pProv = p.provenance || provenance
          db.prepare(`INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`)
            .run(assetId, p.proto ?? 'tcp', Number(p.port), p.state ?? 'open', pProv, p.tool ?? tool,
              p.banner ?? null, p.url ?? null, p.title ?? null, nowIso(), nowIso())
          const portId = db.prepare('SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?')
            .get(assetId, p.proto ?? 'tcp', Number(p.port)).id
          counts.ports++
          this.#observe(db, 'port', portId, 'open', `${p.port}/${p.proto ?? 'tcp'}`, pProv, p.tool ?? tool, runId)
          if (p.service || p.product || p.version) {
            db.prepare(`INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(
              portId, p.service ?? null, p.product ?? null, p.version ?? null, p.cpe ?? null,
              pProv, p.tool ?? tool, nowIso(), nowIso(),
            )
            counts.services++
            this.#observe(db, 'port', portId, 'service', [p.service, p.product, p.version].filter(Boolean).join(' '), pProv, p.tool ?? tool, runId)
          }
          for (const fp of p.fingerprints || []) {
            db.prepare(`INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              assetId, portId, fp.category ?? null, fp.vendor ?? null, fp.product ?? null, fp.version ?? null,
              fp.evidence ?? null, fp.confidence ?? null, fp.provenance ?? pProv, fp.tool ?? tool, nowIso(), nowIso(),
            )
            counts.fingerprints++
            this.#observe(db, 'asset', assetId, 'fingerprint',
              [fp.category, fp.vendor, fp.product, fp.version].filter(Boolean).join(' '),
              fp.provenance ?? pProv, fp.tool ?? tool, runId)
          }
        }
        this.#reindex(db, assetId)
      }
      for (const e of bundle.edges || []) {
        this.#edge(db, e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.confidence)
        counts.edges++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { scan_run_id: runId, counts, stats: this.stats(id) }
  }

  /* ---------- Prompts ---------- */

  /** Default prompt fingerprint manifest (content hashes last written as defaults for this engagement). */
  promptManifestPathOf(id) { return join(this.promptsDirOf(id), '.defaults.json') }

  readPromptManifest(id) {
    try {
      const raw = readFileSync(this.promptManifestPathOf(id), 'utf8')
      const data = JSON.parse(raw)
      return data !== null && typeof data === 'object' ? data : {}
    } catch { return {} }
  }

  writePromptManifest(id, manifest) {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true })
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch { /* a failed write does not affect usage */ }
  }

  /**
   * Swap role prompts that are "still an old built-in default" for the current version; user edits stay.
   *
   * Test: the content fingerprint matches (1) this engagement's last written default (manifest), or
   * (2) any historical default fingerprint (LEGACY_PROMPT_HASHES). Neither match = user-written.
   * Runs on every prompt read (panel open), so older engagements follow new versions too.
   *
   * @param id - engagement id.
   * @param options - `{ force?: boolean }`: force also overwrites user-written ones (scripted upgrades).
   * @returns `{ changed, kept, created }` -- kept lists roles judged user-written and preserved.
   */
  refreshDefaultPrompts(id, options = {}) {
    const manifest = this.readPromptManifest(id)
    let changed = 0
    let created = 0
    const kept = []
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] || ''
      const p = join(this.promptsDirOf(id), `${role}.md`)
      /* New roles (e.g. v0.9.0 assess / main-session plan): the file is missing on older engagements,
         so create it from the current default instead of asking the user to add it */
      if (!existsSync(p)) {
        if (next !== '') {
          mkdirSync(this.promptsDirOf(id), { recursive: true })
          writeFileSync(p, next, 'utf8')
          manifest[role] = promptHash(next)
          created += 1
        }
        continue
      }
      const cur = readFileSync(p, 'utf8')
      const h = promptHash(cur)
      const hNext = promptHash(next)
      if (h === hNext) { manifest[role] = hNext; continue }
      const wasDefault = options.force === true || manifest[role] === h || (LEGACY_PROMPT_HASHES[role] || []).includes(h)
      if (!wasDefault) { kept.push(role); continue }
      /* Keep a .bak before overwriting, so a wrong verdict can be recovered */
      try { copyFileSync(p, `${p}.bak-${Date.now()}`) } catch { /* ignore */ }
      writeFileSync(p, next, 'utf8')
      manifest[role] = hNext
      changed += 1
    }
    this.writePromptManifest(id, manifest)
    return { changed, kept, created }
  }

  listPrompts(id) {
    const dir = this.promptsDirOf(id)
    mkdirSync(dir, { recursive: true })
    this.refreshDefaultPrompts(id)
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`)
      const exists = existsSync(p)
      return {
        role, title,
        /* Main session (plan) is not dispatched, only a persona reference -- label it in the panel */
        planner: role === PLANNER_ROLE,
        dispatcher: role !== PLANNER_ROLE,
        content: exists ? readFileSync(p, 'utf8') : '',
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      }
    })
  }

  /** Restore role prompts to built-in defaults (broken edits, or an old engagement wants new prompts). */
  resetPrompts(id, role) {
    if (role !== undefined && role !== null) {
      this.savePrompt(id, role, DEFAULT_PROMPTS[role] || '')
      return { reset: [role] }
    }
    const done = []
    for (const r of Object.keys(ROLE_TITLES)) { this.savePrompt(id, r, DEFAULT_PROMPTS[r] || ''); done.push(r) }
    return { reset: done }
  }

  savePrompt(id, role, content) {
    if (!ROLE_TITLES[role]) throw new Error(`unknown role: ${role}`)
    mkdirSync(this.promptsDirOf(id), { recursive: true })
    const text = String(content ?? '')
    writeFileSync(join(this.promptsDirOf(id), `${role}.md`), text, 'utf8')
    /* Note if this is the built-in default: it then auto-upgrades with new versions, else never */
    const manifest = this.readPromptManifest(id)
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[role] || '')) manifest[role] = promptHash(text)
    else delete manifest[role]
    this.writePromptManifest(id, manifest)
    return { role, bytes: Buffer.byteLength(text) }
  }

}

/* --------------------------------------------------------- Four-part scoring report
 *
 * Delivery layout (finalised 2026-10-18):
 *   1. Target-unit asset proof
 *   2. Score summary (internet asset access / boundary breach / internal asset access / target access)
 *   3. Credential/access summary (same order)
 *   4. Scoring-point reproduction (same order)
 *
 * Principles:
 *   - List only **assets and items that scored**; do not expand unscored assets per asset;
 *   - Ownership proof uses stored evidence only (domain/title/hostname/tunnel/segment/config); else "TBD";
 *   - Supply chain, jump hosts, segments, descriptive targets and unattributed rows stay separate;
 *   - Label reproduction sources honestly: linked / auto / synthesized / template; cross-port = "verify";
 *   - Credentials are masked by default; plaintext only when options.secrets === true.
 */

function rpOneLine(t, n = 300) {
  return String(t === null || t === undefined ? '' : t).replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
}
function rpClipText(t, n = 300) {
  const s = rpOneLine(t, n * 2)
  if (s.length <= n) return s
  for (const sep of ['. ', '; ', ')', ', ']) {
    const i = s.lastIndexOf(sep, n)
    if (i > n * 0.55) {
      const cut = s.slice(0, i + 1)
      return /[，,、；;：:]$/.test(cut) ? cut.slice(0, -1) + '…' : cut
    }
  }
  return s.slice(0, n) + '…'
}
function rpClip(t, n = 600) {
  const s = String(t === null || t === undefined ? '' : t).replace(/\r/g, '').trim()
  return s.length > n ? s.slice(0, n) + '\n… (đã cắt bớt, nội dung đầy đủ xem kho bằng chứng)' : s
}
function rpBalanceParens(t) {
  const s = String(t === null || t === undefined ? '' : t)
  const open = (s.match(/（/g) || []).length
  const close = (s.match(/）/g) || []).length
  return open > close ? s + ')'.repeat(open - close) : s
}
function rpCell(t, n = 120) {
  return rpBalanceParens(rpClipText(t, n)).replace(/\|/g, '\\|')
}
function rpCodeBlock(lang, text) {
  const s = String(text === null || text === undefined ? '' : text).replace(/\r/g, '').trim()
  if (s === '') return []
  const longest = Math.max(3, ...(s.match(/`+/g) || []).map((x) => x.length + 1))
  const fence = '`'.repeat(longest)
  return [fence + lang, s, fence]
}
function rpStatusLabel(s) {
  return ({ untested: 'Chưa kiểm thử', testing: 'Đang kiểm thử', tested: 'Đã kiểm thử', blocked: 'Bị chặn', abandoned: 'Đã bỏ', no_surface: 'Không có bề mặt tấn công' })[s] || s || 'Chưa kiểm thử'
}
function rpAttackPath(p) {
  const s = String(p === null || p === undefined ? '' : p).replace(/\\/g, '/').trim()
  if (s === '') return ''
  const i = s.lastIndexOf('/attack-files/')
  if (i >= 0) return s.slice(i + 1)
  if (s.startsWith('runs/') || s.startsWith('attack-files/')) return s
  const r = s.lastIndexOf('/runs/')
  return r >= 0 ? s.slice(r + 1) : basename(s)
}
function rpHostOfTarget(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const u = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
  let h = u && u[2] ? u[2] : (t.split(/[\s/?#]/)[0] || '')
  h = h.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
  return h === '' ? null : h
}
function rpHostOfRequest(request) {
  const m = /^host:\s*(\S+)/im.exec(String(request || ''))
  if (m === null) return null
  return m[1].replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
}
function rpIsHostLike(h) {
  return /^[0-9a-z.-]+$/i.test(String(h || '')) && String(h || '').includes('.')
}
function rpHostMismatch(target, reqHost) {
  const t = rpHostOfTarget(target)
  if (t === null || reqHost === null || reqHost === '') return false
  if (t.includes('/') || !rpIsHostLike(t) || !rpIsHostLike(reqHost)) return false
  if (t === reqHost) return false
  if (t.endsWith('.' + reqHost) || reqHost.endsWith('.' + t)) return false
  return true
}
function rpTargetPortOf(target) {
  const t = String(target || '').trim()
  const u = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
  const authority = u && u[1] ? u[1] : (t.split(/[\s/?#]/)[0] || '')
  const m = /:(\d{1,5})$/.exec(authority)
  return m === null ? null : m[1]
}
function rpPortsInText(text) {
  return Array.from(new Set((String(text || '').match(/:(\d{1,5})\b/g) || []).map((x) => x.slice(1))))
}
function rpPortConflict(text, target) {
  const p = rpTargetPortOf(target)
  if (p === null) return false
  const ports = rpPortsInText(text)
  if (ports.length === 0) return false
  return !ports.includes(p)
}
function rpIsHttpMethodLine(line) {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\S+\s+HTTP\/\d(?:\.\d)?\s*$/.test(String(line).trim())
}
function rpSplitHttpRequests(text) {
  const s = String(text || '').replace(/\r/g, '').trim()
  if (s === '') return []
  const out = []
  let cur = []
  for (const line of s.split('\n')) {
    if (rpIsHttpMethodLine(line) && cur.length > 0) {
      out.push(cur.join('\n').trim())
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  if (cur.length > 0) out.push(cur.join('\n').trim())
  return out.filter((b) => rpIsHttpMethodLine(b.split('\n')[0]))
}
function rpCleanHttpBlock(block) {
  return block.split('\n')
    .filter((line) => !/^\s*[（(][^（）()]*[）)]\s*$/.test(line))
    .join('\n').trim()
}
function rpValidHttpRequest(text) {
  return rpSplitHttpRequests(text).length > 0
}
function rpTokenize(text) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) out.add(m[0].toLowerCase())
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) out.add(m[0])
  for (const m of s.matchAll(/\d+(?:\.\d+)?\s*(?:万|亿|条|行|个|台|张|MB|GB|TB|thousand|million|billion|records?|rows?|hosts?|files?|nghìn|ngàn|triệu|tỷ|tỉ|bản ghi|dòng|máy|tệp)/gi)) out.add(m[0])
  return Array.from(out).slice(0, 48)
}
function rpStepMatchesItem(step, item) {
  const hay = [step.title, step.detail, step.result, step.tool].join(' ').toLowerCase()
  if (hay.trim() === '') return false
  const host = rpHostOfTarget(item.target)
  if (host !== null && host !== '' && hay.includes(host)) return true
  const port = rpTargetPortOf(item.target)
  if (port !== null && (hay.includes(':' + port) || hay.includes('/' + port))) return true
  const path = (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+(\/[^?#\s]*)?/i.exec(String(item.target || '')) || [])[1] || ''
  const seg = path.split('/').filter((x) => x.length >= 3)[0]
  if (seg && hay.includes(seg.toLowerCase())) return true
  return false
}
function rpVulnTargetMismatch(item) {
  if (!item.vuln) return false
  return rpPortConflict([item.vuln.title, item.vuln.cve].join(' '), item.target)
}
function rpStepScore(step, tokens, item) {
  const hay = [step.title, step.detail, step.result, step.tool].join(' ').toLowerCase()
  let score = 0
  for (const t of tokens) {
    const k = String(t).toLowerCase()
    if (k.length >= 2 && hay.includes(k)) score += k.length >= 4 ? 2 : 1
  }
  if (step.stage_code === item.stage_code) score += 2
  const host = rpHostOfTarget(item.target)
  if (host !== null && hay.includes(host)) score += 3
  return score
}
function rpSelectSteps(item, max = 3) {
  const steps = item.steps || []
  item._conflictSteps = []
  if (steps.length === 0) return []
  const picked = []
  const conflict = []
  const add = (s) => {
    if (!s) return
    if (rpPortConflict([s.title, s.detail, s.result, s.tool].join(' '), item.target)) {
      if (!conflict.some((x) => x.id === s.id)) conflict.push(s)
      return
    }
    if (!picked.some((x) => x.id === s.id)) picked.push(s)
  }
  if (item.step_id !== null && item.step_id !== undefined) {
    for (const s of steps.filter((x) => x.id === item.step_id)) add(s)
  }
  if (item.vuln && item.vuln.id !== null && item.vuln.id !== undefined) {
    for (const s of steps.filter((x) => x.vuln_id === item.vuln.id)) add(s)
  }
  if (item.point_id !== null && item.point_id !== undefined) {
    for (const s of steps.filter((x) => x.point_id === item.point_id)) add(s)
  }
  if (picked.length === 0) {
    const tokens = rpTokenize([item.evidence, item.gained, item.how, item.point_name, item.target].join(' '))
    const scored = steps
      .filter((s) => rpStepMatchesItem(s, item))
      .map((s) => ({ s, score: rpStepScore(s, tokens, item) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    for (const x of scored.slice(0, max)) add(x.s)
  }
  const source = item.trace && item.trace.step_source ? item.trace.step_source : 'asset'
  const limit = source === 'asset' ? max : Math.max(max, 5)
  item._conflictSteps = conflict
  return picked.slice(0, limit).sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq || 0) - (b.seq || 0)))
}
function rpSelectCreds(item, steps) {
  const list = item.credentials || []
  if (list.length === 0) return []
  const host = rpHostOfTarget(item.target)
  const text = [item.evidence, item.how, item.gained, ...(steps || []).map((s) => [s.title, s.detail, s.result].join(' '))].join(' ')
  const scored = list.map((c) => {
    let score = 0
    const ch = String(c.host || '').toLowerCase()
    if (c.username && text.includes(String(c.username))) score += 3
    if (host !== null && ch.includes(host)) score += 2
    if (c.privilege && text.includes(String(c.privilege))) score += 1
    if (c.source && text.includes(String(c.source))) score += 1
    return { c, score }
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  if (scored.length > 0) return scored.slice(0, 2).map((x) => x.c)
  return list.length === 1 ? list : []
}
function rpReplayOf(item) {
  const allRequests = (item.requests || []).filter((r) => rpValidHttpRequest(r.request))
  const primaryRaw = allRequests.find((r) => r.source === 'linked') || allRequests[0] || null
  const reqHost = primaryRaw === null ? null : rpHostOfRequest(primaryRaw.request)
  const mismatch = primaryRaw === null ? false : rpHostMismatch(item.target, reqHost)
  const requests = allRequests.filter((r) => !rpHostMismatch(item.target, rpHostOfRequest(r.request)))
  const primary = requests.find((r) => r.source === 'linked') || requests[0] || null
  const crossPort = primary !== null && rpPortConflict(primary.request, item.target)
  const template = item.replay_cmd_kind === 'template'
  const cmd = String(item.replay_cmd || '').trim()
  const cmdCross = cmd !== '' && rpPortConflict(cmd, item.target)
  const unfilled = item.replay_cmd_unfilled || []
  if (primary !== null && !mismatch) {
    return {
      kind: 'http',
      label: crossPort
        ? 'Gói tin liên kết khác cổng (điểm vào không phải cổng mục tiêu của mục này, cần đối chiếu)'
        : (primary.source === 'linked'
          ? 'Bắt gói thật (khớp mục tiêu của mục này, dán thẳng vào Burp / Yakit được)'
          : 'Gói tin tự khớp cùng mục tiêu (chưa đối chiếu từng mục, xác nhận nó đúng là yêu cầu của mục này trước khi dán)'),
      source: primary.source || 'auto', primary, blocks: rpSplitHttpRequests(primary.request).map(rpCleanHttpBlock),
      mismatch: false, reqHost, crossPort,
    }
  }
  if (cmd !== '' && !template) {
    const label = cmdCross
      ? 'Lệnh liên kết khác cổng (cổng vào/thao tác khác mục tiêu của mục này, cần đối chiếu)'
      : item.replay_cmd_kind === 'linked' || item.replay_cmd_kind === 'real'
        ? 'Lệnh thực tế trong ngày (lấy từ bước tấn công liên kết của mục này)'
        : item.replay_cmd_kind === 'synthesized'
          ? 'Lệnh tương đương dựng lại theo gói tin/lệnh thật (cần đối chiếu)'
          : 'Lệnh lấy từ bước tấn công (có thể không phải hành động của bước này, cần đối chiếu)'
    return { kind: 'cli', label, source: item.replay_cmd_kind || 'step', command: cmd, mismatch, reqHost, crossPort: cmdCross }
  }
  if (cmd !== '' && template) {
    return {
      kind: 'template',
      label: unfilled.length > 0
        ? 'Mẫu tái hiện mục điểm (placeholder chưa điền hết, không chạy trực tiếp được)'
        : 'Mẫu tái hiện mục điểm (đã điền theo bản ghi, cần đối chiếu)',
      source: 'template', command: cmd, unfilled, mismatch, reqHost, crossPort: cmdCross,
    }
  }
  return {
    kind: 'none',
    label: mismatch ? 'Host của gói tin liên kết không khớp mục tiêu của mục này, đã loại' : 'Không lưu lại điểm vào tái hiện được',
    source: 'none', mismatch, reqHost, rejected: mismatch,
  }
}
function rpItemDetailLines(item, showSecrets) {
  const out = []
  if (item.asset_ip) out.push('- **Tài sản**: `' + item.asset_ip + '`')
  if (item.gained) out.push('- **Lấy được**: ' + rpClipText(item.gained, 300))
  if (item.vuln) {
    out.push('- **Lỗ hổng khai thác**: ' + [item.vuln.cve, item.vuln.title].filter(Boolean).join(' ')
      + (item.vuln_source === 'step' ? '(liên kết từ bước tấn công, không phải điền rõ khi ghi điểm)' : ''))
  }
  if (item.recorded_at) out.push('- **Thời điểm đạt được**: ' + String(item.recorded_at).replace('T', ' ').slice(0, 19)
    + (item.recorded_by ? '(' + item.recorded_by + ')' : ''))
  if (item.nth_of_point > 1) out.push('- **Lần thứ ' + item.nth_of_point + ' cùng loại**')
  if (item.evidence) out.push('- **Nguyên văn kết quả**: ' + rpClip(item.evidence, 5000))
  if (item.how) out.push('- **Đã lấy bằng cách nào**: ' + rpClipText(item.how, 300))
  if (item.note) out.push('- **Ghi chú**: ' + rpClip(item.note, 2000))
  if ((item.replay_cmd_unfilled || []).length > 0) out.push('- **Mẫu chưa điền placeholder**: ' + item.replay_cmd_unfilled.join(', '))
  const steps = item.steps || []
  if (steps.length > 0) {
    out.push('- **Bản ghi hành động đầy đủ** (' + steps.length + ' bước): ')
    for (const [i, s] of steps.entries()) {
      const meta = [
        s.agent ? 'vai trò ' + s.agent : '',
        s.stage_code ? 'giai đoạn ' + s.stage_code : '',
        s.inferred ? 'suy theo cùng tài sản' : '',
        s.recorded_at ? String(s.recorded_at).replace('T', ' ').slice(0, 19) : '',
      ].filter(Boolean).join(' · ')
      out.push('  ' + (i + 1) + '. ' + rpClipText(s.title || '(hành động chưa đặt tên)', 160) + (meta ? '(' + meta + ')' : ''))
      if (s.detail) out.push('     - Ghi chú: ' + rpClipText(s.detail, 400))
      if (s.tool) {
        out.push('     - Lệnh: ')
        out.push(...rpCodeBlock('bash', rpClip(s.tool, 20000)).map((l) => '       ' + l))
      }
      if (s.result) out.push('     - Kết quả: ' + rpClipText(s.result, 2000))
      if (s.evidence_ref) out.push('     - Tệp bằng chứng: `' + rpAttackPath(s.evidence_ref) + '`')
    }
  }
  const creds = item.credentials || []
  if (creds.length > 0) {
    out.push('- **Thông tin xác thực (' + creds.length + ' bản ghi, mặc định che)**: ')
    for (const c of creds) {
      out.push('  - `' + (c.host || '—') + '` ' + (c.username || '(không có tên người dùng)') + ' / ' + (c.secret_type || 'password')
        + ': ' + rpSecretOf(c, showSecrets)
        + (c.privilege ? ' · quyền ' + c.privilege : '')
        + (c.source ? ' · nguồn ' + c.source : '')
        + (c.tool ? ' · cách lấy được ' + rpOneLine(c.tool, 160) : ''))
    }
  }
  const tunnels = item.tunnels || []
  if (tunnels.length > 0) {
    out.push('- **Đường hầm / kênh**: ')
    for (const t of tunnels) {
      out.push('  - `' + (t.kind || 'socks5') + ' ' + (t.listen || '') + '` điểm vào ' + (t.entry || 'chưa đăng ký')
        + (t.reach ? ' · tới được ' + t.reach : '')
        + ' · phía mục tiêu ' + (t.entry_kind || 'chưa khai báo')
        + (t.legit === false ? ' · không tính là vượt ranh giới' : '')
        + (t.status ? ' · ' + t.status : ''))
      if (t.command) {
        out.push(...rpCodeBlock('bash', rpClip(t.command, 8000)).map((l) => '    ' + l))
      }
    }
  }
  const shells = item.webshells || []
  if (shells.length > 0) {
    out.push('- **WebShell**: ')
    for (const w of shells) {
      out.push('  - `' + (w.url || '') + '` ' + (w.shell_type || 'shell')
        + (w.pass_key ? ' · mật khẩu/khóa ' + (showSecrets ? w.pass_key : '••••') : '')
        + (w.privilege ? ' · quyền ' + w.privilege : '')
        + (w.status ? ' · ' + w.status : ''))
    }
  }
  const files = item.attack_files || []
  if (files.length > 0) {
    out.push('- **Tệp tấn công (đường dẫn tái hiện)**: ')
    for (const f of files) {
      out.push('  - `' + (f.path || f.name || '') + '`'
        + (f.kind ? '(' + f.kind + ')' : '')
        + (f.name && f.path ? ' ' + f.name : '')
        + (f.description ? ': ' + rpClipText(f.description, 160) : ''))
    }
  }
  const reqs = item.requests || []
  if (reqs.length > 0) {
    out.push('- **Yêu cầu gốc (' + reqs.length + ' bản ghi)**: ')
    for (const [ri, r] of reqs.entries()) {
      out.push('  - Yêu cầu ' + (ri + 1) + ': ' + (r.label || ((r.method || 'GET') + ' ' + (r.url || '')))
        + (r.source === 'auto' ? '(tự khớp, cần đối chiếu)' : '')
        + (r.status === null || r.status === undefined ? '' : ' · HTTP ' + r.status))
      out.push(...rpCodeBlock('http', rpClip(r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1'), 20000)).map((l) => '    ' + l))
      if (r.response) {
        out.push('    - Tóm tắt phản hồi: ')
        out.push(...rpCodeBlock('http', rpClip(r.response, 1200)).map((l) => '      ' + l))
      }
    }
  }
  if ((item.gaps || []).length > 0) out.push('- **Thiếu tài liệu tái hiện**: ' + item.gaps.join('; '))
  if ((item.shots || []).length > 0) {
    out.push('- **Ảnh chụp bằng chứng**: ')
    for (const sh of item.shots) out.push('  - ' + rpOneLine(sh.label || 'ảnh bằng chứng', 160) + '(`' + (sh.url || '') + '`)')
  }
  return out
}

function rpSimpleResult(item, n = 130) {
  /* Score evidence (score_hit.evidence) is the first-hand record of what this entry actually got;
     vuln.gained is only a fallback, so a linked vuln description is never mistaken for the result. */
  const g = item.evidence || item.gained || item.point_name
  return rpClipText(g, n)
}
function rpReplayState(item) {
  const r = item._replay
  if (r.rejected) return 'Host không khớp'
  if (r.crossPort) return 'khác cổng'
  if (item._vulnMismatch) return 'liên kết khác cổng'
  if (r.kind === 'http') return r.source === 'linked' ? 'có gói tin' : 'gói tin tự khớp'
  if (r.kind === 'cli') return 'có lệnh'
  if (r.kind === 'template') return 'chỉ mẫu'
  return 'thiếu điểm vào'
}
function rpCredMatchesItem(c, x) {
  const ch = rpHostOfTarget(c.host)
  if (ch === null) return false
  const th = rpHostOfTarget(x.target)
  if (th !== null && ch === th) return true
  if (x._asset) {
    if (ch === String(x._asset.ip || '').toLowerCase()) return true
    if (ch === String(x._asset.primary_name || '').toLowerCase()) return true
    for (const n of x._asset.names || []) if (ch === String(n.name || '').toLowerCase()) return true
  }
  const text = [x.evidence, x.how, ...(x._steps || []).map((s) => [s.title, s.detail, s.result, s.tool].join(' '))].join(' ').toLowerCase()
  return text.includes(ch)
}
function rpUniqueCreds(list) {
  const map = new Map()
  for (const x of list) for (const c of x._creds || []) {
    if (!rpCredMatchesItem(c, x)) continue
    if (!map.has(c.id)) map.set(c.id, c)
  }
  return Array.from(map.values())
}
function rpSecretOf(c, showSecrets) {
  if (showSecrets) return c.secret_value || '—'
  return c.secret_value ? '••••' : '—'
}
function rpAssetProof(a, list, assets) {
  const names = [a.primary_name, ...(a.names || []).map((n) => n.name)].filter(Boolean)
  const domains = Array.from(new Set(names.filter((n) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(n))))
  const titleRank = (t) => /(管理|后台|登录|门户|OA|ERP|业务|系统|平台|运维|监控|数据库|文件|备份|邮件|堡垒|VPN)/.test(String(t)) ? 0 : 1
  const titles = Array.from(new Set((a.ports || []).filter((p) => p.state === 'open' && p.title).map((p) => p.title))).sort((x, y) => titleRank(x) - titleRank(y))
  const hostnames = Array.from(new Set((a.names || []).filter((n) => n.kind === 'hostname').map((n) => n.name)))
  const text = (names.join(' ') + ' ' + titles.join(' ')).toLowerCase()
  if (/frpnat|frp\.|fatedier|bskeji/.test(text)) {
    return { type: 'chuỗi cung ứng/máy nhảy', proof: 'Tài sản nhà cung cấp: ' + (domains.join(', ') || hostnames.join(', ') || '—') + '; dùng để vào mạng nội bộ của mục tiêu, không phải tài sản trực tiếp của mục tiêu', strength: '—' }
  }
  /* Ownership proof: recon/assess roles write "Ownership proof: ..." into test_notes by convention.
     Only with proof is it "strong"; without it domain/title stay "medium/TBD", never guessed. */
  // The anchor the recon prompt asks for; accept its English and Vietnamese spellings too.
  // The marker the recon prompt asks for. The skills were translated, so the field
  // label may arrive as `ownership_proof:`, `ownership proof:` or the Chinese form.
  const proofMatch = /(?:归属证明|ownership[ _]proof|bằng chứng sở hữu)[：:]\s*([^\n]+)/i.exec(String(a.test_notes || ''))
  const proofText = proofMatch === null ? '' : proofMatch[1].trim()
  const proofStrong = /ICP|备案|证书|CN\s*=|WHOIS|页脚|版权|单位名称|落款|公章|域名注册|certificate|footer|copyright|company name|registered domain|chứng chỉ|chân trang|bản quyền|tên công ty/i.test(proofText)
  const parts = []
  let sameSegment = false
  let evidenceLinked = false
  if (domains.length > 0) parts.push('Tên miền: ' + domains.slice(0, 3).join(', '))
  if (titles.length > 0) parts.push('Tiêu đề: ' + titles.slice(0, 2).join(', '))
  if (hostnames.length > 0) parts.push('Tên máy: ' + hostnames.slice(0, 2).join(', '))
  if (proofText !== '') parts.push('Bằng chứng quy thuộc: ' + proofText)
  if (a.scope === 'internal') {
    if (/供应链|supply chain|chuỗi cung ứng|SPD/i.test(text)) parts.push('Hệ thống nghiệp vụ nội bộ (không phải tài sản nhà cung cấp)')
    parts.push('Tới được qua đường hầm/máy nhảy phía mục tiêu')
  } else if (domains.length === 0) {
    const prefix = String(a.ip || '').split('.').slice(0, 3).join('.') + '.'
    const sibling = assets.find((b) => b.ip && b.ip !== a.ip && String(b.ip).startsWith(prefix) && b.primary_name && /[a-z]/i.test(b.primary_name))
    if (sibling) { parts.push('Cùng ' + sibling.primary_name + ' dải C'); sameSegment = true }
  }
  const own = [a.ip, a.primary_name].filter(Boolean).map((x) => String(x).toLowerCase())
  const textAll = list.map((x) => [x.evidence, x.how, ...(x._steps || []).map((st) => [st.title, st.detail, st.result, st.tool].join(' '))].join(' ')).join(' ').toLowerCase()
  evidenceLinked = own.some((x) => x && textAll.includes(x))
  if (parts.length === 0 && evidenceLinked) parts.push('Liên kết từ bằng chứng ghi điểm (mục tiêu này xuất hiện trong cấu hình/phát lại)')
  const hasEvidence = parts.length > 0
  if (!hasEvidence) parts.push('Chưa thu thập được bằng chứng quy thuộc trực tiếp (nên bổ sung chứng chỉ/đăng ký/ảnh chụp trang chủ)')
  const strong = proofStrong
  const strength = strong ? 'Mạnh' : (hasEvidence ? 'Trung bình' : 'chờ bổ sung')
  if (evidenceLinked && !strong && proofText === '' && domains.length > 0 && !parts.some((p) => p.includes('Liên kết từ bằng chứng ghi điểm'))) parts.push('Liên kết từ bằng chứng ghi điểm (mục tiêu này xuất hiện trong cấu hình/phát lại)')
  const type = a.scope === 'internal' ? 'nội bộ mục tiêu' : strong ? 'mục tiêu kết nối trực tiếp' : domains.length > 0 ? 'liên kết mục tiêu' : sameSegment ? 'cùng dải mục tiêu' : 'liên kết mục tiêu'
  return { type, proof: parts.join('; '), strength }
}

/* ══════════════════════════════════════════════════════════════════════
   Report v2: asset proof / score summary / scoring-point reproduction
   ══════════════════════════════════════════════════════════════════════ */

const REPORT_STAGES = [
  ['internet', 'Quyền tài sản internet'],
  ['boundary', 'Đột phá ranh giới'],
  ['internal', 'Quyền tài sản nội bộ'],
  ['target', 'Quyền mục tiêu'],
]

function rpReportStageOf(x) {
  const c = String(x && x.stage_code ? x.stage_code : 'internet')
  return REPORT_STAGES.some(([k]) => k === c) ? c : 'internet'
}

function rpReportCredentialText(x, showSecrets = false) {
  const list = (x.credentials || []).filter((c) => c && (c.username || c.secret_value))
  if (list.length === 0) return '—'
  return list.slice(0, 3).map((c) => String(c.username || '—') + '/' + (showSecrets
    ? String(c.secret_value === null || c.secret_value === undefined ? '' : c.secret_value)
    : (c.secret_value ? '••••' : '—'))).join('; ')
}

function rpReportUrlOf(x) {
  const t = String(x.target || '').trim()
  if (t !== '') return t
  return String(x.asset_ip || x.asset_name || '')
}

function rpReportAssetKeyOf(x) {
  if (x.asset_id !== null && x.asset_id !== undefined) return 'id:' + Number(x.asset_id)
  const h = rpHostOfTarget(x.target || '') || x.asset_ip
  return h ? 'host:' + String(h).toLowerCase() : 'item:' + x.id
}

function rpReportAssetOf(x, assetById, assetByHost) {
  let a = null
  if (x.asset_id !== null && x.asset_id !== undefined) a = assetById.get(Number(x.asset_id)) || null
  if (a === null) {
    const h = rpHostOfTarget(x.target || '') || String(x.asset_ip || '').toLowerCase()
    if (h !== null && h !== '') a = assetByHost.get(h) || null
  }
  if (a !== null) return a
  return {
    id: x.asset_id === null || x.asset_id === undefined ? null : Number(x.asset_id),
    ip: x.asset_ip || rpHostOfTarget(x.target || '') || '',
    primary_name: x.asset_name || '', names: [], ports: [],
    scope: x.asset_scope || (x.stage_code === 'internal' ? 'internal' : 'external'),
    segment_cidr: x.asset_segment || '',
  }
}

function rpReportSegmentOf(x, fallbackSegments) {
  const own = String(x.asset_segment || '').trim()
  if (own !== '') return own
  const host = rpHostOfTarget(x.target || '') || String(x.asset_ip || '').trim()
  if (host !== '' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.')
    return parts.slice(0, 3).join('.') + '.0/24'
  }
  const t = String(x.target || '')
  if (t.includes('/')) return t
  for (const reach of fallbackSegments) {
    if (reach && host !== '' && String(reach).startsWith(host.split('.').slice(0, 1).join('.'))) return reach
  }
  return 'Dải mạng chưa quy thuộc'
}

function rpReportShots(list, asset) {
  const out = []
  const seen = new Set()
  const own = asset ? [asset.ip, asset.primary_name, ...(asset.names || []).map((n) => n.name)].filter(Boolean).map((v) => String(v).toLowerCase()) : []
  for (const x of list) {
    for (const sh of (x.shots || [])) {
      if (seen.has(sh.id)) continue
      /* A point-level shot may belong to another asset of the same point; proof must not take it */
      if (own.length > 0 && sh.target && !own.some((v) => v && String(sh.target).toLowerCase().includes(v))) continue
      seen.add(sh.id)
      out.push(sh)
    }
  }
  return out.slice(0, 3)
}

function rpReportEntryOf(x) {
  const t = x.tunnels && x.tunnels[0]
  if (t && t.entry) return t.entry
  const a = x._reportAsset
  if (a && a.id !== null && a.id !== undefined) return a.primary_name || a.ip
  if (a && a.scope === 'external' && !String(x.target || '').includes('/')) return x.target
  return 'Chưa đăng ký điểm vào internet'
}

function buildReportV2(store, id, items, stages, summary, targetName, options = {}) {
  const assets = (store.listAssets(id, { limit: 2000 }).items || [])
  const assetById = new Map(assets.map((a) => [Number(a.id), a]))
  const assetByHost = new Map()
  for (const a of assets) {
    if (a.ip) assetByHost.set(String(a.ip).toLowerCase(), a)
    if (a.primary_name) assetByHost.set(String(a.primary_name).toLowerCase(), a)
    for (const n of a.names || []) if (n.name) assetByHost.set(String(n.name).toLowerCase(), a)
  }
  for (const x of items) {
    x._reportAsset = rpReportAssetOf(x, assetById, assetByHost)
    x._replay = rpReplayOf(x)
  }

  const stageOf = (x) => rpReportStageOf(x)
  const stageItems = {}
  for (const [code] of REPORT_STAGES) stageItems[code] = items.filter((x) => stageOf(x) === code)

  /* Asset ownership proof: internet assets + internal entry assets (boundary entry + first foothold) */
  const proofBuckets = { internet: new Map(), internal_entry: new Map() }
  const addProof = (bucket, x) => {
    const a = x._reportAsset
    if (a === null || a === undefined) return
    /* A boundary target may be a CIDR (172.17.0.0/16), not an asset; it cannot prove the entry asset. */
    if ((a.id === null || a.id === undefined) && (!a.ip || /^\d+\.\d+\.\d+\.0(?:\/|$)/.test(String(a.ip)))) return
    const key = String(a.id !== null && a.id !== undefined ? 'id:' + a.id : 'ip:' + (a.ip || a.primary_name || 'unknown'))
    if (!proofBuckets[bucket].has(key)) proofBuckets[bucket].set(key, { asset: a, items: [] })
    const g = proofBuckets[bucket].get(key)
    if (!g.items.some((v) => v.id === x.id)) g.items.push(x)
  }
  for (const x of stageItems.internet) addProof('internet', x)
  for (const x of stageItems.boundary) addProof('internal_entry', x)
  const firstInternal = stageItems.internal[0]
  if (firstInternal) addProof('internal_entry', firstInternal)

  const proofOf = (bucket) => Array.from(proofBuckets[bucket].values()).map((g) => {
    const p = rpAssetProof(g.asset, g.items, assets)
    return {
      asset: g.asset,
      type: p.type,
      proof: p.proof,
      strength: p.strength,
      points: g.items.reduce((n, x) => n + (Number(x.points) || 0), 0),
      count: g.items.length,
      shots: rpReportShots(g.items, g.asset),
      items: g.items.map((x) => x.id),
    }
  }).sort((a, b) => String(a.asset.ip || '').localeCompare(String(b.asset.ip || '')))

  const stageSummary = REPORT_STAGES.map(([code, name]) => {
    const list = stageItems[code] || []
    return { code, name, count: list.length, points: list.reduce((n, x) => n + (Number(x.points) || 0), 0) }
  })
  const rows = (code) => (stageItems[code] || []).map((x, i) => ({
    seq: i + 1, id: x.id, point_name: x.point_name, points: x.points, counted: x.counted,
    url: rpReportUrlOf(x), asset: x.asset_ip || x._reportAsset.ip || x.target || '—',
    credential: rpReportCredentialText(x, options.secrets === true),
    entry: rpReportEntryOf(x),
    target: x.target || '', code: x.code, stage_code: code,
  }))
  const stageTables = {
    internet: rows('internet'), boundary: rows('boundary'), internal: rows('internal'), target: rows('target'),
  }

  /* Reproduction grouping */
  const groupByAsset = (list) => {
    const m = new Map()
    for (const x of list) {
      const key = rpReportAssetKeyOf(x)
      if (!m.has(key)) m.set(key, { asset: x._reportAsset, items: [] })
      m.get(key).items.push(x)
    }
    return Array.from(m.values()).sort((a, b) => (a.items[0].chain_no || 0) - (b.items[0].chain_no || 0))
  }
  const internet = groupByAsset(stageItems.internet)

  const boundaryMap = new Map()
  for (const x of stageItems.boundary) {
    const ts = x.tunnels || []
    if (ts.length === 0) {
      const key = 'item:' + x.id
      boundaryMap.set(key, { key, tunnel: null, entry: rpReportEntryOf(x), items: [x] })
    } else {
      for (const t of ts) {
        const key = 'tunnel:' + (t.id === null || t.id === undefined ? t.listen || t.entry : t.id)
        if (!boundaryMap.has(key)) boundaryMap.set(key, { key, tunnel: t, entry: t.entry || rpReportEntryOf(x), items: [] })
        boundaryMap.get(key).items.push(x)
      }
    }
  }
  const boundary = Array.from(boundaryMap.values()).map((g) => Object.assign(g, {
    shots: rpReportShots(g.items),
    count: g.items.length,
  })).sort((a, b) => (a.items[0].chain_no || 0) - (b.items[0].chain_no || 0))

  const reachSegments = []
  for (const g of boundary) {
    const reach = g.tunnel && g.tunnel.reach ? String(g.tunnel.reach).trim() : ''
    if (reach !== '' && reachSegments.indexOf(reach) === -1) reachSegments.push(reach)
  }
  const segMap = new Map()
  for (const x of stageItems.internal) {
    const seg = rpReportSegmentOf(x, reachSegments)
    if (!segMap.has(seg)) segMap.set(seg, [])
    segMap.get(seg).push(x)
  }
  const segOrder = []
  for (const s of reachSegments) if (segMap.has(s) && segOrder.indexOf(s) === -1) segOrder.push(s)
  for (const s of Array.from(segMap.keys())) if (segOrder.indexOf(s) === -1) segOrder.push(s)
  const internal_segments = segOrder.map((cidr, i) => {
    const list = segMap.get(cidr) || []
    const assetsInSeg = groupByAsset(list).map((g) => Object.assign(g, { shots: rpReportShots(g.items) }))
    return {
      cidr, ordinal: i + 1, label: cidr === 'Dải mạng chưa quy thuộc' ? cidr : 'Dải mạng ' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'][i] || String(i + 1),
      items: list, assets: assetsInSeg, count: list.length,
      shots: rpReportShots(list),
    }
  })
  const target = groupByAsset(stageItems.target).map((g) => Object.assign(g, { shots: rpReportShots(g.items) }))
  return {
    target: targetName,
    generated_at: nowIso(),
    summary,
    stage_summary: stageSummary,
    stage_tables: stageTables,
    asset_proof: { internet: proofOf('internet'), internal_entry: proofOf('internal_entry') },
    repro: {
      internet: internet.map((g) => Object.assign(g, { shots: rpReportShots(g.items) })),
      boundary,
      internal_segments,
      target,
    },
  }
}

function rpTemplateTable(headers, rows) {
  const out = []
  out.push('| ' + headers.join(' | ') + ' |')
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |')
  for (const row of rows) out.push('| ' + row.map((v) => rpCell(v, 90)).join(' | ') + ' |')
  return out
}

function rpTemplateReproItem(x, heading, showSecrets) {
  const out = []
  out.push('#### ' + heading + ' `' + rpOneLine(x.target || x.asset_ip || '', 70) + '`', '')
  const desc = x.vuln ? [x.vuln.cve, x.vuln.title].filter(Boolean).join(' ') : (x.how || x.point_name)
  out.push('1. **Mô tả lỗ hổng**: ' + rpClipText(desc, 240))
  if (x.vuln_source === 'step') out.push('   - Liên kết lỗ hổng: lấy từ bước tấn công (không điền rõ khi ghi điểm)')
  const replaySource = x.replay_cmd_kind === 'real' || x.replay_cmd_kind === 'linked'
    ? 'lệnh thực tế trong ngày'
    : x.replay_source === 'linked' || x.replay_source === 'auto'
      ? 'bắt gói thật'
      : x.replay_cmd_kind === 'synthesized' ? 'dựng lại theo gói tin/lệnh thật, cần đối chiếu' : null
  if (replaySource) out.push('- **Nguồn tái hiện**: ' + replaySource)
  if (x.evidence) out.push('2. **Kết quả**: ' + rpClipText(x.evidence, 500))
  const r = x._replay || null
  const cmds = []
  if (x.replay_cmd) cmds.push(x.replay_cmd)
  if (r && r.command && cmds.indexOf(r.command) === -1) cmds.push(r.command)
  if (cmds.length > 0) {
    out.push('3. **Lệnh tái hiện**: ')
    for (const cmd of cmds) {
      const kind = /^(powershell|pwsh)/i.test(cmd) ? 'powershell' : 'bash'
      out.push(...rpCodeBlock(kind, rpClip(cmd, 20000)))
    }
  }
  const reqs = (x.requests || []).filter((q) => String(q.request || '').trim() !== '')
  const packets = reqs.slice(0, 3).map((q) => q.request)
  if (packets.length === 0 && x.replay_http) packets.push(x.replay_http)
  if (packets.length > 0) {
    out.push('4. **Gói tin Yakit / HTTP**: ')
    for (const q of packets) out.push(...rpCodeBlock('http', rpClip(q, 20000)))
  }
  const firstResp = reqs.find((q) => String(q.response || '').trim() !== '')
  if (firstResp) {
    out.push('5. **Tóm tắt phản hồi**: ')
    out.push(...rpCodeBlock('http', rpClip(firstResp.response, 1000)))
  }
  if (cmds.length === 0 && packets.length === 0) out.push('3. **Thiếu tái hiện**: chưa lưu lại lệnh thật hoặc gói tin HTTP, không tái hiện trực tiếp được.')
  if ((x.attack_files || []).length > 0) out.push('6. **Tệp tấn công**: ' + x.attack_files.map((f) => '`' + f.path + '`').join(', '))
  const ev = Array.from(new Set((x.steps || []).map((s) => s.evidence_ref).filter(Boolean)))
  if (ev.length > 0) out.push('7. **Tệp bằng chứng**: ' + ev.map((p) => '`' + rpAttackPath(p) + '`').join(', '))
  const shots = x.shots || []
  if (shots.length > 0) {
    out.push('')
    for (const sh of shots) {
      out.push('![' + (sh.label || 'Bằng chứng') + '](' + (sh.url || '') + ')')
      if (sh.kind === 'card') out.push('> Trích đoạn bằng chứng sinh từ bản ghi (không phải ảnh chụp tại chỗ).')
    }
  }
  out.push('')
  return out
}

function renderTemplateReport(report, options = {}) {
  const showSecrets = options.secrets === true
  const out = []
  out.push('# ' + report.target + ' · Báo cáo điểm red-team', '')
  out.push('> Thời điểm tạo: ' + String(report.generated_at || '').replace('T', ' ').slice(0, 16)
    + ' · mục tính điểm: ' + report.summary.count + ' mục · tổng điểm: ' + report.summary.points + ' điểm', '')
  const excluded = []
  if (report.summary.selfCreatedExcluded) excluded.push('tài khoản tự đăng ký/tự tạo ' + report.summary.selfCreatedExcluded + ' bản ghi')
  if (report.summary.serviceCappedExcluded) excluded.push('tài khoản/quyền cơ sở dữ liệu trùng cùng tài sản cùng cổng ' + report.summary.serviceCappedExcluded + ' bản ghi (dịch vụ đã đầy)')
  if (report.summary.disabledExcluded) excluded.push('mục tính điểm đã tắt ' + report.summary.disabledExcluded + ' bản ghi')
  if (excluded.length > 0) out.push('> Chưa tính vào: ' + excluded.join('; ') + '.')
  out.push('> Ảnh chụp bằng chứng: kèm ảnh đại diện theo quy thuộc tài sản và mục tái hiện (mỗi mục tính điểm tối đa 3 ảnh).', '')
  out.push('## Một, chứng minh quy thuộc tài sản', '')
  for (const [key, title] of [['internet', '1.1 Chứng minh quy thuộc tài sản internet'], ['internal_entry', '1.2 Chứng minh quy thuộc tài sản điểm vào nội bộ']]) {
    out.push('### ' + title, '')
    const list = report.asset_proof[key] || []
    if (list.length === 0) { out.push('Chưa thu thập được bằng chứng tài sản tương ứng.', ''); continue }
    for (const g of list) {
      out.push('#### `' + (g.asset.ip || g.asset.primary_name || 'Tài sản chưa đặt tên') + '`' + (g.asset.primary_name ? ' (' + g.asset.primary_name + ')' : ''), '')
      out.push('- **Loại quy thuộc**: ' + g.type)
      out.push('- **Độ mạnh chứng minh**: ' + g.strength)
      out.push('- **Bằng chứng quy thuộc**: ' + rpClipText(g.proof, 700))
      if (g.shots.length > 0) {
        out.push('')
        for (const sh of g.shots) {
          out.push('![' + (sh.label || 'bằng chứng quy thuộc') + '](' + (sh.url || '') + ')')
          if (sh.kind === 'card') out.push('> Trích đoạn bằng chứng sinh từ bản ghi (không phải ảnh chụp tại chỗ).')
        }
      }
      out.push('')
    }
  }
  out.push('## Hai, bảng tổng hợp điểm', '')
  out.push(...rpTemplateTable(['Giai đoạn', 'Mục tính điểm', 'Điểm'], report.stage_summary.map((s) => [s.name, s.count, '+' + s.points])), '')
  for (const [idx, s] of report.stage_summary.entries()) {
    const code = s.code
    out.push('### 2.' + (idx + 1) + ' ' + s.name + ' (' + s.count + ' mục / +' + s.points + ' điểm)', '')
    const list = report.stage_tables[code] || []
    if (list.length === 0) { out.push('Giai đoạn này không có mục ghi điểm.', ''); continue }
    const headers = code === 'internet' ? ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'URL', 'Thông tin đăng nhập']
      : code === 'boundary' ? ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'Điểm vào internet']
        : ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'Tài sản', 'Thông tin xác thực']
    out.push(...rpTemplateTable(headers, list.map((r) => {
      const base = [r.seq, r.point_name, '+' + r.points]
      if (code === 'internet') return base.concat([r.url, r.credential])
      if (code === 'boundary') return base.concat([r.entry])
      return base.concat([r.asset, r.credential])
    })), '')
  }
  out.push('## Ba, tái hiện mục tính điểm', '')
  out.push('### 3.1 Tái hiện điểm tài sản internet', '')
  if (report.repro.internet.length === 0) out.push('Không có mục điểm tài sản internet.', '')
  for (const [i, g] of report.repro.internet.entries()) {
    out.push('#### 3.1.' + (i + 1) + ' ' + (g.asset.ip || g.asset.primary_name || 'Tài sản chưa đặt tên'), '')
    for (const [j, x] of g.items.entries()) out.push(...rpTemplateReproItem(x, '3.1.' + (i + 1) + '.' + (j + 1), showSecrets))
  }
  out.push('### 3.2 Tái hiện đột phá ranh giới internet', '')
  if (report.repro.boundary.length === 0) out.push('Không có mục điểm đột phá ranh giới.', '')
  for (const [i, g] of report.repro.boundary.entries()) {
    out.push('#### 3.2.' + (i + 1) + ' Đường hầm ' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'][i] || String(i + 1), '')
    out.push('1. **Điểm vào**: `' + rpOneLine(g.entry || '—', 120) + '`')
    if (g.tunnel) {
      out.push('2. **Tham số đường hầm**: `' + (g.tunnel.kind || 'socks5') + ' ' + (g.tunnel.listen || '') + '`'
        + (g.tunnel.reach ? ', tới được `' + g.tunnel.reach + '`' : ''))
      if (g.tunnel.command) out.push(...rpCodeBlock('bash', rpClip(g.tunnel.command, 20000)))
    } else out.push('2. **Thiếu bản ghi đường hầm**: chỉ nhóm theo target của mục điểm, cần bổ sung bằng chứng dựng đường hầm.')
    for (const [j, x] of g.items.entries()) out.push(...rpTemplateReproItem(x, '3.2.' + (i + 1) + '.' + (j + 1), showSecrets))
  }
  out.push('### 3.3 Tái hiện điểm tài sản nội bộ', '')
  if (report.repro.internal_segments.length === 0) out.push('Không có mục điểm tài sản nội bộ.', '')
  for (const [i, seg] of report.repro.internal_segments.entries()) {
    out.push('#### 3.3.' + (i + 1) + ' ' + seg.label + ' “' + seg.cidr + '”', '')
    for (const [j, a] of seg.assets.entries()) {
      for (const [k, x] of a.items.entries()) out.push(...rpTemplateReproItem(x, '3.3.' + (i + 1) + '.' + (j + 1) + '.' + (k + 1), showSecrets))
    }
  }
  out.push('### 3.4 Tái hiện quyền mục tiêu', '')
  if (report.repro.target.length === 0) out.push('Không có mục điểm quyền mục tiêu.', '')
  for (const [i, g] of report.repro.target.entries()) {
    for (const [j, x] of g.items.entries()) out.push(...rpTemplateReproItem(x, '3.4.' + (i + 1) + '.' + (j + 1), showSecrets))
  }
  return out.join('\n')
}

function renderDeliveryReport(store, id, items, targetName, options = {}, summary = {}) {
  const showSecrets = options.secrets === true
  const assets = (store.listAssets(id, { limit: 2000 }).items || [])
  const stats = store.stats(id)
  const webshells = store.listWebshells(id, { limit: 20 })
  const tunnels = store.listTunnels(id, { limit: 20 })
  const assetById = new Map(assets.map((a) => [Number(a.id), a]))
  const assetByHost = new Map()
  for (const a of assets) {
    if (a.ip) assetByHost.set(String(a.ip).toLowerCase(), a)
    if (a.primary_name) assetByHost.set(String(a.primary_name).toLowerCase(), a)
    for (const n of a.names || []) if (n.name) assetByHost.set(String(n.name).toLowerCase(), a)
  }
  const resolveAsset = (item) => {
    if (item.asset_id !== null && item.asset_id !== undefined && assetById.has(Number(item.asset_id))) return assetById.get(Number(item.asset_id))
    const h = rpHostOfTarget(item.target)
    if (h !== null && assetByHost.has(h)) return assetByHost.get(h)
    return null
  }
  for (const item of items) {
    item._asset = resolveAsset(item)
    item._vulnMismatch = rpVulnTargetMismatch(item)
    /* Boundary rows need boundary evidence (entry zone / foothold zone / isolated device / internal assets).
       Old rows lack the [boundary evidence] note marker, so the report marks them TBD, not proven. */
    // The marker the skill tells the operator to write. Accept the bracketed, unbracketed
  // and Chinese forms — the skill text was translated, so all three now occur.
  item._boundaryMissing = /^boundary-/.test(String(item.code || ''))
    && !/(?:【边界证据】|boundary[ _]evidence|bằng chứng biên giới)/i.test(String(item.note || ''))
    item._replay = rpReplayOf(item)
    item._steps = rpSelectSteps(item)
    item._stepsUnmatched = item._steps.length === 0 && (item.steps || []).length > 0 && (item._conflictSteps || []).length === 0
    item._creds = rpSelectCreds(item, item._steps)
  }
  const groups = new Map()
  for (const item of items) {
    const a = item._asset
    const key = a ? 'asset:' + a.id : (() => {
      const h = rpHostOfTarget(item.target)
      return 'host:' + (h || rpOneLine(item.target, 60) || 'unknown')
    })()
    if (!groups.has(key)) groups.set(key, { key, asset: a, label: a ? null : (rpHostOfTarget(item.target) || rpOneLine(item.target, 60)), items: [], points: 0 })
    const g = groups.get(key)
    g.items.push(item)
    g.points += Number(item.points) || 0
  }
  const groupList = Array.from(groups.values()).sort((a, b) => {
    if (a.asset && !b.asset) return -1
    if (!a.asset && b.asset) return 1
    return b.points - a.points
  })
  for (const [gi, g] of groupList.entries()) {
    g.no = gi + 1
    g.items.sort((a, b) => (a.chain_no || a.seq || 0) - (b.chain_no || b.seq || 0))
    g.items.forEach((item, ii) => { item._section = g.no + '.' + (ii + 1) })
  }
  const stageOrder = ['internet', 'boundary', 'internal', 'target']
  const stageName = { internet: 'Quyền tài sản internet', boundary: 'Đột phá ranh giới', internal: 'Quyền tài sản nội bộ', target: 'Quyền mục tiêu' }
  const byStage = new Map()
  for (const st of stageOrder) byStage.set(st, items.filter((x) => x.stage_code === st).sort((a, b) => (a.chain_no || 0) - (b.chain_no || 0)))
  for (const [si, st] of stageOrder.entries()) {
    for (const [ii, x] of (byStage.get(st) || []).entries()) {
      x._scoreNo = '2.' + (si + 1) + '.' + (ii + 1)
      x._reproNo = '4.' + (si + 1) + '.' + (ii + 1)
    }
  }
  const lines = []
  const totalPoints = items.reduce((n, x) => n + (Number(x.points) || 0), 0)
  const assetGroups = groupList.filter((g) => g.asset)
  const unassigned = groupList.filter((g) => !g.asset)
  const target = targetName || id
  lines.push('# ' + target + ' · Báo cáo điểm red-team', '')
  lines.push('> Mục tiêu: ' + target + ' · tạo lúc: ' + String(nowIso()).replace('T', ' ').slice(0, 16) + ' · mục tính điểm: ' + items.length + ' mục · tổng điểm: ' + totalPoints + ' điểm · tài sản đã ghi điểm: ' + assetGroups.length + ' máy' + (unassigned.length > 0 ? '(ngoài ra còn ' + unassigned.length + ' mục chưa quy thuộc/dải mạng)' : ''), '')
  lines.push('> Chỉ liệt kê **tài sản và mục đã ghi điểm**; tài sản chưa tính điểm, lỗ hổng và gói tin đầy đủ xem trên bảng điều khiển. Thông tin xác thực mặc định được che, xem trên máy này thêm `secrets: true`.', '')
  const excluded = []
  if (summary.selfCreatedExcluded) excluded.push('tài khoản tự đăng ký/tự tạo ' + summary.selfCreatedExcluded + ' bản ghi')
  if (summary.serviceCappedExcluded) excluded.push('tài khoản/quyền cơ sở dữ liệu trùng cùng tài sản cùng cổng ' + summary.serviceCappedExcluded + ' bản ghi (dịch vụ đã đầy)')
  if (summary.disabledExcluded) excluded.push('mục tính điểm đã tắt ' + summary.disabledExcluded + ' bản ghi')
  if (excluded.length > 0) lines.push('> Chưa tính vào: ' + excluded.join('; ') + ' (khớp tiêu chí trên bảng điều khiển).')
  lines.push('')
  /* 1. Asset proof */
  lines.push('## Một, chứng minh tài sản của đơn vị mục tiêu', '')
  lines.push('> Tiêu chí chứng minh: có bằng chứng quy thuộc như ICP/chứng chỉ/WHOIS/chân trang trang chủ → mục tiêu kết nối trực tiếp; chỉ có tên miền/tiêu đề/cùng dải/đường hầm tới được → liên kết mục tiêu/cùng dải; đường hầm phía mục tiêu tới được + hệ thống nghiệp vụ nội bộ → nội bộ mục tiêu; tài sản chuỗi cung ứng/máy nhảy liệt kê riêng. Độ mạnh: Mạnh = có bằng chứng quy thuộc như đăng ký ICP/chứng chỉ/WHOIS/chân trang trang chủ/ký tên đơn vị; Trung bình = cùng dải/đường hầm tới được hoặc liên kết cấu hình; chờ bổ sung = không có bằng chứng trực tiếp (nên bổ sung ảnh trang chủ/đăng ký).', '')
  lines.push('| # | Tài sản | Loại quy thuộc | Bằng chứng quy thuộc | Độ mạnh chứng minh | Điểm |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const [i, g] of assetGroups.entries()) {
    const p = rpAssetProof(g.asset, g.items, assets)
    lines.push('| A' + (i + 1) + ' | `' + g.asset.ip + '`' + (g.asset.primary_name ? '(' + rpCell(g.asset.primary_name, 28) + ')' : '') + ' | ' + p.type + ' | ' + rpCell(p.proof, 110) + ' | ' + p.strength + ' | +' + g.points + ' / ' + g.items.length + ' mục |')
  }
  for (const [i, g] of unassigned.entries()) {
    const label = String(g.label || '')
    const isCidr = label.includes('/') || /\.0$/.test(label)
    const isDescriptive = /[\u4e00-\u9fa5]/.test(label) && !/^\d+\.\d+\.\d+\.\d+$/.test(label)
    const isJump = /VPS|跳板|jump ?host|bastion|máy nhảy/i.test(label) || (g.items.length > 0 && g.items.every((x) => x.code === 'terminal-access' || String(x.target || '').includes('→')))
    const type = isCidr ? 'liên tài sản/dải mạng' : isJump ? 'máy nhảy/VPS' : isDescriptive ? 'target mô tả' : 'chưa liên kết'
    const proof = isCidr
      ? 'mục đột phá ranh giới, tính điểm theo dải mạng tới được; không phải một tài sản đơn lẻ'
      : isJump
        ? 'máy nhảy/VPS dùng cho diễn tập (không phải tài sản của đơn vị mục tiêu), chỉ dùng để mang đường hầm/điểm vào thiết bị đầu cuối'
        : isDescriptive
          ? 'Nhóm theo target của mục điểm, trong kho không có bản ghi tài sản tương ứng; nên bổ sung asset_id và bằng chứng quy thuộc'
          : 'Chỉ nhóm theo target, trong kho không có bản ghi tài sản khớp; cần bổ sung asset_id và bằng chứng quy thuộc'
    lines.push('| A' + (assetGroups.length + i + 1) + ' | `' + rpCell(label, 28) + '` | ' + type + ' | ' + proof + ' | chờ bổ sung | +' + g.points + ' / ' + g.items.length + ' mục |')
  }
  lines.push('')
  /* 2. Score summary */
  lines.push('## Hai, bảng tổng hợp điểm', '')
  lines.push('| Giai đoạn | Mục tính điểm | Điểm | Tỷ lệ |')
  lines.push('| --- | --- | --- | --- |')
  for (const st of stageOrder) {
    const list = byStage.get(st) || []
    const pts = list.reduce((n, x) => n + (Number(x.points) || 0), 0)
    lines.push('| ' + stageName[st] + ' | ' + list.length + ' | +' + pts + ' | ' + (totalPoints > 0 ? (pts / totalPoints * 100).toFixed(1) : '0.0') + '% |')
  }
  lines.push('')
  lines.push('> Trạng thái tái hiện: có gói tin = gói tin liên kết thật; gói tin tự khớp = tự khớp cùng mục tiêu, cần đối chiếu; có lệnh = lệnh của bước liên kết; chỉ mẫu = không lưu lệnh; thiếu điểm vào = không có bằng chứng; khác cổng/liên kết khác cổng = điểm vào hoặc cổng thao tác không phải mục tiêu của mục này, cần đối chiếu; Host không khớp = mục tiêu của gói tin không trùng, đã loại.', '')
  for (const [si, st] of stageOrder.entries()) {
    const list = byStage.get(st) || []
    const pts = list.reduce((n, x) => n + (Number(x.points) || 0), 0)
    lines.push('### 2.' + (si + 1) + ' ' + stageName[st] + ' (' + list.length + ' mục / +' + pts + ' điểm)', '')
    if (list.length === 0) { lines.push('Giai đoạn này không có mục ghi điểm.', ''); continue }
    lines.push('| # | Mục điểm | Điểm số | Tài sản | Kết quả | Tái hiện |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const x of list) {
      const asset = x._asset ? x._asset.ip : x.target
      lines.push('| ' + x._scoreNo + ' | ' + rpCell(x.point_name, 32) + ' | +' + x.points + ' | `' + rpCell(asset, 42) + '` | ' + rpCell(rpSimpleResult(x), 66) + ' | ' + rpReplayState(x) + ' |')
    }
    lines.push('')
  }
  /* 3. Credentials */
  lines.push('## Ba, bảng tổng hợp tài khoản mật khẩu và quyền', '')
  lines.push('> Chỉ liệt kê thông tin xác thực dùng trực tiếp cho mục tính điểm; `••••` là che mặc định. Đầy đủ ' + (stats.credentials || 0) + ' bản ghi xem trên bảng điều khiển.', '')
  for (const [si, st] of stageOrder.entries()) {
    const list = byStage.get(st) || []
    lines.push('### 3.' + (si + 1) + ' ' + stageName[st], '')
    if (list.length === 0) { lines.push('Giai đoạn này không có mục ghi điểm.', ''); continue }
    const creds = rpUniqueCreds(list)
    if (creds.length === 0) {
      lines.push('Giai đoạn này chưa có tài khoản, thông tin xác thực mới.', '')
    } else {
      lines.push('| Tài sản | Tài khoản | Quyền | Nguồn | Bản rõ | Dùng cho |')
      lines.push('| --- | --- | --- | --- | --- | --- |')
      for (const c of creds) {
        const used = list.filter((x) => (x._creds || []).some((y) => y.id === c.id) && rpCredMatchesItem(c, x)).map((x) => x._scoreNo).slice(0, 5).join(', ')
        lines.push('| `' + rpCell(c.host, 38) + '` | ' + rpCell(c.username || '—', 18) + ' | ' + rpCell(c.privilege || '—', 34) + ' | ' + rpCell(c.source || '—', 28) + ' | ' + rpCell(rpSecretOf(c, showSecrets), 22) + ' | ' + used + ' |')
      }
      lines.push('')
    }
    if (st === 'boundary') {
      lines.push('**Điểm vào biên giới (WebShell / đường hầm)**', '')
      const ws = (webshells || []).filter((w) => w.status === 'online' || w.status === undefined).slice(0, 4)
      const tn = (tunnels || []).filter((t) => t.status === 'active').slice(0, 4)
      if (ws.length === 0 && tn.length === 0) {
        lines.push('Chưa đăng ký WebShell / đường hầm đang trực tuyến.', '')
      } else {
        lines.push('| Loại | Điểm vào | Thông tin xác thực / khóa | Tới được / trạng thái |')
        lines.push('| --- | --- | --- | --- |')
        for (const w of ws) {
          lines.push('| WebShell | `' + rpCell(w.url, 48) + '` | ' + rpCell(w.shell_type || '', 14) + ' / ' + rpCell(showSecrets ? (w.pass_key || '') : (w.pass_key ? '••••' : ''), 18) + ' | ' + rpCell(w.status || '', 10) + ' |')
        }
        for (const t of tn) {
          lines.push('| Đường hầm | ' + rpCell(t.kind || '', 12) + ' `' + rpCell(t.listen || '', 28) + '` | ' + rpCell(t.entry_kind || '', 18) + ' | ' + rpCell(t.reach || '', 38) + ' / ' + rpCell(t.status || '', 10) + ' |')
        }
        lines.push('')
      }
    }
  }
  /* 4. Reproduction */
  lines.push('## Bốn, tái hiện mục điểm', '')
  lines.push('> Mỗi mục chỉ nêu một đường tái hiện ngắn nhất; gói tin / lệnh đầy đủ xem trên bảng điều khiển.', '')
  for (const [si, st] of stageOrder.entries()) {
    const list = byStage.get(st) || []
    lines.push('### 4.' + (si + 1) + ' ' + stageName[st], '')
    if (list.length === 0) { lines.push('Giai đoạn này không có mục ghi điểm.', ''); continue }
    for (const x of list) {
      lines.push('#### ' + x._reproNo + ' ' + x.point_name + '(+' + x.points + ' điểm) — `' + rpOneLine(x.target, 70) + '`', '')
      lines.push('- **Kết quả**: ' + rpSimpleResult(x, 240))
      if (x.confirm && x.confirm.need) lines.push('- **Xác định**: ' + rpClipText(x.confirm.need, 140))
      lines.push('- **Tái hiện**: ' + x._replay.label)
      const r = x._replay
      if (r.kind === 'http') {
        const blocks = (r.blocks || []).slice(0, 2)
        for (const [bi, b] of blocks.entries()) {
          if (blocks.length > 1) lines.push('Yêu cầu ' + (bi + 1) + '/' + blocks.length + ': ')
          lines.push(...rpCodeBlock('http', rpClip(b, 1100)))
        }
        const resp = r.primary && r.primary.response ? rpClipText(r.primary.response, 220) : ''
        if (resp) lines.push('- **Phản hồi dự kiến**: ', ...rpCodeBlock('http', rpClip(resp, 220)))
      } else if (r.kind === 'cli') {
        lines.push(...rpCodeBlock('bash', rpClip(r.command, 900)))
      } else if (r.kind === 'template') {
        lines.push(...rpCodeBlock('bash', rpClip(r.command, 700)))
        lines.push('> Chỉ mẫu / không lưu lệnh trong ngày, cần phát lại theo mục tiêu.')
      } else {
        lines.push('> Thiếu điểm vào tái hiện: cần bổ sung lệnh `chain_add` hoặc gói tin `http_evidence_add`.')
      }
      /* Full entry: steps / creds / tunnels / webshells / attack files / all packets / gaps the panel shows,
         so the downloaded Markdown has them too; a single shortest path loses "page yes, file no". */
      lines.push(...rpItemDetailLines(x, showSecrets))
      let hasTunnelCmd = false
      if (st === 'boundary') {
        const prefix = (String(x.target || '').match(/\d+\.\d+\.\d+/) || [])[0] || ''
        const allTunnels = (tunnels || []).filter((t) => t.status === 'active' && t.command)
        const related = allTunnels.filter((t) => (prefix && String(t.reach || '').includes(prefix)) || String(x.target || '').includes(String(t.listen || '')) || String(x.target || '').includes(String(t.reach || '')))
        const pick = related.length > 0 ? related.slice(0, 1) : []
        if (pick.length > 0) {
          hasTunnelCmd = true
          lines.push('- **Lệnh dựng đường hầm**: ')
          lines.push(...rpCodeBlock('bash', rpClip(pick[0].command, 700)))
        } else if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(String(x.target || ''))) {
          lines.push('> Lệnh dựng đường hầm không được lưu trong bản ghi đường hầm, xem "Đường hầm phiên" trên bảng điều khiển.')
        }
      }
      lines.push('- **Ảnh chụp bằng chứng**: ' + (x.shots || []).length + ' ảnh / gói tin ' + (x.requests || []).length + ' bản ghi / bước ' + (x._steps || []).length + ' bước')
      if ((x.shots || []).length > 0) {
        /* The panel's ShotStrip shows all representative shots (max 3); one in the file loses content */
        for (const [si, sh] of x.shots.entries()) {
          lines.push('', '![' + (si === 0 ? 'Bằng chứng' : 'Bằng chứng ' + (si + 1)) + '](' + (sh.url || '') + ')')
          lines.push('> ' + rpOneLine(sh.label || '', 140) + (sh.kind === 'card' ? '(trích đoạn bằng chứng sinh từ bản ghi, không phải ảnh chụp tại chỗ)' : ''))
        }
      }
      if (x._boundaryMissing) lines.push('- **Thiếu sót**: bằng chứng biên giới chờ bổ sung — bốn câu hỏi về vùng vào/vùng điểm rơi/thiết bị cách ly/tài sản nội bộ mục tiêu thực sự truy cập được chưa đầy đủ; đường hầm cùng vùng chỉ tính theo internal.')
      else if (x._vulnMismatch) lines.push('- **Thiếu sót**: lỗ hổng/điểm vào liên kết khác cổng, cần đối chiếu quan hệ nhân quả giữa điểm vào và mục tiêu.')
      else if (r.rejected) lines.push('- **Thiếu sót**: Host của gói tin liên kết không khớp mục tiêu của mục này, đã loại; cần gán lại.')
      else if (r.crossPort) lines.push('- **Thiếu sót**: liên kết khác cổng, điểm vào/cổng thao tác không phải mục tiêu của mục này, cần đối chiếu.')
      else if (r.kind === 'template' && hasTunnelCmd) lines.push('- **Thiếu sót**: placeholder của mẫu tái hiện chưa điền; lệnh đường hầm đã có, cần bổ sung một bản ghi lệnh truy cập nội bộ đã đo thực tế.')
      else if (r.kind === 'template') lines.push('- **Thiếu sót**: chỉ mẫu, không lưu lệnh thật; cần bổ sung.')
      else if (r.kind === 'none') lines.push('- **Thiếu sót**: không có điểm vào tái hiện; cần bổ sung.')
      lines.push('')
    }
  }
  lines.push('---', '')
  const cardShots = items.reduce((n, x) => n + (x.shots || []).filter((sh) => sh.kind === 'card').length, 0)
  if (cardShots > 0) lines.push('> Ghi chú bằng chứng: trong báo cáo có ' + cardShots + ' ảnh là trích đoạn bằng chứng sinh từ bản ghi (không phải ảnh chụp tại chỗ); ảnh chụp tại chỗ được ghi chú riêng.')
  lines.push('> Báo cáo này chỉ liệt kê tài sản ghi điểm và mục ghi điểm; tài sản chưa tính điểm, lỗ hổng chưa khai thác, chỉ mục bằng chứng đầy đủ xem trên bảng điều khiển.')
  return lines.join('\n')
}
