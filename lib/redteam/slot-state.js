/**
 * "Parked" state of concurrency slots: when a worker agent reports `waiting` /
 * `blocked` (it is waiting for a key / VPS / scope), it yields its slot so the
 * main session can dispatch new work without being blocked by an idle agent.
 *
 * Why a separate file: the tool layer (tools.js) writes and the panel layer
 * (ui.js) reads; sharing one Map avoids "tool reports free slots, panel reports
 * full". Only state and accessors live here, with no host dependency, so either
 * side can import it safely.
 */

/** Root session id → Set<child session id> */
const parked = new Map()

/** Cap guard: child session ids keep growing in a long-lived process. */
const PARKED_CAP = 500

function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(parked, PARKED_CAP)

export function parkAgent(rootId, childId) {
  if (rootId === undefined || childId === undefined) return false
  if (!parked.has(rootId)) parked.set(rootId, new Set())
  parked.get(rootId).add(String(childId))
  return true
}

export function unparkAgent(rootId, childId) {
  const set = parked.get(rootId)
  if (set === undefined) return false
  const dropped = set.delete(String(childId))
  if (set.size === 0) parked.delete(rootId)
  return dropped
}

export function isParked(rootId, childId) {
  const set = parked.get(rootId)
  return set !== undefined && set.has(String(childId))
}
