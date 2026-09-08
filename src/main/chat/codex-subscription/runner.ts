import { createHash, randomUUID } from 'node:crypto'
import { asSchema } from '@ai-sdk/provider-utils'
import { jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import type {
  ChatMessage,
  ChatModelRef,
  ChatPermMode,
  ChatQuestion,
  ChatSubagentUsage,
  ChatStreamEvent,
  ChatUsage,
  ToolOutput,
  SubagentRunMeta,
  SubagentRuntimeHandle,
} from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import { applyChatEvent, MAESTRLY_ULTRA_EFFORT } from '../../../shared/chat'
import { responseDurationMs } from '../../../shared/response-duration'
import { getAppFlag, getConvUiPrefs } from '../../store'
import { stagePlan } from '../../plan-broker'
import { buildAppTools, buildMcpTools } from '../mcp'
import { describeEphemeralToolImage, hasConfiguredImageInterpreter } from '../image-interpreter'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
import { adaptToolSetForModel, supportsChatToolImages } from '../tool-capabilities'
import {
  chatToolOutputToAiSdkOutput,
  codexContentItemsToChatToolOutput,
  modelOutputToChatToolOutput,
  stripToolOutputMetadata,
  toolOutputAsText,
  toolOutputIsError,
  toolOutputToCodexContentItems,
  type CodexToolContentItem,
} from '../tool-output'
import { chatDiag } from '../diag-log'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import {
  clipPersistedToolOutput,
  droppedImageText,
  nativeSeedContextText,
  renderNativeSeedTranscript,
  renderTranscript,
} from '../message'
import { estimateTextTokens, portableContextLoad } from '../portable-context'
import type { PermissionBroker } from '../permission'
import { buildProjectContext } from '../project-context'
import type { QuestionBroker } from '../question-broker'
import { renderSkillContext, skillCatalogLine, type ChatSkill } from '../skills'
import { effectiveSkills, findEffectiveSkill } from '../skill-state'
import type { ChatAgent } from '../agents'
import { listEffectiveAgents } from '../virtual-subagents'
import { buildAndRenderSubagentDispatchCatalog } from '../subagent-dispatch-catalog'
import { resolveSubagentExecutionProfile } from '../subagent-execution-profile'
import { getSubagentProfileModelMeta } from '../subagent-profile-model-meta'
import {
  assertSubagentSelection,
  createExplicitSubagentTurnState,
  recordSubagentDispatch,
} from '../subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from '../subagent-turn-request'
import {
  namespaceSubagentToolCallId,
  namespaceSubagentToolSet,
  runSubagent,
  type NormalizedAiUsage,
} from '../subagent-runner'
import { SubagentCoordinator, type SubagentLease } from '../subagent-coordinator'
import { createSubagentSessionRecorder } from '../subagent-session'
import {
  MAESTRO_DELEGATE_TOOL_DESCRIPTION,
  MAESTRO_DELEGATE_TOOL_SCHEMA,
  maestroAgentsFromTurn,
  prepareMaestroDelegation,
  renderMaestroAgentCatalog,
} from '../maestro-delegation'
import { MAESTRO_SYSTEM_SPEC, renderMaestroTurnPolicy } from '../maestro-prompt'
import type { MaestroLiveRunPort } from '../maestro-live'
import { buildSubagentSupervisionTools } from '../maestro-supervision-tools'
import {
  markDelegationObserved,
  startMaestroDelegation,
  unobservedTurnDelegations,
  waitForTurnDelegationsTerminal,
} from '../maestro-delegation-registry'
import {
  buildMaestroWorkerTools,
  isMaestroWorkerOperationalToolName,
  type MaestroWorkerToolRuntime,
} from '../maestro-worker-tools'
import { recordModelCallUsage } from '../usage-diagnostics'
import { renderDesignModePrompt, renderDesignUltraGuidance } from '../design-mode-prompt'
import {
  getProvider,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  subscriptionAccountId,
} from '../catalog'
import { getClaudeSubscriptionManager } from '../claude-agent-sdk/manager'
import { queueClaudeSessionCleanup } from '../claude-agent-sdk/session-store'
import { runClaudeSubagent } from '../claude-agent-sdk/subagent-runner'
import {
  claudeSubagentRuntimeSignature,
  planSubagentResume,
  recreatedTask,
  resolveSubagentResume,
  subagentToolSignature,
  type SubagentReplayMessage,
  type SubagentResumeRecreateReason,
  type SubagentResumeSource,
} from '../subagent-resume'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile } from '../fable/profile'
import { getGitHubCopilotSubscriptionManager } from '../github-copilot/manager'
import { runGitHubCopilotSubagent } from '../github-copilot/subagent-runner'
import { copilotTools } from '../github-copilot/tools'
import { bashPermissionSavePattern, commandSegments } from '../tools/bash'
import { buildTools, isSubagentReadOnly, REVIEWER_READONLY_TOOL_NAMES, selectSubagentToolNames } from '../tools'
import type { GeneratedImageEmission, GeneratedImageUsage, ReviewerToolRuntime, ToolContext } from '../tools/util'
import { reviewPlanTool } from '../tools/review-plan'
import { createDeltaCoalescer } from '../delta-coalescer'
import { runnerContextHistory, upsertChatMessage } from '../chat-store'
import { deleteGeneratedImages, saveGeneratedImage, type StoredGeneratedImage } from '../generated-images'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  GENERATE_IMAGE_TOOL_NAME,
  normalizeGeneratedImageUsage,
} from '../image-gen'
import type { CodexAppServerClient } from './client'
import { generateImageForConversation } from './image-generation'
import { getCodexSubscriptionManager, type CodexSubscriptionModel } from './manager'
import {
  astraDeveloperInstructions,
  buildAstraCodexThreadProfile,
  type AstraCodexThreadProfile,
} from './astra-runtime-profile'
import {
  serializableReasoningEffortForProfile,
  type ModelHarnessProfileId,
} from '../model-harness-profile'
import { nativeSubagentSuppressionConfig } from './model-catalog-override'
import {
  dynamicToolRegistrations,
  type DynamicToolFunctionSpec,
  type DynamicToolRegistrationSpec,
} from './dynamic-tools'
import {
  codexTextInput,
  type CodexCollaborationMode,
  type CodexNotification,
  type CodexSandboxPolicy,
  type CodexServerRequest,
  type CodexUserInput,
} from './protocol'
import {
  classifyCodexQuotaFailure,
  classifyCodexQuotaFailureWithRateLimits,
  extractTurnCompletedError,
  type CodexQuotaClassification,
} from './quota-error'
import {
  freezeFailoverChain,
  getSubscriptionFailoverRouter,
  resolveCodexRuntimeTarget,
  type MarkExhaustedInfo,
  type CodexRuntimeResolutionFailureReason,
} from '../subscription-failover'
import {
  clearCodexThreadCleanup,
  getCodexThreadBinding,
  markCodexThreadCleanupFailed,
  putCodexThreadBinding,
  queueCodexThreadCleanup,
  retireCodexThreadBinding,
  type CodexThreadBinding,
  type CodexUsageTotals,
} from './thread-store'
import {
  CodexSubagentQuotaError,
  runCodexSubagent,
  sameCodexDynamicToolCheckpoint,
  type CodexDynamicToolCheckpoint,
  type CodexSubagentCheckpoint,
} from './subagent-runner'

export type DynamicToolSpec = DynamicToolFunctionSpec
export { dynamicToolRegistrations } from './dynamic-tools'

export interface DynamicToolRuntime {
  spec: DynamicToolSpec
  execute: (
    input: unknown,
    toolCallId: string,
    signal: AbortSignal,
    update: (state: { output?: string; sub?: SubagentRunMeta }) => void
  ) => Promise<string | DynamicToolExecutionResult>
}

export interface DynamicToolCatalogProfile {
  total: number
  eager: number
  deferred: number
  serializedBytes: number
  schemaBytes: number
  descriptionBytes: number
  largestDescriptionBytes: number
}

interface DynamicToolExecutionResult {
  output: string
  error?: string
  sub?: SubagentRunMeta
  toolOutput?: import('../../../shared/chat').ToolOutput
  contentItems?: CodexToolContentItem[]
}

interface TokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface TokenUsageNotification {
  threadId: string
  turnId: string
  tokenUsage: {
    total: TokenBreakdown
    last: TokenBreakdown
    modelContextWindow: number | null
  }
}

interface TurnCompletedParams {
  threadId: string
  turn: {
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    error?: { message?: string } | null
  }
}

interface SubagentUsageState {
  baseline: CodexUsageTotals
  latest: CodexUsageTotals
  modelId: string | null
}

export interface CodexFailoverRuntimeTarget {
  providerId: string
  accountId: string | null
  client: CodexAppServerClient
  model: Pick<CodexSubscriptionModel, 'id' | 'model'> & Partial<CodexSubscriptionModel>
  runtimeModelId: string
  reasoningEffort?: string
  serviceTier: string | null
  dropImages: boolean
  /** Physical runtime context window, when the account catalog knows it. */
  contextWindow?: number | null
  /** Nominal context window requested from this physical runtime, when configurable. */
  requestedContextWindow?: number | null
  /** Conservative effective window used by the host for this target's requested nominal configuration. */
  effectiveContextWindow?: number | null
  availabilityLease?: { leaseId: string; generation: number }
  manager?: {
    observeModelContextWindow(modelId: string, value: number, requestedNominal?: number | null): void
    getStatusSnapshot?(): { account?: { type?: string } | null } | null
  }
}

export interface CodexFailoverResolutionFailure {
  reason: CodexRuntimeResolutionFailureReason
  message: string
  resetsAt?: number | null
}

export interface RunCodexSubscriptionChatArgs {
  conversationId: string
  projectId: string
  cwd: string
  /** Logical model ref (providerId + modelId). Remains stable across account failover. */
  selection: ChatModelRef
  /** Optional explicit logical selection; when absent, `selection` is treated as logical. */
  logicalSelection?: ChatModelRef
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort
  permMode: ChatPermMode
  reasoningEffort?: string
  /** Effective Fast Mode of this parent turn, resolved by the service before entering the runner. */
  fastMode: boolean
  /** Synthetic Maestrly mode; `reasoningEffort` is already translated to an app-server-supported value. */
  maestrlyUltra?: boolean
  serviceTier?: string | null
  /** The selected model does not accept images: send the attachment as TEXT (interpreter description or note). */
  dropImages?: boolean
  /** Initial physical account for the root thread (binding owner). */
  initialAccountId?: string | null
  /** Effective physical provider for the first attempt (may differ from logical selection). */
  effectiveProviderId?: string
  /** Frozen failover chain (primary first). Absent/length 1 → failover disabled. */
  failoverChain?: readonly string[]
  /** Half-open probe lease for the initial attempt, if any. */
  availabilityLease?: { leaseId: string; generation: number }
  client: CodexAppServerClient
  /** Exact model/list entry used for capability-gated Astra behavior. */
  runtimeModel?: CodexSubscriptionModel | null
  /** Experimental context is a ChatGPT-session capability, never an API-key/ephemeral assumption. */
  eligibleChatGptSession?: boolean
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
  /** User-perceived start time, including automatic compaction and service preparation. */
  responseStartedAt?: number
  /** Register the thread before its SQLite binding; false means teardown won the race. */
  onThreadReady?: (threadId: string, meta?: { providerId?: string; accountId?: string | null }) => boolean
  /** Gate checked immediately before persisting/renewing the native binding. */
  canPersistThread?: () => boolean
  /** Learn the runtime-reported effective window to update metadata/meter without hardcoding. */
  onModelContextWindow?: (contextWindow: number, requestedNominal?: number | null) => void
  /** Effective window used by the host to anticipate portable compaction during the turn. */
  contextWindow?: number
  /** Nominal window requested from the runtime when the catalog advertises configurability. */
  requestedContextWindow?: number | null
  /** Summarize persisted Maestrly history and return the new portable boundary. */
  compactHistory?: () => Promise<{
    summary: string
    usage?: NormalizedAiUsage
    runtimeEstimatedCostUsd?: number
  } | null>
  /** Isolated review loop: do not resume the conversation binding; transcript = execution. */
  ephemeralSession?: boolean
  messageMeta?: {
    source?: import('../../../shared/chat').ChatMessageSource
    internal?: boolean
    executionScope?: import('../../../shared/chat').ChatExecutionScope
    reviewLoop?: import('../../../shared/chat').ChatReviewLoopMeta
  }
  executionScope?: import('../../../shared/chat').ChatExecutionScope
  /** Isolated review turns receive only the fixed host-owned read-only surface. */
  reviewerRuntime?: ReviewerToolRuntime
  /** Resolve the next physical Codex target after a confirmed quota failure. */
  resolveNextTarget?: (
    failure: {
      error: unknown
      classification: CodexQuotaClassification
      usage?: ChatUsage
    },
    attempted: ReadonlySet<string>
  ) => Promise<CodexFailoverRuntimeTarget | CodexFailoverResolutionFailure | null>
  onEffectiveTargetChanged?: (target: {
    providerId: string
    accountId: string | null
    contextWindow?: number | null
    requestedContextWindow?: number | null
  }) => void
  /** Acquire a physical provider lease for a concurrent subagent attempt (ActiveRun refcount). */
  acquirePhysicalProvider?: (providerId: string) => void
  /** Release a physical provider lease after a subagent attempt settles. */
  releasePhysicalProvider?: (providerId: string) => void
  onFailoverTransition?: (info: {
    scope: 'root' | 'subagent'
    fromProviderId: string
    toProviderId: string
    reason: string
    resetsAt?: number | null
  }) => void
  /** Active-turn controls are valid only until the runner publishes null or replaces the port. */
  onTurnControl?: (control: CodexActiveTurnControlPort | null) => void
}

export interface CodexActiveTurnControlPort {
  harnessProfile: ModelHarnessProfileId
  midTurnSteering: boolean
  liveReasoningUpdate: boolean
  steer(text: string, clientUserMessageId: string): Promise<'accepted' | 'target-unavailable'>
  updateReasoning(effort: string): Promise<'applied' | 'target-unavailable' | 'invalid-effort'>
}

export interface RunCodexSubscriptionChatResult {
  planSubmitted: boolean
  threadId: string
}

const EMPTY_USAGE: CodexUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

const EMPTY_NORMALIZED_USAGE = (): NormalizedAiUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  totalInput: 0,
})

function addNormalizedSubagentUsage(target: NormalizedAiUsage, next?: NormalizedAiUsage): NormalizedAiUsage {
  if (!next) return target
  target.input += next.input
  target.output += next.output
  target.cacheRead += next.cacheRead
  target.cacheCreate += next.cacheCreate
  target.totalInput += next.totalInput
  return target
}

function mergeSubagentCheckpoints(
  previous: CodexSubagentCheckpoint | undefined,
  next: CodexSubagentCheckpoint | undefined
): CodexSubagentCheckpoint | undefined {
  if (!previous && !next) return undefined
  const merge = (a?: string[], b?: string[]): string[] | undefined => {
    const out = [...(a ?? []), ...(b ?? [])].map((entry) => entry.trim()).filter(Boolean)
    const unique = [...new Set(out)].slice(0, 40)
    return unique.length ? unique : undefined
  }
  const mergeDynamicTools = (
    a?: CodexDynamicToolCheckpoint[],
    b?: CodexDynamicToolCheckpoint[]
  ): CodexDynamicToolCheckpoint[] | undefined => {
    const out: CodexDynamicToolCheckpoint[] = []
    for (const entry of [...(a ?? []), ...(b ?? [])]) {
      if (!entry?.tool || out.some((existing) => sameCodexDynamicToolCheckpoint(existing, entry))) continue
      if (out.length >= 40) break
      out.push(entry)
    }
    return out.length ? out : undefined
  }
  const checkpoint: CodexSubagentCheckpoint = {}
  const commands = merge(previous?.commands, next?.commands)
  const statusLines = merge(previous?.statusLines, next?.statusLines)
  const filesChanged = merge(previous?.filesChanged, next?.filesChanged)
  const completedDynamicTools = mergeDynamicTools(previous?.completedDynamicTools, next?.completedDynamicTools)
  const inFlightDynamicTools = mergeDynamicTools(previous?.inFlightDynamicTools, next?.inFlightDynamicTools)?.filter(
    (entry) => !completedDynamicTools?.some((completed) => sameCodexDynamicToolCheckpoint(completed, entry))
  )
  if (commands) checkpoint.commands = commands
  if (statusLines) checkpoint.statusLines = statusLines
  if (filesChanged) checkpoint.filesChanged = filesChanged
  if (completedDynamicTools) checkpoint.completedDynamicTools = completedDynamicTools
  if (inFlightDynamicTools?.length) checkpoint.inFlightDynamicTools = inFlightDynamicTools
  return checkpoint.commands ||
    checkpoint.statusLines ||
    checkpoint.filesChanged ||
    checkpoint.completedDynamicTools ||
    checkpoint.inFlightDynamicTools
    ? checkpoint
    : undefined
}

function formatDynamicToolCheckpoint(entry: CodexDynamicToolCheckpoint): string {
  const identity = [
    `tool=${entry.tool}`,
    entry.itemId ? `itemId=${entry.itemId}` : '',
    entry.callId ? `callId=${entry.callId}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  return entry.argumentsSummary ? `${identity}; ${entry.argumentsSummary}` : identity
}

function formatSubagentCheckpoint(checkpoint: CodexSubagentCheckpoint): string {
  const sections: string[] = []
  if (checkpoint.commands?.length) sections.push(`Commands already run:\n- ${checkpoint.commands.join('\n- ')}`)
  if (checkpoint.filesChanged?.length) {
    sections.push(`Files already changed:\n- ${checkpoint.filesChanged.join('\n- ')}`)
  }
  if (checkpoint.completedDynamicTools?.length) {
    sections.push(
      `Dynamic tools already completed (same tool may have other calls):\n- ${checkpoint.completedDynamicTools
        .map(formatDynamicToolCheckpoint)
        .join('\n- ')}`
    )
  }
  if (checkpoint.inFlightDynamicTools?.length) {
    sections.push(
      `Dynamic tools with uncertain completion (verify state before repeating side effects; do not assume they completed):\n- ${checkpoint.inFlightDynamicTools
        .map(formatDynamicToolCheckpoint)
        .join('\n- ')}`
    )
  }
  if (checkpoint.statusLines?.length) {
    sections.push(`Progress observed:\n- ${checkpoint.statusLines.join('\n- ')}`)
  }
  return sections.join('\n\n')
}

const CONTINUE_WITH_CHECKPOINT_INSTRUCTION = `IMPORTANT — account failover continuation:
A previous attempt on another Codex subscription account hit a usage/quota limit. Continue the SAME task from the checkpoint below.
1. Inspect the workspace first; do not assume prior state without checking files and command outputs.
2. Do NOT repeat side effects confirmed complete (commands already run, files already changed, or the exact dynamic tool calls listed as completed). For operations with uncertain completion, inspect and verify their state before repeating any side effect; do not assume they completed.
3. Briefly list what was already done, then finish only the remaining work.
4. Return a concise final result for the parent when the task is complete.`

function buildSubagentContinuationPrompt(task: string, checkpoint?: CodexSubagentCheckpoint): string {
  if (!checkpoint) return task
  const formatted = formatSubagentCheckpoint(checkpoint)
  return `${task}\n\n${CONTINUE_WITH_CHECKPOINT_INSTRUCTION}${formatted ? `\n\nCheckpoint:\n${formatted}` : ''}`
}

function failoverAccountLabel(providerId: string): string {
  const provider = getProvider(providerId)
  if (provider?.accountLabel?.trim()) return provider.accountLabel.trim()
  const accountId = subscriptionAccountId(providerId)
  if (accountId) return accountId
  return provider?.name?.trim() || providerId
}

const DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG = {
  'features.default_mode_request_user_input': true,
  // Upstream inherits everything by default. Keep PATH/HOME/etc., but remove KEY/SECRET/TOKEN from shells/tools.
  'shell_environment_policy.ignore_default_excludes': false,
} as const
/**
 * Codex 0.153.4 has no hard-off for auto-compaction. With `body_after_prefix`, it compares this limit directly
 * (without model_info's default 90% clamp). MAX_SAFE_INTEGER crosses `thread/start` JSON without rounding and
 * delays native compaction, giving Maestrly the first chance to compact; the physical model window remains the
 * runtime's final limit. This applies ONLY to the persistent root thread. Ephemeral subagent/imagegen threads lack
 * Maestrly conversation compaction and must retain Codex's native fallback.
 */
export const ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG = {
  model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER,
  model_auto_compact_token_limit_scope: 'body_after_prefix',
} as const
const MIN_AUTO_RESOLUTION_MS = 60_000
const MAX_AUTO_RESOLUTION_MS = 240_000
const CHILD_STOP_TIMEOUT_MS = 15_000
const OWNED_REQUEST_TIMEOUT_MS = 30_000
const IN_TURN_COMPACT_RATIO = 0.9
const MAX_IN_TURN_COMPACTIONS = 2
const PORTABLE_CONTINUE_PROMPT =
  'Continue the same assistant turn from the imported transcript. Do not repeat completed work or prior progress updates.'
export const SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS = 240
export const TASK_TOOL_DESCRIPTION_MAX_BYTES = 512
const ASTRA_EXPERIMENTAL_CONTEXT_UNAVAILABLE = new WeakSet<CodexAppServerClient>()
const TASK_TOOL_DESCRIPTION =
  'Delegate one focused, self-contained task to an isolated Maestrly subagent. The subagent sees only the ' +
  'supplied prompt and returns its result. Include all required context and select the agent from the input enum.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function ownedRequestDeadline(label: string): { promise: Promise<never>; error: Error; cancel: () => void } {
  const error = new Error(`${label} timed out after ${OWNED_REQUEST_TIMEOUT_MS}ms`)
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error), OWNED_REQUEST_TIMEOUT_MS)
    timer.unref()
  })
  void promise.catch(() => {})
  return {
    promise,
    error,
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveContextWindow(value: unknown): number {
  const normalized = Math.floor(Number(value))
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : 0
}

/** Checks the bounded text sent to a fresh Codex thread against Maestrly's shared 90% admission policy. */
function replayFitsContextWindow(transcript: string, pendingText: string, contextWindow: number): boolean {
  if (contextWindow <= 0) return true
  const load = portableContextLoad(
    contextWindow,
    estimateTextTokens(nativeSeedContextText(transcript)),
    estimateTextTokens(pendingText)
  )
  return !load.shouldCompact
}

function nonNegativeDifference(current: number, previous: number): number {
  return Math.max(0, (Number(current) || 0) - (Number(previous) || 0))
}

function usageTotals(value: TokenBreakdown | undefined): CodexUsageTotals {
  if (!value) return { ...EMPTY_USAGE }
  return {
    inputTokens: Math.max(0, Number(value.inputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(value.cachedInputTokens) || 0),
    outputTokens: Math.max(0, Number(value.outputTokens) || 0),
    reasoningOutputTokens: Math.max(0, Number(value.reasoningOutputTokens) || 0),
  }
}

function toChatUsage(notification: TokenUsageNotification | null, baseline: CodexUsageTotals): ChatUsage | undefined {
  if (!notification) return undefined
  const total = notification.tokenUsage.total
  const last = notification.tokenUsage.last
  const input = nonNegativeDifference(total.inputTokens, baseline.inputTokens)
  const cachedInput = nonNegativeDifference(total.cachedInputTokens, baseline.cachedInputTokens)
  const output = nonNegativeDifference(total.outputTokens, baseline.outputTokens)
  const modelContextWindow = Math.floor(Number(notification.tokenUsage.modelContextWindow) || 0)
  return {
    usageVersion: 2,
    input: Math.max(0, input - cachedInput),
    output,
    contextInput: Math.max(0, Number(last.inputTokens) || 0),
    contextOutput: Math.max(0, Number(last.outputTokens) || 0),
    ...(modelContextWindow > 0 ? { modelContextWindow } : {}),
    ...(cachedInput > 0 ? { cachedInput } : {}),
  }
}

function usageBeforeLast(notification: TokenUsageNotification): CodexUsageTotals {
  const total = usageTotals(notification.tokenUsage.total)
  const last = usageTotals(notification.tokenUsage.last)
  return {
    inputTokens: nonNegativeDifference(total.inputTokens, last.inputTokens),
    cachedInputTokens: nonNegativeDifference(total.cachedInputTokens, last.cachedInputTokens),
    outputTokens: nonNegativeDifference(total.outputTokens, last.outputTokens),
    reasoningOutputTokens: nonNegativeDifference(total.reasoningOutputTokens, last.reasoningOutputTokens),
  }
}

function withSubagentUsage(
  main: ChatUsage | undefined,
  states: ReadonlyMap<string, SubagentUsageState>,
  providerId: string,
  external: readonly ChatSubagentUsage[] = []
): ChatUsage | undefined {
  const perModel = new Map<string, ChatSubagentUsage>()
  let subInput = 0
  let subOutput = 0
  let subCachedInput = 0
  let subCacheCreate = 0
  const record = (usage: ChatSubagentUsage): void => {
    subInput += usage.input
    subOutput += usage.output
    subCachedInput += usage.cachedInput ?? 0
    subCacheCreate += usage.cacheCreate ?? 0
    const key = `${usage.providerId}\0${usage.modelId}`
    const current = perModel.get(key)
    if (current) {
      current.input += usage.input
      current.output += usage.output
      current.cachedInput = (current.cachedInput ?? 0) + (usage.cachedInput ?? 0)
      current.cacheCreate = (current.cacheCreate ?? 0) + (usage.cacheCreate ?? 0)
      if (current.runtimeEstimatedCostUsd != null || usage.runtimeEstimatedCostUsd != null) {
        current.runtimeEstimatedCostUsd = (current.runtimeEstimatedCostUsd ?? 0) + (usage.runtimeEstimatedCostUsd ?? 0)
      }
    } else perModel.set(key, { ...usage })
  }
  for (const state of states.values()) {
    const totalInput = nonNegativeDifference(state.latest.inputTokens, state.baseline.inputTokens)
    const cachedInput = nonNegativeDifference(state.latest.cachedInputTokens, state.baseline.cachedInputTokens)
    const input = Math.max(0, totalInput - cachedInput)
    const output = nonNegativeDifference(state.latest.outputTokens, state.baseline.outputTokens)
    if (!input && !cachedInput && !output) continue
    if (state.modelId)
      record({ providerId, modelId: state.modelId, input, output, ...(cachedInput ? { cachedInput } : {}) })
    else {
      subInput += input
      subCachedInput += cachedInput
      subOutput += output
    }
  }
  for (const usage of external) record(usage)
  if (!subInput && !subCachedInput && !subCacheCreate && !subOutput && !perModel.size) return main
  return {
    ...(main ?? { usageVersion: 2, input: 0, output: 0 }),
    subInput,
    subOutput,
    ...(subCachedInput ? { subCachedInput } : {}),
    ...(subCacheCreate ? { subCacheCreate } : {}),
    ...(perModel.size
      ? {
          subagentUsage: [...perModel.values()].sort((a, b) =>
            `${a.providerId}\0${a.modelId}`.localeCompare(`${b.providerId}\0${b.modelId}`)
          ),
        }
      : {}),
  }
}

export function approvalConfig(
  mode: ChatBehavior,
  permMode: ChatPermMode
): {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
} {
  // Read-only behavior modes must not escalate to writes regardless of the permission toggle. With Agent capabilities,
  // the official sandbox is the first gate; escalation requests pass through the broker.
  if (capabilityBehaviorFor(mode) !== 'agent') {
    return { sandbox: 'read-only', approvalPolicy: permMode === 'full' ? 'never' : 'untrusted' }
  }
  if (permMode === 'full') return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  // Native shell is disabled outside Full, routing commands through the Maestrly bridge. `untrusted`
  // remains defense in depth for any other escalation the runtime requests.
  if (permMode === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }
  return { sandbox: 'read-only', approvalPolicy: 'untrusted' }
}

export function sandboxPolicyFor(
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
  cwd: string
): CodexSandboxPolicy {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  return { type: 'readOnly', networkAccess: false }
}

function maestrlySkillCatalog(skills: readonly ChatSkill[]): string {
  if (!skills.length) return ''
  const entries = skills.map((skill) => skillCatalogLine(skill).slice(0, 520)).join('\n')
  return (
    '\n\nMaestrly project skills (specialized capabilities) are available through the `use_skill` dynamic ' +
    'tool:\n' +
    entries +
    '\nWhen the task clearly matches one of these skills, call `use_skill` before acting and follow the returned ' +
    'instructions for this turn.'
  )
}

/**
 * Codex's native prompt strongly favors doing work itself (shell/apply_patch), overwhelming the passive dynamic
 * `task` description: subscription models almost never delegated. BYOK receives a prescriptive # Subagents
 * system-prompt section; developerInstructions is the equivalent here.
 */
function subagentCatalog(agents: readonly ChatAgent[], conversationId: string, forceReadOnly: boolean): string {
  if (!agents.length) return ''
  const catalog = buildAndRenderSubagentDispatchCatalog(
    { agents, conversationId, forceReadOnly },
    { descriptionMaxChars: SUBAGENT_CATALOG_DESCRIPTION_MAX_CHARS }
  )
  return (
    '\n\nMaestrly subagents are available through the dynamic `task` tool (agent="<name>", prompt="<the full ' +
    'task, with ALL context it needs — it does NOT see this conversation>"). Each run is isolated and returns ' +
    'only its result. Use it to (1) offload broad searches or deep investigation that would flood your context ' +
    'with file dumps, and (2) decompose a LARGE task into self-contained slices delegated to worker agents; ' +
    'independent `task` calls may run in parallel. Keep yourself as the orchestrator: delegate, then integrate ' +
    'and verify the results. Skip delegation for trivial work.\n' +
    catalog +
    '\n'
  )
}

export function maestrlyDeveloperInstructions(
  mode: ChatBehavior,
  skills: readonly ChatSkill[],
  agents: readonly ChatAgent[],
  options: { conversationId?: string; maestro?: MaestroTurnSnapshotV1 } = {}
): string {
  const conversationId = options.conversationId ?? ''
  const designPrompt = renderDesignModePrompt(mode)
  const common =
    'You are running inside Maestrly through the official Codex runtime. Keep your native Codex operating ' +
    'instructions and tool discipline. Maestrly renders GitHub-flavored Markdown and fenced `mermaid` diagrams. ' +
    'Dynamic tools supplied by the host are real Maestrly app/MCP tools; use them when relevant. Use the native ' +
    'request_user_input interaction when a decision from the user is genuinely required.' +
    maestrlySkillCatalog(skills) +
    (mode === 'maestro' && options.maestro
      ? `\n\n${renderMaestroAgentCatalog(options.maestro)}`
      : subagentCatalog(agents, conversationId, mode === 'plan' || mode === 'ask')) +
    (mode === 'maestro' && options.maestro ? `\n\n${renderMaestroTurnPolicy(options.maestro)}` : '') +
    `\n\n${MEMORY_TOOL_GUIDANCE}` +
    (designPrompt ? `\n\n${designPrompt}` : '')
  if (mode === 'plan') {
    return (
      common +
      ' This turn is Plan mode: investigate read-only, produce a concrete implementation plan, submit the final ' +
      'plan with the `review_plan` dynamic tool, and stop. Do not modify files or execute mutating commands.'
    )
  }
  if (mode === 'ask') {
    return (
      common +
      ' This turn is Ask mode: investigate with the supplied read-only Maestrly readers when useful and answer ' +
      'from the real project. Do not modify files, run commands, or call mutating app, MCP, or skill tools. You may use ' +
      'request_user_input only when the answer truly requires a decision from the user.'
    )
  }
  if (mode === 'maestro') {
    return common + `\n\n${MAESTRO_SYSTEM_SPEC}`
  }
  if (mode === 'design') {
    return common + ' This turn is Design mode with Agent-equivalent capabilities under the selected permissions.'
  }
  return (
    common + ' This turn is Agent mode: carry the task through to a verified result within the selected permissions.'
  )
}

function maestrlyAstraHostInstructions(
  mode: ChatBehavior,
  skills: readonly ChatSkill[],
  agents: readonly ChatAgent[],
  options: { conversationId: string; maestro?: MaestroTurnSnapshotV1 }
): string {
  const modeBoundary =
    mode === 'plan'
      ? 'Plan mode is read-only: investigate, submit the final plan with review_plan, and stop.'
      : mode === 'ask'
        ? 'Ask mode is read-only unless the user explicitly changes the task.'
        : mode === 'design'
          ? `Design mode has Agent-equivalent capabilities under the selected permissions.\n\n${renderDesignModePrompt(mode)}`
        : mode === 'maestro'
          ? MAESTRO_SYSTEM_SPEC
          : 'Agent mode: carry authorized work through a verified result within the selected permissions.'
  return (
    modeBoundary +
    maestrlySkillCatalog(skills) +
    (mode === 'maestro' && options.maestro
      ? `\n\n${renderMaestroAgentCatalog(options.maestro)}\n\n${renderMaestroTurnPolicy(options.maestro)}`
      : subagentCatalog(agents, options.conversationId, mode === 'plan' || mode === 'ask')) +
    `\n\n${MEMORY_TOOL_GUIDANCE}`
  )
}

/**
 * `collaborationMode` persists in the app-server thread. Explicitly send `default` in other modes so conversations
 * leaving Plan do not retain native planning instructions.
 */
function collaborationModeFor(
  args: RunCodexSubscriptionChatArgs,
  reasoningEffort: string | undefined = args.reasoningEffort
): CodexCollaborationMode {
  const ultraInstructions = args.maestrlyUltra
    ? args.mode === 'maestro'
      ? 'Maestrly Ultra applies only to the orchestrator reasoning profile. Keep all worker selection governed by the frozen Strategy and Agent Pool.'
      : args.mode === 'design'
        ? renderDesignUltraGuidance(args.mode)
        : args.mode === 'agent'
          ? 'Maestrly Ultra mode is active for this turn. Use maximum rigor. For every non-trivial task, actively ' +
            'look for independent slices before starting. When useful independent slices exist, DELEGATE them through ' +
            'the Maestrly `task` tool and emit multiple independent `task` calls in the same response so they run in ' +
            'parallel. Use `explore` for broad investigation and worker agents for self-contained implementation ' +
            'slices. Keep yourself as the orchestrator: integrate the results, verify the implementation, and ' +
            'critically review the outcome before finishing. Delegation is encouraged, not mandatory when there is no ' +
            'meaningful independent slice.'
          : args.mode === 'plan'
            ? 'Maestrly Ultra mode is active for this Plan turn. Stay read-only, investigate deeply, and actively look ' +
              'for independent research lines. When useful, delegate them through the Maestrly `task` tool and emit ' +
              'multiple independent `task` calls in the same response so they run in parallel. Synthesize and ' +
              'cross-check the results into a concrete plan, submit it through review_plan, and stop.'
            : 'Maestrly Ultra mode is active for this Ask turn. Stay read-only, investigate deeply, and actively look ' +
              'for broad or independent investigation lines. When useful, delegate them through the Maestrly `task` ' +
              'tool and emit multiple independent `task` calls in the same response so they run in parallel. ' +
              'Cross-check the findings, verify assumptions, and answer with maximum rigor.'
    : args.mode === 'maestro'
      ? MAESTRO_SYSTEM_SPEC
      : null
  return {
    mode: args.mode === 'plan' ? 'plan' : 'default',
    settings: {
      model: args.selection.modelId,
      reasoning_effort: reasoningEffort && reasoningEffort !== 'off' ? reasoningEffort : null,
      // `null` restores the official preset after a Maestrly Ultra turn; the app-server field is sticky.
      developer_instructions: ultraInstructions,
    },
  }
}

export function mergeDynamicToolSets(
  mcpTools: ToolSet,
  appTools: ToolSet,
  bridgeTools: ToolSet
): { tools: ToolSet; deferredToolNames: Set<string> } {
  // Order also defines dispatch: bridge > app > MCP.
  const tools: ToolSet = { ...mcpTools, ...appTools, ...bridgeTools }
  const deferredToolNames = new Set([...Object.keys(mcpTools), ...Object.keys(appTools)])
  // A same-named bridge is the effective implementation and must remain eager.
  for (const name of Object.keys(bridgeTools)) deferredToolNames.delete(name)
  return { tools, deferredToolNames }
}

export async function toolSetRuntimes(
  tools: ToolSet,
  deferredToolNames: ReadonlySet<string> = new Set()
): Promise<DynamicToolRuntime[]> {
  const out: DynamicToolRuntime[] = []
  for (const [name, rawTool] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
    const aiTool = rawTool as Tool
    if (!aiTool.execute || !aiTool.inputSchema) continue
    const schema = asSchema(aiTool.inputSchema)
    const inputSchema = await schema.jsonSchema
    out.push({
      spec: {
        type: 'function',
        name,
        description: typeof aiTool.description === 'string' ? aiTool.description : `Maestrly tool ${name}.`,
        inputSchema,
        ...(deferredToolNames.has(name) ? { deferLoading: true } : {}),
      },
      execute: async (input, toolCallId, signal) => {
        let parsed = input
        if (schema.validate) {
          const validation = await schema.validate(input)
          if (!validation.success) throw validation.error
          parsed = validation.value
        }
        const result = await (aiTool.execute as (...args: any[]) => unknown)(parsed, {
          toolCallId,
          messages: [],
          abortSignal: signal,
        })
        const canonical = modelOutputToChatToolOutput(result)
        const modelOutput = aiTool.toModelOutput
          ? await (aiTool.toModelOutput as (options: Record<string, unknown>) => unknown)({
              toolCallId,
              input: parsed,
              output: result,
            })
          : result
        const normalized = modelOutputToChatToolOutput(stripToolOutputMetadata(modelOutput))
        if (typeof canonical === 'string' && typeof normalized === 'string') return normalized || '(no output)'
        const modelText = toolOutputAsText(normalized) || '(no output)'
        if (typeof canonical === 'string') return modelText
        const isError = toolOutputIsError(canonical)
        return {
          output: modelText,
          toolOutput: canonical,
          contentItems: toolOutputToCodexContentItems(normalized),
          ...(isError ? { error: toolOutputAsText(canonical) || 'Tool failed' } : {}),
        }
      },
    })
  }
  return out
}

export function profileDynamicTools(specs: readonly DynamicToolSpec[]): DynamicToolCatalogProfile {
  const registrations = dynamicToolRegistrations(specs)
  let deferred = 0
  let schemaBytes = 0
  let descriptionBytes = 0
  let largestDescriptionBytes = 0
  for (const spec of specs) {
    if (spec.deferLoading === true) deferred += 1
    schemaBytes += Buffer.byteLength(JSON.stringify(spec.inputSchema), 'utf8')
    const currentDescriptionBytes = Buffer.byteLength(spec.description, 'utf8')
    descriptionBytes += currentDescriptionBytes
    largestDescriptionBytes = Math.max(largestDescriptionBytes, currentDescriptionBytes)
  }
  return {
    total: specs.length,
    eager: specs.length - deferred,
    deferred,
    serializedBytes: Buffer.byteLength(JSON.stringify(registrations), 'utf8'),
    schemaBytes,
    descriptionBytes,
    largestDescriptionBytes,
  }
}

/**
 * Signature uses sorted NAMES, not full specs: MCP description/inputSchema changes on reconnection would
 * needlessly invalidate server-side threads (costly retirement + reseeding). The tool LIST must still invalidate:
 * thread/resume rejects dynamicTools, so tools cannot be reregistered on an existing thread.
 */
export function dynamicToolSignature(specs: Pick<DynamicToolSpec, 'name'>[]): string {
  const names = specs.map((spec) => spec.name).sort()
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

function currentUserInputs(message: ChatMessage, seedTranscript: string, dropImages = false): CodexUserInput[] {
  const inputs: CodexUserInput[] = []
  const text: string[] = []
  if (seedTranscript) text.push(nativeSeedContextText(seedTranscript))
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) text.push(part.text)
    // `/skill` invocation: send the expanded block (instructions + root + inventory) to the model instead of the chip.
    if (part.type === 'skill-invocation' && part.body) text.push(part.body)
    if (part.type !== 'file') continue
    if (part.kind === 'image') {
      if (dropImages) text.push(droppedImageText(part))
      else {
        const image = resolveFileImageBytesSync(message.conversationId, part)
        if (image) {
          const base64 = Buffer.from(image.bytes).toString('base64')
          inputs.push({ type: 'image', url: `data:${image.mediaType};base64,${base64}`, detail: 'auto' })
        } else {
          text.push(`[Image attachment ${part.name} could not be decoded by the host.]`)
        }
      }
    } else {
      const label = part.hidden ? `Content referenced by ${part.name}` : `Attached file ${part.name}`
      text.push(`${label}:\n\n${part.data}`)
    }
  }
  if (text.length) inputs.unshift(codexTextInput(text.join('\n\n')))
  return inputs
}

function itemTool(item: Record<string, unknown>): { name: string; input: unknown } | null {
  const type = item.type
  if (type === 'commandExecution') return { name: 'bash', input: { command: item.command, cwd: item.cwd } }
  if (type === 'fileChange') return { name: 'edit', input: { changes: item.changes } }
  if (type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'mcp'
    const tool = typeof item.tool === 'string' ? item.tool : 'tool'
    return { name: `${server}__${tool}`, input: item.arguments ?? {} }
  }
  if (type === 'dynamicToolCall') {
    return { name: typeof item.tool === 'string' ? item.tool : 'tool', input: item.arguments ?? {} }
  }
  if (type === 'collabAgentToolCall') {
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : []
    const agent = (typeof item.model === 'string' && item.model) || receivers[0] || 'codex-subagent'
    const operation = typeof item.tool === 'string' ? item.tool : 'collabAgent'
    const prompt =
      (typeof item.prompt === 'string' && item.prompt.trim()) ||
      `${operation} ${receivers.length ? receivers.join(', ') : 'Codex subagent'}`
    return { name: 'task', input: { agent, prompt, operation, receiverThreadIds: receivers } }
  }
  if (type === 'webSearch') return { name: 'web_search', input: item }
  if (type === 'imageView') return { name: 'view_image', input: { path: item.path } }
  if (type === 'imageGeneration') return { name: 'image_generation', input: imageGenerationInput(item) }
  return null
}

/**
 * `image_generation` card input WITHOUT `result`: that field contains the entire base64 image (MBs), and tool
 * input is persisted in `parts_json`. Bytes go to the artifact store (generated-images.ts).
 */
function imageGenerationInput(item: Record<string, unknown>): Record<string, unknown> {
  const { result: _result, ...rest } = item
  return rest
}

/** Generated-image card text. Never includes base64; the image has its own part. */
function imageGenerationOutput(item: Record<string, unknown>): string {
  const revised = typeof item.revisedPrompt === 'string' ? item.revisedPrompt.trim() : ''
  const saved = typeof item.savedPath === 'string' ? item.savedPath.trim() : ''
  return [
    'Image generated.',
    revised ? `Revised prompt: ${revised}` : '',
    saved ? `Saved by the runtime at: ${saved}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function itemOutput(item: Record<string, unknown>, progress: string): { success: boolean; output: ToolOutput } {
  if (item.type === 'commandExecution') {
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : progress
    const suffix = item.exitCode == null ? '' : `\n\n(exit code ${String(item.exitCode)})`
    return { success: item.status === 'completed', output: (output || '(no output)') + suffix }
  }
  if (item.type === 'fileChange') {
    return { success: item.status === 'completed', output: textOf(item.changes) || '(file changes applied)' }
  }
  if (item.type === 'mcpToolCall') {
    const error = isRecord(item.error) ? textOf(item.error.message ?? item.error) : textOf(item.error)
    if (isRecord(item.result) && Array.isArray(item.result.contentItems)) {
      return {
        success: item.status !== 'failed',
        output: codexContentItemsToChatToolOutput(item.result.contentItems, item.status === 'failed'),
      }
    }
    return item.status === 'failed'
      ? { success: false, output: error || 'MCP tool failed' }
      : { success: true, output: textOf(item.result) || '(no output)' }
  }
  if (item.type === 'dynamicToolCall') {
    return {
      success: item.success !== false,
      output: codexContentItemsToChatToolOutput(item.contentItems, item.success === false),
    }
  }
  if (item.type === 'collabAgentToolCall') {
    const states = isRecord(item.agentsStates) ? Object.values(item.agentsStates).filter(isRecord) : []
    const messages = states
      .map((state) => (typeof state.message === 'string' ? state.message.trim() : ''))
      .filter(Boolean)
    const status = typeof item.status === 'string' ? item.status : 'completed'
    const operation = typeof item.tool === 'string' ? item.tool : 'collabAgent'
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : []
    const target = receivers.length ? receivers.join(', ') : 'subagent'
    const fallback =
      operation === 'spawnAgent'
        ? `Subagent started: ${target}`
        : operation === 'sendInput'
          ? `Input sent to ${target}`
          : operation === 'resumeAgent'
            ? `Subagent resumed: ${target}`
            : operation === 'closeAgent'
              ? `Subagent closed: ${target}`
              : operation === 'wait'
                ? `Finished waiting for ${target}`
                : `Subagent operation completed: ${operation}`
    return {
      success: status === 'completed',
      output: messages.join('\n\n') || (status === 'completed' ? fallback : `Subagent operation failed: ${operation}`),
    }
  }
  if (item.type === 'imageGeneration') {
    const status = typeof item.status === 'string' ? item.status : 'completed'
    // The generic fallback below would serialize the item WITH base64, hence the explicit case here.
    return status === 'failed' || status === 'error'
      ? { success: false, output: 'Image generation failed.' }
      : { success: true, output: imageGenerationOutput(item) }
  }
  const status = typeof item.status === 'string' ? item.status : 'completed'
  return { success: !['failed', 'declined', 'error'].includes(status), output: textOf(item) || '(completed)' }
}

/** Context-size guard for transient Codex tool responses; image bytes remain in memory only. */
function clipCodexContentItems(items: readonly CodexToolContentItem[]): CodexToolContentItem[] {
  return items.map((item) =>
    item.type === 'inputText' ? { type: 'inputText' as const, text: clipPersistedToolOutput(item.text) } : item
  )
}

interface RequestRoute {
  conversationId: string
  projectId: string
  messageId: string
  /** Only requests from this thread become visible/persisted parts; descendants stay inside their task card. */
  rootThreadId: string
  closed: boolean
  broker: PermissionBroker
  questionBroker: QuestionBroker
  tools: Map<string, DynamicToolRuntime>
  /** Per-child runtime projection; child models may have a different image capability than the parent. */
  threadTools: Map<string, Map<string, DynamicToolRuntime>>
  /** Optional task-call namespace for events and broker records emitted by an isolated child thread. */
  toolCallIdPrefix?: string
  itemResources: Map<string, string[]>
  pendingRequests: Map<string, { threadId: string; controller: AbortController; preserveOnAccountFailover: boolean }>
  emit: (event: ChatStreamEvent, force?: boolean) => void
  signal: AbortSignal
  mode: ChatBehavior
  subagentRuns: Map<string, SubagentRunMeta>
}

const requestRoutes = new WeakMap<CodexAppServerClient, Map<string, RequestRoute>>()
const routedClients = new WeakSet<CodexAppServerClient>()

function serverRequestKey(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? `${typeof value}:${String(value)}` : null
}

function beginPendingServerRequest(
  route: RequestRoute,
  threadId: string,
  requestId: unknown,
  options?: { preserveOnAccountFailover?: boolean }
): { signal: AbortSignal; finish: () => void } {
  const key = serverRequestKey(requestId)
  const controller = new AbortController()
  if (key) {
    route.pendingRequests.get(key)?.controller.abort()
    route.pendingRequests.set(key, {
      threadId,
      controller,
      preserveOnAccountFailover: options?.preserveOnAccountFailover === true,
    })
  }
  const finish = (): void => {
    if (key && route.pendingRequests.get(key)?.controller === controller) route.pendingRequests.delete(key)
  }
  return { signal: AbortSignal.any([route.signal, controller.signal]), finish }
}

function cancelPendingServerRequest(route: RequestRoute, threadId: string, requestId: unknown): void {
  const key = serverRequestKey(requestId)
  if (!key) return
  const pending = route.pendingRequests.get(key)
  if (!pending || pending.threadId !== threadId) return
  route.pendingRequests.delete(key)
  pending.controller.abort()
}

function cancelPendingServerRequests(
  route: RequestRoute,
  threadId?: string,
  options?: { preserveManagedTasks?: boolean }
): void {
  for (const [key, pending] of route.pendingRequests) {
    if (threadId && pending.threadId !== threadId) continue
    if (options?.preserveManagedTasks && pending.preserveOnAccountFailover) continue
    route.pendingRequests.delete(key)
    pending.controller.abort()
  }
}

function autoResolutionMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.floor(value)
  return normalized >= MIN_AUTO_RESOLUTION_MS && normalized <= MAX_AUTO_RESOLUTION_MS ? normalized : null
}

async function waitForQuestionAnswers(
  route: RequestRoute,
  toolCallId: string,
  questions: ChatQuestion[],
  requestedAutoResolutionMs: unknown,
  signal: AbortSignal
): Promise<string[][]> {
  const pending = route.questionBroker.ask({
    conversationId: route.conversationId,
    messageId: route.messageId,
    toolCallId,
    questions,
    signal,
  })
  const resolveEmpty = (): void => route.questionBroker.reply(toolCallId, [])
  const timeoutMs = autoResolutionMs(requestedAutoResolutionMs)
  let timer: NodeJS.Timeout | undefined

  if (timeoutMs !== null) {
    timer = setTimeout(resolveEmpty, timeoutMs)
    timer.unref()
  }
  try {
    return await pending
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function fileSystemPathLabel(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'path' && typeof value.path === 'string') return value.path
  if (value.type === 'glob_pattern' && typeof value.pattern === 'string') return value.pattern
  if (value.type !== 'special' || !isRecord(value.value) || typeof value.value.kind !== 'string') return null
  if (value.value.kind === 'unknown' && typeof value.value.path === 'string') return value.value.path
  const subpath = typeof value.value.subpath === 'string' && value.value.subpath ? `/${value.value.subpath}` : ''
  return `<${value.value.kind}${subpath}>`
}

function resourcesFromPermissions(value: unknown): string[] {
  if (!isRecord(value)) return []
  const out: string[] = []
  if (isRecord(value.fileSystem)) {
    for (const key of ['read', 'write'] as const) {
      const paths = value.fileSystem[key]
      if (Array.isArray(paths)) {
        out.push(...paths.filter((p): p is string => typeof p === 'string').map((path) => `${key}:${path}`))
      }
    }
    if (Array.isArray(value.fileSystem.entries)) {
      for (const rawEntry of value.fileSystem.entries) {
        if (!isRecord(rawEntry)) continue
        const access = typeof rawEntry.access === 'string' ? rawEntry.access : 'access'
        const path = fileSystemPathLabel(rawEntry.path)
        if (path) out.push(`${access}:${path}`)
      }
    }
  }
  if (isRecord(value.network) && value.network.enabled) out.push('network')
  return [...new Set(out)]
}

function approvalTitle(kind: 'command' | 'file' | 'permissions', params: Record<string, unknown>): string {
  const reason = typeof params.reason === 'string' && params.reason.trim() ? ` — ${params.reason.trim()}` : ''
  const cwd = typeof params.cwd === 'string' && params.cwd ? ` — in ${params.cwd}` : ''
  if (kind === 'command') return `Run Codex command${reason}${cwd}`
  if (kind === 'file') return `Apply Codex changes${reason}`
  return `Grant additional Codex permissions${reason}${cwd}`
}

function supportsSessionDecision(value: unknown): boolean {
  return Array.isArray(value) && value.some((decision) => decision === 'acceptForSession')
}

function fileChangeResources(
  route: RequestRoute,
  itemId: string,
  grantRoot: unknown
): {
  resources: string[]
  save?: string[]
} {
  const fromItem = route.itemResources.get(itemId) ?? []
  const root = typeof grantRoot === 'string' && grantRoot.trim() ? grantRoot.trim().replace(/[\\/]+$/, '') : ''
  const resources = fromItem.length ? fromItem : root ? [root] : ['workspace files']
  if (root) return { resources, save: [`${root}/*`] }
  return fromItem.length ? { resources, save: fromItem } : { resources }
}

async function handleServerRequest(client: CodexAppServerClient, request: CodexServerRequest): Promise<unknown> {
  const params = isRecord(request.params) ? request.params : {}
  const threadId = typeof params.threadId === 'string' ? params.threadId : ''
  const route = requestRoutes.get(client)?.get(threadId)
  if (!route) throw new Error(`No active Maestrly turn for Codex thread ${threadId || '(unknown)'}`)
  const itemId = typeof params.itemId === 'string' ? params.itemId : `codex_${String(request.id)}`
  const emit: RequestRoute['emit'] =
    threadId === route.rootThreadId
      ? (event, force) => {
          if (!route.closed) route.emit(event, force)
        }
      : () => {}
  const namespaceToolCallId = (id: string): string =>
    route.toolCallIdPrefix ? namespaceSubagentToolCallId(route.toolCallIdPrefix, id) : id
  const visibleItemId = namespaceToolCallId(itemId)

  if (request.method === 'item/tool/call') {
    const toolName = typeof params.tool === 'string' ? params.tool : ''
    const pendingRequest = beginPendingServerRequest(route, threadId, request.id, {
      // Root delegation requests own a host-managed subagent even though the JSON-RPC request originates on the
      // root thread. Child-thread requests are managed by that same task/delegate lifecycle.
      preserveOnAccountFailover: toolName === 'task' || toolName === 'delegate' || threadId !== route.rootThreadId,
    })
    const callId = typeof params.callId === 'string' ? params.callId : itemId
    const visibleCallId = namespaceToolCallId(callId)
    const runtime = route.threadTools.get(threadId)?.get(toolName) ?? route.tools.get(toolName)
    if (!runtime) throw new Error(`Dynamic tool "${toolName}" is not available in this turn`)
    emit({ kind: 'tool-input-start', messageId: route.messageId, toolCallId: visibleCallId, toolName })
    emit({
      kind: 'tool-call',
      messageId: route.messageId,
      toolCallId: visibleCallId,
      toolName,
      input: params.arguments ?? {},
    })
    let latestSub: SubagentRunMeta | undefined
    emit({ kind: 'tool-state', messageId: route.messageId, toolCallId: visibleCallId, state: { status: 'running' } })
    try {
      const rawResult = await runtime.execute(params.arguments ?? {}, callId, pendingRequest.signal, (state) => {
        if (state.sub) {
          latestSub = state.sub
          route.subagentRuns.set(visibleCallId, state.sub)
          route.subagentRuns.set(visibleItemId, state.sub)
        }
        emit({
          kind: 'tool-state',
          messageId: route.messageId,
          toolCallId: visibleCallId,
          state: {
            status: 'running',
            ...(state.output ? { output: clipPersistedToolOutput(state.output) } : {}),
            ...(state.sub ? { sub: state.sub } : {}),
          },
        })
      })
      const raw: DynamicToolExecutionResult = typeof rawResult === 'string' ? { output: rawResult } : rawResult
      // Cap at the source: MCP may return MB-sized payloads; without a cap, this inflates persisted parts_json
      // and the thread's own server-side context.
      const result: DynamicToolExecutionResult = {
        ...raw,
        output: clipPersistedToolOutput(raw.output),
        ...(raw.toolOutput && typeof raw.toolOutput === 'object'
          ? { toolOutput: { ...raw.toolOutput, text: clipPersistedToolOutput(raw.toolOutput.text) } }
          : {}),
        ...(raw.error ? { error: clipPersistedToolOutput(raw.error) } : {}),
      }
      const sub = result.sub ?? latestSub
      if (sub) {
        route.subagentRuns.set(visibleCallId, sub)
        route.subagentRuns.set(visibleItemId, sub)
      }
      emit({
        kind: 'tool-state',
        messageId: route.messageId,
        toolCallId: visibleCallId,
        state: result.error
          ? { status: 'error', error: result.error, ...(sub ? { sub } : {}) }
          : { status: 'completed', output: result.toolOutput ?? result.output, ...(sub ? { sub } : {}) },
      })
      return {
        contentItems: clipCodexContentItems(
          result.contentItems ?? [{ type: 'inputText', text: result.error || result.output }]
        ),
        success: !result.error,
      }
    } catch (error) {
      const message = errorMessage(error)
      emit({
        kind: 'tool-state',
        messageId: route.messageId,
        toolCallId: visibleCallId,
        state: { status: 'error', error: message, ...(latestSub ? { sub: latestSub } : {}) },
      })
      return { contentItems: [{ type: 'inputText', text: clipPersistedToolOutput(message) }], success: false }
    } finally {
      pendingRequest.finish()
    }
  }

  if (request.method === 'item/tool/requestUserInput' || request.method === 'item/tool/requestUserInputAsync') {
    const asyncQuestion = request.method === 'item/tool/requestUserInputAsync'
    const pendingRequest = beginPendingServerRequest(route, threadId, request.id, {
      preserveOnAccountFailover: threadId !== route.rootThreadId,
    })
    const rawQuestions = asyncQuestion
      ? typeof params.question === 'string'
        ? [{ id: 'async', header: 'Question', question: params.question, options: [] }]
        : []
      : Array.isArray(params.questions)
        ? params.questions
        : []
    const questions: ChatQuestion[] = rawQuestions.map((raw, index) => {
      const question = isRecord(raw) ? raw : {}
      const options = Array.isArray(question.options)
        ? question.options
            .filter(isRecord)
            .map((option) => ({
              label: typeof option.label === 'string' ? option.label : '',
              ...(typeof option.description === 'string' ? { description: option.description } : {}),
            }))
            .filter((option) => option.label)
        : []
      return {
        header: typeof question.header === 'string' ? question.header : `Question ${index + 1}`,
        question: typeof question.question === 'string' ? question.question : 'Please provide an answer.',
        ...(question.isSecret === true ? { isSecret: true } : {}),
        options,
      }
    })
    emit({ kind: 'tool-input-start', messageId: route.messageId, toolCallId: visibleItemId, toolName: 'ask_question' })
    emit(
      {
        kind: 'tool-call',
        messageId: route.messageId,
        toolCallId: visibleItemId,
        toolName: 'ask_question',
        input: { questions },
      },
      true
    )
    try {
      const answers = await waitForQuestionAnswers(
        route,
        visibleItemId,
        questions,
        params.autoResolutionMs,
        pendingRequest.signal
      )
      const byId: Record<string, { answers: string[] }> = {}
      rawQuestions.forEach((raw, index) => {
        const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : String(index)
        byId[id] = { answers: answers[index] ?? [] }
      })
      const persistedOutput =
        'The user answered:\n' +
        questions
          .map((question, index) => {
            const answer = question.isSecret ? '••••••' : (answers[index] ?? []).join(', ') || '(no answer)'
            return `- ${question.question} → ${answer}`
          })
          .join('\n')
      emit({
        kind: 'tool-state',
        messageId: route.messageId,
        toolCallId: visibleItemId,
        state: { status: 'completed', output: clipPersistedToolOutput(persistedOutput) },
      })
      return asyncQuestion
        ? { answers: byId, answer: answers[0]?.join('\n') ?? '' }
        : { answers: byId }
    } finally {
      pendingRequest.finish()
    }
  }

  if (request.method === 'item/commandExecution/requestApproval') {
    // Ask is pure conversation in Maestrly's contract. A read-only sandbox alone would still allow read commands.
    if (route.mode === 'ask') return { decision: 'decline' }
    const pendingRequest = beginPendingServerRequest(route, threadId, request.id, {
      preserveOnAccountFailover: threadId !== route.rootThreadId,
    })
    const command = typeof params.command === 'string' && params.command.trim() ? params.command.trim() : 'command'
    const commandResources = commandSegments(command)
    const permissionResources = resourcesFromPermissions(params.additionalPermissions)
    const networkContext = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : null
    const networkResource =
      networkContext && typeof networkContext.host === 'string'
        ? `network:${typeof networkContext.protocol === 'string' ? `${networkContext.protocol}://` : ''}${networkContext.host}`
        : null
    const resources = [
      ...new Set([...commandResources, ...permissionResources, ...(networkResource ? [networkResource] : [])]),
    ]
    const allowSession = supportsSessionDecision(params.availableDecisions)
    const save = allowSession
      ? [
          ...new Set([
            ...commandResources.map(bashPermissionSavePattern),
            ...permissionResources,
            ...(networkResource ? [networkResource] : []),
          ]),
        ]
      : undefined
    try {
      const decision = await route.broker.assertDecision({
        conversationId: route.conversationId,
        projectId: route.projectId,
        action: 'bash',
        resources: resources.length ? resources : [command],
        save,
        toolName: 'bash',
        toolCallId: visibleItemId,
        title: approvalTitle('command', params),
        signal: pendingRequest.signal,
      })
      return { decision: decision === 'always' && allowSession ? 'acceptForSession' : 'accept' }
    } catch {
      return { decision: 'decline' }
    } finally {
      pendingRequest.finish()
    }
  }

  if (request.method === 'item/fileChange/requestApproval') {
    if (route.mode === 'ask') return { decision: 'decline' }
    const pendingRequest = beginPendingServerRequest(route, threadId, request.id, {
      preserveOnAccountFailover: threadId !== route.rootThreadId,
    })
    const { resources, save } = fileChangeResources(route, itemId, params.grantRoot)
    try {
      const decision = await route.broker.assertDecision({
        conversationId: route.conversationId,
        projectId: route.projectId,
        action: 'edit',
        resources,
        save,
        toolName: 'edit',
        toolCallId: visibleItemId,
        title: approvalTitle('file', params),
        signal: pendingRequest.signal,
      })
      return { decision: decision === 'always' && save?.length ? 'acceptForSession' : 'accept' }
    } catch {
      return { decision: 'decline' }
    } finally {
      pendingRequest.finish()
    }
  }

  if (request.method === 'item/permissions/requestApproval') {
    if (route.mode === 'ask') return { permissions: {}, scope: 'turn' }
    const pendingRequest = beginPendingServerRequest(route, threadId, request.id, {
      preserveOnAccountFailover: threadId !== route.rootThreadId,
    })
    const permissions = isRecord(params.permissions) ? params.permissions : {}
    const resources = resourcesFromPermissions(permissions)
    try {
      const decision = await route.broker.assertDecision({
        conversationId: route.conversationId,
        projectId: route.projectId,
        action: 'external_directory',
        resources: resources.length ? resources : ['additional permissions'],
        ...(resources.length ? { save: resources } : {}),
        toolName: 'permissions',
        toolCallId: visibleItemId,
        title: approvalTitle('permissions', params),
        signal: pendingRequest.signal,
      })
      return {
        permissions: {
          ...(permissions.network != null ? { network: permissions.network } : {}),
          ...(permissions.fileSystem != null ? { fileSystem: permissions.fileSystem } : {}),
        },
        scope: decision === 'always' && resources.length ? 'session' : 'turn',
      }
    } catch {
      return { permissions: {}, scope: 'turn' }
    } finally {
      pendingRequest.finish()
    }
  }

  throw new Error(`Unsupported Codex app-server request: ${request.method}`)
}

export interface RequestRouteRegistration {
  addThread: (threadId: string, runtimes?: DynamicToolRuntime[]) => boolean
  removeThread: (threadId: string) => void
  remove: () => void
}

interface CodexRunnerState {
  messageId: string
  planSubmitted: boolean
  requestTurnStop: () => void
  runTask: DynamicToolRuntime['execute'] | null
  emitGeneratedImage: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage: (usage: GeneratedImageUsage) => void
  generateImage: (
    prompt: string,
    signal: AbortSignal,
    onUsage?: (usage: GeneratedImageUsage) => void
  ) => Promise<GeneratedImageEmission>
  subagentCoordinator: SubagentCoordinator
}

function registerRequestRoute(
  client: CodexAppServerClient,
  threadId: string,
  route: RequestRoute
): RequestRouteRegistration {
  let routes = requestRoutes.get(client)
  if (!routes) {
    routes = new Map()
    requestRoutes.set(client, routes)
  }
  if (!routedClients.has(client)) {
    client.setServerRequestHandler((request) => handleServerRequest(client, request))
    routedClients.add(client)
  }
  const registered = new Set<string>()
  let closed = false
  const addThread = (id: string, runtimes?: DynamicToolRuntime[]): boolean => {
    if (!id || closed) return false
    routes?.set(id, route)
    if (runtimes) route.threadTools.set(id, new Map(runtimes.map((runtime) => [runtime.spec.name, runtime])))
    registered.add(id)
    return true
  }
  const removeThread = (id: string): void => {
    if (!id) return
    if (routes?.get(id) === route) routes.delete(id)
    route.threadTools.delete(id)
    registered.delete(id)
    cancelPendingServerRequests(route, id)
  }
  // The app-server may replay approvals during thread/resume. Register this listener before the resume RPC;
  // it cancels only the JSON-RPC id the provider declared resolved/cleared.
  const offResolved = client.onNotification(({ method, params }) => {
    if (method !== 'serverRequest/resolved' || !isRecord(params)) return
    const resolvedThreadId = typeof params.threadId === 'string' ? params.threadId : ''
    if (!resolvedThreadId || routes?.get(resolvedThreadId) !== route) return
    cancelPendingServerRequest(route, resolvedThreadId, params.requestId)
  })
  addThread(threadId)
  return {
    addThread,
    removeThread,
    remove: () => {
      closed = true
      route.closed = true
      cancelPendingServerRequests(route)
      for (const id of registered) if (routes?.get(id) === route) routes.delete(id)
      for (const id of registered) route.threadTools.delete(id)
      registered.clear()
      offResolved()
    },
  }
}

/** Registers an ephemeral child thread for the same host-managed approval/tool request routing as a parent turn. */
export function registerCodexSubagentRequestRoute(args: {
  client: CodexAppServerClient
  conversationId: string
  projectId: string
  messageId: string
  broker: PermissionBroker
  questionBroker: QuestionBroker
  runtimes: DynamicToolRuntime[]
  signal: AbortSignal
  mode: ChatBehavior
  toolCallIdPrefix?: string
  emit?: (event: ChatStreamEvent, force?: boolean) => void
}): RequestRouteRegistration {
  const route: RequestRoute = {
    conversationId: args.conversationId,
    projectId: args.projectId,
    messageId: args.messageId,
    rootThreadId: '',
    closed: false,
    broker: args.broker,
    questionBroker: args.questionBroker,
    tools: new Map(args.runtimes.map((runtime) => [runtime.spec.name, runtime])),
    threadTools: new Map(),
    ...(args.toolCallIdPrefix ? { toolCallIdPrefix: args.toolCallIdPrefix } : {}),
    itemResources: new Map(),
    pendingRequests: new Map(),
    emit: args.emit ?? (() => {}),
    signal: args.signal,
    mode: args.mode,
    subagentRuns: new Map(),
  }
  return registerRequestRoute(args.client, '', route)
}

async function buildDynamicTools(
  args: RunCodexSubscriptionChatArgs,
  state: CodexRunnerState
): Promise<{
  runtimes: DynamicToolRuntime[]
  /** Raw host tools are retained so nested workers can be adapted to their own vision capability. */
  rawTools: ToolSet
  deferredToolNames: ReadonlySet<string>
  skills: ChatSkill[]
  agents: ChatAgent[]
  close: () => Promise<void>
}> {
  const capabilityMode = capabilityBehaviorFor(args.mode)
  const physicalAgents = args.reviewerRuntime
    ? []
    : await listEffectiveAgents({
        cwd: args.cwd,
        conversationId: args.conversationId,
        mode: capabilityMode === 'agent' || args.mode === 'maestro' ? 'agent' : 'plan',
      })
  const agents = args.reviewerRuntime
    ? []
    : args.mode === 'maestro' && args.maestro
      ? maestroAgentsFromTurn(args.maestro, physicalAgents)
      : capabilityMode === 'agent'
        ? physicalAgents
        : args.maestrlyUltra
          ? physicalAgents.filter((agent) => agent.name === 'explore')
          : []
  const gate = (toolName: string, toolCallId: string, signal?: AbortSignal) => {
    return args.broker.assert({
      conversationId: args.conversationId,
      projectId: args.projectId,
      action: 'mcp',
      resources: [toolName],
      save: [toolName],
      toolName,
      toolCallId,
      signal,
    })
  }

  const prefs = args.reviewerRuntime ? undefined : getConvUiPrefs(args.conversationId).chat?.tools
  const appToolsEnabled = !args.reviewerRuntime && (prefs?.app ?? getAppFlag('chat.appTools', false))
  const disabledIds = new Set(prefs?.mcpDisabled ?? [])
  const mcp =
    !args.reviewerRuntime && (capabilityMode === 'agent' || args.mode === 'maestro')
      ? await buildMcpTools({
          signal: args.signal,
          mode: args.mode,
          gate,
          disabledIds,
          codexSafeNames: true,
          supportsImages: true,
          describeImage: (image) =>
            describeEphemeralToolImage({
              image,
              conversationId: args.conversationId,
              cwd: args.cwd,
              signal: args.signal,
            }),
        })
      : { tools: {}, close: async () => {} }
  const app =
    !args.reviewerRuntime && (capabilityMode === 'agent' || args.mode === 'maestro') && appToolsEnabled
      ? await buildAppTools({
          conversationId: args.conversationId,
          mode: args.mode,
          gate,
          exclude: new Set(['review_plan']),
          supportsImages: true,
          describeImage: (image) =>
            describeEphemeralToolImage({
              image,
              conversationId: args.conversationId,
              cwd: args.cwd,
              signal: args.signal,
            }),
        })
      : { tools: {}, close: async () => {} }

  // Read-only classification depends on the host surface (app/MCP). The bridge surface (core built-ins)
  // never changes the result: read/grep/glob/webfetch have verified read-only contracts, and bash/generate_image
  // are already core mutators. This matches the classification children would see through rawTools.
  const hostSurface: ToolSet = { ...mcp.tools, ...app.tools }
  const hasReadOnlySubagent = agents.some((agent) => isSubagentReadOnly(args.mode, agent.tools, hostSurface))

  try {
    // Codex `untrusted` policy automatically allows safelisted commands. When Maestrly governs each bash call,
    // remove native shell and offer existing host bash, whose ctx.ask passes through the broker.
    // Plan/Ask use explicit readers only (no shell/apply_patch), preserving Maestrly's current semantics:
    // Ask may inspect real code without gaining mutation tools.
    const bridgeNames = args.reviewerRuntime
      ? new Set(REVIEWER_READONLY_TOOL_NAMES)
      : capabilityMode === 'agent' && args.permMode !== 'full'
        ? new Set(['bash'])
        : args.mode === 'plan' || args.mode === 'ask' || args.mode === 'maestro'
          ? new Set(['read', 'grep', 'glob', 'webfetch'])
          : new Set<string>()
    if (!args.reviewerRuntime && hasReadOnlySubagent) {
      for (const name of ['read', 'grep', 'glob', 'webfetch']) bridgeNames.add(name)
    }
    if (!args.reviewerRuntime && (await generateImageToolEnabled(args.conversationId, args.mode))) {
      bridgeNames.add(GENERATE_IMAGE_TOOL_NAME)
    }
    const bridgeTools = bridgeNames.size
      ? buildTools({
          enabled: bridgeNames,
          makeCtx: (toolCallId, signal): ToolContext => ({
            conversationId: args.conversationId,
            projectId: args.projectId,
            messageId: '',
            toolCallId,
            cwd: args.cwd,
            signal,
            ask: (action, resources, save) => {
              if (args.reviewerRuntime) {
                return action === 'read' || action === 'grep' || action === 'glob'
                  ? Promise.resolve()
                  : Promise.reject(new Error(`Reviewer read-only boundary denied ${action}`))
              }
              return args.broker.assert({
                conversationId: args.conversationId,
                projectId: args.projectId,
                action,
                resources,
                save,
                toolName: action,
                toolCallId,
                signal,
              })
            },
            askQuestion: (questions) =>
              args.questionBroker.ask({
                conversationId: args.conversationId,
                messageId: state.messageId,
                toolCallId,
                questions,
                signal,
              }),
            emitGeneratedImage: (image) => state.emitGeneratedImage(toolCallId, image),
            onGeneratedImageUsage: state.onGeneratedImageUsage,
            generateImage: (prompt, generationSignal, onUsage) =>
              state.generateImage(prompt, generationSignal, onUsage),
            ...(args.reviewerRuntime
              ? {
                  reviewer: {
                    recordEvidence: (kind) => args.reviewerRuntime!.recordEvidence(kind),
                    searchExecutionContext: (input) => args.reviewerRuntime!.searchExecutionContext(input),
                    readExecutionContext: (input) => args.reviewerRuntime!.readExecutionContext(input),
                    submitReview: (decision) => {
                      const result = args.reviewerRuntime!.submitReview(decision)
                      if (result.ok) {
                        state.planSubmitted = true
                        state.requestTurnStop()
                      }
                      return result
                    },
                  } satisfies ReviewerToolRuntime,
                }
              : {}),
          }),
        })
      : {}
    const hostTools = mergeDynamicToolSets(mcp.tools, app.tools, bridgeTools)
    // Skills are ordinary host tools too. Keeping them in this raw set means nested runtimes can share the
    // exact same capability adaptation as MCP/app outputs instead of inheriting the parent's image policy.
    const skills =
      args.reviewerRuntime || args.mode === 'ask'
        ? []
        : (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
    const skillTools: ToolSet = skills.length
      ? {
          use_skill: tool({
            description: 'Load the complete instructions for a Maestrly project skill before acting.',
            inputSchema: jsonSchema<{ name: string }>({
              type: 'object',
              properties: { name: { type: 'string', enum: skills.map((skill) => skill.name) } },
              required: ['name'],
              additionalProperties: false,
            }),
            execute: async (input) => {
              const name = isRecord(input) && typeof input.name === 'string' ? input.name : ''
              const skill = await findEffectiveSkill(args.cwd, args.conversationId, name)
              if (!skill?.modelInvocable) {
                throw new Error(
                  `Skill "${name || '(missing)'}" not found. Available: ${skills.map((item) => item.name).join(', ')}`
                )
              }
              return renderSkillContext(skill)
            },
          }),
        }
      : {}
    const rawTools: ToolSet = { ...hostTools.tools, ...skillTools }
    const adaptedHostTools = adaptToolSetForModel({
      tools: rawTools,
      supportsImages: !args.dropImages,
      describeImage: (image) =>
        describeEphemeralToolImage({ image, conversationId: args.conversationId, cwd: args.cwd, signal: args.signal }),
    })
    const runtimes = await toolSetRuntimes(adaptedHostTools, hostTools.deferredToolNames)
    if (agents.length) {
      const supervisionTools = buildSubagentSupervisionTools({
        conversationId: args.conversationId,
        parentMessageId: state.messageId,
        maestro: args.mode === 'maestro',
        signal: args.signal,
      })
      runtimes.push(...(await toolSetRuntimes(supervisionTools, new Set())))
    }
    if (agents.length) {
      const delegationToolName = args.mode === 'maestro' ? 'delegate' : 'task'
      runtimes.push({
        spec: {
          type: 'function',
          name: delegationToolName,
          description: args.mode === 'maestro' ? MAESTRO_DELEGATE_TOOL_DESCRIPTION : TASK_TOOL_DESCRIPTION,
          inputSchema:
            args.mode === 'maestro'
              ? MAESTRO_DELEGATE_TOOL_SCHEMA
              : {
                  type: 'object',
                  properties: {
                    agent: {
                      type: 'string',
                      enum: agents.map((agent) => agent.name),
                      description: 'Subagent name from the catalog.',
                    },
                    prompt: { type: 'string', description: 'Self-contained subtask and all required context.' },
                  },
                  required: ['agent', 'prompt'],
                  additionalProperties: false,
                },
        },
        execute: (input, toolCallId, signal, update) => {
          if (!state.runTask) throw new Error('The Maestrly subagent executor is not ready')
          return state.runTask(input, toolCallId, signal, update)
        },
      })
    }
    // ALL Maestrly skills (`.agents` + `.claude`) enter the same host-owned ToolSet above. Codex's
    // NATIVE catalog is disabled in all modes (`skills.include_instructions: false`).
    if (!args.reviewerRuntime && args.mode !== 'ask' && args.mode !== 'maestro') {
      const schema = asSchema(reviewPlanTool.parameters)
      runtimes.push({
        spec: {
          type: 'function',
          name: reviewPlanTool.name,
          description: reviewPlanTool.description,
          inputSchema: await schema.jsonSchema,
        },
        execute: async (input) => {
          const parsed = reviewPlanTool.parameters.parse(input)
          const result = stagePlan({
            agentId: args.conversationId,
            cwd: args.cwd,
            plan: parsed.plan,
            title: parsed.title,
          })
          if (result.ok) {
            state.planSubmitted = true
            state.requestTurnStop()
          }
          return reviewPlanTool.toModelText(
            parsed,
            result.ok ? { staged: true } : { staged: false, error: result.error }
          )
        },
      })
    }
    runtimes.sort((a, b) => a.spec.name.localeCompare(b.spec.name))
    return {
      runtimes,
      rawTools,
      deferredToolNames: hostTools.deferredToolNames,
      skills,
      agents,
      close: async () => {
        await Promise.all([mcp.close(), app.close()])
      },
    }
  } catch (error) {
    await Promise.all([mcp.close(), app.close()])
    throw error
  }
}

function bindingCanResume(
  binding: CodexThreadBinding | null,
  previousMessageId: string | null,
  signature: string,
  instructionHash: string,
  harnessProfile: ModelHarnessProfileId,
  accountId: string | null
): binding is CodexThreadBinding {
  // Model is not part of identity: `thread/resume` accepts the official `model` override. Sol/Luna changes
  // preserve server-side context; the binding records the new model after the next turn.
  return !!(
    binding &&
    previousMessageId &&
    binding.lastMessageId === previousMessageId &&
    binding.toolSignature === signature &&
    binding.instructionHash === instructionHash &&
    binding.harnessProfile === harnessProfile &&
    // Multiple accounts: a thread lives in its owner's CODEX_HOME; another account must never resume it.
    binding.accountId === accountId
  )
}

function experimentalContextUnavailable(error: unknown): boolean {
  return /(?:experimental[_ ]context|context[_ ]management).*(?:unsupported|unavailable|not enabled|not eligible)|(?:unsupported|unknown).*(?:experimental[_ ]mode)/i.test(
    errorMessage(error)
  )
}

function threadAlreadyMissing(error: string): boolean {
  const message = error.trim()
  return (
    /^(?:thread|rollout)(?:\s+\S+)?\s+(?:not found|does not exist)(?::.*)?$/i.test(message) ||
    /^no (?:thread|rollout)(?:\s+found)?(?::.*)?$/i.test(message)
  )
}

async function retireCodexThread(
  conversationId: string,
  threadId: string,
  accountId: string | null,
  options?: { signal?: AbortSignal }
): Promise<void> {
  retireCodexThreadBinding(conversationId, threadId)
  queueCodexThreadCleanup(conversationId, threadId, accountId)
  try {
    // Always delete through the OWNER account's manager (binding/tombstone accountId), never the current run's
    // client: "not found" under the wrong account would clear the tombstone and orphan the real thread.
    await getCodexSubscriptionManager(accountId).deleteThread(threadId, {
      signal: options?.signal ?? AbortSignal.timeout(15_000),
    })
    clearCodexThreadCleanup(threadId)
  } catch (error) {
    const message = errorMessage(error)
    // An absent thread satisfies hard-delete; do not retain its tombstone forever.
    if (threadAlreadyMissing(message)) {
      clearCodexThreadCleanup(threadId)
      return
    }
    markCodexThreadCleanupFailed(threadId, message)
  }
}

/** Start provider-native compaction and await the internal turn's completion (the RPC itself returns immediately). */
export async function compactCodexSubscriptionThread(
  client: CodexAppServerClient,
  threadId: string,
  signal: AbortSignal
): Promise<CodexUsageTotals | null> {
  if (signal.aborted) throw new Error('Compaction aborted')
  let compactTurnId = ''
  let latestUsage: TokenUsageNotification | null = null
  let resolveCompleted!: () => void
  let rejectCompleted!: (error: Error) => void
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  const off = client.onNotification(({ method, params }) => {
    if (!isRecord(params) || params.threadId !== threadId) return
    if (method === 'thread/tokenUsage/updated') {
      latestUsage = params as unknown as TokenUsageNotification
      return
    }
    if (method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') {
      compactTurnId = params.turn.id
      return
    }
    if (method !== 'turn/completed' || !isRecord(params.turn)) return
    const id = typeof params.turn.id === 'string' ? params.turn.id : ''
    if (compactTurnId && id !== compactTurnId) return
    if (params.turn.status === 'failed') {
      const message = isRecord(params.turn.error) ? textOf(params.turn.error.message) : 'Codex compaction failed'
      rejectCompleted(new Error(message || 'Codex compaction failed'))
    } else {
      resolveCompleted()
    }
  })
  const onAbort = (): void => rejectCompleted(new Error('Compaction aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  let timeout: NodeJS.Timeout | undefined
  try {
    await client.request('thread/compact/start', { threadId }, { signal, timeoutMs: 30_000 })
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex compaction timed out')), 120_000)
        timeout.unref()
      }),
    ])
    const finalUsage = latestUsage as TokenUsageNotification | null
    return finalUsage ? usageTotals(finalUsage.tokenUsage.total) : null
  } finally {
    if (timeout) clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    off()
  }
}

/**
 * Official runtime adapter: preserves Maestrly UX/persistence while Codex's own harness governs context,
 * compaction, native tools, skills, and subagents.
 */
export async function runCodexSubscriptionChat(
  args: RunCodexSubscriptionChatArgs
): Promise<RunCodexSubscriptionChatResult> {
  const capabilityMode = capabilityBehaviorFor(args.mode)
  const settleInitialLeaseAsOther = (): void => {
    if (!args.availabilityLease) return
    getSubscriptionFailoverRouter().confirmAttemptOther(
      args.effectiveProviderId ?? args.selection.providerId,
      args.availabilityLease
    )
  }

  if (args.signal.aborted) {
    settleInitialLeaseAsOther()
    throw new Error('Turn aborted before Codex started')
  }
  if (args.reasoningEffort === MAESTRLY_ULTRA_EFFORT) {
    settleInitialLeaseAsOther()
    throw new Error('Maestrly Ultra sentinel must be resolved before calling the Codex app-server')
  }
  const responseStartedAt = args.responseStartedAt ?? Date.now()
  const history = runnerContextHistory(args.conversationId, {
    ephemeralSession: args.ephemeralSession,
    executionScope: args.messageMeta?.executionScope,
  })
  const currentUser = history.at(-1)
  if (currentUser?.role !== 'user') {
    settleInitialLeaseAsOther()
    throw new Error('Current user message was not persisted')
  }

  let currentClient = args.client
  let threadAccountId = args.initialAccountId ?? subscriptionAccountId(args.selection.providerId)
  let currentProviderId = args.effectiveProviderId ?? args.selection.providerId
  let currentServiceTier = args.serviceTier ?? null
  let currentDropImages = args.dropImages === true
  let currentReasoningEffort = args.reasoningEffort
  let currentModelId = args.selection.modelId
  let currentLease = args.availabilityLease
  let currentRequestedContextWindow = positiveContextWindow(args.requestedContextWindow) || null
  let experimentalContextFallbackDisabled = false
  const astraHarnessEnabledAtAdmission = getAppFlag('chat.astraHarness', true)
  const profileFor = (
    model: Partial<CodexSubscriptionModel> | null | undefined,
    client: CodexAppServerClient,
    eligibleChatGptSession = args.eligibleChatGptSession === true
  ): AstraCodexThreadProfile => {
    const session = client.initializeResult?.capabilities
    return buildAstraCodexThreadProfile({
      modelId: currentModelId,
      model,
      astraHarnessEnabled: astraHarnessEnabledAtAdmission,
      eligibleChatGptSession,
      ephemeral: Boolean(args.ephemeralSession),
      reviewer: Boolean(args.reviewerRuntime),
      requestUserInputAsyncAvailable: session?.requestUserInputAsync === true,
      turnSteerAvailable: session?.turnSteer,
      turnSettingsUpdateAvailable: session?.turnSettingsUpdate,
      reasoningEffort: currentReasoningEffort,
      experimentalContextFallbackDisabled:
        experimentalContextFallbackDisabled || ASTRA_EXPERIMENTAL_CONTEXT_UNAVAILABLE.has(client),
    })
  }
  let runtimeProfile = profileFor(args.runtimeModel, currentClient)
  currentReasoningEffort = runtimeProfile.reasoningEffort ?? undefined
  chatDiag({
    kind: 'codex-subscription-harness-profile',
    profile: runtimeProfile.modelHarnessProfileId,
    model: currentModelId,
    conv: args.conversationId,
    nativeCompaction: runtimeProfile.nativeCompactionFirst,
    experimentalContext: runtimeProfile.experimentalContextEnabled,
    steering: runtimeProfile.capabilities.steering,
    liveReasoning: runtimeProfile.capabilities.configurationUpdates,
    asyncQuestions: runtimeProfile.asyncQuestionGuidance,
    nativeMultiAgent: 'disabled-host-task',
    modelCapabilities: runtimeProfile.modelCapabilities,
    adapterCapabilities: runtimeProfile.adapterCapabilities,
    effectiveCapabilities: runtimeProfile.capabilities,
  })
  let currentObserveContextWindow: ((contextWindow: number) => void) | undefined
  const updateContextWindowObserver = (
    manager?: CodexFailoverRuntimeTarget['manager'],
    modelId = currentModelId
  ): void => {
    if (!args.onModelContextWindow && !manager) {
      currentObserveContextWindow = undefined
      return
    }
    currentObserveContextWindow = (contextWindow) => {
      // Pass `null` explicitly for an unknown capability. `undefined` is reserved for compatibility with
      // old callers and must not make a fallback observation inherit the prior target's nominal request.
      args.onModelContextWindow?.(contextWindow, currentRequestedContextWindow)
      manager?.observeModelContextWindow(modelId, contextWindow, currentRequestedContextWindow)
    }
  }
  const targetEffectiveContextWindow = (target: CodexFailoverRuntimeTarget): number | null =>
    positiveContextWindow(target.effectiveContextWindow ?? target.contextWindow ?? target.model.contextWindow) || null
  updateContextWindowObserver()
  // Keep the portable ceiling monotonic across physical account changes. A larger window on a later
  // account must not make a transcript already admitted for a smaller account unsafe to continue.
  let portableContextWindow = positiveContextWindow(args.contextWindow)
  const observePortableContextWindow = (value: unknown): void => {
    const next = positiveContextWindow(value)
    if (!next) return
    portableContextWindow = portableContextWindow > 0 ? Math.min(portableContextWindow, next) : next
  }
  observePortableContextWindow(args.contextWindow)
  const attemptedProviderIds = new Set<string>([currentProviderId])
  const chain = args.failoverChain?.length ? [...args.failoverChain] : [args.selection.providerId]
  const failoverEnabled = typeof args.resolveNextTarget === 'function' && chain.length > 1
  let currentAttemptSettled = false
  const settleCurrentAttempt = (result: 'success' | 'quota' | 'other', exhaustionInfo?: MarkExhaustedInfo): void => {
    // Completion can publish quota before child recovery, then reach failover later.
    // Settle once so an old failure cannot overwrite a newer probe from another turn.
    if (currentAttemptSettled) return
    currentAttemptSettled = true
    const lease = currentLease
    currentLease = undefined
    const providerId = currentProviderId
    const router = getSubscriptionFailoverRouter()

    if (result === 'success') {
      if (failoverEnabled || lease) router.confirmAttemptSuccess(providerId, lease)
    } else if (result === 'quota') {
      if (failoverEnabled || lease) router.confirmAttemptQuota(providerId, lease, exhaustionInfo!)
    } else if (lease) {
      router.confirmAttemptOther(providerId, lease)
    }
  }
  const settleResolvedTargetAsOther = (target: CodexFailoverRuntimeTarget): void => {
    if (target.availabilityLease) {
      getSubscriptionFailoverRouter().confirmAttemptOther(target.providerId, target.availabilityLease)
    }
  }

  const assistantId = randomUUID()
  const createdAt = Date.now()
  let messages: ChatMessage[] = [
    {
      id: assistantId,
      conversationId: args.conversationId,
      role: 'assistant',
      parts: [],
      model: args.selection,
      ...(args.messageMeta ?? {}),
      createdAt,
    },
  ]
  // Steering user messages are persisted after the in-progress assistant row. The binding follows the latest
  // accepted portable anchor so the next turn can still resume the same native thread.
  let lastBindingMessageId: string = assistantId
  let dirty = false
  let lastPersistAt = 0
  const persistNow = (): void => {
    lastPersistAt = Date.now()
    dirty = false
    upsertChatMessage(messages[0])
  }
  const coalescer = createDeltaCoalescer(args.emit)
  const apply = (event: ChatStreamEvent, force = false): void => {
    messages = applyChatEvent(messages, event)
    coalescer.push(event)
    if (force || Date.now() - lastPersistAt > 300) persistNow()
    else dirty = true
  }
  const isFailoverResolutionFailure = (
    value: CodexFailoverRuntimeTarget | CodexFailoverResolutionFailure | null
  ): value is CodexFailoverResolutionFailure => value !== null && 'reason' in value && 'message' in value
  const emitFailoverResolutionFailure = (failure?: CodexFailoverResolutionFailure, usage?: ChatUsage): void => {
    const quota = !failure || failure.reason === 'quota-exhausted'
    apply(
      {
        kind: 'error',
        messageId: assistantId,
        message:
          failure?.message?.trim() ||
          (quota
            ? 'All Codex subscription accounts in the failover chain are exhausted. Try again later.'
            : 'No eligible Codex subscription account is currently available.'),
        ...(quota ? { code: 'codex-accounts-exhausted' as const } : {}),
        ...(usage ? { usage } : {}),
        responseDurationMs: responseDurationMs(responseStartedAt),
      },
      true
    )
  }
  upsertChatMessage(messages[0])
  coalescer.push({
    kind: 'message-start',
    messageId: assistantId,
    model: args.selection,
    createdAt,
    responseStartedAt,
    ...(args.messageMeta?.source ? { source: args.messageMeta.source } : {}),
    ...(args.messageMeta?.reviewLoop ? { reviewLoop: args.messageMeta.reviewLoop } : {}),
  })

  const externalSubagentUsage: ChatSubagentUsage[] = []
  const recordExternalSubagentUsage = (
    model: ChatModelRef,
    usage?: NormalizedAiUsage,
    runtimeEstimatedCostUsd?: number
  ): void => {
    if (!usage && runtimeEstimatedCostUsd == null) return
    const current = externalSubagentUsage.find(
      (entry) => entry.providerId === model.providerId && entry.modelId === model.modelId
    )
    if (current) {
      current.input += usage?.input ?? 0
      current.output += usage?.output ?? 0
      current.cachedInput = (current.cachedInput ?? 0) + (usage?.cacheRead ?? 0)
      current.cacheCreate = (current.cacheCreate ?? 0) + (usage?.cacheCreate ?? 0)
      if (runtimeEstimatedCostUsd == null && usage) {
        current.catalogInput = (current.catalogInput ?? 0) + usage.input
        current.catalogOutput = (current.catalogOutput ?? 0) + usage.output
        current.catalogCacheRead = (current.catalogCacheRead ?? 0) + usage.cacheRead
        current.catalogCacheCreate = (current.catalogCacheCreate ?? 0) + usage.cacheCreate
      }
      if (current.runtimeEstimatedCostUsd != null || runtimeEstimatedCostUsd != null) {
        current.runtimeEstimatedCostUsd = (current.runtimeEstimatedCostUsd ?? 0) + (runtimeEstimatedCostUsd ?? 0)
      }
    } else {
      externalSubagentUsage.push({
        ...model,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        ...(usage?.cacheRead ? { cachedInput: usage.cacheRead } : {}),
        ...(usage?.cacheCreate ? { cacheCreate: usage.cacheCreate } : {}),
        ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
        ...(runtimeEstimatedCostUsd == null && usage
          ? {
              catalogInput: usage.input,
              catalogOutput: usage.output,
              catalogCacheRead: usage.cacheRead,
              catalogCacheCreate: usage.cacheCreate,
            }
          : {}),
      })
    }
  }

  const state: CodexRunnerState = {
    messageId: assistantId,
    planSubmitted: false,
    requestTurnStop: () => {},
    runTask: null,
    emitGeneratedImage: (toolCallId, image) => emitGeneratedImagePart(apply, assistantId, toolCallId, image),
    onGeneratedImageUsage: (usage) =>
      recordExternalSubagentUsage(
        { providerId: usage.providerId, modelId: usage.modelId },
        normalizeGeneratedImageUsage(usage)
      ),
    generateImage: async (prompt, signal, onUsage) =>
      generateImageForConversation({
        conversationId: args.conversationId,
        cwd: args.cwd,
        prompt,
        signal,
        onUsage,
      }),
    subagentCoordinator: new SubagentCoordinator({
      onEvent: (event) =>
        chatDiag({
          kind: 'subagent-coordinator',
          runtime: 'codex-subscription',
          conv: args.conversationId,
          ...event,
        }),
    }),
  }
  let dynamic: Awaited<ReturnType<typeof buildDynamicTools>>
  try {
    dynamic = await buildDynamicTools(args, state)
  } catch (error) {
    settleCurrentAttempt('other')
    apply(
      {
        kind: 'error',
        messageId: assistantId,
        message: errorMessage(error),
        responseDurationMs: responseDurationMs(responseStartedAt),
      },
      true
    )
    coalescer.flush()
    coalescer.dispose()
    throw error
  }
  const specs = dynamic.runtimes.map((runtime) => runtime.spec)
  const childToolSet = (signal: AbortSignal, supportsImages: boolean): ToolSet =>
    adaptToolSetForModel({
      tools: dynamic.rawTools,
      supportsImages,
      describeImage: (image) =>
        describeEphemeralToolImage({ image, conversationId: args.conversationId, cwd: args.cwd, signal }),
    })
  const asClaudeTools = (
    runtimes: readonly DynamicToolRuntime[],
    signal: AbortSignal,
    supportsImages: boolean
  ): ToolSet =>
    Object.fromEntries(
      runtimes
        .filter(
          (runtime) =>
            runtime.spec.name !== 'task' && runtime.spec.name !== 'delegate' && runtime.spec.name !== 'review_plan'
        )
        .map((runtime) => [
          runtime.spec.name,
          tool({
            description: runtime.spec.description,
            inputSchema: jsonSchema(runtime.spec.inputSchema),
            execute: async (input, options) => {
              const result = await runtime.execute(
                input,
                options.toolCallId,
                options.abortSignal ?? signal,
                () => undefined
              )
              if (typeof result === 'string') return result
              return result.toolOutput ?? result.output
            },
            toModelOutput: ({ output }: { output: unknown }) => {
              const normalized = modelOutputToChatToolOutput(output)
              return typeof normalized === 'string'
                ? { type: 'text' as const, value: normalized || '(no output)' }
                : chatToolOutputToAiSdkOutput(normalized, { dropImages: !supportsImages })
            },
          }),
        ])
    )
  const registrations = dynamicToolRegistrations(specs)
  const toolProfile = profileDynamicTools(specs)
  const signature = dynamicToolSignature(specs)
  const projectContext = await buildProjectContext(args.projectId, args.cwd)
  const developerInstructionsFor = (profile: AstraCodexThreadProfile): string => {
    const base = profile.isAstra
      ? maestrlyAstraHostInstructions(args.mode, dynamic.skills, dynamic.agents, {
          conversationId: args.conversationId,
          maestro: args.maestro,
        })
      : maestrlyDeveloperInstructions(args.mode, dynamic.skills, dynamic.agents, {
          conversationId: args.conversationId,
          maestro: args.maestro,
        })
    return (profile.isAstra ? astraDeveloperInstructions(base, profile) : base) + projectContext
  }
  let developerInstructions = developerInstructionsFor(runtimeProfile)
  const structuralInstructionHash = (): string =>
    createHash('sha256')
      .update(
        JSON.stringify({
          version: 2,
          harnessProfile: runtimeProfile.modelHarnessProfileId,
          promptVersion: runtimeProfile.promptVersion,
          developerInstructions,
          projectContext,
          nativeCompactionFirst: runtimeProfile.nativeCompactionFirst,
          experimentalContext: runtimeProfile.experimentalContextEnabled,
        })
      )
      .digest('hex')
  let instructionHash = structuralInstructionHash()
  // Account slot: bindings/tombstones record the thread owner so hard-delete always uses the correct
  // CODEX_HOME, even after restart. `threadAccountId` is mutable under failover.
  const runtimeByName = new Map(dynamic.runtimes.map((runtime) => [runtime.spec.name, runtime]))
  const existing = getCodexThreadBinding(args.conversationId)
  const existingThreadId = existing?.threadId
  const existingAccountId = existing?.accountId ?? threadAccountId
  const previousMessage = history.at(-2) ?? null
  const canResume =
    !args.ephemeralSession &&
    bindingCanResume(
      existing,
      previousMessage?.id ?? null,
      signature,
      instructionHash,
      runtimeProfile.modelHarnessProfileId,
      threadAccountId
    )
  // Isolated: neither resume NOR retire the main conversation binding.
  if (existingThreadId && !canResume && !args.ephemeralSession) {
    chatDiag({
      kind: 'codex-subscription-thread-boundary',
      conv: args.conversationId,
      model: currentModelId,
      fromProfile: existing?.harnessProfile,
      toProfile: runtimeProfile.modelHarnessProfileId,
      reason: existing?.harnessProfile !== runtimeProfile.modelHarnessProfileId ? 'harness-profile' : 'compatibility',
    })
    await retireCodexThread(args.conversationId, existingThreadId, existingAccountId)
  }
  let baseline = canResume ? existing.usage : { ...EMPTY_USAGE }
  const approval = approvalConfig(args.reviewerRuntime ? 'ask' : args.mode, args.permMode)
  const threadOptions = {
    model: currentModelId,
    serviceTier: currentServiceTier,
    cwd: args.cwd,
    approvalPolicy: approval.approvalPolicy,
    // `thread/start` with workspace-write/full marks the project trusted and loads `.codex/config.toml`
    // and local MCPs outside Maestrly gates. Grant actual power per turn only after the isolated thread exists.
    sandbox: 'read-only' as const,
    // Native request_user_input defaults to Plan-only. This official override also enables it in the
    // Default modes used by Agent/Ask without duplicating it as a dynamic tool.
    config: {
      ...DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG,
      ...(runtimeProfile.nativeCompactionFirst ? {} : ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG),
      ...(runtimeProfile.experimentalContextEnabled
        ? { 'features.context_management.experimental_mode': true }
        : runtimeProfile.isAstra
          ? { 'features.context_management.experimental_mode': false }
          : {}),
      // Maestrly discovers and budgets project docs for all runtimes. Zero prevents Codex from injecting
      // AGENTS.md twice with a root/budget that may differ from the canonical contract.
      project_doc_max_bytes: 0,
      ...(currentRequestedContextWindow != null ? { model_context_window: currentRequestedContextWindow } : {}),
      // Maestrly owns deterministic subagent selection and accounting through the dynamic `task` tool.
      // These two flags cover only legacy multi-agent: for 5.6 models, catalog `multi_agent_version` enables
      // the native harness and is disabled only by the PROCESS `model_catalog_json` flag (manager.ts).
      // The thread still controls mode text, hence the hint below.
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      ...nativeSubagentSuppressionConfig(),
      // Plan receives Maestrly readers; controlled Ask/Agent receive no native shell. This avoids
      // the internal `UnlessTrusted` safelist, which would execute `cat`/`rg` without consulting Maestrly's broker.
      ...(args.reviewerRuntime || capabilityMode !== 'agent' || args.permMode !== 'full'
        ? { 'features.shell_tool': false }
        : {}),
      // Native web search never requests approval. Disable it in Ask to avoid bypassing the webfetch gate;
      // MCP/app search tools remain available through Maestrly's broker.
      ...(args.reviewerRuntime || args.mode === 'ask' || args.mode === 'maestro' || args.permMode === 'ask'
        ? { web_search: 'disabled' }
        : {}),
      // The skills catalog ALWAYS belongs to Maestrly (use_skill + global/per-conversation state). Disable
      // native Codex discovery in all modes; otherwise a UI-disabled skill would remain
      // advertised/loadable by the Agent/Plan harness.
      'features.skill_search': false,
      'features.skill_mcp_dependency_install': false,
      'skills.include_instructions': false,
      ...(args.reviewerRuntime || args.mode === 'ask' || args.mode === 'maestro'
        ? {
            'features.apps': false,
            'features.plugins': false,
            'features.tool_suggest': false,
          }
        : {}),
      // Native imagegen stays disabled to avoid a second contract without `outputPath`. In Agent, the host-managed
      // dynamic `generate_image` tool uses an ephemeral Codex thread with exactly the same behavior as other
      // providers. The explicit flag also protects Plan/Ask against runtime defaults.
      'features.image_generation': false,
    } as Record<string, unknown>,
    developerInstructions,
    ...(runtimeProfile.personality ? { personality: runtimeProfile.personality } : {}),
  }
  const baseThreadConfig: Record<string, unknown> = { ...threadOptions.config }
  delete baseThreadConfig.model_context_window
  const disableExperimentalContext = (): void => {
    if (!runtimeProfile.experimentalContextEnabled) return
    experimentalContextFallbackDisabled = true
    ASTRA_EXPERIMENTAL_CONTEXT_UNAVAILABLE.add(currentClient)
    runtimeProfile = profileFor(args.runtimeModel, currentClient)
    baseThreadConfig['features.context_management.experimental_mode'] = false
    threadOptions.config = {
      ...baseThreadConfig,
      ...(currentRequestedContextWindow != null ? { model_context_window: currentRequestedContextWindow } : {}),
    }
    instructionHash = structuralInstructionHash()
    chatDiag({
      kind: 'codex-subscription-experimental-context-fallback',
      profile: runtimeProfile.modelHarnessProfileId,
      model: currentModelId,
      conv: args.conversationId,
    })
  }
  const setRequestedContextWindow = (value: unknown): void => {
    currentRequestedContextWindow = positiveContextWindow(value) || null
    threadOptions.config = {
      ...baseThreadConfig,
      ...(currentRequestedContextWindow != null ? { model_context_window: currentRequestedContextWindow } : {}),
    }
  }
  const applyTarget = (next: CodexFailoverRuntimeTarget): void => {
    args.onTurnControl?.(null)
    currentClient = next.client
    threadAccountId = next.accountId
    currentProviderId = next.providerId
    currentServiceTier = next.serviceTier
    currentDropImages = next.dropImages
    currentReasoningEffort = next.reasoningEffort
    currentModelId = next.runtimeModelId
    runtimeProfile = profileFor(
      next.model,
      next.client,
      next.manager?.getStatusSnapshot?.()?.account?.type === 'chatgpt'
    )
    currentReasoningEffort = runtimeProfile.reasoningEffort ?? undefined
    currentLease = next.availabilityLease
    currentAttemptSettled = false
    threadOptions.model = currentModelId
    threadOptions.serviceTier = currentServiceTier
    developerInstructions = developerInstructionsFor(runtimeProfile)
    threadOptions.developerInstructions = developerInstructions
    if (runtimeProfile.personality) threadOptions.personality = runtimeProfile.personality
    else delete (threadOptions as { personality?: string }).personality
    if (runtimeProfile.isAstra) {
      baseThreadConfig['features.context_management.experimental_mode'] = runtimeProfile.experimentalContextEnabled
    } else {
      delete baseThreadConfig['features.context_management.experimental_mode']
    }
    if (runtimeProfile.nativeCompactionFirst) {
      delete baseThreadConfig.model_auto_compact_token_limit
      delete baseThreadConfig.model_auto_compact_token_limit_scope
    } else {
      Object.assign(baseThreadConfig, ROOT_THREAD_NATIVE_AUTO_COMPACTION_CONFIG)
    }
    instructionHash = structuralInstructionHash()
    setRequestedContextWindow(next.requestedContextWindow)
    updateContextWindowObserver(next.manager, currentModelId)
    observePortableContextWindow(targetEffectiveContextWindow(next))
    attemptedProviderIds.add(next.providerId)
  }
  const notifyEffectiveTargetChanged = (next: CodexFailoverRuntimeTarget): void => {
    const contextWindow = targetEffectiveContextWindow(next)
    args.onEffectiveTargetChanged?.({
      providerId: next.providerId,
      accountId: next.accountId,
      ...(contextWindow != null ? { contextWindow } : {}),
      ...(currentRequestedContextWindow != null ? { requestedContextWindow: currentRequestedContextWindow } : {}),
    })
  }

  // Register routing before `thread/resume`: app-server may replay pending approvals while the RPC is
  // still in flight. Without this early window, requests arrive without an associated Maestrly conversation.
  const itemResources = new Map<string, string[]>()
  const route: RequestRoute = {
    conversationId: args.conversationId,
    projectId: args.projectId,
    messageId: assistantId,
    rootThreadId: canResume ? existing.threadId : '',
    closed: false,
    broker: args.broker,
    questionBroker: args.questionBroker,
    tools: runtimeByName,
    threadTools: new Map(),
    itemResources,
    pendingRequests: new Map(),
    emit: apply,
    signal: args.signal,
    mode: args.mode,
    subagentRuns: new Map(),
  }
  let routeRegistration = registerRequestRoute(currentClient, canResume ? existing.threadId : '', route)
  let offNotification: () => void = () => {}
  let onAbort: () => void = () => {}
  // In-flight generated-image writes. Declared OUTSIDE try because `finally` must also await them: on
  // timeout/transport failure/app-server exit, the runner returns without `turn/completed`, and surviving
  // writes could recreate a deleted/wiped directory or apply an event after dispose.
  const pendingGeneratedImages = new Set<Promise<void>>()
  const trackGeneratedImage = (work: Promise<void>): void => {
    pendingGeneratedImages.add(work)
    // Discarding `.finally()` would create a second unhandled rejected promise if `apply()` failed.
    // Remove from the set in both branches without unhandled rejection; `allSettled` observes the original promise.
    void work.then(
      () => pendingGeneratedImages.delete(work),
      () => pendingGeneratedImages.delete(work)
    )
  }
  const waitForGeneratedImages = async (): Promise<void> => {
    while (pendingGeneratedImages.size) await Promise.allSettled([...pendingGeneratedImages])
  }
  let threadId = ''
  let seeded = !canResume
  let createdNewThread = false
  let threadPersisted = false
  let threadDisposed = false
  let rootTurnAccepted = false
  let rootTurnTerminal = false
  let rootAbortTimer: NodeJS.Timeout | undefined
  let rootAbortTimeoutReject!: (error: Error) => void
  const rootAbortTimeout = new Promise<never>((_resolve, reject) => {
    rootAbortTimeoutReject = reject
  })
  void rootAbortTimeout.catch(() => {})
  const armRootAbortTimeout = (): void => {
    if (rootAbortTimer) return
    rootAbortTimer = setTimeout(() => {
      rootAbortTimer = undefined
      rootAbortTimeoutReject(new Error(`Timed out waiting for Codex root thread ${threadId || '(starting)'} to stop`))
    }, CHILD_STOP_TIMEOUT_MS)
    rootAbortTimer.unref()
  }
  const onStartupAbort = (): void => armRootAbortTimeout()
  args.signal.addEventListener('abort', onStartupAbort, { once: true })
  const managedTaskRecoveryStop = new AbortController()
  const managedTaskRecoverySignal = AbortSignal.any([args.signal, managedTaskRecoveryStop.signal])
  try {
    if (canResume) {
      try {
        const deadline = ownedRequestDeadline('Codex thread/resume')
        const resumeRequest = currentClient.resumeThread(
          {
            threadId: existing.threadId,
            ...threadOptions,
            ...(args.reviewerRuntime ? { environments: [] } : {}),
          } as Parameters<CodexAppServerClient['resumeThread']>[0] & { environments?: [] },
          { timeoutMs: 0 }
        )
        void resumeRequest.catch(() => {})
        let resumed: Awaited<typeof resumeRequest>
        try {
          resumed = await Promise.race([resumeRequest, rootAbortTimeout, deadline.promise])
        } finally {
          deadline.cancel()
        }
        threadId = resumed.thread.id
        route.rootThreadId = threadId
        routeRegistration.addThread(threadId)
        if (threadId !== existing.threadId) routeRegistration.removeThread(existing.threadId)
      } catch (error) {
        if (args.signal.aborted) throw error
        if (runtimeProfile.experimentalContextEnabled && experimentalContextUnavailable(error)) {
          disableExperimentalContext()
        }
        routeRegistration.removeThread(existing.threadId)
        await retireCodexThread(args.conversationId, existing.threadId, existing.accountId)
        // The replacement thread starts cumulative counts at zero. Reusing the lost thread's baseline
        // would collapse the first new turn's delta to zero through nonNegativeDifference().
        baseline = { ...EMPTY_USAGE }
        seeded = true

        const resumeClassification = await classifyCodexQuotaFailureWithRateLimits(error, () =>
          getCodexSubscriptionManager(threadAccountId).getRateLimits(true)
        )
        if (resumeClassification.kind === 'quota' && failoverEnabled && args.resolveNextTarget) {
          const source =
            resumeClassification.confidence === 'structured'
              ? 'structured-error'
              : resumeClassification.confidence === 'rate-limits-confirmed'
                ? 'rate-limits'
                : 'usage-limit-marker'
          const exhaustionInfo = {
            reason: resumeClassification.message,
            source: source as 'structured-error' | 'rate-limits' | 'usage-limit-marker',
            resetsAt: resumeClassification.resetsAt ?? null,
          }
          settleCurrentAttempt('quota', exhaustionInfo)
          const next = await args.resolveNextTarget(
            { error, classification: resumeClassification },
            attemptedProviderIds
          )
          if (!next || isFailoverResolutionFailure(next) || attemptedProviderIds.has(next.providerId)) {
            emitFailoverResolutionFailure(isFailoverResolutionFailure(next) ? next : undefined)
            return { planSubmitted: false, threadId: '' }
          }
          if (args.signal.aborted) {
            settleResolvedTargetAsOther(next)
            throw new Error('Turn aborted during Codex account failover')
          }
          const fromProviderId = currentProviderId
          applyTarget(next)
          args.onFailoverTransition?.({
            scope: 'root',
            fromProviderId,
            toProviderId: next.providerId,
            reason: resumeClassification.message,
            resetsAt: resumeClassification.resetsAt ?? null,
          })
          notifyEffectiveTargetChanged(next)
          routeRegistration.remove()
          route.closed = false
          routeRegistration = registerRequestRoute(currentClient, '', route)
        }
      }
    }
    while (!threadId) {
      if (args.signal.aborted) throw new Error('Turn aborted before Codex turn/start')
      const deadline = ownedRequestDeadline('Codex thread/start')
      const startThreadAccountId = threadAccountId
      const startThreadRequest = currentClient.startThread(
        {
          ...threadOptions,
          // Empty is the official contract to disable environment access: removes shell/apply_patch/view_image.
          // Plan and Ask continue investigating only through the gated dynamic readers above.
          ...(capabilityMode === 'agent' && !args.reviewerRuntime ? {} : { environments: [] }),
          ephemeral: Boolean(args.ephemeralSession),
          dynamicTools: registrations,
        } as Parameters<CodexAppServerClient['startThread']>[0] & {
          dynamicTools: DynamicToolRegistrationSpec[]
          environments?: []
        },
        { timeoutMs: 0 }
      )
      void startThreadRequest.catch(() => {})
      let started: Awaited<typeof startThreadRequest>
      try {
        started = await Promise.race([startThreadRequest, rootAbortTimeout, deadline.promise])
      } catch (error) {
        // The timeout is ours, not the RPC's: a late response still reveals the ID and can be retired.
        void startThreadRequest
          .then((lateThread) =>
            retireCodexThread(args.conversationId, lateThread.thread.id, startThreadAccountId).catch(() => {})
          )
          .catch(() => {})
        deadline.cancel()
        if (args.signal.aborted) throw error
        if (runtimeProfile.experimentalContextEnabled && experimentalContextUnavailable(error)) {
          disableExperimentalContext()
          continue
        }

        const startClassification = await classifyCodexQuotaFailureWithRateLimits(error, () =>
          getCodexSubscriptionManager(threadAccountId).getRateLimits(true)
        )
        if (startClassification.kind === 'quota' && failoverEnabled && args.resolveNextTarget) {
          const source =
            startClassification.confidence === 'structured'
              ? 'structured-error'
              : startClassification.confidence === 'rate-limits-confirmed'
                ? 'rate-limits'
                : 'usage-limit-marker'
          const exhaustionInfo = {
            reason: startClassification.message,
            source: source as 'structured-error' | 'rate-limits' | 'usage-limit-marker',
            resetsAt: startClassification.resetsAt ?? null,
          }
          settleCurrentAttempt('quota', exhaustionInfo)
          const next = await args.resolveNextTarget(
            { error, classification: startClassification },
            attemptedProviderIds
          )
          if (!next || isFailoverResolutionFailure(next) || attemptedProviderIds.has(next.providerId)) {
            emitFailoverResolutionFailure(isFailoverResolutionFailure(next) ? next : undefined)
            return { planSubmitted: false, threadId: '' }
          }
          if (args.signal.aborted) {
            settleResolvedTargetAsOther(next)
            throw error
          }
          const fromProviderId = currentProviderId
          applyTarget(next)
          args.onFailoverTransition?.({
            scope: 'root',
            fromProviderId,
            toProviderId: next.providerId,
            reason: startClassification.message,
            resetsAt: startClassification.resetsAt ?? null,
          })
          notifyEffectiveTargetChanged(next)
          routeRegistration.remove()
          route.closed = false
          routeRegistration = registerRequestRoute(currentClient, '', route)
          continue
        }
        throw error
      } finally {
        deadline.cancel()
      }
      threadId = started.thread.id
      route.rootThreadId = threadId
      createdNewThread = true
      routeRegistration.addThread(threadId)
      // Isolated: create a durable tombstone as soon as the remote ID exists; finally hard-deletes it.
      if (args.ephemeralSession) {
        queueCodexThreadCleanup(args.conversationId, threadId, threadAccountId)
      }
      chatDiag({
        kind: 'codex-subscription-tools-profile',
        mode: args.mode,
        model: args.selection.modelId,
        tools: toolProfile,
      })
      break
    }
    if (args.signal.aborted) {
      if (createdNewThread) {
        await retireCodexThread(args.conversationId, threadId, threadAccountId)
        threadDisposed = true
      }
      throw new Error('Turn aborted before Codex turn/start')
    }
    const lifecycleAccepted =
      args.onThreadReady?.(threadId, { providerId: currentProviderId, accountId: threadAccountId }) ?? true
    if (!lifecycleAccepted) {
      await retireCodexThread(args.conversationId, threadId, threadAccountId)
      threadDisposed = true
      throw new Error('Codex thread was discarded because the conversation is being closed')
    }

    const progress = new Map<string, string>()
    const startedText = new Set<string>()
    const startedReasoning = new Set<string>()
    let latestUsage: TokenUsageNotification | null = null
    let initialContextProfileLogged = false
    let lastReportedContextWindow = 0
    let turnId = ''
    let rootAttemptActive = false
    let portableCompactionRequested = false
    let portableInterruptPromise: Promise<void> | null = null
    let nativeCompactionActive = false
    let inTurnCompactions = 0
    const carriedMainUsage = { totalInput: 0, cachedInput: 0, cacheCreate: 0, output: 0 }
    const carryCurrentAttemptUsage = (notification: TokenUsageNotification | null): void => {
      if (!notification) return
      const total = usageTotals(notification.tokenUsage.total)
      carriedMainUsage.totalInput += nonNegativeDifference(total.inputTokens, baseline.inputTokens)
      carriedMainUsage.cachedInput += nonNegativeDifference(total.cachedInputTokens, baseline.cachedInputTokens)
      carriedMainUsage.output += nonNegativeDifference(total.outputTokens, baseline.outputTokens)
    }
    const carryCompactorUsage = (compacted: NormalizedAiUsage | undefined): void => {
      if (!compacted) return
      const cachedInput = Math.max(0, Number(compacted.cacheRead) || 0)
      const cacheCreate = Math.max(0, Number(compacted.cacheCreate) || 0)
      const totalInput = Math.max(
        Math.max(0, Number(compacted.totalInput) || 0),
        Math.max(0, Number(compacted.input) || 0) + cachedInput + cacheCreate
      )
      carriedMainUsage.totalInput += totalInput
      carriedMainUsage.cachedInput += cachedInput
      carriedMainUsage.cacheCreate += cacheCreate
      carriedMainUsage.output += Math.max(0, Number(compacted.output) || 0)
    }
    const mainUsage = (notification: TokenUsageNotification | null): ChatUsage | undefined => {
      const current = toChatUsage(notification, baseline)
      if (
        !carriedMainUsage.totalInput &&
        !carriedMainUsage.cachedInput &&
        !carriedMainUsage.cacheCreate &&
        !carriedMainUsage.output
      ) {
        return current
      }
      return {
        ...(current ?? { usageVersion: 2 as const, input: 0, output: 0 }),
        input:
          (current?.input ?? 0) +
          Math.max(0, carriedMainUsage.totalInput - carriedMainUsage.cachedInput - carriedMainUsage.cacheCreate),
        output: (current?.output ?? 0) + carriedMainUsage.output,
        ...(carriedMainUsage.cachedInput + (current?.cachedInput ?? 0) > 0
          ? { cachedInput: carriedMainUsage.cachedInput + (current?.cachedInput ?? 0) }
          : {}),
        ...(carriedMainUsage.cacheCreate + (current?.cacheCreate ?? 0) > 0
          ? { cacheCreate: carriedMainUsage.cacheCreate + (current?.cacheCreate ?? 0) }
          : {}),
      }
    }
    const exhaustionSource = (
      classification: Extract<CodexQuotaClassification, { kind: 'quota' }>
    ): 'structured-error' | 'rate-limits' | 'usage-limit-marker' => {
      if (classification.confidence === 'structured') return 'structured-error'
      if (classification.confidence === 'rate-limits-confirmed') return 'rate-limits'
      return 'usage-limit-marker'
    }
    const classifyQuotaForFailover = async (error: unknown): Promise<CodexQuotaClassification> => {
      return classifyCodexQuotaFailureWithRateLimits(error, () =>
        getCodexSubscriptionManager(threadAccountId).getRateLimits(true)
      )
    }
    const markUnfinishedToolsInterrupted = (): void => {
      for (const part of messages[0].parts) {
        if (part.type !== 'tool') continue
        if (
          part.state.status !== 'running' &&
          part.state.status !== 'pending' &&
          part.state.status !== 'awaiting-permission'
        ) {
          continue
        }
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: part.toolCallId,
          state: { status: 'error', error: 'Interrupted by account failover' },
        })
      }
    }
    const hasAssistantOutput = (): boolean =>
      messages[0].parts.some((part) => {
        if (part.type === 'text') return part.text.trim().length > 0
        if (part.type === 'reasoning') return part.text.trim().length > 0
        return part.type === 'tool' || part.type === 'generated-image' || part.type === 'compaction'
      })
    const emitAccountsExhausted = (usage?: ChatUsage, reason?: string): void => {
      apply(
        {
          kind: 'error',
          messageId: assistantId,
          message:
            reason?.trim() || 'All Codex subscription accounts in the failover chain are exhausted. Try again later.',
          code: 'codex-accounts-exhausted',
          usage,
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    }
    const rebindRouteAndNotifications = (seedThreadId: string): void => {
      routeRegistration.remove()
      route.closed = false
      route.rootThreadId = seedThreadId
      routeRegistration = registerRequestRoute(currentClient, seedThreadId, route)
      offNotification()
      offNotification = currentClient.onNotification(handleRootNotification)
    }
    let handleRootNotification!: (notification: CodexNotification) => void

    let planStopArmed = false
    state.requestTurnStop = () => {
      // The dynamic tool must receive JSON-RPC success before interruption. `setImmediate` runs only after
      // handleServerRequest returns and the client writes the tool response to app-server stdio.
      setImmediate(() => {
        planStopArmed = true
        managedTaskRecoveryStop.abort()
        if (threadId && turnId) void currentClient.interruptTurn({ threadId, turnId }).catch(() => {})
      })
    }
    let startRequested = false
    let settle!: (value: TurnCompletedParams) => void
    let completed!: Promise<TurnCompletedParams>
    let rootCompletionCleanupStarted = false
    let rootCompletionDecisionStarted = false
    let rootCompletedClassification: CodexQuotaClassification | null = null
    let rootCompletedParams: TurnCompletedParams | null = null
    const resetRootCompletion = (): void => {
      rootCompletionCleanupStarted = false
      rootCompletionDecisionStarted = false
      rootCompletedClassification = null
      rootCompletedParams = null
      completed = new Promise<TurnCompletedParams>((resolve) => {
        settle = resolve
      })
    }
    resetRootCompletion()
    let activeThreadIds = new Set([threadId])
    const childModels = new Map<string, string>()
    const childUsage = new Map<string, SubagentUsageState>()
    const childParents = new Map<string, string>()
    const childTurnIds = new Map<string, string>()
    const terminalChildThreads = new Set<string>()
    const persistedChildThreads = new Map<string, boolean>()
    const deletedChildThreads = new Set<string>()
    const cleanedChildThreads = new Set<string>()
    const managedChildThreads = new Set<string>()
    const childStateWaiters = new Map<string, Set<() => void>>()
    const childStopPromises = new Map<string, Promise<void>>()
    const childDeletionPromises = new Map<string, Promise<void>>()
    const collabStartedAt = new Map<string, number>()
    const resolvedTaskProfiles = new Map<string, ReturnType<typeof resolveSubagentExecutionProfile>>()
    let activeManagedTasks = 0
    let maestroGuardRequired = false
    const managedTaskWaiters = new Set<() => void>()
    const notifyManagedTasksSettled = (): void => {
      if (activeManagedTasks) return
      for (const wake of managedTaskWaiters) wake()
      managedTaskWaiters.clear()
    }
    const waitForManagedTaskRecovery = (): Promise<void> => {
      if (!activeManagedTasks || managedTaskRecoverySignal.aborted) return Promise.resolve()
      // A quota failure ends the provider turn, not the host task. Children may still be
      // finishing tools or continuing on another account. Their runtime/abort owns that
      // lifetime; the shutdown deadline starts only once recovery finishes or is stopped.
      return new Promise<void>((resolve) => {
        const wake = (): void => {
          managedTaskWaiters.delete(wake)
          managedTaskRecoverySignal.removeEventListener('abort', wake)
          resolve()
        }
        managedTaskWaiters.add(wake)
        managedTaskRecoverySignal.addEventListener('abort', wake, { once: true })
      })
    }
    const waitForManagedTasks = (deadline: number): Promise<void> => {
      if (!activeManagedTasks) return Promise.resolve()
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return Promise.reject(new Error('Timed out waiting for managed Codex tasks to stop'))
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const cleanup = (): void => {
          managedTaskWaiters.delete(wake)
          clearTimeout(timer)
        }
        const wake = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('Timed out waiting for managed Codex tasks to stop'))
        }, remainingMs)
        timer.unref()
        managedTaskWaiters.add(wake)
      })
    }
    const notifyChildStateChanged = (childThreadId: string): void => {
      const waiters = childStateWaiters.get(childThreadId)
      if (!waiters) return
      childStateWaiters.delete(childThreadId)
      for (const wake of waiters) wake()
    }
    const markChildTerminal = (childThreadId: string): void => {
      terminalChildThreads.add(childThreadId)
      childTurnIds.delete(childThreadId)
      notifyChildStateChanged(childThreadId)
    }
    const registerChildThread = (
      id: unknown,
      model: unknown = null,
      parent: unknown = threadId,
      persisted?: boolean,
      runtimes?: DynamicToolRuntime[]
    ): boolean => {
      if (typeof id !== 'string' || !id || id === threadId) return false
      if (!routeRegistration.addThread(id, runtimes)) return false
      activeThreadIds.add(id)
      if (typeof parent === 'string' && parent && parent !== id) childParents.set(id, parent)
      if (typeof persisted === 'boolean') persistedChildThreads.set(id, persisted)
      if (typeof model === 'string' && model) {
        childModels.set(id, model)
        const usage = childUsage.get(id)
        if (usage) usage.modelId = model
      }
      return true
    }
    const selectableAgentNames = dynamic.agents.map((agent) => agent.name)
    const subagentTurnState = createExplicitSubagentTurnState(
      detectExplicitSubagentsForTurn(history, selectableAgentNames),
      selectableAgentNames
    )
    state.runTask = async (input, toolCallId, signal, update) => {
      let agentName = isRecord(input) && typeof input.agent === 'string' ? input.agent.trim() : ''
      let task = isRecord(input) && typeof input.prompt === 'string' ? input.prompt.trim() : ''
      const maestroPrepared =
        args.mode === 'maestro' && args.maestro
          ? await prepareMaestroDelegation({
              input,
              turn: args.maestro,
              parent: { ...args.selection, effort: currentReasoningEffort || 'off' },
              parentFastMode: args.fastMode,
              turnState: subagentTurnState,
              delegationId: toolCallId,
              owner: { conversationId: args.conversationId, parentMessageId: assistantId },
            })
          : undefined
      if (maestroPrepared) {
        agentName = maestroPrepared.agentName
        task = maestroPrepared.task
      }
      if (!agentName || !task) throw new Error('task requires non-empty agent and prompt fields')
      // Agent selection is semantic and happens before execution-profile resolution.
      // Execution routing is host-managed and keyed by the selected agent name.
      // A role mentioned inside task.prompt must never alter profile resolution.
      if (!maestroPrepared) {
        assertSubagentSelection({
          state: subagentTurnState,
          selectedAgent: agentName,
          availableAgents: dynamic.agents.map((agent) => agent.name),
          runtime: 'codex-subscription',
          conversationId: args.conversationId,
        })
        recordSubagentDispatch(subagentTurnState, agentName)
      }
      const executeResolvedTask = async (
        signal: AbortSignal,
        externalRecorder?: import('../subagent-session').SubagentSessionRecorder,
        background = false
      ): Promise<DynamicToolExecutionResult> => {
        const updateState = background ? () => undefined : update
        // Async Maestro delegations are owned by the delegation registry after `delegate` returns its handle.
        // They must not block the current Codex RPC from settling: the host guard below waits for them and then
        // opens a continuation turn. Foreground `task` calls remain part of the RPC teardown barrier.
        if (!background) activeManagedTasks += 1
        try {
          const startedAt = Date.now()
          const lines: string[] = []
          let resolved = resolvedTaskProfiles.get(toolCallId)
          if (!resolved) {
            resolved = maestroPrepared
              ? Promise.resolve({
                  definition: dynamic.agents.find((agent) => agent.name === agentName) ?? null,
                  profile: maestroPrepared.execution.profile,
                })
              : resolveSubagentExecutionProfile({
                  agentName,
                  agents: dynamic.agents,
                  conversationId: args.conversationId,
                  parentFastMode: args.fastMode,
                  parent: {
                    ...args.selection,
                    effort: currentReasoningEffort || 'off',
                  },
                })
            resolvedTaskProfiles.set(toolCallId, resolved)
          }
          const { definition, profile } = await resolved
          const sessionRecorder =
            externalRecorder ??
            createSubagentSessionRecorder({
              conversationId: args.conversationId,
              parentMessageId: assistantId,
              toolCallId,
              origin: args.mode === 'maestro' ? 'delegate' : 'task',
              agentName,
              task,
              profile,
              maestro: maestroPrepared?.execution.snapshot,
              startedAt,
            })
          const meta = (
            usage?: NormalizedAiUsage,
            final = false,
            runtimeEstimatedCostUsd?: number
          ): SubagentRunMeta => ({
            profile,
            ...(maestroPrepared ? { maestro: maestroPrepared.execution.snapshot } : {}),
            startedAt,
            sessionId: sessionRecorder.id,
            ...(sessionRecorder.summary()?.phase ? { phase: sessionRecorder.summary()!.phase } : {}),
            ...(sessionRecorder.summary()?.lastActivityAt
              ? { lastActivityAt: sessionRecorder.summary()!.lastActivityAt }
              : {}),
            ...(usage
              ? {
                  usage: {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheCreate: usage.cacheCreate,
                  },
                }
              : {}),
            ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
            ...(final ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
          })
          updateState({ sub: meta() })
          if (!definition || !profile.effective) {
            const sub = meta(undefined, true)
            updateState({ sub })
            sessionRecorder.complete({
              status: 'failed',
              error: `Subagent "${agentName}" has no runnable execution profile.`,
            })
            return { output: '', error: `Subagent "${agentName}" has no runnable execution profile.`, sub }
          }
          let lease: SubagentLease | null = null
          let maestroWorkerRuntime: MaestroWorkerToolRuntime | null = null
          try {
            maestroWorkerRuntime =
              args.mode === 'maestro'
                ? await buildMaestroWorkerTools({
                    conversationId: args.conversationId,
                    projectId: args.projectId,
                    cwd: args.cwd,
                    parentMessageId: assistantId,
                    delegationId: maestroPrepared?.execution.snapshot.delegationId ?? toolCallId,
                    label: maestroPrepared?.execution.snapshot.resource.label ?? agentName,
                    profile,
                    broker: args.broker,
                    signal,
                    emitGeneratedImage: state.emitGeneratedImage,
                    onGeneratedImageUsage: state.onGeneratedImageUsage,
                    generateImage: state.generateImage,
                  })
                : null
            const effectiveProfile = profile.effective
            const childMeta = isClaudeSubscriptionProvider(profile.effective.providerId)
              ? { meta: { vision: true } }
              : await getSubagentProfileModelMeta(profile.effective.providerId, profile.effective.modelId).catch(
                  () => ({
                    meta: null,
                  })
                )
            const supportsImages = supportsChatToolImages({
              modelVision: childMeta.meta?.vision,
              unknownVision: 'unsupported',
              imageInterpreterConfigured: hasConfiguredImageInterpreter(),
            })
            const inheritedChildTools = Object.fromEntries(
              Object.entries(childToolSet(signal, supportsImages)).filter(
                ([name]) => args.mode !== 'maestro' || name !== 'use_skill'
              )
            ) as ToolSet
            const childTools: ToolSet = sessionRecorder.instrumentTools({
              ...inheritedChildTools,
              ...(maestroWorkerRuntime?.tools ?? {}),
            })
            const namespacedChildTools = namespaceSubagentToolSet(childTools, toolCallId)
            const childDeferredToolNames = new Set([
              ...dynamic.deferredToolNames,
              ...(maestroWorkerRuntime?.deferredToolNames ?? []),
            ])
            const allChildRuntimes = await toolSetRuntimes(namespacedChildTools, childDeferredToolNames)
            const childSpecs = allChildRuntimes.map((runtime) => runtime.spec)
            const claudeSubagentTools = asClaudeTools(allChildRuntimes, signal, supportsImages)
            const progress = (line: string): void => {
              lines.push(line)
              sessionRecorder.phase(line.startsWith('Starting subagent') ? 'model-started' : line)
              updateState({ output: lines.slice(-12).join('\n'), sub: meta() })
            }
            const onTextUpdate = (textUpdate: import('../subagent-text-stream').SubagentTextUpdate): void => {
              sessionRecorder.text(textUpdate)
            }
            const codexReadOnly =
              args.mode === 'maestro' ? false : isSubagentReadOnly(args.mode, definition.tools, childTools)
            const childToolNames =
              args.mode === 'maestro'
                ? new Set(Object.keys(namespacedChildTools).filter(isMaestroWorkerOperationalToolName))
                : selectSubagentToolNames({
                    definition,
                    readOnly: codexReadOnly,
                    providedHostTools: namespacedChildTools,
                  })
            const effectiveDefinition: ChatAgent =
              args.mode === 'maestro'
                ? {
                    ...definition,
                    tools: [...childToolNames],
                    prompt: [definition.prompt, maestroWorkerRuntime?.skillCatalog].filter(Boolean).join('\n\n'),
                  }
                : definition
            const nativeCodex = isCodexSubscriptionProvider(profile.effective.providerId)
            const nativeClaude = isClaudeSubscriptionProvider(profile.effective.providerId)
            const nativeCopilot = isGitHubCopilotSubscriptionProvider(profile.effective.providerId)
            lease = await state.subagentCoordinator.acquire({ agent: agentName, signal })
            const childApproval = approvalConfig(codexReadOnly ? 'plan' : 'agent', args.permMode)
            // Maestro continuity (same semantics as subagent-executor): reopen this agent's previous native thread
            // when provider/account/tools match; otherwise recreate it with the report injected.
            const persistRuntime = args.mode === 'maestro'
            const resumedFrom = maestroPrepared?.execution.snapshot.resumedFrom
            const resumeSource: SubagentResumeSource | null = resumedFrom
              ? (resolveSubagentResume(resumedFrom) ?? {
                  sessionId: resumedFrom,
                  agentName,
                  handle: null,
                  lastReport: '',
                  replay: [],
                })
              : null
            let resumeOutcomeRecorded = false
            const recordResume = (status: 'resumed' | 'recreated', reason?: string): void => {
              if (resumeOutcomeRecorded) return
              resumeOutcomeRecorded = true
              sessionRecorder.resumeOutcome(status, reason)
            }
            const resumeFor = (
              providerId: string,
              accountId: string | null,
              toolSignature?: string,
              claudeContract?: { modelId: string; behaviorProfileId: string | null; runtimeSignature: string }
            ): {
              task: string
              handle: SubagentRuntimeHandle | null
              fallbackTask: string
              replay?: SubagentReplayMessage[]
            } => {
              if (!resumeSource) return { task, handle: null, fallbackTask: task }
              const fallback = (reason: SubagentResumeRecreateReason) => recreatedTask(task, resumeSource, reason)
              const plan = planSubagentResume({
                providerId,
                accountId,
                toolSignature,
                ...claudeContract,
                resume: resumeSource,
              })
              if (plan.mode === 'recreate') {
                recordResume('recreated', plan.reason)
                return { task: fallback(plan.reason), handle: null, fallbackTask: fallback(plan.reason) }
              }
              if (plan.mode === 'replay') return { task, handle: null, fallbackTask: task, replay: plan.history }
              return { task, handle: plan.handle, fallbackTask: fallback('resume-rejected') }
            }
            const settleResume = (outcome: { resumed?: boolean; resumeReason?: string }): void => {
              if (!resumeSource) return
              if (outcome.resumed) recordResume('resumed')
              else recordResume('recreated', outcome.resumeReason ?? 'resume-rejected')
            }
            const result = nativeCodex
              ? await (async () => {
                  const logicalProviderId = profile.effective!.providerId
                  const chain = freezeFailoverChain(logicalProviderId)
                  const attempted = new Set<string>()
                  const accumulatedUsage = EMPTY_NORMALIZED_USAGE()
                  let checkpoint: CodexSubagentCheckpoint | undefined
                  let previousExhausted: { providerId: string; reason: string; resetsAt?: number | null } | null = null
                  let lastPartialText = ''
                  const router = getSubscriptionFailoverRouter()
                  const childDynamicTools = childSpecs.filter(
                    (spec) =>
                      spec.name !== 'task' &&
                      spec.name !== 'delegate' &&
                      spec.name !== 'review_plan' &&
                      childToolNames.has(spec.name)
                  )
                  const childRuntimes = allChildRuntimes.filter(
                    (runtime) =>
                      runtime.spec.name !== 'task' &&
                      runtime.spec.name !== 'delegate' &&
                      runtime.spec.name !== 'review_plan' &&
                      childToolNames.has(runtime.spec.name)
                  )
                  const classifySubagentQuota = async (error: unknown, physicalProviderId: string) => {
                    return classifyCodexQuotaFailureWithRateLimits(error, () =>
                      getCodexSubscriptionManager(subscriptionAccountId(physicalProviderId)).getRateLimits(true)
                    )
                  }

                  while (true) {
                    if (signal.aborted) {
                      throw Object.assign(new Error('Subagent aborted'), {
                        subagentUsage: accumulatedUsage,
                        subagentModel: {
                          providerId: logicalProviderId,
                          modelId: profile.effective!.modelId,
                        },
                      })
                    }

                    const resolvedTarget = await resolveCodexRuntimeTarget({
                      logicalProviderId,
                      modelId: profile.effective!.modelId,
                      reasoningEffort:
                        profile.effective!.configuredEffort && profile.effective!.configuredEffort !== 'off'
                          ? profile.effective!.configuredEffort
                          : profile.effective!.sentEffort && profile.effective!.sentEffort !== 'off'
                            ? profile.effective!.sentEffort
                            : undefined,
                      fastMode: effectiveProfile.fastMode === true,
                      astraHarnessEnabled: astraHarnessEnabledAtAdmission,
                      chain,
                      attemptedProviderIds: attempted,
                      signal,
                    })
                    if (!resolvedTarget.ok) {
                      const usage =
                        accumulatedUsage.totalInput || accumulatedUsage.output ? accumulatedUsage : undefined
                      return {
                        text: lastPartialText,
                        error:
                          resolvedTarget.error === 'aborted'
                            ? 'Subagent aborted'
                            : resolvedTarget.reason === 'quota-exhausted'
                              ? 'All Codex subscription accounts in the failover chain are exhausted for this task.'
                              : resolvedTarget.message,
                        ...(usage ? { usage } : {}),
                        model: { providerId: logicalProviderId, modelId: profile.effective!.modelId },
                      }
                    }

                    const target = resolvedTarget.target
                    attempted.add(target.providerId)
                    let settled = false
                    const settle = (
                      result: 'success' | 'quota' | 'other',
                      exhaustionInfo?: Parameters<typeof router.confirmAttemptQuota>[2]
                    ): void => {
                      if (settled) return
                      settled = true
                      if (result === 'success') {
                        router.confirmAttemptSuccess(target.providerId, target.availabilityLease)
                      } else if (result === 'quota') {
                        router.confirmAttemptQuota(target.providerId, target.availabilityLease, exhaustionInfo!)
                      } else if (target.availabilityLease) {
                        router.confirmAttemptOther(target.providerId, target.availabilityLease)
                      }
                    }

                    const useSharedRootClient = target.client === currentClient
                    let registration: ReturnType<typeof registerCodexSubagentRequestRoute> | null = null
                    try {
                      if (signal.aborted) throw new Error('Subagent aborted')
                      if (previousExhausted) {
                        progress(
                          `${failoverAccountLabel(previousExhausted.providerId)} hit limit; continuing on ${failoverAccountLabel(target.providerId)}`
                        )
                        args.onFailoverTransition?.({
                          scope: 'subagent',
                          fromProviderId: previousExhausted.providerId,
                          toProviderId: target.providerId,
                          reason: previousExhausted.reason,
                          resetsAt: previousExhausted.resetsAt ?? null,
                        })
                        previousExhausted = null
                      }
                      args.acquirePhysicalProvider?.(target.providerId)
                      const childToolSignature = subagentToolSignature(childDynamicTools)
                      const resume = resumeFor(logicalProviderId, target.accountId, childToolSignature)
                      const attemptTask = buildSubagentContinuationPrompt(resume.task, checkpoint)
                      if (!useSharedRootClient) {
                        registration = registerCodexSubagentRequestRoute({
                          client: target.client,
                          conversationId: args.conversationId,
                          projectId: args.projectId,
                          messageId: assistantId,
                          broker: args.broker,
                          questionBroker: args.questionBroker,
                          runtimes: childRuntimes,
                          signal,
                          mode: codexReadOnly ? 'plan' : 'agent',
                        })
                      }
                      const attempt = await runCodexSubagent({
                        client: target.client,
                        cwd: args.cwd,
                        profile,
                        definition: effectiveDefinition,
                        signal,
                        agentName,
                        task: attemptTask,
                        readOnly: codexReadOnly,
                        serviceTier: target.serviceTier ?? 'default',
                        approvalPolicy: childApproval.approvalPolicy,
                        sandboxPolicy: sandboxPolicyFor(childApproval.sandbox, args.cwd),
                        dynamicTools: childDynamicTools,
                        physicalProviderId: target.providerId,
                        accountId: target.accountId,
                        registerThread: useSharedRootClient
                          ? (childThreadId, modelId) => {
                              managedChildThreads.add(childThreadId)
                              const registered = registerChildThread(
                                childThreadId,
                                modelId,
                                threadId,
                                false,
                                childRuntimes
                              )
                              if (!registered) managedChildThreads.delete(childThreadId)
                              return registered
                            }
                          : (childThreadId) => registration!.addThread(childThreadId),
                        removeThread: useSharedRootClient
                          ? (childThreadId, terminal) => {
                              managedChildThreads.delete(childThreadId)
                              if (terminal) {
                                markChildTerminal(childThreadId)
                                activeThreadIds.delete(childThreadId)
                              }
                              routeRegistration.removeThread(childThreadId)
                            }
                          : (childThreadId) => registration!.removeThread(childThreadId),
                        progress,
                        onTextUpdate,
                        persistRuntime,
                        ...(resume.handle?.kind === 'codex-thread'
                          ? { resume: { threadId: resume.handle.threadId, fallbackTask: resume.fallbackTask } }
                          : {}),
                        onThreadStarted: ({ threadId: childThreadId }) => {
                          if (!persistRuntime) return
                          sessionRecorder.runtimeHandle({
                            kind: 'codex-thread',
                            threadId: childThreadId,
                            accountId: target.accountId,
                            toolSignature: childToolSignature,
                          })
                          queueCodexThreadCleanup(args.conversationId, childThreadId, target.accountId)
                        },
                      })
                      settleResume(attempt)
                      addNormalizedSubagentUsage(accumulatedUsage, attempt.usage)
                      if (!useSharedRootClient && attempt.usage) {
                        // Token notifications for a foreign app-server never hit the root childUsage map.
                        recordExternalSubagentUsage(
                          {
                            providerId: logicalProviderId,
                            modelId: profile.effective!.modelId,
                          },
                          attempt.usage
                        )
                      }
                      if (!attempt.error) {
                        settle('success')
                      } else {
                        settle('other')
                      }
                      return {
                        ...attempt,
                        usage:
                          accumulatedUsage.totalInput || accumulatedUsage.output
                            ? { ...accumulatedUsage }
                            : attempt.usage,
                        model: attempt.model ?? {
                          providerId: target.providerId,
                          modelId: profile.effective!.modelId,
                        },
                      }
                    } catch (error) {
                      if (signal.aborted) {
                        settle('other')
                        throw Object.assign(error instanceof Error ? error : new Error(errorMessage(error)), {
                          subagentUsage: accumulatedUsage,
                          subagentModel: {
                            providerId: target.providerId,
                            modelId: profile.effective!.modelId,
                          },
                        })
                      }

                      let quotaError: CodexSubagentQuotaError | null =
                        error instanceof CodexSubagentQuotaError ? error : null
                      const classification = await classifySubagentQuota(error, target.providerId)
                      if (!quotaError && classification.kind === 'quota') {
                        quotaError = new CodexSubagentQuotaError(classification.message, {
                          text: '',
                          physicalProviderId: target.providerId,
                          accountId: target.accountId,
                          model: { providerId: target.providerId, modelId: profile.effective!.modelId },
                        })
                      }

                      if (!quotaError) {
                        settle('other')
                        if (error instanceof Error && 'subagentUsage' in error) {
                          addNormalizedSubagentUsage(
                            accumulatedUsage,
                            (error as Error & { subagentUsage?: NormalizedAiUsage }).subagentUsage
                          )
                          ;(error as Error & { subagentUsage?: NormalizedAiUsage }).subagentUsage = {
                            ...accumulatedUsage,
                          }
                        }
                        throw error
                      }

                      addNormalizedSubagentUsage(accumulatedUsage, quotaError.partial.usage)
                      checkpoint = mergeSubagentCheckpoints(checkpoint, quotaError.partial.checkpoint)
                      if (quotaError.partial.text) lastPartialText = quotaError.partial.text
                      if (!useSharedRootClient && quotaError.partial.usage) {
                        recordExternalSubagentUsage(
                          {
                            providerId: logicalProviderId,
                            modelId: profile.effective!.modelId,
                          },
                          quotaError.partial.usage
                        )
                      }
                      const quotaClassification =
                        classification.kind === 'quota'
                          ? classification
                          : {
                              kind: 'quota' as const,
                              confidence: 'strong-marker' as const,
                              message: quotaError.message,
                            }
                      const source = exhaustionSource(quotaClassification)
                      const exhaustionInfo = {
                        reason: quotaClassification.message,
                        source,
                        resetsAt: quotaClassification.resetsAt ?? null,
                      }
                      settle('quota', exhaustionInfo)
                      previousExhausted = {
                        providerId: target.providerId,
                        reason: quotaClassification.message,
                        resetsAt: quotaClassification.resetsAt ?? null,
                      }
                      // Continue the loop to resolve the next physical target. Do not cancel sibling
                      // subagents still running on the exhausted account.
                    } finally {
                      settle('other')
                      registration?.remove()
                      args.releasePhysicalProvider?.(target.providerId)
                    }
                  }
                })()
              : nativeClaude
                ? await (async () => {
                    const manager = getClaudeSubscriptionManager(subscriptionAccountId(profile.effective!.providerId))
                    const status = await manager.status({ refresh: true })
                    if (!status.authenticated || !status.accountFingerprint) {
                      return { text: '', error: 'Claude subscription is not authenticated.' }
                    }
                    const accountId = manager.accountId ?? null
                    let resolvedModelId: string | undefined
                    if (profile.effective!.modelId.trim() === 'fable') {
                      try {
                        resolvedModelId =
                          (await manager.resolveModelId(profile.effective!.modelId, signal, true)) ?? undefined
                      } catch {
                        return { text: '', error: 'Claude Fable alias could not be resolved.' }
                      }
                    }
                    const behaviorProfile = resolveFableBehaviorProfile({
                      requestedModelId: profile.effective!.modelId,
                      resolvedModelId,
                      enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
                    }).profile
                    const runtimeModelId = resolvedModelId ?? profile.effective!.modelId
                    const runtimeSignature = claudeSubagentRuntimeSignature({
                      modelId: runtimeModelId,
                      behaviorProfileId: behaviorProfile?.id ?? null,
                      prompt: effectiveDefinition.prompt,
                      readOnly: codexReadOnly,
                      sentEffort: profile.effective!.sentEffort,
                      fastMode: profile.effective!.fastMode === true,
                      toolNames: [...childToolNames],
                    })
                    const resume = resumeFor(profile.effective!.providerId, accountId, undefined, {
                      modelId: runtimeModelId,
                      behaviorProfileId: behaviorProfile?.id ?? null,
                      runtimeSignature,
                    })
                    const outcome = await runClaudeSubagent({
                      manager,
                      accountIdentity: {
                        fingerprint: status.accountFingerprint,
                        epoch: status.accountEpoch,
                      },
                      conversationId: args.conversationId,
                      cwd: args.cwd,
                      profile,
                      ...(resolvedModelId ? { resolvedModelId } : {}),
                      behaviorProfile,
                      definition: effectiveDefinition,
                      signal,
                      agentName,
                      task: resume.task,
                      readOnly: codexReadOnly,
                      tools: claudeSubagentTools,
                      allowSkillLoader: args.mode === 'maestro',
                      progress,
                      onTextUpdate,
                      persistRuntime,
                      ...(resume.handle?.kind === 'claude-session'
                        ? { resume: { sessionId: resume.handle.sessionId, fallbackTask: resume.fallbackTask } }
                        : {}),
                      onSessionStarted: ({ sessionId }) => {
                        if (!persistRuntime) return
                        sessionRecorder.runtimeHandle({
                          kind: 'claude-session',
                          sessionId,
                          cwd: args.cwd,
                          accountId,
                          modelId: runtimeModelId,
                          behaviorProfileId: behaviorProfile?.id ?? null,
                          runtimeSignature,
                        })
                        queueClaudeSessionCleanup(args.conversationId, sessionId, args.cwd, accountId)
                      },
                    })
                    settleResume(outcome)
                    return outcome
                  })()
                : nativeCopilot
                  ? await (async () => {
                      const manager = getGitHubCopilotSubscriptionManager(
                        subscriptionAccountId(profile.effective!.providerId)
                      )
                      const identity = manager.getAccountIdentity()
                      if (!identity.fingerprint) {
                        return { text: '', error: 'GitHub Copilot subscription is not authenticated.' }
                      }
                      return runGitHubCopilotSubagent({
                        manager,
                        accountIdentity: identity,
                        conversationId: args.conversationId,
                        cwd: args.cwd,
                        profile,
                        definition: effectiveDefinition,
                        signal,
                        agentName,
                        task: resumeFor(profile.effective!.providerId, null).task,
                        readOnly: codexReadOnly,
                        tools: await copilotTools(
                          Object.fromEntries(
                            Object.entries(namespacedChildTools).filter(([name]) => childToolNames.has(name))
                          ),
                          signal,
                          childDeferredToolNames
                        ),
                        allowSkillLoader: args.mode === 'maestro',
                        progress,
                        onTextUpdate,
                      })
                    })()
                  : await (async () => {
                      // BYOK: without a server-side session, resume replays the previous turn as history.
                      const resume = resumeFor(profile.effective!.providerId, null)
                      const outcome = await runSubagent({
                        cwd: args.cwd,
                        projectId: args.projectId,
                        conversationId: args.conversationId,
                        parentMessageId: assistantId,
                        toolCallId,
                        profile,
                        definition: effectiveDefinition,
                        broker: args.broker,
                        signal,
                        agentName,
                        task: resume.task,
                        ...(resume.replay ? { replayHistory: resume.replay } : {}),
                        progress,
                        onTextUpdate,
                        readOnly: codexReadOnly,
                        tools: childTools,
                        allowSkillLoader: args.mode === 'maestro',
                      })
                      if (resume.replay) settleResume({ resumed: true })
                      return outcome
                    })()
            const runtimeEstimatedCostUsd = (result as { runtimeEstimatedCostUsd?: number }).runtimeEstimatedCostUsd
            if (
              result.model &&
              !isCodexSubscriptionProvider(result.model.providerId) &&
              (result.usage || runtimeEstimatedCostUsd != null)
            ) {
              recordExternalSubagentUsage(result.model, result.usage, runtimeEstimatedCostUsd)
            }
            const sub = meta(result.usage, true, runtimeEstimatedCostUsd)
            updateState({ output: lines.slice(-12).join('\n'), sub })
            sessionRecorder.complete({
              status: result.error ? 'failed' : 'completed',
              usage: result.usage,
              runtimeEstimatedCostUsd,
              ...(result.error ? { error: result.error } : {}),
            })
            return result.error
              ? { output: result.text, error: `Subagent "${agentName}" failed: ${result.error}`, sub }
              : { output: result.text, sub }
          } catch (error) {
            const withUsage = error as Error & {
              subagentUsage?: NormalizedAiUsage
              subagentModel?: ChatModelRef
              subagentRuntimeEstimatedCostUsd?: number
            }
            if (
              withUsage.subagentModel &&
              !isCodexSubscriptionProvider(withUsage.subagentModel.providerId) &&
              (withUsage.subagentUsage || withUsage.subagentRuntimeEstimatedCostUsd != null)
            ) {
              recordExternalSubagentUsage(
                withUsage.subagentModel,
                withUsage.subagentUsage,
                withUsage.subagentRuntimeEstimatedCostUsd
              )
            }
            const sub = meta(withUsage.subagentUsage, true, withUsage.subagentRuntimeEstimatedCostUsd)
            updateState({ output: lines.slice(-12).join('\n'), sub })
            sessionRecorder.complete({
              status: signal.aborted ? 'cancelled' : 'failed',
              usage: withUsage.subagentUsage,
              runtimeEstimatedCostUsd: withUsage.subagentRuntimeEstimatedCostUsd,
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          } finally {
            lease?.release()
            await maestroWorkerRuntime?.close()
          }
        } finally {
          if (!background) {
            activeManagedTasks = Math.max(0, activeManagedTasks - 1)
            notifyManagedTasksSettled()
          }
        }
      }
      if (maestroPrepared) {
        maestroGuardRequired = true
        return startMaestroDelegation({
          conversationId: args.conversationId,
          parentMessageId: assistantId,
          toolCallId,
          agentName,
          task,
          profile: maestroPrepared.execution.profile,
          maestro: maestroPrepared.execution.snapshot,
          parentSignal: signal,
          maestroLive: args.maestroLive,
          execute: (workSignal, sessionRecorder) => executeResolvedTask(workSignal, sessionRecorder, true),
        })
      }
      return executeResolvedTask(signal)
    }
    const inspectItem = (item: Record<string, unknown>): void => {
      if (typeof item.id === 'string' && item.type === 'commandExecution' && typeof item.command === 'string') {
        itemResources.set(item.id, commandSegments(item.command))
      }
      if (typeof item.id === 'string' && item.type === 'fileChange' && Array.isArray(item.changes)) {
        const paths = item.changes
          .filter(isRecord)
          .map((change) => change.path)
          .filter((path): path is string => typeof path === 'string' && Boolean(path))
        if (paths.length) itemResources.set(item.id, [...new Set(paths)])
      }
      if (item.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds)) {
        if (typeof item.id === 'string' && !collabStartedAt.has(item.id)) collabStartedAt.set(item.id, Date.now())
        for (const receiver of item.receiverThreadIds) registerChildThread(receiver, item.model, item.senderThreadId)
        if (isRecord(item.agentsStates)) {
          for (const [agentThreadId, rawState] of Object.entries(item.agentsStates)) {
            if (!isRecord(rawState) || agentThreadId === threadId) continue
            registerChildThread(agentThreadId, null, item.senderThreadId)
            const status = typeof rawState.status === 'string' ? rawState.status : ''
            if (['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status)) {
              markChildTerminal(agentThreadId)
            } else {
              terminalChildThreads.delete(agentThreadId)
              notifyChildStateChanged(agentThreadId)
            }
          }
        }
      }
    }
    const subagentRunMeta = (item: Record<string, unknown>) => {
      if (
        item.type === 'dynamicToolCall' &&
        (item.tool === 'task' || item.tool === 'delegate') &&
        typeof item.id === 'string'
      ) {
        return route.subagentRuns.get(item.id)
      }
      if (item.type !== 'collabAgentToolCall') return undefined
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
        : []
      let inputTokens = 0
      let outputTokens = 0
      for (const receiver of receivers) {
        const usage = childUsage.get(receiver)
        if (!usage) continue
        inputTokens += nonNegativeDifference(usage.latest.inputTokens, usage.baseline.inputTokens)
        outputTokens += nonNegativeDifference(usage.latest.outputTokens, usage.baseline.outputTokens)
      }
      const startedAt = typeof item.id === 'string' ? collabStartedAt.get(item.id) : undefined
      return {
        inputTokens,
        outputTokens,
        ...(startedAt == null ? {} : { startedAt }),
        durationMs: startedAt == null ? 0 : Math.max(0, Date.now() - startedAt),
      }
    }

    const waitForChildStateChange = (childThreadId: string, deadline: number): Promise<void> => {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return Promise.reject(new Error(`Timed out waiting for Codex subagent ${childThreadId} to stop`))
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const waiters = childStateWaiters.get(childThreadId) ?? new Set<() => void>()
        const cleanup = (): void => {
          waiters.delete(wake)
          if (!waiters.size && childStateWaiters.get(childThreadId) === waiters) {
            childStateWaiters.delete(childThreadId)
          }
          clearTimeout(timer)
        }
        const wake = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error(`Timed out waiting for Codex subagent ${childThreadId} to stop`))
        }, remainingMs)
        timer.unref()
        waiters.add(wake)
        childStateWaiters.set(childThreadId, waiters)
      })
    }

    const deletePersistedChildThread = (childThreadId: string, deadline: number): Promise<void> => {
      if (persistedChildThreads.get(childThreadId) !== true) return Promise.resolve()
      if (cleanedChildThreads.has(childThreadId)) return Promise.resolve()
      if (!terminalChildThreads.has(childThreadId)) {
        return Promise.reject(new Error(`Refusing to delete active Codex subagent ${childThreadId}`))
      }
      if (deletedChildThreads.has(childThreadId)) {
        cleanedChildThreads.add(childThreadId)
        return Promise.resolve()
      }
      const pending = childDeletionPromises.get(childThreadId)
      if (pending) return pending
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return Promise.reject(new Error(`Timed out cleaning up Codex subagent ${childThreadId}`))
      }
      const deletion = currentClient
        .deleteThread({ threadId: childThreadId }, { signal: AbortSignal.timeout(remainingMs) })
        .then(() => true)
        .catch((error) => {
          const message = errorMessage(error)
          if (!/^thread is not persisted and cannot be deleted(?::\s*\S+)?$/i.test(message.trim())) throw error
          return false
        })
        .then((remoteDeleted) => {
          cleanedChildThreads.add(childThreadId)
          if (remoteDeleted) {
            for (const candidate of activeThreadIds) {
              let parent = candidate
              const seen = new Set<string>()
              while (parent !== threadId && !seen.has(parent)) {
                if (parent === childThreadId) {
                  deletedChildThreads.add(candidate)
                  cleanedChildThreads.add(candidate)
                  markChildTerminal(candidate)
                  break
                }
                seen.add(parent)
                parent = childParents.get(parent) ?? threadId
              }
            }
          }
          cancelPendingServerRequests(route, childThreadId)
        })
        .finally(() => {
          if (childDeletionPromises.get(childThreadId) === deletion) childDeletionPromises.delete(childThreadId)
        })
      childDeletionPromises.set(childThreadId, deletion)
      return deletion
    }

    const stopChildThread = (childThreadId: string, deadline: number): Promise<void> => {
      const pending = childStopPromises.get(childThreadId)
      if (pending) return pending
      const stopping = (async () => {
        let interruptedTurnId = ''
        let interruptError: unknown
        while (!terminalChildThreads.has(childThreadId)) {
          const childTurnId = childTurnIds.get(childThreadId)
          if (childTurnId && childTurnId !== interruptedTurnId) {
            const remainingMs = deadline - Date.now()
            if (remainingMs <= 0) {
              throw new Error(`Timed out waiting for Codex subagent ${childThreadId} to stop`)
            }
            try {
              await currentClient.interruptTurn(
                { threadId: childThreadId, turnId: childTurnId },
                { signal: AbortSignal.timeout(remainingMs) }
              )
            } catch (error) {
              interruptError = error
            }
            interruptedTurnId = childTurnId
          }
          if (!terminalChildThreads.has(childThreadId)) {
            try {
              await waitForChildStateChange(childThreadId, deadline)
            } catch (error) {
              if (interruptError && !terminalChildThreads.has(childThreadId)) throw interruptError
              throw error
            }
          }
        }
        await deletePersistedChildThread(childThreadId, deadline)
        cancelPendingServerRequests(route, childThreadId)
      })().finally(() => {
        if (childStopPromises.get(childThreadId) === stopping) childStopPromises.delete(childThreadId)
      })
      childStopPromises.set(childThreadId, stopping)
      return stopping
    }

    const unfinishedChildRoots = (): string[] => {
      const unfinished = [...activeThreadIds].filter((id) => id !== threadId && !terminalChildThreads.has(id))
      const unfinishedSet = new Set(unfinished)
      return unfinished.filter((id) => {
        let parent = childParents.get(id)
        const seen = new Set<string>()
        while (parent && parent !== threadId && !seen.has(parent)) {
          if (unfinishedSet.has(parent)) return false
          seen.add(parent)
          parent = childParents.get(parent)
        }
        return true
      })
    }

    const persistedTerminalChildRoots = (): string[] => {
      const candidates = [...activeThreadIds].filter(
        (id) =>
          id !== threadId &&
          terminalChildThreads.has(id) &&
          persistedChildThreads.get(id) === true &&
          !cleanedChildThreads.has(id)
      )
      const candidateSet = new Set(candidates)
      return candidates.filter((id) => {
        let parent = childParents.get(id)
        const seen = new Set<string>()
        while (parent && parent !== threadId && !seen.has(parent)) {
          if (candidateSet.has(parent)) return false
          seen.add(parent)
          parent = childParents.get(parent)
        }
        return true
      })
    }

    const stopUnfinishedChildren = async (preserveManagedTasks = false): Promise<void> => {
      // `handleNotification` delivers each line synchronously in order. When parent completion arrives here,
      // receiverThreadIds from earlier spawns are already registered. Do not use timers to start teardown:
      // besides delaying finish, this breaks hosts/tests with virtual clocks.
      if (preserveManagedTasks) await waitForManagedTaskRecovery()
      const deadline = Date.now() + CHILD_STOP_TIMEOUT_MS
      await waitForManagedTasks(deadline)
      for (let round = 0; round < 8; round += 1) {
        const roots = unfinishedChildRoots()
        if (roots.length) {
          await Promise.all(roots.map((childThreadId) => stopChildThread(childThreadId, deadline)))
          continue
        }
        const cleanupRoots = persistedTerminalChildRoots()
        if (!cleanupRoots.length) return
        await Promise.all(cleanupRoots.map((childThreadId) => deletePersistedChildThread(childThreadId, deadline)))
      }
      const remaining = [...unfinishedChildRoots(), ...persistedTerminalChildRoots()]
      if (remaining.length) throw new Error(`Codex subagents did not stop: ${remaining.join(', ')}`)
    }

    // Deduplicate by itemId: app-server may REPLAY `item/completed` for an item. The reducer is idempotent
    // by partId, but each write would create a new artifactId, redirecting the part to the second file
    // and leaving the first as a permanently orphaned sidecar.
    const persistedGeneratedImages = new Set<string>()

    /**
     * Write the artifact and close the card. Never rejects: every failure (invalid base64, empty result,
     * unsupported format, disk error) becomes a visible ERROR card without breaking the turn.
     */
    const persistGeneratedImage = async (item: Record<string, unknown>): Promise<void> => {
      const status = typeof item.status === 'string' ? item.status : 'completed'
      if (status === 'failed' || status === 'error') {
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: String(item.id),
          state: { status: 'error', error: 'Image generation failed.' },
        })
        return
      }
      const revisedPrompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt.trim() : ''
      let stored: StoredGeneratedImage | null = null
      try {
        stored = await saveGeneratedImage({
          conversationId: args.conversationId,
          result: typeof item.result === 'string' ? item.result : '',
          label: revisedPrompt.slice(0, 48),
        })
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: String(item.id),
          state: { status: 'completed', output: clipPersistedToolOutput(imageGenerationOutput(item)) },
        })
        // force: the file ALREADY exists on disk. Persist immediately so its referencing part is not trapped
        // by the 300 ms throttle (an error right afterward would leave the artifact orphaned and invisible).
        apply(
          {
            kind: 'generated-image',
            messageId: assistantId,
            partId: String(item.id),
            artifactId: stored.artifactId,
            name: stored.name,
            mediaType: stored.mediaType,
            ...(revisedPrompt ? { revisedPrompt } : {}),
            byteSize: stored.byteSize,
          },
          true
        )
      } catch (error) {
        if (stored) await deleteGeneratedImages(args.conversationId, [stored.artifactId])
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: String(item.id),
          state: { status: 'error', error: `Failed to store the generated image: ${errorMessage(error)}` },
        })
      }
    }

    const settleRootAfterChildren = (params: TurnCompletedParams): void => {
      if (rootCompletionCleanupStarted) return
      rootCompletionCleanupStarted = true
      const classification = rootCompletedClassification
      if (classification?.kind === 'quota') {
        // Publish exhaustion before waiting so queued children also select another account.
        settleCurrentAttempt('quota', {
          reason: classification.message,
          source: exhaustionSource(classification),
          resetsAt: classification.resetsAt ?? null,
        })
      }
      const preserveManagedTasks =
        (classification?.kind === 'quota' || classification?.kind === 'suspect') &&
        !args.signal.aborted &&
        !planStopArmed
      // A normal Codex task is synchronous from the provider's point of view, so root completion drains every
      // child before settling. Maestro `delegate` is intentionally detached: draining here would either cancel
      // useful work or wait 15 seconds and fail before the supervision continuation can run.
      const preserveAsyncMaestroDelegations =
        args.mode === 'maestro' && maestroGuardRequired && !args.signal.aborted && !planStopArmed
      const cleanup = preserveAsyncMaestroDelegations
        ? waitForGeneratedImages()
        : stopUnfinishedChildren(preserveManagedTasks).then(() => waitForGeneratedImages())
      void cleanup
        .then(() => settle(params))
        .catch(async (error) => {
          const message = `Failed to stop Codex subagents before completing the turn: ${errorMessage(error)}`
          // Never leave a thread reusable while a descendant may mutate. Root hard-delete also removes the
          // entire subtree; if the runtime is unavailable, the tombstone preserves durable retry.
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          // `waitForGeneratedImages` never rejects (each write handles its own failure), but teardown may fail
          // BEFORE reaching it: await here too so the turn is not persisted without an already-emitted part.
          await waitForGeneratedImages()
          settle({
            ...params,
            turn: { ...params.turn, status: 'failed', error: { message } },
          })
        })
    }

    handleRootNotification = ({ method, params }): void => {
      if (!startRequested || !isRecord(params)) return
      if (method === 'thread/started') {
        const thread = isRecord(params.thread) ? params.thread : null
        if (thread && typeof thread.parentThreadId === 'string' && activeThreadIds.has(thread.parentThreadId)) {
          const persisted = typeof thread.ephemeral === 'boolean' ? !thread.ephemeral : undefined
          registerChildThread(thread.id, null, thread.parentThreadId, persisted)
        }
        return
      }
      const eventThreadId = typeof params.threadId === 'string' ? params.threadId : ''
      if (!activeThreadIds.has(eventThreadId)) return
      const rootEvent = eventThreadId === threadId
      if (rootEvent && nativeCompactionActive && method !== 'thread/deleted') return
      const eventTurnId = typeof params.turnId === 'string' ? params.turnId : ''
      if (rootEvent && turnId && eventTurnId && eventTurnId !== turnId) return

      if (method === 'thread/deleted') {
        if (rootEvent) {
          rootTurnTerminal = true
          retireCodexThreadBinding(args.conversationId, threadId)
          clearCodexThreadCleanup(threadId)
          threadDisposed = true
          cancelPendingServerRequests(route, threadId)
          for (const childThreadId of activeThreadIds) {
            if (childThreadId === threadId || managedChildThreads.has(childThreadId)) continue
            deletedChildThreads.add(childThreadId)
            cleanedChildThreads.add(childThreadId)
            markChildTerminal(childThreadId)
          }
          settleRootAfterChildren({
            threadId,
            turn: {
              id: eventTurnId || turnId,
              status: args.signal.aborted ? 'interrupted' : 'failed',
              error: args.signal.aborted ? null : { message: 'Codex root thread was deleted before completion' },
            },
          })
          return
        }
        deletedChildThreads.add(eventThreadId)
        markChildTerminal(eventThreadId)
        cancelPendingServerRequests(route, eventThreadId)
        return
      }

      if (method === 'turn/started') {
        const turn = isRecord(params.turn) ? params.turn : null
        const startedTurnId = turn && typeof turn.id === 'string' ? turn.id : ''
        if (rootEvent) {
          if (startedTurnId) {
            turnId = startedTurnId
            rootTurnAccepted = true
            const controlledClient = currentClient
            const controlledThreadId = threadId
            const controlledTurnId = startedTurnId
            const controlledProfile = runtimeProfile
            args.onTurnControl?.({
              harnessProfile: controlledProfile.modelHarnessProfileId,
              midTurnSteering: controlledProfile.capabilities.steering,
              liveReasoningUpdate: controlledProfile.capabilities.configurationUpdates,
              steer: async (text, clientUserMessageId) => {
                if (
                  !controlledProfile.capabilities.steering ||
                  !rootAttemptActive ||
                  turnId !== controlledTurnId ||
                  threadId !== controlledThreadId ||
                  currentClient !== controlledClient
                )
                  return 'target-unavailable'
                await controlledClient.steerTurn(
                  {
                    threadId: controlledThreadId,
                    expectedTurnId: controlledTurnId,
                    input: [codexTextInput(text)],
                    clientUserMessageId,
                  },
                  { signal: args.signal, timeoutMs: 30_000 }
                )
                lastBindingMessageId = clientUserMessageId
                chatDiag({
                  kind: 'codex-subscription-steering',
                  profile: controlledProfile.modelHarnessProfileId,
                  model: currentModelId,
                  conv: args.conversationId,
                  result: 'accepted',
                })
                return 'accepted'
              },
              updateReasoning: async (effort) => {
                if (
                  !controlledProfile.capabilities.configurationUpdates ||
                  !rootAttemptActive ||
                  turnId !== controlledTurnId ||
                  threadId !== controlledThreadId ||
                  currentClient !== controlledClient
                )
                  return 'target-unavailable'
                const sent = serializableReasoningEffortForProfile(controlledProfile.modelHarnessProfileId, effort)
                if (effort !== 'off' && effort !== 'default' && !sent) return 'invalid-effort'
                if (sent && !controlledProfile.capabilities.validReasoningEfforts.includes(sent)) {
                  return 'invalid-effort'
                }
                const result = await controlledClient.updateTurnSettings(
                  {
                    threadId: controlledThreadId,
                    expectedTurnId: controlledTurnId,
                    effort: sent,
                  },
                  { signal: args.signal, timeoutMs: 30_000 }
                )
                if (result.applied === false) return 'target-unavailable'
                currentReasoningEffort = sent ?? undefined
                chatDiag({
                  kind: 'codex-subscription-live-reasoning',
                  profile: controlledProfile.modelHarnessProfileId,
                  model: currentModelId,
                  conv: args.conversationId,
                  result: 'applied',
                })
                return 'applied'
              },
            })
          }
          if ((args.signal.aborted || planStopArmed) && turnId) {
            void currentClient.interruptTurn({ threadId, turnId }).catch(() => {})
          }
        } else {
          terminalChildThreads.delete(eventThreadId)
          if (startedTurnId) childTurnIds.set(eventThreadId, startedTurnId)
          notifyChildStateChanged(eventThreadId)
          if (args.signal.aborted && startedTurnId) {
            void currentClient.interruptTurn({ threadId: eventThreadId, turnId: startedTurnId }).catch(() => {})
          }
        }
        return
      }

      if (method === 'thread/tokenUsage/updated') {
        const notification = params as unknown as TokenUsageNotification
        const last = usageTotals(notification.tokenUsage.last)
        const lastCacheRead = Math.min(last.inputTokens, last.cachedInputTokens)
        const eventModel = rootEvent ? args.selection.modelId : (childModels.get(eventThreadId) ?? 'unknown')
        recordModelCallUsage({
          runtime: 'codex-subscription',
          providerId: args.selection.providerId,
          modelId: eventModel,
          conversationId: args.conversationId,
          ...(!rootEvent ? { agent: eventThreadId } : {}),
          usage: {
            input: Math.max(0, last.inputTokens - lastCacheRead),
            output: last.outputTokens,
            cacheRead: lastCacheRead,
            cacheCreate: 0,
            totalInput: last.inputTokens,
          },
        })
        if (rootEvent) {
          latestUsage = notification
          if (!initialContextProfileLogged) {
            initialContextProfileLogged = true
            chatDiag({
              kind: 'codex-subscription-initial-context',
              mode: args.mode,
              model: args.selection.modelId,
              ...(currentRequestedContextWindow != null
                ? { requestedContextWindow: currentRequestedContextWindow }
                : {}),
              ...(portableContextWindow > 0 ? { hostContextWindow: portableContextWindow } : {}),
              contextInput: Math.max(0, Number(notification.tokenUsage?.last?.inputTokens) || 0),
              tools: toolProfile,
            })
          }
          const contextWindow = Math.floor(Number(notification.tokenUsage?.modelContextWindow) || 0)
          if (contextWindow > 0 && contextWindow !== lastReportedContextWindow) {
            lastReportedContextWindow = contextWindow
            observePortableContextWindow(contextWindow)
            currentObserveContextWindow?.(contextWindow)
          }
          const contextInput = Math.max(0, Number(notification.tokenUsage?.last?.inputTokens) || 0)
          const contextOutput = Math.max(0, Number(notification.tokenUsage?.last?.outputTokens) || 0)
          const contextTokens = contextInput + contextOutput
          const compactionWindow =
            portableContextWindow > 0 && contextWindow > 0
              ? Math.min(portableContextWindow, contextWindow)
              : Math.max(portableContextWindow, contextWindow)
          if (
            rootAttemptActive &&
            !args.signal.aborted &&
            !state.planSubmitted &&
            !planStopArmed &&
            !portableCompactionRequested &&
            inTurnCompactions < MAX_IN_TURN_COMPACTIONS &&
            compactionWindow > 0 &&
            (runtimeProfile.nativeCompactionFirst || args.compactHistory) &&
            turnId &&
            contextTokens / compactionWindow >= IN_TURN_COMPACT_RATIO
          ) {
            portableCompactionRequested = true
            const interruptedThreadId = threadId
            const interruptedTurnId = turnId
            portableInterruptPromise = currentClient
              .interruptTurn({ threadId: interruptedThreadId, turnId: interruptedTurnId })
              .then(
                () => undefined,
                () => undefined
              )
          }
        } else {
          const previous = childUsage.get(eventThreadId)
          childUsage.set(eventThreadId, {
            baseline: previous?.baseline ?? usageBeforeLast(notification),
            latest: usageTotals(notification.tokenUsage.total),
            // The protocol includes no model in tokenUsage or thread/started. Break down by model only when
            // collabAgentToolCall reports it; unknown totals remain in subInput/subOutput.
            modelId: childModels.get(eventThreadId) ?? previous?.modelId ?? null,
          })
        }
        return
      }
      if (rootEvent && method === 'turn/completed') args.onTurnControl?.(null)
      if (!rootEvent && method.startsWith('item/')) {
        // Preserve only lifecycle/approval metadata. No child text or internal tool becomes a parent part;
        // useful managed-subagent progress is already aggregated in the `task` card.
        if (method === 'item/started' || method === 'item/completed') {
          const item = isRecord(params.item) ? params.item : null
          if (item) inspectItem(item)
        }
        return
      }
      if (method === 'item/agentMessage/delta') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : 'agent-message'
        if (!startedText.has(itemId)) {
          startedText.add(itemId)
          apply({ kind: 'text-start', messageId: assistantId, partId: itemId })
        }
        if (typeof params.delta === 'string') {
          progress.set(itemId, (progress.get(itemId) ?? '') + params.delta)
          apply({ kind: 'text-delta', messageId: assistantId, partId: itemId, delta: params.delta })
        }
        return
      }
      if (method === 'item/plan/delta') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : 'plan'
        if (!startedText.has(itemId)) {
          startedText.add(itemId)
          apply({ kind: 'text-start', messageId: assistantId, partId: itemId })
        }
        if (typeof params.delta === 'string') {
          progress.set(itemId, (progress.get(itemId) ?? '') + params.delta)
          apply({ kind: 'text-delta', messageId: assistantId, partId: itemId, delta: params.delta })
        }
        return
      }
      // The runtime may also emit raw reasoning/textDelta. Like the official client, Maestrly displays only
      // the summary by default; do not mix raw chain-of-thought with the user-facing summary.
      if (method === 'item/reasoning/summaryTextDelta') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : 'reasoning'
        if (!startedReasoning.has(itemId)) {
          startedReasoning.add(itemId)
          apply({ kind: 'reasoning-start', messageId: assistantId, partId: itemId })
        }
        if (typeof params.delta === 'string') {
          progress.set(itemId, (progress.get(itemId) ?? '') + params.delta)
          apply({ kind: 'reasoning-delta', messageId: assistantId, partId: itemId, delta: params.delta })
        }
        return
      }
      if (method === 'item/commandExecution/outputDelta') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : 'command'
        // Clipping each delta bounds the accumulated buffer (memory AND coalescer persistence): server-side exec
        // may emit MBs of stdout/stderr without any app-server cap.
        const output = clipPersistedToolOutput(
          (progress.get(itemId) ?? '') + (typeof params.delta === 'string' ? params.delta : '')
        )
        progress.set(itemId, output)
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: itemId,
          state: { status: 'running', output },
        })
        return
      }
      if (method === 'item/started') {
        const item = isRecord(params.item) ? params.item : null
        if (!item || typeof item.id !== 'string') return
        inspectItem(item)
        const tool = itemTool(item)
        if (!tool) return
        apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId: item.id, toolName: tool.name })
        apply({
          kind: 'tool-call',
          messageId: assistantId,
          toolCallId: item.id,
          toolName: tool.name,
          input: tool.input,
        })
        apply({ kind: 'tool-state', messageId: assistantId, toolCallId: item.id, state: { status: 'running' } })
        return
      }
      if (method === 'item/completed') {
        const item = isRecord(params.item) ? params.item : null
        if (!item || typeof item.id !== 'string') return
        if (!rootEvent && (item.type === 'agentMessage' || item.type === 'plan' || item.type === 'reasoning')) return
        inspectItem(item)
        if (
          (item.type === 'agentMessage' || item.type === 'plan') &&
          typeof item.text === 'string' &&
          !startedText.has(item.id)
        ) {
          startedText.add(item.id)
          apply({ kind: 'text-start', messageId: assistantId, partId: item.id })
          apply({ kind: 'text-delta', messageId: assistantId, partId: item.id, delta: item.text })
          return
        }
        if (item.type === 'reasoning' && !startedReasoning.has(item.id)) {
          const summary = Array.isArray(item.summary)
            ? item.summary.filter((v): v is string => typeof v === 'string').join('\n')
            : ''
          if (summary) {
            startedReasoning.add(item.id)
            apply({ kind: 'reasoning-start', messageId: assistantId, partId: item.id })
            apply({ kind: 'reasoning-delta', messageId: assistantId, partId: item.id, delta: summary })
          }
          return
        }
        // Generated image (native imagegen): `result` is base64 and must become a file BEFORE the part exists.
        // Handle it before the generic path; writing closes the card. Replaying the SAME item must not write
        // again, which would create a second file and orphan the first.
        if (item.type === 'imageGeneration') {
          if (!persistedGeneratedImages.has(item.id)) {
            persistedGeneratedImages.add(item.id)
            trackGeneratedImage(persistGeneratedImage(item))
          }
          return
        }
        const tool = itemTool(item)
        if (!tool) return
        const output = itemOutput(item, progress.get(item.id) ?? '')
        // This is the FINAL state persisted in parts_json. An uncapped exec here (1 MB of pytest output)
        // previously made future transcript reseeding impossible due to the API character limit.
        const finalOutput: ToolOutput =
          typeof output.output === 'string'
            ? clipPersistedToolOutput(output.output)
            : { ...output.output, text: clipPersistedToolOutput(output.output.text) }
        const sub = subagentRunMeta(item)
        apply({
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: item.id,
          state: output.success
            ? { status: 'completed', output: finalOutput, ...(sub ? { sub } : {}) }
            : { status: 'error', error: toolOutputAsText(finalOutput) || 'Tool failed', ...(sub ? { sub } : {}) },
        })
        return
      }
      if (method === 'turn/completed') {
        const rootFailureClassification = rootEvent ? classifyCodexQuotaFailure(params) : null
        const needsRootRateLimitsRead =
          rootFailureClassification?.kind === 'suspect' ||
          (rootFailureClassification?.kind === 'quota' && rootFailureClassification.resetsAt == null)
        if (rootEvent && rootFailureClassification && needsRootRateLimitsRead) {
          if (rootCompletionDecisionStarted) return
          rootCompletionDecisionStarted = true
          void (async () => {
            let confirmedClassification: CodexQuotaClassification = rootFailureClassification
            try {
              confirmedClassification = await classifyQuotaForFailover(params)
            } catch {
              // Keep suspect when the confirmation read is unavailable.
            }
            rootCompletedClassification = confirmedClassification
            rootCompletedParams = params as unknown as TurnCompletedParams
            cancelPendingServerRequests(route, eventThreadId, {
              // A healthy snapshot turns a transient rate-limit response into a normal failure, so managed
              // tasks must be cancelled before the root is settled. Unknown snapshots remain conservative.
              preserveManagedTasks:
                (confirmedClassification.kind === 'quota' || confirmedClassification.kind === 'suspect') &&
                !args.signal.aborted &&
                !planStopArmed,
            })
            rootTurnAccepted = true
            rootTurnTerminal = true
            settleRootAfterChildren(params as unknown as TurnCompletedParams)
          })()
          return
        }
        if (rootEvent) {
          if (rootCompletionDecisionStarted) return
          rootCompletionDecisionStarted = true
          rootCompletedClassification = rootFailureClassification
          rootCompletedParams = params as unknown as TurnCompletedParams
        }
        cancelPendingServerRequests(route, eventThreadId, {
          // Only quota/suspect failures can start account failover. Keep managed requests alive
          // for those cases so their side effects can settle before the root is retired; cancel
          // them immediately for clearly unrelated root failures, normal completion, explicit
          // user abort, and plan teardown.
          preserveManagedTasks:
            (rootFailureClassification?.kind === 'quota' || rootFailureClassification?.kind === 'suspect') &&
            !args.signal.aborted &&
            !planStopArmed,
        })
        if (rootEvent) {
          rootTurnAccepted = true
          rootTurnTerminal = true
          settleRootAfterChildren(params as unknown as TurnCompletedParams)
        } else {
          markChildTerminal(eventThreadId)
        }
      }
    }
    offNotification = currentClient.onNotification(handleRootNotification)

    onAbort = (): void => {
      armRootAbortTimeout()
      if (turnId) void currentClient.interruptTurn({ threadId, turnId }).catch(() => {})
      void stopUnfinishedChildren().catch(() => {})
    }
    args.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Finite limits: tool outputs use the default 16k cap; total transcript stays well below the API's
      // 1,048,576-character limit, leaving room for system prompt, current message, and attachments. INFINITY here
      // broke a production conversation ("Input exceeds the maximum length of 1048576 characters.").
      const seedTranscript = seeded ? renderNativeSeedTranscript(history.slice(0, -1)) : ''
      let input = currentUserInputs(currentUser, seedTranscript, currentDropImages)
      if (!input.length) input.push(codexTextInput('(continue)'))
      let clientUserMessageId = currentUser.id
      let result!: TurnCompletedParams
      let terminalEventApplied = false

      const performAccountFailover = async (failure: {
        error: unknown
        classification: Extract<CodexQuotaClassification, { kind: 'quota' }>
        usage?: ChatUsage
      }): Promise<'continued' | 'exhausted' | 'aborted' | 'unavailable'> => {
        if (args.signal.aborted) return 'aborted'

        const fromProviderId = currentProviderId
        const fromAccountId = threadAccountId
        const source = exhaustionSource(failure.classification)
        const exhaustionInfo = {
          reason: failure.classification.message,
          source,
          resetsAt: failure.classification.resetsAt ?? null,
        }
        settleCurrentAttempt('quota', exhaustionInfo)

        if (!failoverEnabled || !args.resolveNextTarget) return 'unavailable'

        cancelPendingServerRequests(route, undefined, { preserveManagedTasks: true })
        if (threadId && turnId) {
          await currentClient.interruptTurn({ threadId, turnId }).catch(() => undefined)
        }
        try {
          await stopUnfinishedChildren(true)
        } catch (error) {
          // Do not rotate and replay a root turn while a managed child may still be mutating
          // the workspace. Retire the old root and surface the bounded drain failure instead.
          const retiredThreadId = threadId
          if (retiredThreadId && !threadDisposed) {
            await retireCodexThread(args.conversationId, retiredThreadId, fromAccountId)
            threadDisposed = true
          }
          throw new Error(`Failed to drain Codex subagents before account failover: ${errorMessage(error)}`)
        }
        await waitForGeneratedImages()
        markUnfinishedToolsInterrupted()
        carryCurrentAttemptUsage(latestUsage)
        latestUsage = null
        persistNow()

        if (args.signal.aborted) return 'aborted'

        const next = await args.resolveNextTarget(
          {
            error: failure.error,
            classification: failure.classification,
            usage: failure.usage,
          },
          attemptedProviderIds
        )
        if (!next || isFailoverResolutionFailure(next) || attemptedProviderIds.has(next.providerId)) {
          if (isFailoverResolutionFailure(next)) {
            emitFailoverResolutionFailure(next, failure.usage)
            return next.reason === 'quota-exhausted' ? 'exhausted' : 'unavailable'
          }
          emitAccountsExhausted(failure.usage)
          return 'exhausted'
        }
        if (args.signal.aborted) {
          getSubscriptionFailoverRouter().confirmAttemptOther(next.providerId, next.availabilityLease)
          return 'aborted'
        }

        try {
          args.onFailoverTransition?.({
            scope: 'root',
            fromProviderId,
            toProviderId: next.providerId,
            reason: failure.classification.message,
            resetsAt: failure.classification.resetsAt ?? null,
          })

          const retiredThreadId = threadId
          const oldActive = [...activeThreadIds]
          offNotification()
          for (const activeThreadId of oldActive) routeRegistration.removeThread(activeThreadId)
          activeThreadIds = new Set()
          routeRegistration.remove()
          if (retiredThreadId) {
            await retireCodexThread(args.conversationId, retiredThreadId, fromAccountId)
            threadDisposed = true
          }
        } catch (error) {
          settleResolvedTargetAsOther(next)
          throw error
        }

        const previousPortableContextWindow = portableContextWindow
        applyTarget(next)
        notifyEffectiveTargetChanged(next)

        rebindRouteAndNotifications('')

        const useOriginalInput = !hasAssistantOutput()
        const failoverContextWindow = targetEffectiveContextWindow(next)
        const failoverNarrowedContext =
          failoverContextWindow != null &&
          (previousPortableContextWindow <= 0 || failoverContextWindow < previousPortableContextWindow)
        let seedTranscript = ''
        let continuationTranscript = ''
        if (!useOriginalInput) {
          continuationTranscript = renderTranscript([...history, messages[0]], {
            maxToolOutputChars: 16_000,
            maxChars: 800_000,
          })
        } else {
          // A failover always creates a fresh thread. Even when the original attempt resumed a native thread,
          // the fallback account cannot see that server-side history and must receive the portable seed.
          seedTranscript = renderNativeSeedTranscript(history.slice(0, -1))
        }
        const pendingReplayText = useOriginalInput
          ? renderTranscript([currentUser], { maxToolOutputChars: 16_000, maxChars: 800_000 })
          : PORTABLE_CONTINUE_PROMPT
        const replayNeedsCompaction =
          failoverNarrowedContext &&
          failoverContextWindow != null &&
          !replayFitsContextWindow(
            useOriginalInput ? seedTranscript : continuationTranscript,
            pendingReplayText,
            failoverContextWindow
          )
        const shouldCompactReplay = replayNeedsCompaction || (!useOriginalInput && !continuationTranscript.trim())
        if (shouldCompactReplay && args.compactHistory) {
          let compacted: Awaited<ReturnType<NonNullable<RunCodexSubscriptionChatArgs['compactHistory']>>> = null
          try {
            compacted = await args.compactHistory()
          } catch (compactError) {
            const compactClassification = await classifyQuotaForFailover(compactError)
            if (compactClassification.kind === 'quota') {
              // Compact hit quota on a helper path — try the next account without an incomplete compaction part.
              return await performAccountFailover({
                error: compactError,
                classification: compactClassification,
                usage: failure.usage,
              })
            }
            compacted = null
          }
          const summary = compacted?.summary.trim()
          if (summary) {
            carryCompactorUsage(compacted?.usage)
            apply(
              {
                kind: 'compaction',
                messageId: assistantId,
                partId: randomUUID(),
                text: summary,
                strategy: 'summary',
                usage: withSubagentUsage(mainUsage(null), childUsage, args.selection.providerId, externalSubagentUsage),
              },
              true
            )
            if (useOriginalInput) {
              seedTranscript = renderNativeSeedTranscript([...history.slice(0, -1), messages[0]])
            } else {
              continuationTranscript = renderTranscript([...history, messages[0]], {
                maxToolOutputChars: 16_000,
                maxChars: 800_000,
              })
            }
            if (
              replayNeedsCompaction &&
              failoverContextWindow != null &&
              !replayFitsContextWindow(
                useOriginalInput ? seedTranscript : continuationTranscript,
                pendingReplayText,
                failoverContextWindow
              )
            ) {
              throw new Error('Codex failover replay context remains too large after compaction')
            }
          } else if (replayNeedsCompaction) {
            throw new Error('Codex failover replay context compaction failed')
          }
        } else if (replayNeedsCompaction) {
          throw new Error('Codex failover replay context compaction is unavailable')
        }
        if (!useOriginalInput) {
          const continueMessage: ChatMessage = {
            id: randomUUID(),
            conversationId: args.conversationId,
            role: 'user',
            parts: [{ type: 'text', id: randomUUID(), text: PORTABLE_CONTINUE_PROMPT }],
            createdAt: Date.now(),
            internal: true,
          }
          input = currentUserInputs(continueMessage, continuationTranscript, true)
          if (!input.length) input.push(codexTextInput(PORTABLE_CONTINUE_PROMPT))
          clientUserMessageId = continueMessage.id
        } else {
          input = currentUserInputs(currentUser, seedTranscript, currentDropImages)
          if (!input.length) input.push(codexTextInput('(continue)'))
          clientUserMessageId = currentUser.id
        }

        if (args.signal.aborted) return 'aborted'

        const startDeadline = ownedRequestDeadline('Codex thread/start')
        const freshThreadAccountId = threadAccountId
        const freshThreadRequest = currentClient.startThread(
          {
            ...threadOptions,
            ...(capabilityMode === 'agent' && !args.reviewerRuntime ? {} : { environments: [] }),
            ephemeral: false,
            dynamicTools: registrations,
          } as Parameters<CodexAppServerClient['startThread']>[0] & {
            dynamicTools: DynamicToolRegistrationSpec[]
            environments?: []
          },
          { timeoutMs: 0 }
        )
        void freshThreadRequest.catch(() => {})
        let freshThread: Awaited<typeof freshThreadRequest>
        try {
          freshThread = await Promise.race([freshThreadRequest, rootAbortTimeout, startDeadline.promise])
        } catch (error) {
          void freshThreadRequest
            .then((lateThread) =>
              retireCodexThread(args.conversationId, lateThread.thread.id, freshThreadAccountId).catch(() => {})
            )
            .catch(() => {})
          startDeadline.cancel()
          if (args.signal.aborted) return 'aborted'
          const startClassification = await classifyQuotaForFailover(error)
          if (startClassification.kind === 'quota') {
            return await performAccountFailover({
              error,
              classification: startClassification,
              usage: failure.usage,
            })
          }
          throw error
        } finally {
          startDeadline.cancel()
        }

        threadId = freshThread.thread.id
        route.rootThreadId = threadId
        routeRegistration.addThread(threadId)
        activeThreadIds = new Set([threadId])
        createdNewThread = true
        threadDisposed = false
        baseline = { ...EMPTY_USAGE }
        latestUsage = null
        seeded = true

        if (args.signal.aborted) {
          routeRegistration.removeThread(threadId)
          activeThreadIds.clear()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          return 'aborted'
        }

        const accepted =
          args.onThreadReady?.(threadId, { providerId: currentProviderId, accountId: threadAccountId }) ?? true
        if (!accepted) {
          routeRegistration.removeThread(threadId)
          activeThreadIds.clear()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          throw new Error('Codex thread was discarded because the conversation is being closed')
        }

        return 'continued'
      }

      while (true) {
        portableCompactionRequested = false
        portableInterruptPromise = null
        turnId = ''
        rootTurnAccepted = false
        rootTurnTerminal = false
        resetRootCompletion()
        startRequested = true
        rootAttemptActive = true

        // Do not cancel the RPC locally before receiving turnId: app-server may already have created the turn,
        // and aborting the promise would lose the only identifier usable for turn/interrupt. The response is local
        // and fast; apply abort/plan-stop as soon as turn/started or the response supplies the ID.
        const deadline = ownedRequestDeadline('Codex turn/start')
        const attemptThreadId = threadId
        const startTurnRequest = currentClient.startTurn(
          {
            threadId: attemptThreadId,
            clientUserMessageId,
            input,
            cwd: args.cwd,
            model: currentModelId,
            serviceTier: currentServiceTier,
            approvalPolicy: approval.approvalPolicy,
            sandboxPolicy: sandboxPolicyFor(approval.sandbox, args.cwd),
            effort: currentReasoningEffort && currentReasoningEffort !== 'off' ? currentReasoningEffort : null,
            summary: 'auto',
            ...(runtimeProfile.personality ? { personality: runtimeProfile.personality } : {}),
            collaborationMode: collaborationModeFor(args, currentReasoningEffort),
          },
          { timeoutMs: 0 }
        )
        void startTurnRequest.catch(() => {})
        let turn: Awaited<typeof startTurnRequest>
        try {
          turn = await Promise.race([startTurnRequest, rootAbortTimeout, deadline.promise])
        } catch (error) {
          rootAttemptActive = false
          if (args.signal.aborted || error === deadline.error) {
            void startTurnRequest
              .then((lateTurn) =>
                currentClient
                  .interruptTurn(
                    { threadId: attemptThreadId, turnId: lateTurn.turn.id },
                    { signal: AbortSignal.timeout(15_000) }
                  )
                  .catch(() => {})
              )
              .catch(() => {})
            await retireCodexThread(args.conversationId, attemptThreadId, threadAccountId)
            threadDisposed = true
            throw error
          }
          const startTurnClassification = await classifyQuotaForFailover(error)
          if (startTurnClassification.kind === 'quota') {
            const switched = await performAccountFailover({
              error,
              classification: startTurnClassification,
              usage: withSubagentUsage(
                mainUsage(latestUsage),
                childUsage,
                args.selection.providerId,
                externalSubagentUsage
              ),
            })
            if (switched === 'continued') continue
            if (switched === 'exhausted' || switched === 'unavailable' || switched === 'aborted') {
              terminalEventApplied = switched !== 'aborted'
              result = {
                threadId: attemptThreadId,
                turn: {
                  id: turnId || 'unstarted',
                  status: switched === 'aborted' ? 'interrupted' : 'failed',
                  error: { message: errorMessage(error) },
                },
              }
              break
            }
          }
          throw error
        } finally {
          deadline.cancel()
        }
        turnId = turn.turn.id
        rootTurnAccepted = true
        if (args.signal.aborted || planStopArmed) onAbort()

        result = await Promise.race([
          completed,
          rootAbortTimeout,
          currentClient.waitForExit().then(() => {
            throw currentClient.failure ?? new Error('Codex app-server exited before the turn completed')
          }),
        ])
        rootAttemptActive = false
        await portableInterruptPromise
        if (rootAbortTimer) {
          clearTimeout(rootAbortTimer)
          rootAbortTimer = undefined
        }

        if (
          maestroGuardRequired &&
          args.mode === 'maestro' &&
          !args.signal.aborted &&
          !state.planSubmitted &&
          !planStopArmed
        ) {
          const unobserved = unobservedTurnDelegations(args.conversationId, assistantId)
          if (unobserved.length > 0) {
            const unobservedIds = new Set(unobserved.map((session) => session.id))
            // The parent attempted to finish too early. Keep the same visible assistant turn alive, wait on the
            // durable registry (abortable by Stop), then force one final model pass to reconcile the results.
            const settled = await waitForTurnDelegationsTerminal(args.conversationId, assistantId, args.signal)
            const delegations = settled.filter((session) => unobservedIds.has(session.id))
            for (const session of delegations) markDelegationObserved(session.id)
            carryCurrentAttemptUsage(latestUsage)
            latestUsage = null
            const summary = delegations.map((session) => ({
              sessionId: session.id,
              agent: session.agentName,
              status: session.status,
              phase: session.phase,
              tools: session.toolNames,
              files: session.files,
              tests: session.tests,
              error: session.error,
            }))
            const guardText =
              'Host guard: delegated sessions have settled. Inspect any needed transcript, reconcile every result, ' +
              `and only then produce the final answer. Sessions: ${JSON.stringify(summary)}`
            input = [codexTextInput(guardText)]
            clientUserMessageId = randomUUID()
            maestroGuardRequired = false
            continue
          }
        }

        if (result.turn.status === 'failed' && !args.signal.aborted && !state.planSubmitted && !planStopArmed) {
          const failedPayload = extractTurnCompletedError(result) ?? {
            message: result.turn.error?.message || 'Codex turn failed',
            status: 'failed',
            structured: true as const,
          }
          const failedClassification =
            result === rootCompletedParams && rootCompletedClassification
              ? rootCompletedClassification
              : await classifyQuotaForFailover(failedPayload)
          if (failedClassification.kind === 'quota') {
            const switched = await performAccountFailover({
              error: failedPayload,
              classification: failedClassification,
              usage: withSubagentUsage(
                mainUsage(latestUsage),
                childUsage,
                args.selection.providerId,
                externalSubagentUsage
              ),
            })
            if (switched === 'continued') continue
            if (switched === 'exhausted' || switched === 'unavailable') {
              terminalEventApplied = true
              break
            }
            if (switched === 'aborted') break
          }
        }

        const shouldCompact =
          portableCompactionRequested &&
          result.turn.status === 'interrupted' &&
          !args.signal.aborted &&
          !state.planSubmitted &&
          !planStopArmed
        if (!shouldCompact) break

        const interruptedUsage = latestUsage as TokenUsageNotification | null
        carryCurrentAttemptUsage(interruptedUsage)
        latestUsage = null
        // compactHistory reads the durable conversation; publish all partial output from the interrupted provider first.
        persistNow()
        if (runtimeProfile.nativeCompactionFirst) {
          const beforeNative = interruptedUsage ? usageTotals(interruptedUsage.tokenUsage.total) : baseline
          try {
            nativeCompactionActive = true
            const nativeUsage = await compactCodexSubscriptionThread(currentClient, threadId, args.signal)
            const nativeBaseline = nativeUsage ?? beforeNative
            if (nativeUsage) {
              carriedMainUsage.totalInput += nonNegativeDifference(
                nativeUsage.inputTokens,
                beforeNative.inputTokens
              )
              carriedMainUsage.cachedInput += nonNegativeDifference(
                nativeUsage.cachedInputTokens,
                beforeNative.cachedInputTokens
              )
              carriedMainUsage.output += nonNegativeDifference(
                nativeUsage.outputTokens,
                beforeNative.outputTokens
              )
            }
            baseline = nativeBaseline
            inTurnCompactions += 1
            apply(
              {
                kind: 'compaction',
                messageId: assistantId,
                partId: randomUUID(),
                text: 'Context compacted by the Codex runtime.',
                strategy: 'codex-native',
                usage: withSubagentUsage(mainUsage(null), childUsage, args.selection.providerId, externalSubagentUsage),
              },
              true
            )
            chatDiag({
              kind: 'codex-subscription-native-compaction',
              profile: runtimeProfile.modelHarnessProfileId,
              model: args.selection.modelId,
              conv: args.conversationId,
              result: 'success',
            })
            const continueMessageId = randomUUID()
            input = [codexTextInput(PORTABLE_CONTINUE_PROMPT)]
            clientUserMessageId = continueMessageId
            latestUsage = null
            continue
          } catch {
            chatDiag({
              kind: 'codex-subscription-native-compaction',
              profile: runtimeProfile.modelHarnessProfileId,
              model: args.selection.modelId,
              conv: args.conversationId,
              result: 'portable-fallback',
            })
          } finally {
            nativeCompactionActive = false
          }
        }
        if (!args.compactHistory) {
          for (const activeThreadId of activeThreadIds) routeRegistration.removeThread(activeThreadId)
          activeThreadIds = new Set()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          throw new Error('Codex portable intra-turn compaction is unavailable')
        }
        let compacted: Awaited<ReturnType<NonNullable<RunCodexSubscriptionChatArgs['compactHistory']>>> = null
        try {
          compacted = await args.compactHistory!()
        } catch {
          compacted = null
        }
        const summary = compacted?.summary.trim()
        if (!compacted || !summary) {
          for (const activeThreadId of activeThreadIds) routeRegistration.removeThread(activeThreadId)
          activeThreadIds = new Set()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          throw new Error('Codex portable intra-turn compaction failed')
        }

        carryCompactorUsage(compacted.usage)
        inTurnCompactions += 1
        apply(
          {
            kind: 'compaction',
            messageId: assistantId,
            partId: randomUUID(),
            text: summary,
            strategy: 'summary',
            usage: withSubagentUsage(mainUsage(null), childUsage, args.selection.providerId, externalSubagentUsage),
          },
          true
        )
        chatDiag({
          kind: 'codex-subscription-in-turn-compact',
          compacts: inTurnCompactions,
          contextInput: Math.max(0, Number(interruptedUsage?.tokenUsage.last.inputTokens) || 0),
          contextWindow:
            portableContextWindow > 0 && Math.floor(Number(interruptedUsage?.tokenUsage.modelContextWindow) || 0) > 0
              ? Math.min(
                  portableContextWindow,
                  Math.floor(Number(interruptedUsage?.tokenUsage.modelContextWindow) || 0)
                )
              : Math.max(
                  portableContextWindow,
                  Math.floor(Number(interruptedUsage?.tokenUsage.modelContextWindow) || 0)
                ),
          model: args.selection.modelId,
          conv: args.conversationId,
        })

        const continuationTranscript = renderTranscript([...history, messages[0]], {
          maxToolOutputChars: 16_000,
          maxChars: 800_000,
        })
        const continueMessage: ChatMessage = {
          id: randomUUID(),
          conversationId: args.conversationId,
          role: 'user',
          parts: [{ type: 'text', id: randomUUID(), text: PORTABLE_CONTINUE_PROMPT }],
          createdAt: Date.now(),
          internal: true,
        }
        input = currentUserInputs(continueMessage, continuationTranscript, true)
        if (!input.length) input.push(codexTextInput(PORTABLE_CONTINUE_PROMPT))
        clientUserMessageId = continueMessage.id

        // Old native history is behind the portable boundary and must never become authoritative again.
        const retiredThreadId = threadId
        for (const activeThreadId of activeThreadIds) routeRegistration.removeThread(activeThreadId)
        activeThreadIds = new Set()
        await retireCodexThread(args.conversationId, retiredThreadId, threadAccountId)
        threadDisposed = true
        if (args.signal.aborted) break

        const startDeadline = ownedRequestDeadline('Codex thread/start')
        const freshThreadAccountId = threadAccountId
        const freshThreadRequest = currentClient.startThread(
          {
            ...threadOptions,
            ...(capabilityMode === 'agent' && !args.reviewerRuntime ? {} : { environments: [] }),
            ephemeral: Boolean(args.ephemeralSession),
            dynamicTools: registrations,
          } as Parameters<CodexAppServerClient['startThread']>[0] & {
            dynamicTools: DynamicToolRegistrationSpec[]
            environments?: []
          },
          { timeoutMs: 0 }
        )
        void freshThreadRequest.catch(() => {})
        let freshThread: Awaited<typeof freshThreadRequest>
        try {
          freshThread = await Promise.race([freshThreadRequest, rootAbortTimeout, startDeadline.promise])
        } catch (error) {
          void freshThreadRequest
            .then((lateThread) =>
              retireCodexThread(args.conversationId, lateThread.thread.id, freshThreadAccountId).catch(() => {})
            )
            .catch(() => {})
          const compactStartClassification = await classifyQuotaForFailover(error)
          if (compactStartClassification.kind === 'quota') {
            const switched = await performAccountFailover({
              error,
              classification: compactStartClassification,
              usage: withSubagentUsage(
                mainUsage(latestUsage),
                childUsage,
                args.selection.providerId,
                externalSubagentUsage
              ),
            })
            if (switched === 'continued') continue
            if (switched === 'exhausted' || switched === 'unavailable') {
              terminalEventApplied = true
              result = {
                threadId,
                turn: { id: turnId || 'unstarted', status: 'failed', error: { message: errorMessage(error) } },
              }
              break
            }
            if (switched === 'aborted') break
          }
          throw error
        } finally {
          startDeadline.cancel()
        }
        threadId = freshThread.thread.id
        route.rootThreadId = threadId
        routeRegistration.addThread(threadId)
        activeThreadIds = new Set([threadId])
        createdNewThread = true
        threadDisposed = false
        // Isolated: each intra-turn compaction thread is also ephemeral.
        if (args.ephemeralSession) {
          queueCodexThreadCleanup(args.conversationId, threadId, threadAccountId)
        }
        baseline = { ...EMPTY_USAGE }
        latestUsage = null
        if (args.signal.aborted) {
          routeRegistration.removeThread(threadId)
          activeThreadIds.clear()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          break
        }
        const freshLifecycleAccepted =
          args.onThreadReady?.(threadId, { providerId: currentProviderId, accountId: threadAccountId }) ?? true
        if (!freshLifecycleAccepted) {
          routeRegistration.removeThread(threadId)
          activeThreadIds.clear()
          await retireCodexThread(args.conversationId, threadId, threadAccountId)
          threadDisposed = true
          throw new Error('Codex thread was discarded because the conversation is being closed')
        }
      }

      const finalUsage = latestUsage as TokenUsageNotification | null
      const usage = withSubagentUsage(
        mainUsage(finalUsage),
        childUsage,
        args.selection.providerId,
        externalSubagentUsage
      )
      if (terminalEventApplied) {
        // Failover already emitted the terminal stream event (accounts exhausted).
      } else if (args.signal.aborted) {
        // Stop may arrive while a failed quota turn is awaiting child recovery. The
        // provider's terminal status predates that user action and must not surface an error.
        settleCurrentAttempt('other')
        apply(
          {
            kind: 'aborted',
            messageId: assistantId,
            usage,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          true
        )
      } else if (result.turn.status === 'completed') {
        settleCurrentAttempt('success')
        apply(
          {
            kind: 'finish',
            messageId: assistantId,
            finishReason: 'stop',
            usage,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          true
        )
      } else if (result.turn.status === 'interrupted') {
        // review_plan deliberately ends the turn via turn/interrupt after the tool RPC responds.
        // The product treats this as clean completion (plan delivered), not a cut stream/pipeline error.
        if (state.planSubmitted) {
          settleCurrentAttempt('success')
          apply(
            {
              kind: 'finish',
              messageId: assistantId,
              finishReason: 'stop',
              usage,
              responseDurationMs: responseDurationMs(responseStartedAt),
            },
            true
          )
        } else {
          settleCurrentAttempt('other')
          apply(
            {
              kind: 'finish',
              messageId: assistantId,
              finishReason: 'interrupted',
              usage,
              responseDurationMs: responseDurationMs(responseStartedAt),
            },
            true
          )
        }
      } else {
        settleCurrentAttempt('other')
        const message = result.turn.error?.message || 'Codex turn failed'
        apply(
          {
            kind: 'error',
            messageId: assistantId,
            message,
            usage,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          true
        )
      }

      const mayPersistThread = !args.ephemeralSession && (args.canPersistThread?.() ?? true)
      if (
        (result.turn.status === 'completed' || result.turn.status === 'interrupted') &&
        mayPersistThread &&
        !threadDisposed
      ) {
        putCodexThreadBinding({
          conversationId: args.conversationId,
          threadId,
          modelId: currentModelId,
          toolSignature: signature,
          instructionHash,
          harnessProfile: runtimeProfile.modelHarnessProfileId,
          lastMessageId: lastBindingMessageId,
          usage: finalUsage ? usageTotals(finalUsage.tokenUsage.total) : baseline,
          accountId: threadAccountId,
        })
        threadPersisted = true
      } else if ((!mayPersistThread || args.ephemeralSession) && !threadDisposed) {
        // Isolated or canPersist=false: hard-delete the ephemeral root; main binding remains intact (CAS).
        await retireCodexThread(args.conversationId, threadId, threadAccountId)
        threadDisposed = true
      }
    } catch (error) {
      rootAttemptActive = false
      settleCurrentAttempt('other')
      const usage = withSubagentUsage(
        mainUsage(latestUsage),
        childUsage,
        args.selection.providerId,
        externalSubagentUsage
      )
      if (args.signal.aborted)
        apply(
          {
            kind: 'aborted',
            messageId: assistantId,
            usage,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          true
        )
      else
        apply(
          {
            kind: 'error',
            messageId: assistantId,
            message: errorMessage(error),
            usage,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          true
        )
    }
  } finally {
    managedTaskRecoveryStop.abort()
    args.onTurnControl?.(null)
    settleCurrentAttempt('other')
    // Deliberate order: (1) listener OFF so no new notification can queue another write; (2) await in-flight
    // writes. The runner is the lifecycle boundary (delete/truncate/wipe assume no writes outlive it), and
    // final `apply` calls must happen BEFORE coalescer persist/dispose.
    offNotification()
    await waitForGeneratedImages()
    if (
      threadId &&
      !threadDisposed &&
      (args.ephemeralSession ||
        !(args.canPersistThread?.() ?? true) ||
        (createdNewThread && !threadPersisted) ||
        (rootTurnAccepted && !rootTurnTerminal))
    ) {
      await retireCodexThread(args.conversationId, threadId, threadAccountId)
      threadDisposed = true
    }
    args.signal.removeEventListener('abort', onAbort)
    args.signal.removeEventListener('abort', onStartupAbort)
    if (rootAbortTimer) clearTimeout(rootAbortTimer)
    routeRegistration.remove()
    if (dirty) persistNow()
    coalescer.flush()
    coalescer.dispose()
    await dynamic.close()
  }

  return { planSubmitted: state.planSubmitted, threadId }
}
