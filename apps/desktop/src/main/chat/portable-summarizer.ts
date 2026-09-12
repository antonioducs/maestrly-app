import { randomUUID } from 'node:crypto'
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'
import type { SDKMessage, SDKResultMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedAiUsage } from './runner'
import type { CodexAppServerClient } from './codex-subscription/client'
import { deleteEphemeralCodexThread } from './codex-subscription/lifecycle'
import { queueCodexThreadCleanup } from './codex-subscription/thread-store'
import { codexTextInput } from './codex-subscription/protocol'
import { hardDeleteGitHubCopilotSession } from './github-copilot/lifecycle'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotSubscriptionManager,
} from './github-copilot/manager'
import { queueGitHubCopilotSessionCleanup } from './github-copilot/session-store'
import type { ClaudeSubscriptionAccountIdentity, ClaudeSubscriptionManager } from './claude-agent-sdk/manager'
import { buildClaudeFastModeSettings } from './claude-agent-sdk/options'
import { CLAUDE_DISALLOWED_NATIVE_TOOLS } from './claude-agent-sdk/tools'
import { gatedClaudeHumanPrompt, gatedClaudeHumanText } from './claude-agent-sdk/user-prompt'
import { classifyClaudeQuotaFailure, type ClaudeQuotaClassification } from './claude-agent-sdk/quota-error'
import { normalizeClaudeUsage } from './claude-agent-sdk/usage'
import { redactClaudeCredentials } from './claude-agent-sdk/errors'

const safeTokens = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface CodexTokenUsageSnapshot {
  tokenUsage?: { total?: Record<string, unknown> }
}

function usageFromCodexSnapshot(snapshot: CodexTokenUsageSnapshot | null): NormalizedAiUsage | undefined {
  const totals = snapshot?.tokenUsage?.total
  const inputTotal = safeTokens(totals?.inputTokens)
  const cacheRead = Math.min(inputTotal, safeTokens(totals?.cachedInputTokens))
  const output = safeTokens(totals?.outputTokens)
  return inputTotal || output
    ? { input: inputTotal - cacheRead, output, cacheRead, cacheCreate: 0, totalInput: inputTotal }
    : undefined
}

export interface IsolatedSummaryResult {
  text: string
  usage?: NormalizedAiUsage
  /** Native runtime estimate for THIS call (e.g. Claude total_cost_usd). */
  runtimeEstimatedCostUsd?: number
}

/** Usage reported by an ephemeral Codex attempt before the attempt failed. */
export type IsolatedSummaryAttemptError = Error & {
  partialUsage?: NormalizedAiUsage
  runtimeEstimatedCostUsd?: number
  rawFailure?: unknown
  rateLimitInfo?: SDKRateLimitInfo
  quotaClassification?: ClaudeQuotaClassification
}

function isolatedUsage(value: unknown): NormalizedAiUsage | undefined {
  if (!isRecord(value)) return undefined
  const raw = isRecord(value.partialUsage) ? value.partialUsage : isRecord(value.usage) ? value.usage : null
  if (!raw) return undefined
  const cacheRead = safeTokens(raw.cacheRead)
  const cacheCreate = safeTokens(raw.cacheCreate)
  const input = safeTokens(raw.input)
  const totalInput = Math.max(safeTokens(raw.totalInput), input + cacheRead + cacheCreate)
  const output = safeTokens(raw.output)
  if (!totalInput && !output) return undefined
  const boundedCacheRead = Math.min(totalInput, cacheRead)
  const boundedCacheCreate = Math.min(totalInput - boundedCacheRead, cacheCreate)
  return {
    input: Math.max(0, totalInput - boundedCacheRead - boundedCacheCreate),
    output,
    cacheRead: boundedCacheRead,
    cacheCreate: boundedCacheCreate,
    totalInput,
  }
}

/** Extracts either a successful isolated result's usage or a failed attempt's partial usage. */
export function isolatedSummaryAttemptUsage(value: unknown): NormalizedAiUsage | undefined {
  return isolatedUsage(value)
}

export function addIsolatedSummaryUsage(
  first: NormalizedAiUsage | undefined,
  second: NormalizedAiUsage | undefined
): NormalizedAiUsage | undefined {
  if (!first && !second) return undefined
  return {
    input: (first?.input ?? 0) + (second?.input ?? 0),
    output: (first?.output ?? 0) + (second?.output ?? 0),
    cacheRead: (first?.cacheRead ?? 0) + (second?.cacheRead ?? 0),
    cacheCreate: (first?.cacheCreate ?? 0) + (second?.cacheCreate ?? 0),
    totalInput: (first?.totalInput ?? 0) + (second?.totalInput ?? 0),
  }
}

/** Merges only usage from attempts that failed before the successful isolated result. */
export function mergeIsolatedSummaryUsage(
  result: IsolatedSummaryResult,
  failedAttemptUsage: NormalizedAiUsage
): IsolatedSummaryResult {
  return { ...result, usage: addIsolatedSummaryUsage(result.usage, failedAttemptUsage) }
}

/**
 * Image attached to an isolated call (image interpreter). Each official runtime requires a different
 * format of the SAME bytes: Claude needs base64 + media_type, Codex a data URL, Copilot a blob.
 */
export interface IsolatedImageInput {
  name: string
  mediaType: string
  /** Raw base64 (without the `data:` prefix). */
  base64: string
  /** `data:<mime>;base64,<...>` — same content as the persisted part. */
  dataUrl: string
}

/** One tool-free, non-persisted Claude query. It never touches the conversation's resumable binding. */
export async function summarizeWithClaudeRuntime(args: {
  manager: ClaudeSubscriptionManager
  accountIdentity: ClaudeSubscriptionAccountIdentity
  cwd: string
  modelId: string
  system: string
  prompt: string
  signal: AbortSignal
  effort?: string
  /** Frozen effective Fast Mode; absent preserves current generic options. */
  fastMode?: boolean
  /** Image attachments (image interpreter); absent = text-only call. */
  images?: readonly IsolatedImageInput[]
}): Promise<IsolatedSummaryResult> {
  args.signal.throwIfAborted()
  args.manager.assertAccountIdentity(args.accountIdentity)
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].find((value) => value === args.effort) as
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | undefined
  const prompt = args.images?.length
    ? gatedClaudeHumanPrompt([
        ...args.images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
        })),
        { type: 'text' as const, text: args.prompt },
      ] as unknown as Parameters<typeof gatedClaudeHumanPrompt>[0])
    : gatedClaudeHumanText(args.prompt)
  const abortController = new AbortController()
  let query: ReturnType<ClaudeSubscriptionManager['createQuery']>
  try {
    query = args.manager.createQuery({
      prompt: prompt.prompt,
      options: {
        abortController,
        cwd: args.cwd,
        model: args.modelId,
        ...(effort ? { effort } : {}),
        systemPrompt: args.system,
        settingSources: [],
        ...(typeof args.fastMode === 'boolean'
          ? {
              settings: {
                ...buildClaudeFastModeSettings(args.fastMode),
                promptSuggestionEnabled: false,
                autoMemoryEnabled: false,
                autoCompactEnabled: false,
                precomputeCompactionEnabled: false,
              },
            }
          : {}),
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        allowedTools: [],
        disallowedTools: CLAUDE_DISALLOWED_NATIVE_TOOLS,
        skills: [],
        plugins: [],
        agents: {},
        permissionMode: 'dontAsk',
        persistSession: false,
        includePartialMessages: false,
        promptSuggestions: false,
      },
    })
  } catch (error) {
    prompt.reject(error)
    throw Object.assign(
      new Error(redactClaudeCredentials(error instanceof Error ? error.message : String(error)), { cause: error }),
      {
        rawFailure: error,
        quotaClassification: classifyClaudeQuotaFailure(error),
      }
    )
  }
  const textByMessage = new Map<string, string>()
  const assistantUsage = new Map<string, NormalizedAiUsage>()
  let rawFailure: unknown
  let rateLimitInfo: SDKRateLimitInfo | undefined
  const assistantCosts = new Map<string, number>()
  let result: SDKResultMessage | null = null
  const onAbort = () => {
    abortController.abort(args.signal.reason ?? new Error('Claude summary was aborted.'))
    void query.interrupt().catch(() => undefined)
    query.close()
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  try {
    args.signal.throwIfAborted()
    try {
      const initialized = await query.initializationResult()
      args.manager.assertSubscriptionRuntimeAccount(initialized.account, args.accountIdentity)
      args.manager.assertAccountIdentity(args.accountIdentity)
      args.signal.throwIfAborted()
      prompt.release()
    } catch (error) {
      prompt.reject(error)
      throw error
    }
    for await (const message of query as AsyncIterable<SDKMessage>) {
      if (message.type === 'rate_limit_event') rateLimitInfo = message.rate_limit_info
      if (message.type === 'assistant') {
        if (message.error) rawFailure = message
        if (message.message.usage)
          assistantUsage.set(message.message.id ?? message.uuid, normalizeClaudeUsage(message.message.usage))
        const reportedCost = (message as unknown as { total_cost_usd?: number }).total_cost_usd
        if (typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0)
          assistantCosts.set(message.message.id ?? message.uuid, reportedCost)
        const text = message.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim()
        if (text) textByMessage.set(message.uuid, text)
      } else if (message.type === 'result') {
        result = message
      }
    }
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (args.signal.aborted) throw args.signal.reason ?? new Error('Claude summary was aborted.')
    if (result?.subtype !== 'success') {
      if (result && result.subtype !== 'error_during_execution') rawFailure = result
      else rawFailure ??= result
      throw new Error(
        result && 'errors' in result && result.errors.length
          ? result.errors.join('\n')
          : 'Claude portable compaction failed.'
      )
    }
    const normalizedUsage = normalizeClaudeUsage(result.usage)
    const usage =
      normalizedUsage.totalInput || normalizedUsage.output
        ? {
            input: normalizedUsage.input,
            output: normalizedUsage.output,
            cacheRead: normalizedUsage.cacheRead,
            cacheCreate: normalizedUsage.cacheCreate,
            totalInput: normalizedUsage.totalInput,
          }
        : undefined
    return {
      text: [...textByMessage.values()].at(-1) ?? '',
      ...(usage ? { usage } : {}),
      // Native helper-call estimate: contributes to aggregated compaction cost (summarizePortableTranscript).
      ...(Number.isFinite(Number(result?.total_cost_usd)) && Number(result?.total_cost_usd) >= 0
        ? { runtimeEstimatedCostUsd: Number(result?.total_cost_usd) }
        : {}),
    }
  } catch (error) {
    const failure = new Error(redactClaudeCredentials(error instanceof Error ? error.message : String(error)), {
      cause: error,
    }) as IsolatedSummaryAttemptError
    failure.rawFailure = rawFailure ?? error
    failure.rateLimitInfo = rateLimitInfo
    failure.quotaClassification = classifyClaudeQuotaFailure(failure.rawFailure, rateLimitInfo)
    failure.partialUsage = result?.usage
      ? normalizeClaudeUsage(result.usage)
      : [...assistantUsage.values()].reduce<NormalizedAiUsage | undefined>(
          (sum, usage) => addIsolatedSummaryUsage(sum, usage),
          undefined
        )
    const amount =
      result?.total_cost_usd ??
      (assistantCosts.size && [...assistantUsage.keys()].every((key) => assistantCosts.has(key))
        ? [...assistantCosts.values()].reduce((sum, value) => sum + value, 0)
        : undefined)
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) failure.runtimeEstimatedCostUsd = amount
    throw failure
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    prompt.reject(new Error('Claude summary closed.'))
    query.close()
  }
}

/** Reasoning vocabulary accepted by the Copilot SDK (`ReasoningEffort`). */
const COPILOT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/** One tool-free ephemeral Codex thread. It never touches the conversation's resumable binding. */
export async function summarizeWithCodexRuntime(args: {
  client: CodexAppServerClient
  cwd: string
  modelId: string
  system: string
  prompt: string
  signal: AbortSignal
  /** Selected reasoning effort; absent = runtime decides (same semantics as a turn without override). */
  effort?: string
  /** Frozen effective service tier; absent preserves generic runtime semantics. */
  serviceTier?: string | null
  /** Image attachments (image interpreter); absent = text-only call. */
  images?: readonly IsolatedImageInput[]
  /** Conversation OWNING the ephemeral thread — seeds a durable cleanup-retry TOMBSTONE. Absent = no tombstone. */
  conversationId?: string
  /** Owner account for managed hard-delete (null = default account). */
  accountId?: string | null
}): Promise<IsolatedSummaryResult> {
  let threadId = ''
  let turnId = ''
  let latestUsage: CodexTokenUsageSnapshot | null = null
  const textByItem = new Map<string, string>()
  let resolveCompleted!: (status: string) => void
  let rejectCompleted!: (error: Error) => void
  const completed = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  let rejectAborted!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  void aborted.catch(() => {})
  let off = () => {}
  const onAbort = () => {
    if (threadId && turnId) {
      void args.client
        .interruptTurn({ threadId, turnId }, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 })
        .catch(() => {})
    }
    const reason = args.signal.reason
    rejectAborted(reason instanceof Error ? reason : new Error('Codex summary was aborted.'))
  }
  args.signal.throwIfAborted()
  args.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const startThreadRequest = args.client.startThread(
      {
        model: args.modelId,
        ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
        cwd: args.cwd,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        ephemeral: true,
        dynamicTools: [],
        environments: [],
        config: {
          'features.multi_agent': false,
          'features.multi_agent_v2': false,
          'features.shell_tool': false,
          // Runtime default may be true; compaction is deliberately tool-free and never generates artifacts.
          'features.image_generation': false,
          web_search: 'disabled',
        },
        developerInstructions: args.system,
        personality: 'pragmatic',
      } as Parameters<CodexAppServerClient['startThread']>[0] & { dynamicTools: []; environments: [] },
      { signal: args.signal, timeoutMs: 0 }
    )
    void startThreadRequest.catch(() => {})
    let started: Awaited<typeof startThreadRequest>
    try {
      started = await Promise.race([
        startThreadRequest,
        aborted,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('Codex app-server exited while starting portable compaction')
        }),
      ])
    } catch (error) {
      void startThreadRequest
        .then(async (lateThread) => {
          if (args.conversationId) {
            await deleteEphemeralCodexThread(args.conversationId, lateThread.thread.id, {
              signal: AbortSignal.timeout(15_000),
              accountId: args.accountId ?? null,
            }).catch(() => undefined)
            return
          }
          await args.client
            .deleteThread(
              { threadId: lateThread.thread.id },
              { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 }
            )
            .catch(() => {})
        })
        .catch(() => {})
      throw error
    }
    threadId = started.thread.id
    args.signal.throwIfAborted()
    // DURABLE tombstone as soon as the ID exists: if app-server crashes/logout/network fails before deletion,
    // cleanup handles retry (retryManagedCodexThreadCleanup) — never lose the remote state ID.
    if (args.conversationId) queueCodexThreadCleanup(args.conversationId, threadId, args.accountId ?? null)
    off = args.client.onNotification(({ method, params }) => {
      if (!isRecord(params) || params.threadId !== threadId) return
      if (method === 'turn/started') {
        const turn = isRecord(params.turn) ? params.turn : null
        if (turn && typeof turn.id === 'string') turnId = turn.id
        if (args.signal.aborted) onAbort()
      } else if (method === 'thread/tokenUsage/updated') {
        latestUsage = params as typeof latestUsage
      } else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : 'summary'
        textByItem.set(itemId, (textByItem.get(itemId) ?? '') + params.delta)
      } else if (method === 'item/completed') {
        const item = isRecord(params.item) ? params.item : null
        if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
          if (!textByItem.has(item.id)) textByItem.set(item.id, item.text)
        }
      } else if (method === 'turn/completed') {
        const turn = isRecord(params.turn) ? params.turn : null
        resolveCompleted(typeof turn?.status === 'string' ? turn.status : 'failed')
      } else if (method === 'thread/deleted') {
        rejectCompleted(new Error('Codex compacting thread was deleted before completion'))
      }
    })
    const startTurnRequest = args.client.startTurn(
      {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [
          ...(args.images ?? []).map((image) => ({
            type: 'image' as const,
            url: image.dataUrl,
            detail: 'auto' as const,
          })),
          codexTextInput(args.prompt),
        ],
        cwd: args.cwd,
        model: args.modelId,
        ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: args.effort ?? null,
        summary: 'auto',
        personality: 'pragmatic',
        collaborationMode: {
          mode: 'default',
          settings: { model: args.modelId, reasoning_effort: args.effort ?? null, developer_instructions: null },
        },
      },
      { signal: args.signal, timeoutMs: 0 }
    )
    void startTurnRequest.catch(() => {})
    let turn: Awaited<typeof startTurnRequest>
    try {
      turn = await Promise.race([
        startTurnRequest,
        aborted,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('Codex app-server exited while starting a portable turn')
        }),
      ])
    } catch (error) {
      void startTurnRequest
        .then((lateTurn) =>
          args.client
            .interruptTurn(
              { threadId, turnId: lateTurn.turn.id },
              { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 }
            )
            .catch(() => {})
        )
        .catch(() => {})
      throw error
    }
    turnId = turn.turn.id
    if (args.signal.aborted) onAbort()
    const status = await Promise.race([
      completed,
      aborted,
      args.client.waitForExit().then(() => {
        throw args.client.failure ?? new Error('Codex app-server exited during portable compaction')
      }),
    ])
    args.signal.throwIfAborted()
    if (status !== 'completed') throw new Error(`Codex portable compaction ${status}`)
    const text = [...textByItem.values()].join('\n\n').trim()
    const usage = usageFromCodexSnapshot(latestUsage)
    return { text, ...(usage ? { usage } : {}) }
  } catch (error) {
    const partialUsage = usageFromCodexSnapshot(latestUsage)
    if (!partialUsage) throw error
    const withUsage =
      error instanceof Error ? error : new Error(error == null ? 'Codex portable compaction failed' : String(error))
    const usageError = withUsage as IsolatedSummaryAttemptError
    if (!usageError.partialUsage) usageError.partialUsage = partialUsage
    throw usageError
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    off()
    if (threadId) {
      if (turnId) {
        await args.client
          .interruptTurn({ threadId, turnId }, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 })
          .catch(() => {})
      }
      if (args.conversationId) {
        // Managed hard-delete: success clears the tombstone; failure retains it for durable retry. No binding.
        await deleteEphemeralCodexThread(args.conversationId, threadId, {
          signal: AbortSignal.timeout(15_000),
          accountId: args.accountId ?? null,
        }).catch(() => undefined)
      } else {
        await args.client
          .deleteThread({ threadId }, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 })
          .catch(() => {})
      }
    }
  }
}

/** One tool-free, store-free Copilot session. It never touches the conversation's resumable binding. */
export async function summarizeWithGitHubCopilotRuntime(args: {
  manager: GitHubCopilotSubscriptionManager
  accountIdentity: GitHubCopilotAccountIdentity
  conversationId: string
  cwd: string
  modelId: string
  system: string
  prompt: string
  signal: AbortSignal
  /** Selected reasoning effort (SDK accepts only low|medium|high|xhigh and only on supported models;
   * DISCARD any other value here instead of failing the entire session). */
  effort?: string
  /** Image attachments (image interpreter); absent = text-only call. */
  images?: readonly IsolatedImageInput[]
}): Promise<IsolatedSummaryResult> {
  const usage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  const textByMessage = new Map<string, string>()
  let session: CopilotSession | null = null
  let sessionId = ''
  let fatal = ''
  const onEvent = (event: SessionEvent): void => {
    if (event.agentId) return
    if (event.type === 'assistant.message_delta' && event.data.deltaContent) {
      textByMessage.set(event.data.messageId, (textByMessage.get(event.data.messageId) ?? '') + event.data.deltaContent)
    } else if (event.type === 'assistant.message' && event.data.content) {
      textByMessage.set(event.data.messageId, event.data.content)
    } else if (event.type === 'assistant.usage') {
      const inputTotal = safeTokens(event.data.inputTokens)
      const cacheRead = Math.min(inputTotal, safeTokens(event.data.cacheReadTokens))
      const cacheCreate = Math.min(inputTotal - cacheRead, safeTokens(event.data.cacheWriteTokens))
      usage.input += inputTotal - cacheRead - cacheCreate
      usage.output += safeTokens(event.data.outputTokens)
      usage.cacheRead += cacheRead
      usage.cacheCreate += cacheCreate
      usage.totalInput += inputTotal
    } else if (event.type === 'session.error') fatal = event.data.message
  }
  const copilotEffort = COPILOT_REASONING_EFFORTS.find((e) => e === args.effort)
  const config: GitHubCopilotCreateSessionConfig = {
    model: args.modelId,
    ...(copilotEffort ? { reasoningEffort: copilotEffort } : {}),
    workingDirectory: args.cwd,
    tools: [],
    availableTools: [],
    customAgents: [],
    systemMessage: { mode: 'replace', content: args.system },
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
    onPermissionRequest: () => ({ kind: 'reject' as const, feedback: 'Portable compaction has no tools.' }),
    onEvent,
  }
  const onAbort = () => void session?.abort().catch(() => undefined)
  args.signal.addEventListener('abort', onAbort, { once: true })
  try {
    args.manager.assertAccountIdentity(args.accountIdentity)
    session = await args.manager.createSession(config)
    sessionId = session.sessionId
    if (args.signal.aborted) onAbort()
    const attachments = (args.images ?? []).map((image) => ({
      type: 'blob' as const,
      data: image.base64,
      mimeType: image.mediaType,
      displayName: image.name,
    }))
    const final = await session.sendAndWait(
      { prompt: args.prompt, agentMode: 'interactive', ...(attachments.length ? { attachments } : {}) },
      120_000
    )
    if (final?.data.content) textByMessage.set(final.data.messageId, final.data.content)
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (fatal) throw new Error(fatal)
    const text = [...textByMessage.values()].at(-1)?.trim() ?? ''
    return { text, ...(usage.totalInput || usage.output ? { usage } : {}) }
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
