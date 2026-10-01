import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import { isBotMode } from '../../fleet/instance/config'
import { gitEnvInfo } from '../../git-service'
import { getConversation } from '../../store'
import type { AcpContentBlock } from '../acp/protocol'
import type { ChatAgent } from '../agents'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
import { resolveAntigravityHarness } from '../harness/adapters/antigravity'
import { harnessUltraGuidance } from '../harness/host-contracts'
import { buildHarnessPrompt } from '../harness/prompt-builder'
import type { ResolvedHarness } from '../harness/types'
import { maestroAgentsFromTurn, renderMaestroAgentCatalog } from '../maestro-delegation'
import { MAESTRO_SYSTEM_SPEC, renderMaestroTurnPolicy } from '../maestro-prompt'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { droppedImageText, nativeSeedContextText, renderNativeSeedTranscript } from '../message'
import { pdfFallbackText } from '../pdf-attachments'
import { buildProjectContext } from '../project-context'
import { effectiveSkills } from '../skill-state'
import { type ChatSkill, skillCatalogLine } from '../skills'
import { listEffectiveAgents } from '../virtual-subagents'

export const ANTIGRAVITY_INSTRUCTIONS_VERSION = 1

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
}

export interface AntigravityInstructions {
  instructions: string
  instructionHash: string
  skills: readonly ChatSkill[]
  agents: readonly ChatAgent[]
}

function skillsCatalog(skills: readonly ChatSkill[], project = true): string {
  if (!skills.length) return ''
  return `${project ? 'Project skills' : 'Skills'} available through \`use_skill\`:\n${skills.map(skillCatalogLine).join('\n')}`
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
  const skills =
    args.mode === 'ask'
      ? []
      : (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
  const allAgents = await listEffectiveAgents({
    cwd: args.cwd,
    conversationId: args.conversationId,
    mode: args.mode === 'agent' || args.mode === 'maestro' ? 'agent' : 'plan',
  })
  const agents =
    args.mode === 'maestro' && args.maestro
      ? maestroAgentsFromTurn(args.maestro, allAgents)
      : args.mode === 'agent'
        ? allAgents
        : args.maestrlyUltra
          ? allAgents.filter((agent) => agent.name === 'explore')
          : []
  const agentContext =
    args.mode === 'maestro' && args.maestro ? renderMaestroAgentCatalog(args.maestro) : agentsCatalog(agents)
  const projectContext = await buildProjectContext(args.projectId, args.cwd, args.conversationId)
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
  const git = await gitEnvInfo(args.cwd).catch(() => null)
  const gitLine = git ? ` Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : ''
  const environment = `OS: ${platform}. Today's date: ${new Date().toISOString().slice(0, 10)}. Project directory: ${args.cwd}.${gitLine}`
  const harness = args.harness ?? resolveAntigravityHarness(args.modelId)
  const ultra = args.maestrlyUltra
    ? args.mode === 'maestro'
      ? 'Maximum-rigor reasoning applies only to the orchestrator; choose agents deliberately from the frozen Strategy and Pool.'
      : args.mode === 'agent'
        ? 'Maximum-rigor Maestrly Ultra mode is active. Decompose non-trivial work, delegate independent slices through task when useful, integrate the results, verify the implementation, and critically review it before finishing.'
        : 'Maximum-rigor Maestrly Ultra mode is active. Stay read-only, investigate deeply, and cross-check the conclusion.'
    : ''
  const notes = !isBotMode() && Boolean(getConversation(args.conversationId))
  const allowPlanReview = !isBotMode()
  const instructions = [
    buildHarnessPrompt({
      harness,
      cwd: args.cwd,
      mode: args.mode,
      appToolsEnabled: args.appToolsEnabled ?? false,
      hasNotesTab: notes,
      projectContext,
      skillsContext: skillsCatalog(skills, args.projectId !== null),
      agentsContext: agentContext,
      envContext: environment,
    }).instructions,
    'You are running inside Maestrly through the official Google Antigravity ACP server.',
    `Maestrly mode: ${args.mode}.`,
    `The user's project is ${args.cwd}; your own working directory is a private scratch folder, so always use absolute project paths with Maestrly's tools.`,
    'Use ONLY the tools listed in <maestrly_tools>; built-in Antigravity tools are disabled.',
    ...(allowPlanReview
      ? ['The `review_plan` tool presents a plan for user approval; when the user approves, a new turn executes it.']
      : []),
    'The `ask_question` tool asks the user a question and waits for the answer.',
    ...(args.mode === 'maestro' ? [MAESTRO_SYSTEM_SPEC] : []),
    ...(args.mode === 'maestro' && args.maestro ? [renderMaestroTurnPolicy(args.maestro)] : []),
    MEMORY_TOOL_GUIDANCE,
    ...(ultra ? [harnessUltraGuidance(harness, args.mode) ?? ultra] : []),
    ...(notes ? ['The conversation has a Notes tab; use it when the user asks about notes.'] : []),
    "You are an assistant on the user's machine. The Maestrly tool layer enforces permissions; never claim you executed something you did not.",
  ].join('\n')
  return { instructions, instructionHash: hashAntigravityInstructions(instructions), skills, agents }
}

export function buildAntigravitySeedTranscript(history: readonly ChatMessage[]): string {
  return renderNativeSeedTranscript(history.slice(0, -1))
}

function dataUrlImage(data: string | undefined): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data ?? '')
  return match ? { mimeType: match[1], data: match[2] } : null
}

/**
 * Prompt blocks for one turn. A new session carries Maestrly's instructions, the tool catalog, and (when the
 * conversation already has history) a transcript seed before the user's message; resumed sessions get only the
 * message. Attached images are native `image` blocks unless the model cannot see images.
 */
export function buildAntigravityPromptBlocks(args: {
  conversationId: string
  message: ChatMessage
  newSession: boolean
  instructions: string
  toolCatalog: string
  seedTranscript: string
  dropImages: boolean
}): AcpContentBlock[] {
  const textParts: string[] = []
  const images: AcpContentBlock[] = []
  if (args.newSession) {
    textParts.push(`<maestrly_instructions>\n${args.instructions}\n</maestrly_instructions>`)
    if (args.toolCatalog) textParts.push(args.toolCatalog)
  }
  if (args.seedTranscript) textParts.push(nativeSeedContextText(args.seedTranscript))
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
