/**
 * Endpoint gate: this build only runs when the *selected model* is served by
 * `ai.delify.vn`.
 *
 * The distinction that matters
 * ----------------------------
 * A DSH install can hold many providers at once — an official one, an account
 * route, a self-hosted gateway, a lab server. Asking "does this install contain our
 * endpoint anywhere" answers the wrong question: a machine could have `ai.delify.vn`
 * configured but currently be talking to something else, and it would pass. The
 * question is "is the model I am about to run against served by us", so this reads
 * the *active* selection first and only falls back when that cannot be resolved.
 *
 * Resolution order
 * ----------------
 * 1. `DE_POLICY_ENDPOINT` — explicit override, for staging or a lab. Outranks
 *    everything, because an operator who states the endpoint has said what they want.
 * 2. The active model selection (`<dsh home>/storages/**`, `modelSelection.lastUsed`
 *    → `{ provider, model }`), resolved through the `llm` service:
 *      - `llm.listConfigurableProviders()` gives, per provider route,
 *        `defaultBaseURL`, `baseURLEnv` and `settingsNs`/`settingsPath`;
 *      - the user's profile at that settings path may override `baseURL`, which wins
 *        over `defaultBaseURL` — that is how a self-hosted route is pointed at a
 *        host by hand;
 *      - `baseURLEnv` names environment variables the endpoint is built from.
 * 3. `$DSH_HOME/redteam/config.json` — this plugin's own record, written by EnvTab.
 * 4. `DE_POLICY_HOST_ENDPOINT` → `DEEPSEEK_BASE_URL` → `DEEPSEEK_API_BASE`.
 *
 * When the active provider cannot be resolved the gate falls back rather than
 * guessing, and reports which source it used so the banner can say so. It never
 * silently allows: `unknown` is a refusal, and `assertEndpoint` throws.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The only endpoint this build is issued for. Compared case-insensitively, port-agnostic. */
export const ALLOWED_HOST = 'ai.delify.vn'

/** Shown when the selected model is not served by us. One sentence, no ambiguity. */
export const ENDPOINT_REFUSAL =
  'This build only supports models served by ' + ALLOWED_HOST
  + '. Switch the model in DSH to one routed through that endpoint, or install a build '
  + 'issued for the endpoint you use.'

/** Reduce a URL or bare host to a comparable hostname, or null. */
export function hostOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True when the value resolves to the allowed host or one of its subdomains. */
export function isAllowedEndpoint(value) {
  const host = hostOf(value)
  if (!host) return false
  // The leading dot is what makes this a real suffix check: without it,
  // `ai.delify.vn.evil.test` and `aidelify.vn` would both pass.
  return host === ALLOWED_HOST || host.endsWith(`.${ALLOWED_HOST}`)
}

/* ── reading the active model selection ─────────────────────────────────── */

/**
 * The provider/model the host will actually use.
 *
 * `modelSelection` is stored per session as `{ lastUsed: { provider, model } }`.
 * The most recently written session wins, because that is the one the user was
 * last working in.
 * @returns {{ provider: string, model: string|null, file: string }|null}
 */
export function activeModelSelection(dshHome) {
  const roots = [
    join(dshHome, 'storages', 'session_projcache', 'sessions'),
    join(dshHome, 'storages'),
  ]
  const files = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(join(root, entry.name))
    }
    if (files.length) break
  }

  // Newest first: the last session used is the one whose selection counts.
  const withTime = files.map((file) => {
    let mtime = 0
    try {
      mtime = Number(statSync(file)?.mtimeMs ?? 0)
    } catch { /* an unreadable file sorts last */ }
    return { file, mtime }
  }).sort((a, b) => b.mtime - a.mtime)

  for (const { file } of withTime) {
    let data
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const hit = findSelection(data, 0)
    if (hit) return { ...hit, file }
  }
  return null
}

/** Walk for a `modelSelection` row, bounded. */
function findSelection(value, depth) {
  if (depth > 8 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSelection(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const last = value.lastUsed ?? value.val?.lastUsed
  if (last && typeof last === 'object' && typeof last.provider === 'string') {
    return { provider: last.provider, model: typeof last.model === 'string' ? last.model : null }
  }
  for (const child of Object.values(value)) {
    const hit = findSelection(child, depth + 1)
    if (hit) return hit
  }
  return null
}

/* ── resolving a provider to an endpoint ────────────────────────────────── */

/**
 * Find the endpoint for a provider route.
 *
 * `llm` is the host service (`ctx.get('llm')`). It is absent in a plain Node
 * process — a test or the CLI — so every call is guarded and a missing service is a
 * normal outcome, not an error.
 *
 * @param {object|null} llm  the host's llm service, when available
 * @param {string} provider  the route key from the active selection
 * @param {object} env
 * @returns {{ endpoint: string|null, source: string }}
 */
export function endpointForProvider(llm, provider, env = process.env) {
  if (!llm || typeof llm.listConfigurableProviders !== 'function') {
    return { endpoint: null, source: 'llm service unavailable' }
  }

  let routes = []
  try {
    routes = llm.listConfigurableProviders() || []
  } catch {
    return { endpoint: null, source: 'llm service failed' }
  }

  const route = routes.find((entry) => entry && entry.provider === provider)
  if (!route) return { endpoint: null, source: `provider "${provider}" not configured` }

  // 1. A user-set profile baseURL wins over the shipped default: that is how a
  //    self-hosted or gateway route is pointed somewhere by hand.
  if (route.settingsNs) {
    try {
      const section = llm.settings?.get?.(route.settingsNs)
      const profile = walkPath(section, route.settingsPath || [])
      const fromProfile = profile?.baseURL || profile?.baseUrl || profile?.endpoint
      if (typeof fromProfile === 'string' && fromProfile) {
        return { endpoint: fromProfile, source: `profile ${route.settingsNs}` }
      }
    } catch { /* fall through to the shipped default */ }
  }

  // 2. The adapter's own default.
  if (typeof route.defaultBaseURL === 'string' && route.defaultBaseURL) {
    return { endpoint: route.defaultBaseURL, source: `provider ${provider}` }
  }

  // 3. An endpoint the adapter builds from environment variables.
  for (const key of route.baseURLEnv || []) {
    const value = String(env[key] ?? '').trim()
    if (value) return { endpoint: value, source: key }
  }

  return { endpoint: null, source: `provider "${provider}" has no endpoint` }
}

/** Follow a settings path, tolerating a missing branch at any depth. */
function walkPath(root, path) {
  let node = root
  for (const key of path || []) {
    if (node === null || node === undefined || typeof node !== 'object') return null
    node = node[key]
  }
  return node ?? null
}

/* ── the verdict ────────────────────────────────────────────────────────── */

/** Fallback endpoint sources, in the order they are trusted. */
function fallbackEndpoint(dshHome, env) {
  try {
    const configPath = join(dshHome, 'redteam', 'config.json')
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      const value = config?.endpoint || config?.baseUrl
      if (value) return { endpoint: String(value), source: 'redteam/config.json' }
    }
  } catch { /* a broken config falls through */ }

  for (const key of ['DE_POLICY_HOST_ENDPOINT', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_BASE']) {
    const value = String(env[key] ?? '').trim()
    if (value) return { endpoint: value, source: key }
  }
  return { endpoint: null, source: 'not found' }
}

/**
 * The full verdict.
 *
 * @param {{ env?: object, llm?: object, dshHome?: string }} [options]
 * @returns {{ ok: boolean, status: 'allowed'|'refused'|'unknown', endpoint: string|null,
 *             host: string|null, source: string, provider: string|null, model: string|null,
 *             allowed: string, message: string }}
 */
export function checkEndpoint(options = {}) {
  const env = options.env || process.env
  const dshHome = options.dshHome || String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const llm = options.llm ?? null

  const override = String(env.DE_POLICY_ENDPOINT ?? '').trim()
  if (override) {
    const host = hostOf(override)
    const ok = isAllowedEndpoint(override)
    return {
      ok,
      status: ok ? 'allowed' : 'refused',
      endpoint: override,
      host,
      source: 'DE_POLICY_ENDPOINT',
      provider: null,
      model: null,
      allowed: ALLOWED_HOST,
      message: ok
        ? `Endpoint ${host} is supported.`
        : `Endpoint ${host || override} is not supported. ${ENDPOINT_REFUSAL}`,
    }
  }

  // The question this gate exists to answer: is the model about to be used ours?
  const selection = activeModelSelection(dshHome)
  if (selection) {
    const resolved = endpointForProvider(llm, selection.provider, env)
    if (resolved.endpoint) {
      const host = hostOf(resolved.endpoint)
      const ok = isAllowedEndpoint(resolved.endpoint)
      const modelLabel = selection.model ? ` (model ${selection.model})` : ''
      return {
        ok,
        status: ok ? 'allowed' : 'refused',
        endpoint: resolved.endpoint,
        host,
        source: resolved.source,
        provider: selection.provider,
        model: selection.model,
        allowed: ALLOWED_HOST,
        message: ok
          ? `Provider ${selection.provider}${modelLabel} is served by ${host}.`
          : `Provider ${selection.provider}${modelLabel} is served by ${host || resolved.endpoint}, `
            + `which is not supported. ${ENDPOINT_REFUSAL}`,
      }
    }
    // A provider that resolved to nothing is reported, not skipped: silently falling
    // back here would let a misconfigured route pass under another route's endpoint.
    const fallback = fallbackEndpoint(dshHome, env)
    if (fallback.endpoint) {
      const host = hostOf(fallback.endpoint)
      const ok = isAllowedEndpoint(fallback.endpoint)
      return {
        ok,
        status: ok ? 'allowed' : 'refused',
        endpoint: fallback.endpoint,
        host,
        source: fallback.source,
        provider: selection.provider,
        model: selection.model,
        allowed: ALLOWED_HOST,
        message: ok
          ? `Provider ${selection.provider} could not be resolved; the configured endpoint ${host} is supported.`
          : `Provider ${selection.provider} could not be resolved, and the configured endpoint `
            + `${host || fallback.endpoint} is not supported. ${ENDPOINT_REFUSAL}`,
      }
    }
    return {
      ok: false,
      status: 'unknown',
      endpoint: null,
      host: null,
      source: resolved.source,
      provider: selection.provider,
      model: selection.model,
      allowed: ALLOWED_HOST,
      message: `Provider ${selection.provider} is selected but its endpoint cannot be determined, `
        + `so support cannot be confirmed. ${ENDPOINT_REFUSAL}`,
    }
  }

  const fallback = fallbackEndpoint(dshHome, env)
  const host = hostOf(fallback.endpoint)
  const ok = fallback.endpoint ? isAllowedEndpoint(fallback.endpoint) : false
  return {
    ok,
    status: fallback.endpoint ? (ok ? 'allowed' : 'refused') : 'unknown',
    endpoint: fallback.endpoint,
    host,
    source: fallback.source,
    provider: null,
    model: null,
    allowed: ALLOWED_HOST,
    message: ok
      ? `Endpoint ${host} is supported.`
      : fallback.endpoint
        ? `Endpoint ${host || fallback.endpoint} is not supported. ${ENDPOINT_REFUSAL}`
        : `Cannot determine which endpoint this DSH is pointed at. ${ENDPOINT_REFUSAL}`,
  }
}

/**
 * Throwing form for a caller that must not proceed.
 * @throws {Error} `.code === 'ENDPOINT_UNSUPPORTED'`, `.verdict` attached.
 */
export function assertEndpoint(options = {}) {
  const verdict = checkEndpoint(options)
  if (verdict.ok) return verdict
  const error = new Error(verdict.message)
  error.code = 'ENDPOINT_UNSUPPORTED'
  error.verdict = verdict
  throw error
}
