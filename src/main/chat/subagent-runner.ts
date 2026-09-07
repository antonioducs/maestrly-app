import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { streamText, type ModelMessage, type ToolSet } from 'ai'
import type { SharedV3ProviderOptions } from '@ai-sdk/provider'
import { buildProviderOptionsForSentEffort, CUT_FINISH_REASONS, type ChatModelRef } from '../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import type { ChatAgent } from './agents'
import { getProvider } from './catalog'
import { chatDiag } from './diag-log'
import { MEMORY_TOOL_GUIDANCE } from './memory-tool-guidance'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile } from './fable/profile'
import { compileFableSubagentPrompt } from './fable/prompt'
import { isOpenAIHarnessActive, OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE, openAIHarnessProviderOptions } from './harness'
import { catalogProviderForBaseURL, getProviderModelMetaWithStatus } from './model-meta'
import {
  resolveInterleavedReplayPolicy,
  wrapInterleavedReplayModel,
  type InterleavedReplayStats,
} from './reasoning-replay'
import {
  advanceOpenAICompactionLifecycle,
  commitOpenAICompactionLifecycle,
  createOpenAICompactionLifecycle,
  isOpenAINativeCompactionEvent,
  rollbackOpenAICompactionLifecycle,
  type OpenAICompactionLifecycle,
} from './openai/compaction-lifecycle'
import { createOpenAIResponsesLedger, replayOpenAIResponsesLedger } from './openai/ledger'
import {
  buildOpenAINativeTools,
  OPENAI_APPLY_PATCH_TOOL_NAME,
  OPENAI_LOCAL_SHELL_TOOL_NAME,
} from './openai/native-tools'
import { compileOpenAIPrompt, openAINativeToolsPromptOverlay } from './openai/prompt'
import { compileOpenAIAstraPrompt } from './openai/astra-prompt'
import {
  isAstraHarnessProfile,
  OPENAI_GPT6_ASTRA_PROMPT_PROFILE,
  serializableReasoningEffortForProfile,
} from './model-harness-profile'
import type { OpenAILedgerReplayResult, OpenAIResponsesLedger, OpenAIStreamEventLike } from './openai/types'
import { optimizeOpenAITools } from './openai/tools'
import {
  reconcileOpenAIToolExecutions,
  wrapOpenAIToolExecutions,
  type OpenAIToolExecutionScope,
  type OpenAIToolExecutionStore,
} from './openai/execution'
import type { ToolExecutionRecord } from './openai/inference-store'
import { buildOpenAIProjectContext } from './project-context'
import { resolveChatModel } from './provider'
import type { PermissionAction, PermissionBroker, AssertInput } from './permission'
import {
  ALL_TOOL_NAMES,
  buildTools,
  hasSubagentMutatingCapability,
  selectSubagentToolNames,
  subagentToolMutates,
} from './tools'
import type { ToolContext } from './tools/util'
import { withAnthropicCacheControl } from './message'
import { AI_SDK_MAX_RETRIES, classifyStreamRetry, shouldBlockHighUsageRetry } from './retry-policy'
import { recordModelCallUsage } from './usage-diagnostics'
import { getAppFlag } from '../store'
import { applyFastModeServiceTier } from './fast-mode'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from './subagent-text-stream'
import type { SubagentMessageOwnership } from './subagent-ownership'

const SUB_MAX_CONTINUE = 2
const SUB_MAX_TOTAL_CONTINUES = 3
const SUB_PROGRESS_RESET_STEPS = 4
const IN_TURN_COMPACT_RATIO = 0.9

/**
 * Child tool calls are host-owned even when the child runtime is provider-native. Keep their IDs below the
 * parent `task` call so generated-image parts, permission records and tool-state events cannot collide with the
 * parent turn or with a sibling task.
 */
export function namespaceSubagentToolCallId(taskToolCallId: string, childToolCallId: string): string {
  return `subagent:${taskToolCallId}:${childToolCallId}`
}

/** Wraps a host ToolSet with the task-call namespace used by provider-native child bridges. */
export function namespaceSubagentToolSet(tools: ToolSet, taskToolCallId: string): ToolSet {
  if (!taskToolCallId) return tools
  const namespace = `subagent:${taskToolCallId}:`
  const namespaced: ToolSet = {}
  for (const [name, rawTool] of Object.entries(tools)) {
    const execute = (rawTool as { execute?: unknown }).execute
    if (typeof execute !== 'function') {
      namespaced[name] = rawTool
      continue
    }
    namespaced[name] = {
      ...(rawTool as object),
      execute: async (input: unknown, options: unknown) => {
        const sourceOptions = options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
        const childToolCallId =
          typeof sourceOptions.toolCallId === 'string' && sourceOptions.toolCallId
            ? sourceOptions.toolCallId
            : randomUUID()
        const toolCallId = childToolCallId.startsWith(namespace)
          ? childToolCallId
          : namespaceSubagentToolCallId(taskToolCallId, childToolCallId)
        return (execute as (input: unknown, options: Record<string, unknown>) => unknown)(input, {
          ...sourceOptions,
          toolCallId,
        })
      },
    } as (typeof namespaced)[string]
  }
  return namespaced
}

export interface NormalizedAiUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

function createStandaloneOpenAIExecutionStore(): OpenAIToolExecutionStore {
  const records = new Map<string, ToolExecutionRecord>()
  const key = (conversationId: string, callId: string): string => `${conversationId}\0${callId}`
  return {
    get: (conversationId, callId) => records.get(key(conversationId, callId)) ?? null,
    put: (record) => records.set(key(record.conversationId, record.callId), record),
  }
}

type AiUsageLike = {
  inputTokens?: unknown
  outputTokens?: unknown
  cachedInputTokens?: unknown
  inputTokenDetails?: { noCacheTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } | null
}

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

function normalizeAiUsage(usage: AiUsageLike | null | undefined): NormalizedAiUsage {
  const reportedTotal = tokenCount(usage?.inputTokens)
  const output = tokenCount(usage?.outputTokens)
  const reportedRead = tokenCount(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens)
  const reportedCreate = tokenCount(usage?.inputTokenDetails?.cacheWriteTokens)
  if (reportedTotal > 0) {
    const cacheRead = Math.min(reportedRead, reportedTotal)
    const cacheCreate = Math.min(reportedCreate, reportedTotal - cacheRead)
    return {
      input: reportedTotal - cacheRead - cacheCreate,
      output,
      cacheRead,
      cacheCreate,
      totalInput: reportedTotal,
    }
  }
  const input = tokenCount(usage?.inputTokenDetails?.noCacheTokens)
  return {
    input,
    output,
    cacheRead: reportedRead,
    cacheCreate: reportedCreate,
    totalInput: input + reportedRead + reportedCreate,
  }
}

function addNormalizedUsage(target: NormalizedAiUsage, value: AiUsageLike | null | undefined): NormalizedAiUsage {
  const usage = normalizeAiUsage(value)
  target.input += usage.input
  target.output += usage.output
  target.cacheRead += usage.cacheRead
  target.cacheCreate += usage.cacheCreate
  target.totalInput += usage.totalInput
  return target
}

function reconcileNormalizedUsage(
  target: NormalizedAiUsage,
  observed: NormalizedAiUsage,
  totalUsage: AiUsageLike | null | undefined
): NormalizedAiUsage {
  const total = normalizeAiUsage(totalUsage)
  if (observed.totalInput <= total.totalInput) {
    target.input += total.input - observed.input
    target.cacheRead += total.cacheRead - observed.cacheRead
    target.cacheCreate += total.cacheCreate - observed.cacheCreate
    target.totalInput += total.totalInput - observed.totalInput
  }
  if (observed.output <= total.output) target.output += total.output - observed.output
  return target
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function shortJson(value: unknown): string {
  if (value == null) return ''
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized && serialized !== '{}'
      ? ` ${serialized.length > 180 ? `${serialized.slice(0, 180)}…` : serialized}`
      : ''
  } catch {
    return ''
  }
}

function normalizeStreamFinishReason(finishReason: unknown, rawFinishReason?: unknown): string {
  const unified = typeof finishReason === 'string' ? finishReason : 'stop'
  if ((unified !== 'stop' && unified !== 'other') || typeof rawFinishReason !== 'string') return unified
  if (rawFinishReason === 'max_output_tokens' || rawFinishReason === 'max_tokens') return 'length'
  if (rawFinishReason === 'incomplete') return 'interrupted'
  return CUT_FINISH_REASONS.has(rawFinishReason) ? rawFinishReason : unified
}

function isCutStreamFinish(finishReason: unknown, rawFinishReason?: unknown): boolean {
  return CUT_FINISH_REASONS.has(normalizeStreamFinishReason(finishReason, rawFinishReason))
}

export function isOpenAINativeCompactionPart(part: { type: string; kind?: string }): boolean {
  return isOpenAINativeCompactionEvent(part)
}

export function prepareOpenAISubagentRetryLedger(
  ledger: OpenAIResponsesLedger,
  scope: OpenAIToolExecutionScope,
  store?: OpenAIToolExecutionStore
) {
  const reconciliation = store
    ? reconcileOpenAIToolExecutions(ledger, scope, store)
    : reconcileOpenAIToolExecutions(ledger, scope)
  return {
    ledger: reconciliation.ledger,
    recovered: reconciliation.recovered,
    replay: replayOpenAIResponsesLedger(reconciliation.ledger),
  }
}

export function canReplayOpenAILedger(
  replay: Pick<OpenAILedgerReplayResult, 'lossless' | 'requiresRawResponsesInput'>
): boolean {
  return replay.lossless && !replay.requiresRawResponsesInput
}

export function subagentPermissionAssertInput(input: {
  conversationId: string
  projectId: string
  action: PermissionAction
  resources: string[]
  save?: string[]
  toolCallId: string
  signal: AbortSignal
}): AssertInput {
  return { ...input, toolName: input.action }
}

/**
 * Retry/idempotency classification, unified with execution classification (subagentToolMutates): core and
 * provider-native mutators plus any host tool without a proven read-only contract fail closed as mutating,
 * so an interrupted run is never auto-replayed into a duplicate side effect. Read-only built-ins and host
 * tools with a proven read-only contract (app policy or MCP readOnlyHint) stay replayable.
 */
export function isNonReplayableSubagentMutation(
  hasDurableLedger: boolean,
  toolName: string,
  providedHostTools?: ToolSet | ReadonlySet<string>
): boolean {
  return !hasDurableLedger && subagentToolMutates(toolName, providedHostTools)
}

/** Same policy over the OpenAI ledger, used when canonical ledger replay becomes lossy and text retry would
 *  re-execute tools: any recorded mutating tool call (host or native) blocks the fallback. */
export function hasSubagentMutationInLedger(
  ledger: OpenAIResponsesLedger,
  providedHostTools?: ToolSet | ReadonlySet<string>
): boolean {
  return ledger.entries.some(
    (entry) => entry.type === 'tool-call' && subagentToolMutates(entry.toolName, providedHostTools)
  )
}

/**
 * Runs an isolated SUBAGENT (`task`): streamText with agent system prompt, subtask as its only
 * message (no parent conversation), a tool SUBSET (def.tools, or read-only default; NEVER `task` →
 * prevents recursion), and agent or conversation model. LEAN port of main-loop resilience:
 * transient errors (isRetryableStreamError) with backoff, cut finishes (CUT_FINISH_REASONS), and dead streams
 * without finish → reinvoke with partial text as context (SUB_MAX_CONTINUE/SUB_MAX_TOTAL_CONTINUES).
 * FINAL failure returns TYPED `error` (`task` throws → 'error' part; parent model sees it and decides);
 * turn abort THROWS (kills execute with the turn).
 */
export async function runSubagent(args: {
  cwd: string
  projectId: string
  conversationId: string
  /** Parent assistant message: all subagent executions disappear with it on clear/edit/delete. */
  parentMessageId: string
  /** Parent `task` tool ID; only namespaces private OpenAI ledger checkpoints. */
  toolCallId?: string
  /** Raw/adapted host ToolSet. Dynamic MCP/app tools are filtered and merged with the built-in fallback below. */
  tools?: ToolSet
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  broker: PermissionBroker
  signal: AbortSignal
  agentName: string
  task: string
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
  /** Controls provider-private checkpoints; standalone keeps them in memory and never requires chat FKs. */
  messageOwnership?: SubagentMessageOwnership
  /** Forces read-only tools even if the agent declares writes (plan/ask in ultra). */
  readOnly?: boolean
  /** Allows the host-governed skill loader when this child is a Maestro Pool worker. */
  allowSkillLoader?: boolean
  /**
   * Maestro continuity for stateless providers: the previous turn of this same worker (its task and its rendered
   * work) is replayed as chat history ahead of `task`, so the model continues its own prior work.
   */
  replayHistory?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
}): Promise<{ text: string; error?: string; usage?: NormalizedAiUsage; model?: ChatModelRef }> {
  const def = args.definition
  const usage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  const usedModel: ChatModelRef = { providerId: effective.providerId, modelId: effective.modelId }
  try {
    // Snapshot already resolved once per toolCallId. Adapter, harness, and options derive ONLY from it;
    // continuations never reevaluate rules/credentials or fail over after a possible mutation.
    const resolvedSubModel = resolveChatModel(usedModel.providerId, usedModel.modelId, {
      astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
    })
    const behaviorProfile = resolveFableBehaviorProfile({
      requestedModelId: usedModel.modelId,
      enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
    }).profile
    const provider = getProvider(usedModel.providerId)
    const catalogProviderId = provider ? catalogProviderForBaseURL(provider.baseURL) : null
    const subMetaResult = await getProviderModelMetaWithStatus(usedModel.modelId, catalogProviderId)
    const subMeta = subMetaResult.meta
    const useOpenAISubagent = isOpenAIHarnessActive(
      getAppFlag('chat.openAIHarness', true),
      resolvedSubModel.harnessProfile
    )
    const model = resolvedSubModel.model
    // Interleaved reasoning replay (DeepSeek/GLM/Kimi): subagent delegates tool looping to streamText,
    // so needs the SAME intra-step normalization as main runner. Effort does not gate replay —
    // 'off'/Default only omits override; model capability determines the requirement.
    const subReplayPolicy = resolveInterleavedReplayPolicy({
      transport: resolvedSubModel.transport,
      providerId: usedModel.providerId,
      modelId: usedModel.modelId,
      providerFingerprint: resolvedSubModel.providerFingerprint,
      meta: subMeta,
      catalogStatus: subMetaResult.status,
      reasoningEffort: effective.sentEffort,
    })
    const subReplayStats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
    const subStreamModel = subReplayPolicy ? wrapInterleavedReplayModel(model, subReplayPolicy, subReplayStats) : model
    chatDiag({
      kind: 'interleaved-replay-policy',
      provider: usedModel.providerId,
      model: usedModel.modelId,
      transport: resolvedSubModel.transport,
      agent: args.agentName,
      path: 'subagent',
      effort: effective.sentEffort ?? undefined,
      active: subReplayPolicy != null,
      ...(subReplayPolicy
        ? { field: subReplayPolicy.field }
        : {
            reason:
              resolvedSubModel.transport !== 'openai'
                ? 'transport'
                : subMeta == null && subMetaResult.status === 'unavailable'
                  ? 'catalog-miss'
                  : 'no-capability',
          }),
    })
    // openai-responses: OpenAI /v1/responses STORES by default (30-day retention) — subagent requires
    // the main turn's store:false (BYOK privacy). Without effort (subagent has no own reasoning)
    // → return undefined for other kinds (existing behavior unchanged).
    let subProviderOptions: SharedV3ProviderOptions | undefined = buildProviderOptionsForSentEffort(
      resolvedSubModel.transport,
      serializableReasoningEffortForProfile(resolvedSubModel.modelHarnessProfileId, effective.sentEffort)
    )
    subProviderOptions = applyFastModeServiceTier(subProviderOptions, effective.fastMode === true, usedModel.providerId)
    // Mirrors main runner: Anthropic models outside adapter tables default max_tokens to 4096 →
    // long subagent output cuts with 'length'. Catalog (models.dev) supplies the actual ceiling; other kinds
    // still omit the field (provider default).
    const subMaxOutputTokens = resolvedSubModel.transport === 'anthropic' ? subMeta?.maxOutput : undefined
    // review_plan (submit & release) belongs to the main turn, never isolated subagents (no
    // makeCtx.submitPlan or plan stopWhen). READ_ONLY already excludes it; remove from def.tools too.
    const subagentReadOnly = Boolean(args.readOnly) || !hasSubagentMutatingCapability(def.tools, args.tools)
    const providedHostTools = args.tools ?? {}
    const selectedToolNames = selectSubagentToolNames({
      definition: def,
      readOnly: subagentReadOnly,
      providedHostTools,
      allowSkillLoader: args.allowSkillLoader,
    })
    const enabled = new Set([...selectedToolNames].filter((name) => ALL_TOOL_NAMES.includes(name)))
    const subagentCanMutate = !subagentReadOnly && hasSubagentMutatingCapability(def.tools, args.tools)
    const subagentTaskCallId = args.toolCallId ?? randomUUID()
    const toolCallIdPrefix = `subagent:${args.parentMessageId}:${subagentTaskCallId}`
    const makeSubToolContext = (toolCallId: string, toolSignal: AbortSignal): ToolContext => ({
      conversationId: args.conversationId,
      projectId: args.projectId,
      messageId: args.parentMessageId,
      toolCallId: namespaceSubagentToolCallId(subagentTaskCallId, toolCallId),
      cwd: args.cwd,
      signal: toolSignal,
      ask: (action, resources, save) => {
        return args.broker.assert(
          subagentPermissionAssertInput({
            conversationId: args.conversationId,
            projectId: args.projectId,
            action,
            resources,
            save,
            toolCallId: namespaceSubagentToolCallId(subagentTaskCallId, toolCallId),
            signal: toolSignal,
          })
        )
      },
      // Isolated/noninteractive subagent → do not ask the user (return "dismissed").
      askQuestion: async () => [],
    })
    let tools: ToolSet = buildTools({
      enabled, // No `task` → no recursion.
      makeCtx: makeSubToolContext,
    })
    tools = {
      ...tools,
      ...namespaceSubagentToolSet(
        Object.fromEntries(Object.entries(providedHostTools).filter(([name]) => selectedToolNames.has(name))),
        subagentTaskCallId
      ),
    }
    let subSystem = compileFableSubagentPrompt([def.prompt, MEMORY_TOOL_GUIDANCE].join('\n\n'), behaviorProfile)
    chatDiag({
      kind: 'fable-behavior-profile',
      profile: behaviorProfile?.id ?? 'legacy',
      requestedModel: usedModel.modelId,
      resolvedModel: usedModel.modelId,
      transport: resolvedSubModel.transport,
      effort: effective.sentEffort ?? 'default',
      progressMode: 'prompt-only',
      agent: args.agentName,
      conv: args.conversationId,
    })
    let subLifecycle: OpenAICompactionLifecycle | null = useOpenAISubagent
      ? createOpenAICompactionLifecycle(createOpenAIResponsesLedger())
      : null
    const standalone = args.messageOwnership?.kind === 'standalone'
    const executionStore = standalone ? createStandaloneOpenAIExecutionStore() : undefined
    if (useOpenAISubagent) {
      const nativeTools = buildOpenAINativeTools({
        cwd: args.cwd,
        capabilities: {
          nativeShell: subagentCanMutate && enabled.has('bash') && resolvedSubModel.capabilities.nativeShell,
          nativeApplyPatch:
            subagentCanMutate &&
            enabled.has('edit') &&
            enabled.has('write') &&
            resolvedSubModel.capabilities.nativeApplyPatch,
        },
        makeCtx: makeSubToolContext,
      })
      if (nativeTools[OPENAI_LOCAL_SHELL_TOOL_NAME]) delete tools.bash
      if (nativeTools[OPENAI_APPLY_PATCH_TOOL_NAME]) {
        delete tools.edit
        delete tools.write
      }
      tools = { ...tools, ...nativeTools }
      const projectContext = standalone ? '' : await buildOpenAIProjectContext(args.projectId, args.cwd)
      const genericStablePrefix = [
        def.prompt,
        subagentCanMutate ? '' : 'This delegated run is read-only.',
        standalone ? '' : MEMORY_TOOL_GUIDANCE,
        standalone
          ? ''
          : openAINativeToolsPromptOverlay(
              {
                localShell: nativeTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
                applyPatch: nativeTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
              },
              subagentCanMutate ? 'agent' : 'ask'
            ),
        projectContext,
      ]
        .filter(Boolean)
        .join('\n\n')
      const genericEnvironment = standalone
        ? '# Environment\n\nHost-managed settings surface. No project or workspace context is available.'
        : `# Environment\n\nDelegated subagent: ${args.agentName}. Project directory: ${args.cwd}.`
      let promptStablePrefix = genericStablePrefix
      subSystem = `${genericStablePrefix}\n\n${genericEnvironment}`
      if (!standalone && resolvedSubModel.promptProfile === OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE) {
        const prompt = compileOpenAIPrompt({
          cwd: args.cwd,
          mode: subagentCanMutate ? 'agent' : 'ask',
          appToolsEnabled: false,
          hasNotesTab: false,
          projectContext,
          agentsContext: `${subagentCanMutate ? '' : 'This delegated run is read-only.\n\n'}${def.prompt}`,
          envContext: `Delegated subagent: ${args.agentName}. Project directory: ${args.cwd}.`,
          nativeTools: {
            localShell: nativeTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
            applyPatch: nativeTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
          },
        })
        subSystem = prompt.instructions
        promptStablePrefix = prompt.stablePrefix
      } else if (!standalone && resolvedSubModel.promptProfile === OPENAI_GPT6_ASTRA_PROMPT_PROFILE) {
        const prompt = compileOpenAIAstraPrompt({
          cwd: args.cwd,
          mode: subagentCanMutate ? 'agent' : 'ask',
          appToolsEnabled: false,
          hasNotesTab: false,
          projectContext,
          agentsContext: `${subagentCanMutate ? '' : 'This delegated run is read-only.\n\n'}${def.prompt}`,
          envContext: `Delegated subagent: ${args.agentName}. Project directory: ${args.cwd}.`,
          nativeTools: {
            localShell: nativeTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
            applyPatch: nativeTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
          },
        })
        subSystem = prompt.instructions
        promptStablePrefix = prompt.stablePrefix
      }
      const optimized = await optimizeOpenAITools(tools, {
        conversationId: args.conversationId,
        enableToolSearch: false,
      })
      tools = wrapOpenAIToolExecutions(
        optimized.tools,
        optimized.scheduler,
        {
          conversationId: args.conversationId,
          messageId: args.parentMessageId,
          callIdPrefix: toolCallIdPrefix,
        },
        executionStore
      )
      const promptCacheKey = `maestrly:sub:${createHash('sha256')
        .update(promptStablePrefix)
        .update('\0')
        .update(Object.keys(tools).sort().join('\0'))
        .digest('hex')}`
      subProviderOptions = {
        ...subProviderOptions,
        openai: {
          ...(subProviderOptions?.openai ?? {}),
          ...openAIHarnessProviderOptions(
            { profile: resolvedSubModel.harnessProfile, capabilities: resolvedSubModel.capabilities },
            {
              promptCacheKey,
              reasoningEnabled: resolvedSubModel.capabilities.encryptedReasoning,
              compactionThreshold: subMeta?.contextWindow
                ? Math.floor(subMeta.contextWindow * IN_TURN_COMPACT_RATIO)
                : undefined,
              ...(isAstraHarnessProfile(resolvedSubModel.modelHarnessProfileId)
                ? { promptCacheTtl: '30m' }
                : {}),
            }
          ),
        },
      }
    }
    // ---- Resilience (lean port of main-loop streamOnce/while). ----
    const taskInput = args.task
    const history: ModelMessage[] = (args.replayHistory ?? []).map((message) => ({
      role: message.role,
      content: message.content,
    }))
    let messages: ModelMessage[] = [...history, { role: 'user', content: taskInput }]
    let text = '' // Consolidated previous-attempt text (partials already fed back as context).
    let attemptText = '' // Current-attempt text.
    let produced = false // Did the attempt produce text OR a tool call? Continuation gate.
    let nonReplayableMutation = false // Providers without ledgers must not replay started mutations.
    let retryable = false // Truncation from transient error → backoff before reinvoking.
    let steps = 0
    let continues = 0
    let totalContinues = 0
    let totalSteps = 0
    let attempt = 0
    let retryDelayMs = 0
    let canRetry = SUB_MAX_CONTINUE > 0
    const emitText = createSubagentTextEmitter(args.onTextUpdate)

    const streamAttempt = async (): Promise<'finished' | 'truncated'> => {
      attempt++
      attemptText = ''
      produced = false
      nonReplayableMutation = false
      retryable = false
      retryDelayMs = 0
      steps = 0
      const attemptUsage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
      let finished = false
      const retryTransient = (error: unknown): boolean => {
        const decision = classifyStreamRetry(error)
        if (!decision.retryable) {
          if (decision.reason === 'quota') {
            chatDiag({
              kind: 'retry-quota-terminal',
              runtime: 'byok-ai-sdk',
              provider: usedModel.providerId,
              model: usedModel.modelId,
              agent: args.agentName,
              attempt,
            })
          }
          return false
        }
        if (
          shouldBlockHighUsageRetry({
            steps,
            totalInput: attemptUsage.totalInput,
            contextWindow: subMeta?.contextWindow,
          })
        ) {
          chatDiag({
            kind: 'retry-high-usage-blocked',
            runtime: 'byok-ai-sdk',
            provider: usedModel.providerId,
            model: usedModel.modelId,
            agent: args.agentName,
            attempt,
            steps,
            totalInput: attemptUsage.totalInput,
            contextWindow: subMeta?.contextWindow,
          })
          return false
        }
        retryable = true
        retryDelayMs = decision.delayMs
        chatDiag({
          kind: 'retry-scheduled',
          runtime: 'byok-ai-sdk',
          provider: usedModel.providerId,
          model: usedModel.modelId,
          agent: args.agentName,
          attempt,
          delayMs: retryDelayMs,
        })
        return true
      }
      try {
        const requestMessages =
          resolvedSubModel.transport === 'anthropic' ? withAnthropicCacheControl(messages) : messages
        const result = streamText({
          model: subStreamModel,
          system: subSystem,
          messages: requestMessages,
          tools,
          // No step cap (July 2026 decision): stop only when the model
          // finishes without tool calls; turn abort (Stop) cuts the stream.
          stopWhen: () => false,
          maxRetries: AI_SDK_MAX_RETRIES,
          abortSignal: args.signal,
          ...(subMaxOutputTokens ? { maxOutputTokens: subMaxOutputTokens } : {}),
          ...(subProviderOptions ? { providerOptions: subProviderOptions } : {}),
        })
        for await (const part of result.fullStream) {
          // ABORT GUARD: AI SDK does not cut an in-flight tool execute and may not interrupt subagent
          // streams at step boundaries → otherwise for-await drains the entire stream and the subagent
          // "finishes" after the user stopped the turn. Exiting here actually aborts.
          if (args.signal.aborted) throw new Error('Subagent aborted')
          if (subLifecycle) {
            try {
              subLifecycle = advanceOpenAICompactionLifecycle(subLifecycle, part as OpenAIStreamEventLike)
            } catch (error) {
              chatDiag({
                kind: 'openai-subagent-ledger-capture-error',
                model: usedModel.modelId,
                agent: args.agentName,
                error: errMessage(error),
              })
            }
          }
          switch (part.type) {
            case 'text-delta':
              attemptText += part.text
              emitText(text + attemptText)
              produced = true
              break
            case 'tool-call':
              produced = true
              if (isNonReplayableSubagentMutation(subLifecycle != null, part.toolName, args.tools))
                nonReplayableMutation = true
              args.progress?.(`Subagent ${args.agentName} called ${part.toolName}${shortJson(part.input)}`)
              break
            case 'tool-result':
              args.progress?.(`Subagent ${args.agentName} completed ${part.toolName ?? 'tool'}`)
              break
            case 'tool-error':
              args.progress?.(`Subagent ${args.agentName} tool error: ${errMessage(part.error)}`)
              break
            case 'finish-step':
              steps++
              totalSteps++
              addNormalizedUsage(usage, part.usage)
              addNormalizedUsage(attemptUsage, part.usage)
              recordModelCallUsage({
                runtime: 'byok-ai-sdk',
                providerId: usedModel.providerId,
                modelId: usedModel.modelId,
                conversationId: args.conversationId,
                agent: args.agentName,
                attempt,
                step: totalSteps,
                usage: normalizeAiUsage(part.usage),
              })
              break
            case 'finish': {
              reconcileNormalizedUsage(usage, attemptUsage, part.totalUsage)
              const finish = part as { finishReason?: unknown; rawFinishReason?: unknown }
              const reason = normalizeStreamFinishReason(finish.finishReason, finish.rawFinishReason)
              // A graceful but incomplete finish never counts as success; outer loop decides whether continuation is possible.
              if (isCutStreamFinish(reason, finish.rawFinishReason)) {
                if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
                return 'truncated'
              }
              finished = true
              break
            }
            case 'error':
              // Transient mid-stream error with retry budget → continue with backoff; fatal → propagate.
              if (canRetry && retryTransient(part.error)) {
                produced = true
                if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
                return 'truncated'
              }
              throw Object.assign(new Error(errMessage(part.error)), { maestrlyRetryClassified: true })
            case 'abort':
              throw new Error(part.reason || 'Subagent aborted')
            case 'custom':
              if (isOpenAINativeCompactionPart(part)) produced = true
              break
            default:
              break
          }
        }
      } catch (e) {
        if (args.signal.aborted) {
          if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
          throw e
        }
        // THROWN retryable error (connection reset etc., rather than error part) → same continuation.
        const classified = Boolean((e as { maestrlyRetryClassified?: unknown })?.maestrlyRetryClassified)
        if (!classified && canRetry && retryTransient(e)) {
          produced = true
          if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
          return 'truncated'
        }
        if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
        throw e
      }
      // Stream ended without 'finish' = abrupt cut (connection died without finish chunk) → truncated.
      if (finished) {
        if (subLifecycle) subLifecycle = commitOpenAICompactionLifecycle(subLifecycle)
        return 'finished'
      }
      if (subLifecycle) subLifecycle = rollbackOpenAICompactionLifecycle(subLifecycle)
      return 'truncated'
    }

    args.progress?.(`Starting subagent ${args.agentName}`)
    let outcome = await streamAttempt()
    while (
      outcome === 'truncated' &&
      produced &&
      !nonReplayableMutation &&
      continues < SUB_MAX_CONTINUE &&
      totalContinues < SUB_MAX_TOTAL_CONTINUES &&
      !args.signal.aborted
    ) {
      continues++
      totalContinues++
      canRetry = continues < SUB_MAX_CONTINUE && totalContinues < SUB_MAX_TOTAL_CONTINUES
      // Overloaded/rate-limited provider: immediate reinvocation likely fails again — short backoff.
      if (retryable) await delay(retryDelayMs, undefined, { signal: args.signal })
      if (args.signal.aborted) throw new Error('Subagent aborted')
      // OpenAI ledger preserves native calls/results; other providers continue from partial text.
      const completedAttemptText = attemptText
      if (completedAttemptText) {
        text += completedAttemptText
        attemptText = ''
      }
      if (subLifecycle) {
        const prepared = prepareOpenAISubagentRetryLedger(
          subLifecycle.working,
          {
            conversationId: args.conversationId,
            messageId: args.parentMessageId,
            callIdPrefix: toolCallIdPrefix,
          },
          executionStore
        )
        subLifecycle = { ...subLifecycle, working: prepared.ledger }
        if (prepared.recovered.length > 0) {
          chatDiag({
            kind: 'openai-subagent-tool-execution-recovered',
            model: usedModel.modelId,
            agent: args.agentName,
            calls: prepared.recovered,
          })
        }
        const replay = prepared.replay
        if (canReplayOpenAILedger(replay)) {
          messages = [...history, { role: 'user', content: taskInput }, ...replay.messages]
        } else {
          nonReplayableMutation = hasSubagentMutationInLedger(subLifecycle.working, args.tools)
          if (!nonReplayableMutation) {
            messages = [
              ...history,
              { role: 'user', content: taskInput },
              ...(text ? ([{ role: 'assistant', content: text }] as ModelMessage[]) : []),
            ]
          }
          chatDiag({
            kind: 'openai-subagent-ledger-replay-fallback',
            model: usedModel.modelId,
            agent: args.agentName,
            codes: replay.issues.map((issue) => issue.code),
            retrySkipped: nonReplayableMutation,
          })
          if (nonReplayableMutation) break
        }
      } else if (completedAttemptText) {
        messages.push({ role: 'assistant', content: completedAttemptText })
      }
      args.progress?.(`Retrying after interruption (${totalContinues}/${SUB_MAX_TOTAL_CONTINUES})…`)
      outcome = await streamAttempt()
      // PRODUCTIVE continuation rearms budget (legitimate long task); immediate failure does not (failure burst).
      if (steps >= SUB_PROGRESS_RESET_STEPS) continues = 0
    }
    if (args.signal.aborted) throw new Error('Subagent aborted')
    if (subReplayPolicy) {
      chatDiag({
        kind: 'interleaved-replay-stats',
        path: 'subagent',
        provider: usedModel.providerId,
        model: usedModel.modelId,
        agent: args.agentName,
        normalizedSteps: subReplayStats.normalizedSteps,
        emptyFallbacks: subReplayStats.emptyFallbacks,
      })
    }
    const finalText = (text + attemptText).trim()
    if (outcome === 'finished') return { text: finalText || '(the subagent returned no text)', usage, model: usedModel }
    if (nonReplayableMutation) {
      const interruption = 'Subagent stream was interrupted after a mutating tool call; automatic retry was skipped.'
      return finalText
        ? { text: `${finalText}\n\n(${interruption})`, usage, model: usedModel }
        : { text: '', error: interruption, usage, model: usedModel }
    }
    // Continuation exhausted: return annotated partial text if present (useful despite incompleteness); otherwise honest failure.
    if (finalText)
      return { text: finalText + '\n\n(subagent stream was interrupted before finishing)', usage, model: usedModel }
    return { text: '', error: 'Subagent stream was interrupted before completing.', usage, model: usedModel }
  } catch (e) {
    // Turn abort: propagate accumulated usage so caller can persist before folding `aborted`.
    if (args.signal.aborted) {
      throw Object.assign(new Error(errMessage(e)), { subagentUsage: usage, subagentModel: usedModel })
    }
    // FINAL failure (nonretryable or exhausted retries) → typed: `task` throws and part becomes
    // 'error'. Return usage even on failure (attempts still consumed tokens).
    return {
      text: '',
      error: errMessage(e),
      ...(usage.totalInput || usage.output ? { usage, model: usedModel } : {}),
    }
  }
}
