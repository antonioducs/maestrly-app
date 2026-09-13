import { capabilityBehaviorFor } from '../../../../shared/chat-mode'
import { renderDesignModePrompt } from '../../design-mode-prompt'
import { MEMORY_TOOL_GUIDANCE } from '../../memory-tool-guidance'

/**
 * Reusable Responses-prompt composition strategies. They know slots — base instructions, mode,
 * host tools, project, skills, subagents, Ultra and environment — and never a model name. A profile
 * selects a strategy and supplies the base text; the host overlays stay here.
 */

export type OpenAIPromptMode = 'agent' | 'design' | 'plan' | 'ask'

export interface OpenAIPromptLayoutInput {
  /** Base instructions supplied by the resolved profile. */
  base: string
  cwd: string
  mode: OpenAIPromptMode
  appToolsEnabled: boolean
  hasNotesTab: boolean
  projectContext?: string | null
  skillsContext?: string | null
  agentsContext?: string | null
  envContext?: string | null
  ultraContext?: string | null
  nativeTools?: { localShell: boolean; applyPatch: boolean }
}

export interface CompiledPromptLayout {
  /** Complete value to send as Responses API instructions. */
  instructions: string
  /** Stable, cache-friendly prefix: base, Maestrly policy, and durable workspace context. */
  stablePrefix: string
  /** Volatile environment section, deliberately kept at the end. */
  volatileSuffix: string
}

const clean = (value: string | null | undefined): string => value?.trim() ?? ''

const section = (title: string, body: string | null | undefined): string => {
  const content = clean(body)
  return content ? `# ${title}\n\n${content}` : ''
}

const joinSections = (parts: Array<string | null | undefined>): string => parts.map(clean).filter(Boolean).join('\n\n')

const modeOverlay = (mode: OpenAIPromptMode): string => {
  const restrictedCapabilities = `Besides read/search tools, you may receive external MCP tools explicitly declared read-only and permitted Maestrly app tools for notes, memory search/list/read, web navigation/read, and terminal output. Those catalogs remain permission-gated. Do not edit project files or run commands: code/file writes, shell execution, page interaction through click/type/drag/key/mouse/evaluate, debug, implementation delegation, and Git/PR changes are unavailable.`
  if (mode === 'ask') {
    return `# Maestrly mode

ASK MODE has restricted tools. Use the available read and safe-recording tools to ground answers in real project context. ${restrictedCapabilities} If the task requires changes or commands, tell the user to switch to Agent mode.`
  }

  if (mode === 'plan') {
    return `# Maestrly mode

PLAN MODE has restricted tools. Investigate with the available read and safe-recording tools. ${restrictedCapabilities} Then submit the final plan with review_plan using a Markdown plan and short title. Calling review_plan ends the turn: do not call more tools afterward. Leave at most a one- or two-line text summary and do not replace review_plan with a text-only plan.`
  }

  return `# Maestrly mode

${mode === 'design' ? 'DESIGN MODE uses Agent-equivalent capabilities. It' : 'AGENT MODE'} provides tools to read, search, edit and write files, run commands, and track non-trivial work with todo_write. Prefer small, verifiable actions. Read the relevant code before editing it. Permission-sensitive tools are gated by the harness; explain the reason concisely when approval is requested.`
}

const appToolsOverlay = (enabled: boolean, hasNotesTab: boolean, mode: OpenAIPromptMode): string => {
  const capabilityMode = capabilityBehaviorFor(mode)
  const groups = hasNotesTab
    ? 'terminal_*, browser_*, notes_*, memory_*, and debug_*'
    : 'terminal_*, browser_*, memory_*, and debug_*'
  const preferred = hasNotesTab ? 'terminal_*, memory_*, and notes_*' : 'terminal_* and memory_*'

  if (!enabled) {
    return `# Maestrly app tools

Drawer tools are disabled. If the task genuinely requires them, ask the user to enable Maestrly tools in Settings > Maestrly Chat. Never reach the app through curl/HTTP or inspect legacy local credentials.`
  }

  if (capabilityMode !== 'agent') {
    const restricted = hasNotesTab
      ? 'notes list/read/create/write/append, memory search/list/read, browser navigation/read, and terminal read'
      : 'memory search/list/read, browser navigation/read, and terminal read'
    return `# Maestrly app tools

Drawer tools are enabled with this mode's restricted catalog: ${restricted}. Use only the tools actually exposed; mutating tools outside this list remain unavailable. Never reach the app through curl/HTTP or inspect legacy local credentials.`
  }

  return `# Maestrly app tools

Drawer tools are available as ${groups}. Use them directly. Prefer ${preferred} over equivalent native tools when the user should see, follow, or edit a long-running result or durable project decision in the drawer. A quick internal one-off can stay on native tools. Never reach the app through curl/HTTP or inspect legacy local credentials.`
}

const skillsOverlay = (skillsContext: string | null | undefined): string => {
  const content = clean(skillsContext)
  if (!content) return ''
  return `# Project skills

When the task matches a listed skill, call use_skill with its name before acting, read the returned instructions completely, and follow them for that turn. Use the minimal set of relevant skills. User instructions take precedence over skill instructions.

${content}`
}

/**
 * Tool-name correction shared by every Responses prompt strategy. It is deliberately appended after
 * generic guidance because native provider tools replace, rather than supplement, the corresponding
 * Maestrly function tools in the actual toolset.
 */
export const openAINativeToolsPromptOverlay = (
  nativeTools: OpenAIPromptLayoutInput['nativeTools'],
  mode: OpenAIPromptMode
): string => {
  if (capabilityBehaviorFor(mode) !== 'agent' || !nativeTools) return ''
  const mappings = [
    nativeTools.localShell
      ? '- Use `local_shell` for argv-based local commands. The legacy `bash` tool is not exposed; do not call it.'
      : '',
    nativeTools.applyPatch
      ? '- Use `apply_patch` for structured create/update/delete diffs. The legacy `edit` and `write` tools are not exposed; do not call them.'
      : '',
  ].filter(Boolean)
  if (mappings.length === 0) return ''
  return `# Active OpenAI workspace tools

The active Responses toolset replaces some generic Maestrly tool names. The mapping below supersedes any earlier guidance that names those legacy tools:

${mappings.join('\n')}

These provider-native tools use the same Maestrly approval and workspace boundaries.`
}

/**
 * Codex-derived port layout: an upstream base followed by explicit Maestrly overlays, with an exact
 * stable/volatile boundary so `envContext` never invalidates project, skill or agent prefixes.
 */
export function composeOpenAICodexPortPrompt(input: OpenAIPromptLayoutInput): CompiledPromptLayout {
  const cwd = clean(input.cwd)
  if (!cwd) throw new Error('cwd is required to compile the OpenAI prompt')

  const maestrlyOverlay = joinSections([
    '# Maestrly harness\n\nThe active workspace is ' +
      cwd +
      ". Reply in the user's language. Use only tools actually exposed by this harness, and never invent a Codex-only tool or protocol.",
    modeOverlay(input.mode),
    openAINativeToolsPromptOverlay(input.nativeTools, input.mode),
    appToolsOverlay(input.appToolsEnabled, input.hasNotesTab, input.mode),
    MEMORY_TOOL_GUIDANCE,
    '# Rendering\n\nThe chat supports GitHub-flavored Markdown, tables, and Mermaid diagrams. Use a Mermaid code block for diagrams instead of ASCII art.',
  ])

  const stablePrefix = joinSections([
    input.base,
    maestrlyOverlay,
    renderDesignModePrompt(input.mode),
    section('Project instructions', input.projectContext),
    skillsOverlay(input.skillsContext),
    section('Subagents', input.agentsContext),
    section('Ultra mode', input.ultraContext),
  ])
  const env = clean(input.envContext)
  const volatileSuffix = env ? section('Environment', env) : ''
  return { instructions: joinSections([stablePrefix, volatileSuffix]), stablePrefix, volatileSuffix }
}

const ASTRA_MODE_INSTRUCTIONS: Record<OpenAIPromptMode, string> = {
  agent:
    'Agent mode: carry authorized work through implementation and verification. Write only within the active permission and sandbox policy.',
  design:
    'Design mode: build a navigable visual prototype with Agent-equivalent capabilities under the active permission and sandbox policy.',
  plan: 'Plan mode: investigate and prepare a reviewable implementation plan. Do not implement the planned code before the host starts a later approved turn.',
  ask: 'Ask mode: answer, explain, review, or diagnose. Read-only investigation is allowed; do not mutate the project unless the user explicitly changes the task.',
}

const optionalSection = (title: string, value: string | null | undefined): string => {
  const body = value?.trim()
  return body ? `\n\n# ${title}\n\n${body}` : ''
}

const astraToolPolicy = (input: OpenAIPromptLayoutInput): string => {
  const tools: string[] = []
  if (input.nativeTools?.localShell) tools.push('Use local_shell for shell commands.')
  if (input.nativeTools?.applyPatch) tools.push('Use apply_patch for manual file edits.')
  if (input.appToolsEnabled) tools.push('Connected app tools may be used when their data is in scope.')
  if (input.hasNotesTab) tools.push('Project notes are available through the Memory Center contract below.')
  return tools.length ? `\n\n# Host tools\n\n${tools.join(' ')}` : ''
}

/**
 * Concise host policy layered over a provider-owned native operating prompt: stable host prefix plus
 * a volatile environment suffix.
 */
export function composeOpenAIConcisePrompt(input: OpenAIPromptLayoutInput): CompiledPromptLayout {
  const designPrompt = renderDesignModePrompt(input.mode)
  const stablePrefix = [
    input.base,
    `\n\n# Active mode\n\n${ASTRA_MODE_INSTRUCTIONS[input.mode]}`,
    designPrompt ? `\n\n${designPrompt}` : '',
    astraToolPolicy(input),
    optionalSection('Project and workspace instructions', input.projectContext),
    optionalSection('Memory Center', MEMORY_TOOL_GUIDANCE),
    optionalSection('Available skills', input.skillsContext),
    optionalSection('Available subagents', input.agentsContext),
    optionalSection('Extended reasoning policy', input.ultraContext),
  ].join('')
  const volatileSuffix = optionalSection(
    'Current environment',
    [`Working directory: ${input.cwd}`, input.envContext?.trim()].filter(Boolean).join('\n')
  )
  return { instructions: stablePrefix + volatileSuffix, stablePrefix, volatileSuffix }
}
