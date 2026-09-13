import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { renderDesignModePrompt } from '../design-mode-prompt'
import { MAESTRO_SYSTEM_SPEC } from '../maestro-prompt'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import type { ResolvedHarness } from './types'

/**
 * Host contracts are composed outside the replaceable profile text. Mode limits, the actually
 * available toolset, memory/project guidance, Maestro and autonomy are Maestrly's authority: a
 * profile supplies style and work guidance, never permission to drop these sections.
 */

export const HOST_USING_TOOLS = `# Using your tools
Prefer the dedicated tools over the shell: \`read\` to read files (not cat/head/tail/sed), \`edit\`/\`write\` to change them (not sed/awk/echo redirection), \`grep\`/\`glob\` to search (not grep/find/ls) — they let the user review your work cleanly and are faster. Reserve \`bash\` for real shell/system work (build, tests, git, running scripts). When you decide to use a tool, call it in the SAME turn — don't announce "I'll read the file" and then stop and wait for the user. When several tool calls are independent (none needs another's result), make them in parallel in one response; only go sequential when a call genuinely depends on a previous result.`

export const HOST_RESTRICTED_CAPABILITIES =
  'Besides read/search tools, you may receive external MCP tools explicitly declared read-only and permitted ' +
  'Maestrly app tools for notes, memory search/list/read, web navigation/read, and terminal output. ' +
  'Those catalogs remain permission-gated. Do NOT edit project files or run commands: code/file writes, shell ' +
  'execution, page interaction through click/type/drag/key/mouse/evaluate, debug, implementation delegation, ' +
  'Git/PR changes are unavailable.'

export function hostIdentityLine(cwd: string): string {
  return `You are a coding assistant inside the Maestrly app, working with the user on the project at ${cwd}. Reply in the user's language, in Markdown.`
}

/** Versioned, execution-scoped behavioral identity. Derived from the resolved contract, never templated in a profile. */
export function harnessBehaviorHeader(harness: ResolvedHarness): string | null {
  if (!harness.prompts.behaviorHeader || !harness.identity.behaviorProfileId) return null
  return `# Behavioral profile\n${harness.identity.behaviorProfileId} for ${harness.profileId}. This profile is scoped to this execution.`
}

export function hostCapabilitySection(mode: ChatBehavior): string {
  if (mode === 'maestro') {
    return `\n\nMAESTRO EXPERIENCE: the parent is structurally read-only. You may inspect with read/search tools and coordinate through delegate, but you cannot edit, write, run shell commands, test, build, generate mutable artifacts, or invoke mutating MCP/app tools directly.\n\n${MAESTRO_SYSTEM_SPEC}`
  }
  if (mode === 'ask') {
    return `\n\nASK MODE (restricted tools): use the available read and safe-recording tools to ground your answer in real project context. ${HOST_RESTRICTED_CAPABILITIES} If the task requires changing the project or running commands, tell the user to switch to Agent mode (they toggle it with Shift+Tab).`
  }
  if (mode === 'plan') {
    return `\n\nPLAN MODE (restricted tools): investigate with the available read and safe-recording tools. ${HOST_RESTRICTED_CAPABILITIES} Record the final plan by calling review_plan ("plan" argument in Markdown + a short "title"): that submits it to the "Plan" tab in the drawer for the user to review, edit and approve or discard. Calling review_plan ENDS your turn — do NOT keep writing or call other tools after it. If the user approves, a new turn starts to implement the plan. Do NOT dump the plan in the text only: leave at most a 1-2 line summary and ALWAYS finish by calling review_plan.`
  }
  return `\n\nYou have tools to read/search/edit files and run commands. Prefer small, verifiable actions. Before editing, read the relevant snippet. Dangerous actions (bash, writing/editing files, fetching URLs) ask for the user's approval — briefly explain why before calling them.`
}

export const HOST_RENDERING = `\n\nRendering: the chat supports full Markdown, including GFM tables and Mermaid DIAGRAMS. For any diagram (flow, architecture, sequence, etc.) use a \`\`\`mermaid block instead of drawing ASCII art — it renders as a real visual diagram.`

export function hostAppToolsSection(appToolsEnabled: boolean, hasNotesTab: boolean, mode: ChatBehavior): string {
  const capabilityMode = capabilityBehaviorFor(mode)
  const appToolGroups = hasNotesTab ? 'terminal, browser, notes, memory, debug' : 'terminal, browser, memory, debug'
  const appToolPrefixes = hasNotesTab
    ? 'terminal_*, browser_*, notes_*, memory_*, debug_*'
    : 'terminal_*, browser_*, memory_*, debug_*'
  const preferredDrawerTools = hasNotesTab ? 'terminal_*/memory_*/notes_*' : 'terminal_*/memory_*'
  const restrictedAppTools =
    mode === 'maestro'
      ? hasNotesTab
        ? 'notes list/read, memory search/list/read, browser inspection/read, and terminal read'
        : 'memory search/list/read, browser inspection/read, and terminal read'
      : hasNotesTab
        ? 'notes list/read/create/write/append, memory search/list/read, browser navigation/read, and terminal read'
        : 'memory search/list/read, browser navigation/read, and terminal read'
  return `\n\nMaestrly app tools (${appToolGroups}): ${
    appToolsEnabled
      ? capabilityMode === 'agent'
        ? `ON — you receive them NATIVELY in your tool set (${appToolPrefixes}). Use them directly. PREFER ${preferredDrawerTools} over your equivalent native tools (bash/read/edit and your own memory) when the user should see, follow or edit the result in the drawer — running a server, a long build, a script, recording a decision or a durable project rule: that way they follow along in the UI. A quick internal one-off (e.g. git status) can stay on the native tools.`
        : `ON with this mode's restricted catalog: ${restrictedAppTools}. Use only the tools actually exposed; mutating tools outside this list remain unavailable.`
      : 'OFF right now. If you need them, ASK the user to enable "Maestrly tools" in Settings › Maestrly Chat.'
  }\nNEVER try to reach the app via curl/HTTP or inspect legacy local credentials. The app tools, when on, already arrive ready in your toolset (no network, no token).`
}

export interface MaestrlyBasePromptInput {
  harness: ResolvedHarness
  cwd: string
  appToolsEnabled: boolean
  mode: ChatBehavior
  hasNotesTab: boolean
}

/**
 * Mode-aware base prompt shared by every non-Responses transport. Tool descriptions must match the
 * actual toolset: models otherwise assume tools exist and emit calls the harness cannot serve.
 */
export function buildMaestrlyBasePrompt(input: MaestrlyBasePromptInput): string {
  const header = harnessBehaviorHeader(input.harness)
  const base = [hostIdentityLine(input.cwd), header, input.harness.prompts.styleAndWork, HOST_USING_TOOLS]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
  const designPrompt = renderDesignModePrompt(input.mode)
  return (
    base +
    hostCapabilitySection(input.mode) +
    HOST_RENDERING +
    hostAppToolsSection(input.appToolsEnabled, input.hasNotesTab, input.mode) +
    `\n\n${MEMORY_TOOL_GUIDANCE}` +
    (designPrompt ? `\n\n${designPrompt}` : '')
  )
}

/** Per-mode extended-reasoning guidance declared by a profile; host Ultra blocks stay with the runners. */
export function harnessUltraGuidance(harness: ResolvedHarness, mode: ChatBehavior): string | null {
  const ultra = harness.prompts.ultra
  if (!ultra) return null
  const suffix = ultra.byMode[mode]
  return suffix ? `${ultra.base} ${suffix}` : ultra.base
}

/** Delegation contract appended to a subagent prompt. Absence keeps the legacy prompt untouched. */
export function harnessSubagentPrompt(legacyPrompt: string, harness: ResolvedHarness): string {
  const header = harnessBehaviorHeader(harness)
  const contract = harness.prompts.subagent
  if (!header && !contract) return legacyPrompt
  return [legacyPrompt, header, contract].filter((part): part is string => Boolean(part)).join('\n\n')
}

/** Continuity contract appended to the compaction system prompt. */
export function harnessCompactionSystem(legacySystem: string, harness: ResolvedHarness): string {
  return harness.prompts.compaction ? `${legacySystem}\n\n${harness.prompts.compaction}` : legacySystem
}

export function harnessEnvironmentContext(environment: string): string {
  return `# Current environment\n${environment}`
}
