import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import { ancestorLooksDesktopGui, scheduleRestart as restartDesktop, spawnPowerShellOutsideJob, waitForFile } from "./desktop.js";
import { diskFs } from "./extract-asar.js";
import { looksOfficialDesktopHost } from "./surface.js";

export function restartNote() {
  return "Đang khởi động lại dsh web…";
}

export function portFromRequest(request) {
  const host = String(request?.headers?.host || "");
  const m = host.match(/:(\d+)$/);
  if (m) return Number(m[1]);
  return Number(process.env.PORT) || 3080;
}

export function hostFromRequest(request) {
  const hostHeader = String(request?.headers?.host || "127.0.0.1");
  return hostHeader.replace(/:\d+$/, "") || "127.0.0.1";
}

function hasBareWeb(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    if (String(list[i]) !== "web") continue;
    if (String(list[i - 1] || "").toLowerCase() === "--profile") continue;
    return true;
  }
  return false;
}

function webRestArgs(argv, port) {
  const rest = argv.slice(2).filter((arg) => arg !== "--no-open" && arg !== "desktop");
  if (!hasBareWeb(rest)) {
    rest.unshift("web", "--port", String(port || Number(process.env.PORT) || 3080));
  }
  if (!rest.includes("--no-open")) rest.push("--no-open");
  return rest;
}

function diskFile(fp) {
  if (!fp) return false;
  try {
    const st = diskFs().statSync(fp);
    return Boolean(st && st.isFile());
  } catch {
    return false;
  }
}

export function restartArgv({
  argv = process.argv,
  findBinRoot = core.findDshBinRoot,
  port = Number(process.env.PORT) || 3080,
} = {}) {
  const rest = webRestArgs(argv, port);
  const extracted = core.thisProcessExtractedBinJs();
  if (extracted) return [extracted, ...rest];
  const root = findBinRoot();
  const binJs = root ? path.join(root, "lib", "bin.js") : "";
  if (binJs && diskFile(binJs)) return [binJs, ...rest];
  const next = argv.slice(1).filter((arg) => arg !== "--no-open" && arg !== "desktop");
  if (next[0] && /\.(cmd|bat)$/i.test(next[0])) {
    const dir = path.dirname(next[0]);
    const candidates = [
      path.resolve(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      path.resolve(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    const hit = candidates.find((p) => diskFile(p) || fs.existsSync(p));
    if (hit) next[0] = hit;
  }
  if (!hasBareWeb(next)) next.unshift("web", "--port", String(port));
  if (!next.includes("--no-open")) next.push("--no-open");
  return next;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function spawnRestartHelper(helper, payload, exitAfter = 250) {
  const alive = payload && payload.alivePath;
  if (process.platform === "win32") {
    try { core.silenceCmdFlash(); } catch { /* flash still restarts on failure */ }
    const ps1 = path.join(os.tmpdir(), `de-policy-spawn-web-${process.pid}-${Date.now()}.ps1`);
    const body = [
      "\uFEFF$ErrorActionPreference = 'Continue'",
      "$env:ELECTRON_RUN_AS_NODE = '1'",
      "$env:DSH_SURFACE = 'web'",
      "$env:DSH_PROFILE = 'web'",
      `$env:DSH_PURGE_RESTART = ${psQuote(JSON.stringify(payload))}`,
      "Remove-Item Env:DSH_PERMISSION_MODE -ErrorAction SilentlyContinue",
      `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList @(${psQuote(helper)}) -WindowStyle Hidden -PassThru`,
      "if (-not $p) { throw 'Start-Process web helper failed' }",
    ].join("\r\n");
    fs.writeFileSync(ps1, body, "utf8");
    spawnPowerShellOutsideJob([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      ps1,
    ]);
  } else {
    const child = spawn(process.execPath, [helper], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: {
        ...core.envForDetachedSpawn(process.env, { surface: "web" }),
        ELECTRON_RUN_AS_NODE: "1",
        DSH_SURFACE: "web",
        DSH_PROFILE: "web",
        DSH_PURGE_RESTART: JSON.stringify(payload),
      },
    });
    child.unref();
  }
  if (alive && !waitForFile(alive, 4000)) {
    return { restarting: false, error: "Tiến trình khởi động lại không chạy" };
  }
  // On 1.1.71 Mac comes back because the old process exits and frees the port,
  // not because the helper runs SIGKILL / lsof.
  if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);
  return { restarting: true, goPath: alive ? `${alive}.go` : "" };
}

/**
 * @param {object} [request]
 * @param {unknown} [_ctx]
 * @param {{ openBrowser?: boolean }} [options]
 * settle / self-heal restart passes request=null, so no browser by default: prevents
 * reopened windows after the user closed one (#59/#61).
 */
export function scheduleRestart(request, _ctx, options = {}) {
  if (looksOfficialDesktopHost()) {
    return restartDesktop(request, _ctx, { ...options, surface: "desktop" });
  }
  try {
    if (ancestorLooksDesktopGui()) {
      return restartDesktop(request, _ctx, { ...options, surface: "desktop" });
    }
  } catch { /* not embedded web, fall through to standalone web restart */ }
  const openBrowser = options.openBrowser ?? (request != null);
  const helper = fileURLToPath(new URL("./restart-web.js", import.meta.url));
  const alive = path.join(os.tmpdir(), `de-policy-web-alive-${process.pid}`);
  try { fs.unlinkSync(alive); } catch { /* no marker from previous run */ }
  try { fs.unlinkSync(`${alive}.go`); } catch { /* no go signal from previous run */ }
  const port = portFromRequest(request);
  const spawned = spawnRestartHelper(helper, {
    kind: "web",
    execPath: process.execPath,
    argv: restartArgv({ port }),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port,
    pid: process.pid,
    alivePath: alive,
    lockPath: path.join(os.tmpdir(), `de-policy-web-restart-${port}.lock`),
    openBrowser: openBrowser !== false,
  });
  if (spawned && spawned.restarting === false) return spawned;
  return { restarting: true, goPath: spawned && spawned.goPath };
}

export function scheduleCleanupRestart({ request, restartArgv: argv, cleanup = [] } = {}) {
  const src = fileURLToPath(new URL("./uninstall-restart.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `de-policy-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  const spawned = spawnRestartHelper(dest, {
    kind: "web",
    execPath: process.execPath,
    argv: argv || restartArgv(),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port: portFromRequest(request),
    cleanup,
    helper: dest,
    openBrowser: request != null,
  });
  return { restarting: spawned?.restarting !== false, goPath: spawned && spawned.goPath };
}
