import { withCursorAccountRun } from './account-runs'
import { cursorModelSelectionsEqual } from './manager'
import { resolveCursorHarness } from '../harness/adapters/cursor'
import type { AgentOptions, ModelSelection } from '@cursor/sdk'
import type { ToolSet } from 'ai'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { selectSubagentToolNames } from '../tools'
import { CONVERSATION_DISPATCH_TOOL_NAMES } from '../tool-policy'
import { recordModelCallUsage } from '../usage-diagnostics'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import { createCursorStreamMapper, resolveCursorTerminalEvidence } from '../cursor-sdk/stream-map'
import { estimateCursorPublishedCostUsd } from '../cursor-sdk/models'
import { cursorSdkErrorMessage, redactCursorCredentials } from '../cursor-sdk/errors'
import type { CursorAgentLease, CursorSubscriptionAccountIdentity, CursorSubscriptionManager } from './manager'
import { clearCursorAgentCleanup, markCursorAgentCleanupFailed, queueCursorAgentCleanup } from './session-store'
import { buildCursorToolBridge } from './tool-bridge'
import { awaitCursorOperation, closeCursorLease, cancelLateCursorRun, runCursorRunWithWatchdog } from './watchdog'

const FORBIDDEN_CHILD_TOOLS = new Set<string>([
  'task',
  'delegate',
  'review_plan',
  'ask_question',
  'todo_write',
  ...CONVERSATION_DISPATCH_TOOL_NAMES,
])

export interface RunCursorSubagentArgs {
  manager: CursorSubscriptionManager
  accountIdentity: CursorSubscriptionAccountIdentity
  conversationId: string
  cwd: string
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  signal: AbortSignal
  watchdog?: { timeoutMs?: number; graceMs?: number; deadlineMs?: number }
  frozenModelSelection?: import('./manager').CursorModelSelectionSnapshot
  isHostPending?: () => boolean
  agentName: string
  task: string
  readOnly: boolean
  harness?: import('../harness/types').ResolvedHarness
  tools: ToolSet
  allowSkillLoader?: boolean
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
}

function childToolNames(
  definition: ChatAgent,
  readOnly: boolean,
  providedHostTools: ToolSet,
  allowSkillLoader?: boolean
): Set<string> {
  return selectSubagentToolNames({ definition, readOnly, providedHostTools, allowSkillLoader })
}

function usageFromMapper(
  usage: ReturnType<ReturnType<typeof createCursorStreamMapper>['state']>['lastUsage']
): NormalizedAiUsage | undefined {
  if (!usage) return undefined
  const totalInput = (usage.input ?? 0) + (usage.cachedInput ?? 0) + (usage.cacheCreate ?? 0)
  if (!totalInput && !(usage.output ?? 0)) return undefined
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cachedInput ?? 0,
    cacheCreate: usage.cacheCreate ?? 0,
    totalInput,
  }
}

async function cleanupEphemeral(manager: CursorSubscriptionManager, agentId: string, cwd: string): Promise<void> {
  try {
    await manager.deleteAgent(agentId)
    clearCursorAgentCleanup(agentId)
  } catch (error) {
    queueCursorAgentCleanup(null, agentId, cwd, manager.accountId ?? null)

    markCursorAgentCleanupFailed(agentId, error)
  }
}

async function runCursorSubagentInScope(args: RunCursorSubagentArgs): Promise<{
  text: string
  error?: string
  usage?: NormalizedAiUsage
  model?: ChatModelRef
  runtimeEstimatedCostUsd?: number
}> {
  args.signal.throwIfAborted()
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  const fastMode = effective.fastMode === true
  let model: ChatModelRef = { providerId: effective.providerId, modelId: effective.modelId }
  const allowedNames = childToolNames(args.definition, args.readOnly, args.tools, args.allowSkillLoader)
  const tools: ToolSet = Object.fromEntries(
    Object.entries(args.tools).filter(([name]) => allowedNames.has(name) && !FORBIDDEN_CHILD_TOOLS.has(name))
  )

  const systemPrompt = [
    (args.harness ?? resolveCursorHarness(effective.modelId)).prompts.subagent ?? '',
    args.definition.prompt,
    `You are the delegated Maestrly subagent "${args.agentName}". Work only on the supplied task.`,
    MEMORY_TOOL_GUIDANCE,
    args.readOnly
      ? 'This delegated run is strictly read-only. Do not modify files, execute mutating commands, or spawn subagents.'
      : 'You are a worker. Do not spawn subagents. Return a concise result to the parent when the task is complete.',
  ].join('\n\n')

  let lease: CursorAgentLease | null = null
  let agentId = ''
  let usageRecorded = false
  const recordUsage = (usage: NormalizedAiUsage | undefined): void => {
    if (!usage || usageRecorded) return
    usageRecorded = true
    recordModelCallUsage({
      runtime: 'cursor-subscription',
      providerId: model.providerId,
      modelId: model.modelId,
      conversationId: args.conversationId,
      agent: args.agentName,
      usage,
    })
  }

  const toolAbort = new AbortController()
  const toolSignal = AbortSignal.any([args.signal, toolAbort.signal])
  try {
    args.manager.assertAccountIdentity(args.accountIdentity)
    const bridge = await buildCursorToolBridge({ tools, signal: toolSignal })
    const resolvedModel = await args.manager.resolveModelSelection(
      effective.modelId,
      fastMode,
      false,
      effective.sentEffort
    )
    if (args.frozenModelSelection && !cursorModelSelectionsEqual(resolvedModel, args.frozenModelSelection))
      throw new Error('executor-unavailable')
    model = { providerId: effective.providerId, modelId: resolvedModel.modelId }
    const selection: ModelSelection = {
      id: resolvedModel.modelId,
      ...(resolvedModel.params.length
        ? { params: resolvedModel.params.map((param) => ({ id: param.id, value: param.value })) }
        : {}),
    }
    const agentOptions: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'> = {
      model: selection,
      mode: args.readOnly ? 'plan' : 'agent',
      local: { cwd: args.cwd, customTools: bridge.customTools },
      name: `maestrly:sub:${args.agentName.slice(0, 24)}`,
    }
    lease = await awaitCursorOperation(args.manager.createAgent(agentOptions), {
      signal: args.signal,
      timeoutMs: args.watchdog?.timeoutMs,
      onLateSettled: async (late) => {
        if (!late) return
        await closeCursorLease(late)
        await cleanupEphemeral(args.manager, late.agent.agentId, args.cwd)
      },
    })
    agentId = lease.agent.agentId
    args.manager.assertAccountIdentity(args.accountIdentity)
    args.signal.throwIfAborted()

    args.progress?.(`Starting subagent ${args.agentName}`)
    const sendingLease = lease
    const run = await awaitCursorOperation(
      lease.agent.send(
        {
          text: `${systemPrompt}\n\n# Task\n${args.task}`,
        },
        { model: selection, mode: args.readOnly ? 'plan' : 'agent' }
      ),
      {
        signal: args.signal,
        timeoutMs: args.watchdog?.timeoutMs,
        onAbandon: () => {
          lease = null
          agentId = ''
        },
        onLateSettled: async (lateRun) => {
          await cancelLateCursorRun(lateRun, args.watchdog?.graceMs)
          await closeCursorLease(sendingLease)
          await cleanupEphemeral(args.manager, sendingLease.agent.agentId, args.cwd)
        },
      }
    )

    const mapper = createCursorStreamMapper(`cursor-sub-${args.agentName}`, bridge.takeToolOutput)
    let text = ''
    const emitText = createSubagentTextEmitter(args.onTextUpdate)
    const outcome = await runCursorRunWithWatchdog({
      stream: run.supports('stream') ? () => run.stream() : undefined,
      wait: run.supports('wait') ? () => run.wait() : undefined,
      cancel: () => run.cancel(),
      onMessage: (message) => {
        for (const event of mapper.push(message)) {
          if (event.kind === 'text-delta' && 'delta' in event && typeof event.delta === 'string') {
            text += event.delta
            emitText(text)
          }
          if (event.kind === 'tool-input-start' && 'toolName' in event) {
            args.progress?.(`${bridge.nameFromSdk(String(event.toolName))} started`)
          }
        }
      },
      signal: args.signal,
      isHostPending: args.isHostPending,
      ...args.watchdog,
    })
    if (outcome.stalled) toolAbort.abort()

    args.manager.assertAccountIdentity(args.accountIdentity)
    const state = mapper.state()
    const usage = usageFromMapper(state.lastUsage)
    const runtimeEstimatedCostUsd = usage
      ? estimateCursorPublishedCostUsd(model.modelId, fastMode, {
          input: usage.input,
          output: usage.output,
          cachedInput: usage.cacheRead,
          cacheCreate: usage.cacheCreate,
        })
      : null
    recordUsage(usage)

    if (args.signal.aborted || outcome.aborted) {
      throw Object.assign(new Error('Subagent aborted'), {
        ...(usage ? { subagentUsage: usage } : {}),
        ...(runtimeEstimatedCostUsd != null ? { subagentRuntimeEstimatedCostUsd: runtimeEstimatedCostUsd } : {}),
        subagentModel: model,
      })
    }
    if (outcome.stalled) {
      return {
        text,
        error: `Cursor subagent stalled (${outcome.stalled}).`,
        ...(usage ? { usage } : {}),
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
        model,
      }
    }

    const resolution = resolveCursorTerminalEvidence(state.finishStatus, outcome.waitResult?.status)
    if (resolution.status !== 'FINISHED' || resolution.conflict) {
      const detail =
        state.finishMessage ||
        outcome.waitResult?.error?.message ||
        (resolution.conflict
          ? 'Cursor subagent ended with conflicting terminal evidence'
          : resolution.status
            ? `Cursor subagent ended with status ${resolution.status}`
            : 'Cursor subagent ended without a terminal status')
      return {
        text,
        error: redactCursorCredentials(detail),
        ...(usage ? { usage } : {}),
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
        model,
      }
    }

    return {
      text: text.trim() || '(the subagent returned no text)',
      ...(usage ? { usage } : {}),
      ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
      model,
    }
  } catch (error) {
    toolAbort.abort()
    const measured = error as Error & {
      subagentUsage?: NormalizedAiUsage
      subagentRuntimeEstimatedCostUsd?: number
    }
    const usage = measured.subagentUsage
    recordUsage(usage)
    if (args.signal.aborted || measured.message === 'Subagent aborted') {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        ...(usage ? { subagentUsage: usage } : {}),
        ...(measured.subagentRuntimeEstimatedCostUsd != null
          ? { subagentRuntimeEstimatedCostUsd: measured.subagentRuntimeEstimatedCostUsd }
          : {}),
        subagentModel: model,
      })
    }
    return {
      text: '',
      error: cursorSdkErrorMessage(error),
      ...(usage ? { usage } : {}),
      ...(measured.subagentRuntimeEstimatedCostUsd != null
        ? { runtimeEstimatedCostUsd: measured.subagentRuntimeEstimatedCostUsd }
        : {}),
      model,
    }
  } finally {
    toolAbort.abort()
    if (lease) {
      try {
        await closeCursorLease(lease)
      } catch {
        agentId = '' /* Retain ownership if close fails. */
      }
    }
    if (agentId) {
      await cleanupEphemeral(args.manager, agentId, args.cwd)
    }
  }
}

/** Account teardown also reaches helpers and children hosted by another provider. */
export function runCursorSubagent(
  args: Parameters<typeof runCursorSubagentInScope>[0]
): ReturnType<typeof runCursorSubagentInScope> {
  return withCursorAccountRun(args, (signal) => runCursorSubagentInScope({ ...args, signal }))
}
