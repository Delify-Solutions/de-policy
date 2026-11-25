import nodeFs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let cachedDiskFs;

/**
 * fs on the real disk.
 * Electron's bundled fs maps `resources/app` into a still-present `app.asar`, so creating files
 * inside it fails with ENOENT. Use this for extracting directories and for patching while the
 * archive is still there.
 * Without original-fs (non-Electron), fall back to node:fs.
 */
export function diskFs() {
  if (cachedDiskFs) return cachedDiskFs;
  process.noDeprecation = true;
  try {
    cachedDiskFs = createRequire(import.meta.url)("original-fs");
  } catch {
    cachedDiskFs = nodeFs;
  }
  return cachedDiskFs;
}

/**
 * asar probe cache (startup perf fix / F14 + F17).
 *
 * `asarShadowsPath()` walks up to 12 levels per call, 1-2 original-fs syscalls per level, so
 * **every** call through hostFs becomes ~25 syscalls. Measured:
 *   - findAiBaseWeb fallback dir scan over 60k dirs: bare node:fs 6.2 s -> 94 s through this layer;
 *   - after fixing the fallback scan, during module load this probe alone still took 24% of host
 *     startup CPU (4117 ms / 17226 ms).
 *
 * Two cache levels:
 *   1) persistent: 5 s TTL. Any **write** through hostFs clears it at once; the plugin helpers that
 *      move app.asar (renameAsarAside / extractAsarToSide / commitExtractedDir / …) clear it
 *      explicitly too. An out-of-process official updater swapping app.asar is covered by the 5 s
 *      TTL, and an official update restarts the host anyway.
 *   2) scoped: a hard cache explicitly opened/closed by withFsProbeCache(). The scope must not
 *      change the filesystem; it serves one-off bursts like a recursive dir scan with 100k calls.
 */

const PROBE_TTL_MS = 5000;
const PROBE_MAX_ENTRIES = 400000;

let probePersist = null;
let probePersistEpoch = 0;
let probeScope = null;

/** Drop every asar probe cache. Must be called after anything that can change app.asar. */
export function invalidateAsarProbes() {
  probePersist = new Map();
  probePersistEpoch = Date.now();
}

function activeProbes() {
  if (probeScope) return probeScope;
  const now = Date.now();
  if (!probePersist || now - probePersistEpoch >= PROBE_TTL_MS) invalidateAsarProbes();
  return probePersist;
}

/** Enable the hard cache for the given sync function (which must not touch the FS). Reentrant. */
export function withFsProbeCache(fn) {
  if (probeScope) return fn();
  probeScope = new Map();
  try {
    return fn();
  } finally {
    probeScope = null;
  }
}

function probeKey(kind, p) {
  return kind + String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function probeAsarFileIn(dir) {
  try {
    const asar = path.join(dir, "app.asar");
    return diskFs().existsSync(asar) && diskFs().statSync(asar).isFile();
  } catch {
    return false;
  }
}

function asarFileIn(dir) {
  if (!dir) return false;
  const cache = activeProbes();
  const k = probeKey("f:", dir);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = probeAsarFileIn(dir);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

function computeAsarShadows(raw) {
  let dir = path.normalize(raw);
  for (let i = 0; i < 12; i += 1) {
    const base = path.basename(dir).toLowerCase();
    if ((base === "app" || base.endsWith(".asar")) && asarFileIn(path.dirname(dir))) return true;
    if (asarFileIn(dir)) return true;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return false;
}

/** This path gets mapped by Electron into the sibling app.asar. False once extracted and archive moved. */
export function asarShadowsPath(targetPath) {
  const raw = String(targetPath || "").trim();
  if (!raw) return false;
  const cache = activeProbes();
  const k = probeKey("s:", raw);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = computeAsarShadows(raw);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

/**
 * Which fs the host files use.
 * With no app.asar (Web, third-party desktop, official bundle extracted and archive moved) keep node:fs.
 * While the archive is present and Electron maps resources/app into it, switch to the real disk.
 */
export function fsFor(targetPath) {
  return asarShadowsPath(targetPath) ? diskFs() : nodeFs;
}

function fsForPair(left, right) {
  return asarShadowsPath(left) || asarShadowsPath(right) ? diskFs() : nodeFs;
}

// These methods change the filesystem and may add/remove app.asar, so the probe cache must be
// invalidated before the call. openSync is deliberately excluded: it is mostly a read-only open,
// and including it would flush the cache.
const HOST_WRITE = new Set([
  "writeFileSync", "mkdirSync", "chmodSync", "unlinkSync", "rmSync",
  "renameSync", "appendFileSync", "symlinkSync", "copyFileSync",
]);

function route(method, pair) {
  const isWrite = HOST_WRITE.has(method);
  return (first, ...rest) => {
    if (isWrite) invalidateAsarProbes();
    const f = pair ? fsForPair(first, rest[0]) : fsFor(first);
    return f[method](first, ...rest);
  };
}

const HOST_SYNC = [
  "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
  "readdirSync", "mkdirSync", "realpathSync", "chmodSync", "unlinkSync",
  "rmSync", "renameSync", "appendFileSync", "openSync", "symlinkSync",
];

/** Pick node:fs or the real disk by path. Patches, probes and status all go through this one. */
export const hostFs = {
  copyFileSync: route("copyFileSync", true),
  promises: {
    readFile: (p, ...args) => fsFor(p).promises.readFile(p, ...args),
    writeFile: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.writeFile(p, ...args); },
    mkdir: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.mkdir(p, ...args); },
    unlink: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.unlink(p, ...args); },
    rm: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.rm(p, ...args); },
    copyFile: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.copyFile(src, dest, ...args); },
    rename: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.rename(src, dest, ...args); },
  },
};
for (const method of HOST_SYNC) hostFs[method] = route(method, false);
// closeSync / readSync take an fd, not a path. Going through route() would probe the number as a path.
// Without these two: core.js isTextShim fs.readSync / closeSync throws TypeError and every shim is
// judged binary (#127). On Windows an unclosed legacy backupAll placeholder handle also yields EPERM.
hostFs.closeSync = (fd, ...args) => nodeFs.closeSync(fd, ...args);
hostFs.readSync = (fd, buf, offset, length, position) => nodeFs.readSync(fd, buf, offset, length, position);

/** Electron disguises app.asar as a directory. Reading the archive must use original-fs,
 * else isFile is false and extraction fails. */
function archiveFs() {
  return diskFs();
}

function renameBusy(error) {
  const code = error && error.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export function renameAsarAside(asarPath) {
  // This step changes whether app.asar exists, so the asar probe cache must be dropped right away.
  invalidateAsarProbes();
  const afs = archiveFs();
  if (!asarPath || !afs.existsSync(asarPath)) return { renamed: false };
  const bak = `${asarPath}.bak`;
  try {
    if (afs.existsSync(bak)) afs.rmSync(bak, { force: true });
    afs.renameSync(asarPath, bak);
    return { renamed: true, bak };
  } catch (error) {
    if (renameBusy(error)) return { renamed: false, busy: true, bak };
    throw error;
  }
}

export function asarArchiveIsFile(p) {
  try {
    const afs = archiveFs();
    return Boolean(p) && afs.existsSync(p) && afs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Recognize the same archive by size and mtime. */
export function asarFileIdentity(asarPath) {
  try {
    const st = archiveFs().statSync(asarPath);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function sameAsarIdentity(left, right) {
  return Boolean(
    left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs,
  );
}

/**
 * Usable dir paired with the same archive: do not extract.
 * Dir missing, or the recorded archive size/time changed: extract once.
 * Upgrade marker hit another archive: extract once too. Dir present, never recorded, not an
 * upgrade: trust the archive, do not extract.
 */
export function shouldExtractAsar({ usable, identity, recorded, upgrade }) {
  if (!identity) return false;
  if (!usable) return true;
  const same = sameAsarIdentity(identity, recorded);
  if (upgrade && !same) return true;
  if (recorded && !same) return true;
  return false;
}

function readHeader(fd, afs) {
  const pre = Buffer.alloc(16);
  if (afs.readSync(fd, pre, 0, 16, 0) !== 16) throw new Error("asar header truncated");
  if (pre.readUInt32LE(0) !== 4) throw new Error("not an asar archive");
  const headerSize = pre.readUInt32LE(4);
  const jsonSize = pre.readUInt32LE(12);
  if (!headerSize || !jsonSize || jsonSize > 256 * 1024 * 1024) throw new Error("asar header size invalid");
  const jsonBuf = Buffer.alloc(jsonSize);
  if (afs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) throw new Error("asar header short");
  return {
    header: JSON.parse(jsonBuf.toString("utf8")),
    dataOffset: 8 + headerSize,
  };
}

function walk(node, prefix, out) {
  const files = node && node.files;
  if (!files) return;
  for (const [name, info] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (info && info.files) walk(info, rel, out);
    else if (info) out.push({ rel, info });
  }
}

function copyRange(afs, fd, offset, size, outPath) {
  const outFs = diskFs();
  const out = outFs.openSync(outPath, "w");
  try {
    const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
    let left = size;
    let pos = offset;
    while (left > 0) {
      const n = afs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) throw new Error(`asar short read at ${outPath}`);
      outFs.writeSync(out, buf, 0, n);
      pos += n;
      left -= n;
    }
  } finally {
    outFs.closeSync(out);
  }
}

/** Files flagged unpacked inside asar are not in the archive body. They must be copied
 * into resources/app before starting the extracted dir. */
export function overlayAsarUnpacked(asarPath, destDir) {
  const outFs = diskFs();
  const unpacked = `${asarPath}.unpacked`;
  if (!destDir || !outFs.existsSync(unpacked)) return { copied: 0, missing: true };
  let copied = 0;
  const walk = (dir) => {
    for (const ent of outFs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, ent.name);
      const to = path.join(destDir, path.relative(unpacked, from));
      if (ent.isDirectory()) {
        outFs.mkdirSync(to, { recursive: true });
        walk(from);
      } else if (ent.isFile()) {
        if (outFs.existsSync(to)) continue;
        outFs.mkdirSync(path.dirname(to), { recursive: true });
        outFs.copyFileSync(from, to);
        copied += 1;
      }
    }
  };
  walk(unpacked);
  return { copied };
}

function discardDir(dir) {
  if (!dir) return;
  try { diskFs().rmSync(dir, { recursive: true, force: true }); } catch { /* cleaned next run */ }
}

function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function ensureDirWritable(dir) {
  if (!dir) return;
  const fs = diskFs();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  try { if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755); } catch { /* read-only disk: error on write */ }
}

function writeAsarEntry(afs, fd, destDir, entry, dataOffset, outFs) {
  const info = entry.info;
  const outPath = path.join(destDir, ...entry.rel.split("/"));
  outFs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (info.unpacked) return false;
  if (typeof info.link === "string") {
    const linkResolved = path.resolve(path.dirname(outPath), info.link);
    const destResolved = path.resolve(destDir);
    const inside = linkResolved === destResolved
      || linkResolved.startsWith(destResolved + path.sep);
    if (!inside) return false;
    try {
      outFs.symlinkSync(info.link, outPath);
    } catch {
      /* skip when a link cannot be created; the main program files stay in the archive */
    }
    return false;
  }
  const size = Number(info.size || 0);
  const offset = dataOffset + Number(info.offset || 0);
  if (size === 0) {
    outFs.writeFileSync(outPath, Buffer.alloc(0));
  } else {
    copyRange(afs, fd, offset, size, outPath);
  }
  return true;
}

/** Extract into a directory beside the target. On failure delete the half-done copy, never the one in use. */
export async function extractAsarToSide(asarPath, destDir) {
  const next = `${destDir}.dshpurge-next`;
  discardDir(next);
  try {
    ensureDirWritable(path.dirname(destDir));
    ensureDirWritable(next);
    const count = await extractAsarAsync(asarPath, next);
    return { next, count };
  } catch (error) {
    discardDir(next);
    throw error;
  }
}

function restoreFromPrev(fs, destDir, prev) {
  if (!prev || fs.existsSync(destDir)) return false;
  try {
    fs.renameSync(prev, destDir);
    return true;
  } catch {
    return false;
  }
}

/** Move the old dir aside and swap the new one in only after extraction finished. If the swap
 * fails put the old dir back; if it still fails write recover.json keeping nextDir for a retry. */
export function commitExtractedDir(destDir, nextDir) {
  const fs = diskFs();
  if (!nextDir || !fs.existsSync(nextDir)) throw new Error("Thư mục giải nén không tồn tại");
  let prev = "";
  if (fs.existsSync(destDir)) {
    prev = `${destDir}.dshpurge-prev`;
    if (fs.existsSync(prev)) prev = `${destDir}.dshpurge-prev-${Date.now()}`;
    fs.renameSync(destDir, prev);
  }
  try {
    fs.renameSync(nextDir, destDir);
  } catch (error) {
    const restored = restoreFromPrev(fs, destDir, prev);
    const recoverFp = `${destDir}.dshpurge-recover.json`;
    try {
      fs.writeFileSync(recoverFp, JSON.stringify({
        when: new Date().toISOString(),
        destDir,
        nextDir,
        prev,
        prevRestored: restored,
        error: String(error?.message || error),
      }, null, 2));
    } catch { /* recovery info is best effort */ }
    const err = new Error(
      `commitExtractedDir failed; nextDir kept at ${nextDir}, prev at ${prev}, recover=${recoverFp}: ${error && error.message || error}`
    );
    err.cause = error;
    err.recover = recoverFp;
    throw err;
  }
  return { prev };
}

/** Old dir that the upgrade script moved aside earlier. Put it back when patching did not finish. */
export function newestPreservedDir(destDir) {
  const fs = diskFs();
  const parent = path.dirname(destDir);
  const prefix = `${path.basename(destDir)}.dshpurge-prev`;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return ""; }
  let best = "";
  let bestTime = -1;
  for (const name of names) {
    if (name !== prefix && !name.startsWith(`${prefix}-`)) continue;
    const full = path.join(parent, name);
    let time = 0;
    try { time = fs.statSync(full).mtimeMs; } catch { continue; }
    if (time >= bestTime) {
      best = full;
      bestTime = time;
    }
  }
  return best;
}

/** Patching did not finish: put the old dir moved aside just now back in place. */
export function restoreExtractedDir(destDir, prev) {
  const fs = diskFs();
  if (!prev || !fs.existsSync(prev)) return false;
  let failed = "";
  if (fs.existsSync(destDir)) {
    failed = `${destDir}.dshpurge-failed-${Date.now()}`;
    fs.renameSync(destDir, failed);
  }
  try {
    fs.renameSync(prev, destDir);
  } catch (error) {
    if (failed && !fs.existsSync(destDir)) {
      try { fs.renameSync(failed, destDir); } catch { /* old dir still in prev */ }
    }
    throw error;
  }
  if (failed) {
    try { fs.rmSync(failed, { recursive: true, force: true }); } catch { /* broken dir is harmless */ }
  }
  return true;
}

export function extractAsar(asarPath, destDir) {
  const afs = archiveFs();
  const fd = afs.openSync(asarPath, "r");
  let count = 0;
  try {
    const { header, dataOffset } = readHeader(fd, afs);
    const entries = [];
    walk(header, "", entries);
    const outFs = diskFs();
    outFs.mkdirSync(destDir, { recursive: true });
    for (const entry of entries) {
      if (writeAsarEntry(afs, fd, destDir, entry, dataOffset, outFs)) count += 1;
    }
  } finally {
    afs.closeSync(fd);
  }
  return count;
}

/** Yield the event loop while extracting so /status is not blocked by sync writes on Mac
 * (which shows up as a read failure). */
export async function extractAsarAsync(asarPath, destDir) {
  const afs = archiveFs();
  const fd = afs.openSync(asarPath, "r");
  let count = 0;
  try {
    const { header, dataOffset } = readHeader(fd, afs);
    const entries = [];
    walk(header, "", entries);
    const outFs = diskFs();
    outFs.mkdirSync(destDir, { recursive: true });
    let n = 0;
    for (const entry of entries) {
      if (writeAsarEntry(afs, fd, destDir, entry, dataOffset, outFs)) count += 1;
      n += 1;
      if (n % 8 === 0) await yieldTick();
    }
  } finally {
    afs.closeSync(fd);
  }
  return count;
}
