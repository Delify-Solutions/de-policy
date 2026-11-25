/**
 * Validation and normalization before writing to the store (zero dependency).
 *
 * Extracted from core.js: these functions decide "which values may enter the
 * store" and are where the security boundary lives (path traversal, invalid
 * enums), so they deserve their own place, their own read, their own tests.
 */

import { resolve, sep } from 'node:path'

export const WEBSHELL_TYPES = ['behinder', 'godzilla', 'antSword', 'antsword', 'custom']
export const WEBSHELL_STATUSES = ['online', 'offline', 'dead', 'unknown']

/**
 * Normalize the shell type: case-insensitive, Chinese aliases of Behinder /
 * Godzilla / AntSword are also accepted. Unknown input throws instead of silently
 * storing the raw text -- the panel's "user cannot connect" red mark and the
 * session page's connection-password copy both key off this field, so a typo
 * stored silently does not raise an error, it just makes both checks fail quietly.
 * @param value - raw value (may be empty).
 * @returns normalized value or null (empty is valid = undeclared).
 */
export function normalizeShellType(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return null
  const lower = raw.toLowerCase()
  // Accept the Vietnamese and English names a model may use alongside the Chinese.
  if (/behinder|冰蝎|con bọ/.test(lower)) return 'behinder'
  if (/godzilla|哥斯拉|quái thú/.test(lower)) return 'godzilla'
  if (/antsword|蚁剑|kiếm kiến/.test(lower)) return 'antSword'
  if (lower === 'custom' || lower === 'custom-shell' || /自定义|自研|tự viết|hand-written/.test(raw)) return 'custom'
  throw new Error("invalid webshell shell_type: " + JSON.stringify(value)
    + '. Delivery requires a **Behinder shell (behinder) / Godzilla shell (godzilla)** (the user must be able to connect to it themselves); '
    + 'for any other type submit custom (temporary relay only — the panel marks it "user cannot connect").')
}

/** Normalize the shell status (the UI shows three states: online/offline/unknown). */
export function normalizeShellStatus(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  const aliases = { up: 'online', alive: 'online', down: 'offline', failed: 'offline', removed: 'dead' }
  const normalized = aliases[raw] || raw
  if (normalized === '') return 'online'
  if (!WEBSHELL_STATUSES.includes(normalized)) {
    throw new Error("invalid webshell status: " + JSON.stringify(value) + ". Legal values are only " + WEBSHELL_STATUSES.join(" / ") + ".")
  }
  return normalized
}


/**
 * The path must stay inside the allowed roots (traversal protection).
 *
 * Why needed: `readAttackFile` / `pocGet` read the **path column in the
 * database**, and that column is written by the agent itself through
 * `addAttackFile` / `savePoc` -- i.e. untrusted input. If it is set to
 * `/etc/passwd` or `~/.ssh/id_rsa`, a single click in the panel copies that file
 * into the browser. `deletePoc` already had a startsWith guard, but the read and
 * write paths missed it; this is the shared implementation.
 * @param target - path to validate.
 * @param allowedRoots - allowed root directories (array).
 * @returns the normalized absolute path.
 * @throws on escape (callers treat it as "not found"; never return content silently).
 */
export function assertPathWithin(target, allowedRoots) {
  const abs = resolve(String(target || ""))
  const roots = (allowedRoots || []).filter((r) => typeof r === "string" && r !== "").map((r) => resolve(r))
  const okFlag = roots.some((root) => abs === root || abs.startsWith(root + sep))
  if (!okFlag) {
    throw new Error("path outside allowed roots: " + abs
      + " (allowed roots: " + roots.join(", ") + "). The file path in this record is not inside this target's directory, read refused.")
  }
  return abs
}
