/** On official desktop boot Fiber._reload still mounts desktop-office: settle must not unpack/kill. */

export const DESKTOP_SETTLE_DELAY_MS = 4000;

export function isInactiveContextError(error) {
  if (!error) return false;
  if (error.code === "INACTIVE_EFFECT") return true;
  return /inactive context/i.test(String(error.message || error));
}

export function watchContextLife(ctx) {
  const life = { alive: true };
  if (!ctx || typeof ctx.effect !== "function") return life;
  try {
    ctx.effect(() => () => {
      life.alive = false;
    });
  } catch (error) {
    if (isInactiveContextError(error)) {
      life.alive = false;
      return life;
    }
    throw error;
  }
  return life;
}

export function settleDelayMs(surface) {
  return surface === "desktop" ? DESKTOP_SETTLE_DELAY_MS : 0;
}

/** Desktop self-heal must not requestRestart / taskkill, or Cordis raises INACTIVE_EFFECT. */
export function settleMayRestart({ surface, sealed = false } = {}) {
  if (surface === "desktop") return false;
  if (sealed) return false;
  return true;
}

/** In-place extract/swap on a sealed asar races the official Host's Fiber._reload lock. */
export function settleMayReapply({ surface, sealed = false } = {}) {
  if (surface === "desktop" && sealed) return false;
  return true;
}

/**
 * Whether to restart after clicking Apply. Web and desktop share one rule:
 * restart only once cleanup finished or prompts were written. On backup
 * failure or a host gate that did not pass, do not kill the process. Cooldown
 * is not kept here: otherwise the first restart leaves the asar unchanged and
 * the second Apply reads as a cancel.
 */
export function applyShouldRestart({
  complete = false,
  promptReady = false,
} = {}) {
  return Boolean(complete || promptReady);
}
