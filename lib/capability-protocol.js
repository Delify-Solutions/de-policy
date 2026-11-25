/**
 * Capability selection protocol: read the skill / MCP catalog first, then pick per current task.
 * Leaves official skill registration, MCP mounts, and tool permissions untouched.
 * Official DSH already documents tool usage, so no extra Host tools discipline is added here.
 */

// [de-policy] No `de-policy` prefix: the host renderPrompt has a step
// filter(s => s.name.startsWith("de-policy")) that moves such sections to the front in insert order.
// The old name "de-policy:capabilities" matched the prefix, so cap landed before inject (dump line 1),
// inverting the render to "cap first, inject second". Rename to dodge that filter.
export const CAPABILITY_SECTION = "dshpg-capabilities";

const OFFICIAL_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first**: Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.
2. **Match the task**: From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task — not “always use something”, not “never use something”.
3. **Call what matches**:
   - Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   - Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool’s semantics.
4. **Only then DIY**: If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.
5. **Subagents / sub-delegates inherit this rule**: Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.
6. Host skills and MCP stay available; this prompt does not remove them.`;

const REDTEAM_LEAD_PROTOCOL = `## Capability selection by task (redteam lead)

1. You plan, dispatch with \`subagent\`, verify results, and report. Executors do hands-on work.
2. Before dispatch, know which skills/MCP fit the next stage (from \`<available_skills>\` / redteam skills / session MCP).
3. In every \`subagent\` brief: require the child to **read the skill/MCP catalog, then call only what the assigned task needs** (name concrete skill codes when you know them).
4. Do not ban skill or MCP for children. Leaf limits apply only to further delegation tools (\`subagent_fork\` / workflow / ralph), not to skill/MCP.
5. Vague “go investigate” briefs are wrong; task-matched skill/MCP instructions are right.`;

/**
 * @param {{ redteam?: boolean, redteamChild?: boolean, enabled?: boolean }} [opts]
 * @returns {string}
 */
export function capabilityProtocolText(opts = {}) {
  if (opts.enabled === false) return "";
  // Child agents / subagents follow the main session: read catalog, then call task-matched skill/MCP.
  // Redteam extras (role / dispatch) mount separately; this does not swap in a second process here.
  if (opts.redteamChild) return OFFICIAL_PROTOCOL;
  if (opts.redteam) return REDTEAM_LEAD_PROTOCOL;
  return OFFICIAL_PROTOCOL;
}
