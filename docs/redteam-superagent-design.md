# Gap Between the Red Team "Drill Ground" and superagent: Design Document

**Nature: design and gap analysis, no implementation.** This document only answers "what it is now, what is missing, how superagent does it, and in what order the gaps should be closed".
The accompanying implementation details (per-file function signatures, SQL, pseudocode) are in [`redteam-superagent-dev.md`](redteam-superagent-dev.md).

Reference points:

| Name | Location | Version / state |
| --- | --- | --- |
| This plugin | `lib/redteam/`, `skills/redteam/`, `presets/redteam/` | `de-policy` 1.1.75 (`package.json` still says `0.0.1`; leave it) |
| Host | DeepSeek Harness | 0.2.2-rc.3 |
| superagent prototype | `.scratch/superagent-proto` | The README calls itself "Research prototype for reference only" |

Reading order: §1 gives the conclusion table first, §2 explains that the two are not the same kind of thing at all, §3 compares them stage by stage (this is the body of the document),
§4 lists "implemented / half-implemented / not implemented", §5 gives the order and trade-offs for closing the gaps, §6 records the defect exposed this time as design rationale.

---

## 1. One-page conclusion

| Stage | superagent's form | This plugin's current state | Gap level |
| --- | --- | --- | --- |
| Registration | Source plugins turn external events into Triggers; the Engine is the sole write entry point | No Source concept. Tasks are spawned directly by the main session with the `subagent` tool, and the role is recognized from the `redteamRole:` line in the prompt | **Structural omission** |
| Scheduling | `Passes` ticks every 2 seconds, `Engine.evaluateDue()` + the `Effects` queue; concurrency is managed by worker slots | The main session decides who to dispatch and when; concurrency relies on the **advisory** gate in `redteam_agent_slot` | **Structural omission** |
| Session delivery | `AgentDelivery` delivers idempotently per `messageId(requestId)`, with no duplicates across restarts | A child session = a one-off spawn, not continued after it ends; the `resume` capability is unused | **Structural omission** |
| Re-dispatching a task | A Ticket is a persistent entity; `retryTicket` ends the old Assignment and starts a new one, in the same session and the same directory | Only a fresh child session can be spawned; all context is lost | **Structural omission** |
| Confirming task state | `Ticket.attention` (structured questions) + the 6-row decision table `ticketStage()` | The `agent_report` table + tail-line text parsing; one notch less deterministic | **Half implemented** |
| Determining the final conclusion | In `report()`, `ready`/`dropped` ends the Ticket directly; `followsDone` handles PR closure | There is no "end" action; a report is only a record | **Half implemented** |
| Boundary handling | Mandate (authorization credential) + Policy (versioned rules) + admission table; engine-level rejection beyond `tools/pre-execute` | Only `redteam_scope_check` / `redteam_batch` check CIDR; the other tools do not | **Half implemented** |
| Result verification | References are validated when a report is persisted (`askedBy` must be a human message, `answers` must be answerable), and `ready` is aligned with the PR state | There is `redteam_session_check` (real connection) and `redteam_data_proof` (structured row counts), but **no** mandatory check that "the report says it got it = the database really has it" | **Half implemented** |

In one sentence: **superagent is a persistent state machine; this plugin is a good set of bookkeeping tools + prompt discipline.**
This plugin's strength is "what to record" (assets/vulnerabilities/credentials/tunnels/scores/coverage, the 20-odd tables in `lib/redteam/schema.js`)
and "how to attack" (40 skills, 5 role drafts); its weakness is the orchestration-state layer of "who is running, how far along, and who they are blocked on".

---

## 2. The two are not the same kind of thing

### 2.1 superagent solves "picking up work unattended, long term"

Its Sources are Feishu and GitHub —— events arrive on their own from outside. So it must answer:
**does an incoming event count as work? whose work is it? how does the conclusion get back? what happens after a restart?**

Therefore its core is a state machine **written only by the Engine** (the start of `docs/007-architecture.md`):

```
Source → Trigger → Thread → Eval → Decision → Ticket(Mandate) → Assignment → Executor
```

The Engine is the **sole writer** of Trigger / Thread / Decision / Ticket / Assignment (synchronous, single transaction),
and every external side effect first enters the `Effects` queue table and executes after commit (`src/app/effects.ts`).
What this constraint buys is: restart at any moment, and "how many jobs exist now and who each is waiting for" can be rebuilt from the database.

### 2.2 This plugin solves "a drill with someone watching"

The target is given by the user on the spot, and the main session is the commander. So it naturally delegates orchestration to the model:
the plan prompt in `presets/redteam/agent.cordis.yml` hard-codes "dispatch one at a time", "at most 3", "check the quota before and after dispatching".

This works very well in scenarios where **someone is watching** —— the human is the scheduler. Its failure point is exactly superagent's foothold:
**when nobody is present, nobody advances; and for things that need a human decision, there is no reliable place to park them.**

### 2.3 Therefore "copy it wholesale" is wrong

Half of superagent's complexity comes from Source (Feishu event consumption, GitHub notification polling, PR lifecycle, channel replies).
The red team has none of this: targets do not send messages on their own. Copying the Source layer wholesale only yields a pile of code nobody calls.

**What should be ported is the middle three layers: the Ticket state machine, the Assignment lifecycle, and the Effects persistent queue.**
What should not be ported is Source / Channel / Policy versioning and the admission table (the red team has no multi-tenancy or multiple sources).

---

## 3. Stage-by-stage comparison

Each section below follows the same structure: **how superagent does it (with code locations) → how this plugin does it now (with code locations) → where the difference is → what should be borrowed**.

### 3.1 Registration (who registers "a thing")

**superagent**

- A Source plugin implements the `SourceContext` interface, translating external messages into a `Trigger` (an immutable event with actor, thread, and channel address).
- `Intake.receive(trigger)` (`src/core/intake.ts:28`) does four things:
  1. Deduplicate by `trigger.id`; a repeat returns `duplicate`;
  2. Filter by `SourceScope`; filtered items are still persisted with a `filtered` reason (**dropped events still leave a trace**);
  3. Record Thread ownership and Correlation;
  4. Fan out to the Tickets subscribed to those Threads, **and** determine "whether any Ticket claims this message";
     only if nobody claims it does it enter the Eval queue (`if (!this.owners(trigger).length) this.queueForEval(trigger)`).
- The product of registration is not "a task" but "a fact + which Thread it belongs to". The task (Ticket) is decided later by Eval.

**This plugin**

- There is no Trigger. The starting point of a task is the main session calling the `subagent` tool (`presets/redteam/agent.cordis.yml:333`,
  `provider: spawn`, `backgroundMode: continuable`, `maxDepth: 1`).
- "Registration" actually happens **on the child session itself**: the first line of the task description states `redteamRole: <code>`,
  and the host captures it on `agent/inbox/claimed` with the `ROLE_TAG` regex in `lib/redteam/role-section.js`,
  records it into the module-level `roleBySession`, and inserts `engagements/<target>/agents/<code>.md` when assembling the system prompt.
- In other words: **the role is a prompt-layer convention, not a data-layer entity.** A missing line, a wrong code, or a child session changing role all fail silently
  (`noteClaimedMessage` just `return`s when it finds nothing).

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Deduplication | Trigger id is idempotent; a repeat registration counts once | None. Spawning the same task twice really gives two child sessions |
| Rejected events | Persisted + reason recorded | No such concept |
| Ownership | Thread / Ticket have explicit foreign keys | Only one soft field, `parent_session` |
| Role | A property of the Ticket, hard-coded in the engine | A regex in the prompt, relying on model self-discipline |

**What to borrow**

Borrow "registration = persist a fact with an id, and repeated registration is idempotent", **do not borrow the Source layer**.
Concretely for the red team: `redteam_agent_slot action=acquire` should really produce a queryable Assignment row
(with assignmentId, role, task summary, start time), instead of shoving a
`label#timestamp` into the in-memory `reservations` Map (`lib/redteam/tools.js:335` `addReservation`). In-memory state is gone after a restart.

---

### 3.2 Scheduling (who decides who to dispatch next and when)

**superagent**

- `Passes` (`src/app/passes.ts:31`): `setInterval(2000)` per tick; each tick calls `effects.kick()` then `engine.evaluateDue()`.
  Only one tick runs at a time; concurrent calls are merged into "run once more" (the `pumpAgain` logic in `pump()`).
  A failed tick is written to health, and cleared on the next successful tick.
- Scheduling is **data-driven**: `evaluateDue()` walks every Thread with queued Triggers and starts one Eval per Thread;
  an Eval has a deadline, is re-queued twice on timeout, and marked `unavailable` the third time (the `expire` in `src/core/evals.ts`,
  `REQUEUES = 2`).
- Concurrency is managed by worker slots (`docs/003-execution.md` §Concurrency): a Ticket occupies one slot from launch,
  and **one extra slot is reserved for human messages**, so humans cannot be squeezed out by automatic tasks.
- Pausing (`pause processing`) only stops "dispatching / new Evals / delivery / replies"; already-running turns are not interrupted.

**This plugin**

- Scheduling lives entirely in the prompt. The plan prompt near `lib/redteam/store-core.js:540` says:
  "dispatch one at a time by default, advance in order", "launch only one agent each time, dispatch the next after it finishes", "at most 3 at a time per target".
- On the code side there is only an **advisory** gate `redteam_agent_slot` (`lib/redteam/tools.js:902`):
  - `liveRunningChildren()` (`:303`) reads `ctx.get('subagents').listChildren(root)` and counts child sessions with `activity === 'running'`;
  - `maxAgentsNow()` (`:138`) reads `settings.json` → `REDTEAM_MAX_AGENTS` → default 3;
  - `acquire` returns `ok:false` immediately when full, and the prompt requires "do not retry and force it in".
- Key fact: **there is no `tools/pre-execute` interception at all**. Child sessions can still be spawned; the gate only asks the model not to dispatch.
  When the model disobeys (or its context gets flushed), the cap of 3 is meaningless.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Tick | Yes, every 2 seconds, observable | None. Only passively triggered once when a child session ends |
| Cap | Hard constraint, rejected at the engine layer | Soft advice, model self-discipline |
| Human priority | A separate reserved slot | No concept; human messages and automatic tasks compete for the same quota |
| Timeout | Evals have deadlines and are re-queued | A child session can hang indefinitely |
| Pause | First-class, stateful | None |

**What to borrow**

Borrow the smallest thing first: **move the "cap" from the prompt into code**. The host already has a `tools/pre-execute` waterfall
(this plugin already uses it; see the comments in `lib/tool-gate.js`); checking `liveRunningChildren` before a `subagent` tool call
is enough to reject hard. Note that `coerceGate` in `lib/tool-gate.js` flattens every verdict to `allow` —— that is **deliberate**
(to avoid disabling downstream side effects), so the red team quota check must go in another layer **before it**, or be changed to
"decide the quota inside the same handler, then next()". This is the first pitfall to handle in the development document.

Do not borrow the `Passes` timer: the red team has no "events arrive by themselves" scenario, and adding an idle 2-second tick just burns CPU.

---

### 3.3 Session delivery (how messages pass between child sessions, and between the main session and child sessions)

**superagent**

- `AgentDelivery` (`src/app/delivery.ts`) is the only delivery channel, and its core property is **idempotency**:
  ```ts
  export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
  ```
  No matter how many times the same `requestId` is retried, only one message ever appears in the Session. It scans three places to decide "have I seen this":
  ids seen by this process, persisted history (`sessionPersistence.open` reads `user/message` batch by batch),
  and anything still sitting unconsumed in the inbox.
- Messages carry their own source: `{ kind: 'dsh-superagent', form: 'relay' }`.
  **A message sent by the plugin is never mistaken for something a human wrote** —— that is an explicit rule in `docs/001-domain.md`.
- Three delivery modes: `queue` (next turn), `steer` (next step), `{ inject }` (inject into history without waking).

**This plugin**

- Main → child: a one-off prompt at spawn time, and **no channel afterwards**. To add information you can only use `send_message` (a host tool).
- Child → main: when the child session ends the host emits `subagent/end`, and the handler at `lib/redteam/tools.js:527` reads
  `info.lastAssistantMessage` (an array of content blocks) and parses out `redteamReport: {...}` to persist it.
  **This is one-directional and happens only once, at the end.**
- When the main session pushes a message into its own session, it goes through the render layer's `input.setDraft` + `input.submit('queue')`
  (around `client.js:22972`). Such messages carry `source.kind: "user"` and an `rpcId` —— **indistinguishable from real human input in the database**.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Idempotency | Strongly idempotent per requestId, across restarts | None |
| Identity | `kind: 'dsh-superagent'`, distinguishable | Plugin-synthesized messages masquerade as `kind: 'user'` |
| Channel | Bidirectional (Input into the worker, Report back to main) | One-directional (once, at the end) |
| Waking | Can wake an idle worker | Cannot; only a fresh spawn |

**What to borrow**

Borrow **"a plugin message must carry its own identity"**; this is the cheapest and highest-payoff item.
This plugin already has the correct example: `makeContinueMessage` in `lib/continue-retry.js:128` uses
`source: { kind: "de-policy", form: "notice" }`, and `hasFreshHumanTurn` (`:246`)
explicitly filters out `"plugin"` / `"de-policy"` by `source.kind`.
**But the message that wakes "go handle it" does not go through that path** —— it goes through the render layer's submit, and thus becomes "something a human said".
This is one of the direct causes of the defect recorded in §6.

---

### 3.4 Re-dispatching a task (how to keep going after a failure)

**superagent**

- The Ticket is persistent; an Assignment is "one execution round". `retryTicket` (the Engine table in `docs/007`):
  ends the current Assignment and starts a new Assignment on **the same Executor Session, the same directory, the same branch, the same PR**.
- The post-restart recovery path also goes through here: `Assignments.interrupted()` (`src/core/assignments.ts:83`) determines
  whether the previous round was "settled" (`waiting|ready|blocked|failed` with no new Input afterwards);
  if settled, it keeps the session and only delivers the missing Input; if not, it `restart`s and injects a `RECOVERY_NOTE`:
  "check the worktree, git history, and GitHub state first; do not repeat external actions that have already been done".
- Transient failures (`transient()`, `src/executor/dsh.ts:41`: 408/429/5xx/connection refused/timeout) get dedicated retries:
  3 times with increasing backoff, re-running launch or asking the worker to "continue"; a failed prepare command is **not** retried (to avoid treating a half-built directory as finished).

**This plugin**

- Re-dispatching = spawning a brand-new child session. The old child session's context, the paths already ruled out, and the intermediate conclusions already obtained are all lost.
- `redteam_agent_slot` parks itself via `parkAgent` (`lib/redteam/slot-state.js`) on `status=blocked|waiting`,
  and `subagent/end` also parks as a fallback —— the intent is right ("do not hold a slot while idling"), but the park state is
  **a module-level `Map`, pure memory**, reset to zero on process restart; and it only affects "whether it counts toward the quota", not "what state this job is in".
- `lib/continue-retry.js` has `autoRetry: true, retryMax: 3`, but that is **main-session** continuation retry,
  unrelated to child sessions.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Re-dispatch granularity | Same Ticket, new Assignment | A brand-new child session |
| Context | Preserved (same Session) | Lost |
| Restart recovery | Explicit path + recovery prompt | None. Park state is in memory, and the queue is full of historical residue |
| Transient failures | Classified retry | None (if the child session crashes, it crashes) |

**What to borrow**

Borrow the model "**a job is persistent, execution is round-based**"; this is the most valuable item in the whole design.
Landing it in the red team does not require anything as heavy as an Assignment table: one `agent_task` table (target, role, task summary,
status, current assignment, previous round's conclusion) is enough. But **the key is to have an id**: only with an id can you
"re-dispatch to the same task", and only then does the model have somewhere to write "I tried this, switch to another path".

---

### 3.5 Confirming task state (how to know "what we are waiting on now")

**superagent**

Two layers:

1. **Structured facts**: `Ticket.attention` is an object `{ id, question, triggerId? }`,
   produced by the `human_action` field of `orchestrator_report` (`src/app/tools/executor.ts:75`).
   A report can also carry `question_for_trigger_id` (which human message raised this question, determining where to reply) and
   `reply_to_trigger_id` (which question this report answers). **All enums and ids, not free text.**
2. **A deterministic decision table**: `ticketStage()` in `src/core/stage.ts`, first match from top to bottom wins:

   | Order | Condition | Stage |
   | --- | --- | --- |
   | 1 | `ticket.ended` | `ended` |
   | 2 | `ticket.delivery` (delivery failed) | `person/delivery` |
   | 3 | `ticket.attention` (a pending question) | `person/answer` |
   | 4 | Latest report `ready` | `person/review` |
   | 5 | Latest report `blocked`/`failed` and `waitsForPerson` | `person/blocked` / `person/failed` |
   | 6 | No Assignment or pending | `working/queued` |
   | 7 | Report `waiting` or the Assignment has ended | `idle` |
   | 8 | Everything else | `working` |

   Note that the common meaning of `person/*` is "**cannot move without human input**", while `idle` means "this round is done, waiting for a new event".

**This plugin**

- When a child session ends it writes one `agent_report` row (`lib/redteam/schema.js:373`; written in `store-core.js:1970`),
  with fields `status = progress|waiting|ready|blocked|failed|dropped` + `blocked_reason` + `needs[]`.
- Parsing relies on `parseAgentReport` (`store-core.js:1894`): find `redteamReport: {...}` in free text,
  with pseudo-JSON as a fallback. **If the model omits a line, writes the wrong status word, or corrupts the JSON, the whole thing is lost** (nothing is written when `parsed === null`).
- `attentionQueue` (`store-core.js:2058`) takes **the latest row per session**, sorted by `waiting > ready > blocked > failed > progress`.
- UI side: from `client.js:21918` it polls `/redteam/api {op:'attention'}` every 8 seconds;
  `AttentionToast` (`:23050`) renders it as a pill in the bottom-right, and the panel's `OverviewTab` (`lib/redteam/client.js:10348`) renders it as the first screen.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| State source | Structured fields (enums + ids) | A convention line inside free text |
| Determination | A deterministic table, testable in code | Sorting only; no decision on "can this still progress" |
| Lifecycle | Tickets have `ended`, state converges | **No end semantics**; the latest row lives forever |
| Human questions | Objects with ids, revocable | An element in a to-do list, with no id |

**What to borrow**

Borrow two things:

1. **The decision table.** `ticketStage`'s 6-row table can be ported almost verbatim: mapping `agent_report` status to
   a stage already has a prototype (the `stage` field in `attentionQueue`); what is missing is the non-`person` states
   `ended` / `idle` / `queued`, plus "what condition counts as ended".
2. **End semantics.** See §3.6.

---

### 3.6 Determining the final conclusion (when a thing counts as "done")

**superagent**

- In `Assignments.report()` (`src/core/assignments.ts:96`), whether to end the Ticket is decided at the same time as the report is persisted:
  ```ts
  const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped'
    : report.state === 'ready' ? ready : undefined
  if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
  ```
  The semantics of `ready` are "done, awaiting human acceptance"; if it does not follow any Thread it ends directly as `completed`;
  if it follows a PR, it must wait for `followsDone` (all PRs it opened are closed) before ending.
- `dropped` means "nothing to do": end without sending a message, unless a matching rule requires sending.
- Ending does not delete data: `ended` records the time, who, why, and what the outcome was; Subscriptions are retained,
  and a human speaking on that Thread afterwards can still resume (unless a human `stopTicket` stopped it).

**This plugin**

- **There is no "end" action.** `agent_report` has only `dropped`, which `attentionQueue` skips
  (`if (r.status === 'dropped') continue`); everything else stays resident indefinitely.
- The judgement "this round is done" is written into the return value's `note` string (`attentionQueue` in `store-core.js`:
  `items.length === 0 && pendingCoverage === 0` → "nobody is waiting and there is no queue gap: this round is done").
  **It is a sentence for humans to read, not a state for code to use.**
- The coverage queues (`asset_coverage` / `host_coverage`) carry "what is still not done",
  but they answer "what actions are still missing", not "has this task ended".

**Where the difference is**

- superagent's ending is **a state transition in the engine**, which cascades into notifications, freeing the slot, and allowing resume.
- This plugin's "ending" is **the absence of state**: as long as nobody writes a new report, the queue shows the old rows forever.
  This directly causes the defect in §6 —— the same block of prompt text being generated over and over.

**What to borrow**

Borrow "`ready`/`dropped` must converge". The minimal form: `agent_report` has an `acknowledged_at`
(added this time, see §6), but that only solves "a human has handled it". The complete form also needs **task-level** ending:
once a role's objective for this phase is achieved or abandoned, that role exits the "active queue",
rather than being implied by silence in the next round. The difference is that silence cannot distinguish "still running" from "finished long ago".

---

### 3.7 Boundary handling (what may and may not be done)

**superagent** has three layers:

1. **Mandate** (authorization credential): produced when an Eval is accepted, immutable, recording the Policy version, scope, strength,
   matched rules, and requester identity. A wider scope = a new Ticket. **A Ticket ending does not end the Mandate** ——
   only a human stop revokes it, or Policy no longer recognizes it.
2. **Policy** (versioned rules): the admission table decides "who may initiate work through this Source";
   a rule change is **delivered** to affected Tickets (`policyChanged`), but **does not revoke** the Mandate.
   A running Eval is discarded and re-queued.
3. **Engine-level rejection**: every command validates its preconditions, and an illegal request throws `UserError`.
   For example in `report()`: `askedBy` must point at a human message, `answers` must point at an answerable human message,
   `ready` cannot carry a question at the same time, and an ended `assignment` cannot report again. **These are code rejections, not prompt requests.**

**This plugin**

- `scopeCheck` (`lib/redteam/tools.js:444`): `no scope → 'unscoped'`,
  `IP matches → 'in'`, `not in → 'out'`, `domain cannot be resolved → 'unresolved'`.
- Only two tools actually call it: `redteam_scope_check` (`:2403`) and `redteam_batch` (`:2419`,
  validating the assets and vulns kinds separately).
- The other 60-odd tools (`redteam_asset_add`, `redteam_vuln_add`, `redteam_credential_add`,
  `redteam_tunnel_add`, `redteam_score_hit` …) **do not check scope at all**.
- The authorization premise is written in the persona prompt (`presets/redteam/agent.cordis.yml`):
  "if the user gives the target organisation's name, this attack-defense drill is considered authorized: do not ask about the authorization scope".
  This coexists with the "T0–T3 asset admission" (same file) —— that is: **authorization is not to be asked about, but the choice of what to attack has disciplinary constraints**.
- The discipline is carried by the `asset.test_*` fields + the skill bodies (`skills/redteam/`), which are **prompt-layer**.
- In addition, `lib/tool-gate.js` uniformly downgrades the host's `tools/pre-execute` verdict to `allow`,
  and `tools/post-execute` forbids `block`. This is so that downstream side effects (job output caps, workspace snapshots,
  spill truncation) still run; the cost is that **any red team logic relying on this layer to reject will be ineffective**.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Carrier of authorization | A Mandate object, immutable, with an id | One sentence in a prompt |
| Where it is checked | The engine's command entry points, full coverage | 2 tool entry points; the rest do not check |
| Consequence of a violation | Throws `UserError`, not persisted | None; persisted and scored as usual |
| Rule changes | Versioned, deliverable, Evals re-queued | None |

**What to borrow**

Borrow "**authorization is a queryable object, not an adjective**". The red team does not need Policy versioning (no multi-tenancy),
but it does need an explicit `engagement.scope` + **a single entry point that every write tool passes through**.
The current problem is divergence: `redteam_batch` rejects out-of-scope, `redteam_asset_add` does not ——
the same asset via batch and via single add gives different results; that is a design defect, not an implementation bug.

---

### 3.8 Result verification (the report says it got it; how to confirm it is real)

**superagent**

- **Structural validation** (from `src/core/assignments.ts:96`): the report's `askedBy` must be a human message that can reach this
  Ticket (`person(id, true)`), and `answers` must be answerable (`person(id, false)`),
  otherwise it throws `notAsker` / `notAnswerable`.
- **State validation**: `ready` allows ending only when the work is really done; a Ticket following a PR must check whether the PR is really closed.
- **Delivery validation**: `inputsDelivered` / `inputsRead` are two separate facts ——
  "delivered" and "read" are not the same thing, and only the latter moves `readAt`.
- **Retry persistence**: `RECOVERY_NOTE` requires the post-restart Executor to look at the directory, git history, and GitHub first,
  before deciding whether to repeat external actions.

**This plugin** (this part is actually not bad, but be clear about what it verifies)

- `redteam_session_check` (`lib/redteam/tools.js:1782`): **really initiates** an HTTP / SOCKS5 CONNECT
  to connect to WebShells and tunnels, and writes online/offline back to the database. In 1.1.75 `socks5Probe` (`:454`) is a complete three-stage handshake.
  This is real verification, not reading fields.
- `redteam_data_proof` (`:2503`): structured record fields / row counts / samples / provenance,
  with `row_count >= 10000` automatically flagged as `meets_threshold` —— turning "P1 ten thousand rows" from an adjective into a comparable number.
- `redteam_score_report` (`:2151`): only includes results that actually scored, each with a paste-ready raw request where possible.
- The coverage tables (`asset_coverage` / `host_coverage`) split "is it done" into 5 and 7 items,
  and `redteam_asset_next` / `redteam_next_action` read the gaps from them.

**Where the difference is**

| Dimension | superagent | This plugin |
| --- | --- | --- |
| Report validation | Engine-level rejection of illegal references | None (persisted as soon as `redteamReport` parses) |
| Definition of "got it" | Explicit state transitions | Depends on whether the tool was written correctly (vuln status=confirmed/exploited) |
| Connectivity | Not applicable | Verified (really sends packets) |
| Data volume | Not applicable | Verified (structured row counts) |
| Report↔database consistency | Yes | **No mandatory check**: the report says "got 12 servers", but is it 12 rows in `score_hit`? Nobody verifies |

**What to borrow**

Borrow "**a report must be verifiable by the rows in the database**". The red team already has all the material (`score_hit`, `vuln`, `credential`,
`webshell`, `tunnel`, `host_finding`); what is missing is a **checking action**:
compare the numbers claimed in `agent_report.summary` against the rows actually written by that session (or this round of the target) in the database,
and flag any mismatch. This suits the red team better than superagent's reference validation, because the red team's "results" are naturally counts.

---

## 4. Current-state inventory: implemented / half-implemented / not implemented

### 4.1 Implemented (no worries)

| Capability | Location | Note |
| --- | --- | --- |
| Target workspace + SQLite fact base | `lib/redteam/store-core.js`, `schema.js` | 20+ tables, covering assets/ports/services/vulnerabilities/credentials/WebShells/tunnels/attack steps/scoring points/hits/coverage/reports |
| Unified op routing | `dispatch` in `store-core.js` | The panel, CLI, and tools share one vocabulary |
| Role-draft injection | `lib/redteam/role-section.js` | `redteamRole:` regex + reading `agents/<code>.md` per target |
| Structured reports | `store-core.js:1894 / :1970` | Free-text parsing + persistence, keeping 20 rows per session |
| Waiting queue | `store-core.js:2058` `attentionQueue` | Sorting + `needs` aggregation + coverage gaps |
| Waiting-queue closure | `store-core.js:2008` `acknowledgeAgentReports` | **Added this time**, see §6 |
| Concurrency quota (advisory) | `tools.js:902` + `slot-state.js` | Really reads the registry; parked sessions do not occupy a slot |
| Coverage-driven next step | `store-core.js:1738 / :1854` | `hostNextActions` / `assetNextActions` |
| Real connectivity verification | `tools.js:1782 / :454` | Real HTTP + SOCKS5 probing |
| Structured data proof | `tools.js:2503` | Fields/row counts/samples, 10k-row threshold |
| Scope validation (partial) | `tools.js:444` | Called by only 2 entry points |
| Unified scoring stance | `lib/redteam/score-rules.js` | Per-service cap, per-service dedup, G5/G6 multipliers |
| Skill library | 40 files in `skills/redteam/` | Unrelated to this problem, but it is the "how to attack" asset |

### 4.2 Half implemented (the skeleton exists, the critical half is missing)

| Capability | Part that exists | Part that is missing |
| --- | --- | --- |
| Task state | The `agent_report.status` enum + stage mapping | No `ended` / `idle` / `queued`; no "end" semantics |
| Scheduling | Quota queries + prompt discipline | No code-level rejection; no tick; no timeout |
| Boundary | `scopeCheck` + 2 entry points | The other write tools do not validate; authorization is not an object |
| Verification | Connectivity, data volume, score report | Consistency check between reports and database row counts |
| Session delivery | One-directional reporting via `subagent/end` | No Input return channel; no idempotency; no waking |
| Re-dispatch | Can spawn again | Context lost; no task id; no recovery path after restart |

### 4.3 Not implemented (explicitly absent)

| Capability | Note | Needed? |
| --- | --- | --- |
| Trigger / Source layer | The red team has no external event source | **Not needed** |
| Channel / reply routing | No Feishu/GitHub reply requirements | **Not needed** |
| Policy versioning | Single user, single target | **Not needed** |
| Mandate object | Authorization is one sentence | Needed, but can be minimal (one scope + one immutable open record) |
| Assignment lifecycle | A child session = one-off | **Needed**; it is the core of §3.4 |
| Effects persistent queue | All side effects are done synchronously at the call site | Partially needed (delivery and re-dispatch) |
| Eval / decision layer | No independent decision | Partially needed (the decision table can be ported directly) |

---

## 5. Order and trade-offs for closing the gaps

**Do not port everything at once.** Sort by "it keeps causing incidents until fixed":

### Phase one: stop the bleeding (half of this was done this time)

1. ✅ Reports can be closed (`acknowledged_at` + `redteam_attention action=ack` + the `attentionAck` op).
2. ✅ "Go handle it" only fills, never sends (removed `submitAttentionPrompt`; the button is now "fill into the main session input box").
3. ⬜ **Turn the quota into a hard constraint**: reject over-cap spawns at the `tools/pre-execute` layer (mind the downgrade logic in `lib/tool-gate.js`).
   This is the only backstop for prompt discipline.
4. ⬜ **Plugin messages carry their own identity**: any text the plugin pushes into the main session must no longer go through the render layer's
   `input.submit`, otherwise `kind: "user"` makes it permanently indistinguishable from real human input.

### Phase two: make state queryable (corresponds to §3.5 / §3.6)

5. ⬜ An `agent_task` table: one row per task, with an id, role, status, current assignment, and previous round's conclusion.
   `redteam_agent_slot acquire` returns an assignment id instead of an in-memory `label#timestamp`.
6. ⬜ Port the `ticketStage` decision table and fill in `ended` / `idle` / `queued`.
7. ⬜ Define "end": `ready` / `dropped` converge the task; it no longer lives forever.

### Phase three: make re-dispatch meaningful (corresponds to §3.3 / §3.4)

8. ⬜ Once tasks are persisted, re-dispatch = a new assignment pointing at the same task id, with the task summary carrying "what has been tried".
9. ⬜ Idempotent delivery: give every plugin message a deterministic id to avoid duplicates.
10. ⬜ Restart recovery: rebuild "which tasks are running / which are waiting for a human" from `agent_task`.

### Phase four: consolidate the boundary into one place (corresponds to §3.7)

11. ⬜ All write tools pass through the same `assertInScope`, instead of it being scattered across 2 entry points.
12. ⬜ Consistency check between reports and the database (corresponds to the gap in §3.8).

**Explicitly out of scope**: Source / Channel / Policy versioning / PR lifecycle / Eval deadline re-queueing.
Reason: the red team has no multiple sources, multi-tenancy, or external PRs. Porting them only creates code nobody calls.

---

## 6. This incident's defect as design rationale

### 6.1 Symptom

A fixed block of text ("the drill ground has N agents waiting for someone…") appeared periodically in the main session conversation, word for word identical.

### 6.2 Localization (evidence-based, not speculation)

In the session log `<DSH_HOME>/sessions/<WORKSPACE>/<SESSION>/session.v4.jsonl.zstd`
(multi-frame concatenated zstd; must be decompressed frame by frame using the `28 b5 2f fd` magic):

- The text appears in 8 records: 4 as `agent/inbox/spliced`, 4 as `user/message`;
- Among the 4, there are **4 different `rpcId`s**;
- The source is always `{ kind: "user", rpcId: ..., clientTimeZone: "Asia/Shanghai" }`.

`kind: "user"` + `rpcId` means: this was really submitted by the render layer through a host RPC, **not written by the plugin**.
Plugin-written messages carry `kind: "plugin"` or `kind: "de-policy"` (the correct form is in
`lib/continue-retry.js:128`).

### 6.3 Causal chain (two defects superimposed)

1. **`attentionQueue` has no closure semantics** (the old version at `store-core.js:2058`):
   it takes the latest report per session, and `waiting`/`ready`/`blocked`/`failed` stay forever.
   The demo data `demo-vuln-scan` / `demo-exploit` / `demo-internal` sat in the target `TARGET_REMOVED` indefinitely.
2. **`handleAttention` really sends** (the old `handleAttention` in `client.js`):
   the doc comment said "fill only, do not auto-send", but the code called `submitAttentionPrompt` → `input.submit('queue')`.
   So every trigger: generated **byte-identical** text → filled it into the input box → submitted it as a human message.

The two multiplied = "the same paragraph was really sent N times". **Fixing only one is not enough**:
fix only 1 and the button still sends the same text out; fix only 2 and the queue is still never empty, and the pill still says "N people are waiting".

### 6.4 Fixes already made

| Change | File | Effect |
| --- | --- | --- |
| `agent_report.acknowledged_at` column + migration | `lib/redteam/schema.js:387 / :607 / :732` | A report can be marked as handled |
| `acknowledgeAgentReports(id, {session_id\|ids\|all})` | `lib/redteam/store-core.js:2008` | Only affects that session's latest row; idempotent |
| `attentionQueue` skips handled rows | `lib/redteam/store-core.js:2073` | The queue really does become empty |
| `attentionAck` op | `lib/redteam/store-core.js:922` | Shared by panel/CLI/tools |
| `redteam_attention action=ack` | `lib/redteam/tools.js:1388` | The main session can close out what it has handled |
| Removed `submitAttentionPrompt`; `handleAttention` fills only, never sends | `client.js:22972` | No longer decides on the human's behalf |
| Button label "dispatch to main session for handling" → "fill into the main session input box" | `client.js`, `lib/redteam/client.js` | Wording matches behaviour |
| Prompts gained "after handling each one, use action=ack to remove it" | `client.js:22936` | Makes closure part of the workflow |

**Evidence** (real-machine database `<DSH_HOME>/redteam`, target `TARGET_REMOVED`):

```
[before]  total: 3, awaiting: 3
[ack 1]   {"acknowledged":1}          → total 2, demo-exploit / demo-internal remain
[ack all] {"acknowledged":2}          → total 0, gaps 1
[idempotent] {"acknowledged":0}       → repeated ack has no side effects
a newly written waiting report → total 1, back in the queue (proving "new events still come in")
measured column structure includes acknowledged_at
```

### 6.5 Design lessons (constraints to write into subsequent implementations)

1. **Words meant for the user must not be sent on the user's behalf by code.** Where a human decision is needed, code only organizes it;
   the send key must be pressed by the human.
2. **Plugin-synthesized content must carry its own identity.** Going through the render layer's submit turns it into `kind: "user"`,
   after which it can never be distinguished from real human input —— and "distinguishing human input from automatic input" is a prerequisite for many capabilities
   (see `hasFreshHumanTurn` in `lib/continue-retry.js`).
3. **A queue with no closure action is a constant.** Any "waiting for someone" list must have a "handled" transition,
   otherwise it can neither drive a workflow nor carry information.
4. **Doc comments and code must change together.** The primary scene of this defect was a comment saying "fill only, do not auto-send"
   with the very next line calling submit.

---

## 7. Terminology mapping

| superagent | Meaning | Counterpart in this plugin | Equivalent? |
| --- | --- | --- | --- |
| Source | Event source | None | No |
| Trigger | Event | The task description of one spawn | No (no dedup, no ownership) |
| Thread | Thread | Target (engagement) + session binding | Partially |
| Eval | Decision | The main session deciding for itself | No (no deadline, no re-queueing) |
| Ticket | Work ticket | **None** (the most critical gap) | No |
| Mandate | Authorization credential | One sentence in a prompt + `engagement.scope` | No |
| Assignment | Execution round | One `subagent` spawn | Partially (no id, no renewal) |
| Report | Report | One `agent_report` row | Partially (persists, but could not be closed → now fixed) |
| Attention | Pending question | `agent_report.status='waiting'` + `needs[]` | Partially (no id, not revocable) |
| Effects | Side-effect queue | None (all done synchronously at the call site) | No |
| Passes | Scheduling tick | None | No |
