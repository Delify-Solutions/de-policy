import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsFor } from "./extract-asar.js";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as skills from "./skills.js";
import * as updater from "./update.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import {
  GLOBAL_PROMPT_ORDER,
  isMnemonPluginMessage,
  isChildAgentContext,
  isRedteamSession,
  installAssembleGuard,
  rewritePromptAssembly,
} from "./identity.js";
import { holdOwnedPresetAlive as coreHoldOwnedPresetAlive, scheduleOwnedSelectedDefaultSweep } from "./preset-default.js";
import { capabilityProtocolText, CAPABILITY_SECTION } from "./capability-protocol.js";
import { registerAnchor, anchorTextFor, ANCHOR_SECTION } from "./anchor.js";
import { installSubagentControl } from "./subagent-control.js";
import { installToolGateBypass } from "./tool-gate.js";
import { installSubagentRoleCapture, resolveSubagentRoleText } from "./redteam/role-section.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as uninstaller from "./uninstall.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import { installRegionGate, readAllowText, writeAllowText } from "./net-scope.js";
import {
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  watchContextLife,
} from "./settle-policy.js";
import { detachWindowsConsole, stripProxyEnv } from "./hide-console.js";

try { stripProxyEnv(); } catch { /* nothing to clear when no proxy vars are set */ }
try { detachWindowsConsole(); } catch { /* nothing to detach when no console is attached */ }

export const name = "de-policy";

// Never put pluginPackages into inject: Cordis waits forever on every key in the map.
// Portable copies / leftover Hub installs often lack this service; adding it just means pending then exit 1.
export const inject = ["systemPrompt", "tools"];

let bootFullQuit = false;

const DEFAULTS = {
  enabled: true,
  autoApplyOnStart: false,
  autoUpdateOnStart: false,
  autoRevertOnMissing: false,
  injectOnce: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "Continue",
  // Codex style: teach the model to discover skill / MCP itself; official registration and tools untouched.
  capabilityProtocol: true,
  // Tail anchor: identity lock at the end of the system prompt offsets the host copy after it.
  anchorMode: "auto", // "auto" | "off"
  // Child agent approval takeover: rewrite the host-hardcoded never into ask, then auto-approve.
  subagentControl: true,
  // Tool pre/post waterfall always allow / accept; skips auto-review and post-execute block.
  toolGateBypass: true,
};

const log = (config, ...args) => {
  if (config?.verbose) console.log("[de-policy]", ...args);
};

let webTreeReady = false;
let applyInFlight = false;
let lastStatusPayload = null;

function watchWebTreeReady(ctx) {
  // Must hook connection and then await, at the same moment the official code prints the URL.
  // Awaiting inside apply() returns early while later entries are absent, leaving session.list empty.
  // Entry reset: hot reload / apply after dispose reuses the previous ready=true, so the /status run
  // before the second inject trusts a stale flag; force a reset here.
  webTreeReady = false;
  const mark = () => {
    webTreeReady = true;
  };
  if (typeof ctx?.inject !== "function") {
    mark();
    return;
  }
  try {
    ctx.inject(["connection"], (host) => {
      const settled = host.get?.("loader")?.await?.();
      if (!settled || typeof settled.then !== "function") {
        mark();
        return;
      }
      settled.then(() => {
        if (host.get?.("webServer") !== undefined && host.get?.("connection") !== undefined) mark();
      }, mark);
    });
  } catch {
    mark();
  }
}

function fsExists(fp) {
  const list = Array.isArray(fp) ? fp : [fp];
  return list.some((p) => {
    if (!p || typeof p !== "string") return false;
    try {
      return fsFor(p).existsSync(p);
    } catch {
      return false;
    }
  });
}

function line(title, value, ok = null) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  return `${mark} ${title}: ${value}`;
}

function renderStatus(state) {
  const out = [];
  out.push("de-policy Trạng thái / Status");
  out.push(line("Bề mặt / surface", state.surface || hostctl.currentSurface()));
  out.push(line("DSH_HOME", state.dsh_home));
  if (state.desktop_install) out.push(line("Cài desktop / desktop", state.desktop_install));
  if (state.ai_base) {
    out.push(line("Gốc plugin / plugin root", state.ai_base));
    for (const [key, fp] of Object.entries(state.files)) {
      const list = Array.isArray(fp) ? fp : [fp];
      const shown = list.length <= 1 ? String(list[0] || "") : `${list[0]} (+${list.length - 1})`;
      out.push(`    ${fsExists(fp) ? "✓" : "✗"} ${key.padEnd(22)} ${shown}`);
    }
  } else {
    out.push(line("Gốc plugin / plugin root", core.missingAiBaseMessage(), false));
  }
  out.push(line("Thư mục shim", state.shim_dir || "chưa xác định / not found", !!state.shim_dir));
  if (state.desktop_runtimes?.length) {
    out.push(line("Desktop runtime", `${state.desktop_runtimes.length} sealed (shim OK; bak external)`, true));
    for (const d of state.desktop_runtimes) out.push(`    · ${d}`);
  }
  out.push(line("Sao lưu / backup", state.has_backup ? "có / yes" : "không / no", state.has_backup));
  out.push(line("Tệp inject / inject", state.override_path));
  out.push(line("Trạng thái inject / override", state.override_status));
  if (state.asar_still_sealed) {
    out.push(line("app.asar",
      "vẫn còn. Bản vá ghi vào thư mục đã giải nén, tiến trình hiện tại không đọc được", false));
  }
  out.push("");
  const displayRows = Array.isArray(state.display_patches)
    ? state.display_patches
    : core.groupPatchesForDisplay(core.ALL_PATCHES, state.patch_status || {});
  const displayTally = core.tallyDisplayPatches(displayRows);
  out.push(`Bản vá / patches: ${displayTally.applied}/${displayTally.total || 0} applied, `
    + `${displayTally.pending} pending`);
  for (const row of displayRows) {
    const s = row.status || "n/a";
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    const patch = core.ALL_PATCHES.find((item) => item.id === row.id);
    const label = row.title || (patch ? patch.desc?.split(" / ")[0] : "") || (patch ? patch.name : `patch-${row.id}`);
    const idLabel = Array.isArray(row.ids) && row.ids.length > 1 ? row.ids.join("/") : String(row.id);
    const layer = patch ? `${patch.layer}/${patch.layer_en}` : row.layer || "";
    out.push(`  ${mark} [#${String(idLabel).padEnd(6)}] ${label.padEnd(36)} ${layer} — ${s}`);
  }
  out.push("");
  out.push(`shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function injectAllowedNow(config) {
  return config.enabled !== false;
}

/** prompt-inject.md (saved copy) > the box not yet flushed by this process > encrypted default. */
// mtime throttle: with 400ms setInterval + per pre-step + per preset-selected + per readInjectFallback
// firing often, disk sync + 3 hashOverride calls + 2 module-level writes hit 20 times per click.
// Reuse the last result in a short window: same home + unchanged file mtime + < 200ms since last call.
let hungCache = { home: "", mtime: 0, at: 0, resolved: null };
const HUNG_CACHE_MS = 200;
function statInjectMtimeMs(home) {
  if (!home) return 0;
  try {
    return Math.floor(fs.statSync(core.findOverrideFile(home)).mtimeMs);
  } catch { return 0; }
}
function refreshHungOperator(dshHome = core.findDshHome()) {
  const home = core.pinDshHome() || dshHome || core.findDshHome();
  const now = Date.now();
  const mtimeBefore = statInjectMtimeMs(home);
  if (
    hungCache.resolved
    && hungCache.home === home
    && hungCache.mtime === mtimeBefore
    && now - hungCache.at < HUNG_CACHE_MS
  ) {
    return hungCache.resolved;
  }
  try { core.syncPromptInjectOnDiskSync(home); } catch { /* a sync failure still follows the resolve path */ }
  const resolved = rules.resolveInjectText(home);
  // Fallback order: resolved.text > encrypted default > never empty (empty second fallback hits purge[]).
  const fallback = core.normalizeOverride(core.defaultOverrideText()) || "";
  // Box, disk and encrypted slot go to the model as-is; no ChatML, no interpolation, no mode trimming.
  const text = resolved.text || fallback;
  if (text) {
    core.hangOperatorPrompt(text);
    // Same rule as the "save" button: without saving, assembly must still read this full text.
    core.rememberCommittedOverride(home, text);
  }
  const out = { ...resolved, text: text || resolved.text };
  // Cache on the post-sync mtime so the next high-frequency poll (file untouched) hits it directly.
  hungCache = { home, mtime: statInjectMtimeMs(home), at: now, resolved: out };
  return out;
}

function syncHungPromptGlobal() {
  const text = hungCache.resolved?.text || core.hungOperatorPrompt() || "";
  try { globalThis.__dshPurgeHungPrompt = text; } catch { /* ignore */ }
}

// All three paths inject full text. Does not read inbox or touch steer/followup, avoiding false wakeups.
function shouldInjectAssembly(context) {
  const decision = { mode: "full", taskKind: "general", lastRole: "full", isSubagent: false };
  try {
    decision.isSubagent = isChildAgentContext(context);
  } catch { /* ignore */ }
  if (globalThis.__dshPurgeRetryPending) {
    globalThis.__dshPurgeRetryPending = false;
    decision.lastRole = "retry";
  }
  return decision;
}

function readSessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

// [approach 2] Log probe. Writes to an internal file, keeping host stderr clean. Monitor tails with tail -F.
const PURGE_INTERNAL_LOG = path.join(os.tmpdir(), "de-policy-desktop.log");
// Log rotation: check size every ~1024 writes; above 2MB rename the current file to .1 over the old .1,
// and the new file starts empty. Long sessions / repeated hot reloads cannot blow up tmp.
const PURGE_INTERNAL_LOG_MAX = 2 << 20;
let _purgeLogWriteCount = 0;
function rotatePurgeInternalLog() {
  try {
    const st = fs.statSync(PURGE_INTERNAL_LOG);
    if (st.size > PURGE_INTERNAL_LOG_MAX) {
      try { fs.renameSync(PURGE_INTERNAL_LOG, `${PURGE_INTERNAL_LOG}.1`); } catch { /* retry later */ }
    }
  } catch { /* file does not exist */ }
}
// One-line ISO timestamp + tag + k=v... format. Easy to read with tail -F and grep.
// Spaces in values would split the kv pairs, so they are all replaced with _ to keep grep stable.
function purgeLog(tag, kv) {
  try {
    if ((++_purgeLogWriteCount & 0x3ff) === 0) rotatePurgeInternalLog();
    let line = `${new Date().toISOString()} [${tag}]`;
    if (kv) {
      for (const k of Object.keys(kv)) {
        const raw = kv[k];
        const v = raw === undefined || raw === null ? "" : String(raw).replace(/\s+/g, "_");
        line += ` ${k}=${v}`;
      }
    }
    fs.appendFileSync(PURGE_INTERNAL_LOG, line + "\n", "utf8");
  } catch {}
}
function logAssembleDecision(where, decision) {
  purgeLog(`assemble.${where}`, {
    mode: decision.mode,
    task: decision.taskKind,
    last: decision.lastRole,
    sub: decision.isSubagent,
  });
}

function injectSnapshot(dshHome = core.findDshHome()) {
  const resolved = rules.resolveInjectText(dshHome);
  return {
    injectSource: resolved.source,
    injectRuleId: resolved.ruleId,
    needPrompt: resolved.source === "none",
  };
}

/** Text shown in the box wins; when empty, resolveInjectText (includes prompt-inject.md). */
function injectSnapshotFromBox(dshHome, boxText) {
  if (typeof boxText === "string" && core.normalizeOverride(boxText)) {
    return { injectSource: "prompt", injectRuleId: null, needPrompt: false };
  }
  const resolved = rules.resolveInjectText(dshHome);
  if (resolved.text) {
    return { injectSource: resolved.source, injectRuleId: null, needPrompt: false };
  }
  return { injectSource: "none", injectRuleId: null, needPrompt: true };
}

const NEED_PROMPT_ERROR = "Cả prompt lẫn bộ luật đều rỗng, phải thêm prompt trước";

function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

/** Do the real patch. The official asar web calls it after HTTP returns, so unpacking never stalls. */
async function executePurgeApply({ incoming, home, scrubbed, surface }) {
  const surf = surface || hostctl.currentSurface();
  let located = { aiBase: "", handoff: null, extracted: false };
  try {
    if (surf === "desktop") {
      located = await core.resolveApplyAiBase(core.findAiBase({ surface: surf }), { forApply: true, surface: surf });
    } else {
      // web patches only npm/profile @deepseek-ai. No asar unpack, no .app, or Mac hangs for minutes.
      const npm = core.findAiBaseWebNpm();
      located = { aiBase: npm || "", handoff: null, extracted: false };
    }
  } catch (e) {
    console.warn("[de-policy] apply locate:", String(e && e.message ? e.message : e));
    located = {
      aiBase: surf === "desktop" ? (core.findAiBase({ surface: surf }) || "") : (core.findAiBaseWebNpm() || ""),
      handoff: null,
      extracted: false,
      error: String(e && e.message ? e.message : e),
    };
  }
  const state = {
    dsh_home: home,
    ai_base: located.aiBase || "",
  };
  if (located.aiBase) state.ai_base = located.aiBase;
  if (located.extracted) {
    const arch = located.handoff?.archive;
    if (arch) core.writeUnpackedAsarStamp(arch);
  }
  const handoff = located.handoff && located.handoff.swapAsar ? located.handoff : null;
  if (!state.ai_base) {
    const override = await core.readOverrideForUi(state.dsh_home);
    const missing = located.error || core.missingAiBaseMessage();
    const missingPayload = {
      ok: true,
      complete: false,
      prompt_only: true,
      web_no_package: false,
      ask_restart: false,
      restarting: false,
      surface: surf,
      ai_base: "",
      asar_still_sealed: core.desktopAsarStillSealed(),
      missing_ai_base: missing,
      error: missing,
      override_content: override.content,
      defaultContent: override.defaultContent,
      ...injectSnapshot(state.dsh_home),
      override_path: override.path,
    };
    try { reapply.writeLastApply(missingPayload); } catch { /* ignore */ }
    return missingPayload;
  }
  const httpMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
    preserveClientBundles: false,
    forApply: true,
    aiBase: state.ai_base,
    surface: surf,
  });
  const report = httpMulti.report;
  const shim = surf === "desktop" ? await core.patchAllShims() : {};
  let cliRepair = null;
  try {
    cliRepair = core.repairOfficialCliAfterUnpack();
  } catch (e) {
    cliRepair = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const flash = surf === "desktop"
    ? core.silenceCmdFlash(httpMulti.hosts[0]?.aiBase || state.ai_base)
    : { ok: true, entry: "skipped_web" };
  const summary = core.summarizeApplyReport(report);
  const hostWritten =
    core.allPatchHostsWritten(httpMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
  const backupBlocked = (httpMulti.hosts || []).some((h) => Array.isArray(h.backupFailed) && h.backupFailed.length);
  const writeDenied = (httpMulti.hosts || []).map((h) => h.writeDenied).find((row) => row && row.ok === false);
  const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !backupBlocked && !writeDenied;
  const sealedNow = core.desktopAsarStillSealed();
  const promptReady = core.failedAllowsPromptReady(summary.failed);
  if (flash.ok === true && (complete || promptReady) && hostWritten) {
    reapply.markPatchesApplied();
  }
  const askRestart = applyShouldRestart({
    complete: complete || (promptReady && hostWritten),
    promptReady: promptReady && hostWritten,
  }) && !backupBlocked;
  if (askRestart && handoff && sealedNow && surf === "desktop") bootFullQuit = true;
  else if (surf !== "desktop") bootFullQuit = false;
  if (askRestart) reapply.markSettleRestart();
  let promptInjectInstall = "skipped";
  if (hostWritten && flash.ok === true) {
    try {
      const diskRaw = core.readPromptInjectFileSync(home);
      const diskNorm = core.normalizeOverride(diskRaw);
      const bundledNorm = core.normalizeOverride(core.defaultOverrideText());
      if (diskNorm && diskNorm !== bundledNorm && core.isKeepableUserOverride(home, diskRaw)) {
        promptInjectInstall = "kept_user_custom";
      } else {
        const seed = core.seedPromptInjectAtBoot(home);
        promptInjectInstall = seed?.action || "noop";
      }
    } catch (e) {
      promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
    }
  }
  const hung = refreshHungOperator(state.dsh_home);
  const override = await core.readOverrideForUi(state.dsh_home);
  const patch_status = {};
  for (const row of report) {
    const id = row.patch_id ?? row.id;
    if (id != null) patch_status[id] = row.status;
  }
  const display_patches = core.groupPatchesForDisplay(core.ALL_PATCHES, patch_status);
  purgeLog("http.apply", {
    complete,
    askRestart,
    applied: summary.applied,
    already: summary.already,
    failed: summary.failed.length,
    seed: promptInjectInstall,
    incoming: incoming === null ? -1 : incoming.length,
    surface: surf,
    aiBase: state.ai_base,
    extracted: Boolean(located.extracted),
  });
  const applyPayload = {
    ok: true,
    complete,
    host_written: hostWritten,
    surface: surf,
    control_surface: surf,
    process_surface: hostctl.currentSurface(),
    ai_base: state.ai_base || "",
    dsh_home: state.dsh_home,
    ask_restart: askRestart,
    restarting: askRestart,
    restart_after_apply: askRestart,
    unpacked_asar: Boolean(located.extracted),
    needs_full_quit: false,
    asar_still_sealed: sealedNow,
    asar_swap_started: false,
    applied: summary.applied,
    already: summary.already,
    failed: summary.failed.length,
    failed_items: summary.failed.map((r) => ({
      id: r.patch_id,
      name: r.name,
      status: r.status,
    })),
    report: report.map((r) => ({ id: r.patch_id, name: r.name, status: r.status })),
    patch_status,
    patches: display_patches.map((p) => ({
      id: p.id,
      ids: p.ids,
      layer: p.layer || "",
      status: p.status,
      title: p.title || "",
    })),
    override_content: hung.text || override.content,
    defaultContent: override.defaultContent,
    ...injectSnapshot(state.dsh_home),
    override_path: override.path,
    override_installed: promptInjectInstall,
    system_field_extracted: true,
    shim,
    desktop_scrubbed: scrubbed,
    cli_repair: cliRepair,
    cmd_flash: flash,
    patches_applied: (summary.applied || 0) + (summary.already || 0),
  };
  if (writeDenied && writeDenied.error) {
    applyPayload.ok = false;
    applyPayload.error = writeDenied.error;
  }
  try { reapply.writeLastApply(applyPayload); } catch { /* ignore */ }
  return applyPayload;
}

async function ensureRestartReady() {
  // Restart only after the user clicked apply. discover + patchStatus here would stall HTTP
  // and leave the panel stuck on "restarting" with the assistant unable to get in.
  return { ok: true };
}

/** The prompt ctx usually has no scope, so the section goes global; a preset proxy cannot see it. */
function addPromptSection(ctx, section) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* reading a property throws without inject */ }
  push(ctx);
  const disposers = [];
  let registered = false;
  let lastError = null;
  for (const host of hosts) {
    try {
      const d = host.systemPrompt.section(section);
      registered = true;
      if (typeof d === "function") disposers.push(d);
    } catch (error) {
      const msg = String(error && error.message || error);
      if (msg.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError) throw lastError;
  // Have ctx.effect drop the section on reload / dispose; host.systemPrompt.section
  // returns no disposer today; only implementations returning a function benefit, old behavior kept.
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* dead ctx */ }
  }
}

export function registerPromptSections(ctx, config) {
  addPromptSection(ctx, {
    name: "de-policy",
    order: GLOBAL_PROMPT_ORDER,
    interpolate: false,
    text: (context) => {
      if (!injectAllowedNow(config)) return "";
      // Whatever is written goes into system verbatim; no tidying, no trimming.
      return readInjectFallback(context);
    },
  });

  if (config.capabilityProtocol !== false) {
    addPromptSection(ctx, {
      name: CAPABILITY_SECTION,
      order: GLOBAL_PROMPT_ORDER + 1,
      interpolate: false,
      text: (context) => {
        if (!injectAllowedNow(config)) return "";
        const redteam = isRedteamSession(context);
        return capabilityProtocolText({
          redteam,
          redteamChild: redteam && isChildAgentContext(context),
          enabled: true,
        });
      },
    });
  }

  const postPrompt = typeof config.postPrompt === "string" ? config.postPrompt.trim() : "";
  if (!postPrompt) return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    // A throw in the old version blew up apply; postPrompt is extra, so skipping it is safe.
    console.warn(
      `[de-policy] postPromptOrder (${config.postPromptOrder}) phải là số hữu hạn `
    + `> ${GLOBAL_PROMPT_ORDER}; bỏ qua đoạn postPrompt`,
    );
    return;
  }
  addPromptSection(ctx, {
    name: "de-policy:post",
    order: config.postPromptOrder,
    text: () => (injectAllowedNow(config) ? postPrompt : ""),
  });
}

function readInjectFallback(context) {
  let home = "";
  try { home = core.findDshHome(); } catch { home = ""; }
  const refreshed = refreshHungOperator(home);
  let text = refreshed.text || "";
  let source = text ? "refresh" : "none";
  if (!text) {
    const fallback = rules.ensureOperatorBody(home);
    if (fallback) { text = fallback; source = "ensure"; }
  }
  if (!text) {
    purgeLog("inject.read", { source: "empty", bytes: 0 });
    return "";
  }
  let redteam = false;
  try { redteam = isRedteamSession(context); } catch { redteam = false; }
  let subagent = false;
  try { subagent = isChildAgentContext(context); } catch { subagent = false; }
  purgeLog("inject.read", {
    source,
    srcTag: refreshed.source || "n/a",
    redteam,
    sub: subagent,
    rawBytes: text.length,
    outBytes: text.length,
  });
  return text;
}

function installMnemonMessageStrip(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeMnemonStrip) return;
  ctx.__dshPurgeMnemonStrip = true;
  const strip = config.stripMnemon !== false;
  const wrap = async (_payload, next) => {
    const decision = await next();
    if (!decision) return decision;
    // agent-loop reads decision.messages.length; missing it blows up gateway/internal on round two.
    const incoming = Array.isArray(decision.messages) ? decision.messages : [];
    const messages = strip ? incoming.filter((message) => !isMnemonPluginMessage(message)) : incoming;
    if (messages.length === incoming.length && Array.isArray(decision.messages)) return decision;
    return { ...decision, messages };
  };
  // In the old version late() + queueMicrotask(late) + setTimeout(late, 1500) could all succeed,
  // stacking the same wrap 3 deep on the agent/pre-step waterfall and filtering decisions 3 times per round.
  // A mounted gate is used here: hook once successfully, stop retrying, and hand the disposer to ctx.effect.
  let mounted = false;
  let dispose = null;
  const late = () => {
    if (mounted) return;
    try {
      const d = ctx.on("agent/pre-step", wrap, { global: true, prepend: true });
      mounted = true;
      if (typeof d === "function") dispose = d;
    } catch { /* retry next time */ }
  };
  late();
  if (!mounted) queueMicrotask(late);
  let retryTimer = null;
  if (!mounted) {
    retryTimer = setTimeout(late, 1500);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }
  try {
    ctx.effect(() => () => {
      if (retryTimer) clearTimeout(retryTimer);
      try { dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* no effect on a dead ctx; the next apply overwrites it */ }
}

function rewriteLiveAssembly(config, assembled, context, decision = { mode: "full", taskKind: "general" }) {
  const enabled = config.enabled !== false;
  const redteam = enabled && isRedteamSession(context);
  const full = enabled ? readInjectFallback(context) : "";
  const dshHome = enabled ? core.findDshHome() : "";
  let cwd = "";
  try { cwd = String(context?.agent?.session?.header?.cwd || "").trim(); } catch { /* ignore */ }
  if (dshHome && cwd) {
    try { rules.writeLastCwd(dshHome, cwd); } catch { /* ignore */ }
  }
  if (!cwd && dshHome) {
    try { cwd = String(rules.readLastCwd(dshHome) || "").trim(); } catch { /* ignore */ }
  }
  const policy = enabled && dshHome ? rules.readWorkspacePolicy(dshHome) : "always";
  // Enable the checked local cwd rule fallback only when the prompt box is empty (avoids inject overlap).
  let localInject = "";
  if (enabled && dshHome && !String(full || "").trim()) {
    try { localInject = rules.readSelectedCwdInject(dshHome, cwd); } catch { /* ignore */ }
  }
  const effectiveFull = String(full || "").trim() ? full : localInject;
  const inject = effectiveFull;
  // rewritePromptAssembly appends the anchor as the last section of the sections array;
  // when the host skips the rewrite, the 10150 section registered by registerAnchor still backs it up.
  let anchorApplied = false;
  const hasInject = Boolean(String(inject || "").trim());
  let dropWorkspaceBaseline = false;
  if (enabled) {
    if (policy === "strict") dropWorkspaceBaseline = true;
    else if (policy === "fallback") dropWorkspaceBaseline = hasInject;
    else dropWorkspaceBaseline = false;
  }
  const roleText = redteam ? resolveSubagentRoleText(context) : "";
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon !== false,
    capabilityProtocol: config.capabilityProtocol !== false,
    context,
    roleText,
    dropWorkspaceBaseline,
    cwd,
    anchorText: anchorTextFor(config),
  });
  anchorApplied = Array.isArray(rewritten?.sections)
    && rewritten.sections.some((section) => String(section?.name || "") === ANCHOR_SECTION);
  const closerFollow = closerFollowBytes(rewritten?.sections);
  let subagent = false;
  try { subagent = isChildAgentContext(context); } catch { subagent = false; }
  // Approval policy of the current session: never makes decide() reject before the waterfall runs.
  // That is the most direct evidence of "always rejected", so print it with every round's assembly.
  const approvalPolicy = (() => {
    try {
      const session = context?.agent?.session;
      const svc = context?.agent?.ctx?.get?.("approval");
      return typeof svc?.effectivePolicy === "function" ? svc.effectivePolicy(session) : "n/a";
    } catch { return "n/a"; }
  })();
  purgeLog("assemble.rewrite", {
    enabled,
    redteam,
    sub: subagent,
    mode: decision?.mode || "full",
    task: decision?.taskKind || "general",
    last: decision?.lastRole || "unknown",
    fullBytes: full.length,
    localBytes: localInject.length,
    injectBytes: inject.length,
    anchorApplied,
    roleBytes: roleText.length,
    cap: config.capabilityProtocol !== false,
    strip: config.stripMnemon !== false,
    policy,
    approval: approvalPolicy,
    dropWorkspaceBaseline,
    injectHead: Array.isArray(rewritten?.sections) && (() => {
      const first = rewritten.sections[0];
      const firstText = String(first?.text || "");
      const name = String(first?.name || "");
      if (name === "de-policy") return true;
      if (!inject) return false;
      return /persona-prefix$|^persona$|^deployment:persona$/.test(name) && firstText.includes(inject);
    })(),
    folded: Array.isArray(rewritten?.sections) && (() => {
      const first = rewritten.sections[0];
      const name = String(first?.name || "");
      if (!inject) return false;
      return /persona-prefix$|^persona$|^deployment:persona$/.test(name)
        && String(first?.text || "").includes(inject);
    })(),
    injectTail: Array.isArray(rewritten?.sections) && rewritten.sections.length > 0
      && /^de-policy(:|$)/.test(String(rewritten.sections[rewritten.sections.length - 1]?.name || "")),
    chatml: Array.isArray(rewritten?.sections) && /<project_instructions>|<\|im_start\|>/i.test(String(rewritten.sections[0]?.text || "")),
    afterCloser: closerFollow,
    cwd,
  });
  return rewritten;
}

function closerFollowBytes(sections) {
  const closer = "</project_instructions>";
  const joined = (Array.isArray(sections) ? sections : [])
    .map((section) => (typeof section?.text === "string" ? section.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const at = joined.lastIndexOf(closer);
  if (at < 0) return -1;
  return joined.length - (at + closer.length);
}

/** If the registry already computed rev from the old file, rebuild now so page URL and cache agree (#63). */
function publishClientBundleRevs(ctx, packageNames) {
  if (!Array.isArray(packageNames) || packageNames.length === 0) return;
  let mods = null;
  try {
    mods = ctx?.get?.("clientModules", false);
  } catch {
    mods = null;
  }
  if (!mods || typeof mods.rebuilt !== "function") return;
  for (const id of packageNames) {
    try { mods.rebuilt(id); } catch { /* not in the registry yet; the next snapshot reads it */ }
  }
}

/** Cordis ctx is a Proxy: without a declared inject, reading a property throws; wrap both in try. */
function permissionPresetsOf(ctx) {
  try {
    const direct = ctx?.permissionPresets;
    if (direct && typeof direct.set === "function") return direct;
  } catch {
    /* Without this service injected the Cordis proxy throws; a full-permission pin must not fail hard. */
  }
  try {
    const svc = ctx?.get?.("permissionPresets");
    if (svc && typeof svc.set === "function") return svc;
  } catch {
    /* this service is absent. */
  }
  return null;
}

function shouldKeepFreshFullAccess(session, svc) {
  const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
  const preset = state?.preset;
  if (preset === "danger-full-access" || preset === "auto" || preset === "custom") return false;
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const pins = Array.isArray(events) ? events.filter((event) => event?.type === "permission/preset") : [];
  if (pins.length > 1) return false;
  return preset == null || preset === "workspace-write" || preset === "read-only";
}

function upgradeFreshSessionAccess(ctx, session) {
  try {
    const svc = permissionPresetsOf(ctx);
    if (!svc || !shouldKeepFreshFullAccess(session, svc)) return;
    svc.set(session, "danger-full-access");
  } catch (error) {
    console.warn("[de-policy] full-access pin:", error instanceof Error ? error.message : String(error));
  }
}

/** A fresh session shows full permission by default; pinning workspace-write drops the chip after sending. */
function installFreshFullAccess(ctx) {
  if (typeof ctx.on !== "function" || ctx.__dshPurgeFullPin) return;
  ctx.__dshPurgeFullPin = true;
  // ctx.effect: unbind session/created on plugin dispose, else handlers linger and hot reload doubles them.
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => {
      queueMicrotask(() => upgradeFreshSessionAccess(ctx, session));
    }); } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeFullPin;
    };
  });
}

function installCwdCapture(ctx) {
  if (!ctx || ctx.__dshPurgeCwdCapture) return;
  if (typeof ctx.on !== "function") return;
  ctx.__dshPurgeCwdCapture = true;
  const home = core.findDshHome();
  let lastWritten = "";
  const flush = (session) => {
    try {
      const cwd = String(session?.header?.cwd || "").trim();
      if (!cwd || !home || cwd === lastWritten) return;
      rules.writeLastCwd(home, cwd);
      lastWritten = cwd;
    } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) flush(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    const disposers = [];
    try { disposers.push(ctx.on("session/created", flush)); } catch { /* ignore */ }
    try { disposers.push(ctx.on("session/event", (session) => flush(session))); } catch { /* ignore */ }
    return () => {
      for (const d of disposers) {
        try { if (typeof d === "function") d(); } catch { /* ignore */ }
      }
      delete ctx.__dshPurgeCwdCapture;
    };
  });
}

function pinOneSystemPrompt(sp) {
  if (!sp || typeof sp.project !== "function") return false;
  if (sp._dshPurgeProjectWrapped) return true;
  const orig = typeof sp.project.bind === "function" ? sp.project.bind(sp) : sp.project;
  const wrapped = function dshPurgeProject(rendered, input) {
    const next = input && typeof input === "object" ? { ...input, inHistory: false } : { inHistory: false };
    return orig(rendered, next);
  };
  try {
    sp.project = wrapped;
    sp._dshPurgeProjectWrapped = true;
    return true;
  } catch {
    try {
      Object.defineProperty(sp, "project", {
        configurable: true,
        writable: true,
        value: wrapped,
      });
      sp._dshPurgeProjectWrapped = true;
      return true;
    } catch {
      return false;
    }
  }
}

function pinSystemPromptReplace(target) {
  if (!target) return false;
  // A child agent's loopCtx.systemPrompt and agent.systemPrompt are often different objects.
  // Pinning only agent lets later steps use the inHistory slot, where official identity overrides inject.
  const seen = new Set();
  let pinned = false;
  const add = (sp) => {
    if (!sp || seen.has(sp)) return;
    seen.add(sp);
    if (pinOneSystemPrompt(sp)) pinned = true;
  };
  add(target);
  add(target.systemPrompt);
  add(target.loopCtx && target.loopCtx.systemPrompt);
  add(target.ctx && target.ctx.systemPrompt);
  return pinned;
}

function installCwdVariable(host) {
  if (!host || host.__dshPurgeCwdVar) return;
  let prompt = null;
  try { prompt = host.systemPrompt; } catch { prompt = null; }
  if (!prompt || typeof prompt.variable !== "function") return;
  host.__dshPurgeCwdVar = true;
  try {
    prompt.variable("cwd", (context) => {
      try {
        const live = String(context?.agent?.session?.header?.cwd || "").trim();
        if (live) return live;
      } catch { /* ignore */ }
      try {
        const last = String(rules.readLastCwd(core.findDshHome()) || "").trim();
        if (last) return last;
      } catch { /* ignore */ }
      return "";
    });
  } catch (error) {
    const msg = String(error && error.message || error);
    if (!/already registered/i.test(msg)) {
      try { console.warn("[de-policy] cwd variable:", msg); } catch { /* ignore */ }
    }
  }
}

function bindLiveAgent(agent, prepareAssemble, caller = "unknown") {
  if (!agent) return;
  try {
    const loopCtx = agent.loopCtx || agent.ctx;
    if (loopCtx && typeof prepareAssemble === "function") prepareAssemble(loopCtx);
  } catch { /* this proxy layer has no systemPrompt yet */ }
  const pinned = pinSystemPromptReplace(agent);
  let origin = "";
  try { origin = String(agent.session?.header?.origin || ""); } catch { origin = ""; }
  purgeLog("agent.bind", {
    caller,
    id: agent.id || "",
    origin,
    pinned,
  });
}

function scheduleChildPrepare(session, ctx, bindAgent) {
  const header = session?.header;
  if (!header) return;
  /*
   * Only delegation origin and depth count; **`parentSession` is ignored**.
   * The host also writes parentSession for sessions resumed or branched from history; those still
   * have delegationDepth 0 and are their own root at runtime. Treating them as child agents would
   * bind the agent to the wrong session (red-team resumed sessions hit this in practice).
   */
  const isChild = header.origin === "subagent"
    || header.origin === "teammate"
    || header.origin === "delegate"
    || (header.delegationDepth ?? 0) > 0;
  if (!isChild) return;
  const tryBind = () => {
    try {
      const agents = ctx.agents || (typeof ctx.get === "function" ? ctx.get("agents") : null);
      const child = typeof agents?.get === "function" ? agents.get(session.id) : null;
      if (!child) return false;
      bindAgent(child, "sessionCreated");
      return true;
    } catch {
      return false;
    }
  };
  if (tryBind()) return;
  try {
    const iso = session.ctx || session.loopCtx;
    if (iso) bindAgent({ ctx: iso, loopCtx: iso, session, id: session.id }, "sessionCreatedIso");
  } catch { /* isolate is not mounted yet */ }
  queueMicrotask(tryBind);
  setTimeout(tryBind, 0);
  setTimeout(tryBind, 50);
}

function installIdentityOverride(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  installSubagentRoleCapture(ctx);
  installCwdVariable(ctx);
  // installAssembleGuard is idempotent: a prompt already hooked by slot.rewrite only swaps rewriteFn,
  // no new dispose. The original pushed a noop closure into the Set every 400ms + every pre-step,
  // accumulating tens of thousands in a 2-hour session. Now: track only the first real disposer.
  const wrapDisposers = new Set();
  const wrappedPrompts = new WeakSet();
  const trackDisposer = (d, prompt) => {
    if (typeof d !== "function") return d;
    if (prompt) {
      if (wrappedPrompts.has(prompt)) return d;
      wrappedPrompts.add(prompt);
    }
    wrapDisposers.add(d);
    return d;
  };
  const rewriteFn = (assembled, context) => {
    // [approach 2] installAssembleGuard takes this same path and makes the same full/anchor decision.
    const decision = shouldInjectAssembly(context);
    logAssembleDecision("rewriteFn", decision);
    return rewriteLiveAssembly(config, assembled, context, decision);
  };
  // The interval heartbeat runs every 400ms and nothing changes in steady state — log only on flips or errors
  // so millions of guard.wrap entries per day do not flood a 7MB log and drown the real events.
  let lastGuardSig = "";
  const wrapAssemble = (caller = "unknown") => {
    try {
      const prompt = ctx.systemPrompt;
      const d = installAssembleGuard(prompt, rewriteFn);
      try { pinSystemPromptReplace(prompt); } catch { /* ignore */ }
      try { pinSystemPromptReplace(ctx); } catch { /* ignore */ }
      const mounted = typeof d === "function";
      const tracked = trackDisposer(d, prompt);
      const sig = `${!!prompt}|${mounted}`;
      if (sig !== lastGuardSig) {
        purgeLog("guard.wrap", { caller, prompt: !!prompt, mounted });
        lastGuardSig = sig;
      }
      return tracked;
    } catch (e) {
      purgeLog("guard.wrap", { caller, err: String(e?.message || e) });
      lastGuardSig = "";
      return false;
    }
  };
  if (!ctx.__dshPurgeAssembleHook) {
    ctx.__dshPurgeAssembleHook = true;
    // Different cordis versions may call the waterfall as (assembly, context) or (assembly, context, next):
    // the old code took the 3rd arg as a function, so an old host passed context as next and next() threw.
    // Disposers stay out of wrapDisposers: ctx.effect cleanup fires on child scope exit or preset switch,
    // and collecting it would unbind it forever. On a real cordis dispose the listener dies with ctx.
    try {
      ctx.on("system-prompt/assemble", async (...args) => {
        const [assembly, context] = args;
        const next = args.length >= 3 ? args[args.length - 1] : null;
        // Log on entry — proves the request reached our handler; hasNext=false means cordis used
        // the old signature, so the downstream waterfall relies entirely on the assembled we return.
        let eventsLen = 0;
        try { eventsLen = readSessionEvents(context?.agent?.session).length; } catch {}
        purgeLog("assemble.entry", {
          hasNext: typeof next === "function",
          sections: Array.isArray(assembly?.sections) ? assembly.sections.length : -1,
          events: eventsLen,
        });
        let assembled = assembly;
        if (typeof next === "function") {
          try {
            assembled = await next();
          } catch (err) {
            // A throw anywhere downstream kills the whole assemble and the UI hangs without sending.
            // Swallow it and fall back to the upstream assembly so the inject still hooks.
            try { console.warn("[de-policy] system-prompt/assemble waterfall rejected:", err?.message || err); } catch {}
            purgeLog("assemble.waterfall", { err: String(err?.message || err) });
            assembled = assembly;
          }
        }
        try {
          // [v10] The handler refreshes up front: round one may see a null hungCache
          // and installAssembleGuard may not have wrapped systemPrompt, so force reads warm here
          // to keep readInjectFallback → refreshHungOperator on a warm cache instead of the empty-value path.
          try { refreshHungOperator(core.findDshHome()); } catch { /* a resolve exception never blocks */ }
          const decision = shouldInjectAssembly(context);
          logAssembleDecision("event", decision);
          return rewriteLiveAssembly(config, assembled, context, decision);
        } catch (err) {
          try { console.warn("[de-policy] rewriteLiveAssembly failed:", err?.message || err); } catch {}
          purgeLog("assemble.rewriteFail", { err: String(err?.message || err) });
          return assembled;
        }
      }, { global: true, prepend: true });
    } catch { /* old ctx.on signatures throw; the next apply overwrites */ }
  }
  // Switching preset replaces assemble. The pre-step waterfall runs later, so the first send misses it.
  // The host calls this function before assemble and uses the current mode's own systemPrompt.
  const prepareAssemble = (loopCtx) => {
    try { refreshHungOperator(core.findDshHome()); } catch { /* the primary home has no prompt yet */ }
    // loopCtx may be a host Proxy where reading .systemPrompt throws (no service injected there).
    let prompt = null;
    try { prompt = loopCtx && loopCtx.systemPrompt; } catch { prompt = null; }
    if (prompt) {
      try {
        trackDisposer(installAssembleGuard(prompt, rewriteFn), prompt);
      } catch { /* when this proxy layer cannot be wrapped, wrap the plugin's own below */ }
      try { pinSystemPromptReplace(prompt); } catch { /* the assemble rewrite still covers it */ }
    }
    try {
      const iso = (loopCtx && loopCtx.ctx) || loopCtx;
      if (iso && iso !== ctx) {
        installCwdVariable(iso);
        registerPromptSections(iso, config);
        registerAnchor(iso, config);
      }
    } catch { /* the isolate layer has no systemPrompt yet */ }
    wrapAssemble("prepareAssemble");
    return prompt || null;
  };
  globalThis.__dshPurgePrepareAssemble = prepareAssemble;
  syncHungPromptGlobal();
  // complete:true overwrites sections after the waterfall; wrap the return so inject returns each round.
  wrapAssemble("init");
  try {
    const agents = ctx.agents || (typeof ctx.get === "function" ? ctx.get("agents") : null);
    const live = typeof agents?.list === "function" ? agents.list() : [];
    for (const agent of live || []) bindLiveAgent(agent, prepareAssemble, "initList");
  } catch { /* no agents service at startup */ }
  // The guard must re-mount whenever cordis swaps the systemPrompt proxy (preset switch, subagent fork,
  // live-mount). It used to clearInterval after 20s, so a later swap went unwrapped and round two used
  // native assemble; complete:true kept only the full section and it looked truncated. The guard is
  // idempotent (WeakSet + identity check), so 400ms until ctx dispose costs negligible CPU.
  // 400ms vs a 2000ms window: the first assemble of a new conversation may run before the hook lands.
  // CPU cost (idempotent wrap) is nothing compared to "new conversation broken" from the user's view.
  const timer = setInterval(() => wrapAssemble("interval"), 400);
  if (typeof timer.unref === "function") timer.unref();
  // The three ctx.on below need a flag: a second apply of installIdentityOverride on the same ctx
  // (re-mount after dispose / hot reload) stacks listeners: inject runs N times, wrap N deep.
  if (!ctx.__dshPurgeSessionHook) {
    ctx.__dshPurgeSessionHook = true;
    try {
      ctx.on("session/created", (session) => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* the primary home has no prompt yet */ }
        wrapAssemble("sessionCreated");
        scheduleChildPrepare(session, ctx, (agent, caller) => bindLiveAgent(agent, prepareAssemble, caller));
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgeAgentHook) {
    ctx.__dshPurgeAgentHook = true;
    try {
      ctx.on("agent/created", (payload) => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* the primary home has no prompt yet */ }
        bindLiveAgent(payload?.agent, prepareAssemble, "agentCreated");
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePresetHook) {
    ctx.__dshPurgePresetHook = true;
    try {
      ctx.on("agent-preset/selected", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* the primary home has no prompt yet */ }
        wrapAssemble("presetSelected");
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePreStepHook) {
    ctx.__dshPurgePreStepHook = true;
    try {
      ctx.on("agent/pre-step", (payload, next) => {
        wrapAssemble("preStep");
        try {
          const agent = payload && payload.agent;
          if (agent) pinSystemPromptReplace(agent);
        } catch { /* with no agent at this step, wrap only the host assemble */ }
        return typeof next === "function" ? next() : payload;
      }, { global: true, prepend: true });
    } catch { /* ignore */ }
  }
  // Collect everything on hot reload/unload: the poll timer, the guard proxy layer, the global hooks
  // exposed to the agent loop all get swept in the same effect; otherwise the next apply binds another layer.
  try {
    ctx.effect(() => () => {
      clearInterval(timer);
      for (const d of wrapDisposers) {
        try { d(); } catch { /* ignore */ }
      }
      wrapDisposers.clear();
      // Clear the flag so the next apply may re-bind listeners; otherwise a reused ctx goes silent.
      delete ctx.__dshPurgeSessionHook;
      delete ctx.__dshPurgeAgentHook;
      delete ctx.__dshPurgePresetHook;
      delete ctx.__dshPurgePreStepHook;
      // [v10] AssembleHook must be cleared too. It was missed, so on ctx reuse a new apply saw flag=true
      // and skipped ctx.on("system-prompt/assemble", ...); no listener, so round one
      // of a new conversation to the 400ms setInterval guard alone — miss the window and inject is empty.
      delete ctx.__dshPurgeAssembleHook;
      // A new conversation / hot reload disposes before apply. Clearing the global hung here
      // makes an immediate send read an empty string during the gap, restored only by the next apply.
    });
  } catch { /* with no effect, rely on unref + self-overwrite on the next apply */ }
}

function shimNeedsPatch(state) {
  if (hostctl.currentSurface() === "desktop") return false;
  return (
    state.shim_cmd === "original" ||
    state.shim_ps1 === "original" ||
    state.shim_bin === "original"
  );
}

function currentSettleScope() {
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* not desktop, or no install dir yet */ }
  return { surface: hostctl.controlSurface(), sealed };
}

async function settleInstalledPatches(config, ctx, life) {
  if (life && !life.alive) return "skip:inactive";
  try { core.rememberUnpackedArchive(); } catch { /* no official install dir, no archive */ }
  try {
    reapply.ensureInstalledRevSeed();
  } catch (e) {
    log(config, "seed installed-rev failed:", String(e && e.message ? e.message : e));
  }
  try {
    if (reapply.healEmptyAppliedStamp()) log(config, "healed empty applied stamp");
  } catch (e) {
    log(config, "heal applied stamp failed:", String(e && e.message ? e.message : e));
  }

  if (config.autoApplyOnStart !== true) {
    try {
      if (await reapply.patchesMatchInstallStrict() || await reapply.hostCleanEnoughToKeep()) {
        reapply.markPatchesApplied();
        log(config, "boot: host files left untouched; stamp kept");
        return "boot:host-untouched";
      }
    } catch { /* no stamp is fine; wait for the user to click apply */ }
    log(config, "boot: skip host writes (Apply once)");
    return "skip:boot-no-host-write";
  }

  const scope = currentSettleScope();
  if (!(await reapply.patchesMatchInstallStrict())) {
    if (!settleMayReapply(scope)) {
      log(config, "sealed desktop: skip startup reapply (wait for Apply)");
      return "skip:sealed-wait-apply";
    }
    if (await reapply.hostCleanEnoughToKeep()) {
      reapply.markPatchesApplied();
      log(config, "host already clean; kept patches and refreshed stamp");
      return "already-clean";
    }
    if (officialUpdate.upgradeMarkerExists(process.execPath)) {
      const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, upgrade: true });
      if (life && !life.alive) return "skip:inactive";
      if (!upgraded.ok) {
        log(config, "official upgrade reapply failed:", upgraded.error || "");
        return "reapply-failed";
      }
      officialUpdate.clearUpgradeMarker(process.execPath);
      officialUpdate.clearStaleExtractedApps(process.execPath);
      if (!settleMayRestart(currentSettleScope()) || reapply.shouldSkipSettleRestart()) {
        if (upgraded.needsFullQuit) bootFullQuit = true;
        log(config, "official upgrade reapplied; skip settle restart");
        return "reapplied-no-restart";
      }
      reapply.markSettleRestart();
      log(config, "official upgrade reapplied; restarting onto the new build");
      // ctx may be disposed during reapply.reapplyInstalled's await; check again before restarting.
      if (life && !life.alive) return "skip:inactive";
      try {
        armSettleRestart(ctx);
      } catch (e) {
        log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
        return "restart-failed";
      }
      return "restarting";
    }

    // Startup self-heal only writes disk; no asar swap, no kill, avoiding INACTIVE_EFFECT in Fiber._reload.
    const result = await reapply.reapplyInstalled({ scheduleSwap: false });
    if (life && !life.alive) return "skip:inactive";
    if (!result.ok) {
      log(config, "reapply failed:", result.error || "");
      return "reapply-failed";
    }
    // After a successful reapply, force a non-empty stamp so the clean path cannot skip the write (#59/#60).
    try { reapply.markPatchesApplied(); } catch { /* ignore */ }
    if (result.needsFullQuit) {
      bootFullQuit = true;
      log(config, "reapply wrote patches; official host needs a full quit");
      return "full-quit";
    }
    if (!settleMayRestart(currentSettleScope())) {
      log(config, "reapply wrote patches; desktop settle does not restart");
      return "reapplied-no-restart";
    }
    if (reapply.shouldSkipSettleRestart()) {
      log(config, "reapply wrote patches; skip settle restart (cooldown)");
      return "reapplied-no-restart";
    }
    // Already aligned means no restart; restart once only while stamp/host still disagree.
    if (await reapply.patchesMatchInstallStrict()) {
      log(config, "reapply wrote patches; already aligned, no restart");
      return "reapplied";
    }
    reapply.markSettleRestart();
    log(config, "reapply wrote patches; restarting");
    // reapplyInstalled awaits internally; recheck life before restarting so no scheduleRestart hits it.
    if (life && !life.alive) return "skip:inactive";
    try {
      // web: self-heal restart opens no browser; a closed window is never relaunched (#59/#61).
      armSettleRestart(ctx);
    } catch (e) {
      log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }

  const applied = await autoApply(config);
  // Private pinned version: the startup path performs no update check and never goes online.
  return applied;
}

async function autoApply(config) {
  try {
    core.applyRuntimeEnv();
    const sanitized = core.sanitizeDesktopCommandRuntimes();
    if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

    const state = await core.gatherState();
    if (!state.ai_base) {
      log(config, "skip auto-apply: plugin root not found");
      return "skip:plugin_root_not_found";
    }
    try {
      const flash = core.silenceCmdFlash(state.ai_base);
      log(config, "cmd-flash:", JSON.stringify(flash));
      if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
    } catch (e) {
      log(config, "cmd-flash failed:", String(e));
    }

    if (state.patches_pending === 0) {
      if (config.autoApplyOnStart && shimNeedsPatch(state)) {
        await core.patchAllShims();
        core.silenceCmdFlash(state.ai_base);
        log(config, "auto-apply: patches clean, shim refreshed");
        return "already_clean:shim_patched";
      }
      log(config, "auto-apply: already clean");
      return "already_clean";
    }
    if (!config.autoApplyOnStart) {
      log(config, "auto-apply disabled");
      return "disabled";
    }
    const autoMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: true,
      llm: typeof ctx?.get === 'function' ? ctx.get('llm') : null,
    });
    await core.patchAllShims();
    const report = autoMulti.report;
    const flash = core.silenceCmdFlash(autoMulti.hosts[0]?.aiBase || state.ai_base);
    const applied = report.filter((r) => r.status === "applied").length;
    log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
    return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
  } catch (e) {
    console.warn("[de-policy] auto-apply error:", String(e));
    return `error:${e}`;
  }
}

/** Self-heal restart: spawn the assistant first, pause briefly, so it does not race startup HTTP. */
function armSettleRestart(ctx) {
  const planned = hostctl.scheduleRestart(null, ctx, { openBrowser: false });
  if (planned && planned.restarting) {
    setTimeout(() => hostctl.signalRestartGo(planned), 400);
  }
  return planned;
}

/** The restart after an apply. Quit and reopen the sealed bundle instead of waiting for the user. */
function scheduleApplyRestart(shouldRestart, ctx = null, surface = null) {
  if (!shouldRestart) return { restarting: false };
  const surf = surface || hostctl.controlSurface();
  let planned = null;
  if (surf === "desktop" && core.desktopAsarStillSealed()) {
    // Pass ctx to the core layer so a sealed-bundle restart also kills Electron via PowerShell,
    // on the double-safety path, with no more "host stopped" crash dialog (#64).
    planned = core.restartSealedDesktopIfNeeded({ ctx, surface: surf });
    planned = {
      ...(planned || {}),
      restarting: Boolean(planned && planned.restarting === true && planned.keptAlive !== true),
    };
  } else {
    try {
      planned = hostctl.scheduleRestart(null, ctx, { surface: surf });
      if (planned && (planned.restarting === false || planned.clean === false)) return planned;
      planned = planned || { restarting: true };
    } catch (error) {
      return { restarting: false, error: String(error && error.message ? error.message : error) };
    }
  }
  if (planned && planned.restarting) hostctl.signalRestartGo(planned);
  return planned;
}

async function handlePurgeCommand(rawInput, config, ctx = null) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "status").toLowerCase();

  switch (sub) {
    case "status":
    case "s": {
      const state = await core.gatherState();
      return { kind: "success", text: renderStatus(state) };
    }
    case "apply":
    case "a": {
      core.applyRuntimeEnv();
      if (hostctl.controlSurface() === "desktop") core.clearDesktopLocateCache();
      const home = core.pinDshHome();
      const scrubbed = core.sanitizeDesktopCommandRuntimes();
      const surface = hostctl.controlSurface();
      const state = await core.gatherState({ surface });
      if (home) state.dsh_home = home;
      let located;
      try {
        located = await core.resolveApplyAiBase(state.ai_base, { forApply: true, surface });
      } catch (e) {
        return { kind: "error", text: String(e && e.message ? e.message : e) };
      }
      if (!located.aiBase) return { kind: "error", text: core.missingAiBaseMessage() };
      state.ai_base = located.aiBase;
      if (located.extracted && located.handoff?.archive) {
        core.writeUnpackedAsarStamp(located.handoff.archive);
      }
      const blocked = rejectIfNeedPrompt(state.dsh_home);
      if (blocked) return { kind: "error", text: blocked.error };
      const applyMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
        preserveClientBundles: false,
        forApply: true,
        surface,
        // The endpoint gate needs the host's llm service to resolve which endpoint
        // the *selected* provider uses; without it the gate can only report unknown.
        llm: typeof ctx?.get === 'function' ? ctx.get('llm') : null,
      });
      const report = applyMulti.report;
      const shimResult = await core.patchAllShims();
      const flash = core.silenceCmdFlash(applyMulti.hosts[0]?.aiBase || state.ai_base);
      const lines = [];
      for (const h of applyMulti.hosts) lines.push(`  Host / host → ${h.aiBase}`);
      lines.push(...report.map((r) => {
        const m = r.status === "applied" ? "✓ đã sạch"
          : r.status === "already" ? "- đã mới nhất"
            : r.status === "missing_file" ? "⚠ thiếu tệp" : `✗ ${r.status}`;
        return `  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`;
      }));
      lines.push("", "shim:");
      for (const [dir, st] of Object.entries(shimResult)) {
        lines.push(`  · ${dir} → ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
      if (scrubbed.length) {
        lines.push("", "Desktop in-bin .bak scrub:");
        for (const row of scrubbed) lines.push(`  ✓ ${row.dir} → ${row.cleaned.join(", ")}`);
      }
      lines.push("Desktop: thư mục niêm phong host-commands chỉ dọn, không inject; "
        + "cấm ghi bak vào bin (issue #9).");
      const summary = core.summarizeApplyReport(report);
      const hostWritten = core.allPatchHostsWritten(applyMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
      const backupBlocked = (applyMulti.hosts || []).some((h) => Array.isArray(h.backupFailed) && h.backupFailed.length);
      const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !backupBlocked;
      const promptReady = core.failedAllowsPromptReady(summary.failed);
      const shouldRestart = complete === true;
      if (shouldRestart) reapply.markSettleRestart();
      try { core.seedPromptInjectAtBoot(state.dsh_home); } catch { /* the primary home is not ready yet */ }
      try { refreshHungOperator(state.dsh_home); } catch { /* ignore */ }
      try {
        const { ensureRedteamRuntime } = await import("./redteam/bootstrap-runtime.js");
        const rt = await ensureRedteamRuntime({ download: false, background: false, timeoutMs: 15000 });
        lines.push("", "Runtime redteam:");
        lines.push(`  Kho tri thức ${rt.knowledgePath} (${rt.pocs || 0} POC)`);
        const tplNote = rt.templatesDownloaded
          ? " đã tải"
          : (rt.templatesError ? ` ${rt.templatesError}` : "");
        lines.push(`  mẫu nuclei ${rt.templates || 0} → ${rt.templatesDir || ""}${tplNote}`);
      } catch (error) {
        lines.push("", "Runtime redteam: " + String(error && error.message ? error.message : error));
      }
      const planned = scheduleApplyRestart(shouldRestart, ctx);
      if (planned && planned.clean === false) {
        lines.push("", "Thanh lọc chưa ghi vào host hiện tại, đã huỷ khởi động lại.");
      } else if (planned && planned.restarting === false && planned.error) {
        lines.push("", String(planned.error));
      } else if (shouldRestart && planned && planned.restarting !== false) {
        lines.push("", "Đang khởi động lại.");
      } else if (!complete) {
        lines.push("", "Thanh lọc chưa xong, không khởi động lại.");
      } else {
        lines.push("", "Bản vá đã có trong host, không khởi động lại nữa.");
      }
      return { kind: "success", text: lines.join("\n") };
    }
    case "revert":
    case "r": {
      const state = await core.gatherState();
      const lines = [];
      {
        const { reverted, errors } = await core.revertAllHosts();
        lines.push(...reverted.map((p) => `  ✓ đã hoàn nguyên / Reverted ${p}`));
        for (const [p, e] of errors) lines.push(`  ⚠ hoàn nguyên thất bại ${p}: ${e}`);
        if (reverted.length === 0) lines.push("  - không có bản sao lưu để hoàn nguyên / no patch backup");
      }
      const shimRevert = await core.revertAllShims();
      for (const [dir, st] of Object.entries(shimRevert)) {
        lines.push(`  shim ${dir}: ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push("", "Hoàn nguyên xong / Revert done. Khởi động lại dsh để phục hồi.");
      lines.push("Lưu ý: prompt-inject.md được giữ lại (tệp người dùng) / kept (user file)");
      return { kind: "success", text: lines.join("\n") };
    }
    case "uninstall":
    case "remove": {
      const result = await uninstaller.uninstallPurge();
      const lines = [];
      if (result.applied) lines.push("Đã phát hiện bản vá, hoàn nguyên về bản gốc.");
      else lines.push("Không thấy bản vá nào được áp dụng, vẫn sẽ xoá tệp plugin.");
      if (result.patches) {
        lines.push(`  Tệp đã hoàn nguyên: ${result.patches.reverted?.length || 0}`);
      }
      if (result.override?.removed) lines.push(`  Đã xoá ${result.override.path}`);
      if (result.stripped?.length) lines.push(`  Đã gỡ khỏi profile: ${result.stripped.join(", ")}`);
      if (result.errors?.length) {
        for (const e of result.errors) lines.push(`  ⚠ ${e}`);
      }
      lines.push("", "Hãy khởi động lại dsh. Sau đó plugin không còn được nạp.");
      return { kind: result.ok ? "success" : "error", text: lines.join("\n") };
    }
    case "edit":
    case "e": {
      const state = await core.gatherState();
      let r = core.editOverride(state.dsh_home);
      let created = false;
      if (!r.ok && r.needCreate) {
        await core.installOverride(state.dsh_home, true);
        r = core.editOverride(state.dsh_home);
        created = true;
      }
      // Old: returned kind:"success" when r.ok was false, so users saw "opened" with no process.
      if (!r.ok) {
        return { kind: "error", text: r.error || "Không mở được trình soạn thảo" };
      }
      return {
        kind: "success",
        text: created
          ? `Đã tạo tệp inject mặc định và mở trình soạn thảo: ${r.path}\nKhởi động lại dsh để áp dụng.`
          : `Đã mở ${r.editor} để sửa tệp inject: ${r.path}\nSửa xong thì khởi động lại dsh.`,
      };
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "Lệnh de-policy:\n" +
          "  /purge status     xem trạng thái\n" +
          "  /purge apply      áp dụng toàn bộ thanh lọc (prompt + code + shim + override)\n" +
          "  /purge revert     hoàn nguyên\n" +
          "  /purge uninstall  gỡ plugin (đã áp dụng thì hoàn nguyên trước)\n" +
          "  /purge edit       sửa tệp inject prompt-inject.md\n" +
          "  /purge help       hiện trợ giúp\n" +
          "Chuyển bộ luật xem /rules (list | use <id> | create | delete | reset)\n" +
          "Cài Skill chính thức xem /skills (list | import <đường dẫn> | create <id> [mô tả] | delete <id>)",
      };
  }
}

function renderRulesStatus(st) {
  const out = [];
  out.push("Bộ luật / Rule Sets");
  out.push(`  Thư mục lưu / store  ${st.rules_dir}`);
  const targetLine = st.active
    ? `${st.agents_path} (${st.active_target})`
    : "(không có kích hoạt)";
  out.push(`  Tệp đích / target ${targetLine} — exists=${st.agents_exists}, synced=${st.agents_synced}`);
  out.push("");
  if (st.rules.length === 0) {
    out.push("  (chưa có luật / no rules — dùng /rules create <id> hoặc tạo ở trang cài đặt)");
  }
  for (const r of st.rules) {
    const isActive = r.id === st.active;
    const label = r.name !== r.id ? `${r.name} (${r.id})` : r.id;
    out.push(`  ${isActive ? "▶" : "·"} ${label}${isActive ? " ★ hiện tại" : ""} `
      + `[${r.target}] (${rules.formatSize(r.size)})`);
  }
  return out.join("\n");
}

async function handleRulesCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderRulesStatus(await rules.rulesStatus(dshHome)) };
    case "use":
    case "activate":
    case "u": {
      const id = args[1];
      if (!id) return { kind: "error", text: "Cách dùng: /rules use <id>" };
      try {
        const meta = await rules.activateRule(dshHome, id);
        refreshHungOperator(dshHome);
        return {
          kind: "success",
          text: `✓ Đã kích hoạt luật ${meta.name} (${id}) → ghi `
            + `${rules.targetPath(dshHome, meta.target)} và inject systemPrompt. `
            + "Có hiệu lực ở phiên mới.",
        };
      } catch (e) {
        return { kind: "error", text: `Kích hoạt thất bại: ${e.message}` };
      }
    }
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "Cách dùng: /rules create <id> [bí danh] [AGENTS.md|CLAUDE.md]" };
      const name = args[2] || id;
      const target = args[3] || "AGENTS.md";
      if (!rules.validTarget(target)) {
        return { kind: "error", text: `Đích không hợp lệ: ${target} (chỉ được là AGENTS.md hoặc CLAUDE.md)` };
      }
      try {
        await rules.saveRule(dshHome, id, "", { name, target });
        return {
          kind: "success",
          text: `✓ Đã tạo luật ${name} (${id} → ${target}). Sửa nội dung ở trang cài đặt mục "Bộ luật" rồi lưu.`,
        };
      } catch (e) {
        return { kind: "error", text: `Tạo thất bại: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "Cách dùng: /rules delete <id>" };
      try {
        await rules.deleteRule(dshHome, id);
        refreshHungOperator(dshHome);
        return { kind: "success", text: `✓ Đã xoá luật ${id}.` };
      } catch (e) {
        return { kind: "error", text: `Xoá thất bại: ${e.message}` };
      }
    }
    case "reset":
    case "restore":
    case "还原": { // keep the Chinese alias: it is a command word users may type

      try {
        const r = await rules.resetToOriginal(dshHome);
        refreshHungOperator(dshHome);
        const lines = [];
        if (r.removed.length > 0) lines.push(`✓ Đã xoá tệp đích do plugin ghi: ${r.removed.join(", ")}`);
        if (r.skipped.length > 0) {
          lines.push(`⚠ Bỏ qua (nội dung tệp khác luật, có thể bị sửa tay): ${r.skipped.join(", ")}`);
        }
        lines.push("Đã xoá trạng thái kích hoạt. Nội dung kho luật vẫn giữ, có thể kích hoạt lại "
          + "bất cứ lúc nào. Hiện về trạng thái gốc: không có chỉ dẫn toàn cục.");
        return { kind: "success", text: lines.join("\n") };
      } catch (e) {
        return { kind: "error", text: `Hoàn nguyên thất bại: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "Lệnh bộ luật:\n" +
          "  /rules list                         liệt kê mọi luật\n" +
          "  /rules use <id>                     kích hoạt (ghi AGENTS.md/CLAUDE.md và inject systemPrompt)\n" +
          "  /rules create <id> [bí danh] [đích] tạo luật mới\n" +
          "  /rules delete <id>                  xoá luật\n" +
          "  /rules reset                        hoàn nguyên trạng thái gốc\n" +
          "  /rules help                         hiện trợ giúp",
      };
  }
}

function renderSkillsStatus(st) {
  const out = [];
  out.push("Skill người dùng chính thức / $DSH_HOME/skills");
  out.push(`  ${st.skills_dir}`);
  out.push("  Plugin chỉ cài thư mục. Gọi thì đi qua kênh chính thức: khi tác vụ khớp "
    + "description/whenToUse, model gọi công cụ skill; gõ /tên trong chat thì nạp ngay.");
  out.push("  Viết \"kích hoạt\" trong nội dung không có tác dụng. Kênh chính thức đọc name, "
    + "description, whenToUse, disable-model-invocation, user-invocable.");
  out.push("");
  if (!st.skills.length) {
    out.push("  (chưa có Skill người dùng — dùng /skills import <tệp nén hoặc thư mục> "
      + "hoặc import ở trang cài đặt)");
    return out.join("\n");
  }
  for (const item of st.skills) {
    const mark = item.valid ? "·" : "!";
    const desc = item.description || "(không có mô tả)";
    const how = item.valid
      ? [
        item.userInvocable ? `/${item.id}` : "không gọi được /tên",
        item.modelInvocable ? "model gọi được" : "model không gọi được",
      ].join(" · ")
      : "";
    out.push(`  ${mark} ${item.id}  ${desc}  (${skills.formatSize(item.size)})`);
    if (how) out.push(`      ${how}`);
    if (!item.valid && item.error) out.push(`      ${item.error}`);
  }
  return out.join("\n");
}

async function handleSkillsCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderSkillsStatus(await skills.skillsStatus(dshHome)) };
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "Cách dùng: /skills create <id> [mô tả]" };
      if (!skills.validSkillName(id)) {
        return { kind: "error", text: "id phải ở dạng kebab-case, ví dụ code-review" };
      }
      const description = args.slice(2).join(" ").trim() || id;
      try {
        const saved = skills.toPublicSkill(dshHome, await skills.saveSkill(dshHome, id, "", description));
        return {
          kind: "success",
          text: `✓ Đã ghi vào thư mục chính thức ${saved.path}\n`
            + `Phiên mới sẽ vào thư mục Skill chính thức; khi tác vụ khớp hoặc gõ /${id} `
            + "thì kênh chính thức nạp.",
        };
      } catch (e) {
        return { kind: "error", text: `Cài thất bại: ${e.message}` };
      }
    }
    case "import":
    case "i": {
      const src = args.slice(1).join(" ").trim();
      if (!src) return { kind: "error", text: "Cách dùng: /skills import <tệp nén hoặc thư mục>" };
      try {
        const packed = await skills.importFromPath(dshHome, src);
        const names = packed.imported.map((item) => item.id).join(", ");
        return { kind: "success", text: `✓ Đã import vào $DSH_HOME/skills chính thức: ${names}` };
      } catch (e) {
        return { kind: "error", text: `Import thất bại: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "Cách dùng: /skills delete <id>" };
      try {
        const removed = skills.toPublicSkill(dshHome, await skills.deleteSkill(dshHome, id));
        return {
          kind: "success",
          text: `✓ Đã xoá khỏi thư mục chính thức ${id}`
            + (removed.backup ? `\nBản sao lưu: ${removed.backup}` : ""),
        };
      } catch (e) {
        return { kind: "error", text: `Xoá thất bại: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "Cài Skill chính thức:\n" +
          "  /skills list                 liệt kê $DSH_HOME/skills\n" +
          "  /skills create <id> [mô tả]  ghi <id>/SKILL.md\n" +
          "  /skills import <đường dẫn>   import tệp nén hoặc thư mục vào thư mục chính thức\n" +
          "  /skills delete <id>          xoá thư mục đó (kênh chính thức cũng bỏ ra)\n" +
          "  cũng có thể tự xoá $DSH_HOME/skills/<id>\n" +
          "  gọi: gõ /<id> trong chat, hoặc để model gọi công cụ skill theo description\n" +
          "  không inject systemPrompt, không thay thế prompt",
      };
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) {
    purgeLog("boot", { enabled: false });
    return;
  }
  purgeLog("boot", {
    enabled: true,
    surface: hostctl.currentSurface(),
    stripMnemon: cfg.stripMnemon !== false,
    cap: cfg.capabilityProtocol !== false,
  });
  try { stripProxyEnv(); } catch { /* nothing to clear when no proxy vars are set */ }
  try { detachWindowsConsole(); } catch { /* nothing to detach when no console is attached */ }
  if (hostctl.currentSurface() === "desktop") {
    // The official GUI fetches loopback right after Host ready; no sync writes / PowerShell here.
    setImmediate(() => {
      try {
        const hide = core.healOfficialHostSpawnHideOnDisk();
        if (hide && hide.length) purgeLog("heal-host-spawn-hide", { files: hide });
      } catch { /* desktop not installed or file in use */ }
      try {
        const bind = core.healOfficialDesktopHostBindOnDisk();
        if (bind && bind.length) purgeLog("heal-host-bind-lan", { files: bind });
      } catch { /* desktop not installed or file in use */ }
      try {
        const healed = core.healDuplicateDesktopHandoffOnDisk();
        if (healed && healed.length) purgeLog("heal-desktop-handoff", { files: healed });
      } catch { /* desktop not installed or file in use */ }
      try {
        const office = core.healOfficeSkillsRuntimeOnDisk();
        if (office && office.healed) purgeLog("heal-office-skills", office);
      } catch { /* desktop not installed or runtime dir not writable */ }
    });
  } else {
    // When the desktop Host crashed before plugin load, the desktop surface never ran. On CLI/Web start
    // it also scans: light in a non-desktop process, and it can revive a desktop that never boots again.
    setImmediate(() => {
      try {
        const bind = core.healOfficialDesktopHostBindOnDisk();
        if (bind && bind.length) purgeLog("heal-host-bind-lan-cli", { files: bind });
      } catch { /* desktop not installed or file in use */ }
    });
  }
  try {
    const home = core.pinDshHome() || core.findDshHome();
    purgeLog("home", { home: home || "(none)" });
    try {
      if (home) {
        const flag = path.join(home, ".hung-disabled");
        if (fs.existsSync(flag)) {
          fs.unlinkSync(flag);
          purgeLog("hung-disabled", { removed: flag });
        }
      }
    } catch (e) { purgeLog("hung-disabled", { err: String(e?.message || e) }); }
    syncHungPromptGlobal();
    // After a successful Apply→cleanup→restart, seed the encrypted prompt into prompt-inject.md by default.
    // Files the user already edited stay untouched; write only when absent or still an empty file.
    try {
      const seed = core.seedPromptInjectAtBoot(home);
      log(cfg, "seed prompt-inject:", seed?.action || "noop", seed?.reason || "");
    } catch (e) {
      console.warn("[de-policy] seed prompt-inject failed:", String(e && e.message ? e.message : e));
    }
    refreshHungOperator(home);
  } catch { /* without a primary home, assembly falls back to the built-in default */ }
  // Startup does not write the host package. Patch / bak / client.js / runtime are written once on "apply".
  const life = watchContextLife(ctx);
  if (!life.alive) {
    console.warn("[de-policy] skip apply: inactive context");
    return;
  }
  log(cfg, "plugin enabled");
  core.applyRuntimeEnv();
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* without a primary home, assembly falls back to the built-in default */ }

  const settleTimer = setTimeout(() => {
    if (!life.alive) {
      log(cfg, "settle skipped: inactive context");
      return;
    }
    settleInstalledPatches(cfg, ctx, life)
      .then((r) => log(cfg, "settle:", r))
      .catch((e) => {
        if (isInactiveContextError(e)) {
          log(cfg, "settle skipped: inactive context");
          return;
        }
        console.warn("[de-policy] settle error:", String(e));
      });
    rules.ensureInitialState(core.findDshHome())
      .then((r) => log(cfg, "rules init:", JSON.stringify(r)))
      .catch((e) => console.warn("[de-policy] rules init error:", String(e)));
  }, settleDelayMs(hostctl.controlSurface()));
  try {
    ctx.effect(() => () => clearTimeout(settleTimer));
  } catch (e) {
    if (isInactiveContextError(e)) {
      clearTimeout(settleTimer);
      purgeLog("apply", { skip: "inactive" });
      return;
    }
    purgeLog("apply", { effect_err: String(e?.message || e) });
  }

  try {
    applyHostHooks(ctx, cfg);
  } catch (e) {
    if (isInactiveContextError(e)) {
      purgeLog("apply", { skip: "inactive" });
      return;
    }
    purgeLog("apply-hooks", { err: String(e?.message || e) });
  }
}

function applyHostHooks(ctx, cfg) {
  const hook = (name, fn) => {
    try {
      fn();
    } catch (e) {
      if (isInactiveContextError(e)) throw e;
      purgeLog("hook", { name, err: String(e?.message || e) });
    }
  };
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* the primary home is not ready yet */ }
  hook("identity", () => installIdentityOverride(ctx, cfg));
  hook("region", () => installRegionGate(ctx));
  hook("fresh-access", () => installFreshFullAccess(ctx));
  hook("cwd", () => installCwdCapture(ctx));
  hook("mnemon", () => installMnemonMessageStrip(ctx, cfg));
  hook("prompt-sections", () => registerPromptSections(ctx, cfg));
  hook("prompt-anchors", () => registerAnchor(ctx, cfg));
  hook("subagent-control", () => installSubagentControl(ctx, cfg));
  hook("tool-gate", () => installToolGateBypass(ctx, cfg));
  try {
    ctx.effect(() => {
      // Register when the effect actually installs, so a failed registration never leaks the owner count.
      const releaseHold = coreHoldOwnedPresetAlive();
      return () => {
        releaseHold();
        // Do not clear selectedDefault during teardown: a patchReload: live hot reload also disposes,
        // which would reset the user's "redteam mode" dropdown default back to standard on every reload.
        try { scheduleOwnedSelectedDefaultSweep({ ctx, dshHome: core.findDshHome() }); } catch { /* safe */ }
      };
    });
  } catch { /* with no effect, rely on the redteam disposer / uninstall to clear */ }

  // Continue-retry state scoped to this apply; disposing the old ctx takes these closures along.
  const continuePluginCfg = cfg;
  const savedContinueSettings = continueRetry.loadSettings(core.findDshHome());
  const continueRuntime = continueRetry.installContinueRetry(ctx, {
    getConfig: () => continueRetry.mergeConfig(continuePluginCfg, savedContinueSettings),
  });
  try {
    ctx.effect(() => () => {
      try { continueRuntime?.dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* with no effect, the cordis scope reclaims it */ }

  hook("commands", () => {
  const commands = ctx.get?.("commands");
  if (commands) {
    commands.register({
      name: "purge",
      description: "dsh instruction-authority purge (status/apply/revert/uninstall/edit/help)",
      input: { hint: "status | apply | revert | uninstall | edit | help" },
      handler: async (invocation) => handlePurgeCommand(invocation.rawInput ?? "", cfg, ctx),
    });
    commands.register({
      name: "rules",
      description: "Rule-set switching (writes AGENTS.md/CLAUDE.md): list | use <id> | "
        + "create <id> [alias] [target] | delete <id> | reset | help",
      input: { hint: "list | use <id> | create <id> [alias] [target] | delete <id> | reset | help" },
      handler: async (invocation) => handleRulesCommand(invocation.rawInput ?? ""),
    });
    commands.register({
      name: "skills",
      description: "Official user Skill ($DSH_HOME/skills): list | import <path> | "
        + "create <id> [description] | delete <id> | help",
      input: { hint: "list | import <path> | create <id> [description] | delete <id> | help" },
      handler: async (invocation) => handleSkillsCommand(invocation.rawInput ?? ""),
    });
    commands.register({
      name: "rewind",
      description: "Rewind: withdraw the turn already sent; the official fork starts a new "
        + "Session with the prior context; resending the line re-injects it",
      input: { hint: "once | round" },
      handler: async (invocation) => {
        const sessionId = rewind.invocationSessionId(invocation);
        const arg = String(invocation.rawInput || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
        const info = await rewind.analyzeRewind(ctx, sessionId);
        if (info.ok && info.kind === "main" && arg !== "once" && arg !== "round") {
          return {
            kind: "success",
            text: "Main agent, choose: /rewind once withdraws one step, /rewind round withdraws "
              + "the whole turn (subagents included). The conversation is undone, the new Session "
              + "continues from the prior context, and the line goes back to the input box.",
          };
        }
        const mode = arg === "round" ? "round" : "once";
        const result = await rewind.applyRewind(ctx, sessionId, mode);
        if (!result.ok) return { kind: "error", text: result.error };
        return {
          kind: "success",
          text: mode === "round"
            ? "Withdrew the whole previous turn. The new Session continues from the prior "
              + "context, the line is back in the input box, resending re-injects it."
            : "Withdrew the previous step. The new Session continues from the prior context, "
              + "the line is back in the input box, resending re-injects it.",
        };
      },
    });
  }
  });

  hook("tools", () => {
  if (ctx.tools) {
    ctx.tools.register({
      name: "purge_status",
      description: `Show the dsh instruction-authority purge status (progress of `
        + `${core.ALL_PATCHES.length} patches, shim injection, override file).`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        return { text: renderStatus(state) };
      },
    });
    ctx.tools.register({
      name: "purge_apply",
      description: `Apply the dsh instruction-authority purge: ${core.ALL_PATCHES.length} patches `
        + "(prompt layer + code defaults + engine-level approval/sandbox bypass) + shim injection "
        + "+ override file. A dsh restart is needed for full effect.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        core.applyRuntimeEnv();
        const scrubbed = core.sanitizeDesktopCommandRuntimes();
        const state = await core.gatherState();
        if (!state.ai_base) return { text: "ERROR: " + core.missingAiBaseMessage() };
        const blocked = rejectIfNeedPrompt(state.dsh_home);
        if (blocked) return { text: "ERROR: " + blocked.error };
        const toolMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
          preserveClientBundles: false,
          forApply: true,
        });
        await core.patchAllShims();
        const flash = core.silenceCmdFlash(toolMulti.hosts[0]?.aiBase || state.ai_base);
        const report = toolMulti.report;
        const applied = report.filter((r) => r.status === "applied").length;
        const already = report.filter((r) => r.status === "already").length;
        const scrubNote = scrubbed.length ? ` desktop_scrub=${scrubbed.length}` : "";
        return { text: `Purge done / applied=${applied}, already=${already}.${scrubNote} `
          + `phase-1=${flash.phase1} restart dsh to apply.` };
      },
    });
    ctx.tools.register({
      name: "purge_revert",
      description: "Revert the dsh instruction-authority purge to the backed-up originals "
    + "(keeps the prompt-inject.md user file).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        const lines = [];
        {
          const { reverted, errors } = await core.revertAllHosts();
          lines.push(`reverted=${reverted.length}${errors.length ? ` errors=${errors.length}` : ""}`);
        }
        const shimRevert = await core.revertAllShims();
        lines.push(`shim_dirs=${Object.keys(shimRevert).length}`);
        return { text: `Revert done / ${lines.join(", ")}. restart dsh to restore.` };
      },
    });
  }
  });

  hook("web", () => installWebServer(ctx, cfg));
}

function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function denyCrossOrigin(response) {
  response.writeHead(403, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, error: "cross-origin blocked" }));
}

function hostPort(host) {
  const raw = String(host || "").trim().toLowerCase();
  if (!raw) return { name: "", port: "" };
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    const name = end >= 0 ? raw.slice(1, end) : raw;
    const port = end >= 0 && raw[end + 1] === ":" ? raw.slice(end + 2) : "";
    return { name, port };
  }
  const i = raw.lastIndexOf(":");
  if (i > 0 && raw.indexOf(":") === i) return { name: raw.slice(0, i), port: raw.slice(i + 1) };
  return { name: raw, port: "" };
}

function isLoopbackName(name) {
  const n = String(name || "").replace(/^\[|\]$/g, "");
  return n === "localhost" || n === "127.0.0.1" || n === "::1" || n === "0.0.0.0";
}

/** Is the connection local (remote is non-loopback when desktop is reached over a LAN address). */
function isSelfAddress(addr) {
  const norm = String(addr || "").replace(/^::ffff:/i, "");
  if (!norm) return false;
  if (norm === "127.0.0.1" || norm === "::1" || norm === "::" || norm === "0.0.0.0") return true;
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it && String(it.address || "").replace(/^::ffff:/i, "") === norm) return true;
      }
    }
  } catch { /* when no interface can be read, accept loopback only */ }
  return false;
}

function hostsAlign(originHost, requestHost) {
  const a = hostPort(originHost);
  const b = hostPort(requestHost);
  if (!a.name || !b.name) return false;
  if (a.name === b.name && a.port === b.port) return true;
  return isLoopbackName(a.name) && isLoopbackName(b.name) && a.port === b.port;
}

function applyCorsHeaders(request, headers) {
  const origin = headerOf(request, "origin").trim();
  if (!origin || origin === "null") return headers;
  try {
    const originHost = new URL(origin).host;
    const host = headerOf(request, "host").trim();
    if (hostsAlign(originHost, host) || isLoopbackName(hostPort(originHost).name)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers.vary = "Origin";
    }
  } catch { /* no CORS added when Origin is not a URL */ }
  return headers;
}

function allowPluginRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  const origin = headerOf(request, "origin").trim();
  const host = headerOf(request, "host").trim();
  // Mac Safari often marks localhost / 127.0.0.1 as cross-site, and POSTs may carry Origin: null.
  // The plugin binds only to local loopback, so a loopback Host is allowed.
  if (host && isLoopbackName(hostPort(host).name)) return true;
  /* On desktop the LAN address makes Host non-loopback; the connection is local, Origin app:// or none,
     so origin comparison is meaningless, allow it. `null` is not allowed (sandboxed iframes send it too). */
  if (isSelfAddress(request && request.socket && request.socket.remoteAddress)
    && (!origin || /^(app|file|blob|data|about|chrome-extension|moz-extension|tauri|capacitor|ionic):/i.test(origin))) {
    return true;
  }
  if (!origin || origin === "null") {
    if (site === "cross-site") {
      denyCrossOrigin(response);
      return false;
    }
    return true;
  }
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  if (host && hostsAlign(originHost, host)) return true;
  denyCrossOrigin(response);
  return false;
}

function installWebServer(ctx, cfg) {
  // Desktop embeds @deepseek-ai/dsh-web-app, so settings also use webServer (often 43120), not just dsh web.
  watchWebTreeReady(ctx);
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // Collect the unregister disposer of every sub-route so host.effect cleanup removes them all at once.
      // Old versions registered without collecting, so a reload left previous handlers stacked beneath.
      const routeDisposers = [];
      const trackRoute = (d) => {
        if (typeof d === "function") routeDisposers.push(d);
        return d;
      };
      const registerPluginRoute = (spec, label) => trackRoute(host.webServer.register({
        ...spec,
        handler: async (request, response) => {
          if (!allowPluginRequest(request, response)) return;
          const origWriteHead = response.writeHead.bind(response);
          response.writeHead = (status, headers) => origWriteHead(status, applyCorsHeaders(request, { ...(headers || {}) }));
          return spec.handler(request, response);
        },
      }, label));
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            if (!lastStatusPayload) {
              const diskApply = reapply.consumeLastApply();
              if (diskApply) lastStatusPayload = { ...diskApply, fromApply: true };
            }
            if (applyInFlight || !webTreeReady) {
              sendJson(response, 200, {
                ...(lastStatusPayload || {
                  patches_total: 0,
                  patches_applied: 0,
                  patch_status: {},
                  shim_cmd: "n/a",
                  shim_ps1: "n/a",
                  shim_bin: "n/a",
                  has_backup: false,
                }),
                ok: true,
                ready: webTreeReady,
                applying: applyInFlight,
              });
              return;
            }
            if (lastStatusPayload && lastStatusPayload.fromApply === true) {
              sendJson(response, 200, {
                ...lastStatusPayload,
                ok: lastStatusPayload.ok !== false,
                ready: true,
                applying: false,
              });
              return;
            }
            const surface = hostctl.requestedSurface(request);
            const processSurface = hostctl.currentSurface();
            const state = await core.gatherState({ surface });
            const patch_names = {};
            for (const p of core.ALL_PATCHES) patch_names[String(p.id)] = p.name;
            const payload = {
              ok: true,
              ready: true,
              applying: false,
              surface,
              control_surface: surface,
              process_surface: processSurface,
              ai_base: state.ai_base,
              desktop_install: state.desktop_install || "",
              desktop_exe: state.desktop_exe || "",
              asar_still_sealed: state.asar_still_sealed || false,
              web_no_package: Boolean(state.web_no_package),
              missing_ai_base: (state.ai_base || state.web_no_package) ? "" : core.missingAiBaseMessage(),
              patches_applied: state.ai_base ? (state.display_applied ?? state.patches_applied) : 0,
              patches_pending: state.display_pending ?? state.patches_pending,
              patches_skipped: state.display_skipped ?? state.patches_skipped ?? 0,
              patches_ready: state.display_ready ?? state.patches_ready ?? 0,
              patches_na: state.patches_na || 0,
              patches_total: state.ai_base ? (state.display_total ?? state.patches_total ?? 0) : 0,
              patches_lost: reapply.patchesLostAfterHostReset(),
              patch_status: state.patch_status,
              patches: (state.display_patches || []).map((p) => ({
                id: p.id,
                ids: p.ids,
                layer: p.layer || "",
                status: p.status,
                title: p.title || "",
              })),
              patch_names,
              shim_cmd: state.shim_cmd,
              shim_ps1: state.shim_ps1,
              shim_bin: state.shim_bin,
              has_backup: state.has_backup,
              override_status: state.override_status,
              override_path: state.override_path,
              dsh_home: state.dsh_home,
              plugin_version: updater.localVersion(),
              boot_full_quit: bootFullQuit,
              // Private pinned version: no update status or channel exposed.
              sealed: true,
              system_field_extracted: (() => {
                try {
                  const fp = require("path").join(
                    require("@deepseek-ai/dsh-agent-loop")?.__dirname || "",
                    "lib", "index.js"
                  );
                  if (!require("fs").existsSync(fp)) return false;
                  const src = require("fs").readFileSync(fp, "utf8");
                  return src.includes("systemParts") && src.includes("nonSystemMessages");
                } catch { return false; }
              })(),
              ...(applyInFlight
              ? { skills: [] }
              : await skills.skillsStatus(core.findDshHome()).catch(() => ({ skills: [] }))),
            };
            lastStatusPayload = payload;
            sendJson(response, 200, payload);
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "de-policy: status");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/last-user",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.readLastUserText(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "de-policy: last user");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/rewind/options",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.analyzeRewind(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "de-policy: rewind options");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/rewind",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const url = new URL(request.url, "http://127.0.0.1");
              const sessionId = url.searchParams.get("sessionId");
              if (sessionId) {
                const draft = rewind.takeDraft(sessionId);
                sendJson(response, 200, { ok: true, ...(draft || {}) });
                return;
              }
              const pending = rewind.getPending();
              sendJson(response, 200, { ok: true, ...(pending || {}) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const sessionId = String(body?.sessionId || "").trim();
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "Cần sessionId" });
                return;
              }
              const mode = body?.mode === "round" ? "round" : "once";
              const result = await rewind.applyRewind(ctx, sessionId, mode);
              try { refreshHungOperator(core.findDshHome()); } catch { /* next send uses disk prompt */ }
              purgeLog("http.rewind", { mode, ok: result.ok, child: String(result.sessionId || "").slice(0, 8) });
              sendJson(response, result.ok ? 200 : 409, result);
            } catch (e) {
              purgeLog("http.rewind", { err: String(e && e.message ? e.message : e) });
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "de-policy: rewind");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/apply",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          applyInFlight = true;
          let holdApplyLock = false;
          try {
            await new Promise((resolve) => setImmediate(resolve));
            const body = await readJsonBody(request, 8 * 1024 * 1024);
            const incoming = typeof body?.content === "string" ? body.content : null;
            const surface = hostctl.requestedSurface(request, body);
            core.applyRuntimeEnv();
            if (surface === "desktop") core.clearDesktopLocateCache();
            const home = core.pinDshHome();
            try { core.seedPromptInjectAtBoot(home); } catch { /* write on commit */ }
            const scrubbed = core.sanitizeDesktopCommandRuntimes();
            const blocked = rejectIfNeedPrompt(home, incoming === null ? undefined : incoming);
            if (blocked) {
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 400, {
                ok: false,
                needPrompt: true,
                override_content: incoming || "",
                defaultContent: ui.defaultContent,
                ...blocked,
              });
              return;
            }
            try {
              await core.commitOverrideOnApply(home, incoming);
            } catch (e) {
              console.warn("[de-policy] apply override:", String(e && e.message ? e.message : e));
            }
            const payload = await executePurgeApply({ incoming, home, scrubbed, surface });
            lastStatusPayload = { ...payload, fromApply: true };
            sendJson(response, 200, payload);
            void import("./redteam/bootstrap-runtime.js").then((mod) => (
              mod.ensureRedteamRuntime({ download: false, background: true, timeoutMs: 15000 })
            )).catch(() => {});
          } catch (e) {
            purgeLog("http.apply", { err: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          } finally {
            if (!holdApplyLock) applyInFlight = false;
          }
        },
      }, "de-policy: apply");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/revert",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const surface = hostctl.requestedSurface(request);
            const state = await core.gatherState({ surface });
            const result = {};
            {
              const { reverted, errors } = await core.revertAllHosts({ surface });
              result.reverted = reverted.length;
              result.errors = errors.length;
            }
            result.shim = await core.revertAllShims();
            sendJson(response, 200, { ok: true, ...result,
              note: "khởi động lại dsh để phục hồi; prompt-inject.md được giữ lại" });
            purgeLog("http.revert", { reverted: result.reverted, errors: result.errors });
          } catch (e) {
            purgeLog("http.revert", { err: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "de-policy: revert");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/uninstall",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const surface = hostctl.requestedSurface(request);
            const result = await uninstaller.uninstallPurge();
            purgeLog("http.uninstall", { ok: result.ok, surface });
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface,
              fullApp: surface === "desktop",
              note: result.ok ? hostctl.restartNote(surface) : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      }, "de-policy: uninstall");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/drill-grant",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, ...readDrillGrant(home) });
            return;
          }
          if (request.method === "POST") {
            sendJson(response, 200, { ok: true, ...writeDrillGrant(home) });
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "de-policy: drill-grant");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/override",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const home = core.findDshHome();
              // Panel opens override: seed the encrypted default, keep user edits.
              try { core.seedPromptInjectAtBoot(home); } catch { /* ignore */ }
              refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, { ok: true, ...ui, ...injectSnapshot(home), system_field_extracted: true });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const home = core.findDshHome();
              const blocked = rejectIfNeedPrompt(home, content);
              if (blocked) {
                sendJson(response, 400, {
                  ok: false,
                  content,
                  ...blocked,
                });
                return;
              }
              const saved = await core.saveOverrideContent(home, content);
              purgeLog("http.override.save", {
                bytes: content.length,
                customized: saved.customized,
                explicit: saved.explicitSave,
              });
              try { refreshHungOperator(home); } catch { /* refresh failure keeps disk */ }
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, {
                ok: true,
                content: saved.content,
                defaultContent: saved.defaultContent,
                customized: ui.customized,
                usingDefault: ui.usingDefault,
                path: ui.path,
                ...injectSnapshot(home),
                system_field_extracted: true,
              });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "de-policy: override");
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/own-servers",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, content: readAllowText(home) });
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const saved = await writeAllowText(home, content);
              sendJson(response, 200, { ok: true, content: saved.text, dropped: saved.dropped });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "de-policy: own-servers");
      trackRoute(installRulesHttp(host.webServer));
      trackRoute(installSkillsHttp(host.webServer));
      registerPluginRoute({
        kind: "exact",
        path: "/de-policy/restart",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            try { reapply.consumeLastApply(); } catch { /* ignore */ }
            lastStatusPayload = null;
            const body = await readJsonBody(request);
            const ready = await ensureRestartReady();
            if (!ready.ok) {
              bootFullQuit = false;
              purgeLog("http.restart", { ok: false, pending: (ready.pending || []).join(",") });
              sendJson(response, 200, {
                ok: false,
                error: ready.error || "Thanh lọc chưa hoàn tất, đã huỷ khởi động lại",
                restarting: false,
                pending: ready.pending || [],
              });
              return;
            }
            const surface = hostctl.requestedSurface(request, body);
            purgeLog("http.restart", { surface, ua: String(request?.headers?.["user-agent"] || "").slice(0, 80) });
            lastStatusPayload = null;
            let planned = null;
            // Desktop restart touches desktop; browser restart only web. Never both.
            if (surface === "desktop" && core.desktopAsarStillSealed()) {
              planned = core.restartSealedDesktopIfNeeded({ ctx, surface });
            } else {
              planned = hostctl.scheduleRestart(request, ctx, { surface });
            }
            if (planned && planned.clean === false) {
              bootFullQuit = false;
              sendJson(response, 200, {
                ok: false,
                error: "Thanh lọc chưa ghi vào host hiện tại, đã huỷ khởi động lại",
                restarting: false,
              });
              return;
            }
            // Already restarted: drop the sticky flag, no re-refresh and no second prompt.
            bootFullQuit = false;
            const restarting = Boolean(planned && (planned.restarting || planned.asarSwap));
            const restartError = planned && planned.error ? String(planned.error) : "";
            const payload = {
              ok: restarting || !restartError,
              surface,
              fullApp: surface === "desktop",
              restarting,
              already: Boolean(planned && planned.already),
              needsFullQuit: Boolean(planned && planned.asarSwap),
              asar_still_sealed: core.desktopAsarStillSealed(),
              error: restartError || undefined,
              note: restarting ? "Đang khởi động lại." : restartError,
            };
            response.writeHead(200, {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
            });
            response.end(JSON.stringify(payload), () => {
              if (restarting) hostctl.signalRestartGo(planned);
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "de-policy: restart");
      return () => {
        for (let i = routeDisposers.length - 1; i >= 0; i -= 1) {
          try { routeDisposers[i](); } catch { /* ignore */ }
        }
        routeDisposers.length = 0;
      };
    }, "de-policy: http routes");
  });
}

function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(", ") });
  response.end();
  return true;
}

async function handleRulesOp(op, body, queryId, queryCwd) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  const cwdHint = typeof body?.cwd === "string" && body.cwd.trim()
    ? body.cwd.trim()
    : (typeof queryCwd === "string" && queryCwd.trim() ? queryCwd.trim() : "");
  if (cwdHint) {
    try { rules.writeLastCwd(dshHome, cwdHint); } catch { /* ignore */ }
  }
  if (op === "status") {
    return { ok: true, ...(await rules.rulesStatus(dshHome, cwdHint)) };
  }
  if (op === "scan-cwd" || op === "scan") {
    const effective = cwdHint || rules.readLastCwd(dshHome);
    const candidates = effective ? rules.scanCwdInstructions(effective) : [];
    const selections = rules.readCwdSelections(dshHome);
    return {
      ok: true,
      cwd: effective,
      candidates: candidates.map((item) => ({ ...item, selected: selections.includes(item.path) })),
      selections,
    };
  }
  if (op === "toggle-cwd") {
    const target = typeof body?.path === "string" ? body.path.trim() : "";
    if (!target) return { status: 400, ok: false, error: "path required" };
    const enabled = body?.enabled !== false;
    const next = await rules.toggleCwdSelection(dshHome, target, enabled);
    return { ok: true, selections: next };
  }
  if (op === "set-policy" || op === "workspace-policy") {
    const policy = typeof body?.policy === "string" ? body.policy.trim() : "";
    if (!rules.WORKSPACE_POLICIES.includes(policy)) {
      return { status: 400, ok: false, error: `invalid policy: ${policy}` };
    }
    const applied = await rules.writeWorkspacePolicy(dshHome, policy);
    return { ok: true, policy: applied, policies: [...rules.WORKSPACE_POLICIES] };
  }
  if (op === "read") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const content = await rules.readRule(dshHome, id);
    if (content === null) return { status: 404, ok: false, error: `rule not found: ${id}` };
    const meta = await rules.readRuleMeta(dshHome, id);
    return { ok: true, id, name: meta.name, target: meta.target, content };
  }
  if (op === "save") {
    const content = typeof body?.content === "string" ? body.content : null;
    if (!rules.validRuleId(id) || content === null) {
      return { status: 400, ok: false, error: "id and content (string) required" };
    }
    const target = typeof body?.target === "string" ? body.target : undefined;
    // The old version wrote body.target straight into rules.saveRule; an invalid target pollutes agents_path.
    if (target !== undefined && !rules.validTarget(target)) {
      return { status: 400, ok: false, error: `invalid target: ${target} (chỉ được là AGENTS.md hoặc CLAUDE.md)` };
    }
    await rules.saveRule(dshHome, id, content, {
      name: typeof body?.name === "string" ? body.name : undefined,
      target,
    });
    refreshHungOperator(dshHome);
    return { ok: true, id, ...injectSnapshot(dshHome) };
  }
  if (op === "activate") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const meta = await rules.activateRule(dshHome, id);
    refreshHungOperator(dshHome);
    return {
      ok: true,
      id,
      name: meta.name,
      target: meta.target,
      agents_path: rules.targetPath(dshHome, meta.target),
      note: "đã ghi tệp đích và inject systemPrompt, có hiệu lực ở phiên mới",
      ...injectSnapshot(dshHome),
    };
  }
  if (op === "delete") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    await rules.deleteRule(dshHome, id);
    refreshHungOperator(dshHome);
    return { ok: true, id };
  }
  if (op === "reset") {
    const r = await rules.resetToOriginal(dshHome);
    refreshHungOperator(dshHome);
    return { ok: true, ...r,
      note: "đã hoàn nguyên về trạng thái gốc (không chỉ dẫn toàn cục); kho luật được giữ lại" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function rulesHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = url.pathname.replace(/^\/de-policy\/rules\/?/, "").replace(/\/$/, "");
      let body = {};
      if (request.method === "POST") body = await readJsonBody(request);
      else if (methodNotAllowed(request, response, forcedOp ? ["GET", "POST"] : ["GET", "POST"])) return;
      const op = forcedOp || body.op || tail || "status";
      const result = await handleRulesOp(op, body, url.searchParams.get("id"), url.searchParams.get("cwd"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

async function handleSkillsOp(op, body, queryId) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  if (op === "status") {
    return { ok: true, ...(await skills.skillsStatus(dshHome)) };
  }
  if (op === "read") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const item = await skills.readSkill(dshHome, id);
    if (!item) return { status: 404, ok: false, error: `skill not found: ${id}` };
    return { ok: true, ...skills.toPublicSkill(dshHome, item) };
  }
  if (op === "save") {
    if (!skills.validSkillName(id)) {
      return { status: 400, ok: false, error: "id phải ở dạng kebab-case, ví dụ code-review" };
    }
    const content = typeof body?.content === "string" ? body.content : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const saved = await skills.saveSkill(dshHome, id, content, description);
    return { ok: true, ...skills.toPublicSkill(dshHome, saved) };
  }
  if (op === "delete") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const removed = await skills.deleteSkill(dshHome, id);
    return { ok: true, ...skills.toPublicSkill(dshHome, removed) };
  }
  if (op === "import") {
    if (body?.path || body?.source || body?.folder) {
      return { status: 400, ok: false, error: "Hãy chọn tệp nén hoặc thư mục trên máy này để import" };
    }
    if (typeof body?.data === "string" && body.data.trim()) {
      const packed = await skills.importArchive(dshHome, Buffer.from(body.data, "base64"), body.name || "skill.zip");
      return { ok: true, ...packed };
    }
    if (Array.isArray(body?.files) && body.files.length) {
      const packed = await skills.importFileTree(dshHome, body.files, body.name || "");
      return { ok: true, ...packed };
    }
    return { status: 400, ok: false, error: "Hãy chọn tệp nén hoặc thư mục" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function skillsHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST, OPTIONS" });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = skillRouteTail(url.pathname);
      const body = request.method === "POST" ? await readJsonBody(request, 14 * 1024 * 1024) : {};
      const op = forcedOp
        || body.op
        || tail
        || url.searchParams.get("op")
        || (url.searchParams.get("id") ? "read" : "status");
      const result = await handleSkillsOp(op, body, url.searchParams.get("id"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

function skillRouteTail(pathname) {
  const match = String(pathname || "").match(/^\/de-policy\/skills?(?:\/(.*))?$/i);
  if (!match) return "";
  return String(match[1] || "").replace(/\/$/, "");
}

function installSkillsHttp(webServer) {
  // The old version registered /de-policy/skills[/op] and /de-policy/skill[/op] as 10+ exact routes plus
  // a prefix fallback; the handler dispatches ops by tail, so the exact list only bloated the route table.
  // Two prefix routes cover everything; forcedOp="" keeps body.op/tail/op dispatch alive.
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/de-policy/skills", handler: skillsHttpHandler(""),
  }));
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/de-policy/skill", handler: skillsHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function installRulesHttp(webServer) {
  // Same as skills: one prefix covers /de-policy/rules[/op]; the handler dispatches ops by tail.
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/de-policy/rules", handler: rulesHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function sendJson(response, status, payload, onFlushed) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload), () => {
    if (typeof onFlushed === "function") onFlushed();
  });
}

function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function registerRoute(webServer, spec) {
  try {
    const handler = spec.handler;
    return webServer.register({
      ...spec,
      handler: async (request, response) => {
        if (!allowPluginRequest(request, response)) return;
        return handler(request, response);
      },
    });
  } catch (e) {
    console.warn("[de-policy] route", spec?.path, String(e && e.message ? e.message : e));
    return () => {};
  }
}

async function readJsonBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
