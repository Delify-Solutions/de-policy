# Red Team "Drill Ground" Superagent-ization: Development Document

**Nature: an implementation manual. Every feature described in this document is unimplemented.**
The accompanying gap analysis is in [`redteam-superagent-design.md`](redteam-superagent-design.md) (hereafter "the design document").

The reader of this document is **another model / another engineer**. So every section is written to be actionable directly:
it gives files, function signatures, SQL, pseudocode, acceptance criteria, and **pitfalls that must be avoided** (these pitfalls come from this repository's real structure, not generic advice).

---

## 0. Required reading before starting

### 0.1 Hard constraints (violating them causes rework)

| Constraint | Basis |
| --- | --- |
| Keep the plugin version in `package.json` at `0.0.1`, keep the internal red team identifier at 1.1.75, **do not change** | Repository convention |
| Fixes must be **portable across machines**: do not hard-code local paths, do not depend on `D:\DeepSeek Harness` | Repository convention |
| **Do not** commit before submitting; the maintainer decides | Repository convention |
| Must not introduce record-filing query capabilities (historical convention; `regress.mjs` has a guard) | Repository convention |
| After changes you must: `node scripts/build-client.mjs` → sync both install copies → run `.scratch/regress.mjs` | See §7 |

### 0.2 Two install paths (copies, not symlinks)

```
$DSH_HOME/plugins/de-policy
$DSH_HOME/profiles/desktop/node_modules/de-policy
```

After changing repository files you **must** sync these two locations, otherwise the user sees old code. Item [2] of `regress.mjs` compares them byte by byte.

### 0.3 Where the browser picks up code

The browser loads the **root `client.js`**. `lib/redteam/client.js` is its source,
and `scripts/build-client.mjs` extracts the source into a snippet and inserts it between the
`/* __DSH_PURGE_DRILL_BEGIN__ */` … `/* __DSH_PURGE_DRILL_END__ */` markers in `client.js`.

- Change `lib/redteam/client.js` → you **must** run the build.
- Change parts **outside** the drill block in `client.js` (for example `AttentionToast`, `handleAttention`) →
  editing `client.js` directly is enough (the build does not touch those parts).
- **But**: if the same text exists both inside and outside the drill block (for example button labels), both must be changed,
  otherwise they will disagree after the build.

To determine whether a symbol is inside or outside the block:

```bash
node -e "const fs=require('fs');const a=fs.readFileSync('client.js','utf8');
const b=a.indexOf('/* __DSH_PURGE_DRILL_BEGIN__ */'),e=a.indexOf('/* __DSH_PURGE_DRILL_END__ */');
const i=a.indexOf('function handleAttention');console.log(i>b&&i<e?'inside drill':'outside drill')"
```

### 0.4 Key file map

| File | Order of magnitude (lines) | Responsibility |
| --- | --- | --- |
| `lib/redteam/store-core.js` | ~7.3k | SQLite fact base + default prompts + `dispatch` op routing |
| `lib/redteam/schema.js` | ~780 | All DDL + `migrate()` incremental migrations |
| `lib/redteam/tools.js` | ~2.6k | 67 agent tools + `subagent/end` handler + slot gate |
| `lib/redteam/ui.js` | ~940 | `/redteam/api` HTTP entry point |
| `lib/redteam/client.js` | ~16k | Drill-ground panel bundle (source) |
| `client.js` | ~23k | Shell bundle (including `AttentionToast`, rewind, continue) |
| `lib/tool-gate.js` | ~84 | `tools/pre-execute` / `post-execute` downgrade bypass |
| `lib/redteam/slot-state.js` | ~46 | parked in-memory state |
| `lib/redteam/role-section.js` | ~177 | `redteamRole:` capture and role-draft injection |
| `lib/continue-retry.js` | ~360 | Main-session continuation (including the **correct** plugin-message example) |
| `presets/redteam/agent.cordis.yml` | — | The redteam preset: persona + tool lines |

---

## 1. Task A: Turn the quota from "prompt discipline" into "code rejection"

**Corresponds to design document §3.2.**
**Problem**: `redteam_agent_slot` only asks the model to restrain itself; if the model disobeys, nothing intercepts it.

### 1.1 Precise location of the current state

`lib/redteam/tools.js`

```js
:138  function maxAgentsNow(ctx)                 // settings.json → REDTEAM_MAX_AGENTS → 3
:303  async function liveRunningChildren(ctx, rootSessionId)   // reads subagents.listChildren
:329  function reservationList(rootId)           // in-memory reservations
:335  function addReservation(rootId, key)
:340  function dropReservation(rootId, key)
:902  name: 'redteam_agent_slot'                 // status / acquire / release
```

Key facts about `lib/tool-gate.js` (**read this first**):

```js
/** pre-execute's verdict may only be allow; ask / deny / cancel are all downgraded. */
function coerceGate(decision) {
  if (!decision || typeof decision !== "object") return { kind: "allow" };
  return decision.kind === "allow" ? decision : { kind: "allow" };
}
```

It attaches to `tools/pre-execute` with `prepend: true`, and **unconditionally flattens the verdict to allow after next()**.
So: **returning deny at this layer is useless**; it will be swallowed.

### 1.2 Implementation plan

New file `lib/redteam/agent-quota.js` (pure logic, no host dependency, easy to unit test):

```js
/**
 * Child-agent quota decision. A pure function plus an injected "currently running" reader.
 * Why not in tools.js: tools.js is already 2600 lines, and this layer must be importable directly by unit tests.
 */
export function quotaDecision({ used, cap, role, isChild }) {
  // A child session must not spawn another child session: maxDepth=1 is already guaranteed by the subagent tool itself,
  // and we block it again here because config could be changed by the user.
  if (isChild) return { kind: 'deny', reason: 'Child agents are leaf nodes; further delegation is not allowed (maxDepth=1)' }
  if (used >= cap) return { kind: 'deny', reason: `Concurrency is full (max ${cap}): wait for existing agents to report, or release the ones that have finished` }
  return { kind: 'allow' }
}
```

Two options for the integration point; **(a) is recommended**:

**(a) Attach another handler on `tools/pre-execute`, ordered before tool-gate, and do nothing but call next() itself**

Ordering problem: `tool-gate.js` registers with `prepend: true`, so it sits outermost (last registered runs first).
To take effect **inside** it, the red team handler must be registered **later than it** (also `prepend:true`,
and applied after tool-gate), so that the red team handler is outermost and `next()` enters tool-gate.

Registration timing: at the end of `apply(ctx)` in `lib/redteam/tools.js`, wrapped in `ctx.effect`
(follow the existing `subagent/end` pattern at `:524`, otherwise hot reloads stack duplicates).

```js
ctx.effect(() => {
  let install = null
  const hook = async (exec, next) => {
    try {
      if (exec && exec.name === 'subagent') {
        const { rootId, sessionId } = bindingKeyOf(exec)
        const owner = rootId ?? sessionId
        if (owner !== undefined) {
          const live = await liveRunningChildren(ctx, owner)
          const cap = maxAgentsNow(ctx)
          const decision = quotaDecision({
            used: Math.max(live.running, reservationList(owner).length),
            cap,
            isChild: sessionId !== undefined && sessionId !== owner,
          })
          if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
        }
      }
    } catch { /* If it cannot be decided, let it through: better to miss one interception than to block all delegation */ }
    return next()
  }
  // Must be registered later than tool-gate to sit outermost
  try { install = ctx.on('tools/pre-execute', hook, { global: true, prepend: true }) } catch { /* no host */ }
  return () => { try { if (typeof install === 'function') install() } catch { /* ignore */ } }
})
```

**Pitfall 1**: the waterfall semantics of `tools/pre-execute` are "any layer that does not call next() truncates all later layers".
So a deny must `return { kind: 'deny' }` **and not call next()**, otherwise downstream side effects still run.
**Pitfall 2**: confirm the field name of `exec.name` first. Use a one-off probe to print it once:

```js
// .scratch/probe-subagent-exec.mjs (temporary file; do not commit)
function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (String(exec && exec.name || '').includes('subagent')) {
      console.log('[probe]', Object.keys(exec), exec.name, exec.agent && exec.agent.session && exec.agent.session.id)
    }
    return next()
  }, { global: true })
}
```

**Pitfall 3**: `bindingKeyOf` is at `tools.js:194`, and it reads `exec.agent`. If in the
`tools/pre-execute` payload the agent is in a different field, adapt to it; **do not** assume.

**(b) Alternative: move the gate into the `subagent` tool itself**

The host package `@deepseek-ai/dsh-tool-subagent` is an official package; changing it means on-disk modification of an official package, which violates this repository's
direction of "removing on-disk modifications to official packages" (see the patch policy in `lib/core.js`). **Not recommended**.

### 1.3 Acceptance

```js
// .scratch/check-quota.mjs
import { quotaDecision } from '../lib/redteam/agent-quota.js'
const cases = [
  [{ used: 2, cap: 3, isChild: false }, 'allow'],
  [{ used: 3, cap: 3, isChild: false }, 'deny'],
  [{ used: 0, cap: 3, isChild: true }, 'deny'],
]
for (const [input, want] of cases) {
  const got = quotaDecision(input).kind
  console.log(got === want ? '✓' : '✗', JSON.stringify(input), got)
}
```

Real-machine acceptance: manually set `maxAgents` in `settings.json` to 1, then run
"dispatch two independent tasks"; the second `subagent` call should be rejected, **and** the second child session
should not exist in `list_agents`.

---

## 2. Task B: Plugin messages must not impersonate real human input

**Corresponds to design document §3.3 / §6.5 item 2.**

### 2.1 Current state

- **Correct example**: `lib/continue-retry.js:128`

```js
export function makeContinueMessage(text) {
  return {
    id: `de-policy-continue-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: { kind: "de-policy", form: "notice", summary: "continue" },
  };
}
```

`hasFreshHumanTurn` (`:246`) filters on this: `source.kind === "plugin"` or `"de-policy"` does not count as a human.

- **Wrong example (already removed this time)**: the old `submitAttentionPrompt` in `client.js` called `input.submit('queue')`.
  That message appears in the session log as `source: { kind: "user", rpcId: ... }`, **indistinguishable** from real human input.

### 2.2 What needs to be done

1. **Audit**: find every path where "the plugin actively pushes messages into a session".

   ```bash
   grep -rn "input.submit\|\.submit('queue')\|\.submit(\"queue\")\|agent.followup\|agent.steer\|agent.inject" \
     client.js lib/ --include=*.js
   ```

   Known results (after this fix):
   - `lib/continue-retry.js:273` `agent.followup(makeContinueMessage(text))` —— ✅ carries identity
   - `client.js` rewind-related —— writes a draft only, does not send —— ✅
   - `client.js` `EnvAdaptSendGate` wrapping `submit` —— intercepts only, does not send —— ✅
   - The rest should be empty. **If a new path is added, it must follow the `makeContinueMessage` approach.**

2. **Add a guard**: in `client.js`'s rewind / fill channels, forbid any automatic `submit`.

   In the respective utility-function areas of `lib/redteam/client.js` and `client.js` (near `isPluginDraft`),
   add a comment-style assertion, or simply harden it in the code-review checklist. **Do not** add a runtime throw —— a throw in the render layer causes a white screen.

3. **Document it**: `docs/redteam-superagent-design.md` §6.5 already says it; the implementation must not violate it.

### 2.3 Acceptance

```bash
# Only one followup should appear — in continue-retry — and it should carry source.kind
grep -rn "source: {" lib/continue-retry.js | head
# Should be 0 hits
grep -rn "input.submit(" client.js lib/ --include=*.js
```

Real machine: after triggering "fill into the main session input box", **the input box should contain only a draft, with no new message entering the conversation**.
Clicking send should be what produces a `user/message`.

---

## 3. Task C: `agent_task` —— make "a task" a persistent entity

**Corresponds to design document §3.4 / §3.5 / §3.6, §5 phase two.**
**This is the largest item of the three phases, and the only prerequisite that makes "re-dispatch a task" actually meaningful.**

### 3.1 Design points (think it through before writing)

Today: one `subagent` spawn = one child session; when the child session ends, everything disappears except a single `agent_report` row.
Re-dispatching = a new spawn, and the model can only recall what happened last time from the 1500 characters of `agent_report.summary`.

Goal: **the task persists, executions are round-based.**

```
agent_task     one task: target + role + objective summary + status + current assignment
agent_report   the report of one execution round (keep as is, add a task_id foreign key)
```

**Why not use superagent's full Ticket model**:
80% of Ticket's complexity is "multiple sources + multiple people + lifecycle spanning PRs". The red team has none of that.
Keeping only "a task has multiple execution rounds" is enough.

### 3.2 Schema (`lib/redteam/schema.js`)

Append after the `agent_report` table creation:

```sql
/* Execution task: the persistent identity of one "dispatch".
   A child session is one-off; a task is not: the same task can have multiple execution rounds (re-dispatched to a new child session).
   Without this table, "re-dispatch the task" can only rely on the model reading the 1500-character summary of the previous round. */
CREATE TABLE IF NOT EXISTS agent_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement TEXT NOT NULL,
  role TEXT NOT NULL,                  -- recon|assess|vuln-scan|exploit|internal
  objective TEXT NOT NULL,             -- task objective summary (written by the model, 1-3 sentences)
  scope_note TEXT,                     -- asset/subnet scope for this task (free text, for the next round to read)
  tried TEXT,                          -- paths already tried (JSON array, cumulative)
  status TEXT NOT NULL DEFAULT 'open', -- open|running|waiting|done|dropped
  session_id TEXT,                     -- the current/most recent round's child session id
  assignment_no INTEGER DEFAULT 0,     -- which round
  outcome TEXT,                        -- one-sentence conclusion when done
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_agent_task_eng ON agent_task(engagement, status);
CREATE INDEX IF NOT EXISTS ix_agent_task_session ON agent_task(session_id);
```

Migration (inside `migrate()`, immediately after `ensure('agent_report','acknowledged_at','TEXT')`):

```js
/* Attach agent_report to a task; old databases keep NULL (= unattributed), losing no history */
ensure('agent_report', 'task_id', 'INTEGER')
```

> Note: `ensure` inside `migrate()` only does ALTER, **it does not create tables**. Table creation goes through the
> `for (const ddl of [...]) db.exec(ddl)` loop at the end of `migrate()`, or into the `DDL` constant.
> The reference: that array at `schema.js:721` contains `CREATE TABLE IF NOT EXISTS agent_report`,
> **adding it in the same place is the least effort**.

### 3.3 Store methods (`lib/redteam/store-core.js`)

Place near `recordAgentReport` (`:1970`). All **synchronous, single transaction**, consistent with the existing style.

```js
/* ---------- tasks (agent_task) ---------- */

/** Open a task. Returns the task id. */
openAgentTask(id, f = {}) {
  const db = this.db(id)
  const role = String(f.role || '').trim()
  if (role === '') throw new Error('openAgentTask: role is required')
  const objective = String(f.objective || '').trim()
  if (objective === '') throw new Error('openAgentTask: objective is required')
  db.prepare('INSERT INTO agent_task(engagement, role, objective, scope_note, tried, status, created_at, updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)').run(
    String(id), role, objective.slice(0, 2000),
    f.scope_note === undefined || f.scope_note === null ? null : String(f.scope_note).slice(0, 4000),
    JSON.stringify(Array.isArray(f.tried) ? f.tried : []),
    'open', nowIso(), nowIso(),
  )
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
}

/** Attach one execution round to the task (called on dispatch). assignment_no auto-increments. */
bindAgentTask(id, taskId, sessionId) {
  const db = this.db(id)
  const row = db.prepare('SELECT * FROM agent_task WHERE id = ?').get(Number(taskId))
  if (!row) return { ok: false, error: 'task does not exist' }
  const no = Number(row.assignment_no || 0) + 1
  db.prepare('UPDATE agent_task SET session_id = ?, assignment_no = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(String(sessionId), no, 'running', nowIso(), Number(taskId))
  return { ok: true, task_id: Number(taskId), assignment_no: no }
}

/** Change status (called when a report is persisted). done/dropped are terminal. */
updateAgentTask(id, taskId, f = {}) {
  const db = this.db(id)
  const statuses = ['open', 'running', 'waiting', 'done', 'dropped']
  const status = f.status === undefined ? undefined : String(f.status)
  if (status !== undefined && !statuses.includes(status)) throw new Error('agent_task status is invalid')
  const row = db.prepare('SELECT * FROM agent_task WHERE id = ?').get(Number(taskId))
  if (!row) return { ok: false, error: 'task does not exist' }
  /* tried only grows: the whole value of re-dispatching lies in this "what has already been tried" */
  let tried = []
  try { tried = JSON.parse(row.tried || '[]') } catch { tried = [] }
  if (Array.isArray(f.add_tried)) for (const item of f.add_tried) if (item && !tried.includes(item)) tried.push(String(item))
  db.prepare('UPDATE agent_task SET status = ?, tried = ?, outcome = ?, updated_at = ? WHERE id = ?').run(
    status === undefined ? row.status : status,
    JSON.stringify(tried.slice(-50)),
    f.outcome === undefined ? row.outcome : String(f.outcome || '').slice(0, 1000),
    nowIso(), Number(taskId),
  )
  return { ok: true, task_id: Number(taskId), status: status === undefined ? row.status : status, tried: tried.slice(-50) }
}

/** Query: by default returns only unfinished tasks. */
listAgentTasks(id, opts = {}) {
  const db = this.db(id)
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100)
  const rows = opts.include_closed === true
    ? db.prepare('SELECT * FROM agent_task WHERE engagement = ? ORDER BY id DESC LIMIT ?').all(String(id), limit)
    : db.prepare("SELECT * FROM agent_task WHERE engagement = ? AND status NOT IN ('done','dropped') ORDER BY id DESC LIMIT ?").all(String(id), limit)
  return rows.map((r) => ({
    ...r,
    tried: (() => { try { return JSON.parse(r.tried || '[]') } catch { return [] } })(),
  }))
}
```

### 3.4 Wiring when a report is persisted (modify `recordAgentReport`)

**Change only one place; do not scatter it.** After the INSERT in `recordAgentReport`, append:

```js
/* If a task is attached, advance the task status too; otherwise just record the report (old behaviour unchanged). */
const taskId = Number(f.task_id)
if (Number.isInteger(taskId) && taskId > 0) {
  try {
    const mapped = status === 'ready' ? 'done'
      : status === 'dropped' ? 'dropped'
        : status === 'waiting' || status === 'blocked' || status === 'failed' ? 'waiting'
          : 'running'
    this.updateAgentTask(id, taskId, {
      status: mapped,
      outcome: mapped === 'done' || mapped === 'dropped' ? (f.summary || '') : undefined,
    })
  } catch { /* a failed task linkage must not affect report persistence */ }
}
```

The INSERT columns must also include `task_id`:

```js
db.prepare('INSERT INTO agent_report(session_id, parent_session, role, label, status, blocked_reason, needs, summary, created_at, task_id) ' +
  'VALUES(?,?,?,?,?,?,?,?,?,?)').run(/* …original parameters…, */ Number.isInteger(taskId) && taskId > 0 ? taskId : null)
```

### 3.5 Dispatch path changes (`lib/redteam/tools.js`)

Change the `acquire` branch of `redteam_agent_slot` (`:902`): from "return an in-memory key" to "return a task id".
**Keep the old key behaviour** (for prompts that have not been updated yet) and add `task_id`.

```js
if (args.action === 'acquire') {
  if (free <= 0) { /* …keep the existing rejection… */ }
  const label = (typeof args.label === 'string' && args.label.trim() !== '') ? args.label.trim() : 'slot'
  const bound = bindings.get(owner) ?? bindings.get(String(sessionId))   // existing binding lookup, see :294 recordSessionBinding
  let taskId = 0
  if (bound !== undefined) {
    try {
      taskId = store.openAgentTask(bound, {
        role: typeof args.role === 'string' ? args.role : 'recon',
        objective: typeof args.objective === 'string' && args.objective.trim() ? args.objective : label,
        scope_note: args.scope_note,
      })
    } catch { taskId = 0 }
  }
  const key = label + '#' + Date.now()
  addReservation(owner, key)
  return JSON.stringify(Object.assign(base, {
    slot: key,
    task_id: taskId || undefined,
    hint: taskId
      ? `Slot acquired (${key}), task id=${taskId}. When dispatching, write task_id into the first-line comment of the subtask (redteamTask: ${taskId}); the report will attach automatically.`
      : `Slot acquired (${key}).`,
  }), null, 2)
}
```

New parameters (add to `parameters`):

```js
role: { type: 'string', enum: ['recon', 'assess', 'vuln-scan', 'exploit', 'internal'], description: 'On acquire: the role for this round, used to create the task' },
objective: { type: 'string', description: 'On acquire: one sentence on what this task must achieve' },
scope_note: { type: 'string', description: 'On acquire: the asset/subnet scope this time, for the next round to read' },
task_id: { type: 'number', description: 'On release/status: optionally target a specific task' },
```

### 3.6 How a child session knows which task it belongs to

**Do not** introduce a second regex to parse the task id —— the role already has `redteamRole:`; adding another turns
"prompt convention" into "prompt protocol", which fails silently when wrong (the lesson of `role-section.js`).

**Recommended**: reuse the same capture point in `role-section.js`, extending `redteamRole: <code>` with an optional second line
`redteamTask: <id>`, **read together in the same `agent/inbox/claimed`**.

```js
// lib/redteam/role-section.js
const ROLE_TAG = /^[ \t]*redteamRole:[ \t]*(recon|assess|vuln-scan|exploit|internal)[ \t]*$/im
const TASK_TAG = /^[ \t]*redteamTask:[ \t]*(\d+)[ \t]*$/im

export function parseRedteamTask(text) {
  const m = String(text || '').match(TASK_TAG)
  return m ? Number(m[1]) : 0
}
```

Inside `noteClaimedMessage`, after `remember(agent, role)` append `rememberTask(agent, taskId)`,
stored in another module-level Map (also with a FIFO cap, copied from the `ROLE_SESSION_CAP` approach).

**Then read it out in the `subagent/end` handler** (`tools.js:527`):

```js
const parsed = text === '' ? null : store.parseAgentReport?.(text)
if (parsed) {
  const taskId = taskIdOfChild(childId)   // read from the new Map
  store.recordAgentReport(bound, { /* … */, task_id: taskId || undefined })
}
```

**Pitfall**: `roleBySession` may already have been cleaned up by the time `subagent/end` runs (it is keyed by session id, and
nothing guarantees a child session's entry is still there after the session ends). So **task attribution must land in `bindings`/a separate Map at `agent/inbox/claimed` time**,
and `subagent/end` must read-then-rely; if it cannot read, treat it as "unattributed task" (no error, no guessing).

### 3.7 Prompt support

Append to `DEFAULT_PROMPTS.plan` in `lib/redteam/store-core.js` (the "concurrency cap" section around `:540`):

```
- When dispatching, write `redteamTask: <task_id>` on its own line (right after `redteamRole:`); the report will attach to that task automatically.
  When re-dispatching the same task, **reuse the same task_id**, and paste that task's `tried` (what has already been tried) into the task description,
  so the new child session does not start from zero.
```

### 3.8 New tools (3, in `tools.js`)

```js
ctx.tools.register(withStructuredErrors(defineTool({
  name: 'redteam_task',
  description: '[For the main session when dispatching/re-dispatching] Task ledger: op=open creates a task, op=list lists unfinished tasks, op=get shows one (including tried), op=close closes it, op=add_tried records paths already tried. Before re-dispatching, call get once and paste tried into the new task description.',
  parameters: {
    engagement: { type: 'string' },
    op: { type: 'string', required: true, enum: ['open', 'list', 'get', 'close', 'add_tried'] },
    task_id: { type: 'number' },
    role: { type: 'string', enum: ['recon', 'assess', 'vuln-scan', 'exploit', 'internal'] },
    objective: { type: 'string' },
    scope_note: { type: 'string' },
    status: { type: 'string', enum: ['open', 'running', 'waiting', 'done', 'dropped'] },
    outcome: { type: 'string' },
    tried: { type: 'array', items: { type: 'string' } },
    include_closed: { type: 'boolean' },
    limit: { type: 'number' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  async execute(args, exec) {
    const id = resolveEngagement(store, exec, args.engagement)
    if (args.op === 'open') return JSON.stringify({ ok: true, engagement: id, task_id: store.openAgentTask(id, args) }, null, 2)
    if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, items: store.listAgentTasks(id, args) }, null, 2)
    if (args.op === 'get') {
      const one = store.listAgentTasks(id, { include_closed: true, limit: 200 }).find((t) => t.id === Number(args.task_id))
      return JSON.stringify(one ? { ok: true, task: one } : { ok: false, error: 'task does not exist' }, null, 2)
    }
    if (args.op === 'close') return JSON.stringify(store.updateAgentTask(id, args.task_id, { status: args.status || 'done', outcome: args.outcome }), null, 2)
    return JSON.stringify(store.updateAgentTask(id, args.task_id, { add_tried: args.tried || [] }), null, 2)
  },
})))
```

### 3.9 Acceptance

```js
// .scratch/check-task.mjs  —— real-machine database; clean up afterwards
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'
const s = new RedteamStore(process.env.DSH_HOME + '/redteam')
const id = 'task-selftest'
const t = s.openAgentTask(id, { role: 'vuln-scan', objective: 'test task', scope_note: '10.0.0.0/24' })
console.log('open', t)
console.log('bind', s.bindAgentTask(id, t, 'sess-1'))
s.recordAgentReport(id, { session_id: 'sess-1', role: 'vuln-scan', status: 'waiting', blocked_reason: 'missing key', needs: [{ kind: 'key', detail: 'K' }], task_id: t })
console.log('after waiting →', s.listAgentTasks(id))
s.recordAgentReport(id, { session_id: 'sess-2', role: 'vuln-scan', status: 'ready', summary: 'finished', task_id: t })
console.log('after ready   →', s.listAgentTasks(id, { include_closed: true }))
s.close()
```

Expected: after `waiting` the task status is `waiting`; after `ready` it is `done` with a non-empty `outcome`;
`listAgentTasks` **no longer returns** it by default.

---

## 4. Task D: Stage decision table (aligned with `ticketStage`)

**Corresponds to design document §3.5.** Small workload, direct payoff (the panel and the tools share one decision).

New file `lib/redteam/task-stage.js` (pure function, zero dependencies):

```js
/**
 * Task stage decision. The rules come from superagent's ticketStage (src/core/stage.ts),
 * but the red team has no PR / Channel, so "only ends when the external thread ends" is dropped.
 * The first match from top to bottom wins.
 */
export function taskStage(task, latestReport, coverageGaps) {
  if (!task) return 'none'
  if (task.status === 'done') return 'done'
  if (task.status === 'dropped') return 'dropped'
  const r = latestReport && latestReport.status
  if (r === 'waiting') return 'person/answer'
  if (r === 'ready') return 'person/review'
  if (r === 'blocked') return 'person/blocked'
  if (r === 'failed') return 'person/failed'
  if (task.status === 'open' && !task.session_id) return 'working/queued'
  if (r === 'progress') return 'working'
  if (r === 'dropped') return 'dropped'
  /* No report at all but a session is still attached: treat it as running */
  if (task.session_id) return 'working'
  return Number(coverageGaps) > 0 ? 'working/queued' : 'idle'
}
```

Integration:

- Change each item's `stage` in `attentionQueue` to the result of `taskStage(...)` (keeping the existing
  `person/*` strings unchanged, so **the mapping tables in the panel and the Toast do not need to change**).
- `AttentionToast` at `client.js:23050` and `STAGE_TEXT` at `lib/redteam/client.js:10457`
  already have five levels `person/answer|review|blocked|failed|working`; **the new `working/queued` and `idle`
  must be added on both sides** (otherwise they display as "waiting").

### 4.1 Acceptance

```js
import { taskStage } from '../lib/redteam/task-stage.js'
console.log(taskStage({ status: 'running', session_id: 'x' }, { status: 'progress' }, 3)) // working
console.log(taskStage({ status: 'waiting', session_id: 'x' }, { status: 'waiting' }, 0))  // person/answer
console.log(taskStage({ status: 'done' }, null, 0))                                       // done
```

---

## 5. Task E: Unified boundary validation

**Corresponds to design document §3.7.** The current state is "2 entry points check, 60+ do not".

### 5.1 Plan

Add a wrapper in `tools.js` (`scopeCheck` is already at `:444`; reuse it directly):

```js
/**
 * Every tool that "writes asset-side facts" must pass through this layer.
 * Current state: redteam_batch rejects out-of-scope, redteam_asset_add does not ——
 * the same asset via batch and via single add gives different results; that is a design defect.
 */
function assertInScope(store, id, target, opts = {}) {
  const check = scopeCheck(store, id, target)
  if (check.status === 'out') {
    throw new Error('Out of authorized scope: ' + target + (check.scope.length ? ' (authorized scope ' + check.scope.join(', ') + ')' : '') +
      '. If you are sure you want to attack it, extend the scope with redteam_engagement_open first.')
  }
  /* unscoped / unresolved pass by default: a target without a configured scope is the norm (the prompts explicitly require not asking about authorization);
     what cannot be resolved is a domain name, and domain resolution is part of the collection phase itself. */
  return check
}
```

Call sites (**confirm each one; do not blind-edit**):

| Tool | Where the target comes from in the arguments |
| --- | --- |
| `redteam_asset_add` (near `:1000`) | `args.ip` |
| `redteam_vuln_add` / `redteam_vuln_update` | `args.target` |
| `redteam_credential_add` | no target; skip |
| `redteam_webshell_add` (`:1663`) | `args.url` |
| `redteam_tunnel_add` (`:1720`) | **only check the URL host in `entry`**; `listen` is always a local address (`127.0.0.1:1080`), `reach` is a CIDR (`10.0.0.0/8`) —— neither can be fed to `scopeCheck` directly |
| `redteam_score_hit` | `args.target` |
| `redteam_host` (op=finding) | look up the IP via `asset_id` |

**Pitfall 1**: `redteam_tunnel_add.listen` is a **local** listen address; checking it against the scope would reject every tunnel.
`reach` is a subnet string, not an IP, so `scopeCheck` returns `unresolved` for it (equivalent to no validation).
So the tunnel entry can only: check `entry` (if it is a URL, take its hostname → resolve IP → check),
and explicitly annotate in the return that `reach` was not validated. **Do not add CIDR containment logic to `scopeCheck`** ——
that is a different semantic (whether a subnet falls inside an authorized subnet) and would pollute the existing IP decision.

**Pitfall 2**: `scopeCheck` returns `unresolved` for domain names. Do not add DNS resolution for this —— the collection phase is supposed to resolve before persisting;
a resolution failure means "not collected yet", and rejecting then actually blocks the normal flow.

### 5.2 Acceptance

```
1. Set the target's scope=10.20.0.0/16
2. redteam_asset_add ip=10.30.1.1   → should be rejected (out)
3. redteam_asset_add ip=10.20.1.1   → should succeed
4. redteam_tunnel_add listen=127.0.0.1:1080 reach=10.30.0.0/16 → should succeed (only the IP in reach is checked;
   if reach is a subnet string rather than an IP, keep the current behaviour of not checking, and annotate "not validated" in the return)
```

---

## 6. Task F: Report-to-database consistency check

**Corresponds to design document §3.8.** The red team's "results" are naturally counts, so verification means counting.

### 6.1 Plan

New tool `redteam_report_verify`:

```js
name: 'redteam_report_verify',
description: '[For the main session when checking a child agent report] Compare the results an execution session claims against the rows it actually wrote in the database: score hits, vulnerabilities, credentials, WebShells, tunnels, host findings. If the numbers do not match, list them; do not take the report at face value.'
```

Implementation points (**do not** parse numbers out of natural language —— unreliable):

- Input: `session_id` (or `task_id`), and optionally `expect: { score_hits, vulns, credentials, webshells, tunnels, findings }`.
- Counting: filter rows written by that session using each table's own "who wrote it" column.
  **The column names are not uniform and must be confirmed table by table** (these are measured results; do not guess from the table name):

  | Table | Attribution column |
  | --- | --- |
  | `score_hit` | `recorded_by` (`schema.js:209`; `addScoreHit` writes it at `store-core.js:2711`) |
  | `vuln` | `agent` |
  | `credential` | `agent` |
  | `webshell` | `agent` |
  | `tunnel` | `agent` |
  | `attack_step` | has both `agent` and `recorded_by` (`store-core.js:4985`); use `agent` for counting |
  | `host_finding` | `created_by` |

  If a table has no rows for that session, give `0` in `actual` rather than omitting it —— an omission reads as "not checked".
- Output:

```json
{
  "ok": true,
  "session_id": "...",
  "actual": { "score_hits": 4, "vulns": 3, "credentials": 1, "webshells": 1, "tunnels": 0, "findings": 12 },
  "expected": { "score_hits": 12, "vulns": 3 },
  "mismatch": [{ "key": "score_hits", "expected": 12, "actual": 4, "note": "the report claims 12 scoring hits; the database has only 4" }],
  "verdict": "mismatch"
}
```

`verdict`: `ok` (all match) / `mismatch` (differences) / `unverifiable` (no `expected` given).

### 6.2 Why no automatic parsing

`agent_report.summary` is free text from `text.slice(-1500)`. Extracting numbers with regex goes wrong immediately on
a sentence like "got 12 servers, 3 of which are Windows". **Let the model fill in `expect` itself**;
if it cannot, the verdict is `unverifiable` —— that is better than a wrong judgement.

### 6.3 Acceptance

- Create 3 `score_hit` rows, then `expect: { score_hits: 5 }` → should return `mismatch` with `actual=3`.
- Pass no `expect` → `unverifiable`, while `actual` must still be correct.

---

## 7. What must be done after every change

```bash
# 1) Syntax
for f in client.js lib/redteam/client.js lib/redteam/store-core.js lib/redteam/tools.js lib/redteam/schema.js; do node --check "$f"; done

# 2) If you touched lib/redteam/client.js (or the css / shared js it imports)
node scripts/build-client.mjs

# 3) Sync both install copies (extend the file list as needed)
DSH="D:/DeepSeek Harness/.dsh"
for d in "$DSH/plugins/de-policy" "$DSH/profiles/desktop/node_modules/de-policy"; do
  for f in client.js lib/redteam/client.js lib/redteam/store-core.js lib/redteam/tools.js lib/redteam/schema.js; do
    cp "$f" "$d/$f"
  done
done

# 4) Regression
DSH_HOME="$DSH" node .scratch/regress.mjs
```

`regress.mjs` checks: `node --check` (12 files), the two copies byte-identical, no record-filing query references, skill count 40,
5 key modules importable. **All must be green before moving on.**

> Note: the `touched` list in `regress.mjs` is hard-coded. Adding files like `lib/redteam/agent-quota.js`,
> `task-stage.js` requires adding them to the `touched` array **at the same time**, otherwise syntax checking and syncing will not cover them.

---

## 8. Construction order (suggested)

| Order | Task | Depends on | Risk | Estimate |
| --- | --- | --- | --- | --- |
| 1 | A hard quota rejection | None | Medium (a wrong `pre-execute` order blocks everything) | Small |
| 2 | B audit + guard | None | Low | Small |
| 3 | D stage decision table | C's table | Low | Small |
| 4 | C `agent_task` table + 3 tools | None | Medium (the migration must be idempotent) | Large |
| 5 | E unified scope validation | None | Medium (a false positive on `tunnel.entry` blocks normal flow) | Medium |
| 6 | F consistency check | C (needs per-session counting) | Low | Small |

**Do 1 and 2 first**: these two are stop-the-bleeding items that keep causing incidents until fixed.
**C must be completed in a single change** (schema + store + tools + prompts together); a half-finished state makes
"task status" and "reports" disagree, which is worse than not having it.

---

## 9. Pitfalls that must be avoided (summary)

1. **`lib/tool-gate.js` flattens every `pre-execute` verdict to `allow`.**
   Returning deny downstream of it is ineffective; the red team quota must be registered **after** it (also `prepend:true`, applied later).
2. **`lastAssistantMessage` in `subagent/end` is an array of content blocks**, not a string.
   `textOfAssistantMessage` (`tools.js:101`) already handles extraction; **do not write another one**.
3. **`parseAgentReport` returns null on parse failure and does not throw**. Any statistic depending on it silently undercounts;
   do not assume "a report exists means a parsed value exists".
4. **`latest` in `attentionQueue` means "the latest row per session"**. After adding `task_id`, do not casually change it to
   "the latest per task" —— sessions and tasks are not one-to-one (a failed round re-dispatched gives two sessions on the same task).
5. **`zstd` session logs are multi-frame concatenations**; decompressing the whole thing with `zlib.zstdDecompressSync` throws
   `ZSTD_error_prefix_unknown`. Split frames by the magic `28 b5 2f fd` and decompress each segment —— useful when troubleshooting.
6. **`client.js` has one copy of the UI inside the drill block and one outside**. When changing text/behaviour, change both, then build to verify.
7. **Wrap every `ctx.on` in `ctx.effect`**: leaving no disposer stacks N copies of the handler after a hot reload
   (the comment at `tools.js:523` was written for exactly this).
8. **In-memory state (`parked` in `slot-state.js`, `reservations`) is lost on restart.**
   Any fact that must survive a restart has to go into SQLite —— that is the reason task C exists.

---

## 10. Already done this time (do not redo)

| Change | Location |
| --- | --- |
| `agent_report.acknowledged_at` + migration | `lib/redteam/schema.js:387`, `:607`, `:732` |
| `acknowledgeAgentReports` | `lib/redteam/store-core.js:2008` |
| `attentionQueue` skips already-handled items | `lib/redteam/store-core.js:2073` |
| `attentionAck` op | `lib/redteam/store-core.js:922` |
| `redteam_attention action=ack` | `lib/redteam/tools.js:1388` |
| `handleAttention` fills only, does not send; `submitAttentionPrompt` removed | `client.js:22995` |
| Button label changed to "fill into the main session input box" | `client.js`, `lib/redteam/client.js` |
| Prompts gained a closing requirement | `client.js:22936` |

For the reasons and evidence see design document §6.
