/**
 * Plugin-level settings (zero dependency): currently one item only -- the
 * **concurrent worker agent limit**.
 *
 * Why not an environment variable: `REDTEAM_MAX_AGENTS` can only be set before
 * startup and needs a dsh web restart after any change, while "how many worker
 * agents run at once" is the most frequently tuned knob. So a JSON file lives in
 * the fact-base root: `$DSH_HOME/redteam/settings.json`.
 *
 * Precedence: settings.json -> env `REDTEAM_MAX_AGENTS` -> default 3.
 * The tool side (the redteam_agent_slot gate) and the panel side (the "agents"
 * page) read the same file, so the two never drift apart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default concurrency limit (user ruling: 3 worker agents by default per project). */
export const DEFAULT_MAX_AGENTS = 3

/** Hard limit: more will not be faster -- the per-API-key concurrency/rate limit
 * hits first and only perturbs testing. */
export const MAX_AGENTS_LIMIT = 10

/** Settings file path (same root as the fact base, backed up/migrated with it). */
export function settingsPathOf(root) {
  return join(String(root || '.'), 'settings.json')
}

/** Read all settings (missing/broken file yields an empty object, never throws). */
export function readSettings(root) {
  try {
    if (!existsSync(settingsPathOf(root))) return {}
    const parsed = JSON.parse(readFileSync(settingsPathOf(root), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** Merge-write a few settings and return the complete settings afterwards. */
export function writeSettings(root, patch) {
  const next = Object.assign({}, readSettings(root), patch)
  mkdirSync(String(root || '.'), { recursive: true })
  writeFileSync(settingsPathOf(root), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** Coerce any input into an integer within [1, MAX_AGENTS_LIMIT]. */
export function clampMaxAgents(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS
  return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT)
}

/**
 * Currently effective concurrency limit.
 * @param root - fact-base root directory (`ctx.redteam.root`).
 * @param env - environment table (injectable for tests).
 * @returns the effective integer limit.
 */
export function maxAgentsOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return clampMaxAgents(fromFile)
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampMaxAgents(fromEnv)
  return DEFAULT_MAX_AGENTS
}

/** Persist the concurrency limit and return the value actually in effect. */
export function saveMaxAgents(root, value) {
  const applied = clampMaxAgents(value)
  writeSettings(root, { maxAgents: applied })
  return applied
}

/** Where the current setting comes from (the panel must state it truthfully,
 * to avoid an "I changed it but nothing happened" illusion). */
export function maxAgentsSourceOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return 'settings'
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return 'env'
  return 'default'
}
