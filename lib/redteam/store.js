/**
 * RedTeam asset store -- Cordis Host plugin shell
 *
 * Role: publish {@link RedteamStore} as the process-level service `ctx.redteam`
 * so that
 *   - the client UI (via the dsh-redteam-ui HTTP bridge)
 *   - the tool lines of every role agent (preset plane, injecting ctx.redteam)
 * all read the same SQLite fact base.
 *
 * Plane: host. Asset data must be shared across sessions by later vuln-scan /
 * exploit / internal agents, so the service instance has to be process-level
 * unique and cannot live in a preset.
 *
 * Zero external dependencies: only node: builtins, so nothing has to resolve
 * node_modules under the profile.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { RedteamStore } from './store-core.js'

/** Cordis plugin name. */
export const name = 'redteam-store'

/** No hard dependencies: the data layer activates without other services. */
export const inject = []

/**
 * Resolve the data root: explicit config > REDTEAM_HOME > $DSH_HOME/redteam.
 * The composition layer usually passes an absolute path via
 * `!!js dshHomePath('redteam')`.
 */
function resolveRoot(config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) return config.root
  if (process.env.REDTEAM_HOME) return process.env.REDTEAM_HOME
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * This plugin's own package name and version (used by the UI "version +
 * auto-update").
 *
 * Why two candidates: the marketplace package `dsh-redteam-mode` keeps its
 * package.json next to this file (the generated lib/); when this package is
 * mounted alone it is one level up. If neither reads, return null and the UI
 * shows "version unknown"; no feature depends on it.
 */
function readSelfPackage() {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
      if (pkg && typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return {
          name: pkg.name,
          version: pkg.version,
          description: typeof pkg.description === 'string' ? pkg.description : '',
          homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
        }
      }
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * @param ctx - plugin context.
 * @param config - `{ root?: string }`.
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)
  let store
  try {
    store = new RedteamStore(root)
  } catch (error) {
    ctx.logger?.error?.('redteam-store: open failed: %s', error && error.message ? error.message : String(error))
    return
  }
  /* Package identity is attached to the store: the UI bridge layer (redteam-ui)
      reads its version display and update logic from here, so no version number
      needs to be hardcoded in the generated output. */
  const self = readSelfPackage()
  if (self !== null) {
    try { store.plugin = Object.freeze(self) } catch { /* ignore */ }
  }

  // The service closes when its fiber unmounts: every SQLite handle is released in one place.
  ctx.effect(() => () => {
    try { store.close() } catch { /* a failed close must not block deactivation */ }
  })

  ctx.provide('redteam', store)
}

export { RedteamStore }
