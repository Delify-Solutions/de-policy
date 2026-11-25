/**
 * On disable/uninstall, clear a selectedDefault that points at this plugin's preset.
 * Host resolve() throws hard on an unknown preset and does not fall back to config.default (#108).
 */
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

const OWNED_PRESET_IDS = ["redteam"];
const FALLBACK_PRESET = "standard";

function isOwnedPresetId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return false;
  return OWNED_PRESET_IDS.some((own) => id === own || id.endsWith(`/${own}`));
}

function readText(fp) {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

function writeText(fp, text) {
  fs.writeFileSync(fp, text, "utf8");
}

function listProfilePatchFiles(dshHome) {
  const root = path.join(dshHome, "profiles");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const fp = path.join(root, name, "cordis.patch.yml");
    if (fs.existsSync(fp)) out.push(fp);
  }
  return out;
}

/** Change only the selectedDefault value that points at this plugin's preset; do not reflow the YAML. */
function repairSelectedDefaultInYaml(text, fallback = FALLBACK_PRESET) {
  const src = String(text || "");
  if (!/selectedDefault/.test(src)) return { text: src, changed: false };
  const next = src.replace(
    /(selectedDefault\s*:\s*)(["']?)(?:[\w.-]+\/)?redteam\2/gi,
    `$1$2${fallback}$2`,
  );
  return { text: next, changed: next !== src };
}

function repairProfilePatchFile(fp, fallback = FALLBACK_PRESET) {
  const raw = readText(fp);
  if (!raw) return { path: fp, changed: false };
  const { text, changed } = repairSelectedDefaultInYaml(raw, fallback);
  if (!changed) return { path: fp, changed: false };
  writeText(fp, text);
  return { path: fp, changed: true };
}

function configValue(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  try {
    if (typeof node.get === "function") return String(node.get() ?? "");
  } catch {
    /* ignore */
  }
  try {
    if (typeof node.value !== "undefined") return String(node.value ?? "");
  } catch {
    /* ignore */
  }
  return "";
}

function configSet(node, value) {
  if (!node) return false;
  try {
    if (typeof node.set === "function") {
      node.set(value);
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    node.value = value;
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

function clearLiveSelectedDefault(ctx) {
  if (!ctx) return false;
  let persisted = false;
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    const row = settings?.get?.("agent-preset-registry")
      || settings?.get?.("@deepseek-ai/dsh-agent-preset-registry");
    const selected = configValue(row?.config?.selectedDefault || row?.selectedDefault);
    if (isOwnedPresetId(selected) && typeof settings?.update === "function") {
      const fallback = configValue(row?.config?.default || row?.default) || FALLBACK_PRESET;
      if (fallback && !isOwnedPresetId(fallback)) {
        const ret = settings.update("agent-preset-registry", { selectedDefault: fallback });
        if (ret && typeof ret.then === "function") ret.catch(() => {});
        persisted = true;
      }
    }
  } catch {
    /* ignore */
  }
  const bags = [];
  try {
    const reg = (typeof ctx.get === "function" ? ctx.get("agentPresets") : null) || ctx.agentPresets;
    if (reg) bags.push(reg.config || reg);
  } catch {
    /* ignore */
  }
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    const row = settings?.get?.("agent-preset-registry") || settings?.get?.("@deepseek-ai/dsh-agent-preset-registry");
    if (row) bags.push(row.config || row);
  } catch {
    /* ignore */
  }
  for (const bag of bags) {
    if (!bag) continue;
    const selected = bag.selectedDefault;
    const current = configValue(selected);
    if (!isOwnedPresetId(current)) continue;
    const fallback = configValue(bag.default) || FALLBACK_PRESET;
    if (configSet(selected, fallback)) return true;
  }
  return persisted;
}

/**
 * Called on disable/uninstall. Failures are only recorded, never thrown.
 * @returns {{ live: boolean, files: string[] }}
 */
export function clearOwnedSelectedDefault({ ctx = null, dshHome = "" } = {}) {
  const home = dshHome || findDshHome();
  const report = { live: false, files: [] };
  try {
    report.live = clearLiveSelectedDefault(ctx);
  } catch {
    report.live = false;
  }
  if (!home) return report;
  for (const fp of listProfilePatchFiles(home)) {
    try {
      const row = repairProfilePatchFile(fp);
      if (row.changed) report.files.push(fp);
    } catch {
      /* a failed write on one profile must not block the disable */
    }
  }
  return report;
}

export function removeStaleAgentPresetDir(dshHome, id = "redteam") {
  const home = dshHome || findDshHome();
  if (!home || !id) return false;
  const dir = path.join(home, ".agent-presets", id);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Does the registry still declare this preset? Returns null when the registry is unreadable. */
async function registryStillDeclares(ctx, id) {
  try {
    const reg = typeof ctx?.get === "function" ? ctx.get("agentPresets") : ctx?.agentPresets;
    if (reg == null || typeof reg.list !== "function") return null;
    const rows = await reg.list();
    if (!Array.isArray(rows)) return null;
    return rows.some((row) => String(row?.id || "").trim().toLowerCase() === String(id).toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Clear the default on disable/uninstall; this **must not hang off ordinary effect teardown**.
 *
 * A profile with `patchReload: "live"` does "dispose then apply" on every hot reload:
 * clearing `selectedDefault` during teardown would revert the "redteam mode" default the user
 * picked from the dropdown to standard on every hot reload (and rewrite the profile's
 * cordis.patch.yml to disk while at it).
 * What the user sees is "chose redteam, and the next message is standard again".
 *
 * So teardown only does two things: record whether a plugin instance is still alive in this
 * process, then schedule one delayed re-check.
 * At re-check time an instance count > 0 means a hot reload — do nothing; only when none is left
 * (a real disable/uninstall) do we clear.
 */
const liveOwners = new Map(); // id -> number of live applies

/** Register once per apply; return the release fn for the same effect's teardown. */
export function holdOwnedPresetAlive(id = "redteam") {
  liveOwners.set(id, (liveOwners.get(id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveOwners.set(id, Math.max(0, (liveOwners.get(id) || 0) - 1));
  };
}

export function scheduleOwnedSelectedDefaultSweep({ ctx = null, dshHome = "", delayMs = 4000, id = "redteam" } = {}) {
  const timer = setTimeout(() => {
    void (async () => {
      // An instance is still alive -> this is a hot reload; the user's chosen default must not move.
      if ((liveOwners.get(id) || 0) > 0) return;
      // The registry still declares this preset (redeclared by another path) -> leave it alone too.
      if (await registryStillDeclares(ctx, id)) return;
      // registry.list() may span an await; if a hot reload re-applied meanwhile, keep it again.
      if ((liveOwners.get(id) || 0) > 0) return;
      const home = dshHome || findDshHome();
      // A failed clear must not block the disable.
      try { clearOwnedSelectedDefault({ ctx, dshHome: home }); } catch { /* best effort */ }
    })();
  }, delayMs);
  try { timer.unref?.(); } catch { /* ignore */ }
  return timer;
}
