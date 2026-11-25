import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

if (info.alivePath) {
  try { fs.writeFileSync(String(info.alivePath), String(process.pid), "utf8"); } catch { /* exists */ }
}

const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];
const logPath = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  "de-policy-restart-desktop.log",
);

function log(msg) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
}

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === "ELECTRON_RUN_AS_NODE"
      || upper === "NODE_OPTIONS"
      || upper === "NODE_PATH"
      || upper === "ELECTRON_ENABLE_LOGGING"
      || upper === "ELECTRON_LOG_FILE"
      || upper === "HTTP_PROXY"
      || upper === "HTTPS_PROXY"
      || upper === "ALL_PROXY"
    ) {
      delete env[key];
    }
  }
  // [de-policy-fix 2026-10-09] env inherited from explorer often lacks DSH_PROFILE
  // (the WM_SETTINGCHANGE broadcast never refreshes a long-lived explorer). Without a
  // fallback on helper relaunch, the new Electron -> host child still lacks it, reports
  // "cannot determine the boot profile", the host crashes, the plugin never activates
  // and every injection breaks.
  if (!env.DSH_PROFILE) env.DSH_PROFILE = "desktop";
  env.DSH_SURFACE = "desktop";
  // A GUI process must never attach a console. The official Host pipes `dsh web:` into
  // process.stdout.
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

function psQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function win32CommandLine(exe, argv) {
  const parts = [`"${exe}"`];
  for (const raw of argv || []) {
    const s = String(raw);
    parts.push(!/[\s"]/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
  }
  return parts.join(" ");
}

/** Windows: create the exe through WMI. CreateProcess+detached pops a separate console. */
function launchWin32Gui(exe, argv, cwd, env) {
  const commandLine = win32CommandLine(exe, argv);
  const workdir = cwd || path.dirname(exe);
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(workdir)} }; if (-not $r -or $r.ReturnValue -ne 0) { throw ('Win32_Process.Create ' + $r.ReturnValue) }`,
    ], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15000,
    });
    log("relaunched via WMI Create");
    return true;
  } catch (error) {
    log("WMI Create failed, spawn fallback: " + (error && error.message ? error.message : error));
    const child = spawn(exe, argv || [], {
      detached: true,
      stdio: "ignore",
      cwd: workdir,
      env,
      windowsHide: true,
      shell: false,
    });
    child.unref();
    return true;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid) {
  if (!pid) {
    await sleep(400);
    return true;
  }
  for (let i = 0; i < 80; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(120);
  }
  return !pidAlive(pid);
}

function rmTree(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {
    // leave it alone while locked
  }
}

function pidsForImage(image) {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  });
  const pids = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const cols = line.split(",");
    const pid = Number(String(cols[1] || "").replace(/"/g, "").trim());
    if (pid) pids.push(pid);
  }
  return pids;
}

function commandLineLooksDesktopGui(cmd) {
  const n = String(cmd || "").replace(/\\/g, "/").toLowerCase();
  if (!n) return true;
  if (n.includes("restart-web.js") || n.includes("restart-desktop.js")) return false;
  if (n.includes("/dsh-desktop-host/") || n.includes("host-process-entry") || n.includes("desktop-cli.js")) return false;
  // 0.2.0 desktop host is exe + bin.js with no web. Treating it as a GUI kills the host
  // first and pops stopped.
  if (/\bbin\.js\b/.test(n)) return false;
  return true;
}

function winProcessRows(image) {
  const name = String(image || "").replace(/'/g, "''");
  if (!name) return [];
  try {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object {` +
      ' "{0}`t{1}" -f $_.ProcessId, (($_.CommandLine) -replace "`t"," " -replace "`r"," " -replace "`n"," ")' +
      " }";
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 12000,
    });
    const rows = [];
    for (const line of String(out || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.indexOf("\t");
      const pid = Number((tab < 0 ? trimmed : trimmed.slice(0, tab)).trim());
      const cmd = tab < 0 ? "" : trimmed.slice(tab + 1);
      if (pid) rows.push({ pid, cmd });
    }
    if (rows.length) return rows;
  } catch {
    // fall through
  }
  return pidsForImage(image).map((pid) => ({ pid, cmd: "" }));
}

function darwinBundleOf(exe) {
  const n = String(exe || "").replace(/\\/g, "/");
  const m = n.match(/^(.*\.app)\/Contents\/MacOS\//i);
  return m ? m[1] : "";
}

function darwinBundleName(bundle) {
  if (!bundle) return "";
  const infoPlist = path.join(bundle, "Contents", "Info.plist");
  try {
    return execFileSync("defaults", ["read", path.join(bundle, "Contents", "Info"), "CFBundleName"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    // fall through
  }
  try {
    return execFileSync("plutil", ["-extract", "CFBundleName", "raw", infoPlist], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return path.basename(bundle, ".app");
  }
}

function listDarwinPids(exe) {
  const bundle = darwinBundleOf(exe);
  if (!exe || !bundle) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  const frameworks = `${bundle}/Contents/Frameworks/`;
  const pids = [];
  for (const line of String(out || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.search(/\s/);
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp).trim());
    const cmd = trimmed.slice(sp + 1).trim();
    if (!pid) continue;
    if (cmd.includes("restart-web.js") || cmd.includes("restart-desktop.js")) continue;
    if (/\bbin\.js\b/.test(cmd) && (/\sweb\b/.test(cmd) || cmd.includes(" --port "))) continue;
    if (cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(frameworks) || cmd.includes("/dsh-desktop-host/")) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function commandMatchesExe(cmd, exe) {
  if (!cmd || !exe) return false;
  if (cmd.includes("restart-web.js") || cmd.includes("restart-desktop.js")) return false;
  if (/\bbin\.js\b/.test(cmd) && (/\sweb\b/.test(cmd) || cmd.includes(" --port "))) return false;
  return cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(`${exe}\t`) || cmd.includes("/dsh-desktop-host/");
}

function listPosixPids(exe) {
  if (!exe) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of String(out || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.search(/\s/);
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp).trim());
    const cmd = trimmed.slice(sp + 1).trim();
    if (!pid || !commandMatchesExe(cmd, exe)) continue;
    pids.push(pid);
  }
  return [...new Set(pids)];
}

function desktopImageNames(exe = info.execPath) {
  const names = new Set(["DeepSeek Harness.exe", "DSH Desktop.exe"]);
  const base = path.basename(String(exe || ""));
  if (base) names.add(base);
  if (base && !/\.exe$/i.test(base)) names.add(`${base}.exe`);
  return [...names];
}

function listDesktopPids(exe = info.execPath) {
  if (process.platform === "darwin") return listDarwinPids(exe);
  if (process.platform !== "win32") return listPosixPids(exe);
  const images = desktopImageNames(exe);
  const exeNorm = String(exe || "").replace(/\\/g, "/").toLowerCase();
  const pids = [];
  for (const image of images) {
    try {
      for (const row of winProcessRows(image)) {
        if (!commandLineLooksDesktopGui(row.cmd)) continue;
        if (exeNorm && row.cmd) {
          const n = String(row.cmd).replace(/\\/g, "/").toLowerCase();
          if (!n.includes(exeNorm)) continue;
        }
        pids.push(row.pid);
      }
    } catch {
      // that process name does not exist
    }
  }
  return [...new Set(pids)];
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}

async function waitDesktopGone(exe, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const left = listDesktopPids(exe).filter((pid) => pid !== process.pid);
    if (left.length === 0) return true;
    await sleep(200);
  }
  return listDesktopPids(exe).filter((pid) => pid !== process.pid).length === 0;
}

async function quitPosixDesktop(exe) {
  signalPids(listDesktopPids(exe), "SIGTERM");
  if (await waitDesktopGone(exe, 8000)) {
    log("quit by SIGTERM");
    return "SIGTERM";
  }
  signalPids(listDesktopPids(exe), "SIGKILL");
  await waitDesktopGone(exe, 2000);
  log("quit by SIGKILL");
  return "SIGKILL";
}

async function quitDarwinDesktop(exe) {
  const bundle = darwinBundleOf(exe);
  const name = darwinBundleName(bundle);
  if (name) {
    try {
      execFileSync(
        "osascript",
        ["-e", `if application "${name}" is running then tell application "${name}" to quit`],
        { timeout: 15000 },
      );
      log("osascript quit sent");
    } catch (e) {
      log(`osascript quit failed: ${e && e.message ? e.message : e}`);
    }
    if (await waitDesktopGone(exe, 8000)) {
      log("quit by apple event");
      return "apple-event";
    }
  }
  signalPids(listDesktopPids(exe), "SIGTERM");
  if (await waitDesktopGone(exe, 5000)) {
    log("quit by SIGTERM");
    return "SIGTERM";
  }
  signalPids(listDesktopPids(exe), "SIGKILL");
  await waitDesktopGone(exe, 2000);
  log("quit by SIGKILL");
  return "SIGKILL";
}

function killOtherDesktopProcesses(keepPid, exe = info.execPath) {
  for (const pid of listDesktopPids(exe)) {
    if (pid === keepPid || pid === process.pid) continue;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 15000,
        });
      } catch {
        // already exited
      }
      continue;
    }
    try {
      process.kill(pid, process.platform === "darwin" ? "SIGTERM" : undefined);
    } catch {
      // already exited
    }
  }
}

async function moveAsarAsideAsync(asar) {
  if (!asar) return false;
  try {
    if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) return true;
  } catch {
    return true;
  }
  const bak = `${asar}.bak`;
  try {
    if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  } catch {
    // keep going
  }
  for (let i = 0; i < 80; i++) {
    try {
      if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
        log("asar already absent");
        return true;
      }
      fs.renameSync(asar, bak);
      log(`asar moved to ${bak}`);
      return true;
    } catch {
      await sleep(300);
    }
  }
  log("asar move failed after retries");
  return false;
}

function asarStillSealed(asar) {
  try {
    return Boolean(asar) && fs.existsSync(asar) && fs.statSync(asar).isFile();
  } catch {
    return false;
  }
}

async function releaseSealedAsar(asar, exe) {
  if (!asar) return true;
  if (await moveAsarAsideAsync(asar)) return true;
  log("retry quit then move asar");
  if (process.platform === "darwin") await quitDarwinDesktop(exe);
  else if (process.platform === "win32") {
    killOtherDesktopProcesses(process.pid, exe);
    await sleep(800);
  } else await quitPosixDesktop(exe);
  if (await moveAsarAsideAsync(asar)) return true;
  return !asarStillSealed(asar);
}

async function relaunchDesktop() {
  if (!info.execPath) {
    process.exit(1);
  }
  const env = spawnEnv();
  if (process.platform === "darwin") {
    const bundle = darwinBundleOf(info.execPath);
    if (bundle) {
      for (let i = 0; i < 8; i++) {
        try {
          const child = spawn("open", [bundle], {
            detached: true,
            stdio: "ignore",
            env,
            shell: false,
          });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 400);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
          });
          child.unref();
          log("relaunched via open");
          return;
        } catch (error) {
          log("open relaunch fail " + i + ": " + (error && error.message ? error.message : error));
          await sleep(300 * (i + 1));
        }
      }
      process.exit(1);
    }
  }
  // [de-policy-fix 2026-10-09] Reuse Electron's own --updated argv branch:
  // main.js:11256 process.argv.includes("--updated") → raiseAfterUpdate=true
  // -> enterWorkspace calls window.moveTop() + window.focus(), forcing foreground from
  // inside. Far more reliable than an external PS SetForegroundWindow (Win11 foreground
  // protection only blocks external processes).
  const baseArgv = Array.isArray(info.argv) ? info.argv.slice() : [];
  if (process.platform === "win32" && !baseArgv.includes("--updated")) {
    baseArgv.push("--updated");
  }
  if (process.platform === "win32") {
    for (let i = 0; i < 8; i++) {
      try {
        launchWin32Gui(info.execPath, baseArgv, info.cwd || path.dirname(info.execPath), env);
        log("relaunched gui (argv=" + JSON.stringify(baseArgv) + ")");
        break;
      } catch (error) {
        log("relaunch gui fail " + i + ": " + (error && error.message ? error.message : error));
        if (i === 7) process.exit(1);
        await sleep(300 * (i + 1));
      }
    }
  } else {
    let child = null;
    for (let i = 0; i < 8; i++) {
      try {
        child = spawn(info.execPath, baseArgv, {
          detached: true,
          stdio: "ignore",
          cwd: info.cwd || process.cwd(),
          env,
          windowsHide: true,
          shell: false,
        });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 400);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        break;
      } catch (error) {
        log("relaunch spawn fail " + i + ": " + (error && error.message ? error.message : error));
        child = null;
        await sleep(300 * (i + 1));
      }
    }
    if (!child) process.exit(1);
    child.unref();
    log("relaunched via execPath (argv=" + JSON.stringify(baseArgv) + ")");
  }

  // [de-policy-fix 2026-10-09] Windows: the new Electron is spawned from a detached
  // helper, and Windows focus rules keep it in the background. The helper is no longer
  // foreground (the old Electron was killed), so a direct SetForegroundWindow is silently
  // rejected. A three-step trick forces foreground:
  //   1) keybd_event sends a virtual Alt key - simulated input releases the foreground lock
  //   2) AttachThreadInput joins the current foreground thread's input queue - inherits
  //      its foreground rights
  //   3) ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow
  if (process.platform === "win32") {
    const exeLiteral = info.execPath.replace(/'/g, "''");
    const psScript =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$sig=@'\n" +
      "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n" +
      "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);\n" +
      "[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();\n" +
      "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a,uint b,bool f);\n" +
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,uint f,int e);\n" +
      "'@;" +
      "$t=Add-Type -MemberDefinition $sig -Name W -Namespace U -PassThru;" +
      "[void]$t::keybd_event(0x12,0,0,0);" +
      "[void]$t::keybd_event(0x12,0,2,0);" +
      "for($i=0;$i -lt 25;$i++){" +
      "  Start-Sleep -Milliseconds 300;" +
      "  $p=Get-Process | Where-Object {$_.Path -eq '" + exeLiteral + "' -and $_.MainWindowHandle -ne 0} | Select-Object -First 1;" +
      "  if($p){" +
      "    $h=$p.MainWindowHandle;" +
      "    $fg=$t::GetForegroundWindow();" +
      "    $pid2=0;" +
      "    $fgTid=$t::GetWindowThreadProcessId($fg,[ref]$pid2);" +
      "    $curTid=$t::GetCurrentThreadId();" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$true);" +
      "    [void]$t::ShowWindow($h,9);" +
      "    [void]$t::BringWindowToTop($h);" +
      "    [void]$t::SetForegroundWindow($h);" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$false);" +
      "    break;" +
      "  }" +
      "}";
    try {
      const ps = spawn("powershell.exe", [
        "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-Command", psScript,
      ], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      // After detached + unref, async errors like ENOENT arrive as an 'error' event that
      // the outer try/catch cannot catch -> uncaught and the process dies.
      ps.on("error", (err) => log("ps bring-to-front spawn error: " + String(err?.message || err)));
      ps.unref();
      log("spawned ps bring-to-front helper (keybd+attach+setfg)");
    } catch (err) {
      log("ps bring-to-front spawn failed: " + String(err));
    }
  }
}

async function waitRestartGo() {
  const go = info.alivePath ? `${info.alivePath}.go` : "";
  if (!go) {
    await sleep(800);
    return;
  }
  for (let i = 0; i < 50; i++) {
    try { if (fs.existsSync(go)) return; } catch { /* not released yet */ }
    await sleep(100);
  }
}

await waitRestartGo();

let asarReleased = true;
if (info.killApp) {
  // #85: kill Electron first, then sleep + cleanup. The old order slept 400ms first, so
  // the host had exited while Electron still ran the stale close callback and popped a
  // crash dialog. New order: kill at once (killInstallElectronSync already ran host-side;
  // this is the backstop) - the faster Electron dies, the less the old callback can run.
  if (process.platform === "darwin") {
    await quitDarwinDesktop(info.execPath);
  } else if (process.platform === "win32") {
    killOtherDesktopProcesses(process.pid);
    await sleep(500);
    // Second pass: kill again to cover pids the first sweep missed
    killOtherDesktopProcesses(process.pid);
  } else {
    await quitPosixDesktop(info.execPath);
  }
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
} else {
  const gone = await waitPidGone(info.pid);
  if (!gone) process.exit(1);
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
}

if (info.respawn === false) {
  process.exit(asarReleased ? 0 : 1);
}

if (!info.execPath) process.exit(1);

if (info.asar && !asarReleased) {
  log("asar still sealed; relaunching sealed app");
}

await relaunchDesktop();
await sleep(400);
process.exit(0);
