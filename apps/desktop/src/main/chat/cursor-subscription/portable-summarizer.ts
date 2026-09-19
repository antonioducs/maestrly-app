import { withCursorAccountRun } from './account-runs'
import type { AgentOptions, ModelSelection, RunResult } from '@cursor/sdk'
import type { NormalizedAiUsage } from '../runner'
import { createCursorStreamMapper, resolveCursorTerminalEvidence } from '../cursor-sdk/stream-map'
import { estimateCursorPublishedCostUsd } from '../cursor-sdk/models'
import { cursorSdkErrorMessage, redactCursorCredentials } from '../cursor-sdk/errors'
import { cursorModelSelectionsEqual } from './manager'
import type {
  CursorAgentLease,
  CursorModelSelectionSnapshot,
  CursorSubscriptionAccountIdentity,
  CursorSubscriptionManager,
} from './manager'
import { clearCursorAgentCleanup, markCursorAgentCleanupFailed, queueCursorAgentCleanup } from './session-store'
import { awaitCursorOperation, closeCursorLease, cancelLateCursorRun, runCursorRunWithWatchdog } from './watchdog'

export interface IsolatedImageInput {
  data: string
  mimeType: string
  base64?: string
  dataUrl?: string
}

export interface IsolatedSummaryResult {
  text: string
  usage?: NormalizedAiUsage
  runtimeEstimatedCostUsd?: number
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

async function summarizeWithCursorRuntimeInScope(args: {
  manager: CursorSubscriptionManager
  accountIdentity: CursorSubscriptionAccountIdentity
  cwd: string
  modelId: string
  system: string
  prompt: string
  signal: AbortSignal
  images?: readonly IsolatedImageInput[]

  fastMode?: boolean

  reasoningEffort?: string

  frozenModelSelection?: CursorModelSelectionSnapshot

  watchdog?: { timeoutMs?: number; graceMs?: number; deadlineMs?: number }
}): Promise<IsolatedSummaryResult> {
  args.signal.throwIfAborted()
  args.manager.assertAccountIdentity(args.accountIdentity)

  let resolved: Awaited<ReturnType<CursorSubscriptionManager['resolveModelSelection']>> | null = null
  if (args.frozenModelSelection) {
    try {
      const live = await args.manager.resolveModelSelection(args.modelId, args.fastMode, true, args.reasoningEffort)
      if (!cursorModelSelectionsEqual(live, args.frozenModelSelection)) throw new Error('executor-unavailable')
      resolved = {
        ...live,
        modelId: args.frozenModelSelection.modelId,
        params: args.frozenModelSelection.params,
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'executor-unavailable') throw error
      throw new Error('executor-unavailable', { cause: error })
    }
  } else if (args.fastMode !== undefined || args.reasoningEffort) {
    resolved = await args.manager.resolveModelSelection(args.modelId, args.fastMode, false, args.reasoningEffort)
  }
  const selection: ModelSelection = resolved
    ? {
        id: resolved.modelId,
        ...(resolved.params.length
          ? { params: resolved.params.map((param) => ({ id: param.id, value: param.value })) }
          : {}),
      }
    : { id: args.modelId }
  const agentOptions: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'> = {
    model: selection,
    mode: 'plan',
    local: { cwd: args.cwd, customTools: {} },
    name: 'maestrly:summarizer',
  }

  let lease: CursorAgentLease | null = null
  let agentId = ''
  try {
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

    const images = (args.images ?? [])
      .map((image) => {
        if (image.data && image.mimeType) return { data: image.data, mimeType: image.mimeType }
        if (image.base64 && image.mimeType) return { data: image.base64, mimeType: image.mimeType }
        return null
      })
      .filter((entry): entry is { data: string; mimeType: string } => Boolean(entry))

    const sendingLease = lease
    const run = await awaitCursorOperation(
      lease.agent.send(
        {
          text: `${args.system}\n\n---\n\n${args.prompt}`,
          ...(images.length ? { images } : {}),
        },
        { model: selection, mode: 'plan' }
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

    const mapper = createCursorStreamMapper('cursor-summarizer')
    let text = ''
    const outcome = await runCursorRunWithWatchdog({
      stream: run.supports('stream') ? () => run.stream() : undefined,
      wait: run.supports('wait') ? () => run.wait() : undefined,
      cancel: () => run.cancel(),
      onMessage: (message) => {
        for (const event of mapper.push(message)) {
          if (event.kind === 'text-delta' && 'delta' in event && typeof event.delta === 'string') {
            text += event.delta
          }
        }
      },
      signal: args.signal,
      ...(args.watchdog
        ? { timeoutMs: args.watchdog.timeoutMs, graceMs: args.watchdog.graceMs, deadlineMs: args.watchdog.deadlineMs }
        : {}),
    })

    args.manager.assertAccountIdentity(args.accountIdentity)
    if (args.signal.aborted || outcome.aborted) {
      throw args.signal.reason ?? new Error('Cursor summary was aborted.')
    }
    if (outcome.stalled) {
      throw new Error(`Cursor summary stalled (${outcome.stalled}).`)
    }

    const state = mapper.state()
    const waitResult: RunResult | undefined = outcome.waitResult
    const resolution = resolveCursorTerminalEvidence(state.finishStatus, waitResult?.status)
    if (resolution.status !== 'FINISHED' || resolution.conflict) {
      const detail =
        state.finishMessage ||
        waitResult?.error?.message ||
        (resolution.conflict
          ? 'Cursor summary ended with conflicting terminal evidence'
          : resolution.status
            ? `Cursor summary ended with status ${resolution.status}`
            : 'Cursor summary ended without a terminal status')
      throw new Error(redactCursorCredentials(detail))
    }

    const usage = usageFromMapper(state.lastUsage)
    const runtimeEstimatedCostUsd = usage
      ? estimateCursorPublishedCostUsd(resolved?.modelId ?? args.modelId, args.fastMode, {
          input: usage.input,
          output: usage.output,
          cachedInput: usage.cacheRead,
          cacheCreate: usage.cacheCreate,
        })
      : null
    return {
      text: text.trim(),
      ...(usage ? { usage } : {}),
      ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
    }
  } catch (error) {
    throw new Error(cursorSdkErrorMessage(error))
  } finally {
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
export function summarizeWithCursorRuntime(
  args: Parameters<typeof summarizeWithCursorRuntimeInScope>[0]
): ReturnType<typeof summarizeWithCursorRuntimeInScope> {
  return withCursorAccountRun(args, (signal) => summarizeWithCursorRuntimeInScope({ ...args, signal }))
}
