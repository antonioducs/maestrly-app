import type { CopilotSession, SessionEvent, Tool as CopilotTool } from '@github/copilot-sdk'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import { getAppFlag } from '../../store'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { selectSubagentToolNames } from '../tools'
import { recordModelCallUsage } from '../usage-diagnostics'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { hardDeleteGitHubCopilotSession } from './lifecycle'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotSubscriptionManager,
} from './manager'
import { queueGitHubCopilotSessionCleanup } from './session-store'
import { COPILOT_TOOL_SEARCH_DEFER_THRESHOLD } from './tools'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile } from '../fable/profile'
import { compileFableSubagentPrompt } from '../fable/prompt'
import { chatDiag } from '../diag-log'

const SESSION_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const FORBIDDEN_CHILD_TOOLS = new Set(['task', 'delegate', 'review_plan', 'ask_question', 'todo_write'])
type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface RunGitHubCopilotSubagentArgs {
  manager: GitHubCopilotSubscriptionManager
  accountIdentity: GitHubCopilotAccountIdentity
  conversationId: string
  cwd: string
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  signal: AbortSignal
  agentName: string
  task: string
  readOnly: boolean
  tools: CopilotTool[]
  allowSkillLoader?: boolean
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
}

export interface GitHubCopilotSubagentResult {
  text: string
  error?: string
  usage?: NormalizedAiUsage
  model?: ChatModelRef
}

const safeTokens = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function childToolNames(
  definition: ChatAgent,
  readOnly: boolean,
  providedHostToolNames: ReadonlySet<string>,
  allowSkillLoader?: boolean
): Set<string> {
  return selectSubagentToolNames({
    definition,
    readOnly,
    providedHostTools: providedHostToolNames,
    allowSkillLoader,
  })
}

function usageValue(usage: NormalizedAiUsage): NormalizedAiUsage | undefined {
  return usage.totalInput || usage.output ? usage : undefined
}

/** Runs one isolated, ephemeral Copilot SDK session over the already-authenticated manager. */
export async function runGitHubCopilotSubagent(
  args: RunGitHubCopilotSubagentArgs
): Promise<GitHubCopilotSubagentResult> {
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  const model: ChatModelRef = { providerId: effective.providerId, modelId: effective.modelId }
  const usage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  const allowed = childToolNames(
    args.definition,
    args.readOnly,
    new Set(args.tools.map((entry) => entry.name)),
    args.allowSkillLoader
  )
  const tools = args.tools.filter((entry) => allowed.has(entry.name) && !FORBIDDEN_CHILD_TOOLS.has(entry.name))
  const textOrder: string[] = []
  const textByMessage = new Map<string, string>()
  const emitText = createSubagentTextEmitter(args.onTextUpdate)
  let session: CopilotSession | null = null
  let sessionId = ''
  let fatalError: string | null = null
  let abortRequested = args.signal.aborted

  const finalText = (): string => {
    for (let index = textOrder.length - 1; index >= 0; index -= 1) {
      const content = textByMessage.get(textOrder[index])?.trim()
      if (content) return content
    }
    return ''
  }
  const recordText = (messageId: string, content: string, replace: boolean): void => {
    if (!textByMessage.has(messageId)) textOrder.push(messageId)
    textByMessage.set(messageId, replace ? content : (textByMessage.get(messageId) ?? '') + content)
    emitText(finalText())
  }
  const onEvent = (event: SessionEvent): void => {
    if (event.agentId) return
    switch (event.type) {
      case 'assistant.message_delta':
        if (event.data.deltaContent) recordText(event.data.messageId, event.data.deltaContent, false)
        return
      case 'assistant.message':
        if (event.data.content) recordText(event.data.messageId, event.data.content, true)
        return
      case 'assistant.usage': {
        const totalInput = safeTokens(event.data.inputTokens)
        const cacheRead = Math.min(totalInput, safeTokens(event.data.cacheReadTokens))
        const cacheCreate = Math.min(totalInput - cacheRead, safeTokens(event.data.cacheWriteTokens))
        const measured = {
          input: totalInput - cacheRead - cacheCreate,
          output: safeTokens(event.data.outputTokens),
          cacheRead,
          cacheCreate,
          totalInput,
        }
        usage.input += measured.input
        usage.output += measured.output
        usage.cacheRead += cacheRead
        usage.cacheCreate += cacheCreate
        usage.totalInput += totalInput
        recordModelCallUsage({
          runtime: 'github-copilot-subscription',
          providerId: model.providerId,
          modelId: model.modelId,
          conversationId: args.conversationId,
          agent: args.agentName,
          usage: measured,
        })
        return
      }
      case 'tool.execution_start':
        args.progress?.(`${event.data.toolName} started`)
        return
      case 'tool.execution_partial_result':
        if (event.data.partialOutput.trim()) args.progress?.(event.data.partialOutput.trim())
        return
      case 'tool.execution_progress':
        if (event.data.progressMessage.trim()) args.progress?.(event.data.progressMessage.trim())
        return
      case 'tool.execution_complete':
        args.progress?.(`${event.data.success ? 'completed' : 'failed'} ${event.data.toolCallId}`)
        return
      case 'session.error':
        fatalError = event.data.message
        return
    }
  }
  const legacySystemMessage = [
    args.definition.prompt,
    `You are the delegated Maestrly subagent "${args.agentName}". Work only on the supplied task.`,
    MEMORY_TOOL_GUIDANCE,
    args.readOnly
      ? 'This delegated run is strictly read-only. Do not modify files, execute mutating commands, or spawn subagents.'
      : 'You are a worker. Do not spawn subagents. Return a concise result to the parent when the task is complete.',
  ].join('\n\n')
  const behaviorProfile = resolveFableBehaviorProfile({
    requestedModelId: effective.modelId,
    enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
  }).profile
  const systemMessage = compileFableSubagentPrompt(legacySystemMessage, behaviorProfile)
  chatDiag({
    kind: 'fable-behavior-profile',
    profile: behaviorProfile?.id ?? 'legacy',
    requestedModel: effective.modelId,
    resolvedModel: effective.modelId,
    transport: 'github-copilot',
    effort: effective.sentEffort ?? 'default',
    progressMode: 'prompt-only',
    agent: args.agentName,
    conv: args.conversationId,
  })
  const config: GitHubCopilotCreateSessionConfig = {
    model: effective.modelId,
    ...(effective.sentEffort ? { reasoningEffort: effective.sentEffort as CopilotReasoningEffort } : {}),
    workingDirectory: args.cwd,
    tools,
    availableTools: tools.map((entry) => `custom:${entry.name}`),
    toolSearch: { enabled: true, deferThreshold: COPILOT_TOOL_SEARCH_DEFER_THRESHOLD },
    customAgents: [],
    systemMessage: { mode: 'replace', content: systemMessage },
    streaming: true,
    includeSubAgentStreamingEvents: false,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    enableSessionTelemetry: false,
    enableCitations: false,
    enableSkills: false,
    enableSessionStore: false,
    enableHostGitOperations: false,
    memory: { enabled: false },
    onPermissionRequest: () => ({
      kind: 'reject' as const,
      feedback: 'This delegated Maestrly session allows only host-managed custom tools.',
    }),
    onEvent,
  }
  const onAbort = (): void => {
    abortRequested = true
    void session?.abort().catch(() => undefined)
  }
  args.signal.addEventListener('abort', onAbort, { once: true })

  try {
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (!args.accountIdentity.fingerprint) throw new Error('GitHub Copilot is not authenticated')
    session = await args.manager.createSession(config)
    sessionId = session.sessionId
    args.progress?.(`Starting subagent ${args.agentName}`)
    if (abortRequested) onAbort()
    const final = await session.sendAndWait({ prompt: args.task, agentMode: 'interactive' }, SESSION_WAIT_TIMEOUT_MS)
    if (final?.data.content) recordText(final.data.messageId, final.data.content, true)
    args.manager.assertAccountIdentity(args.accountIdentity)
    const measured = usageValue(usage)
    if (abortRequested) {
      throw Object.assign(new Error('Subagent aborted'), { subagentUsage: measured, subagentModel: model })
    }
    if (fatalError) return { text: finalText(), error: fatalError, ...(measured ? { usage: measured } : {}), model }
    return {
      text: finalText() || '(the subagent returned no text)',
      ...(measured ? { usage: measured } : {}),
      model,
    }
  } catch (error) {
    const measured = usageValue(usage)
    if (abortRequested) {
      throw Object.assign(new Error(errorMessage(error)), { subagentUsage: measured, subagentModel: model })
    }
    return { text: finalText(), error: errorMessage(error), ...(measured ? { usage: measured } : {}), model }
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    await session?.abort().catch(() => undefined)
    if (sessionId) {
      queueGitHubCopilotSessionCleanup(args.conversationId, sessionId, args.manager.accountId)
      await args.manager.disconnectSession(sessionId).catch(() => undefined)
      await hardDeleteGitHubCopilotSession(args.manager, sessionId).catch(() => undefined)
    }
  }
}
