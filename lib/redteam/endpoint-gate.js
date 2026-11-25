/**
 * Endpoint gate: this build is licensed for one endpoint only.
 *
 * Why a gate and not a warning: the plugin patches the host's prompt policy,
 * approval stack and sandbox behaviour. Running it against an endpoint Delify does
 * not operate means Delify is changing the behaviour of a third party's product on
 * someone else's bill, with no visibility into what that endpoint tolerates. So the
 * check runs before the patch engine is allowed to touch anything, and the answer is
 * a refusal rather than a notice someone can click past.
 *
 * What it reads, in order, and why each is a fallback:
 *
 *   1. `DE_POLICY_ENDPOINT` — an explicit override for a staging or lab endpoint.
 *      An operator who sets it outranks anything discovered automatically.
 *   2. `$DSH_HOME/redteam/config.json` — this plugin's own config, written by the
 *      EnvTab. Survives a profile reset.
 *   3. The host's model route (`<dsh home>/storages/**` model selection, which
 *      carries `provider` + `baseUrl`). This is where the endpoint actually lives
 *      after a user signs in, so it is the authoritative source when present.
 *   4. `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_BASE` — the environment variables the
 *      host itself honours.
 *
 * When nothing can be read, the gate reports `unknown` and lets the caller decide.
 * It never silently allows: `assertEndpoint` throws, and the patch engine calls it
 * before the first write. `unknown` is treated as a failure to verify, not a pass.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The single host this build is issued for. Compared case-insensitively, port-agnostic. */
export const ALLOWED_HOST = 'ai.delify.vn'

/** The message shown when the endpoint is not ours. One sentence, no ambiguity. */
export const ENDPOINT_REFUSAL =
  'This build only supports the endpoint ' + ALLOWED_HOST
  + '. Point DSH at that endpoint, or install a build issued for the endpoint you use.'

/** Reduce a URL or bare host to a comparable hostname, or null. */
export function hostOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  // A bare host with no scheme: `new URL` would throw, so add one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True when the value resolves to the allowed host, or to one of its subdomains. */
export function isAllowedEndpoint(value) {
  const host = hostOf(value)
  if (!host) return false
  // `ai.delify.vn` and anything under it. A lookalike (`ai.delify.vn.evil.test`) is
  // not a suffix match because the comparison includes the leading dot.
  return host === ALLOWED_HOST || host.endsWith(`.${ALLOWED_HOST}`)
}

/**
 * Read the endpoint this install is pointed at.
 * @returns {{ endpoint: string|null, source: string }} source is for the message.
 */
export function detectEndpoint(env = process.env) {
  const explicit = String(env.DE_POLICY_ENDPOINT ?? '').trim()
  if (explicit) return { endpoint: explicit, source: 'DE_POLICY_ENDPOINT' }

  const dshHome = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

  // This plugin's own config, if EnvTab has written one.
  try {
    const configPath = join(dshHome, 'redteam', 'config.json')
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      const fromConfig = config?.endpoint || config?.baseUrl
      if (fromConfig) return { endpoint: String(fromConfig), source: 'redteam/config.json' }
    }
  } catch { /* a broken config falls through to the host route */ }

  // The host's model selection: the authoritative source once a user has signed in.
  const fromHost = endpointFromHostStorage(dshHome)
  if (fromHost) return { endpoint: fromHost, source: 'host model route' }

  for (const key of ['DE_POLICY_HOST_ENDPOINT', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_BASE']) {
    const value = String(env[key] ?? '').trim()
    if (value) return { endpoint: value, source: key }
  }

  return { endpoint: null, source: 'not found' }
}

/**
 * Pull `baseUrl` out of the host's stored model selection.
 *
 * Walks `<dsh home>/storages` for JSON files and looks for the first object that
 * carries both a `provider`/`baseUrl` pair. Deliberately shallow and bounded: this
 * runs on every startup, and a deep recursive scan of a session cache would cost
 * more than the check is worth.
 */
function endpointFromHostStorage(dshHome) {
  const roots = [join(dshHome, 'storages'), join(dshHome, 'storages', 'session_projcache', 'sessions')]
  const seen = new Set()
  // Breadth over a handful of files, not a filesystem crawl.
  const MAX_FILES = 40

  const visit = (value, depth) => {
    if (seen.size >= MAX_FILES || depth > 6 || value === null || typeof value !== 'object') return null
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item, depth + 1)
        if (hit) return hit
      }
      return null
    }
    const direct = value.baseUrl || value.baseURL || value.endpoint
    if (typeof direct === 'string' && hostOf(direct)) return direct
    for (const child of Object.values(value)) {
      const hit = visit(child, depth + 1)
      if (hit) return hit
    }
    return null
  }

  const readFile = (file) => {
    seen.add(file)
    try {
      return visit(JSON.parse(readFileSync(file, 'utf8')), 0)
    } catch {
      return null
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (seen.size >= MAX_FILES) break
      const path = join(root, entry.name)
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const hit = readFile(path)
        if (hit) return hit
      } else if (entry.isDirectory()) {
        // One level down: the session cache stores one JSON per session.
        let inner
        try {
          inner = readdirSync(path, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of inner) {
          if (seen.size >= MAX_FILES) break
          if (!child.isFile() || !child.name.endsWith('.json')) continue
          const hit = readFile(join(path, child.name))
          if (hit) return hit
        }
      }
    }
  }
  return null
}

/**
 * The verdict, for the panel and for the patch engine.
 * @returns {{ ok: boolean, status: 'allowed'|'refused'|'unknown', endpoint: string|null,
 *             host: string|null, source: string, allowed: string, message: string }}
 */
export function checkEndpoint(env = process.env) {
  const { endpoint, source } = detectEndpoint(env)
  const host = hostOf(endpoint)

  if (!endpoint) {
    return {
      ok: false,
      status: 'unknown',
      endpoint: null,
      host: null,
      source,
      allowed: ALLOWED_HOST,
      message: `Cannot determine which endpoint this DSH is pointed at, so support cannot be `
        + `confirmed. ${ENDPOINT_REFUSAL}`,
    }
  }

  if (isAllowedEndpoint(endpoint)) {
    return {
      ok: true,
      status: 'allowed',
      endpoint,
      host,
      source,
      allowed: ALLOWED_HOST,
      message: `Endpoint ${host} is supported.`,
    }
  }

  return {
    ok: false,
    status: 'refused',
    endpoint,
    host,
    source,
    allowed: ALLOWED_HOST,
    message: `Endpoint ${host || endpoint} is not supported. ${ENDPOINT_REFUSAL}`,
  }
}

/**
 * Throwing form, for a caller that must not proceed.
 * @throws {Error} with `.code === 'ENDPOINT_UNSUPPORTED'` and `.verdict` attached.
 */
export function assertEndpoint(env = process.env) {
  const verdict = checkEndpoint(env)
  if (verdict.ok) return verdict
  const error = new Error(verdict.message)
  error.code = 'ENDPOINT_UNSUPPORTED'
  error.verdict = verdict
  throw error
}
