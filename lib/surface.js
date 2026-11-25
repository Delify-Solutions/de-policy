import path from "node:path";

/** Currently wired host surfaces. gui / tui are recognised but still adapt as web. */
export const SURFACES = Object.freeze(["web", "desktop", "gui", "tui"]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function exeName(execPath) {
  return path.basename(String(execPath || "")).toLowerCase();
}

export function pathLooksDesktop(p) {
  const n = slash(p);
  if (!n) return false;
  // Install dirs may be named "DeepSeek Harness" / "deepseek-harness" / "DeepseekHarnessDesktop".
  // Source repos often carry that name too, so require resources/, exe or .app/ for a desktop install.
  const harnessDir =
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness/.test(n);
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.includes("dsh-desktop") ||
    n.includes("dsh-plugin-desktop") ||
    n.includes("/deepseek harness.app/") ||
    (harnessDir && (n.includes("/resources/") || n.includes("/contents/resources/") || n.endsWith("/resources"))) ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n) ||
    n.endsWith("/host-process-entry.js") ||
    n.endsWith("/desktop-cli.js")
  );
}

function isOfficialHarnessExeName(name) {
  return (
    name === "dsh desktop.exe" ||
    name === "dsh desktop" ||
    name === "deepseek harness.exe" ||
    name === "deepseek-harness.exe" ||
    name === "deepseek harness" ||
    name === "deepseek-harness" ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(name)
  );
}

function isElectronRunAsNode(env) {
  const v = norm(env.ELECTRON_RUN_AS_NODE);
  return v !== "" && v !== "0" && v !== "false";
}

/** Electron running a CLI as Node (common for official `dsh web`) is not a desktop GUI. */
function isElectronGuiProcess(input = {}) {
  const env = input.env ?? process.env;
  if (isElectronRunAsNode(env)) return false;
  const versions = input.versions ?? process.versions;
  if (versions && versions.electron) return true;
  const execPath = input.execPath ?? process.execPath;
  return isOfficialHarnessExeName(exeName(execPath));
}

function argvList(argv) {
  return Array.isArray(argv) ? argv : [];
}

/** Bare command: `dsh web` / `dsh tui`. Paths and `--flag` do not count. */
export function argvHasBareCommand(argv, name) {
  const want = String(name || "").toLowerCase();
  if (!want) return false;
  for (const raw of argvList(argv)) {
    const a = String(raw || "").trim();
    if (!a || a.startsWith("-")) continue;
    if (/[\\/]/.test(a) || /\.(js|mjs|cjs|exe|cmd|bat|asar)$/i.test(a)) continue;
    if (a.toLowerCase() === want) return true;
  }
  return false;
}

function profileFromArgv(argv) {
  const list = argvList(argv);
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i] || "").trim();
    const low = a.toLowerCase();
    if (low === "--profile" && list[i + 1]) return norm(list[i + 1]);
    if (low.startsWith("--profile=")) return norm(a.slice("--profile=".length));
  }
  return "";
}

function profileName(env, argv) {
  return norm(env.DSH_PROFILE) || profileFromArgv(argv);
}

export function argvLooksDesktopHost(argv) {
  const list = argvList(argv);
  if (argvHasBareCommand(list, "web")) return false;
  return list.some((arg) => {
    const n = slash(arg);
    return (
      n.endsWith("/host-process-entry.js") ||
      n.endsWith("/desktop-cli.js") ||
      n.includes("/dsh-desktop-host/") ||
      n.includes("/dsh-plugin-desktop/") ||
      // 0.2.0 desktop host: resources/app.asar/lib/bin.js, with no web subcommand.
      ((n.includes("/resources/app.asar/") || n.includes("/resources/app/")) &&
        (n.endsWith("/bin.js") || n.endsWith("/lib/bin.js")))
    );
  });
}

/** This process is the official desktop Host (Electron-as-node + dsh-desktop-host), not `dsh web`. */
export function looksOfficialDesktopHost(input = {}) {
  const argv = input.argv ?? process.argv;
  if (argvHasBareCommand(argv, "web")) return false;
  if (argvLooksDesktopHost(argv)) return true;
  const env = input.env ?? process.env;
  if (forcedSurface(env) === "desktop") return true;
  if (norm(env.DSH_PROFILE) === "desktop" && isElectronRunAsNode(env)) {
    if (isOfficialHarnessExeName(exeName(input.execPath ?? process.execPath))) return true;
  }
  return false;
}

function forcedSurface(env) {
  const forced = norm(env.DSH_SURFACE);
  return SURFACES.includes(forced) ? forced : "";
}

export function detectSurface(input = {}) {
  const env = input.env ?? process.env;
  const forced = forcedSurface(env);
  if (forced) return forced;

  const argv = input.argv ?? process.argv;
  // Official `dsh web` often lives inside a desktop install's app.asar: argv has /resources/,
  // and execPath may be Harness.exe + ELECTRON_RUN_AS_NODE. The command itself decides.
  if (argvHasBareCommand(argv, "web")) return "web";
  if (argvHasBareCommand(argv, "tui")) return "tui";
  if (argvHasBareCommand(argv, "gui")) return "gui";
  if (argvHasBareCommand(argv, "desktop")) return "desktop";
  // The official Host's argv carries dsh-desktop-host and must beat a stray DSH_PROFILE=web.
  if (argvLooksDesktopHost(argv)) return "desktop";

  const profile = profileName(env, argv);
  // `--profile web` / DSH_PROFILE=web means web. Official web often starts from bin.js inside a
  // .app, so a desktop-looking path must not make it report "desktop".
  if (profile === "web" || profile === "tui" || profile === "gui") return profile;
  if (profile === "desktop") return "desktop";

  const execPath = input.execPath ?? process.execPath;
  if (isElectronRunAsNode(env) && isOfficialHarnessExeName(exeName(execPath))) {
    return "desktop";
  }

  if (isElectronGuiProcess(input)) return "desktop";
  return "web";
}

export function isDesktopSurface(input = {}) {
  return detectSurface(input) === "desktop";
}

export function normalizeSurface(value) {
  const n = norm(value);
  return SURFACES.includes(n) ? n : "";
}

export function thisProcessIsElectronGui(input = {}) {
  return isElectronGuiProcess(input);
}

/**
 * The surface the user clicked. Browser = web, Electron window = desktop.
 * The embedded `dsh web` process in the official desktop has web in argv, which must not
 * make the desktop app count as web.
 */
export function controlSurface(input = {}) {
  // Prefer the window surface / embedded desktop. A client misreporting surface=web must
  // not send a desktop Apply to a dsh web restart.
  if (input.electron === true) return "desktop";
  if (input.embeddedDesktop === true) return "desktop";
  if (isElectronGuiProcess(input)) return "desktop";
  const hinted = normalizeSurface(input.hint);
  if (hinted === "desktop") return "desktop";
  if (hinted === "web") return "web";
  return detectSurface(input);
}

/** gui / tui are not adapted yet: they go through web restart and detection. */
export function adapterFor(kind) {
  return kind === "desktop" ? "desktop" : "web";
}
