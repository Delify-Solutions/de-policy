import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function installedRevPath() {
  return path.join(core.findDshHome(), "de-policy", "installed-rev");
}

function installedRev() {
  try {
    return fs.readFileSync(installedRevPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function appliedStampPath() {
  return path.join(core.findDshHome(), "de-policy", "applied.json");
}

function settleGuardPath() {
  return path.join(core.findDshHome(), "de-policy", "settle-restart.guard");
}

function lastApplyPath() {
  return path.join(core.findDshHome(), "de-policy", "last-apply.json");
}

/** A new instance can still read this apply result after the process was killed, releasing "in progress". */
export function writeLastApply(payload = {}) {
  try {
    const fp = lastApplyPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify({
      at: Date.now(),
      fromApply: true,
      ok: payload.ok !== false,
      complete: payload.complete === true,
      ask_restart: payload.ask_restart === true,
      ai_base: payload.ai_base || "",
      surface: payload.surface || "",
      applied: payload.applied,
      already: payload.already,
      failed: payload.failed,
      patches_applied: payload.patches_applied,
      error: payload.error || "",
    })}\n`, "utf8");
  } catch { /* on write failure fall back to in-memory lastStatusPayload */ }
}

export function readLastApply(maxAgeMs = 15 * 60 * 1000) {
  try {
    const raw = JSON.parse(fs.readFileSync(lastApplyPath(), "utf8"));
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export function consumeLastApply() {
  const raw = readLastApply();
  if (raw) {
    try { fs.unlinkSync(lastApplyPath()); } catch { /* ignore */ }
  }
  return raw;
}

export function readAppliedStamp() {
  try {
    const raw = JSON.parse(fs.readFileSync(appliedStampPath(), "utf8"));
    return {
      version: String(raw.version || ""),
      sha: String(raw.sha || ""),
    };
  } catch {
    return null;
  }
}

function sameRev(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isApplyPlaceholder(sha) {
  const text = String(sha || "");
  return text.startsWith("apply:") || text === "applied";
}

function applyPlaceholderVersion(sha) {
  const m = String(sha || "").trim().match(/^apply:(.+)$/);
  return m ? m[1] : "";
}

function refreshStaleApplyPlaceholder(sha) {
  const ver = pluginVersion();
  const oldVer = applyPlaceholderVersion(sha);
  if (oldVer && ver && oldVer !== ver) return `apply:${ver}`;
  return String(sha || "").trim();
}

/** A manual apply may never write installed-rev; an empty sha keeps settle misaligned forever
 * and restarts endlessly. */
export function resolveApplySha(explicit) {
  const wanted = String(explicit == null ? "" : explicit).trim();
  if (wanted) return refreshStaleApplyPlaceholder(wanted) || wanted;
  const rev = installedRev();
  if (rev) return refreshStaleApplyPlaceholder(rev) || rev;
  const ver = pluginVersion();
  return ver ? `apply:${ver}` : "applied";
}

function writeInstalledRev(sha) {
  const value = String(sha || "").trim();
  if (!value) return;
  const fp = installedRevPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${value}\n`, "utf8");
}

function writeAppliedStamp(sha) {
  const fp = appliedStampPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    sha: String(sha || "").trim(),
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

/** When the current plugin version matches the version written into the patches, startup
 * need not restore and re-patch. */
export function stampMatches(stamp, version, rev) {
  if (!stamp || !stamp.version || stamp.version !== version) return false;
  // An empty sha means an incomplete stamp (an empty string was once written by mistake);
  // never treat it as aligned (#56).
  if (!stamp.sha) return false;
  const current = String(rev || "").trim();
  if (!current) return true;
  // When a manual-apply placeholder stamp coexists with a later git rev, trust only version, so no
  // pointless restart loop.
  if (isApplyPlaceholder(stamp.sha) || isApplyPlaceholder(current)) return true;
  if (!sameRev(current, stamp.sha)) return false;
  return true;
}

/**
 * Stamp matches, but the host was knocked back to a sealed asar by an official update, or the clean
 * markers are gone: still counts as misaligned (#57).
 * Not finding the plugin root (early web boot, pure CLI) is not the same as losing the patches,
 * otherwise it re-patches and restarts forever (#59).
 */
export function hostStillHasAppliedPatches() {
  try {
    if (core.desktopAsarStillSealed()) return false;
  } catch {
    /* non-desktop surface */
  }
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return true;
    return core.hostCleanMarkersPresent(aiBase);
  } catch {
    return true;
  }
}

/** An empty sha may only be stamped in place when not sealed and not clearly missing markers. */
export function canHealEmptyStamp({ sealed = false, hasAiBase = false, markersPresent = false } = {}) {
  if (sealed) return false;
  if (hasAiBase && !markersPresent) return false;
  return true;
}

export function patchesMatchInstall() {
  if (!stampMatches(readAppliedStamp(), pluginVersion(), installedRev())) return false;
  return hostStillHasAppliedPatches();
}

/**
 * Real per-patch check: only a "pending" in patchStatus is actual work left.
 * hostCleanMarkersPresent only looks at whether any clean marker exists, so it cannot detect the
 * drift where a DSH self-upgrade replaces files like agent-loop wholesale and all #74/#87 markers
 * disappear.
 */
export async function hostPatchesStillPending() {
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return false;
    const status = await core.patchStatus(aiBase);
    return Object.values(status).some((row) => row === "pending");
  } catch {
    return false;
  }
}

/** Even after the fast path, do the per-patch pending check again, so marker drift on a DSH
 * upgrade never skips re-patching. */
export async function patchesMatchInstallStrict() {
  if (!patchesMatchInstall()) return false;
  if (await hostPatchesStillPending()) return false;
  return true;
}

/**
 * The host clean is still there, only the version stamp is old. Startup must not revertAll because
 * of that, or the page goes back to "needs cleaning again" right after the user applies and restarts.
 */
export async function hostCleanEnoughToKeep() {
  let aiBase = "";
  try {
    aiBase = core.findAiBase() || "";
  } catch {
    return false;
  }
  if (!aiBase || !core.hostCleanMarkersPresent(aiBase)) return false;
  const status = await core.patchStatus(aiBase);
  return !Object.values(status).some((row) => row === "pending");
}

/** Applied stamp present but the host is back on a sealed asar / clean markers gone: the panel
 * reports "patches lost" (#57). A missing root is not loss. */
export function patchesLostAfterHostReset() {
  const stamp = readAppliedStamp();
  if (!stamp?.version || !stamp?.sha) return false;
  try {
    if (core.desktopAsarStillSealed()) return true;
  } catch {
    /* non-desktop surface */
  }
  try {
    const aiBase = core.findAiBase();
    if (aiBase && !core.hostCleanMarkersPresent(aiBase)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** A manual Apply must stamp on success too, or settle reads the patches as misaligned after
 * restart and asks to restart again. */
export function markPatchesApplied(sha) {
  const resolved = resolveApplySha(sha);
  const current = installedRev();
  // Keep a git rev already written by the update channel; otherwise use the resolve result
  // (which may be an apply:version placeholder).
  const finalSha = current && !isApplyPlaceholder(current) ? current : resolved;
  writeInstalledRev(finalSha);
  writeAppliedStamp(finalSha);
  return finalSha;
}

/**
 * #59/#60: an empty sha or a missing installed-rev makes settle reapply+restart on every boot.
 * When the version already matches, seed a non-empty stamp / rev first to break the self-restart;
 * patches genuinely missing are re-applied by the later logic.
 */
export function healEmptyAppliedStamp() {
  const stamp = readAppliedStamp();
  const version = pluginVersion();
  if (!stamp || stamp.version !== version) return false;
  if (stamp.sha) {
    if (!installedRev()) writeInstalledRev(stamp.sha);
    return false;
  }
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* ignore */ }
  let hasAiBase = false;
  let markersPresent = false;
  try {
    const aiBase = core.findAiBase();
    hasAiBase = Boolean(aiBase);
    markersPresent = Boolean(aiBase && core.hostCleanMarkersPresent(aiBase));
  } catch {
    /* root not located yet */
  }
  // Sealed, or clean markers clearly absent: must not stamp it as aligned, or #57 stops self-healing.
  if (!canHealEmptyStamp({ sealed, hasAiBase, markersPresent })) return false;
  markPatchesApplied();
  return true;
}

/** Write a placeholder when no installed-rev exists yet after install (common for tarball /
 * manual apply). */
export function ensureInstalledRevSeed() {
  const current = installedRev();
  if (current) {
    const next = refreshStaleApplyPlaceholder(current);
    if (next && next !== current) {
      writeInstalledRev(next);
      return next;
    }
    return current;
  }
  const stamp = readAppliedStamp();
  if (stamp?.sha) {
    writeInstalledRev(stamp.sha);
    return stamp.sha;
  }
  const sha = resolveApplySha();
  writeInstalledRev(sha);
  return sha;
}

/** Cool down when settle just restarted, so "re-patch -> restart -> re-patch" never becomes a loop. */
export function shouldSkipSettleRestart(windowMs = 180000) {
  try {
    const raw = JSON.parse(fs.readFileSync(settleGuardPath(), "utf8"));
    if (String(raw.version || "") !== pluginVersion()) return false;
    const at = Date.parse(String(raw.at || "")) || 0;
    return at > 0 && Date.now() - at < windowMs;
  } catch {
    return false;
  }
}

export function markSettleRestart() {
  const fp = settleGuardPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

/**
 * Restore host files from backup first, then rewrite them with this plugin version's patches.
 * An old version carries its own patch list and a new one carries its own; whichever version we
 * roll back to, its patches are the ones applied.
 */
export async function reapplyInstalled(options = {}) {
  core.applyRuntimeEnv();
  let aiBase = null;
  let handoff = null;
  let freshExtract = null;
  try {
    const state = await core.gatherState();
    aiBase = state.ai_base;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const sealed = core.sealedAsarHandoff();
  if (!aiBase || sealed) {
    try {
      const opened = await core.openSealedDesktopHost({
        upgrade: options.upgrade === true,
        forApply: true,
      });
      if (opened.aiBase) aiBase = opened.aiBase;
      if (opened.swapAsar) handoff = opened;
      if (opened.extracted) freshExtract = opened;
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  } else {
    core.rememberUnpackedArchive();
  }
  if (!aiBase) return { ok: false, error: core.missingAiBaseMessage() };
  // What was just extracted is the official original. An already-used dir is still restored,
  // then re-patched for this version.
  const preserveClientBundles = options.preserveClientBundles !== false;
  // A DSH self-upgrade replaces host files wholesale but leaves the old bak beside them. A plain
  // revertAll then writes the current new version back to the old one -> mixed code crashes
  // outright. First refresh every bak that "has no de-policy marker but differs from current in
  // bytes" onto current; revertAll then cannot destroy the new host, and applyPatches below puts
  // the markers back.
  if (!freshExtract) {
    try {
      const refreshed = core.refreshStaleBaksForUpgrade(aiBase);
      if (refreshed.length) {
        console.warn(`[de-policy] refreshed ${refreshed.length} stale bak(s) before revert:`, refreshed);
      }
    } catch (e) {
      console.warn("[de-policy] refresh stale bak failed:", String(e && e.message ? e.message : e));
    }
  }
  const reverted = freshExtract ? { reverted: [] } : await core.revertAll(aiBase, { preserveClientBundles });
  if (!freshExtract) await core.revertAllShims();
  const multi = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles, forApply: true });
  await core.patchAllShims();
  const flash = core.silenceCmdFlash(multi.hosts[0]?.aiBase || aiBase);
  const summary = core.summarizeApplyReport(multi.report);
  const backupBlocked = (multi.hosts || []).some((h) => Array.isArray(h.backupFailed) && h.backupFailed.length);
  const clean =
    summary.failed.length === 0 &&
    !backupBlocked &&
    (core.allPatchHostsWritten(multi.hosts) || core.hostCleanMarkersPresent(aiBase));
  if (clean && flash.ok !== true) {
    console.warn("[de-policy] cmd flash patch did not apply cleanly; clean flow continues, UI shows cmdFlashOk=false");
  }
  if (!clean && freshExtract) {
    const restored = core.restoreSealedExtract(freshExtract.appDir, freshExtract.prev);
    return {
      ok: false,
      error: restored ? "Chưa hoàn tất việc làm sạch, đã đặt lại thư mục giải nén của bản trước" : "Chưa hoàn tất việc làm sạch",
      restored,
      version: pluginVersion(),
      reverted: 0,
      applied: summary.applied || 0,
      failed: summary.failed.length,
      renamed: false,
      needsFullQuit: false,
      cmdFlashOk: flash.ok === true,
    };
  }
  if (clean) {
    markPatchesApplied(installedRev() || undefined);
    if (freshExtract?.archive) core.writeUnpackedAsarStamp(freshExtract.archive);
    try {
      const seed = core.seedPromptInjectAtBoot(core.findDshHome());
      if (seed && seed.action === "error") {
        console.warn("[de-policy] seed prompt-inject failed:", seed.reason);
      }
    } catch (e) {
      console.warn("[de-policy] seed prompt-inject exception:", String(e && e.message ? e.message : e));
    }
  }
  let renamed = false;
  if (clean && handoff?.asar && options.scheduleSwap !== false) {
    const swapped = core.scheduleSealedDesktopRestart(handoff);
    renamed = Boolean(swapped?.renamed);
  }
  const pending = Boolean(handoff?.asar && !renamed && options.scheduleSwap !== false);
  // Only when app.asar was really moved aside is this process still on the old bundle and needs
  // another start. When the official side already runs from resources/app, never ask for a restart
  // just because of ELECTRON_RUN_AS_NODE, or every panel open requests one more restart.
  return {
    ok: clean,
    error: clean ? "" : "Chưa hoàn tất việc làm sạch",
    version: pluginVersion(),
    reverted: reverted.reverted?.length || 0,
    applied: summary.applied || 0,
    failed: summary.failed.length,
    renamed,
    needsFullQuit: renamed || pending,
    cmdFlashOk: flash.ok === true,
  };
}
