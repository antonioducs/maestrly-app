import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import type { AppToolGroup } from '../../../shared/app-tool-groups'
import { isBotMode } from '../../fleet/instance/config'
import { gitEnvInfo } from '../../git-service'
import { getConversation } from '../../store'
import type { AcpContentBlock } from '../acp/protocol'
import type { ChatAgent } from '../agents'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
import { resolveAntigravityHarness } from '../harness/adapters/antigravity'
import { harnessUltraGuidance } from '../harness/host-contracts'
import { buildHarnessPrompt } from '../harness/prompt-builder'
import { generatedInterfacesEnabled } from '../generated-interfaces'
import type { ResolvedHarness } from '../harness/types'
import { renderMaestroSwarmSection } from '../maestro-prompt'
import { applyToolPruning, planToolPruning, protectedRecentMessageIds } from '../compaction/tool-pruning'
import { activeChatContext, droppedImageText, nativeSeedContextText, renderNativeSeedTranscript } from '../message'
import { pdfFallbackText } from '../pdf-attachments'
import { estimatePortableContextTokens, estimateTextTokens } from '../portable-context'
import { buildProjectContext } from '../project-context'
import { commandShellEnvironment } from '../tools/command-shell'
import { mainAgentSkills } from '../skill-state'
import { type ChatSkill, renderSkillCatalogEntries } from '../skills'
import { listEffectiveAgents } from '../virtual-subagents'

export const ANTIGRAVITY_INSTRUCTIONS_VERSION = 2

export interface BuildAntigravityInstructionsArgs {
  /** Null for standalone chats: there is no workspace, project context, or project skill catalog. */
  projectId: string | null
  cwd: string
  conversationId: string
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  modelId: string
  maestrlyUltra?: boolean
  harness?: ResolvedHarness
  appToolsEnabled?: boolean
  disabledAppToolGroups?: readonly AppToolGroup[]
}

export interface AntigravityInstructions {
  instructions: string
  instructionHash: string
  /** Date and git state for the current turn; outside the hash, so a new day never forces a new session. */
  environment: string
  /** Short restatement for resumed sessions, so the mode and tool rules stay next to the latest message. */
  turnReminder: string
  skills: readonly ChatSkill[]
  agents: readonly ChatAgent[]
}

function skillsCatalog(skills: readonly ChatSkill[], project = true): string {
  if (!skills.length) return ''
  return `${project ? 'Project skills' : 'Skills'} available through \`use_skill\`:\n${renderSkillCatalogEntries(skills)}`
}

function agentsCatalog(agents: readonly ChatAgent[]): string {
  if (!agents.length) return ''
  return (
    'Maestrly can delegate isolated work through the host-managed `task` tool. Give each subagent a ' +
    'self-contained prompt; independent tasks may run in parallel. Available Maestrly agents:\n' +
    agents.map((agent) => `- ${agent.name}: ${agent.description ?? '(no description)'}`).join('\n')
  )
}

export function hashAntigravityInstructions(instructions: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: ANTIGRAVITY_INSTRUCTIONS_VERSION, instructions }))
    .digest('hex')
}

/**
 * Maestrly's harness instructions for an Antigravity session. The ACP server has no system prompt field and
 * ignores project rule files, so these travel inside the first user prompt of each session.
 */
export async function buildAntigravityInstructions(
  args: BuildAntigravityInstructionsArgs
): Promise<AntigravityInstructions> {
  const capabilityMode = capabilityBehaviorFor(args.mode)
  const skills = await mainAgentSkills(args.mode, args.cwd, args.conversationId)
  const allAgents = await listEffectiveAgents({
    cwd: args.cwd,
    conversationId: args.conversationId,
    mode: capabilityMode === 'agent' ? 'agent' : 'plan',
  })
  const agents =
    capabilityMode === 'agent'
      ? allAgents
      : args.maestrlyUltra
        ? allAgents.filter((agent) => agent.name === 'explore')
        : []
  const agentContext = agentsCatalog(agents)
  const projectContext = await buildProjectContext(args.projectId, args.cwd, args.conversationId)
  const skillsContext = skillsCatalog(skills, args.projectId !== null)
  const scope = args.projectId === null ? 'standalone' : 'project'
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
  const git = await gitEnvInfo(args.cwd).catch(() => null)
  const gitLine = git ? ` Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : ''
  // The date and git state change between turns without changing the contract, so they travel with each message.
  const environment = `Today's date: ${new Date().toISOString().slice(0, 10)}. Project directory: ${args.cwd}.${gitLine}`
  const harness = args.harness ?? resolveAntigravityHarness(args.modelId)
  const ultra = args.maestrlyUltra
    ? capabilityMode === 'agent'
      ? 'Maximum-rigor Maestrly Ultra mode is active. Decompose non-trivial work, delegate independent slices through task when useful, integrate the results, verify the implementation, and critically review it before finishing.'
      : 'Maximum-rigor Maestrly Ultra mode is active. Stay read-only, investigate deeply, and cross-check the conclusion.'
    : ''
  const notes = !isBotMode() && Boolean(getConversation(args.conversationId))
  const allowPlanReview = !isBotMode()
  const prompt = buildHarnessPrompt({
    harness,
    cwd: args.cwd,
    conversationId: args.conversationId,
    scope,
    mode: args.mode,
    appToolsEnabled: args.appToolsEnabled ?? false,
    ...(args.disabledAppToolGroups ? { disabledAppToolGroups: args.disabledAppToolGroups } : {}),
    hasNotesTab: notes,
    projectContext,
    skillsContext,
    agentsContext: agentContext,
    generatedInterfaces: generatedInterfacesEnabled(),
  })
  // The base layout leaves project, skill and agent context to the runtime (as for the BYOK runner), and the
  // standalone layout composes skills and agents but not the memory core; the profile layouts compose all three.
  // Each block gets its own heading so a skill list never reads as part of the project's AGENTS.md.
  const section = (title: string, body: string): string => (body.trim() ? `# ${title}\n${body.trim()}` : '')
  const runtimeContext =
    scope === 'standalone'
      ? [projectContext.trim()]
      : prompt.layout === 'maestrly-base'
        ? [projectContext.trim(), section('Skills', skillsContext), section('Subagents', agentContext)]
        : []
  const runtime = [
    'You are running inside Maestrly through the official Google Antigravity ACP server. Antigravity adds its own agent instructions; where they conflict with these Maestrly instructions about tools, plans, task or walkthrough files, file locations or progress reports, follow these.',
    `Maestrly mode: ${args.mode}.`,
    `The user's project is ${args.cwd}; your own working directory is a private scratch folder, so always use absolute project paths with Maestrly's tools.`,
    'Use only the tools listed in <maestrly_tools>; built-in Antigravity tools are disabled.',
    `OS: ${platform}. ${commandShellEnvironment()}`,
    ...(allowPlanReview
      ? ['The `review_plan` tool presents a plan for user approval; when the user approves, a new turn executes it.']
      : []),
    'The `ask_question` tool asks the user a question and waits for the answer.',
    // The Maestrly base layout already carries the capability contract.
    ...(args.mode === 'maestro' && args.maestro ? [renderMaestroSwarmSection(args.maestro)] : []),
    ...(ultra ? [harnessUltraGuidance(harness, args.mode) ?? ultra] : []),
    ...(notes ? ['The conversation has a Notes tab; use it when the user asks about notes.'] : []),
    "You are an assistant on the user's machine. The Maestrly tool layer enforces permissions; never claim you executed something you did not.",
  ].join('\n')
  const instructions = [prompt.stablePrefix, ...runtimeContext, `# Maestrly on Antigravity\n${runtime}`]
    .filter(Boolean)
    .join('\n\n')
  const turnReminder = `Maestrly mode: ${args.mode}. Keep following the Maestrly instructions of this session: use only the tools in <maestrly_tools>, with absolute paths under ${args.cwd}.`
  return {
    instructions,
    instructionHash: hashAntigravityInstructions(instructions),
    environment,
    turnReminder,
    skills,
    agents,
  }
}

/** Antigravity's own system prompt and native tool declarations, ~15.6 KB on runtime 1.4.0. */
const ANTIGRAVITY_RUNTIME_PROMPT_TOKENS = 5_500

/**
 * Occupancy of an Antigravity session as Maestrly estimates it. The server's `usage_update` is the difference between
 * two cumulative totals read at racy moments (runtime 1.4.0), so one report can fold two model calls together — about
 * twice the real window — and it cannot serve as a measurement.
 */
export function estimateAntigravityContextTokens(args: {
  instructions: string
  toolCatalog: string
  history: readonly ChatMessage[]
  assistant: ChatMessage
}): number {
  return (
    ANTIGRAVITY_RUNTIME_PROMPT_TOKENS +
    estimateTextTokens(args.instructions) +
    estimateTextTokens(args.toolCatalog) +
    estimatePortableContextTokens([...args.history, args.assistant])
  )
}

/** `liveAssistant` carries a compaction made during this turn, so the seed starts from its summary. */
export function buildAntigravitySeedTranscript(history: readonly ChatMessage[], liveAssistant?: ChatMessage): string {
  const prior = history.slice(0, -1)
  return renderNativeSeedTranscript(liveAssistant ? [...prior, liveAssistant] : prior)
}

/**
 * `history` (ending with the current user message) as the seed sees it once older tool outputs are one-line stubs,
 * by the same rule as the pre-send pruning step. Only the seed changes: the stored history keeps every output, so
 * another model still receives them, and a session recreated later applies the rule again.
 */
export function pruneAntigravitySeedHistory(history: readonly ChatMessage[]): {
  history: ChatMessage[]
  stubs: number
} {
  const active = activeChatContext(history.slice(0, -1)).messages
  const targets = planToolPruning(active, { protectedIds: protectedRecentMessageIds(active), mode: 'stub' })
  return { history: applyToolPruning(history, targets), stubs: targets.length }
}

/** Follows a seed that lost tool outputs or older turns, so the model looks up what it cannot see. */
export const ANTIGRAVITY_CONDENSED_SEED_NOTE =
  'Parts of this prior dialogue are condensed (tool outputs replaced by one-line stubs, older turns summarized). The complete history is still available: before relying on or contradicting an earlier decision that is not shown in full here, read it with history_search and history_read.'

function dataUrlImage(data: string | undefined): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data ?? '')
  return match ? { mimeType: match[1], data: match[2] } : null
}

export const ANTIGRAVITY_MESSAGE_ANCHOR =
  "Based on the instructions and context above, reply to the user's message below."

/**
 * Prompt blocks for one turn. A new session carries Maestrly's instructions, the tool catalog, (when the
 * conversation already has history) a transcript seed, and the current environment, then a short bridge to the
 * user's message; resumed sessions get the reminder and the environment before the message. Gemini follows long
 * prompts best with the context first and the request last. Attached images are native `image` blocks unless the
 * model cannot see images.
 */
export function buildAntigravityPromptBlocks(args: {
  conversationId: string
  message: ChatMessage
  newSession: boolean
  instructions: string
  toolCatalog: string
  seedTranscript: string
  /** The seed lost tool outputs or older turns; adds the note pointing to the history tools. */
  seedCondensed?: boolean
  dropImages: boolean
  environment?: string
  turnReminder?: string
}): AcpContentBlock[] {
  const textParts: string[] = []
  const images: AcpContentBlock[] = []
  if (args.newSession) {
    textParts.push(`<maestrly_instructions>\n${args.instructions}\n</maestrly_instructions>`)
    if (args.toolCatalog) textParts.push(args.toolCatalog)
  }
  if (args.seedTranscript) {
    textParts.push(nativeSeedContextText(args.seedTranscript))
    if (args.seedCondensed) textParts.push(ANTIGRAVITY_CONDENSED_SEED_NOTE)
  }
  const turnContext = [args.newSession ? '' : args.turnReminder, args.environment]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
  if (turnContext.length) {
    textParts.push(`<maestrly_turn_context>\n${turnContext.join('\n')}\n</maestrly_turn_context>`)
  }
  if (args.newSession) textParts.push(ANTIGRAVITY_MESSAGE_ANCHOR)
  for (const part of args.message.parts) {
    if (part.type === 'text' && part.text) textParts.push(part.text)
    if (part.type === 'context' && part.text) textParts.push(part.text)
    if (part.type === 'skill-invocation' && part.body) textParts.push(part.body)
    if (part.type !== 'file') continue
    if (part.kind === 'image') {
      if (args.dropImages) {
        textParts.push(droppedImageText(part))
        continue
      }
      const resolved = resolveFileImageBytesSync(args.conversationId, part)
      const image = resolved
        ? { data: Buffer.from(resolved.bytes).toString('base64'), mimeType: resolved.mediaType }
        : dataUrlImage(part.data)
      if (image) images.push({ type: 'image', mimeType: image.mimeType, data: image.data })
      else textParts.push(`[Image attachment ${part.name} could not be decoded by the host.]`)
      continue
    }
    if (part.kind === 'pdf') {
      textParts.push(pdfFallbackText(part))
      continue
    }
    const label = part.hidden ? `Content referenced by ${part.name}` : `Attached file ${part.name}`
    textParts.push(`${label}:\n\n${part.data}`)
  }
  const text = textParts.join('\n\n').trim() || '(continue)'
  return [{ type: 'text', text }, ...images]
}
