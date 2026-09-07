import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ToolSet } from 'ai'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import { getAppFlag } from '../../store'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { selectSubagentToolNames } from '../tools'
import { recordModelCallUsage } from '../usage-diagnostics'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { claudeRuntimeErrorMessage } from './errors'
import type { ClaudeSubscriptionAccountIdentity, ClaudeSubscriptionManager } from './manager'
import { buildClaudeToolBridge, CLAUDE_DISALLOWED_NATIVE_TOOLS, type ClaudeToolBridge } from './tools'
import { buildClaudeFastModeSettings } from './options'
import { gatedClaudeHumanText } from './user-prompt'
import { normalizeClaudeUsage } from './usage'
import { claudeServedModelMismatch } from './served-model'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile, type FableBehaviorProfile } from '../fable/profile'
import { compileFableSubagentPrompt } from '../fable/prompt'
import { createFablePostToolUseHook } from '../fable/sdk-hooks'
import { chatDiag } from '../diag-log'

const FORBIDDEN_CHILD_TOOLS = new Set([
  'task',
  'delegate',
  'review_plan',
  'ask_question',
  'todo_write',
  'wait_delegation',
  'list_delegations',
  'inspect_subagent',
  'cancel_delegation',
])

export interface RunClaudeSubagentArgs {
  manager: ClaudeSubscriptionManager
  accountIdentity: ClaudeSubscriptionAccountIdentity
  conversationId: string
  cwd: string
  profile: SubagentExecutionSnapshotV1
  /** Canonical child identity supplied by the Claude runtime when the configured model is an alias. */
  resolvedModelId?: string
  behaviorProfile?: FableBehaviorProfile | null
  definition: ChatAgent
  signal: AbortSignal
  agentName: string
  task: string
  readOnly: boolean
  tools: ToolSet
  allowSkillLoader?: boolean
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
  /**
   * Maestro delegations persist the SDK session so a later turn can resume it. The caller owns the deletion
   * (end of the parent turn) and must tombstone the id via `onSessionStarted`.
   */
  persistRuntime?: boolean
  /** Resume this SDK session. A rejected/replaced resume falls back to a fresh session + fallbackTask. */
  resume?: { sessionId: string; fallbackTask: string }
  onSessionStarted?: (info: { sessionId: string; resumed: boolean }) => void
}

function childToolNames(
  definition: ChatAgent,
  readOnly: boolean,
  providedHostTools: ToolSet,
  allowSkillLoader?: boolean
): Set<string> {
  return selectSubagentToolNames({ definition, readOnly, providedHostTools, allowSkillLoader })
}

function resultUsage(result: SDKResultMessage): NormalizedAiUsage {
  return normalizeClaudeUsage(result.usage)
}

function resultRuntimeEstimatedCost(result: SDKResultMessage | null): number | undefined {
  const cost = Number(result?.total_cost_usd)
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

function textFromAssistant(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
}

/** Runs one isolated Claude Agent SDK session owned by the Maestrly task scheduler. */
export async function runClaudeSubagent(args: RunClaudeSubagentArgs): Promise<{
  text: string
  error?: string
  usage?: NormalizedAiUsage
  model?: ChatModelRef
  runtimeEstimatedCostUsd?: number
  /** Only when `resume` was requested. */
  resumed?: boolean
  resumeReason?: string
}> {
  args.signal.throwIfAborted()
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  const model: ChatModelRef = { providerId: effective.providerId, modelId: effective.modelId }
  const allowedNames = childToolNames(args.definition, args.readOnly, args.tools, args.allowSkillLoader)
  const tools: ToolSet = Object.fromEntries(
    Object.entries(args.tools).filter(([name]) => allowedNames.has(name) && !FORBIDDEN_CHILD_TOOLS.has(name))
  )
  const abortController = new AbortController()
  const runtimeSignal = AbortSignal.any([args.signal, abortController.signal])
  let query: ReturnType<ClaudeSubscriptionManager['createQuery']> | null = null
  let abortRequested = args.signal.aborted
  let resumed = false
  let resumeReason: string | undefined
  const withResume = <T extends object>(value: T): T & { resumed?: boolean; resumeReason?: string } =>
    args.resume ? { ...value, resumed, ...(resumeReason ? { resumeReason } : {}) } : value
  const onAbort = (): void => {
    abortRequested = true
    abortController.abort(args.signal.reason ?? new Error('Claude subagent aborted.'))
    if (query) {
      setTimeout(() => query?.close(), 1_000).unref?.()
      void query.interrupt().catch(() => undefined)
    }
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  if (args.signal.aborted) onAbort()
  let bridge: ClaudeToolBridge
  try {
    bridge = await buildClaudeToolBridge(tools, runtimeSignal, new Set(Object.keys(tools)), () =>
      args.manager.assertAccountIdentity(args.accountIdentity)
    )
  } catch (error) {
    args.signal.removeEventListener('abort', onAbort)
    throw error
  }
  const legacySystemPrompt = [
    args.definition.prompt,
    `You are the delegated Maestrly subagent "${args.agentName}". Work only on the supplied task.`,
    MEMORY_TOOL_GUIDANCE,
    args.readOnly
      ? 'This delegated run is strictly read-only. Do not modify files, execute mutating commands, or spawn subagents.'
      : 'You are a worker. Do not spawn subagents. Return a concise result to the parent when the task is complete.',
  ].join('\n\n')
  const behaviorProfile =
    args.behaviorProfile === undefined
      ? resolveFableBehaviorProfile({
          requestedModelId: effective.modelId,
          resolvedModelId: args.resolvedModelId,
          enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
        }).profile
      : args.behaviorProfile
  const systemPrompt = compileFableSubagentPrompt(legacySystemPrompt, behaviorProfile)
  const fablePostToolUseHook = behaviorProfile ? createFablePostToolUseHook() : null
  chatDiag({
    kind: 'fable-behavior-profile',
    profile: behaviorProfile?.id ?? 'legacy',
    requestedModel: effective.modelId,
    resolvedModel: args.resolvedModelId ?? effective.modelId,
    transport: 'claude-agent-sdk',
    effort: effective.sentEffort ?? 'default',
    progressMode: behaviorProfile?.progressMode ?? 'prompt-only',
    agent: args.agentName,
    conv: args.conversationId,
  })
  args.signal.throwIfAborted()
  let text = ''
  const emitText = createSubagentTextEmitter(args.onTextUpdate)
  let result: SDKResultMessage | null = null
  let lastAssistantModelId: string | null = null
  const currentResult = (): SDKResultMessage | null => result
  const currentModelId = (): string | null => lastAssistantModelId
  const closeQuery = (): void => query?.close()
  const resetAttempt = (): void => {
    text = ''
    result = null
  }
  let usageRecorded = false
  const recordUsage = (usage: NormalizedAiUsage | undefined, attributedModel: ChatModelRef = model): void => {
    if (!usage || usageRecorded) return
    usageRecorded = true
    recordModelCallUsage({
      runtime: 'claude-subscription',
      providerId: attributedModel.providerId,
      modelId: attributedModel.modelId,
      conversationId: args.conversationId,
      agent: args.agentName,
      usage,
    })
  }
  /**
   * One SDK query. `session-replaced` means a resume was requested but the SDK reported a different session id
   * (it silently started a new one): the caller retries fresh with the fallback task so the worker at least
   * sees its previous report. `rejected` means the resume never initialized.
   */
  const stream = async (attempt: {
    taskText: string
    resumeId?: string
  }): Promise<'done' | 'session-replaced' | 'rejected'> => {
    const prompt = gatedClaudeHumanText(attempt.taskText)
    const queryAbort = new AbortController()
    const onRuntimeAbort = (): void => queryAbort.abort(runtimeSignal.reason)
    runtimeSignal.addEventListener('abort', onRuntimeAbort, { once: true })
    if (runtimeSignal.aborted) onRuntimeAbort()
    let replaced = false
    try {
      query = args.manager.createQuery({
        prompt: prompt.prompt,
        options: {
          abortController: queryAbort,
          cwd: args.cwd,
          model: args.resolvedModelId ?? effective.modelId,
          ...(effective.sentEffort
            ? { effort: effective.sentEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
            : {}),
          settings: {
            ...buildClaudeFastModeSettings(effective.fastMode === true),
          },
          systemPrompt,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: { maestrly: bridge.server },
          tools: [],
          allowedTools: bridge.allowedTools,
          disallowedTools: CLAUDE_DISALLOWED_NATIVE_TOOLS,
          toolAliases: bridge.toolAliases,
          skills: [],
          plugins: [],
          agents: {},
          hooks: {
            PreToolUse: [bridge.preToolUseHook],
            ...(fablePostToolUseHook ? { PostToolUse: [fablePostToolUseHook] } : {}),
          },
          ...(fablePostToolUseHook ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
          permissionMode: 'dontAsk',
          includePartialMessages: false,
          persistSession: args.persistRuntime === true,
          ...(attempt.resumeId ? { resume: attempt.resumeId } : {}),
          promptSuggestions: false,
        },
      })
      args.manager.assertAccountIdentity(args.accountIdentity)
      try {
        const initialized = await query.initializationResult()
        args.manager.assertSubscriptionRuntimeAccount(initialized.account, args.accountIdentity)
        args.manager.assertAccountIdentity(args.accountIdentity)
        args.signal.throwIfAborted()
        prompt.release()
      } catch (error) {
        prompt.reject(error)
        if (attempt.resumeId && !abortRequested) return 'rejected'
        throw error
      }
      args.progress?.(`Starting subagent ${args.agentName}`)
      let sessionReported = false
      try {
        for await (const message of query) {
          if (
            !sessionReported &&
            'session_id' in message &&
            typeof message.session_id === 'string' &&
            message.session_id
          ) {
            sessionReported = true
            if (attempt.resumeId && message.session_id !== attempt.resumeId) {
              replaced = true
              queryAbort.abort(new Error('Claude resumed a different session; restarting fresh.'))
              void query.interrupt().catch(() => undefined)
              break
            }
            args.onSessionStarted?.({ sessionId: message.session_id, resumed: Boolean(attempt.resumeId) })
          }
          if (message.type === 'assistant') lastAssistantModelId = message.message.model
          const assistantText = textFromAssistant(message)
          if (assistantText) {
            text = assistantText
            emitText(text)
          }
          if (message.type === 'tool_progress' && !message.parent_tool_use_id) {
            args.progress?.(`${bridge.nameFromSdk(message.tool_name)} running (${message.elapsed_time_seconds}s)`)
          }
          if (message.type === 'result') result = message
        }
      } catch (error) {
        if (replaced && !abortRequested) return 'session-replaced'
        throw error
      }
      return replaced ? 'session-replaced' : 'done'
    } finally {
      runtimeSignal.removeEventListener('abort', onRuntimeAbort)
      if (replaced) {
        query?.close()
        query = null
      }
    }
  }
  try {
    const outcome = args.resume
      ? await stream({ taskText: args.task, resumeId: args.resume.sessionId })
      : await stream({ taskText: args.task })
    if (outcome !== 'done') {
      resumeReason = outcome === 'rejected' ? 'resume-rejected' : 'session-replaced'
      args.progress?.(`Could not resume previous session (${resumeReason}); starting a fresh one`)
      resetAttempt()
      await stream({ taskText: args.resume!.fallbackTask })
    } else if (args.resume) {
      resumed = true
    }
    args.manager.assertAccountIdentity(args.accountIdentity)
    // Assigned inside `stream`; read through closures so control-flow narrowing does not collapse them to null.
    const result = currentResult()
    const usage = result ? resultUsage(result) : undefined
    const runtimeEstimatedCostUsd = resultRuntimeEstimatedCost(result)
    const servedModelMismatch = claudeServedModelMismatch(effective.modelId, result, currentModelId())
    const reportedModel = servedModelMismatch
      ? { providerId: model.providerId, modelId: servedModelMismatch.served }
      : model
    recordUsage(usage, reportedModel)
    if (abortRequested) {
      throw Object.assign(new Error('Subagent aborted'), {
        subagentUsage: usage,
        subagentModel: model,
        ...(runtimeEstimatedCostUsd != null ? { subagentRuntimeEstimatedCostUsd: runtimeEstimatedCostUsd } : {}),
      })
    }
    if (result?.subtype !== 'success') {
      const error = result && 'errors' in result ? result.errors.join('\n') : 'Claude subagent did not finish.'
      return withResume({
        text,
        error,
        ...(usage ? { usage } : {}),
        model,
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
      })
    }
    if (servedModelMismatch) {
      return withResume({
        text,
        error: servedModelMismatch.message,
        ...(usage ? { usage } : {}),
        model: reportedModel,
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
      })
    }
    if (!text && result.result) emitText(result.result)
    return withResume({
      text: text || result.result || '(the subagent returned no text)',
      ...(usage ? { usage } : {}),
      model,
      ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
    })
  } catch (error) {
    const measured = error as Error & {
      subagentUsage?: NormalizedAiUsage
      subagentRuntimeEstimatedCostUsd?: number
    }
    const result = currentResult()
    const usage = measured.subagentUsage ?? (result ? resultUsage(result) : undefined)
    const runtimeEstimatedCostUsd = measured.subagentRuntimeEstimatedCostUsd ?? resultRuntimeEstimatedCost(result)
    recordUsage(usage)
    if (abortRequested) {
      const aborted = error instanceof Error ? error : new Error(String(error))
      throw Object.assign(aborted, {
        ...(usage ? { subagentUsage: usage } : {}),
        subagentModel: model,
        ...(runtimeEstimatedCostUsd != null ? { subagentRuntimeEstimatedCostUsd: runtimeEstimatedCostUsd } : {}),
      })
    }
    return withResume({
      text,
      error: claudeRuntimeErrorMessage(error, effective.modelId),
      ...(usage ? { usage } : {}),
      model,
      ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
    })
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    closeQuery()
  }
}
