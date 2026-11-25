/**
 * Score rules: decision criteria + default score points (zero deps, node: builtins only).
 *
 * Extracted from core.js, and also **the one file in this project most worth reading on its own**:
 * the panel / report / attack-chain totals must agree, and that only holds because applyScoreCaps and
 * evaluateScoreBoard here are the **single implementation** — three copies drift into three criteria.
 *
 * Roles:
 *   · applyScoreCaps       —— given hit rows, mark which ones score and which are capped/over cap;
 *   · evaluateScoreBoard   —— wrap "read metadata + call applyScoreCaps + backfill flags" as one entry;
 *   · DEFAULT_SCORE_POINTS —— score points as expanded from the rule doc (src/rule/cap/dedup_scope).
 */

/* targetHasIpv6Host must detect IPv6 literals: reuse ip-utils so two regexes cannot drift*/
import { isIpv6 } from './ip-utils.js'

/* ------------------------------------------------------------------ decision rules*/

/* ------------------------------------------------------------------ decision rules*/

/**
 * What counts as a "real tunnel" (proof of boundary break / internal pivot): **the target boundary
 * must be crossed**, i.e. one end of the channel sits on the target side. Three cases:
 *   · target-outbound: target dials out to my server (reverse shell landed, frp/Stowaway on target)
 *   · target-http: through target WebShell/HTTP channel (suo5, Neo-ReGeorg, reGeorg, custom HTTP tunnel)
 *   · target-agent: tunnel relayed via an owned process/session on target (target-initiated SSH -R, etc.)
 * Not counted: self-only —— proxy or listener on my own VPS / self-hosted server, never hitting the target.
 */
const TUNNEL_ENTRY_KINDS = {
  'target-outbound': 'target dials out (reverse shell / frp client running on the target)',
  'target-http': 'through the target WebShell/HTTP channel (suo5 / Neo-ReGeorg)',
  'target-agent': 'relayed via an owned process/session on the target (SSH -R, etc.)',
  'self-only': 'only on my own VPS/self-hosted server (not a boundary break)',
}
export { TUNNEL_ENTRY_KINDS }

/** Whether this tunnel crosses the target boundary. Undeclared (old data) → null, UI shows "pending".*/
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * Account/permission points: **a self-registered account is not access obtained** (the drill scores taking
 * over accounts someone else already had). Hits must declare self_created, so self-signup is not a result.
 */
const ACCOUNT_POINT_CODES = ['web-account-user', 'web-account-admin', 'server-shell', 'db-access', 'internal-pivot', 'core-system']
export { ACCOUNT_POINT_CODES }

/**
 * Score points capped per service: **one port on one asset scores once**.
 *
 *   · Account class (web-account-user / web-account-admin) —— the top-privilege account fills the service:
 *     user account 10 pts, admin 20 pts; more accounts on the same service do not stack
 *     (both classes are **one class**: user then admin → only the admin row scores, total from the highest).
 *   · Database class (db-access) —— same rule: one DB credential fills it, a 2nd account does not re-score.
 *
 * Other points (webshell/rce/sensitive-data/boundary/…) stay uncapped and accumulate per hit.
 */
const SERVICE_CAPPED_POINT_CODES = ['web-account-user', 'web-account-admin', 'db-access']
export { SERVICE_CAPPED_POINT_CODES }

/**
 * Parse the port out of target: `http://h:8080/x`, `10.0.0.5:6379`, `10.0.0.5:22`.
 * No port or unparseable returns null (**never invent 80/443**, or distinct services get merged).
 */
export function parseTargetPort(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** Port value from the DB column (old rows may be null/0/empty string).*/
function normalizePort(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * Extract the service identity from target: host[:port].
 *   · Port is the explicit one; when absent, infer from scheme (http→80, https→443, other→none),
 *     so `http://h/x` and `http://h:80/y` land on the same service;
 *   · Path/params/query are always dropped (`http://h:8080/a/b?c=1` → `h:8080`).
 * Returns null when host cannot be parsed.
 */
function targetAuthority(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  /* With no port written, fill the scheme default: else one service written two ways is scored twice*/
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * Service key: the cap granularity = one port on one asset.
 *   · target yields host[:port] → use it (`t10.20.30.40:3306`) ——
 *     the same service may be recorded by different people, some with asset_id, some with target only;
 *     keying on the target is the only way to group them;
 *   · target unparseable (missing / name only) → fall back to the asset: with port use `a<id>:<port>`,
 *     without one record `a<id>:0` (unknown port of that asset);
 *   · neither → null (no service info, this row takes no part in capping).
 */
export function scoreServiceKey(hit = {}) {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  if (assetId === null) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/** Human-readable label for the service, used by alerts/reports (e.g. `10.1.2.3:8080`).*/
export function serviceLabel(hit = {}, assetIp) {
  const ip = assetIp || hit.asset_ip || ''
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target)
  if (ip !== '') return port === null ? ip : ip + ':' + port
  /* With no asset id, use host[:port] from target (drop path and params, never treat the whole URL as a name);
     fill the port when it came from the DB column and target omits it, so the service is visible.*/
  const authority = targetAuthority(hit.target)
  if (authority === null) return hit.target ? String(hit.target) : '(unlabelled service)'
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ':' + port
  return authority
}

/**
 * The **single implementation** of score capping and dedup (data-driven since v0.11.0).
 *
 * Decision fields come from the point itself (`score_point.rule / cap / dedup_scope`), not a hardcoded list:
 *   · `dedup_scope = service` —— per (asset, port) only the highest-value row scores;
 *   · `dedup_scope = system`  —— per (asset, port, system name) only the top privilege scores,
 *     for "one system counts its highest privilege once" (mail / OA / central systems, etc.);
 *   · `dedup_scope = target`  —— the whole target counts once (boundary break, IPv6 bonus);
 *   · `dedup_scope = none`    —— no dedup, accumulate by unit/card/node (compute cards, etc.).
 * Then accumulate per `rule` group; past that rule's `cap` is flagged `capped` (cap = 0 means uncapped).
 *
 * `self_created = 1` (self-registered/self-built accounts) never scores: neither competes nor takes a slot.
 *
 * @param {Array} rows - hit rows (need code / points / asset_id / port / target / recorded_at;
 *                        optional system_key for the system scope)
 * @param {Map|Object|null} pointsByCode - code → `{rule, cap, dedup_scope, points}`;
 *                        omitted → "each code its own group, dedup only, no cap" (legacy callers)
 * @returns {{capped:number, items:Array, caps:Map}} flagged rows + capped count + per-rule cap usage
 */
export function applyScoreCaps(rows = [], pointsByCode = null, nameByAsset = null) {
  const metaOf = (r) => {
    const m = pointsByCode === null || pointsByCode === undefined
      ? undefined
      : (typeof pointsByCode.get === 'function' ? pointsByCode.get(r.code) : pointsByCode[r.code])
    const rule = m && m.rule !== null && m.rule !== undefined ? Number(m.rule) : null
    const legacyScope = legacyCapGroup(r.code)
    return {
      group: rule === null ? 'code:' + String(r.code || '') : 'rule:' + rule,
      cap: m && Number(m.cap) > 0 ? Number(m.cap) : 0,
      scope: (m && m.dedup_scope) || legacyScope || 'none',
      rule,
    }
  }
  const flagged = (rows || []).map((r) => {
    const m = metaOf(r)
    return {
      ...r, capped: false, capped_by_id: null, capped_reason_kind: null,
      service_key: null, cap_group: m.group, dedup_scope: m.scope, rule: m.rule, rule_cap: m.cap,
    }
  })

  /* ① Dedup by score scope: within one scope key keep only the highest-value row (ties → earliest recorded)*/
  const buckets = new Map()
  for (const r of flagged) {
    if (Number(r.self_created) === 1) continue
    const scope = r.dedup_scope
    if (scope === 'none' || scope === null || scope === undefined) continue
    let key
    if (scope === 'target') key = 'target'
    else if (scope === 'system') key = 'sys:' + String(systemKeyOf(r, nameByAsset) || '')
    else {
      /* The `service` scope needs a real service key (`t<host[:port]>` / `a<id>:<port>`).
         When service info is unavailable it **takes no part in dedup**, not "every row its own key" ——
         the latter lets a key like `svc:#hit7` knock out every hit of the same scope: measured 62
         target-less terminal-access hits, 61 judged dedup/zero-score, only 1 kept — results silently eaten.
         Prefer under-capping to mis-capping: if the service is unrecognisable, score each on its own.*/
      const svc = scoreServiceKey(r)
      if (svc === null || svc === undefined || String(svc) === '') continue
      key = 'svc:' + String(svc)
    }
    if (key === '' || key === 'svc:null' || key === 'sys:null') continue
    const k = r.cap_group + '|' + key
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }
  let capped = 0
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const best = pickBestHit(list)
    for (const r of list) {
      if (r === best) continue
      r.capped = true
      r.capped_by_id = best.id
      r.capped_by_points = Number(best.points) || 0
      r.capped_by_evidence = best.evidence || null
      r.capped_reason_kind = 'dedup'
      capped += 1
    }
  }

  /* ② Rule cap: scored hits of one rule may not accumulate past cap (highest first; overflow flagged capped)*/
  const caps = new Map()
  const byRule = new Map()
  for (const r of flagged) {
    if (r.capped === true || Number(r.self_created) === 1) continue
    if (r.rule_cap <= 0) continue
    if (!byRule.has(r.cap_group)) byRule.set(r.cap_group, [])
    byRule.get(r.cap_group).push(r)
  }
  for (const [group, list] of byRule.entries()) {
    const cap = list[0].rule_cap
    const ordered = [...list].sort((a, b) => {
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pb !== pa) return pb - pa
      return Number(a.id) - Number(b.id)
    })
    let used = 0; let nCapped = 0
    for (const r of ordered) {
      const pts = Number(r.points) || 0
      if (used + pts > cap) {
        r.capped = true
        r.capped_reason_kind = 'cap'
        r.capped_by_points = null
        nCapped += 1
        capped += 1
      } else {
        used += pts
      }
    }
    caps.set(group, { rule: list[0].rule, cap, used, capped: nCapped })
  }
  return { capped, items: flagged, caps }
}

/**
 * The "system key" used for `system` scope dedup.
 *
 * The rule text says "one system counts its highest privilege once" (mail, OA, central systems, etc.).
 * Resolution order:
 *   ① `system_key` carried by the hit (given explicitly by the caller, most precise);
 *   ② the asset `primary_name` (preferred system name/domain); asset names usually map to one system;
 *   ③ fall back to the service key (asset:port).
 * All three failing returns null —— then it **takes no part in that scope**: uncapped beats mis-capped.
 */
function systemKeyOf(hit = {}, nameByAsset = null) {
  const svc = scoreServiceKey(hit)
  const svcText = svc === null || svc === undefined ? '' : String(svc)

  /* ① system_key from the caller: **trusted only with a service-key prefix (t<host[:port]> /
     a<id>:<port>)**. Callers (listScorePoints / scoreReport / scoreChain) pre-build keys like
     `assetName|port`, and with no asset name that degrades to `"|8080"` —— trusting it merges
     10.7.7.7:8080 with 10.7.7.8:8080 into "the same system", capping another host's results for nothing.
     When untrusted, **keep going** and fall back to the service key, not drop the whole system scope.*/
  const explicit = String(hit.system_key || '').trim()
  if (explicit !== '' && (svcText === '' || explicit.includes(svcText))) {
    /* With no service key to validate, require a non-empty name field (a port-only wild key merges services)*/
    const head = explicit.split('|')[0]
    if (svcText !== '' || String(head).trim() !== '') return explicit
  }

  /* ② Asset name (system name/domain) + service key —— **the main path for the system scope**.
     The rule text is "one system counts its highest privilege once"; coverage is "same system + same port":
     the same product on several hosts/ports is several instances, each scoring its own highest privilege.
     ⚠️ If you really need "once across hosts and ports", pass system_key explicitly with one shared value
     (see ① above) —— but then confirm those hits truly are the same system instance.*/
  const id = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  const nameOf = (assetId) => {
    if (assetId === null || nameByAsset === null || nameByAsset === undefined) return null
    const raw = typeof nameByAsset.get === 'function' ? nameByAsset.get(assetId) : nameByAsset[assetId]
    const text = raw === null || raw === undefined ? '' : String(raw).trim()
    return text === '' ? null : text
  }
  const name = nameOf(id)
  if (name !== null) return name + '|' + svcText

  /* ③ Fall back to the service key: per (asset, port) only the top privilege counts —— equivalent to the
     service scope, and the safety net for "system / app / DB privileges on one host score once" (G1).*/
  if (svcText !== '') return svcText

  /* ④ All three fail (no asset_id, no system name, target yields no host):
     fall back to **the hit's own id** —— i.e. all distinct, each scores on its own.
     Prefer under-capping to mis-capping: treating two indistinguishable hits "the same system" eats results.
     ⚠️ Math.random() **must not** be used here: the same hit gets different keys in two calls
     (panel / report / chain) and the scoring becomes unstable.*/
  return '#hit' + String(hit.id ?? '0')
}

/** Pick the scoring row from same-scope hits: highest value, ties → earliest recorded (smaller id).*/
function pickBestHit(list) {
  return list.reduce((a, b) => {
    const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
    if (pb !== pa) return pb > pa ? b : a
    return Number(b.id) < Number(a.id) ? b : a
  }, list[0])
}

/** Legacy scope grouping (v0.10 and older: account and DB classes capped per "same asset + port").*/
function legacyCapGroup(code) {
  const c = String(code || '').trim()
  if (c === 'web-account-user' || c === 'web-account-admin') return 'service'
  return SERVICE_CAPPED_POINT_CODES.includes(c) ? 'service' : null
}


/**
 * Read score point metadata (code → `{ rule, cap, dedup_scope, points, enabled, builtin, src }`).
 * Shared by panel / report / chain, so one rule set is not read three times with a field missed each time.
 * @param db - target database handle.
 */
function loadScoreMeta(db) {
  return new Map(db.prepare('SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point')
    .all()
    .map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
}

/**
 * Asset id → system name (primary_name); the `system` scope groups "one system" with it.
 * @param db - target database handle.
 */
function loadAssetNames(db) {
  return new Map(db.prepare('SELECT id, primary_name FROM asset').all()
    .filter((a) => a.primary_name).map((a) => [Number(a.id), a.primary_name]))
}

/**
 * The **actual points** of this hit = tier points × multiplier.
 *   · Tier points: the hit's own value wins (a merged row holds several tiers); else the point default;
 *   · Multiplier: G5 data-scale doubling (over 100M records / 10TB, or control of a knowledge-base
 *     system) ×2, G6 IPv6 results ×3. It applies to **privilege points**, so it folds into the value
 *     and is capped with it (the doc requires caps stay at the original limit for that system type;
     a multiplier never breaks them).
 * */
function hitPointsOf(hit = {}, metaByCode = null) {
  let base = 0
  if (hit.points !== null && hit.points !== undefined && hit.points !== '') {
    base = Number(hit.points) || 0
  } else {
    const code = hit.code === null || hit.code === undefined ? null : String(hit.code)
    if (code !== null && metaByCode !== null && metaByCode !== undefined) {
      const meta = typeof metaByCode.get === 'function' ? metaByCode.get(code) : metaByCode[code]
      if (meta !== undefined && meta !== null) base = Number(meta.points) || 0
    }
  }
  const mult = Number(hit.multiplier)
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1))
}

/**
 * Is the host part of this target an IPv6 literal (http://[2001:db8::1]:8080/x, 2001:db8::1, [::1]:22)?
 *
 * A coarse character-class regex cannot replace this: IPv6 mixes hex letters (a-f),
 * and a pattern like /^\[[0-9a-f:]+\]/ that only looks at colons and hex misses lettered addresses
 * (measured: `db8` in 2001:db8::1 dropped, so the G6 ×3 never applied).
 * So hand the host part to isIpv6() —— the same implementation cidrOf / scopeOfIp use.
 */
function targetHasIpv6Host(target) {
  const text = String(target || "").trim()
  if (text === "") return false
  const bracket = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\])/i.exec(text)
  if (bracket !== null) return isIpv6(bracket[1].replace(/^\[|\]$/g, ""))
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(text)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(text) || [])[1]
  if (!authority) return false
  /* A bare IPv6 needs brackets to carry a port, so drop the brackets first, then try to strip the port*/
  const host = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "")
  return isIpv6(host)
}

/**
 * Turn the G5 / G6 multiplier rules into a multiplier (privilege points only, capped by cap).
 *   · `ip_version === 6` or an IPv6 literal target → ×3 (G6);
 *   · `data_scale === "large"` → ×2 (G5: over 100M records or 10TB);
 *   · `data_scale === "knowledge-base"` → ×2 (G5: control of a knowledge-base system);
 *   · both → multiplied. The doc does not forbid stacking; take the favourable reading and
 *     **label the reason**.
 * @param hit - hit params (ip_version / data_scale / target).
 @returns `{ multiplier, reasons }`
 * */
function scoreMultiplierOf(hit = {}) {
  const reasons = []
  let multiplier = 1
  const target = String(hit.target || "")
  const ipv6 = Number(hit.ip_version) === 6 || targetHasIpv6Host(target)
    /* The bare-IPv6 fallback regex needs ≥2 colons: internal `host:port` like dc01:389 / ad01:8080
       has only one, and the old regex misread those as IPv6, silently tripling results*/
    || /(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i.test(target)
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 result ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 data scale over 100M records / 10TB ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 control of a knowledge-base system ×2") }
  return { multiplier, reasons }
}

/**
 * **Unified score evaluation**: panel / report / attack chain all call this to decide what scores
 *and what is capped.
 * 
 * Input is a set of hit rows; output is their scoring flags. Callers only guarantee each row carries
 * `{ id, code, points, asset_id, port, target, self_created }` plus **the actual points of this hit**
 *(`points`; never the point default —— a merged row holds several tiers and the default flips
 * the verdict).
 * 
 * @param db - target database handle.
 * @param rows - array of hit rows.
 * @param options - `{ meta?, names?, enabledOnly? }`: reuse already-read metadata; `enabledOnly` true
                  flags hits of disabled points as not scoring (report and panel must agree).
 * @returns `{ byId, items, caps, meta, names, disabledIds }`
 * */
function evaluateScoreBoard(db, rows = [], options = {}) {
  const meta = options.meta || loadScoreMeta(db)
  const names = options.names || loadAssetNames(db)
  const prepared = (rows || []).map((h) => {
    const code = h.code === null || h.code === undefined ? null : String(h.code)
    const m = code === null ? undefined : meta.get(code)
    const nm = h.asset_id === null || h.asset_id === undefined ? null : names.get(Number(h.asset_id))
    return Object.assign({}, h, {
      code,
      /* points must be the actual points of this hit (see above)*/
      points: hitPointsOf(h, meta),
      rule: m === undefined || m.rule === undefined ? null : m.rule,
      cap: m === undefined ? 0 : m.cap,
      dedup_scope: m === undefined ? 'service' : m.dedup_scope,
      cap_group: m === undefined || m.rule === null || m.rule === undefined ? 'code:' + String(code) : 'rule:' + m.rule,
      rule_cap: m === undefined ? 0 : m.cap,
      system_key: [nm || '', normalizePort(h.port) ?? parseTargetPort(h.target) ?? ''].join('|'),
    })
  })
  const evaluated = applyScoreCaps(prepared, meta, names)
  const byId = new Map(evaluated.items.map((x) => [x.id, x]))
  const disabledIds = new Set()
  if (options.enabledOnly === true) {
    for (const h of prepared) {
      const m = h.code === null ? undefined : meta.get(h.code)
      if (m !== undefined && Number(m.enabled) !== 1) disabledIds.add(h.id)
    }
  }
  return { byId, items: evaluated.items, caps: evaluated.caps, meta, names, disabledIds }
}

/**
 * Why this hit does not score (one sentence shared by alert / UI / report, so three copies cannot drift).
 * @param hit - hit row (code / target / port / rule / rule_cap / capped_reason_kind)
 * @param bestPoints - the row that outranked it in dedup (that row's points)
 */
export function scoreCapReasonText(hit = {}, bestPoints) {
  const label = serviceLabel(hit)
  if (hit.capped_reason_kind === 'cap') {
    return '`' + label + '` does not score: '
      + (hit.rule === null || hit.rule === undefined ? '' : 'rule ' + hit.rule + ' ')
      + '**has already reached that rule\'s cumulative cap (' + (Number(hit.rule_cap) || 0) + ' pts)** — anything past the cap on the same rule never accumulates. '
      + 'Move the effort to another rule or another asset; do not keep farming a rule that is already maxed out.'
  }
  return '`' + label + '` the privileges on this target are already fully scored (scoring basis: one target counts only its highest-value row'
    + (bestPoints === undefined || bestPoints === null ? '' : ', +' + bestPoints + ' pts')
    + ') — this row no longer scores under the rules and stays only as a process trail; **move to another target or another rule, do not farm the same class of result on one target**.'
}

/** Legacy alias (named serviceCapReason up to v0.10).*/
export const serviceCapReason = scoreCapReasonText


/**
 * Coerce a number written with grouping separators.
 *
 * "1,320,000" (English), "1.320.000" (Vietnamese) and "1 320 000" (either, with a
 * non-breaking or normal space) all mean the same quantity. A lone separator with
 * one or two digits after it is a decimal point, not a grouping mark: "1.32" is
 * one point three two, never one thousand three hundred twenty.
 */
function toNumber(raw) {
  const text = String(raw).trim().replace(/[\u00a0\u202f]/g, ' ')
  // Drop every separator that has exactly three digits after it and is followed by
  // another separator or the end of the number.
  let cleaned = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === ',' || ch === '.' || ch === ' ') {
      const rest = text.slice(i + 1)
      const group = /^\d{3}(?![\d])/.exec(rest)
      const isGrouping = group && (rest.length === 3 || /[., ]/.test(rest[3] || ''))
      if (isGrouping) continue
    }
    cleaned += ch
  }
  return Number(cleaned)
}

/**
 * A **coarse threshold** for data scale: 1,000,000 rows/records.
 * Its purpose moved from the bulk-sensitive-data point to a scale self-check for the G5 doubling ——
 * see the warning in addScoreHit. The formal G5 threshold is "over 100M records or 10TB"; here a
 * lower tier only screens whether a scale was written, nudging below it without blocking the score.
 */
export const SENSITIVE_DATA_MIN_ROWS = 1000000

/** The other half of the G5 threshold: 10TB of data. Compared in bytes, never in rows. */
export const SENSITIVE_DATA_MIN_TB = 10

/**
 * Parse a data volume out of evidence text (rows / records / entries).
 * Accepts "120 万条", "1300万行", "1,200,000 条记录", "2.5万行", "1200000 records".
 * **Only forms carrying a counter (条/行/记录/records/rows) or a magnitude word (亿/万/million…)
 * are accepted** — bare digits are not, or a password `123456` or a port number becomes a
 * data volume. Byte volumes ("12TB") are parsed separately by `parseByteVolume`, because a
 * row count and a byte count are independent evidence and must not be converted.
 * Unparseable returns null (the caller asks for the scale; no guessing, no invented numbers).
 */
export function parseRowCount(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = {
    亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3,
    billion: 1e9, million: 1e6, thousand: 1e3,
    'tỷ': 1e9, 'tỉ': 1e9, 'triệu': 1e6, 'nghìn': 1e3, 'ngàn': 1e3,
  }
  const nums = []
  /* «digits + unit + 条/行/记录»: the counter is a Chinese measure word, or English records/rows/entries*/
  // Accepts all three languages an operator or model may write: the Chinese
  // quantities the upstream prompts used, English units, and Vietnamese ones.
  // A number with no unit is never counted — see the comment above.
  // One optional qualifier word is allowed between the number and its unit, because
  // English prose says "132 million user records" and the Chinese form does not.
  // Separators differ by language and the difference is not cosmetic: "1.320.000"
  // is one million three hundred twenty thousand in Vietnamese and could be read
  // as 1.32 followed by 000. A dotted group is therefore only a decimal point when
  // it is followed by exactly three digits *and* another separator follows, which
  // is the grouping shape; otherwise it is the decimal point.
  const cn = /(\d{1,3}(?:[.,\u00a0 ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(亿|千万|百万|十万|万|千|thousand|million|billion|nghìn|ngàn|triệu|tỷ|tỉ)?\s*(?:[A-Za-zÀ-ỹ]+\s+)?(条|行|记录|数据|records?|rows?|entries|bản ghi|dòng|bản|mục)/gi
  for (const m of text.matchAll(cn)) {
    const base = toNumber(m[1])
    if (!Number.isFinite(base)) continue
    const mult = m[2] === undefined ? 1 : units[m[2]]
    nums.push(Math.round(base * mult))
  }
  if (nums.length > 0) return Math.max(...nums)
  /* Bare forms like "exported 1.2 million" (no counter word) also count, but a
     magnitude word is required — a port number must never read as a data volume. */
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千|thousand|million|billion|nghìn|ngàn|triệu|tỷ|tỉ)/gi)) {
    const base = toNumber(m[1])
    if (Number.isFinite(base)) nums.push(Math.round(base * units[m[2]]))
  }
  return nums.length === 0 ? null : Math.max(...nums)
}

/** 1 TB in bytes. The formal G5 threshold is 10TB, so bytes compare against a byte count. */
const TB_BYTES = 1e12

/**
 * Parse a byte volume out of evidence text: "12TB", "1.5 TB", "800 GB", "12太字节".
 *
 * A separate parser from parseRowCount because the two units are not convertible —
 * "10TB of training data" and "100M records" are two independent ways to reach the
 * G5 threshold, and there is no rows-per-byte constant that would be true for both
 * a user table and an object store. Bytes are converted to an equivalent row count
 * (one row per kilobyte) only so the single `rows` field stays comparable; the
 * threshold comparison itself uses bytes.
 */
export function parseByteVolume(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = {
    TB: 1e12, TiB: 1e12, 太字节: 1e12, 兆兆字节: 1e12,
    GB: 1e9, GiB: 1e9, 吉字节: 1e9, 千兆字节: 1e9,
    MB: 1e6, MiB: 1e6, 兆字节: 1e6,
  }
  let best = null
  // A qualifier word may sit between the number and the unit: "12 TB of training data".
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:[A-Za-zÀ-ỹ]+\s+)?(TB|TiB|GB|GiB|MB|MiB|太字节|兆兆字节|吉字节|千兆字节|兆字节)/gi)) {
    const base = toNumber(m[1])
    if (!Number.isFinite(base)) continue
    const key = Object.keys(units).find((u) => u.toLowerCase() === String(m[2]).toLowerCase())
    if (!key) continue
    const bytes = base * units[key]
    if (best === null || bytes > best.bytes) best = { bytes, base, unit: key }
  }
  if (!best) return null
  // No `rows` field on purpose: 800GB is not "781 million rows". Rows and bytes are
  // two independent ways to reach the G5 threshold, and a conversion between them
  // would be a fabricated number. Callers check each against its own threshold.
  return {
    bytes: best.bytes,
    tb: best.bytes / TB_BYTES,
    source: `${best.base}${best.unit}`,
  }
}

/** Thousands separators, so numbers read better in alerts.*/
export function formatRows(n) {
  return Number(n).toLocaleString('en-US')
}


/* ------------------------------------------------------------------ default score points*/

/**
 * Score point → delivery criteria (what counts as obtained, what proves it, how to reproduce it).
 *
 * Why a separate table instead of stuffing it into `score_point.description`:
 * the description is rule-doc wording (for the agent to pick tiers); this table is the reproduction criteria
 * for reviewers. Different audience, different depth. Report and UI look these up by code,
 * so a rule-doc update need not touch this table, and vice versa.
 *
 * Fields:
 *   · need   —— acceptance test: what must hold for this item to count (reviewers reconcile against it)
 *   · proof  —— evidence: what must be attached (the G7 proof requirement)
 *   · replay —— reproduction entry: which request / command replays it (the direct answer to "reproducible")
 *   · script —— action the field team can follow directly (copy-paste runnable where possible)
 */
export const SCORE_CONFIRM = {
  'domain-control': {
    need: 'The target domain\'s resolution records now point at something we control (NS/A records live), or the domain admin panel is operable',
    proof: 'Admin panel screenshot + dig/nslookup comparison before and after the change',
    replay: 'nslookup <DOMAIN> <MY_NS>; or the raw admin-panel request',
    script: 'dig NS <DOMAIN> @8.8.8.8\ndig <DOMAIN> @<MY_NS>',
  },
  'terminal-access': {
    need: 'Commands can be issued to the endpoint and its output retrieved (not "a device was found")',
    proof: 'The controlled endpoint\'s id/hostname output + proof of its relation to the target organisation (G7)',
    replay: 'Run id inside the remote-control session; or the trojan/RAT agent check-in log',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: 'A command was executed on the host and its output captured (WebShell / reverse shell / RAT all count)',
    proof: 'Command output (id / hostname) + WebShell connection parameters or session log',
    replay: 'Raw WebShell request (directly replayable); or the reverse-shell listener log',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: 'Connected to the database with the account and ran a query (unauthorised access counts: connecting is enough)',
    proof: 'Query output after a successful login (select user(), version()) + the account\'s privilege level',
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: 'Logged into the system with an account the target already had (user or admin) and reached a protected page',
    proof: 'Page content/output after login + the session Cookie or Token (proof it is not just the password)',
    replay: 'Raw login request (with the witnessing Cookie/Token) + one authenticated request to a protected page',
    script: 'curl -i -s -X POST <LOGIN_URL> -d "username=<u>&password=<p>" -c cookie.txt\ncurl -s -b cookie.txt <PROTECTED_PAGE>',
  },
  'central-system': {
    need: 'Logged into a centralised system (bastion host / domain controller / SSO / endpoint management console) with admin rights',
    proof: 'Admin panel screenshot + an action showing subordinate nodes are controllable (log into 20% of managed nodes, or 20 hosts)',
    replay: 'Raw login request + the request and response of one control action (e.g. listing managed hosts)',
    script: 'curl -s -b cookie.txt "<CONTROL_LIST_ENDPOINT>"',
  },
  'bigdata-system': {
    need: 'Obtained admin or ordinary privileges on a big-data platform (Hadoop/Spark/ES, etc.)',
    proof: 'Platform admin page/endpoint output + the data volume reachable (row count or capacity)',
    replay: 'Raw platform endpoint request (e.g. ES _cat/indices, YARN /ws/v1/cluster/apps)',
    script: 'curl -s "<PLATFORM_ENDPOINT>" | head -50',
  },
  netdev: {
    need: 'Logged into a network device (firewall/router/switch/VPN/gateway) and obtained privileges',
    proof: 'Device admin page screenshot + routing table or connection-count screenshot (explicitly required by G7)',
    replay: 'Raw device login request + the command output that reads the routing table',
    script: 'show ip route    # or display ip routing-table',
  },
  'netdev-redirect': {
    need: 'Traffic direction was actually changed through that device (policy/route/DNS change took effect)',
    proof: 'Routing table or policy comparison before and after + evidence our node received the traffic',
    replay: 'Raw policy-config request + packet capture/access log on our controlled node',
    script: 'tcpdump -ni any port <PORT> -c 10',
  },
  'netdev-implant': {
    need: 'An executable RAT/persistence was implanted on the device **and** it was used to complete follow-up attacks',
    proof: 'Evidence of the RAT process or persistence item + records of later results launched through that device',
    replay: 'Raw request/command of the implant action + later access logs through that device',
    script: '',
  },
  iiot: {
    need: 'Obtained admin privileges on an industrial-internet system, or bulk control of the connected devices under it',
    proof: 'Admin panel screenshot + the list of controlled devices and their count',
    replay: 'Raw login request + the device-list endpoint response',
    script: '',
  },
  'cloud-platform': {
    need: 'Admin privileges on a cloud management platform; or bulk control of cloud nodes via ak/sk (node points need ≥100)',
    proof: 'Platform admin page screenshot; for ak/sk give the controlled-node list and count, or admin proof (created a node / changed permissions)',
    replay: 'Raw platform endpoint request (list instances, create users, etc.)',
    script: 'curl -s -H "Authorization: Bearer <token>" "<PLATFORM_INSTANCE_LIST>"',
  },
  'iot-platform': {
    need: 'Obtained privileges on an IoT management platform, or bulk control of devices through its connection points',
    proof: 'Platform admin page screenshot + connection-point/device count',
    replay: 'Raw platform login and device-list endpoint requests',
    script: '',
  },
  'iot-corenet': {
    need: 'Pivoted from an IoT endpoint device into the core network and controlled important systems such as business production',
    proof: 'Path description (which endpoint → core network → which system) + control evidence for that system',
    replay: 'The lateral-movement command issued from the endpoint + the login/operation request against the core-network system',
    script: '',
  },
  secdev: {
    need: 'Obtained admin privileges on a non-centralised security device (IPS/IDS/audit/WAF)',
    proof: 'Device admin page screenshot + an action showing policy is controllable',
    replay: 'Raw login request + one policy-read endpoint response',
    script: '',
  },
  'file-storage': {
    need: 'Obtained backend privileges on a file-storage system (FTP/NAS/netdisk/object storage), or one of its ordinary accounts',
    proof: 'Valid login/invocation credential (account password, AK/SK, session Cookie) + the post-login file listing; **anonymous listing or unauthorised read of a listing does not count** (data results score separately, see G2)',
    replay: 'Raw directory-listing request (FTP LIST / S3 ListObjects / WebDAV PROPFIND) and its successful output',
    script: 'curl -s "<STORAGE_ENDPOINT>" | head -50',
  },
  'ai-agent': {
    need: 'Controlled an agent tool such as a model agent/skill and **actually drove it to perform an action**',
    proof: 'Conversation or invocation log + the action it was driven to perform and its result (range points judged by depth of control)',
    replay: 'Raw request that drove the agent + the output of the action it performed',
    script: '',
  },
  'model-compute': {
    need: 'Obtained system admin privileges on a compute management platform / training-data and knowledge-base system',
    proof: 'Admin panel screenshot + an action showing compute scheduling or data read/write',
    replay: 'Raw platform login and scheduling/data endpoint requests',
    script: '',
  },
  'model-data': {
    need: 'Obtained admin privileges on a model-related data system (can affect training/inference/operations or steal or tamper with weights)',
    proof: 'Admin panel screenshot + the list of models/datasets that can be read and written',
    replay: 'Raw platform endpoint requests (list models, download weights)',
    script: '',
  },
  'computepower-admin': {
    need: 'Obtained admin privileges on compute infrastructure',
    proof: 'Admin panel screenshot + proof of schedulable resources',
    replay: 'Raw platform login and resource-list endpoint requests',
    script: '',
  },
  'computepower-cards': {
    need: 'Actually obtained compute card resources (10 pts/card) or control of a card-pooling platform',
    proof: 'Card resource list (with count) + evidence tasks can be submitted or cards held exclusively',
    replay: 'nvidia-smi output / the platform card-list endpoint',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: 'Established a channel from the target side into the internal network and can **actually reach internal targets**',
    proof: 'Tunnel registration (the entry must be on the target side) + output/screenshot of reaching an internal target through the tunnel (G7)',
    replay: 'The command and output that reached the internal target through the tunnel; the tunnel setup command',
    script: 'curl --socks5-hostname 127.0.0.1:<PORT> http://<INTERNAL_IP>/ -i',
  },
  'boundary-strong': {
    need: 'Broke through gateway-class strong isolation, entered the strongly isolated business intranet and actually reached internal targets',
    proof: 'Control screenshot of the gateway-class isolation device + screenshot proof of reaching the intranet (G7)',
    replay: 'The command and output that reached the internal target through the strong-isolation channel',
    script: '',
  },
  'boundary-physical': {
    need: 'Broke physical isolation / entered the core production network and actually reached the target',
    proof: 'Control screenshot of the firewall/VPN/multi-NIC host/gateway + screenshot of reaching the intranet (G7)',
    replay: 'The command and output that reached the target after entering the core network',
    script: '',
  },
  'boundary-supply': {
    need: 'Entered a defended organisation\'s intranet via a supply-chain operations channel or a cloud service (scored per case)',
    proof: 'Control evidence on the supply-chain/cloud side + proof of entering the defended organisation\'s intranet; state which case applies',
    replay: 'The command and output that entered the intranet from the supply-chain channel',
    script: '',
  },
}

/** Delivery criteria for a score point; null when there is no entry (report then shows evidence only).*/
export function scoreConfirmOf(code) {
  const key = String(code || '').trim()
  return SCORE_CONFIRM[key] === undefined ? null : SCORE_CONFIRM[key]
}

export const DEDUP_SCOPES = ['service', 'system', 'target', 'none']

/**
 * Full definition of one score point (factory, so 22 objects do not repeat fields).
 *
 * Two numbers, two jobs, **do not mix them**:
 *   · `src`  —— the original number in the merged breakthrough-scoring rules (merged rows use the first),
 *              used only to reconcile against the original table; appears in docs and comments;
 *   · `rule` —— the internal **cap grouping key** (`applyScoreCaps` accumulates cap by it).
 *              It must be **unique**: historically the original number was the key, so merged 16/17 rows and
 *              the two 19 sub-items shared one key —— one hit ate the other's cap,
 *              and `rule` numbers repeated (two 19s) or skipped (6/17/20/21),
 *              so a model reading "rule 19 is capped" could not tell which one.
 *              Now 1..N contiguous and unique, matching array order one to one.
 */
const sp = (src, rule, tier, code, name, category, points, cap, dedup_scope, description) => ({
  src, rule, tier, code, name, category, points, cap, dedup_scope, description,
})

/* ── General rules (G1–G8, spanning all items; not scored alone, written into docs and prompts) ─────────
   G1 highest privilege counts once | G2 data results score separately | G3 caps apply per defended unit |
   G4 devices score per unit | G5 data scale doubling | G6 IPv6 ×3 (never breaking the original cap) |
   G7 proof requirement | G8 fallback: other systems scored by the specialist group after review.
   Full text in docs/得分规则-合并版.md.*/
export const SCORE_GENERAL_RULES = [
  { code: 'G1', name: 'Highest privilege only, counted once', detail: 'When several privileges are obtained on the same system, the same host, or the same database, score only the highest one (admin plus ordinary privileges earns the admin points only).' },
  { code: 'G2', name: 'Data results score separately', detail: 'Mail data, business data, data assets and similar results are scored separately by data importance and never mixed with privilege points.' },
  { code: 'G3', name: 'Cap basis', detail: 'Each item\'s point cap covers one defended organisation and every subordinate body under it; nothing accumulates past the cap.' },
  { code: 'G4', name: 'Devices/endpoints score per unit', detail: 'Printers and wifi routers 5 pts/unit; PCs, Pads, phones, cameras and electronic billboards 10 pts/unit; cloud hosts, containers, managed connected devices and IoT connection points 10 pts/unit. Bulk control is converted by "controlled nodes".' },
  { code: 'G5', name: 'Data-scale doubling', detail: 'Systems holding large amounts of data (important data over 100M records or 10TB) double their score; control of a knowledge-base-related system doubles its score. Ordinary log data generated by the system does not count.' },
  { code: 'G6', name: 'IPv6 multiplier', detail: 'Results obtained via IPv6 score ×3, but the cap is still the original cap of the corresponding system type; the multiplier never breaks it.' },
  { code: 'G7', name: 'Proof material', detail: 'Breaking a network boundary requires a control screenshot of the isolation device and screenshot proof of reaching the intranet; controlled phones, Pads and similar endpoints must prove their relation to the target organisation; network device privileges require evidence such as the routing table or a connection-count screenshot.' },
  { code: 'G8', name: 'Fallback clause', detail: 'Privileges on other systems, servers and devices have no preset points; the specialist group assigns them after review.' },
]

/**
 * Default score points —— **strictly aligned with the merged breakthrough scoring rules, 25 items**
 * (obtain access: 21 + boundary break: 4, 8 categories; a row billing a different unit is split out,
 *e.g. compute-infra admin access vs compute cards).
 * 
 * Difference from the previous version: no more splitting by privilege tier inside one rule ——
 * one item = one merged row (`tier` names its tier/sub-item); only **different billing units**
 *keep sub-items (e.g. compute-infra "admin access" vs "compute card, 10 pts/card").
 * 
 * Fields:
 *   · src    original number in the merged table (reconciles row by row);
 *   · group  UI grouping: GENERAL = general systems, WEB = web application systems,
 *            CENTRAL = central systems, BIGDATA = big-data systems,
 *            NETINFRA = network infrastructure, STORAGE = file storage systems,
 *            MODEL = model-related systems, BOUNDARY = network boundary break;
 *   · points single-hit points (multi-tier rows take the main tier; the description lists tiers);
   · cap    cap for this row (0 = uncapped); dedup_scope is the scoring scope.
 * */
export const SCORE_GROUPS = [
  { code: 'GENERAL', name: 'Control of general systems' },
  { code: 'WEB', name: 'Control of Web application systems' },
  { code: 'CENTRAL', name: 'Control of centralised systems' },
  { code: 'BIGDATA', name: 'Control of big-data systems' },
  { code: 'NETINFRA', name: 'Control of network infrastructure' },
  { code: 'STORAGE', name: 'File storage systems' },
  { code: 'MODEL', name: 'Control of model-related systems' },
  { code: 'BOUNDARY', name: 'Network boundary break' },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ 1. Obtain access (18 items) ═══════════════════════════════════════*/

  /* 1 Domain control access*/
  sp(1, 1, 'apex domain 50 / subdomain 20 pts each', 'domain-control', 'Domain control privilege', 'GENERAL', 50, 400, 'system',
    '**Apex domain 50 pts each, subdomain 20 pts each**, scored by domain type; this item caps at 400 pts (G3).\n'
    + 'When scoring, write the domain and its type in evidence; for a subdomain set the single-hit points to 20.'),

  /* 2 Endpoint access*/
  sp(2, 2, '5 / 10 pts each', 'terminal-access', 'Endpoint privilege (phone, Pad, PC, printer, camera, wifi router, etc.)', 'GENERAL', 10, 600, 'system',
    '**Printers and wifi routers 5 pts each; PCs, Pads, phones, cameras and electronic billboards 10 pts each** (G4), accumulated per unit; this item caps at 600 pts (G3).\n'
    + 'A controlled endpoint must prove its relation to the target organisation (G7); for a 5-pt device set the single-hit points to 5.\n'
    + 'Endpoints obtained through phishing also score under this item — write the target person\'s role in evidence (general office / IT operations / business operations).'),

  /* 3 Server host access*/
  sp(3, 3, 'ordinary 10 / admin 50 pts each', 'server-host', 'Server host privilege (including webshell access)', 'GENERAL', 50, 600, 'system',
    '**Ordinary privilege 10 pts each, admin privilege 50 pts each**; this item caps at 600 pts (G3).\n'
    + 'One host counts only its highest privilege once (G1) — after root/SYSTEM, ordinary privileges on that host no longer accumulate.\n'
    + 'Obtaining one server host loses no points; for an ordinary privilege set the single-hit points to 10.'),

  /* 4 Database connection credentials*/
  sp(4, 4, 'ordinary 10 / admin 50 / unauthorised 10 pts each', 'db-credential', 'Database connection account and password (including SQL injection)', 'GENERAL', 50, 400, 'system',
    '**Ordinary user privilege 10 pts each, admin privilege 50 pts each; redis and any other empty-password or unauthorised-access result is a flat 10 pts each**; this item caps at 400 pts (G3).\n'
    + 'The same privilege level (including admin) on one database scores once only; system, application and database privileges on one host count only the highest once (G1).\n'
    + 'Data results score separately (G2); for an ordinary privilege or unauthorised access set the single-hit points to 10.'),

  /* 5, 6 Mail and business production systems (the original table shares rule and cap for both)*/
  sp(5, 5, 'admin 100 / ordinary 50 pts each', 'web-app', 'Mail system / office-automation and business-production systems / other Web application system privileges', 'WEB', 100, 2000, 'system',
    '**Admin privilege 100 pts each, ordinary user privilege 50 pts each; one system counts its highest privilege once** (G1); this item caps at 2000 pts (G3).\n'
    + 'This item merges items 5 and 6 of the original table (identical rules and cap), **i.e. the "control of Web application systems" class**; when scoring, write in evidence which class it is:\n'
    + '· **Mail system**;\n'
    + '· **Office-automation and business-production systems** (office OA, ERP, direct-report instant messaging, financial systems, business-production systems, data warehouses and similar systems whose compromise or outage affects the industry\'s or the organisation\'s business production, operations management or daily office work);\n'
    + '· **Other Web application systems (catch-all)**: HTTP/HTTPS sites where an account from the credential list was **actually tested and logs in**; '
    + 'anything that does not fall into a more specific score-point class (centralised systems go to item 7, big-data systems to item 8, cloud management platforms to item 11, IoT management platforms to item 12, security devices to item 13, etc.) '
    + 'scores under this item uniformly (admin 100 / ordinary 50). **Web logins whose credentials record only `host:port` with no system name or business owner (backends, admin consoles, operations platforms, in-house business systems) also go here** — '
    + 'first judge whether a more fitting class exists; if not, classify as "control of Web application systems" and never drop the record just because "it is unclear whether it is mail/OA". '
    + 'When scoring, set `target` to the actual login URL (with port), write in evidence "which site + which account + admin/ordinary tier", and actually test the login first, per red line 1.\n'
    + 'Mail data scores again separately by importance (G2); for an ordinary user privilege set the single-hit points to 50.'),

  /* 7 Central systems*/
  sp(7, 6, 'admin 500 / ordinary 50 pts each', 'central-system', 'Centralised system privilege (operations / identity / networking / endpoint management consoles)', 'CENTRAL', 500, 4000, 'system',
    '**System admin privilege 500 pts each, ordinary privilege 50 pts each**; one privilege level scores once, i.e. holding both admin and ordinary privilege earns only the admin points (G1); this item caps at 4000 pts (G3).\n'
    + 'Centralised systems cover four classes:\n'
    + '· **Operations centralisation**: bastion hosts, centralised monitoring, unified resource publishing, etc.;\n'
    + '· **Identity and privilege management**: SSO, 4A, IAM, etc.;\n'
    + '· **Networking centralisation**: domain controllers, certificate authorities, SDWAN unified controllers, etc.;\n'
    + '· **Endpoint host management consoles**: endpoint management software consoles, zero-trust control centres, etc.\n'
    + '⚠️ Devices **managed by** a centralised system (hosts, endpoints, etc.) are scored **by cross-reference to the "control of general systems" points** (e.g. PC and mobile endpoint 10 pts each, G4) — '
    + '**do not score them at the centralised-system top tier of 500 pts**, which would be badly inflated; bulk control needs proof: log into at least 20% of the managed nodes, 20 hosts maximum.'),

  /* 8 Big-data systems*/
  sp(8, 7, 'admin 1000 / ordinary 100 pts each', 'bigdata-system', 'Big-data system privilege', 'BIGDATA', 1000, 4000, 'system',
    '**Admin privilege 1000 pts, ordinary privilege 100 pts each**; one privilege level scores once, i.e. holding both admin and ordinary privilege earns only the admin points (G1); this item caps at 4000 pts (G3).\n'
    + 'Data scores separately (G2); **a system with under 500M records or 1TB of valid data is scored as an ordinary database** (i.e. switch to the item-4 points).'),

  /* 9 Network device access*/
  sp(9, 8, 'ordinary 100 / admin 200 / bonus 200·1000 pts', 'netdev', 'Network device privilege (firewall, router, switch, gateway, optical shutter, ferry machine, VPN, etc.)', 'NETINFRA', 200, 2000, 'service',
    '**Ordinary user privilege 100 pts, admin privilege 200 pts**; this item caps at 2000 pts (G3). Evidence such as the routing table or a connection-count screenshot is required (G7).\n'
    + 'Achieving the following actions on the same device **adds points** (scored at the tier actually reached):\n'
    + '· **Network redirection or service hijacking** through that device: +200 pts;\n'
    + '· **Implanting a remote-control program on that device and successfully running follow-up attacks**: 1000 pts.\n'
    + 'For an ordinary privilege or a bonus tier, adjust the single-hit points to the tier actually reached.'),

  /* 10 Industrial internet systems*/
  sp(10, 9, 'admin 200 / device 10 pts each', 'iiot', 'Industrial internet system privilege', 'NETINFRA', 200, 2000, 'system',
    '**Management-console admin privilege 200 pts; managed connected devices 10 pts each** (G4); this item caps at 2000 pts (G3).\n'
    + 'Covers connected vehicles, smart manufacturing, remote diagnostics, intelligent transport, etc. When accumulating devices per unit, use separate hit records (points set to 10).'),

  /* 11 Cloud management platform*/
  sp(11, 10, 'admin 500 / node 10 pts each', 'cloud-platform', 'Control of a cloud management platform (including PaaS platforms such as K8S, Red Hat OpenShift, etc.)', 'NETINFRA', 500, 2000, 'system',
    '**Admin privilege 500 pts; cloud hosts and containers 10 pts each** (G4); this item caps at 2000 pts (G3). Cloud business systems score separately under the important-system rules.\n'
    + 'Bulk control via ak/sk by default **counts only the controlled-node points, not the admin points**, unless admin privilege is proven (e.g. created a cloud node, managed user permissions).\n'
    + '⚠️ **Fewer than 100 nodes is scored as an ordinary Web application and the nodes earn nothing** (i.e. the item 5/6 basis).'),

  /* 12 IoT device management platform*/
  sp(12, 11, 'platform 200 / connection point 10 / core network +5000 pts', 'iot-platform', 'IoT device management platform privilege', 'NETINFRA', 200, 2000, 'system',
    '**An IoT platform with control capability 200 pts; connection points on the platform 10 pts each** (G4); this item caps at 2000 pts (G3).\n'
    + '**Pivoting through an IoT endpoint device into the core network and controlling important systems such as business production adds 5000 pts separately** (not bound by this item\'s 2000-pt cap; record it as its own hit).'),

  /* 13 Security devices*/
  sp(13, 12, 'admin 200 pts', 'secdev', 'Security device privilege (IPS, IDS, audit appliances, WAF and other non-centralised security devices)', 'NETINFRA', 200, 1000, 'service',
    '**Admin privilege 200 pts**; this item caps at 1000 pts (G3). Non-centralised security devices only (centralised ones go to item 7).'),

  /* 14 File storage systems*/
  sp(14, 13, 'admin 50 / ordinary 10 pts each', 'file-storage', 'File storage system privilege (FTP, object storage, enterprise NAS, enterprise netdisk, etc.)', 'STORAGE', 50, 500, 'system',
    '**Admin privilege 50 pts each; ordinary user privilege, empty systems or systems holding only test data 10 pts each**; this item caps at 500 pts (G3).\n'
    + 'Covers FTP, object storage (scored per system), enterprise NAS, enterprise netdisk, etc.; data scores separately (G2). For an ordinary privilege set the single-hit points to 10.'),

  /* 15 Model agents / agent tooling*/
  sp(15, 14, '100–500 pts each', 'ai-agent', 'Model agents, skills and other agent tooling (and being able to drive the agent to attack)', 'MODEL', 100, 4000, 'service',
    '**100–500 pts each**, a range judged by depth of control and operation; this item caps at 4000 pts (G3).\n'
    + 'Covers model agents, skills and other agent tooling; write the depth of control/operation in evidence and set the single-hit points to the tier judged.'),

  /* 16, 17 Compute management platform + training data / knowledge-base systems (identical rules)*/
  sp(16, 15, 'system admin privilege 500 pts each', 'model-compute', 'Compute management platform privilege / training-data and knowledge-base system privilege', 'MODEL', 500, 4000, 'system',
    '**System admin privilege 500 pts each**; this item caps at 4000 pts (G3).\n'
    + 'This item merges items 16 and 17 of the original table (word-for-word identical rules); when scoring, write in evidence which class it is:\n'
    + '· **Compute management platform** (can manage and schedule compute resources, etc.);\n'
    + '· **Training-data, knowledge-base and related systems** (can steal or tamper with training data or the knowledge base, perform data poisoning, etc.).\n'
    + 'Systems holding large amounts of data (over 100M records or 10TB) **double their score**, and control of a knowledge-base-related system **doubles its score** (G5).'),

  /* 18 Model-related data systems*/
  sp(18, 16, 'system admin privilege 500 pts each', 'model-data', 'Model-related data system privilege', 'MODEL', 500, 4000, 'system',
    '**System admin privilege 500 pts each**; this item caps at 4000 pts (G3).\n'
    + 'Can disrupt model training, inference and operations services, and steal or tamper with model weight files, etc.\n'
    + '⚠️ The difference from items 16 and 17 **cannot be smoothed over**: this item **has no "control of a knowledge-base-related system doubles the score"**, but it does have "data-asset results scored by reference to the data scale" (G2); '
    + 'very large data-scale systems (over 100M records or over 10TB) double their score (G5).'),

  /* 19 Compute infrastructure (privilege and compute card are two billing units; both rows kept)*/
  sp(19, 17, 'admin 500 pts each', 'computepower-admin', 'Compute infrastructure · admin privilege', 'MODEL', 500, 2000, 'system',
    '**Admin privilege 500 pts each**; this item caps at 2000 pts (including path points, G3).\n'
    + 'This item and "compute infrastructure · compute card resources" belong to item 19 and share the 2000-pt cap; the three (admin privilege / large compute card resources / compute card pooling platform) score separately but are bound by this item\'s overall cap.'),
  sp(19, 18, '10 pts/card', 'computepower-cards', 'Compute infrastructure · compute card resources / compute card pooling platform', 'MODEL', 10, 2000, 'none',
    '**10 pts/card**, accumulated per card (G4); obtaining large compute card resources scores, and obtaining a compute card pooling platform scores directly, each capped at 2000 pts, sharing item 19\'s overall 2000-pt cap with "admin privilege".\n'
    + 'When scoring, write the card count or the platform name in evidence.'),

  /* ══ 2. Break the network boundary (4 items; one target unit scores a given boundary type once) ══════*/

  sp(22, 19, '1000 pts', 'boundary-logical', 'Entering a logically isolated business intranet', 'BOUNDARY', 1000, 0, 'target',
    '**1000 pts**. Scope: each boundary class broken counts once for the whole target organisation.\n'
    + 'Proof material (G7): a control screenshot of the firewall-class isolation device, screenshot proof of reaching the intranet, etc.'),
  sp(23, 20, '10000 pts', 'boundary-strong', 'Entering a logically strongly isolated business intranet', 'BOUNDARY', 10000, 0, 'target',
    '**10000 pts**. Scope: each boundary class broken counts once for the whole target organisation.\n'
    + 'Proof material (G7): a control screenshot of the gateway-class isolation device, screenshot proof of reaching the intranet, etc.'),
  sp(24, 21, '30000 pts', 'boundary-physical', 'Entering a physically isolated intranet / core production network', 'BOUNDARY', 30000, 0, 'target',
    '**30000 pts**. Scope: each boundary class broken counts once for the whole target organisation.\n'
    + 'Proof material (G7): control screenshots of the firewall, VPN, multi-NIC host, network device and gateway-class isolation device, screenshot proof of reaching the intranet, etc.\n'
    + 'Such as railway dispatch private networks, bank core accounting networks, power production control zones, carrier signalling networks, energy production IoT, etc.'),
  sp(25, 22, '1000 pts (3000 max)', 'boundary-supply', 'Entering an intranet via a supply-chain operations channel or a cloud service', 'BOUNDARY', 1000, 3000, 'service',
    'Scored in three cases:\n'
    + '· Entering **the intranet of one defended organisation**: 1000 pts;\n'
    + '· Entering **several** defended organisations\' intranets via **one** supply-chain organisation or cloud service: 1000 pts per defended organisation;\n'
    + '· Entering different network zones of **one** defended organisation\'s intranet via **several** supply-chain organisations or cloud services: 1000 pts each, 3000 pts max.\n'
    + 'When scoring, write in evidence which case applies and which defended organisation / network zone is involved.'),

  /* ══ Bonus results stacked on top (attached to an access item above, but **scored and capped
     separately**) ══ These are not "another system access" but "did something more on the access
     already held" (the +N in the doc). Folding them into the base item would share its cap.*/

  /* 9 Network device bonus: redirect traffic or hijack a service through that device, +200 pts*/
  sp(9, 23, 'redirection / service hijacking +200 pts', 'netdev-redirect', 'Network device · network redirection or service hijacking through that device', 'NETINFRA', 200, 2000, 'none',
    '**Adds 200 pts on top of the "network device privilege" points** (item 9 of the doc).\n'
    + 'Applies to: changing routes/policies to steer traffic to a node we control, DNS hijacking, business-traffic hijacking and other redirection that actually took effect.\n'
    + 'Evidence required (G7): routing table, policy configuration or connection-count screenshot; write the redirection direction and how it was verified in evidence.'),

  /* 9 Network device bonus: implant a remote-control program and use it for follow-up, 1000 pts*/
  sp(9, 24, 'implant RAT + follow-up attacks 1000 pts', 'netdev-implant', 'Network device · implanting a remote-control program and successfully running follow-up attacks', 'NETINFRA', 1000, 2000, 'none',
    '**Adds 1000 pts on top of the "network device privilege" points** (item 9 of the doc).\n'
    + 'Two things must be proven: "the implant succeeded **and** it was used to complete follow-up attacks": RAT process/persistence evidence + later results launched through that device.'),

  /* 12 IoT: pivot from an endpoint into the core network and control business production systems, +5000 pts*/
  sp(12, 25, 'core network +5000 pts', 'iot-corenet', 'IoT · pivoting through an endpoint device into the core network and controlling important systems', 'NETINFRA', 5000, 5000, 'none',
    '**Item 12 of the doc states "add 5000 pts separately"**, which does not consume that item\'s 2000-pt cap.\n'
    + 'Applies to: pivoting laterally from an IoT endpoint device into the core network and controlling important systems such as business production;\n'
    + 'in evidence, state clearly: which endpoint it entered from, which systems were controlled in the core network, and what privileges were obtained.'),
]

/* ------------------------------------------------------------------ internal helper exports*/

/**
 * These were module-level functions in core.js (not exported); once split out, core.js needs them,
 * so they are exported explicitly. They are not a public API —— check core.js before changing one.
 */
export {
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup,
  targetHasIpv6Host, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf,
}
