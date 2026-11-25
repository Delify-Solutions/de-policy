/**
 * Bypass for the tool pre/post waterfalls: downgrade only, never take over.
 *
 * The host runs every tool call through two extensible chains (cordis waterfall:
 * first registered runs first; any layer that skips next() truncates all later ones):
 *
 *   pipeline.prepare()
 *     gate = waterfall("tools/pre-execute", exec, () => {kind:"allow"})
 *     gate.kind === "allow" -> still passes tools.checkGuards(exec)
 *
 *   pipeline.postExecute()
 *     decision = waterfall("tools/post-execute", exec, result, () => {kind:"accept"})
 *     decision.kind === "block" -> result is rewritten as isError
 *
 * Only the upstream layer can deny:
 *   dsh-experimental-auto-review  classes risk under AUTO presets in pre-execute,
 *   returning deny / ask / a reviewer error
 *
 * So this never hard-truncates the chain: returning allow outright would switch off
 * real downstream side effects too (dsh-tool-jobs output caps, the edit snapshots of
 * dsh-workspace-changes, dsh-spill-policy truncation of oversized results), which
 * introduces bugs far harder to trace than a denial.
 * Instead call next() as usual so every layer runs, then flatten the verdict into
 * allow / accept.
 */

/** pre-execute verdict: allow only; ask / deny / cancel all downgrade. */
function coerceGate(decision) {
  if (!decision || typeof decision !== "object") return { kind: "allow" };
  return decision.kind === "allow" ? decision : { kind: "allow" };
}
/** post-execute verdict: block is forbidden; content / value rewrites pass as before. */
function coercePost(decision) {
  if (!decision || typeof decision !== "object") return { kind: "accept" };
  return decision.kind === "block" ? { kind: "accept" } : decision;
}

/**
 * Delegation tool names. The host configures them in `dsh-base/cordis.patch.yml`:
 *   tool-subagent      → toolName: subagent
 *   tool-subagent-fork → toolName: subagent_fork
 *   tool-workflow      → workflow by default
 * All three can delegate further, so a child agent may nest without limit.
 */
const DELEGATION_TOOLS = new Set(["subagent", "subagent_fork", "workflow"]);

/**
 * Whether this session is a subagent (leaf) spawned by someone else.
 *
 * Same criteria as identity.js isChildAgentContext: delegation origin and depth only.
 * **`parentSession` is ignored** — resumed or branched sessions write it too, and such
 * a session is its own root; blocking it would stop all further delegation.
 */
function isLeafAgent(agent) {
  const header = agent?.session?.header;
  if (!header) return false;
  const origin = String(header.origin || "").toLowerCase();
  if (origin === "subagent" || origin === "teammate" || origin === "delegate") return true;
  return Number(header.delegationDepth ?? 0) > 0;
}

/**
 * Subagents may not delegate further.
 *
 * The prompt line "you are a leaf, do not delegate" only appeals to the model's
 * discipline; it complied once, but that was luck. So block on the waterfall: the call
 * returns a denial and the tool never runs. The rest of the allow logic is unchanged.
 */
function denyDelegation(exec) {
  /* exec shape: dsh-tools/lib/pipeline.js:createExecution — the tool name is exec.name. */
  const name = String(exec?.name || exec?.tool?.name || "");
  if (!DELEGATION_TOOLS.has(name)) return null;
  if (!isLeafAgent(exec?.agent)) return null;
  return {
    kind: "deny",
    reason: `Subagent là nút lá, không thể giao việc tiếp (${name}). Hãy làm xong nhiệm vụ hiện tại rồi báo cáo lại.`,
  };
}

export function installToolGateBypass(ctx, config = {}) {
  if (config.toolGateBypass === false) return () => {};
  if (typeof ctx?.on !== "function") return () => {};

  const offs = [];

  // global is required: the host calls ctx.waterfall(scopeTarget(this.tools, exec.agent),
  // ...) inside agent scope; a hook on the plugin's own ctx never fires.
  // prepend is required: this plugin applies last in the bundle, so prepend puts the last
  // registration outermost, which is the only way to see the downstream final verdict.
  try {
    offs.push(ctx.on("tools/pre-execute", async (exec, next) => {
      /* Subagent delegating again: deny here, the tool never runs and the downstream
         review chain is skipped. Kept first: it is our only active decision, the rest
         is downgraded to allow. */
      const denial = denyDelegation(exec);
      if (denial) return denial;
      if (!exec || typeof exec !== "object") {
        return typeof next === "function" ? coerceGate(await next()) : { kind: "allow" };
      }
      if (typeof next !== "function") return { kind: "allow" };
      try {
        return coerceGate(await next());
      } catch {
        // A downstream throw makes waterfall mark the whole call isError; downgrade to
        // allow so the tool itself runs: another reviewer's fault must not be our denial.
        return { kind: "allow" };
      }
    }, { global: true, prepend: true }));
  } catch { /* old host has no tools/pre-execute */ }

  try {
    offs.push(ctx.on("tools/post-execute", async (exec, result, next) => {
      if (typeof next !== "function") return { kind: "accept" };
      try {
        return coercePost(await next());
      } catch {
        return { kind: "accept" };
      }
    }, { global: true, prepend: true }));
  } catch { /* old host has no tools/post-execute */ }

  // tools.checkGuards() runs separately after the waterfall in other plugins' scope, so
  // it is untouched here. In 0.2.2 only these register guards: dsh-subagent (structured
  // output recorded → further tools skipped, a normal stop), dsh-creation-recommendations
  // (plugin_manager may only create files), dsh-experimental-liveshare (fork is read-only).
  // Those are flow constraints, not content denial. Erasing them breaks the host's own
  // teardown, so they are left as-is on purpose.

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* already released */ }
    }
  };
}
