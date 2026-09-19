import { resolveCursorHarness } from '../harness/adapters/cursor'
import { buildHarnessPrompt } from '../harness/prompt-builder'
import { harnessUltraGuidance } from '../harness/host-contracts'
import { createHarnessSnapshot } from '../harness/compatibility'
import type { ResolvedHarness } from '../harness/types'
import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import { getConversation } from '../../store'
import { gitEnvInfo } from '../../git-service'
import { nativeSeedContextText, renderNativeSeedTranscript } from '../message'
import type { ChatSkill } from '../skills'
import { skillCatalogLine } from '../skills'
import type { ChatAgent } from '../agents'
import { effectiveSkills } from '../skill-state'
import { buildProjectContext } from '../project-context'
import { listEffectiveAgents } from '../virtual-subagents'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { maestroAgentsFromTurn, renderMaestroAgentCatalog } from '../maestro-delegation'
import { MAESTRO_SYSTEM_SPEC, renderMaestroTurnPolicy } from '../maestro-prompt'
import type { CursorAgentBinding } from './session-store'

export interface CursorBindingCompatibilityInput {
  binding: CursorAgentBinding | null
  previousMessageId: string | null
  modelId: string
  modelParams: ReadonlyArray<{ id: string; value: string }>
  cwd: string
  harnessProfile: string
  instructionHash: string
  toolSignature: string
  accountFingerprint: string
  accountId: string | null
}

export function isCursorAgentBindingCompatible(input: CursorBindingCompatibilityInput): boolean {
  const { binding } = input
  if (!binding) return false
  if (!input.previousMessageId) return false
  return (
    binding.lastMessageId === input.previousMessageId &&
    binding.modelId === input.modelId &&
    binding.cwd === input.cwd &&
    binding.harnessProfile === input.harnessProfile &&
    binding.instructionHash === input.instructionHash &&
    binding.toolSignature === input.toolSignature &&
    binding.accountFingerprint === input.accountFingerprint &&
    binding.accountId === input.accountId &&
    binding.modelParams.length === input.modelParams.length &&
    binding.modelParams.every(
      (param, index) => input.modelParams[index]?.id === param.id && input.modelParams[index]?.value === param.value
    )
  )
}

export interface CursorHarnessEnvelope {
  mode: ChatBehavior
  modelId: string
  cwd: string
  projectContext: string
  skillCatalog: string
  agentCatalog: string
  environment: string
  ultra: boolean
  instructions: string
  harnessSnapshot?: import('../../../shared/harness').HarnessSnapshotV1
}

function skillsCatalog(skills: readonly ChatSkill[]): string {
  if (!skills.length) return ''
  return 'Project skills available through `use_skill`:\n' + skills.map(skillCatalogLine).join('\n')
}

function agentsCatalog(agents: readonly ChatAgent[]): string {
  if (!agents.length) return ''
  return (
    'Maestrly can delegate isolated work through the host-managed `task` tool. Give each subagent a ' +
    'self-contained prompt; independent tasks may run in parallel. Available Maestrly agents:\n' +
    agents.map((agent) => `- ${agent.name}: ${agent.description ?? '(no description)'}`).join('\n')
  )
}

export interface BuildCursorHarnessContextArgs {
  projectId: string
  cwd: string
  conversationId: string
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  modelId: string
  maestrlyUltra?: boolean
  harness?: ResolvedHarness
  appToolsEnabled?: boolean
}

export async function buildCursorHarnessContext(
  args: BuildCursorHarnessContextArgs
): Promise<{ envelope: CursorHarnessEnvelope; skills: readonly ChatSkill[]; agents: readonly ChatAgent[] }> {
  const skills =
    args.mode === 'ask'
      ? []
      : (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
  const skillContext = skillsCatalog(skills)
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
  const projectContext = await buildProjectContext(args.projectId, args.cwd)
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
  const git = await gitEnvInfo(args.cwd).catch(() => null)
  const gitLine = git ? ` Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : ''
  const environment = `OS: ${platform}. Today's date: ${new Date().toISOString().slice(0, 10)}. Project directory: ${args.cwd}.${gitLine}`
  const harness = args.harness ?? resolveCursorHarness(args.modelId)
  const ultra = args.maestrlyUltra
    ? args.mode === 'maestro'
      ? 'Maximum-rigor reasoning applies only to the orchestrator; choose agents deliberately from the frozen Strategy and Pool.'
      : args.mode === 'agent'
        ? 'Maximum-rigor Maestrly Ultra mode is active. Decompose non-trivial work, delegate independent slices through task when useful, integrate the results, verify the implementation, and critically review it before finishing.'
        : 'Maximum-rigor Maestrly Ultra mode is active. Stay read-only, investigate deeply, and cross-check the conclusion.'
    : ''
  const conversation = getConversation(args.conversationId)
  const notes = Boolean(conversation)
  const allowPlanReview = true
  const instructions = [
    buildHarnessPrompt({
      harness,
      cwd: args.cwd,
      mode: args.mode,
      appToolsEnabled: args.appToolsEnabled ?? false,
      hasNotesTab: notes,
      projectContext,
      skillsContext: skillContext,
      agentsContext: agentContext,
      envContext: environment,
    }).instructions,
    'You are running inside Maestrly through the official Cursor Agent SDK runtime.',
    `Maestrly mode: ${args.mode}.`,
    'Use ONLY the custom tools offered to you; do not attempt tools you were not given.',
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
  return {
    envelope: {
      mode: args.mode,
      modelId: args.modelId,
      cwd: args.cwd,
      projectContext,
      skillCatalog: skillContext,
      agentCatalog: agentContext,
      environment,
      ultra: Boolean(args.maestrlyUltra),
      instructions,
      harnessSnapshot: createHarnessSnapshot(harness),
    },
    skills,
    agents,
  }
}

export const CURSOR_HARNESS_ENVELOPE_VERSION = 1

export function hashCursorHarnessEnvelope(envelope: CursorHarnessEnvelope): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: CURSOR_HARNESS_ENVELOPE_VERSION,
        ...envelope,
      })
    )
    .digest('hex')
}

export function buildCursorSeedTranscript(history: readonly ChatMessage[]): string {
  return renderNativeSeedTranscript(history.slice(0, -1))
}

export function cursorSeedContextText(seedTranscript: string): string {
  return seedTranscript ? nativeSeedContextText(seedTranscript) : ''
}

export function cursorUserInputText(message: ChatMessage, seedTranscript: string): string {
  const parts: string[] = []
  if (seedTranscript) parts.push(cursorSeedContextText(seedTranscript))
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) parts.push(part.text)
    if (part.type === 'context' && part.text) parts.push(part.text)
    if (part.type === 'skill-invocation' && part.body) parts.push(part.body)
  }
  return parts.join('\n\n').trim() || '(continue)'
}
