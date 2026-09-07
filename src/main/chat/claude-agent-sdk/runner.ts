import { createHash, randomUUID } from 'node:crypto'
import type { SDKCompactBoundaryMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type {
  ChatMessage,
  ChatModelRef,
  ChatPermMode,
  ChatStreamEvent,
  ChatSubagentUsage,
  MessagePart,
  SubagentRunMeta,
} from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import type { MaestroLiveRunPort } from '../maestro-live'
import { applyChatEvent } from '../../../shared/chat'
import { responseDurationMs } from '../../../shared/response-duration'
import { getAppFlag, getConversation, getConvUiPrefs } from '../../store'
import { gitEnvInfo } from '../../git-service'
import { stagePlan } from '../../plan-broker'
import type { ChatAgent } from '../agents'
import { listEffectiveAgents } from '../virtual-subagents'
import {
  lastConversationContextMessage,
  runnerContextHistory,
  toPublicChatUsage,
  upsertChatMessage,
  type StoredChatMessage,
  type StoredChatUsage,
} from '../chat-store'
import { createDeltaCoalescer } from '../delta-coalescer'
import { chatDiag } from '../diag-log'
import { buildAppTools, buildMcpTools } from '../mcp'
import { describeEphemeralToolImage } from '../image-interpreter'
import { adaptToolSetForModel } from '../tool-capabilities'
import { clipPersistedToolOutput, renderTranscript } from '../message'
import type { PermissionBroker } from '../permission'
import { buildProjectContext } from '../project-context'
import type { QuestionBroker } from '../question-broker'
import { IN_TURN_COMPACT_RATIO, SYSTEM_PROMPT, type NormalizedAiUsage } from '../runner'
import { renderSkillContext, skillCatalogLine, type ChatSkill } from '../skills'
import { effectiveSkills, findEffectiveSkill } from '../skill-state'
import { SubagentCoordinator } from '../subagent-coordinator'
import { buildAndRenderSubagentDispatchCatalog } from '../subagent-dispatch-catalog'
import { createExplicitSubagentTurnState } from '../subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from '../subagent-turn-request'
import { builtinToolNamesForMode, buildTools, REVIEWER_READONLY_TOOL_NAMES } from '../tools'
import type { GeneratedImageEmission, GeneratedImageUsage, ReviewerToolRuntime, ToolContext } from '../tools/util'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  GENERATE_IMAGE_TOOL_NAME,
  mergeGeneratedImageUsage,
} from '../image-gen'
import { recordModelCallUsage } from '../usage-diagnostics'
import {
  CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE,
  claudeRuntimeErrorMessage,
  claudeSubscriptionErrorMessage,
  isClaudeAuthenticationRequired,
  redactClaudeCredentials,
} from './errors'
import type { ClaudeSubscriptionAccountIdentity, ClaudeSubscriptionManager } from './manager'
import { buildClaudeChatQueryOptions, buildClaudeCompactionQueryOptions } from './options'
import {
  buildClaudeSessionBinding,
  buildClaudeSessionPrompt,
  claudeSeedTranscript,
  isClaudeSessionBindingCompatible,
  resolveClaudeSession,
} from './session'
import {
  clearClaudeSessionCleanup,
  getClaudeMessageMapping,
  getClaudeSessionBinding,
  putClaudeMessageMapping,
  putClaudeSessionBinding,
  queueClaudeSessionCleanup,
  markClaudeSessionCleanupFailed,
  reassignClaudeMessageMappings,
  retireClaudeSessionBinding,
  type ClaudeContextSnapshot,
  type ClaudeSessionUsageSnapshot,
} from './session-store'
import { createClaudeStreamMapper } from './stream-map'
import { createClaudeTaskRuntime, type ClaudeManagedTaskRunner } from './task-runtime'
import {
  MAESTRO_DELEGATE_TOOL_DESCRIPTION,
  MAESTRO_DELEGATE_TOOL_SCHEMA,
  maestroAgentsFromTurn,
  renderMaestroAgentCatalog,
} from '../maestro-delegation'
import { renderMaestroTurnPolicy } from '../maestro-prompt'
import { buildSubagentSupervisionTools } from '../maestro-supervision-tools'
import {
  markDelegationObserved,
  unobservedTurnDelegations,
  waitForTurnDelegationsTerminal,
} from '../maestro-delegation-registry'
import { buildClaudeToolBridge, CLAUDE_DISALLOWED_NATIVE_TOOLS, type ClaudeToolBridge } from './tools'
import { normalizeClaudeUsage, type NormalizedClaudeUsage } from './usage'
import { claudeServedModelMismatch } from './served-model'
import { renderDesignUltraGuidance } from '../design-mode-prompt'
import { FABLE_51_PROFILE_FLAG, resolveFableBehaviorProfile, type FableBehaviorProfile } from '../fable/profile'
import { fableEnvironmentContext } from '../fable/prompt'
import { createFablePostToolUseHook } from '../fable/sdk-hooks'

const MAX_IN_TURN_COMPACTIONS = 2
const PORTABLE_CONTINUE_PROMPT =
  'Continue the same assistant turn from the imported transcript. Do not repeat completed work or prior progress updates.'

export interface RunClaudeChatArgs {
  conversationId: string
  projectId: string
  cwd: string
  selection: ChatModelRef
  resolvedModelId?: string
  /** Behavior resolved once at turn admission. undefined keeps direct-call compatibility by resolving locally. */
  behaviorProfile?: FableBehaviorProfile | null
  /** Runtime model id frozen for an isolated review-loop execution. */
  frozenResolvedModelId?: string
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort
  permMode: ChatPermMode
  reasoningEffort?: string
  fastMode?: boolean
  maestrlyUltra?: boolean
  /** Runtime/model fallback flag for image inputs and tool results. */
  dropImages?: boolean
  manager: ClaudeSubscriptionManager
  accountIdentity: ClaudeSubscriptionAccountIdentity
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
  responseStartedAt?: number
  onSessionReady?: (sessionId: string) => boolean
  canPersistSession?: () => boolean
  onModelContextWindow?: (contextWindow: number) => void
  /** Effective model window. Together with compactHistory, enables portable intra-turn compaction. */
  contextWindow?: number
  /** Summarizes durable visible history; the returned boundary is persisted in the live assistant bubble. */
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
}

export interface RunClaudeChatResult {
  planSubmitted: boolean
  sessionId: string
}

export type InspectClaudeSessionCompatibilityArgs = Omit<
  RunClaudeChatArgs,
  'emit' | 'responseStartedAt' | 'onSessionReady' | 'canPersistSession' | 'onModelContextWindow'
>

interface RunnerState {
  planSubmitted: boolean
  planToolCallId: string | null
  planResultAcknowledged: boolean
  planAcknowledgementTimer: ReturnType<typeof setTimeout> | null
  subagentRuns: Map<string, SubagentRunMeta>
  query: ReturnType<ClaudeSubscriptionManager['createQuery']> | null
  runTask: ClaudeManagedTaskRunner | null
  coordinator: SubagentCoordinator
  queryAbortController: AbortController | null
  /**
   * Publish the generated image part (generate_image). Only REAL turns define this; inspect/compact omit the tool
   * because they have no assistant message to display the artifact.
   */
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
}

interface PreparedRuntime {
  tools: ToolSet
  /** Raw host tools retained for nested workers whose model has a different vision capability. */
  rawTools: ToolSet
  bridge: ClaudeToolBridge
  systemPrompt: string
  promptHash: string
  transientContext?: string
  fablePostToolUseHook?: ReturnType<typeof createFablePostToolUseHook>
  behaviorProfile?: FableBehaviorProfile
  agents: ChatAgent[]
  close: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeTokens(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted) return null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveAbort: (() => void) | null = null
  const fallback = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs)
    timeout.unref?.()
    if (signal) {
      resolveAbort = () => resolve(null)
      signal.addEventListener('abort', resolveAbort, { once: true })
      if (signal.aborted) resolveAbort()
    }
  })
  try {
    return await Promise.race([promise, fallback])
  } catch {
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && resolveAbort) signal.removeEventListener('abort', resolveAbort)
  }
}

function diagnosticEntries(value: unknown): string[] {
  if (value instanceof Error) return value.message.trim() ? [value.message.trim()] : []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (isRecord(value) && Array.isArray(value.errors)) {
    return value.errors
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

function isIntentionalPlanInterruptDiagnostic(value: unknown): boolean {
  const entries = diagnosticEntries(value)
  return (
    entries.length === 1 &&
    /^(?:Claude Code returned an error result:\s*)?\[ede_diagnostic\]\s+result_type=user\s+last_content_type=n\/a\s+stop_reason=(?:null|tool_use)$/.test(
      entries[0]
    )
  )
}

function skillsCatalog(skills: readonly ChatSkill[]): string {
  if (!skills.length) return ''
  return skills.map(skillCatalogLine).join('\n')
}

function agentsCatalog(agents: readonly ChatAgent[], conversationId: string, forceReadOnly: boolean): string {
  if (!agents.length) return ''
  return buildAndRenderSubagentDispatchCatalog({ agents, conversationId, forceReadOnly }, { descriptionMaxChars: 240 })
}

function usageFromResult(
  result: SDKResultMessage | null,
  context: ClaudeContextSnapshot | null,
  subagents: readonly ChatSubagentUsage[],
  contextIdentity: string,
  fallbackMain?: NormalizedClaudeUsage,
  mainOverride?: NormalizedClaudeUsage,
  aux?: { runtimeCostUsd?: number; catalogTokens?: NormalizedClaudeUsage; runtimeCoveredTokens?: NormalizedClaudeUsage }
): StoredChatUsage | undefined {
  if (!result && !fallbackMain && !mainOverride && !subagents.length && !context) return undefined
  const main =
    mainOverride ?? (result ? normalizeClaudeUsage(result.usage) : (fallbackMain ?? normalizeClaudeUsage({})))
  const sub = subagents.reduce(
    (sum, item) => ({
      input: sum.input + item.input,
      output: sum.output + item.output,
      cached: sum.cached + (item.cachedInput ?? 0),
      created: sum.created + (item.cacheCreate ?? 0),
    }),
    { input: 0, output: 0, cached: 0, created: 0 }
  )
  // Auxiliary calls (intra-turn compaction): COMPLETE native estimates add to main cost;
  // without estimates, their buckets depend on the catalog; main runtime cost does NOT cover them.
  const mainRuntimeCost =
    Number.isFinite(Number(result?.total_cost_usd)) && Number(result?.total_cost_usd) >= 0
      ? Number(result?.total_cost_usd)
      : null
  const auxRuntimeCost = aux?.runtimeCostUsd ?? 0
  const hasAuxRuntime = auxRuntimeCost > 0
  const auxCatalog = aux?.catalogTokens
  const hasAuxCatalog =
    auxCatalog != null && (auxCatalog.input || auxCatalog.output || auxCatalog.cacheRead || auxCatalog.cacheCreate)
  const auxRuntimeTokens = aux?.runtimeCoveredTokens
  const hasAuxRuntimeTokens =
    auxRuntimeTokens != null &&
    (auxRuntimeTokens.input || auxRuntimeTokens.output || auxRuntimeTokens.cacheRead || auxRuntimeTokens.cacheCreate)
  let catalogInput: number | undefined
  let catalogOutput: number | undefined
  let catalogCacheRead: number | undefined
  let catalogCacheCreate: number | undefined
  if (mainRuntimeCost != null && hasAuxCatalog) {
    catalogInput = auxCatalog!.input
    catalogOutput = auxCatalog!.output
    catalogCacheRead = auxCatalog!.cacheRead
    catalogCacheCreate = auxCatalog!.cacheCreate
  } else if (mainRuntimeCost == null && hasAuxRuntime) {
    // The runtime cost here covers ONLY auxiliary calls with estimates; MAIN buckets (and auxiliary buckets
    // without estimates) still use the catalog. Runtime-covered tokens are SUBTRACTED from the residual;
    // otherwise the ledger/card would add auxiliary runtime cost AND price the same tokens again via the catalog.
    const auxIn = (hasAuxCatalog ? auxCatalog!.input : 0) + (hasAuxRuntimeTokens ? auxRuntimeTokens!.input : 0)
    const auxOut = (hasAuxCatalog ? auxCatalog!.output : 0) + (hasAuxRuntimeTokens ? auxRuntimeTokens!.output : 0)
    const auxRead =
      (hasAuxCatalog ? auxCatalog!.cacheRead : 0) + (hasAuxRuntimeTokens ? auxRuntimeTokens!.cacheRead : 0)
    const auxCreate =
      (hasAuxCatalog ? auxCatalog!.cacheCreate : 0) + (hasAuxRuntimeTokens ? auxRuntimeTokens!.cacheCreate : 0)
    catalogInput = Math.max(0, main.input - auxIn)
    catalogOutput = Math.max(0, main.output - auxOut)
    catalogCacheRead = Math.max(0, main.cacheRead - auxRead)
    catalogCacheCreate = Math.max(0, main.cacheCreate - auxCreate)
  }
  const runtimeEstimatedCostUsd =
    mainRuntimeCost != null || hasAuxRuntime ? (mainRuntimeCost ?? 0) + auxRuntimeCost : undefined
  return {
    usageVersion: 2,
    input: main.input,
    output: main.output,
    ...(context
      ? {
          contextInput: context.totalTokens,
          modelContextWindow: context.maxTokens,
          // INTERNAL identity (account + prompt): StoredChatUsage only; IPC uses toPublicChatUsage.
          contextIdentity,
        }
      : {}),
    cachedInput: main.cacheRead,
    cacheCreate: main.cacheCreate,
    ...(sub.input ? { subInput: sub.input } : {}),
    ...(sub.output ? { subOutput: sub.output } : {}),
    ...(sub.cached ? { subCachedInput: sub.cached } : {}),
    ...(sub.created ? { subCacheCreate: sub.created } : {}),
    ...(subagents.length ? { subagentUsage: [...subagents] } : {}),
    ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
    ...(catalogInput ? { catalogInput } : {}),
    ...(catalogOutput ? { catalogOutput } : {}),
    ...(catalogCacheRead ? { catalogCacheRead } : {}),
    ...(catalogCacheCreate ? { catalogCacheCreate } : {}),
  }
}

function usageSnapshot(
  result: SDKResultMessage | null,
  fallbackMain?: NormalizedClaudeUsage,
  fallbackTurns = 0,
  mainOverride?: NormalizedClaudeUsage
): ClaudeSessionUsageSnapshot {
  const main =
    mainOverride ?? (result ? normalizeClaudeUsage(result.usage) : (fallbackMain ?? normalizeClaudeUsage({})))
  return {
    inputTokens: main.input,
    outputTokens: main.output,
    cacheReadTokens: main.cacheRead,
    cacheWriteTokens: main.cacheCreate,
    costUsd: Math.max(0, Number(result?.total_cost_usd) || 0),
    turns: Math.max(0, Number(result?.num_turns) || fallbackTurns),
    durationMs: Math.max(0, Number(result?.duration_ms) || 0),
    durationApiMs: Math.max(0, Number(result?.duration_api_ms) || 0),
  }
}

function aggregateClaudeUsage(values: Iterable<NormalizedClaudeUsage>): NormalizedClaudeUsage | undefined {
  let count = 0
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalInput: 0,
  }
  for (const usage of values) {
    count += 1
    total.input += usage.input
    total.output += usage.output
    total.cacheRead += usage.cacheRead
    total.cacheCreate += usage.cacheCreate
    total.totalInput += usage.totalInput
  }
  return count ? total : undefined
}

function normalizedPortableUsage(value: NormalizedAiUsage | undefined): NormalizedClaudeUsage | undefined {
  if (!value) return undefined
  const input = safeTokens(value.input)
  const output = safeTokens(value.output)
  const cacheRead = safeTokens(value.cacheRead)
  const cacheCreate = safeTokens(value.cacheCreate)
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    totalInput: Math.max(safeTokens(value.totalInput), input + cacheRead + cacheCreate),
  }
}

function resultModelContextWindow(
  result: SDKResultMessage | null,
  runtimeModelId: string,
  assistantModelId?: string | null
): number {
  if (!result) return 0
  const entries = Object.entries(result.modelUsage ?? {})
  const modelIds = [runtimeModelId, assistantModelId].filter((value): value is string => Boolean(value))
  for (const modelId of modelIds) {
    const exact = result.modelUsage?.[modelId]
    const window = safeTokens(exact?.contextWindow)
    if (window) return window
  }
  for (const modelId of modelIds) {
    const canonical = entries.find(([, usage]) => usage.canonicalModel === modelId)?.[1]
    const window = safeTokens(canonical?.contextWindow)
    if (window) return window
  }
  const windows = new Set(entries.map(([, usage]) => safeTokens(usage.contextWindow)).filter((value) => value > 0))
  return windows.size === 1 ? [...windows][0] : 0
}

function resultError(result: SDKResultMessage | null, modelId?: string): string | null {
  if (!result) return 'Claude ended without a terminal result.'
  if (result.subtype === 'success') return null
  return claudeRuntimeErrorMessage(
    redactClaudeCredentials(result.errors.filter(Boolean).join('\n') || `Claude stopped with ${result.subtype}.`),
    modelId
  )
}

async function prepareRuntime(
  args: InspectClaudeSessionCompatibilityArgs,
  assistantId: string,
  state: RunnerState
): Promise<PreparedRuntime> {
  const capabilityMode = capabilityBehaviorFor(args.mode)
  const activateTerminalStep = (toolCallId: string): void => {
    state.planSubmitted = true
    state.planToolCallId = toolCallId
    state.planResultAcknowledged = false
    if (state.planAcknowledgementTimer) clearTimeout(state.planAcknowledgementTimer)
    // Do not interrupt until the provider emits the matching tool_result. Closing
    // before that event would persist an assistant/tool_use without its result.
    state.planAcknowledgementTimer = setTimeout(() => {
      if (state.planResultAcknowledged) return
      state.queryAbortController?.abort(new Error('Claude did not acknowledge the terminal tool result.'))
      state.query?.close()
    }, 10_000)
    state.planAcknowledgementTimer.unref?.()
  }
  const makeContext = (toolCallId: string, toolSignal: AbortSignal): ToolContext => ({
    conversationId: args.conversationId,
    projectId: args.projectId,
    messageId: assistantId,
    toolCallId,
    cwd: args.cwd,
    signal: toolSignal,
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
        signal: toolSignal,
      })
    },
    askQuestion: (questions) =>
      args.questionBroker.ask({
        conversationId: args.conversationId,
        messageId: assistantId,
        toolCallId,
        questions,
        signal: toolSignal,
      }),
    submitPlan: (plan, title) => {
      const result = stagePlan({ agentId: args.conversationId, cwd: args.cwd, plan, title })
      if (!result.ok) return false
      activateTerminalStep(toolCallId)
      return true
    },
    ...(args.reviewerRuntime
      ? {
          reviewer: {
            recordEvidence: (kind) => args.reviewerRuntime!.recordEvidence(kind),
            searchExecutionContext: (input) => args.reviewerRuntime!.searchExecutionContext(input),
            readExecutionContext: (input) => args.reviewerRuntime!.readExecutionContext(input),
            submitReview: (decision) => {
              const result = args.reviewerRuntime!.submitReview(decision)
              if (result.ok) activateTerminalStep(toolCallId)
              return result
            },
          } satisfies ReviewerToolRuntime,
        }
      : {}),
    ...(state.emitGeneratedImage
      ? { emitGeneratedImage: (image: GeneratedImageEmission) => state.emitGeneratedImage?.(toolCallId, image) }
      : {}),
    ...(state.onGeneratedImageUsage ? { onGeneratedImageUsage: state.onGeneratedImageUsage } : {}),
  })
  const enabledBuiltins = args.reviewerRuntime
    ? new Set(REVIEWER_READONLY_TOOL_NAMES)
    : builtinToolNamesForMode(args.mode)
  // generate_image is OPT-IN and exists only when a part can be published: toggle enabled + ChatGPT subscription
  // connected (it generates the image even here, in a conversation running on Claude).
  if (
    !args.reviewerRuntime &&
    state.emitGeneratedImage &&
    (await generateImageToolEnabled(args.conversationId, args.mode))
  ) {
    enabledBuiltins.add(GENERATE_IMAGE_TOOL_NAME)
  }
  const core = buildTools({ enabled: enabledBuiltins, makeCtx: makeContext })
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
  const mcp = args.reviewerRuntime
    ? { tools: {}, close: async () => {} }
    : await buildMcpTools({
        mode: args.mode,
        signal: args.signal,
        gate,
        disabledIds,
        supportsImages: true,
        describeImage: (image) =>
          describeEphemeralToolImage({
            image,
            conversationId: args.conversationId,
            cwd: args.cwd,
            signal: args.signal,
          }),
      })
  const app = appToolsEnabled
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
  try {
    const skills =
      args.reviewerRuntime || args.mode === 'ask'
        ? []
        : (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
    const skillTools: ToolSet = skills.length
      ? {
          use_skill: tool({
            description: 'Loads the complete instructions for a Maestrly project skill before acting.',
            inputSchema: jsonSchema<{ name: string }>({
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            }),
            execute: async ({ name }) => {
              const skill = await findEffectiveSkill(args.cwd, args.conversationId, name)
              // Disabled, missing, or `disable-model-invocation` means nonexistent from the model's perspective.
              return skill?.modelInvocable
                ? renderSkillContext(skill)
                : `Skill "${name}" not found. Available: ${skills.map((item) => item.name).join(', ') || '(none)'}`
            },
          }),
        }
      : {}
    const allAgents = args.reviewerRuntime
      ? []
      : await listEffectiveAgents({
          cwd: args.cwd,
          conversationId: args.conversationId,
          mode: capabilityMode === 'agent' || args.mode === 'maestro' ? 'agent' : 'plan',
        })
    const agents =
      args.mode === 'maestro' && args.maestro
        ? maestroAgentsFromTurn(args.maestro, allAgents)
        : capabilityMode === 'agent'
          ? allAgents
          : args.maestrlyUltra
            ? allAgents.filter((agent) => agent.name === 'explore')
            : []
    const delegationToolName = args.mode === 'maestro' ? 'delegate' : 'task'
    const taskTools: ToolSet = agents.length
      ? {
          [delegationToolName]: tool({
            description:
              args.mode === 'maestro'
                ? MAESTRO_DELEGATE_TOOL_DESCRIPTION
                : 'Delegates one focused, self-contained task to an isolated Maestrly subagent. Include all required context.',
            inputSchema: jsonSchema(
              args.mode === 'maestro'
                ? MAESTRO_DELEGATE_TOOL_SCHEMA
                : {
                    type: 'object',
                    properties: {
                      agent: { type: 'string', enum: agents.map((agent) => agent.name) },
                      prompt: { type: 'string' },
                    },
                    required: ['agent', 'prompt'],
                    additionalProperties: false,
                  }
            ),
            execute: async (input, options) => {
              if (!state.runTask) throw new Error('The Maestrly subagent executor is not ready.')
              const result = await state.runTask(
                input,
                options.toolCallId,
                options.abortSignal ?? args.signal,
                (update) => {
                  if (update.sub) state.subagentRuns.set(options.toolCallId, update.sub)
                }
              )
              if (result.error) throw new Error(result.error)
              return result.output
            },
          }),
        }
      : {}
    const rawTools: ToolSet = { ...core, ...mcp.tools, ...app.tools, ...skillTools }
    const hostTools: ToolSet = adaptToolSetForModel({
      tools: rawTools,
      supportsImages: !args.dropImages,
      describeImage: (image) =>
        describeEphemeralToolImage({ image, conversationId: args.conversationId, cwd: args.cwd, signal: args.signal }),
    })
    const supervisionTools = agents.length
      ? buildSubagentSupervisionTools({
          conversationId: args.conversationId,
          parentMessageId: assistantId,
          maestro: args.mode === 'maestro',
          signal: args.signal,
        })
      : {}
    const tools: ToolSet = { ...hostTools, ...taskTools, ...supervisionTools }
    const bridge = await buildClaudeToolBridge(tools, args.signal, undefined, () =>
      args.manager.assertAccountIdentity(args.accountIdentity)
    )
    const projectContext = await buildProjectContext(args.projectId, args.cwd)
    const git = await gitEnvInfo(args.cwd).catch(() => null)
    const platform =
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
    const env = [
      `OS: ${platform}.`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
      `Project directory: ${args.cwd}.`,
      git ? `Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const ultra = args.maestrlyUltra
      ? args.mode === 'maestro'
        ? 'Maximum-rigor reasoning applies only to the orchestrator. Keep the frozen Strategy and choose agents deliberately from the Pool.'
        : args.mode === 'design'
          ? renderDesignUltraGuidance(args.mode)
          : args.mode === 'agent'
            ? 'Maximum-rigor Maestrly Ultra mode is active. Decompose non-trivial work, delegate independent slices through task when useful, integrate results, verify, and review before finishing.'
            : 'Maximum-rigor Maestrly Ultra mode is active. Stay read-only, investigate deeply, and cross-check the conclusion.'
      : ''
    const behaviorProfile =
      args.behaviorProfile === undefined
        ? resolveFableBehaviorProfile({
            requestedModelId: args.selection.modelId,
            resolvedModelId: args.frozenResolvedModelId ?? args.resolvedModelId,
            enabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
          }).profile
        : args.behaviorProfile
    const systemPrompt = [
      SYSTEM_PROMPT(
        args.cwd,
        appToolsEnabled,
        args.mode,
        Boolean(getConversation(args.conversationId)),
        behaviorProfile
      ),
      '# Active runtime\nYou are running through the official Anthropic Claude Agent SDK. Maestrly owns the system prompt, tools, permissions, skills, subagents, plans, questions and persistence. Use only the supplied Maestrly MCP tools; native Claude Code extensions are disabled.',
      projectContext,
      skills.length ? `# Project skills\n${skillsCatalog(skills)}` : '',
      agents.length
        ? args.mode === 'maestro'
          ? renderMaestroAgentCatalog(args.maestro!)
          : `# Maestrly subagents\n${agentsCatalog(agents, args.conversationId, capabilityMode !== 'agent')}`
        : '',
      args.mode === 'maestro' && args.maestro ? renderMaestroTurnPolicy(args.maestro) : '',
      ultra ? `# Ultra mode\n${ultra}` : '',
      behaviorProfile ? '' : `# Environment\n${env}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    return {
      tools: hostTools,
      rawTools,
      bridge,
      systemPrompt,
      promptHash: createHash('sha256').update(systemPrompt).digest('hex'),
      ...(behaviorProfile ? { transientContext: fableEnvironmentContext(env) } : {}),
      ...(behaviorProfile ? { fablePostToolUseHook: createFablePostToolUseHook() } : {}),
      ...(behaviorProfile ? { behaviorProfile } : {}),
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

/**
 * Rebuilds the effective Maestrly harness/tool surface and checks whether the
 * persisted Claude session can safely remain authoritative for the next turn.
 */
export async function inspectClaudeSessionCompatibility(args: InspectClaudeSessionCompatibilityArgs): Promise<boolean> {
  const binding = getClaudeSessionBinding(args.conversationId)
  if (!binding) return false
  const state: RunnerState = {
    planSubmitted: false,
    planToolCallId: null,
    planResultAcknowledged: false,
    planAcknowledgementTimer: null,
    subagentRuns: new Map(),
    query: null,
    runTask: null,
    queryAbortController: null,
    coordinator: new SubagentCoordinator({ onEvent: () => {} }),
  }
  let runtime: PreparedRuntime | null = null
  try {
    args.signal.throwIfAborted()
    args.manager.assertAccountIdentity(args.accountIdentity)
    runtime = await prepareRuntime(args, `claude_inspect_${randomUUID()}`, state)
    args.signal.throwIfAborted()
    if (
      !isClaudeSessionBindingCompatible(binding, {
        modelId: args.resolvedModelId ?? args.selection.modelId,
        reasoningEffort: args.reasoningEffort,
        fastMode: args.fastMode,
        cwd: args.cwd,
        promptHash: runtime.promptHash,
        toolSignature: runtime.bridge.toolSignature,
        accountIdentity: args.accountIdentity,
        accountId: args.manager.accountId,
      })
    ) {
      return false
    }
    // Resume boundary = MAIN context (isolated rounds never move the conversation binding).
    const previousMessage = lastConversationContextMessage(args.conversationId)
    if (binding.lastMessageId === previousMessage?.id) return true
    if (!previousMessage) return false
    const mapping = getClaudeMessageMapping(args.conversationId, previousMessage.id)
    return Boolean(mapping?.sessionId === binding.sessionId && mapping.sdkAssistantUuid)
  } finally {
    await runtime?.close().catch(() => undefined)
  }
}

/** Official Claude runtime adapter: Maestrly owns product behavior while Agent SDK owns the agent loop. */
export async function runClaudeChat(args: RunClaudeChatArgs): Promise<RunClaudeChatResult> {
  if (args.signal.aborted) throw new Error('Turn aborted before Claude started.')
  args.manager.assertAccountIdentity(args.accountIdentity)
  if (!args.accountIdentity.fingerprint) throw new Error('Claude is not authenticated.')
  if (args.ephemeralSession && args.frozenResolvedModelId) {
    let liveResolvedModelId: string | null
    try {
      liveResolvedModelId = await args.manager.resolveModelId(args.selection.modelId, args.signal, true)
    } catch (error) {
      args.signal.throwIfAborted()
      throw new Error('executor-unavailable', { cause: error })
    }
    if (liveResolvedModelId !== args.frozenResolvedModelId) throw new Error('executor-unavailable')
  }
  const responseStartedAt = args.responseStartedAt ?? Date.now()
  const history = runnerContextHistory(args.conversationId, {
    ephemeralSession: args.ephemeralSession,
    executionScope: args.messageMeta?.executionScope,
  })
  const currentUser = history.at(-1)
  if (currentUser?.role !== 'user') throw new Error('Current user message was not persisted.')

  const assistantId = randomUUID()
  const createdAt = Date.now()
  let messages: StoredChatMessage[] = [
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
  let dirty = false
  let terminalCommitted = false
  let lastPersistAt = 0
  const persist = (): void => {
    dirty = false
    lastPersistAt = Date.now()
    upsertChatMessage(messages[0])
  }
  const coalescer = createDeltaCoalescer(args.emit)
  /** `publicEvent` omits contextIdentity for IPC when an event carries internal usage. */
  const apply = (event: ChatStreamEvent, force = false, publicEvent?: ChatStreamEvent): void => {
    messages = applyChatEvent(messages, event) as StoredChatMessage[]
    coalescer.push(publicEvent ?? event)
    if (force || Date.now() - lastPersistAt > 300) persist()
    else dirty = true
  }
  const applyWithUsage = (base: ChatStreamEvent, usage: StoredChatUsage | undefined, force = true): void => {
    const stored = { ...base, ...(usage ? { usage } : {}) } as ChatStreamEvent
    const publicUsage = toPublicChatUsage(usage)
    const pub = { ...base, ...(publicUsage ? { usage: publicUsage } : {}) } as ChatStreamEvent
    apply(stored, force, pub)
  }
  const currentToolState = (toolCallId: string) => {
    const part = messages[0]?.parts.find(
      (candidate) => candidate.type === 'tool' && candidate.toolCallId === toolCallId
    )
    return part?.type === 'tool' ? part.state : undefined
  }
  const assistantTextOnlyRepeats = (diagnostic: string): boolean => {
    const textParts = messages[0]?.parts.filter(
      (part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text'
    )
    if (!textParts?.length) return false
    return (
      textParts
        .map((part) => part.text)
        .join('')
        .trim() === diagnostic.trim()
    )
  }
  const applyAuthenticationRequired = (diagnostic: string, usage?: StoredChatUsage): void => {
    applyWithUsage(
      {
        kind: 'error' as const,
        messageId: assistantId,
        message: CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE,
        code: 'claude-authentication-required' as const,
        removeAssistantText: assistantTextOnlyRepeats(diagnostic),
        responseDurationMs: responseDurationMs(responseStartedAt),
      },
      usage
    )
    terminalCommitted = true
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

  const queryAbortController = new AbortController()
  const runtimeSignal = AbortSignal.any([args.signal, queryAbortController.signal])
  const state: RunnerState = {
    planSubmitted: false,
    planToolCallId: null,
    planResultAcknowledged: false,
    planAcknowledgementTimer: null,
    subagentRuns: new Map(),
    query: null,
    runTask: null,
    queryAbortController,
    coordinator: new SubagentCoordinator({
      onEvent: (event) =>
        chatDiag({
          kind: 'subagent-coordinator',
          runtime: 'claude-subscription',
          conv: args.conversationId,
          ...event,
        }),
    }),
    emitGeneratedImage: (toolCallId, image) => emitGeneratedImagePart(apply, assistantId, toolCallId, image),
    onGeneratedImageUsage: (usage) => mergeGeneratedImageUsage(subagentUsage, usage),
  }
  const subagentUsage = new Map<string, ChatSubagentUsage>()
  let runtime: PreparedRuntime | null = null
  let sessionId = ''
  let sessionAccepted = false
  let sessionPersisted = false
  let result: SDKResultMessage | null = null
  let context: ClaudeContextSnapshot | null = null
  let streamMapper: ReturnType<typeof createClaudeStreamMapper> | null = null
  let fatal: string | null = null
  let queryClosed = false
  let abortCloseTimer: ReturnType<typeof setTimeout> | null = null
  let planInterruptCloseTimer: ReturnType<typeof setTimeout> | null = null
  let inTurnCompactions = 0
  let currentAttemptUsageArchived = false
  const completedAttemptUsage: NormalizedClaudeUsage[] = []
  const portableCompactorUsage: NormalizedClaudeUsage[] = []
  /** AGGREGATE native estimate for intra-turn compactions (only when complete; see summarizePortableTranscript). */
  let portableCompactorRuntimeCostUsd = 0
  /** Compaction tokens WITHOUT native estimates: depend on the catalog (never covered by main). */
  const portableCompactorCatalogUsage: NormalizedClaudeUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalInput: 0,
  }
  /**
   * Compaction tokens COVERED by native estimates: when main has no runtime cost, these tokens NEVER return to the
   * catalog residual (otherwise the auxiliary call would be priced TWICE).
   */
  const portableCompactorRuntimeCoveredUsage: NormalizedClaudeUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalInput: 0,
  }
  const retiredSessionIds = new Set<string>()
  const portableContextWindow = safeTokens(args.contextWindow)
  const runtimeModelId = args.frozenResolvedModelId ?? args.resolvedModelId ?? args.selection.modelId
  const closeQuery = (): void => {
    if (queryClosed) return
    queryClosed = true
    state.query?.close()
  }
  const onAbort = (): void => {
    queryAbortController.abort(args.signal.reason ?? new Error('Claude turn aborted.'))
    abortCloseTimer = setTimeout(closeQuery, 1_000)
    abortCloseTimer.unref?.()
    void state.query?.interrupt().catch(() => undefined)
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  if (args.signal.aborted) onAbort()

  const retireManagedSession = async (retiredSessionId: string): Promise<void> => {
    if (!retiredSessionId || retiredSessionIds.has(retiredSessionId)) return
    retiredSessionIds.add(retiredSessionId)
    retireClaudeSessionBinding(args.conversationId, retiredSessionId)
    queueClaudeSessionCleanup(args.conversationId, retiredSessionId, args.cwd, args.manager.accountId ?? null)
    try {
      await args.manager.deleteManagedSession(retiredSessionId, args.cwd)
      clearClaudeSessionCleanup(retiredSessionId)
    } catch (error) {
      markClaudeSessionCleanupFailed(retiredSessionId, claudeSubscriptionErrorMessage(error))
    }
  }

  try {
    runtime = await prepareRuntime({ ...args, signal: runtimeSignal }, assistantId, state)
    chatDiag({
      kind: 'fable-behavior-profile',
      profile: runtime.behaviorProfile?.id ?? 'legacy',
      requestedModel: args.selection.modelId,
      resolvedModel: runtimeModelId,
      transport: 'claude-agent-sdk',
      effort: args.reasoningEffort ?? 'default',
      progressMode: runtime.behaviorProfile?.progressMode ?? 'prompt-only',
      conv: args.conversationId,
    })
    args.signal.throwIfAborted()
    state.runTask = args.reviewerRuntime
      ? null
      : createClaudeTaskRuntime({
          conversationId: args.conversationId,
          projectId: args.projectId,
          cwd: args.cwd,
          mode: args.mode,
          maestro: args.maestro,
          maestroLive: args.maestroLive,
          permMode: args.permMode,
          selection: args.selection,
          reasoningEffort: args.reasoningEffort,
          fastMode: args.fastMode === true,
          manager: args.manager,
          accountIdentity: args.accountIdentity,
          broker: args.broker,
          questionBroker: args.questionBroker,
          assistantId,
          agents: runtime.agents,
          tools: runtime.rawTools,
          coordinator: state.coordinator,
          subagentUsage,
          apply,
          emitGeneratedImage: state.emitGeneratedImage,
          onGeneratedImageUsage: state.onGeneratedImageUsage,
          turnState: createExplicitSubagentTurnState(
            detectExplicitSubagentsForTurn(
              history,
              runtime.agents.map((agent) => agent.name)
            ),
            runtime.agents.map((agent) => agent.name)
          ),
        })

    const previousMessage = history.at(-2) ?? null
    const existing = getClaudeSessionBinding(args.conversationId)
    const compatible =
      !args.ephemeralSession &&
      isClaudeSessionBindingCompatible(existing, {
        modelId: runtimeModelId,
        reasoningEffort: args.reasoningEffort,
        fastMode: args.fastMode,
        cwd: args.cwd,
        promptHash: runtime.promptHash,
        toolSignature: runtime.bridge.toolSignature,
        accountIdentity: args.accountIdentity,
        accountId: args.manager.accountId,
      })
    const mapping = previousMessage ? getClaudeMessageMapping(args.conversationId, previousMessage.id) : null
    const resolution = resolveClaudeSession({
      binding: existing,
      compatible,
      previousMessageId: previousMessage?.id ?? null,
      mappedAssistantUuid: mapping?.sdkAssistantUuid ?? null,
      mappedSessionId: mapping?.sessionId ?? null,
    })
    chatDiag({
      kind: 'claude-session-resolution',
      profile: runtime.behaviorProfile?.id ?? 'legacy',
      model: runtimeModelId,
      conv: args.conversationId,
      resume: Boolean(resolution.resume),
      fork: resolution.forkSession,
      retire: resolution.retireExisting,
      reason: args.ephemeralSession
        ? 'ephemeral'
        : !existing
          ? 'no-binding'
          : !compatible
            ? 'incompatible-contract'
            : resolution.forkSession
              ? 'rewind-fork'
              : resolution.resume
                ? 'tip-resume'
                : 'history-diverged',
    })
    if (resolution.retireExisting && existing && !args.ephemeralSession) {
      retireClaudeSessionBinding(args.conversationId, existing.sessionId)
    }
    let intentionalPlanInterruptIssued = false
    let intentionalPlanInterruptCaught = false
    const contextIdentity = createHash('sha256')
      .update(
        `${args.selection.providerId}\0${runtimeModelId}\0${args.accountIdentity.fingerprint}\0${runtime.promptHash}`
      )
      .digest('hex')
    let nextPrompt = buildClaudeSessionPrompt(currentUser, claudeSeedTranscript(history, resolution.resume), {
      dropImages: args.dropImages,
      transientContext: runtime.transientContext,
    })
    let nextResume: Pick<
      Parameters<typeof buildClaudeChatQueryOptions>[0],
      'resume' | 'resumeSessionAt' | 'forkSession'
    > = {
      resume: resolution.resume,
      resumeSessionAt: resolution.resumeSessionAt,
      forkSession: resolution.forkSession,
    }
    let maestroGuarded = false

    while (true) {
      queryClosed = false
      result = null
      context = null
      sessionId = ''
      sessionAccepted = false
      intentionalPlanInterruptIssued = false
      intentionalPlanInterruptCaught = false
      state.query = args.manager.createQuery({
        prompt: nextPrompt.prompt,
        options: buildClaudeChatQueryOptions({
          abortController: queryAbortController,
          cwd: args.cwd,
          modelId: runtimeModelId,
          reasoningEffort: args.reasoningEffort,
          fastMode: args.fastMode,
          systemPrompt: runtime.systemPrompt,
          bridge: runtime.bridge,
          postToolUseHook: runtime.fablePostToolUseHook,
          disallowedNativeTools: CLAUDE_DISALLOWED_NATIVE_TOOLS,
          ...nextResume,
        }),
      })
      const activeQuery = state.query
      try {
        const initialized = await activeQuery.initializationResult()
        args.manager.assertSubscriptionRuntimeAccount(initialized.account, args.accountIdentity)
        args.manager.assertAccountIdentity(args.accountIdentity)
        args.signal.throwIfAborted()
        nextPrompt.release()
      } catch (error) {
        nextPrompt.reject(error)
        throw error
      }

      const contextCapturedMessageIds = new Set<string>()
      let portableCompactionRequested = false
      let portableInterruptPromise: Promise<unknown> | null = null
      const captureContext = async (): Promise<boolean> => {
        if (runtimeSignal.aborted || queryClosed) return false
        const measured = await settleWithin(activeQuery.getContextUsage(), 1_500, runtimeSignal)
        if (!measured) return false
        const totalTokens = safeTokens(measured.totalTokens)
        const maxTokens = safeTokens(measured.maxTokens)
        context = {
          totalTokens,
          maxTokens,
          percentage:
            Number(measured.percentage) > 0
              ? Number(measured.percentage)
              : maxTokens
                ? (totalTokens / maxTokens) * 100
                : 0,
          model: measured.model || runtimeModelId,
        }
        if (maxTokens) args.onModelContextWindow?.(maxTokens)
        return true
      }
      const requestPortableCompaction = (): boolean => {
        const runtimeContextWindow = context?.maxTokens ?? 0
        const compactionWindow =
          portableContextWindow > 0 && runtimeContextWindow > 0
            ? Math.min(portableContextWindow, runtimeContextWindow)
            : Math.max(portableContextWindow, runtimeContextWindow)
        if (
          portableCompactionRequested ||
          state.planSubmitted ||
          inTurnCompactions >= MAX_IN_TURN_COMPACTIONS ||
          compactionWindow <= 0 ||
          !args.compactHistory ||
          !context ||
          context.totalTokens / compactionWindow < IN_TURN_COMPACT_RATIO
        ) {
          return false
        }
        // compactHistory reads the durable conversation. Publish the provider's folded prefix first.
        persist()
        portableCompactionRequested = true
        portableInterruptPromise = activeQuery.interrupt().catch(() => undefined)
        closeQuery()
        return true
      }
      streamMapper = createClaudeStreamMapper(assistantId, runtime.bridge.nameFromSdk)
      currentAttemptUsageArchived = false
      const applyMappedEvents = (events: readonly ChatStreamEvent[]): void => {
        for (const event of events) {
          apply(event, event.kind === 'tool-call' && event.toolName === 'ask_question')
        }
      }
      const ensureSession = (message: SDKMessage): void => {
        if (!('session_id' in message) || !message.session_id || sessionId) return
        sessionId = message.session_id
        // Isolated: create a durable tombstone as soon as the remote ID exists; finally hard-deletes it.
        if (args.ephemeralSession) {
          queueClaudeSessionCleanup(args.conversationId, sessionId, args.cwd, args.manager.accountId ?? null)
        }
        sessionAccepted = args.onSessionReady?.(sessionId) ?? true
        if (!sessionAccepted) {
          void activeQuery.interrupt().catch(() => undefined)
          throw new Error('Claude session was discarded because the conversation is being closed.')
        }
      }
      const ensureProgressTool = (toolCallId: string, toolName: string, input: unknown): void => {
        if (!currentToolState(toolCallId)) {
          const normalized = runtime!.bridge.nameFromSdk(toolName)
          apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId, toolName: normalized })
          apply(
            { kind: 'tool-call', messageId: assistantId, toolCallId, toolName: normalized, input },
            normalized === 'ask_question'
          )
          apply({ kind: 'tool-state', messageId: assistantId, toolCallId, state: { status: 'running' } })
        }
      }
      const handleUser = async (message: Extract<SDKMessage, { type: 'user' }>): Promise<boolean> => {
        const mapped = streamMapper!.pushUser(message, state.subagentRuns, runtime!.bridge.takeToolOutput)
        let toolResultIndex = 0
        let foldedToolResult = false
        for (const event of mapped.events) {
          const finalToolState =
            event.kind === 'tool-state' && (event.state.status === 'completed' || event.state.status === 'error')
          apply(event, finalToolState)
          if (!finalToolState) continue
          const toolResult = mapped.toolResults[toolResultIndex++]
          if (!toolResult) continue
          foldedToolResult = true
          state.subagentRuns.delete(toolResult.toolCallId)
          if (toolResult.toolCallId === state.planToolCallId) {
            state.planResultAcknowledged = !toolResult.isError
            if (state.planAcknowledgementTimer) {
              clearTimeout(state.planAcknowledgementTimer)
              state.planAcknowledgementTimer = null
            }
            if (state.planResultAcknowledged) {
              // getContextUsage is a live control request. Capture it before the
              // intentional interrupt tears down the Claude Code transport.
              await captureContext()
              intentionalPlanInterruptIssued = true
              // The matching tool result is now folded and persisted. Interrupting from
              // this boundary preserves a resumable provider-native transcript.
              void activeQuery.interrupt().catch(() => undefined)
              planInterruptCloseTimer = setTimeout(closeQuery, 2_000)
              planInterruptCloseTimer.unref?.()
            }
          }
        }
        if (!foldedToolResult || intentionalPlanInterruptIssued || !(await captureContext())) return false
        return requestPortableCompaction()
      }

      try {
        for await (const sdkMessage of activeQuery) {
          ensureSession(sdkMessage)
          if (sdkMessage.type === 'stream_event' && !sdkMessage.parent_tool_use_id) {
            applyMappedEvents(streamMapper.pushPartial(sdkMessage))
          } else if (sdkMessage.type === 'assistant' && !sdkMessage.parent_tool_use_id) {
            applyMappedEvents(streamMapper.pushAssistant(sdkMessage))
            if (
              sdkMessage.message.stop_reason != null &&
              sdkMessage.message.stop_reason !== 'tool_use' &&
              !contextCapturedMessageIds.has(sdkMessage.message.id) &&
              (await captureContext())
            ) {
              contextCapturedMessageIds.add(sdkMessage.message.id)
              if (requestPortableCompaction()) break
            }
          } else if (sdkMessage.type === 'user' && !sdkMessage.parent_tool_use_id) {
            if (await handleUser(sdkMessage)) break
          } else if (sdkMessage.type === 'tool_progress' && !sdkMessage.parent_tool_use_id) {
            const existingState = currentToolState(sdkMessage.tool_use_id)
            if (existingState?.status === 'completed' || existingState?.status === 'error') continue
            const call = streamMapper.tool(sdkMessage.tool_use_id)
            ensureProgressTool(
              sdkMessage.tool_use_id,
              runtime.bridge.nameFromSdk(sdkMessage.tool_name),
              call?.input ?? {}
            )
            apply({
              kind: 'tool-state',
              messageId: assistantId,
              toolCallId: sdkMessage.tool_use_id,
              state: {
                status: 'running',
                output: `${runtime.bridge.nameFromSdk(sdkMessage.tool_name)} running (${sdkMessage.elapsed_time_seconds}s)`,
                ...(state.subagentRuns.get(sdkMessage.tool_use_id)
                  ? { sub: state.subagentRuns.get(sdkMessage.tool_use_id) }
                  : {}),
              },
            })
          } else if (sdkMessage.type === 'tool_use_summary') {
            for (const toolCallId of sdkMessage.preceding_tool_use_ids) {
              const existingState = currentToolState(toolCallId)
              if (existingState?.status === 'completed' || existingState?.status === 'error') continue
              apply({
                kind: 'tool-state',
                messageId: assistantId,
                toolCallId,
                state: {
                  status: 'completed',
                  output: clipPersistedToolOutput(sdkMessage.summary),
                  ...(state.subagentRuns.get(toolCallId) ? { sub: state.subagentRuns.get(toolCallId) } : {}),
                },
              })
            }
          } else if (sdkMessage.type === 'result') {
            result = sdkMessage
          }
        }
      } catch (error) {
        if (portableCompactionRequested && !args.signal.aborted) {
          // Interrupting an overfull provider attempt can end in a normal SDK transport diagnostic.
        } else if (
          intentionalPlanInterruptIssued &&
          state.planSubmitted &&
          state.planResultAcknowledged &&
          !args.signal.aborted &&
          isIntentionalPlanInterruptDiagnostic(error)
        ) {
          intentionalPlanInterruptCaught = true
          chatDiag({
            kind: 'claude-plan-interrupt-terminal',
            runtime: 'claude-subscription',
            conv: args.conversationId,
            resultSubtype: result?.subtype ?? null,
          })
        } else {
          throw error
        }
      }

      if (!portableCompactionRequested || args.signal.aborted || state.planSubmitted) {
        const pendingGuard =
          args.mode === 'maestro' &&
          !maestroGuarded &&
          !args.signal.aborted &&
          !state.planSubmitted &&
          unobservedTurnDelegations(args.conversationId, assistantId).length > 0
        if (pendingGuard) {
          const attemptUsage = aggregateClaudeUsage(streamMapper.state().assistantUsageByMessageId.values())
          if (attemptUsage) completedAttemptUsage.push(attemptUsage)
          currentAttemptUsageArchived = true
          const resumeSessionId = sessionId
          const delegations = await waitForTurnDelegationsTerminal(args.conversationId, assistantId, args.signal)
          for (const delegation of delegations) markDelegationObserved(delegation.id)
          persist()
          const continuationTranscript = renderTranscript([...history, messages[0]], {
            maxToolOutputChars: 16_000,
            maxChars: 800_000,
          })
          const guardMessage: ChatMessage = {
            id: randomUUID(),
            conversationId: args.conversationId,
            role: 'user',
            internal: true,
            parts: [
              {
                type: 'text',
                id: randomUUID(),
                text:
                  'Host guard: delegated sessions have settled. Inspect any needed transcript, reconcile every ' +
                  `result, and only then produce the final answer. Sessions: ${JSON.stringify(
                    delegations.map((entry) => ({
                      sessionId: entry.id,
                      agent: entry.agentName,
                      status: entry.status,
                      tools: entry.toolNames,
                      files: entry.files,
                      tests: entry.tests,
                      error: entry.error,
                    }))
                  )}`,
              },
            ],
            createdAt: Date.now(),
          }
          nextPrompt = buildClaudeSessionPrompt(guardMessage, continuationTranscript, {
            dropImages: args.dropImages,
          })
          nextResume = resumeSessionId ? { resume: resumeSessionId } : {}
          maestroGuarded = true
          continue
        }
        break
      }
      if (portableInterruptPromise) await settleWithin(portableInterruptPromise, 2_000, args.signal)
      persist()
      const compactionContext = context as ClaudeContextSnapshot | null

      let compacted: Awaited<ReturnType<NonNullable<RunClaudeChatArgs['compactHistory']>>> = null
      try {
        compacted = await args.compactHistory!()
      } catch {
        compacted = null
      }
      const summary = compacted?.summary.trim()
      if (!compacted || !summary) {
        fatal = 'Claude portable intra-turn compaction failed.'
        chatDiag({
          kind: 'claude-subscription-in-turn-compact-failed',
          compacts: inTurnCompactions,
          contextInput: compactionContext?.totalTokens ?? 0,
          contextWindow:
            portableContextWindow > 0 && (compactionContext?.maxTokens ?? 0) > 0
              ? Math.min(portableContextWindow, compactionContext?.maxTokens ?? 0)
              : Math.max(portableContextWindow, compactionContext?.maxTokens ?? 0),
          model: runtimeModelId,
          conv: args.conversationId,
        })
        break
      }

      const attemptUsage = aggregateClaudeUsage(streamMapper.state().assistantUsageByMessageId.values())
      const compactorUsage = normalizedPortableUsage(compacted.usage)
      const markerUsage = aggregateClaudeUsage([
        ...completedAttemptUsage,
        ...portableCompactorUsage,
        ...(attemptUsage ? [attemptUsage] : []),
        ...(compactorUsage ? [compactorUsage] : []),
      ])
      // Compaction cost: add complete native estimates (tokens marked as covered); token-only usage
      // uses the catalog (main does not cover it).
      if (compacted.runtimeEstimatedCostUsd != null) {
        portableCompactorRuntimeCostUsd += Math.max(0, compacted.runtimeEstimatedCostUsd)
        if (compactorUsage) {
          portableCompactorRuntimeCoveredUsage.input += compactorUsage.input
          portableCompactorRuntimeCoveredUsage.output += compactorUsage.output
          portableCompactorRuntimeCoveredUsage.cacheRead += compactorUsage.cacheRead
          portableCompactorRuntimeCoveredUsage.cacheCreate += compactorUsage.cacheCreate
        }
      } else if (compactorUsage) {
        portableCompactorCatalogUsage.input += compactorUsage.input
        portableCompactorCatalogUsage.output += compactorUsage.output
        portableCompactorCatalogUsage.cacheRead += compactorUsage.cacheRead
        portableCompactorCatalogUsage.cacheCreate += compactorUsage.cacheCreate
      }
      const compactorAux = {
        runtimeCostUsd: portableCompactorRuntimeCostUsd,
        catalogTokens: portableCompactorCatalogUsage,
        runtimeCoveredTokens: portableCompactorRuntimeCoveredUsage,
      }
      inTurnCompactions += 1
      applyWithUsage(
        {
          kind: 'compaction' as const,
          messageId: assistantId,
          partId: randomUUID(),
          text: summary,
          strategy: 'summary' as const,
        },
        usageFromResult(
          null,
          compactionContext,
          [...subagentUsage.values()],
          contextIdentity,
          markerUsage,
          markerUsage,
          compactorAux
        )
      )
      chatDiag({
        kind: 'claude-subscription-in-turn-compact',
        compacts: inTurnCompactions,
        contextInput: compactionContext?.totalTokens ?? 0,
        contextWindow:
          portableContextWindow > 0 && (compactionContext?.maxTokens ?? 0) > 0
            ? Math.min(portableContextWindow, compactionContext?.maxTokens ?? 0)
            : Math.max(portableContextWindow, compactionContext?.maxTokens ?? 0),
        model: runtimeModelId,
        conv: args.conversationId,
      })
      if (attemptUsage) completedAttemptUsage.push(attemptUsage)
      if (compactorUsage) portableCompactorUsage.push(compactorUsage)
      currentAttemptUsageArchived = true

      // A portable summary makes the provider-native history stale. Never resume this session again.
      const supersededSessionId = sessionId
      await retireManagedSession(supersededSessionId)
      // Isolated: NEVER retire the conversation's MAIN binding (existing); retire only the ephemeral session.
      if (!args.ephemeralSession && existing && existing.sessionId !== supersededSessionId) {
        await retireManagedSession(existing.sessionId)
      }
      if (args.signal.aborted) break

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
      }
      nextPrompt = buildClaudeSessionPrompt(continueMessage, continuationTranscript, {
        dropImages: args.dropImages,
        transientContext: runtime.transientContext,
      })
      nextResume = {}
    }

    const mapperState = streamMapper.state()
    const fallbackMainUsage = currentAttemptUsageArchived
      ? undefined
      : aggregateClaudeUsage(mapperState.assistantUsageByMessageId.values())
    const lastRequestUsage = currentAttemptUsageArchived ? null : mapperState.latestAssistantUsage
    const fallbackContextTokens = lastRequestUsage ? lastRequestUsage.totalInput + lastRequestUsage.output : 0
    const intentionalPlanInterruptAccepted =
      intentionalPlanInterruptCaught ||
      (intentionalPlanInterruptIssued &&
        state.planSubmitted &&
        state.planResultAcknowledged &&
        !args.signal.aborted &&
        result?.subtype !== 'success' &&
        isIntentionalPlanInterruptDiagnostic(result))
    const fallbackContextWindow = resultModelContextWindow(result, runtimeModelId, mapperState.lastAssistantModelId)
    let resolvedContext = context as ClaudeContextSnapshot | null
    if (!resolvedContext && (fallbackContextTokens || fallbackContextWindow)) {
      resolvedContext = {
        totalTokens: fallbackContextTokens,
        maxTokens: fallbackContextWindow,
        percentage:
          fallbackContextWindow && fallbackContextTokens ? (fallbackContextTokens / fallbackContextWindow) * 100 : 0,
        model: runtimeModelId,
      }
    } else if (resolvedContext) {
      if (fallbackContextTokens > resolvedContext.totalTokens) {
        resolvedContext.totalTokens = fallbackContextTokens
      }
      if (!resolvedContext.maxTokens && fallbackContextWindow) {
        resolvedContext.maxTokens = fallbackContextWindow
      }
      resolvedContext.percentage = resolvedContext.maxTokens
        ? (resolvedContext.totalTokens / resolvedContext.maxTokens) * 100
        : resolvedContext.percentage
    }
    context = resolvedContext
    if (context?.maxTokens) args.onModelContextWindow?.(context.maxTokens)
    const planAcknowledgementMissing = state.planSubmitted && !state.planResultAcknowledged
    const terminalToolLabel = args.reviewerRuntime ? 'review decision' : 'staged plan'
    if (planAcknowledgementMissing && state.planToolCallId) {
      apply(
        {
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: state.planToolCallId,
          state: {
            status: 'error',
            error: `Claude did not acknowledge the ${terminalToolLabel} tool result.`,
          },
        },
        true
      )
    }
    const servedModelMismatch = claudeServedModelMismatch(runtimeModelId, result, mapperState.lastAssistantModelId)
    if (servedModelMismatch) {
      chatDiag({
        kind: 'claude-served-model-mismatch',
        requested: servedModelMismatch.requested,
        served: servedModelMismatch.served,
        conv: args.conversationId,
      })
    }
    fatal =
      fatal ??
      (planAcknowledgementMissing
        ? `Claude did not acknowledge the ${terminalToolLabel} tool result; the provider session was discarded.`
        : intentionalPlanInterruptAccepted
          ? null
          : (resultError(result, runtimeModelId) ?? servedModelMismatch?.message ?? null))
    const finalAttemptUsage = result ? normalizeClaudeUsage(result.usage) : fallbackMainUsage
    const normalizedUsage = aggregateClaudeUsage([
      ...completedAttemptUsage,
      ...portableCompactorUsage,
      ...(finalAttemptUsage ? [finalAttemptUsage] : []),
    ])
    const chatUsage = usageFromResult(
      result,
      context,
      [...subagentUsage.values()],
      contextIdentity,
      fallbackMainUsage,
      normalizedUsage,
      {
        runtimeCostUsd: portableCompactorRuntimeCostUsd,
        catalogTokens: portableCompactorCatalogUsage,
        runtimeCoveredTokens: portableCompactorRuntimeCoveredUsage,
      }
    )
    if (normalizedUsage) {
      recordModelCallUsage({
        runtime: 'claude-subscription',
        providerId: args.selection.providerId,
        modelId: servedModelMismatch?.served ?? runtimeModelId,
        conversationId: args.conversationId,
        usage: {
          input: normalizedUsage.input,
          output: normalizedUsage.output,
          cacheRead: normalizedUsage.cacheRead,
          cacheCreate: normalizedUsage.cacheCreate,
          totalInput: normalizedUsage.totalInput,
        },
      })
    }
    const authenticationRequired = Boolean(fatal && isClaudeAuthenticationRequired(result ?? fatal))
    if (args.signal.aborted) {
      applyWithUsage(
        {
          kind: 'aborted' as const,
          messageId: assistantId,
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        chatUsage
      )
      terminalCommitted = true
      coalescer.flush()
      return {
        planSubmitted: state.planSubmitted && state.planResultAcknowledged,
        sessionId,
      }
    } else if (fatal && authenticationRequired) {
      applyAuthenticationRequired(fatal, chatUsage)
      args.manager.requireAuthentication(result ?? fatal)
      coalescer.flush()
      return {
        planSubmitted: state.planSubmitted && state.planResultAcknowledged,
        sessionId,
      }
    }
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (fatal) {
      applyWithUsage(
        {
          kind: 'error' as const,
          messageId: assistantId,
          message: fatal,
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        chatUsage
      )
      terminalCommitted = true
      coalescer.flush()
      return {
        planSubmitted: state.planSubmitted && state.planResultAcknowledged,
        sessionId,
      }
    } else {
      applyWithUsage(
        {
          kind: 'finish' as const,
          messageId: assistantId,
          finishReason: result?.stop_reason ?? 'stop',
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        chatUsage
      )
      terminalCommitted = true
    }
    if (
      sessionId &&
      sessionAccepted &&
      !args.signal.aborted &&
      !fatal &&
      !args.ephemeralSession &&
      (args.canPersistSession?.() ?? true)
    ) {
      const userUuid = result?.subtype === 'success' ? (result.user_message_uuid ?? null) : null
      if (!inTurnCompactions && resolution.forkSession && existing && sessionId !== existing.sessionId) {
        reassignClaudeMessageMappings(args.conversationId, existing.sessionId, sessionId)
      }
      putClaudeMessageMapping({
        conversationId: args.conversationId,
        maestrlyMessageId: currentUser.id,
        sessionId,
        sdkUserUuid: userUuid,
        sdkAssistantUuid: null,
      })
      putClaudeMessageMapping({
        conversationId: args.conversationId,
        maestrlyMessageId: assistantId,
        sessionId,
        sdkUserUuid: userUuid,
        sdkAssistantUuid: mapperState.lastAssistantUuid,
      })
      putClaudeSessionBinding(
        buildClaudeSessionBinding({
          conversationId: args.conversationId,
          sessionId,
          modelId: runtimeModelId,
          reasoningEffort: args.reasoningEffort,
          fastMode: args.fastMode,
          cwd: args.cwd,
          promptHash: runtime.promptHash,
          toolSignature: runtime.bridge.toolSignature,
          lastMessageId: assistantId,
          lastAssistantUuid: mapperState.lastAssistantUuid,
          accountIdentity: args.accountIdentity,
          accountId: args.manager.accountId,
          usage: usageSnapshot(
            result,
            fallbackMainUsage,
            completedAttemptUsage.length + mapperState.assistantUsageByMessageId.size,
            normalizedUsage
          ),
          context,
        })
      )
      clearClaudeSessionCleanup(sessionId)
      sessionPersisted = true
    }
    if (dirty) persist()
    coalescer.flush()
    return {
      planSubmitted: state.planSubmitted && state.planResultAcknowledged,
      sessionId,
    }
  } catch (error) {
    if (terminalCommitted) {
      coalescer.flush()
      return {
        planSubmitted: state.planSubmitted && state.planResultAcknowledged,
        sessionId,
      }
    }
    for (const [toolCallId, sub] of state.subagentRuns) {
      const existingState = currentToolState(toolCallId)
      if (existingState?.status === 'completed' || existingState?.status === 'error') continue
      apply({
        kind: 'tool-state',
        messageId: assistantId,
        toolCallId,
        state: {
          status: 'error',
          error: args.signal.aborted ? 'Aborted' : 'Subagent execution ended before Claude acknowledged its result.',
          sub,
        },
      })
    }
    const fallbackMainUsage = currentAttemptUsageArchived
      ? undefined
      : aggregateClaudeUsage(streamMapper?.state().assistantUsageByMessageId.values() ?? [])
    const catchFinalAttemptUsage = result ? normalizeClaudeUsage(result.usage) : fallbackMainUsage
    const catchNormalizedUsage = aggregateClaudeUsage([
      ...completedAttemptUsage,
      ...portableCompactorUsage,
      ...(catchFinalAttemptUsage ? [catchFinalAttemptUsage] : []),
    ])
    const catchContextIdentity = createHash('sha256')
      .update(
        `${args.selection.providerId}\0${runtimeModelId}\0${args.accountIdentity.fingerprint}\0${runtime?.promptHash ?? 'unavailable'}`
      )
      .digest('hex')
    const catchUsage = usageFromResult(
      result,
      context,
      [...subagentUsage.values()],
      catchContextIdentity,
      fallbackMainUsage,
      catchNormalizedUsage,
      {
        runtimeCostUsd: portableCompactorRuntimeCostUsd,
        catalogTokens: portableCompactorCatalogUsage,
        runtimeCoveredTokens: portableCompactorRuntimeCoveredUsage,
      }
    )
    if (state.planSubmitted && !state.planResultAcknowledged && state.planToolCallId) {
      const terminalToolLabel = args.reviewerRuntime ? 'review decision' : 'staged plan'
      apply(
        {
          kind: 'tool-state',
          messageId: assistantId,
          toolCallId: state.planToolCallId,
          state: {
            status: 'error',
            error: `Claude did not acknowledge the ${terminalToolLabel} tool result.`,
          },
        },
        true
      )
    }
    const caughtFailure = fatal ?? error
    const authenticationRequired = isClaudeAuthenticationRequired(caughtFailure)
    if (args.signal.aborted) {
      applyWithUsage(
        {
          kind: 'aborted' as const,
          messageId: assistantId,
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        catchUsage
      )
    } else if (authenticationRequired) {
      const diagnostic = claudeSubscriptionErrorMessage(caughtFailure)
      applyAuthenticationRequired(diagnostic, catchUsage)
      args.manager.requireAuthentication(caughtFailure)
    } else {
      applyWithUsage(
        {
          kind: 'error' as const,
          messageId: assistantId,
          message: fatal ?? claudeRuntimeErrorMessage(error, runtimeModelId),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        catchUsage
      )
    }
    coalescer.flush()
    return {
      planSubmitted: state.planSubmitted && state.planResultAcknowledged,
      sessionId,
    }
  } finally {
    state.subagentRuns.clear()
    if (state.planAcknowledgementTimer) clearTimeout(state.planAcknowledgementTimer)
    if (abortCloseTimer) clearTimeout(abortCloseTimer)
    if (planInterruptCloseTimer) clearTimeout(planInterruptCloseTimer)
    args.signal.removeEventListener('abort', onAbort)
    closeQuery()
    if (sessionId && !sessionPersisted && !retiredSessionIds.has(sessionId)) await retireManagedSession(sessionId)
    await runtime?.close().catch(() => undefined)
    if (dirty) persist()
    coalescer.flush()
    coalescer.dispose()
  }
}

export interface CompactClaudeSessionArgs
  extends Omit<RunClaudeChatArgs, 'emit' | 'responseStartedAt' | 'onSessionReady' | 'canPersistSession'> {
  customInstructions?: string
}

export interface CompactClaudeSessionResult {
  sessionId: string
  success: boolean
  tokensRemoved: number
  summary: string | null
  context?: ClaudeContextSnapshot
  usage?: NormalizedClaudeUsage & { runtimeEstimatedCostUsd?: number }
  incompatible?: boolean
}

/** Requests the runtime's native /compact command for the exact persisted session. */
export async function compactClaudeSession(args: CompactClaudeSessionArgs): Promise<CompactClaudeSessionResult> {
  args.signal.throwIfAborted()
  args.manager.assertAccountIdentity(args.accountIdentity)
  // `/compact` intentionally uses the command-string channel. Prove the
  // initialized backend first through a no-turn capability query.
  await args.manager.listModels(args.signal)
  args.manager.assertAccountIdentity(args.accountIdentity)
  args.signal.throwIfAborted()
  const binding = getClaudeSessionBinding(args.conversationId)
  if (!binding) throw new Error('This conversation has no Claude session to compact.')
  const state: RunnerState = {
    planSubmitted: false,
    planToolCallId: null,
    planResultAcknowledged: false,
    planAcknowledgementTimer: null,
    subagentRuns: new Map(),
    query: null,
    runTask: null,
    queryAbortController: null,
    coordinator: new SubagentCoordinator({ onEvent: () => {} }),
  }
  const runtime = await prepareRuntime(args, `claude_compact_${randomUUID()}`, state)
  if (args.signal.aborted) {
    await runtime.close().catch(() => undefined)
    args.signal.throwIfAborted()
  }
  if (
    !isClaudeSessionBindingCompatible(binding, {
      modelId: args.resolvedModelId ?? args.selection.modelId,
      reasoningEffort: args.reasoningEffort,
      fastMode: args.fastMode,
      cwd: args.cwd,
      promptHash: runtime.promptHash,
      toolSignature: runtime.bridge.toolSignature,
      accountIdentity: args.accountIdentity,
      accountId: args.manager.accountId,
    })
  ) {
    await runtime.close()
    return {
      sessionId: binding.sessionId,
      success: false,
      tokensRemoved: 0,
      summary: null,
      incompatible: true,
    }
  }
  const before = binding.context?.totalTokens ?? 0
  const command = args.customInstructions?.trim() ? `/compact ${args.customInstructions.trim()}` : '/compact'
  const abortController = new AbortController()
  let query: ReturnType<ClaudeSubscriptionManager['createQuery']> | null = null
  let boundary: SDKCompactBoundaryMessage | null = null
  let result: SDKResultMessage | null = null
  let context: ClaudeContextSnapshot | undefined
  const onAbort = () => {
    abortController.abort(args.signal.reason ?? new Error('Claude compaction aborted.'))
    query?.close()
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  try {
    query = args.manager.createQuery({
      prompt: command,
      options: buildClaudeCompactionQueryOptions({
        abortController,
        cwd: args.cwd,
        modelId: args.resolvedModelId ?? args.selection.modelId,
        sessionId: binding.sessionId,
        disallowedNativeTools: CLAUDE_DISALLOWED_NATIVE_TOOLS,
      }),
    })
    for await (const message of query) {
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        boundary = message
        const measured = await settleWithin(query.getContextUsage(), 1_500, args.signal)
        if (measured) {
          context = {
            totalTokens: safeTokens(measured.totalTokens),
            maxTokens: safeTokens(measured.maxTokens),
            percentage: Math.max(0, Number(measured.percentage) || 0),
            model: measured.model,
          }
        }
      } else if (message.type === 'result') result = message
    }
    args.signal.throwIfAborted()
    args.manager.assertAccountIdentity(args.accountIdentity)
    const normalizedUsage = result ? normalizeClaudeUsage(result.usage) : undefined
    const servedModelMismatch = claudeServedModelMismatch(
      args.resolvedModelId ?? args.selection.modelId,
      result,
      context?.model
    )
    if (servedModelMismatch) {
      chatDiag({
        kind: 'claude-compact-served-model-mismatch',
        requested: servedModelMismatch.requested,
        served: servedModelMismatch.served,
        conv: args.conversationId,
      })
    }
    if (!context) {
      const maxTokens = resultModelContextWindow(result, args.resolvedModelId ?? args.selection.modelId)
      const totalTokens = normalizedUsage ? normalizedUsage.totalInput + normalizedUsage.output : 0
      if (totalTokens || maxTokens) {
        context = {
          totalTokens,
          maxTokens,
          percentage: maxTokens && totalTokens ? (totalTokens / maxTokens) * 100 : 0,
          model: args.resolvedModelId ?? args.selection.modelId,
        }
      }
    }
    if (normalizedUsage) {
      recordModelCallUsage({
        runtime: 'claude-subscription',
        providerId: args.selection.providerId,
        modelId: servedModelMismatch?.served ?? args.resolvedModelId ?? args.selection.modelId,
        conversationId: args.conversationId,
        usage: normalizedUsage,
      })
    }
    return {
      sessionId: binding.sessionId,
      success: Boolean(boundary) && !servedModelMismatch,
      tokensRemoved: Math.max(0, before - (context?.totalTokens ?? before)),
      summary: boundary
        ? `Claude compacted ${boundary.compact_metadata.pre_tokens} tokens of provider-native context.`
        : null,
      ...(context ? { context } : {}),
      ...(normalizedUsage
        ? {
            usage: {
              ...normalizedUsage,
              ...(Number.isFinite(Number(result?.total_cost_usd)) && Number(result?.total_cost_usd) >= 0
                ? { runtimeEstimatedCostUsd: Number(result?.total_cost_usd) }
                : {}),
            },
          }
        : {}),
    }
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    query?.close()
    await runtime.close().catch(() => undefined)
  }
}
