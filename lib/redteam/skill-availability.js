/**
 * Skill availability self-check (zero-dependency, the **single** verdict logic shared
 * by tools and UI)
 *
 * Why it exists: skill bodies name local paths / env vars / VPS addresses, but **a skill
 * being listable ≠ runnable**. A missing `FOFA_KEY`, a tool not dropped into
 * `$DSH_HOME/redteam/toolkit/`, a VPS still left as a placeholder — all of that is only
 * discovered once you are actually working, already inside the target. So the verdict
 * lives in one place:
 *   · agent side — `redteam_preflight` runs it before work starts and asks the user for
 *     whatever is missing;
 *   · panel side — the skill library tab labels each skill with its availability.
 *
 * Every issue also carries a **fix** (`issues[].fix`, text from `skill-fixes.js`): the
 * panel does not just say "unavailable", it tells the user how to fix it. `problems`
 * stays as a plain-text view for older callers.
 *
 * Dimensions (all objectively readable from the skill body):
 *   1) can the body load — the whole skill is marked unavailable only when the body is
 *      unreadable **and** the file really is not on this machine. With the body in hand
 *      (host supplied content) the model can load the skill; a missing path is then only
 *      a trace of an **older install / another machine** (paths are absolute, so a
 *      machine change points nowhere) and must not mark it unavailable;
 *   2) env vars (`os.environ["X"]` / `process.env.X`; `os.environ.get("X", "…")` with a
 *      default does not count);
 *   3) local paths referenced in the body (absolute paths under toolkit / bin / local,
 *      `$DSH_HOME`, `~/`);
 *   4) external infrastructure placeholders (e.g. an unfilled `<your VPS IP>`).
 * 2/3/4 are recorded as gaps only. If the body documents an alternative, the skill still
 * loads with a missing tool or key.
 *
 * Not judged: semantic correctness, permissions, target reachability — only a real run
 * reveals those.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixesForIssue } from './skill-fixes.js'

/** Expand $DSH_HOME / ${DSH_HOME} / ~ (all forms appear in skill bodies). */
export function expandSkillPath(p, env = process.env) {
  const dshHome = env.DSH_HOME || resolve(homedir(), '.dsh')
  let out = String(p).trim()
  out = out.replace(/\$\{DSH_HOME\}/g, dshHome).replace(/\$DSH_HOME/g, dshHome)
  if (out.startsWith('~/')) out = resolve(homedir(), out.slice(2))
  return out
}

/**
 * The two possible `$DSH_HOME` sources on this machine.
 *
 * The plugin process resolves `process.env.DSH_HOME || homedir()/.dsh`; the host's
 * `dshHomePath()` uses its own home. They diverge after a drive change, a profile change,
 * or on a machine where `HOME` is empty, and honoring only one marks skill copies and
 * toolkit paths as "missing" (the main reason skills show unavailable on other machines).
 */
export function dshHomeCandidates(env = process.env) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(env.DSH_HOME)
  push(resolve(homedir(), '.dsh'))
  return out
}

/** A referenced path counts as existing when it exists under **any** candidate home
 *  (honoring env alone reports a whole toolkit as missing). */
export function existsUnderAnyHome(raw, env = process.env) {
  for (const home of dshHomeCandidates(env)) {
    if (existsSync(expandSkillPath(raw, { ...env, DSH_HOME: home }))) return true
  }
  return false
}

/** Extract the required-but-unset env var names from a skill body. */
export function requiredEnvOf(content) {
  const names = new Set()
  const body = String(content || '')
  /* Node side: process.env.X (there is no default-value form) */
  for (const m of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1])
  /* Python side: os.environ["X"] is required; os.environ.get("X", "default") falls back,
     so it does not count */
  for (const m of body.matchAll(/os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]{2,})["']\s*(,)?/g)) {
    if (m[2] === undefined) names.add(m[1])
  }
  /* Shell side: ${X:?required} is explicitly required; a bare $X is not judged (skills are
     full of $TARGET-style placeholders) */
  for (const m of body.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):\?/g)) names.add(m[1])
  return Array.from(names)
}

/** Docs are not tools. Filenames from another OS or CPU also never make this system
 *  report unavailable. */
export function pathCountsOnThisHost(raw, platform = process.platform, arch = process.arch) {
  const base = String(raw).replace(/\\/g, '/').split('/').pop() || ''
  if (/\.(md|txt|json|ya?ml|csv)$/i.test(base)) return false
  const token = (name) => new RegExp('(?:^|[._-])(?:' + name + ')(?:[._-]|$)', 'i').test(base)
  if (platform === 'win32' && /\.(sh|bash)$/i.test(base)) return false
  if (platform === 'win32' && /\/\.local\/|\/\.kimi-webbridge\//.test(String(raw).replace(/\\/g, '/'))) return false
  const isWinName = /\.exe$/i.test(base) || token('windows|win32|win64')
  const isDarwin = token('darwin|macos')
  const isLinux = token('linux')
  const isArm = token('arm64|aarch64')
  const isAmd = token('amd64|x64|x86_64')
  if (platform === 'win32' && (isLinux || isDarwin)) return false
  if (platform === 'darwin' && (isWinName || isLinux)) return false
  if (platform !== 'win32' && platform !== 'darwin' && (isWinName || isDarwin)) return false
  if (isArm && arch !== 'arm64') return false
  if (isAmd && arch !== 'x64') return false
  return true
}

/** Local paths referenced in the body whose existence is checkable (absolute paths under
 *  toolkit / bin / local). */
export function referencedPathsOf(content) {
  const out = new Set()
  for (const m of String(content || '').matchAll(/(?:~|\$DSH_HOME|\/home\/[^\s"'`,)]+?)\/[\w./\u4e00-\u9fa5-]+/g)) {
    const raw = m[0].replace(/[，。；、：)）\]]+$/, '')
    if (!/\/(toolkit|bin|local)\//.test(raw)) continue
    if (/[<>{}*|]/.test(raw)) continue
    if (!pathCountsOnThisHost(raw)) continue
    out.add(raw)
  }
  return Array.from(out)
}

/** Parse the YAML frontmatter at the top of a skill file (single-line scalars only,
 *  enough for name/description/category/whenToUse). */
function readFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''))
  if (m === null) return {}
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv === null) continue
    out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** When the host skill service lists nothing, use this package's skills/redteam and
 *  $DSH_HOME/redteam/skills. */
export function bundledSkillSummaries() {
  const here = dirname(fileURLToPath(import.meta.url))
  /* Scan both candidate homes: the host lists skills from its own home via dshHomePath,
     so scanning only the env one shows "installed but unlistable" on divergent machines. */
  const dirs = [join(here, '..', '..', 'skills', 'redteam')]
  for (const home of dshHomeCandidates()) {
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const file of names) {
      if (!file.endsWith('.md')) continue
      const name = file.slice(0, -3)
      if (seen.has(name)) continue
      const filePath = join(dir, file)
      let content = ''
      try { content = readFileSync(filePath, 'utf8') } catch { content = '' }
      if (!content.trim()) continue
      seen.add(name)
      /* frontmatter description/category/whenToUse win, the body H1 is the fallback.
         category groups the panel's skill library by folder (recon / intranet / tunnel
         / scoring…). */
      const fm = readFrontmatter(content)
      const title = (content.match(/^#\s+(.+)$/m) || [])[1] || name
      out.push({
        name,
        description: String(fm.description || title).trim(),
        whenToUse: String(fm.whenToUse || '').trim(),
        category: String(fm.category || '').trim(),
        content,
        path: filePath,
        library: 'redteam',
        resourceBase: { kind: 'directory', path: dir },
      })
    }
  }
  return out
}

/** Official skills live in `$DSH_HOME/skills`. Redteam skills live in this package's
 *  `skills/redteam` or `$DSH_HOME/redteam/skills`. */
export function skillLibraryOf(summary) {
  if (!summary || typeof summary !== 'object') return ''
  if (summary.library === 'official' || summary.library === 'redteam') return summary.library
  const n = [summary.path, summary.dir, summary.root, summary.resourceBase && summary.resourceBase.path]
    .filter((item) => typeof item === 'string')
    .join('\n')
    .replace(/\\/g, '/')
  if (/\/skills\/redteam(\/|$)/.test(n) || /\/redteam\/skills(\/|$)/.test(n)) return 'redteam'
  if (/\/skills(\/|$)/.test(n)) return 'official'
  return ''
}

/** Official user skills. Redteam tool paths are never used to judge them. */
export function officialSkillSummaries() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'skills')
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || entry.name === '.system' || entry.name.startsWith('.')) continue
    let filePath = ''
    let name = ''
    if (entry.isDirectory()) {
      filePath = join(dir, entry.name, 'SKILL.md')
      name = entry.name
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
      filePath = join(dir, entry.name)
      name = entry.name.slice(0, -3)
    } else {
      continue
    }
    if (seen.has(name) || !existsSync(filePath)) continue
    let content = ''
    try { content = readFileSync(filePath, 'utf8') } catch { continue }
    if (!content.trim()) continue
    seen.add(name)
    const title = (content.match(/^description:\s*(.+)$/m) || content.match(/^#\s+(.+)$/m) || [])[1] || name
    out.push({
      name,
      description: String(title).trim().replace(/^['"]|['"]$/g, ''),
      content,
      path: filePath,
      library: 'official',
      resourceBase: { kind: 'directory', path: dir },
    })
  }
  return out
}

/** The redteam self-check uses redteam skills only. Official skills take no part in path
 *  judging even when the host lists them. */
export function redteamSummariesForCheck(summaries, bundled, scoped) {
  const base = Array.isArray(bundled) ? bundled : []
  const names = new Set(base.map((item) => item && item.name).filter(Boolean))
  const picked = []
  const seen = new Set()
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary || !summary.name || seen.has(summary.name)) continue
    const library = skillLibraryOf(summary)
    if (library === 'official') continue
    if (library === 'redteam' || scoped === true || names.has(summary.name)) {
      seen.add(summary.name)
      picked.push(summary)
    }
  }
  for (const item of base) {
    if (!item || !item.name || seen.has(item.name)) continue
    seen.add(item.name)
    picked.push(item)
  }
  return picked
}

/** Read a same-named skill body from a root (null when unreadable). */
export function readSkillFromRoot(root, name) {
  if (typeof root !== 'string' || root === '') return null
  for (const dir of [root, resolve(root, String(name || ''))]) {
    for (const file of [resolve(dir, String(name || '') + '.md'), resolve(dir, 'SKILL.md')]) {
      try { if (existsSync(file)) return { path: file, content: readFileSync(file, 'utf8') } } catch { /* try the next one */ }
    }
  }
  return null
}

/** Call the fix-text generator; any exception degrades to an empty string (the
 *  availability verdict must not fail because of text). */
function safeFix(issue) {
  try { return String(fixesForIssue(issue) || '') } catch { return '' }
}

/**
 * Check one skill's availability.
 *
 * @param skill - `{ name, description?, content?, path?, root? }` (content is the skill
 *   body, root is the skill root it came from).
 * @param options - `{ env?: NodeJS.ProcessEnv, sameNameIn?: string[] }`.
 *   `sameNameIn` lists the **other roots that also register a same-named skill**: same
 *   names are resolved by root order, and a later copy gets "shadowed". It is used to
 *   detect "the bundled placeholder version is what actually loads while your configured
 *   copy sits later in the order".
 * @returns `{ name, status: 'available'|'broken'|'unknown', issues, problems, needs_user,
 *   checked, shadowed_by? }`
 *   `issues` is a `{ kind, detail, fix }` list (`kind` ∈ file-missing / content-missing /
 *   env-missing / path-missing / placeholder / shadowed); `problems` is its detail text
 *   view. Missing paths, missing keys and unfilled placeholders stay in issues and never
 *   turn status into broken.
 *   status='unknown' means "body unreadable, cannot judge" (e.g. a remote skill with
 *   metadata only and a failed body load).
 */
export function checkSkill(skill, options = {}) {
  const env = options.env || process.env
  const name = skill && skill.name ? String(skill.name) : '(chưa đặt tên)'
  const content = skill && typeof skill.content === 'string' ? skill.content : ''
  const file = skill && typeof skill.path === 'string' ? skill.path : null
  const root = skill && typeof skill.root === 'string' ? skill.root : null
  const issues = []
  const needsUser = []
  /** Record one issue: detail is the user-facing "why unavailable", fix is "how to fix"
   *  (see skill-fixes.js). */
  const addIssue = (kind, detail, extra) => {
    const payload = Object.assign({ kind, skill: name }, extra || {})
    let fix = ''
    try { fix = String(fixesForIssue(payload) || '') } catch { fix = '' }
    issues.push(Object.assign({ kind, detail, fix }, extra || {}))
  }

  if (content.trim() === '') {
    /* Body unreadable, split in two: the file should be here but is gone (really
       unloadable → broken), otherwise (metadata only / remote source / host gave no body
       → cannot judge → unknown). */
    const gone = file !== null && !existsSync(file)
    const detail = gone
      ? 'Tệp kỹ năng không tồn tại trên máy này, cũng không đọc được nội dung: ' + file
      : 'Không đọc được nội dung kỹ năng (chỉ có metadata): không thể đánh giá khả dụng, khi cần hãy dùng công cụ `skill` để nạp thật một lần'
    const kind = gone ? 'file-missing' : 'content-missing'
    return {
      name,
      status: gone ? 'broken' : 'unknown',
      issues: [{ kind, detail, fix: safeFix({ kind, skill: name, file: file || undefined }) }],
      problems: [detail],
      needs_user: [],
      checked: { file, env: [], paths: [] },
    }
  }
  /* Body in hand = the skill loads. The path here is a hint only: it is an absolute path
     resolved on some earlier machine and necessarily points nowhere after a machine
     change — record a non-blocking file-stale, never mark the skill unavailable. */
  if (file !== null && !existsSync(file)) {
    addIssue('file-stale', 'Đường dẫn tệp mà kỹ năng ghi lại không tồn tại trên máy này (nội dung kỹ năng vẫn nạp được): ' + file, { file })
  }

  const envNames = requiredEnvOf(content)
  const missingEnv = envNames.filter((n) => !env[n])
  for (const n of missingEnv) {
    addIssue('env-missing', 'Thiếu biến môi trường ' + n, { env: n })
  }

  const paths = referencedPathsOf(content)
  const missingPaths = paths.filter((p) => !existsUnderAnyHome(p, env))
  if (missingPaths.length > 0) {
    addIssue('path-missing', 'Đường dẫn máy này được tham chiếu không tồn tại: ' + missingPaths.slice(0, 6).join(', ')
      + (missingPaths.length > 6 ? ' và ' + missingPaths.length + ' chỗ khác' : ''), { paths: missingPaths })
  }

  /* External infrastructure placeholders: a `<your VPS IP>`-style token in the skill
     means it is not configured yet.
     But **a configured deployment must not be misreported**: as soon as REDTEAM_VPS_HOST
     has a value, placeholders in the body are just documentation style (real commands
     substitute the configured value) and are no longer a gap.
     The order must be "configuration first, then placeholders", otherwise machines with
     a configured VPS show these skills as broken forever (template placeholders mixed
     with real configuration). */
  const vpsConfigured = typeof env.REDTEAM_VPS_HOST === 'string' && env.REDTEAM_VPS_HOST.trim() !== ''
  const placeholders = []
  if (!vpsConfigured) {
    if (content.includes('<你的VPS_IP>') || content.includes('<VPS_IP>')) placeholders.push('VPS address')
    if (content.includes('<你的VPS_主机名>') || content.includes('<VPS 主机名>')) placeholders.push('VPS hostname')
  }
  for (const p of placeholders) {
    addIssue('placeholder', p + ' vẫn là placeholder (trong kỹ năng ghi placeholder, nghĩa là máy này/môi trường này chưa cấu hình)', { placeholder: p })
    needsUser.push(p)
  }
  for (const n of missingEnv) needsUser.push('biến môi trường ' + n)

  /* Backstop: a same-named skill exists in another root with "fewer problems" (usually
     the user's own configured copy, shadowed by a bundled placeholder version ranked
     earlier). Say so honestly instead of making the user think the env is unconfigured. */
  let shadowed = null
  for (const other of Array.isArray(options.sameNameIn) ? options.sameNameIn : []) {
    if (other === root) continue
    const alt = readSkillFromRoot(other, name)
    if (alt === null || alt.content === content) continue
    const verdict = checkSkill({ name, content: alt.content, path: alt.path }, { env })
    if (verdict.status === 'available' || verdict.problems.length < issues.length) {
      shadowed = { root: other, path: alt.path, status: verdict.status }
      addIssue('shadowed', 'Trong `' + other + '` còn một bản kỹ năng cùng tên (' + verdict.status + '), '
        + 'nhưng theo thứ tự gốc kỹ năng thì bản đang nạp là bản này (các lý do không khả dụng ở trên đến từ bản này)', { other_root: other })
      break
    }
  }

  /* Reaching here means the body was readable → available. Missing tools / keys /
     placeholders / paths from another machine are recorded as gaps only. */
  return {
    name,
    status: 'available',
    issues,
    problems: issues.map((x) => x.detail),
    needs_user: Array.from(new Set(needsUser)),
    ...(shadowed === null ? {} : { shadowed_by: shadowed.root, shadowed_path: shadowed.path }),
    checked: { file, env: envNames, missing_env: missingEnv, paths, missing_paths: missingPaths },
  }
}

/** Summarize a batch of skill states (used by the panel header badges and
 *  redteam_preflight's return value). */
export function summarizeSkills(results) {
  const out = { total: results.length, available: 0, broken: 0, unknown: 0 }
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1
  return out
}
