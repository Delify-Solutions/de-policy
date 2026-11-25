// Core invariants the red-team engine must keep.
//
// These do not test features — they test the three things a translation of this
// size can silently break, each of which has already broken once during the port:
//
//   1. A parser that reads model output must accept the three languages an
//      operator writes in. Translating the prompts moved that output from Chinese
//      to English and Vietnamese, so a parser that only matched Chinese would
//      quietly score nothing.
//   2. A label one module produces and another compares against must stay equal.
//      The score label went from `强` to `Mạnh` while the panel kept comparing the
//      old value, so a strong proof always rendered as a warning.
//   3. Every module must load. A comment edit that removes a `*/` parses as a
//      syntax error and is caught by `node --check`, but an edit that changes
//      behaviour still loads — so the two below are the ones worth pinning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Modules under test resolve $DSH_HOME lazily; give them a throwaway one so a
// run never reads or writes the developer's real profile.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'de-policy-test-'))
process.env.DATA_DIR = process.env.DSH_HOME

// Installs a stub `@deepseek-ai/dsh-tools` into that throwaway DSH_HOME. Imported
// first so it runs before `lib/redteam/tools.js` resolves its host dependency.
await import('./host-stub.mjs')

const score = await import('../lib/redteam/score-rules.js')
const store = await import('../lib/redteam/store-core.js')
const validate = await import('../lib/redteam/validate.js')
const netScope = await import('../lib/net-scope.js')

/* ── 1. parsers accept all three languages ─────────────────────────────── */

test('parseRowCount: Chinese', () => {
  assert.equal(score.parseRowCount('导出 1.32 亿条用户数据'), 132_000_000)
  assert.equal(score.parseRowCount('导出 1,320,000 条'), 1_320_000)
})

test('parseRowCount: English', () => {
  assert.equal(score.parseRowCount('exported 132,000,000 user records'), 132_000_000)
  assert.equal(score.parseRowCount('exported 1.32 million records'), 1_320_000)
  assert.equal(score.parseRowCount('1,320,000 rows'), 1_320_000)
})

test('parseRowCount: Vietnamese', () => {
  assert.equal(score.parseRowCount('xuất 132 triệu bản ghi'), 132_000_000)
  assert.equal(score.parseRowCount('1.320.000 dòng'), 1_320_000)
})

test('parseRowCount: a bare number is not a data volume', () => {
  // A port, a password or an id must never be read as a record count.
  assert.equal(score.parseRowCount('123456'), null)
  assert.equal(score.parseRowCount('port 3306'), null)
  assert.equal(score.parseRowCount(''), null)
})

test('parseByteVolume: bytes are parsed separately from rows', () => {
  assert.equal(score.parseByteVolume('12TB of training data').tb, 12)
  assert.equal(score.parseByteVolume('1.5 TB').tb, 1.5)
  assert.equal(score.parseByteVolume('800GB').tb, 0.8)
  assert.equal(score.parseByteVolume('导出 12TB 训练数据').tb, 12)
  assert.equal(score.parseByteVolume('1,320,000 records'), null)
})

test('parseByteVolume: no row-count conversion is invented', () => {
  // 800GB must not become "781 million rows" and clear the 100M row threshold.
  const gb = score.parseByteVolume('800GB')
  assert.equal(gb.rows, undefined)
  assert.ok(gb.tb < 10, '800GB is below the 10TB half of the G5 threshold')
  assert.equal(score.parseRowCount('800GB'), null)
})

test('the two G5 thresholds are independent constants', () => {
  assert.equal(score.SENSITIVE_DATA_MIN_ROWS, 1_000_000)
  assert.equal(score.SENSITIVE_DATA_MIN_TB, 10)
})

test('shell-type recognition: all three languages', () => {
  assert.equal(validate.normalizeShellType('behinder'), 'behinder')
  assert.equal(validate.normalizeShellType('冰蝎'), 'behinder')
  assert.equal(validate.normalizeShellType('con bọ'), 'behinder')
  assert.equal(validate.normalizeShellType('godzilla'), 'godzilla')
  assert.equal(validate.normalizeShellType('哥斯拉'), 'godzilla')
  assert.equal(validate.normalizeShellType('quái thú'), 'godzilla')
  assert.equal(validate.normalizeShellType('antSword'), 'antSword')
  assert.equal(validate.normalizeShellType('蚁剑'), 'antSword')
  assert.equal(validate.normalizeShellType('custom'), 'custom')
  assert.equal(validate.normalizeShellType('tự viết'), 'custom')
})

test('the intent gate fires in all three languages', () => {
  for (const text of [
    '对这个站做渗透',
    'run a pentest against the host',
    'tấn công vào server này',
    'quét cổng 1.2.3.4',
  ]) {
    assert.equal(netScope.isAttackTask(text), true, `should be an attack task: ${text}`)
  }
})

test('the intent gate leaves a benign message alone', () => {
  for (const text of [
    '渗透测试报告怎么写的规范',
    'how do I set up a proxy in my browser',
    'địa chỉ ip của tôi là gì',
  ]) {
    assert.equal(netScope.isAttackTask(text), false, `should be benign: ${text}`)
  }
})

/* ── 2. labels stay equal across modules ───────────────────────────────── */

test('the score label the store emits is the one the panel compares against', async () => {
  // The panel is a separate bundle and cannot be imported here, so this pins the
  // value the store produces. If it changes, the panel comparison must change too.
  const label = store.strengthLabelOf
    ? store.strengthLabelOf(true)
    : null
  if (label !== null) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
  }
  // The label must be reproducible from the exported constant set.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/redteam/store-core.js', import.meta.url), 'utf8'),
  )
  const match = source.match(/const strength = strong \? '([^']+)'/)
  assert.ok(match, 'store-core still declares the strength label')
  assert.equal(match[1], 'Mạnh', 'the label the panel must compare against')
})

/* ── 3. prompts and descriptions are English ──────────────────────────── */

test('the six role prompts exist and are English', () => {
  const roles = Object.keys(store.DEFAULT_PROMPTS)
  assert.deepEqual(roles, ['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal'])
  for (const role of roles) {
    const body = store.DEFAULT_PROMPTS[role]
    assert.ok(body.length > 500, `${role} prompt is substantial`)
    // A prompt may quote a foreign token as an example ("万/亿" as magnitude words).
    // What it must not do is be written in another language: a Chinese sentence is
    // long runs of Han; an example is a few characters between punctuation.
    const runs = body.match(/[\u4e00-\u9fff]+/g) || []
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0)
    assert.ok(longest <= 2, `${role} prompt carries a Chinese phrase: "${runs.find((r) => r.length === longest)}"`)
  }
})

test('every score point still exists after translation', () => {
  assert.equal(score.DEFAULT_SCORE_POINTS.length, 25)
  assert.equal(Object.keys(score.SCORE_CONFIRM).length, 25)
  for (const point of score.DEFAULT_SCORE_POINTS) {
    assert.ok(point.code, 'a point has a code')
    assert.ok(typeof point.name === 'string' && point.name.length > 0)
    const han = String(point.name).match(/[\u4e00-\u9fff]/g)
    assert.equal(han, null, `point ${point.code} name is translated`)
  }
})

/* ── 4. every tool registers ───────────────────────────────────────────── */

test('all 67 tool definitions register against a cordis-like context', async () => {
  // `tools.js` resolves `@deepseek-ai/dsh-tools` from the installed host at module
  // load and throws when it cannot — deliberate, so the preset learns the host is
  // missing. `test/host-stub.mjs` installs the one export it needs into a throwaway
  // DSH_HOME; it must run before the import below, which is why it is a separate
  // module rather than inline setup.
  const registered = []
  const ctx = {
    tools: { register: (spec) => registered.push(spec.name) },
    get: () => null,
    effect: () => {},
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
    locale: { bind: () => (key) => key, register() {} },
  }
  const tools = await import('../lib/redteam/tools.js')
  await tools.apply(ctx)
  assert.equal(registered.length, 67)
  assert.ok(registered.every((name) => name.startsWith('redteam_')))
  assert.equal(new Set(registered).size, 67, 'no duplicate tool names')
})

/* ── 5. cross-module string contracts ──────────────────────────────────── */

test('needs_user strings from skill-availability are recognised by tools', async () => {
  // `skill-availability.js` produces these strings and `tools.js` decorates them.
  // When the source moved from Chinese to Vietnamese the decoration silently
  // stopped firing — the string passed through untranslated and the operator saw
  // "biến môi trường FOFA_KEY" with no hint about where to set it.
  const availability = await import('../lib/redteam/skill-availability.js')
  const skillPath = new URL('../skills/redteam/fofa-recon.md', import.meta.url)
  const { readFileSync } = await import('node:fs')

  const verdict = availability.checkSkill(
    { name: 'fofa-recon', content: readFileSync(skillPath, 'utf8') },
    { env: {} },
  )
  const produced = verdict.needs_user || []
  assert.ok(produced.length > 0, 'a skill with a missing env var reports a need')

  // The mapping lives inline in tools.js and cannot be imported, so this pins the
  // shape it must accept. If the producer changes its prefix, this fails.
  const decorate = (n, win = false) => {
    const envVar = /^(?:biến môi trường|环境变量)\s+(\S+)/i.exec(n)
    if (envVar) {
      return 'Biến môi trường ' + envVar[1]
        + (win ? ' (ở trang Thích ứng môi trường)' : ' (export rồi khởi động lại)')
    }
    if (/^VPS\s+(address|hostname|地址|主机名)/i.test(n)) return 'Thông tin VPS: ' + n
    return n
  }

  for (const item of produced) {
    const decorated = decorate(item)
    assert.notEqual(
      decorated,
      item,
      `"${item}" was not recognised — the prefix the producer emits must match the consumer`,
    )
  }
})

test('every number format the prompts tell the model to write actually parses', async () => {
  // The scoring warning tells the operator to write the volume into `evidence`. If
  // the prompt shows a format the parser rejects, a correct report scores nothing —
  // and nothing visibly fails, the score is just quietly lower.
  const all = Object.values(store.DEFAULT_PROMPTS).join('\n')
  const quoted = [...all.matchAll(/"([^"]+)"/g)].map((m) => m[1])

  // Only strings that name a unit. A bare 4-digit run is a year or a CVE id.
  const volumeish = quoted.filter(
    (t) => /\b(records?|rows?|entries|bản ghi|dòng)\b/i.test(t) || /\b(TB|GB|MB|TiB|GiB)\b/.test(t),
  )
  assert.ok(volumeish.length > 0, 'the prompts show at least one volume example')

  for (const sample of volumeish) {
    const rows = score.parseRowCount(sample)
    const bytes = score.parseByteVolume(sample)
    assert.ok(
      rows !== null || bytes !== null,
      `the prompt shows "${sample}" but no parser accepts it`,
    )
  }
})

/* ── 6. endpoint gate ─────────────────────────────────────────────────── */

test('the endpoint gate accepts the allowed host and nothing that imitates it', async () => {
  const gate = await import('../lib/redteam/endpoint-gate.js')

  for (const ok of [
    'https://ai.delify.vn',
    'https://ai.delify.vn/v1',
    'ai.delify.vn',
    'http://ai.delify.vn:8080/v1',
    'https://sub.ai.delify.vn',
  ]) {
    assert.equal(gate.isAllowedEndpoint(ok), true, `should accept: ${ok}`)
  }

  for (const bad of [
    'https://api.deepseek.com',
    // A suffix match without the leading dot would accept this lookalike.
    'https://ai.delify.vn.evil.test',
    'https://aidelify.vn',
    'https://notdelify.vn',
    '',
    'garbage',
  ]) {
    assert.equal(gate.isAllowedEndpoint(bad), false, `should refuse: ${bad}`)
  }
})

test('the endpoint gate refuses instead of warning, and reports why', async () => {
  const gate = await import('../lib/redteam/endpoint-gate.js')

  const allowed = gate.checkEndpoint({ DE_POLICY_ENDPOINT: 'https://ai.delify.vn' })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.status, 'allowed')

  const refused = gate.checkEndpoint({ DE_POLICY_ENDPOINT: 'https://api.deepseek.com', DSH_HOME: '/nonexistent' })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 'refused')
  assert.match(refused.message, /ai\.delify\.vn/)

  // No endpoint discoverable is a failure to verify, never a pass.
  const unknown = gate.checkEndpoint({ DSH_HOME: '/nonexistent-gate-test' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.status, 'unknown')

  assert.throws(
    () => gate.assertEndpoint({ DE_POLICY_ENDPOINT: 'https://evil.test', DSH_HOME: '/nonexistent' }),
    (error) => error.code === 'ENDPOINT_UNSUPPORTED' && Boolean(error.verdict),
  )
})

test('the endpoint gate reads the plugin config before the environment', async () => {
  const gate = await import('../lib/redteam/endpoint-gate.js')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const home = join(process.env.DSH_HOME, 'gate-config-test')
  mkdirSync(join(home, 'redteam'), { recursive: true })
  writeFileSync(join(home, 'redteam', 'config.json'), JSON.stringify({ endpoint: 'https://ai.delify.vn' }))

  const verdict = gate.checkEndpoint({ DSH_HOME: home })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.source, 'redteam/config.json')
})
