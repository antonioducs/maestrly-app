import { withCursorAccountRun } from './account-runs'
import type { PermissionScope } from '../../../shared/conversation-scope'
import { capabilityBehaviorFor } from '../../../shared/chat-mode'
import { randomUUID } from 'node:crypto'
import type { AgentOptions, ModelSelection } from '@cursor/sdk'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type {
  ChatMessage,
  ChatModelRef,
  ChatStreamEvent,
  ChatUsage,
  SubagentRunMeta,
  ToolState,
} from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import type { MaestroLiveRunPort } from '../maestro-live'
import { applyChatEvent } from '../../../shared/chat'
import { responseDurationMs } from '../../../shared/response-duration'
import { getAppFlag, getConvUiPrefs } from '../../store'
import { stagePlan } from '../../plan-broker'
import { buildAppTools, buildMcpTools } from '../mcp'
import { deleteChatMessage, runnerContextHistory, upsertChatMessage } from '../chat-store'
import { createDeltaCoalescer } from '../delta-coalescer'
import { droppedImageText, nativeSeedContextText } from '../message'
import { describeEphemeralToolImage } from '../image-interpreter'
import { resolveFileImageBytesSync } from '../attachment-artifacts'
import { adaptToolSetForModel } from '../tool-capabilities'
import type { PermissionBroker } from '../permission'
import type { QuestionBroker } from '../question-broker'
import { renderSkillContext } from '../skills'
import { findEffectiveSkill } from '../skill-state'
import { builtinToolNamesForMode, buildTools, REVIEWER_READONLY_TOOL_NAMES } from '../tools'
import type { GeneratedImageEmission, GeneratedImageUsage, ReviewerToolRuntime, ToolContext } from '../tools/util'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  GENERATE_IMAGE_TOOL_NAME,
  mergeGeneratedImageUsage,
} from '../image-gen'
import { chatDiag } from '../diag-log'
import { createExplicitSubagentTurnState } from '../subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from '../subagent-turn-request'
import { SubagentCoordinator } from '../subagent-coordinator'
import type { ChatSubagentUsage } from '../../../shared/chat'
import { createCursorTaskRuntime, type CursorManagedTaskRunner } from './task-runtime'
import { MAESTRO_DELEGATE_TOOL_DESCRIPTION, MAESTRO_DELEGATE_TOOL_SCHEMA } from '../maestro-delegation'
import { buildSubagentSupervisionTools } from '../maestro-supervision-tools'
import {
  createCursorStreamMapper,
  resolveCursorTerminalEvidence,
  type CursorRunTerminalStatus,
} from '../cursor-sdk/stream-map'
import { estimateCursorPublishedCostUsd } from '../cursor-sdk/models'
import { classifyCursorSdkError, cursorSdkErrorMessage, redactCursorCredentials } from '../cursor-sdk/errors'
import { buildCursorToolBridge, normalizeCursorToolEvent } from './tool-bridge'
import {
  awaitCursorOperation,
  closeCursorLease,
  cancelLateCursorRun,
  runCursorRunWithWatchdog,
  type CursorRunStallPhase,
} from './watchdog'
import {
  CURSOR_HARNESS_PROFILE,
  clearCursorAgentCleanup,
  getCursorAgentBinding,
  markCursorAgentCleanupFailed,
  putCursorAgentBinding,
  queueCursorAgentCleanup,
  retireCursorAgentBinding,
} from './session-store'
import {
  buildCursorHarnessContext,
  buildCursorSeedTranscript,
  hashCursorHarnessEnvelope,
  isCursorAgentBindingCompatible,
} from './session'
import { cursorModelSelectionsEqual } from './manager'
import type {
  CursorAgentLease,
  CursorSubscriptionModelSelection,
  CursorModelSelectionSnapshot,
  CursorSubscriptionAccountIdentity,
  CursorSubscriptionManager,
} from './manager'

export interface RunCursorSubscriptionChatArgs {
  conversationId: string
  /** Null for standalone chats, which have no workspace; permissionScope then carries the isolation. */
  projectId: string | null
  permissionScope?: PermissionScope
  cwd: string
  selection: ChatModelRef
  mode: ChatBehavior
  permMode?: import('../../../shared/chat').ChatPermMode
  harness?: import('../harness/types').ResolvedHarness
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort

  fastMode?: boolean

  reasoningEffort?: string
  maestrlyUltra?: boolean

  dropImages?: boolean
  manager: CursorSubscriptionManager
  accountIdentity: CursorSubscriptionAccountIdentity
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
  responseStartedAt?: number
  canPersistSession?: () => boolean
  onModelContextWindow?: (contextWindow: number) => void
  contextWindow?: number

  runTask?: (
    input: { agent: string; prompt: string },
    toolCallId: string,
    signal: AbortSignal
  ) => Promise<{ output: string; error?: string }>

  watchdog?: { timeoutMs?: number; graceMs?: number; deadlineMs?: number }

  ephemeralSession?: boolean

  frozenModelSelection?: CursorModelSelectionSnapshot
  messageMeta?: {
    source?: import('../../../shared/chat').ChatMessageSource
    internal?: boolean
    executionScope?: import('../../../shared/chat').ChatExecutionScope
    reviewLoop?: import('../../../shared/chat').ChatReviewLoopMeta
  }
  executionScope?: import('../../../shared/chat').ChatExecutionScope

  reviewerRuntime?: ReviewerToolRuntime
}

export interface RunCursorSubscriptionChatResult {
  planSubmitted: boolean
  agentId: string

  diagnostics: {
    runId: string | null
    requestId: string | null
    stalled: CursorRunStallPhase | null
    timeoutKind: 'inactivity' | 'deadline' | null
    cancelInvoked: boolean
  }
}

interface RunnerState {
  planSubmitted: boolean
  runTask: CursorManagedTaskRunner | NonNullable<RunCursorSubscriptionChatArgs['runTask']> | null
  coordinator: SubagentCoordinator

  subagentRuns: Map<string, SubagentRunMeta>
  taskTerminalStates: Map<string, ToolState>
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
}

function dataUrlBlob(data: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

export function currentUserInput(
  message: ChatMessage,
  seedTranscript: string,
  dropImages: boolean,
  transientContext?: string
): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const textParts: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []
  if (seedTranscript) textParts.push(nativeSeedContextText(seedTranscript))
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) textParts.push(part.text)
    if (part.type === 'context' && part.text) textParts.push(part.text)
    if (part.type === 'skill-invocation' && part.body) textParts.push(part.body)
    if (part.type !== 'file') continue
    if (part.kind === 'image') {
      if (dropImages) {
        textParts.push(droppedImageText(part))
        continue
      }
      const resolved = resolveFileImageBytesSync(message.conversationId, part)
      const blob = resolved
        ? { data: Buffer.from(resolved.bytes).toString('base64'), mimeType: resolved.mediaType }
        : dataUrlBlob(part.data ?? '')
      if (blob) images.push({ data: blob.data, mimeType: blob.mimeType })
      else if (dropImages) textParts.push(droppedImageText(part))
      else textParts.push(`[Image attachment ${part.name} could not be decoded by the host.]`)
      continue
    }
    const label = part.hidden ? `Content referenced by ${part.name}` : `Attached file ${part.name}`
    textParts.push(`${label}:\n\n${part.data}`)
  }
  if (transientContext) textParts.push(transientContext)
  return { text: textParts.join('\n\n').trim() || '(continue)', images }
}

function cursorSdkMode(sdkMode: ChatBehavior): 'agent' | 'plan' {
  return capabilityBehaviorFor(sdkMode) === 'agent' ? 'agent' : 'plan'
}

async function cleanupOrphanCursorAgent(
  manager: CursorSubscriptionManager,
  input: { conversationId: string; agentId: string; cwd: string; accountId: string | null }
): Promise<void> {
  try {
    await manager.deleteAgent(input.agentId)
    clearCursorAgentCleanup(input.agentId)
  } catch (error) {
    queueCursorAgentCleanup(input.conversationId, input.agentId, input.cwd, input.accountId)

    markCursorAgentCleanupFailed(input.agentId, error)
  }
}

function withSubagentUsage(
  main: ChatUsage | null,
  subagents: ReadonlyMap<string, ChatSubagentUsage>
): ChatUsage | null {
  if (!subagents.size) return main
  const perModel = new Map<string, ChatSubagentUsage>()
  let subInput = 0
  let subOutput = 0
  let subCachedInput = 0
  let subCacheCreate = 0
  for (const usage of subagents.values()) {
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
    } else {
      perModel.set(key, { ...usage })
    }
  }
  return {
    ...(main ?? { usageVersion: 2, input: 0, output: 0, billingOnly: true }),
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

function enrichCursorMainUsage(
  usage: ChatUsage | null,
  args: Pick<RunCursorSubscriptionChatArgs, 'selection' | 'fastMode' | 'contextWindow'>
): ChatUsage | null {
  if (!usage) return null
  const runtimeEstimatedCostUsd = estimateCursorPublishedCostUsd(args.selection.modelId, args.fastMode, usage)
  const contextWindow = Math.floor(Number(args.contextWindow) || 0)
  return {
    ...usage,
    ...(contextWindow > 0 ? { modelContextWindow: contextWindow } : {}),
    ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
  }
}

async function runCursorSubscriptionChatInScope(
  args: RunCursorSubscriptionChatArgs
): Promise<RunCursorSubscriptionChatResult> {
  const dropImages = args.dropImages === true
  const accountFingerprint = args.accountIdentity.fingerprint
  if (!accountFingerprint) throw new Error('Cursor is not authenticated')
  const responseStartedAt = args.responseStartedAt ?? Date.now()
  const history = runnerContextHistory(args.conversationId, {
    ephemeralSession: args.ephemeralSession,
    executionScope: args.messageMeta?.executionScope,
  })
  const currentUser = history.at(-1)
  if (currentUser?.role !== 'user') throw new Error('Current user message was not persisted')

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
  let lastPersistAt = 0
  const persist = (): void => {
    lastPersistAt = Date.now()
    upsertChatMessage(messages[0])
  }
  const coalescer = createDeltaCoalescer(args.emit)
  const apply = (event: ChatStreamEvent, force = false): void => {
    messages = applyChatEvent(messages, event)
    coalescer.push(event)
    if (force || Date.now() - lastPersistAt > 300) persist()
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

  const subagentUsage = new Map<string, ChatSubagentUsage>()
  const state: RunnerState = {
    planSubmitted: false,
    runTask: args.runTask ?? null,
    coordinator: new SubagentCoordinator({
      onEvent: (event) =>
        chatDiag({ kind: 'subagent-coordinator', runtime: 'cursor-subscription', conv: args.conversationId, ...event }),
    }),
    subagentRuns: new Map(),
    taskTerminalStates: new Map(),
    emitGeneratedImage: (toolCallId, image) => emitGeneratedImagePart(apply, assistantId, toolCallId, image),
    onGeneratedImageUsage: (usage) => mergeGeneratedImageUsage(subagentUsage, usage),
  }

  const canPersistBinding = args.canPersistSession ?? (() => true)
  const ephemeral = Boolean(args.ephemeralSession)

  const toolAbort = new AbortController()
  const toolSignal = AbortSignal.any([args.signal, toolAbort.signal])
  let agentId = ''
  let agentHandle: CursorAgentLease | null = null
  let bindingPersisted = false
  let orphanHandled = false

  const turnState: { createdNewAgent: boolean } = { createdNewAgent: false }
  let usage: ChatUsage | null = null

  const diagnostics: {
    runId: string | null
    requestId: string | null
    stalled: CursorRunStallPhase | null
    timeoutKind: 'inactivity' | 'deadline' | null
    cancelInvoked: boolean
  } = { runId: null, requestId: null, stalled: null, timeoutKind: null, cancelInvoked: false }

  const handleOrphanAgent = async (): Promise<void> => {
    if (!agentId || orphanHandled) return
    if (!ephemeral && (!turnState.createdNewAgent || bindingPersisted)) return
    orphanHandled = true
    await cleanupOrphanCursorAgent(args.manager, {
      conversationId: args.conversationId,
      agentId,
      cwd: args.cwd,
      accountId: args.manager.accountId ?? null,
    })
  }

  try {
    args.signal.throwIfAborted()
    args.manager.assertAccountIdentity(args.accountIdentity)
    let liveResolvedModel: CursorSubscriptionModelSelection
    try {
      liveResolvedModel = await args.manager.resolveModelSelection(
        args.selection.modelId,
        args.fastMode,
        Boolean(args.frozenModelSelection),
        args.reasoningEffort
      )
    } catch (error) {
      if (args.frozenModelSelection) throw new Error('executor-unavailable', { cause: error })
      throw error
    }
    if (args.frozenModelSelection && !cursorModelSelectionsEqual(liveResolvedModel, args.frozenModelSelection)) {
      throw new Error('executor-unavailable')
    }
    const resolvedModel = args.frozenModelSelection
      ? { ...liveResolvedModel, modelId: args.frozenModelSelection.modelId, params: args.frozenModelSelection.params }
      : liveResolvedModel

    const makeContext = (toolCallId: string, toolSignal: AbortSignal): ToolContext => ({
      conversationId: args.conversationId,
      projectId: args.projectId,
      permissionScope: args.permissionScope,
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
          permissionScope: args.permissionScope,
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
        state.planSubmitted = result.ok
        return result.ok
      },
      ...(args.reviewerRuntime
        ? {
            reviewer: {
              recordEvidence: (kind) => args.reviewerRuntime!.recordEvidence(kind),
              searchExecutionContext: (input) => args.reviewerRuntime!.searchExecutionContext(input),
              readExecutionContext: (input) => args.reviewerRuntime!.readExecutionContext(input),
              submitReview: (decision) => {
                const result = args.reviewerRuntime!.submitReview(decision)
                if (result.ok) state.planSubmitted = true
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
        permissionScope: args.permissionScope,
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
      const { skills, agents, envelope } = args.reviewerRuntime
        ? {
            skills: [],
            agents: [],
            envelope: {
              mode: args.mode,
              modelId: resolvedModel.modelId,
              cwd: args.cwd,
              projectContext: '',
              skillCatalog: '',
              agentCatalog: '',
              environment: `Project directory: ${args.cwd}.`,
              ultra: false,
              instructions:
                'This is an isolated internal review turn. Use only the supplied reviewer read-only tools and finish by calling submit_review exactly once.',
            },
          }
        : await buildCursorHarnessContext({
            projectId: args.projectId,
            cwd: args.cwd,
            conversationId: args.conversationId,
            mode: args.mode,
            maestro: args.maestro,
            modelId: resolvedModel.modelId,
            maestrlyUltra: args.maestrlyUltra,
            harness: args.harness,
            appToolsEnabled,
          })
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
                return skill?.modelInvocable
                  ? renderSkillContext(skill)
                  : `Skill "${name}" not found. Available: ${skills.map((item) => item.name).join(', ') || '(none)'}`
              },
            }),
          }
        : {}

      const delegationToolName = args.mode === 'maestro' ? 'delegate' : 'task'
      const taskTools: ToolSet = agents.length
        ? {
            [delegationToolName]: tool({
              description:
                args.mode === 'maestro'
                  ? MAESTRO_DELEGATE_TOOL_DESCRIPTION
                  : 'Delegate a self-contained slice of work to an isolated Maestrly subagent. ' +
                    'Give the full context; the subagent does not see this conversation.',
              inputSchema: jsonSchema(
                args.mode === 'maestro'
                  ? MAESTRO_DELEGATE_TOOL_SCHEMA
                  : {
                      type: 'object',
                      properties: {
                        agent: { type: 'string', enum: agents.map((agent) => agent.name) },
                        prompt: { type: 'string', description: 'Self-contained subtask and all required context.' },
                      },
                      required: ['agent', 'prompt'],
                      additionalProperties: false,
                    }
              ),
              execute: async (input, options) => {
                if (!state.runTask) throw new Error('The Maestrly subagent executor is not ready')
                const toolCallId = options.toolCallId

                apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId, toolName: delegationToolName })
                apply({ kind: 'tool-call', messageId: assistantId, toolCallId, toolName: delegationToolName, input })
                let result: Awaited<ReturnType<CursorManagedTaskRunner>>
                try {
                  result = await state.runTask(input, toolCallId, options.abortSignal ?? args.signal, (update) => {
                    if (update.sub) state.subagentRuns.set(toolCallId, update.sub)
                  })
                } catch (error) {
                  const terminal: ToolState = {
                    status: 'error',
                    error: redactCursorCredentials(error instanceof Error ? error.message : String(error)),
                    ...(state.subagentRuns.get(toolCallId) ? { sub: state.subagentRuns.get(toolCallId) } : {}),
                  }
                  state.taskTerminalStates.set(toolCallId, terminal)
                  apply({ kind: 'tool-state', messageId: assistantId, toolCallId, state: terminal })
                  throw error
                }
                const sub = result.sub ?? state.subagentRuns.get(toolCallId)
                if (sub) state.subagentRuns.set(toolCallId, sub)
                const resultError = result.error ? redactCursorCredentials(result.error) : undefined
                const terminal: ToolState = resultError
                  ? { status: 'error', error: resultError, ...(sub ? { sub } : {}) }
                  : { status: 'completed', output: result.output, ...(sub ? { sub } : {}) }
                state.taskTerminalStates.set(toolCallId, terminal)
                apply({ kind: 'tool-state', messageId: assistantId, toolCallId, state: terminal })
                if (resultError) throw new Error(resultError)
                return result.output
              },
            }),
          }
        : {}

      const supervisionTools = agents.length
        ? buildSubagentSupervisionTools({
            conversationId: args.conversationId,
            parentMessageId: assistantId,
            maestro: args.mode === 'maestro',
            signal: args.signal,
          })
        : {}
      const rawTools: ToolSet = {
        ...core,
        ...mcp.tools,
        ...app.tools,
        ...skillTools,
        ...taskTools,
        ...supervisionTools,
      }
      const tools: ToolSet = adaptToolSetForModel({
        tools: rawTools,
        supportsImages: !dropImages,
        describeImage: (image) =>
          describeEphemeralToolImage({
            image,
            conversationId: args.conversationId,
            cwd: args.cwd,
            signal: args.signal,
          }),
      })

      if (!args.runTask && agents.length) {
        const selectableAgentNames = agents.map((agent) => agent.name)
        const explicitSubagentTurnState = createExplicitSubagentTurnState(
          detectExplicitSubagentsForTurn(history, selectableAgentNames),
          selectableAgentNames
        )
        state.runTask = createCursorTaskRuntime({
          conversationId: args.conversationId,
          projectId: args.projectId,
          permissionScope: args.permissionScope,
          cwd: args.cwd,
          mode: args.mode,
          maestro: args.maestro,
          maestroLive: args.maestroLive,
          turnState: explicitSubagentTurnState,
          permMode: args.permMode ?? 'ask',
          selection: args.selection,
          fastMode: args.fastMode === true,
          reasoningEffort: args.reasoningEffort,
          manager: args.manager,
          accountIdentity: args.accountIdentity,
          broker: args.broker,
          questionBroker: args.questionBroker,
          assistantId,
          agents,
          tools: rawTools,
          coordinator: state.coordinator,
          subagentUsage,
          apply,
          emitGeneratedImage: state.emitGeneratedImage,
          onGeneratedImageUsage: state.onGeneratedImageUsage,
        })
      }
      const bridge = await buildCursorToolBridge({ tools, signal: toolSignal })

      const instructionHash = hashCursorHarnessEnvelope(envelope)
      const harnessProfile = CURSOR_HARNESS_PROFILE
      const toolSignature = bridge.toolSignature

      const previousMessage = history.at(-2) ?? null
      const existing = getCursorAgentBinding(args.conversationId)
      const compatible =
        !args.ephemeralSession &&
        isCursorAgentBindingCompatible({
          binding: existing,
          previousMessageId: previousMessage?.id ?? null,
          modelId: resolvedModel.modelId,
          modelParams: resolvedModel.params,
          cwd: args.cwd,
          harnessProfile,
          instructionHash,
          toolSignature,
          accountFingerprint,
          accountId: args.manager.accountId ?? null,
        })
      if (existing && !compatible && !args.ephemeralSession) {
        retireCursorAgentBinding(args.conversationId, existing.agentId)
        try {
          await args.manager.deleteAgent(existing.agentId)

          clearCursorAgentCleanup(existing.agentId)
        } catch {
          // The retirement tombstone governs future cleanup.
        }
      }

      const selection: ModelSelection = {
        id: resolvedModel.modelId,
        ...(resolvedModel.params.length
          ? { params: resolvedModel.params.map((param) => ({ id: param.id, value: param.value })) }
          : {}),
      }
      const agentOptions: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'> = {
        model: selection,
        mode: args.reviewerRuntime ? 'plan' : cursorSdkMode(args.mode),
        local: {
          cwd: args.cwd,
          customTools: bridge.customTools,
        },
        name: `maestrly:${args.conversationId.slice(0, 8)}`,
      }

      const seedTranscript = compatible ? '' : buildCursorSeedTranscript(history)
      turnState.createdNewAgent = !(compatible && existing)
      const lease = await awaitCursorOperation(
        compatible && existing
          ? args.manager.resumeAgent(existing.agentId, agentOptions)
          : args.manager.createAgent(agentOptions),
        {
          signal: args.signal,
          timeoutMs: args.watchdog?.timeoutMs,
          onLateSettled: async (late) => {
            if (!late) return
            await closeCursorLease(late)
            if (!compatible)
              await cleanupOrphanCursorAgent(args.manager, {
                conversationId: args.conversationId,
                agentId: late.agent.agentId,
                cwd: args.cwd,
                accountId: args.manager.accountId ?? null,
              })
          },
        }
      )

      agentHandle = lease
      const agent = lease.agent
      agentId = agent.agentId
      args.manager.assertAccountIdentity(args.accountIdentity)
      args.signal.throwIfAborted()
      bindingPersisted = false

      if (ephemeral) {
        queueCursorAgentCleanup(args.conversationId, agentId, args.cwd, args.manager.accountId ?? null)
      }

      const envelopeText = `# Maestrly harness\n${envelope.instructions}\n\n# Project\n${envelope.projectContext}\n\n${envelope.skillCatalog}\n${envelope.agentCatalog}\n\n${envelope.environment}`
      const input = currentUserInput(currentUser, seedTranscript, dropImages)
      const sendText = compatible ? input.text : `${envelopeText}\n\n${input.text}`

      const run = await awaitCursorOperation(
        agent.send(
          {
            text: sendText,
            ...(input.images.length ? { images: input.images } : {}),
          },
          { model: selection, mode: args.reviewerRuntime ? 'plan' : cursorSdkMode(args.mode) }
        ),
        {
          signal: args.signal,
          timeoutMs: args.watchdog?.timeoutMs,
          isHostPending: () =>
            Boolean(
              args.broker.pendingFor?.(args.conversationId).length ||
                args.questionBroker.pendingFor?.(args.conversationId).length
            ),
          onAbandon: () => {
            agentHandle = null
            agentId = ''
          },
          onLateSettled: async (lateRun) => {
            await cancelLateCursorRun(lateRun, args.watchdog?.graceMs)
            await closeCursorLease(lease)
            if (!compatible)
              await cleanupOrphanCursorAgent(args.manager, {
                conversationId: args.conversationId,
                agentId: agent.agentId,
                cwd: args.cwd,
                accountId: args.manager.accountId ?? null,
              })
          },
        }
      )

      const mapper = createCursorStreamMapper(assistantId, bridge.takeToolOutput)
      const outcome = await runCursorRunWithWatchdog({
        stream: run.supports('stream') ? () => run.stream() : undefined,
        wait: run.supports('wait') ? () => run.wait() : undefined,
        cancel: () => run.cancel(),
        onMessage: (sdkMessage) => {
          for (const event of mapper.push(sdkMessage)) {
            const normalized = normalizeCursorToolEvent(event, bridge.nameFromSdk, state.taskTerminalStates)
            apply(normalized, normalized.kind === 'tool-call' && normalized.toolName === 'ask_question')
          }
        },
        signal: args.signal,
        isHostPending: () =>
          Boolean(
            args.broker.pendingFor?.(args.conversationId).length ||
              args.questionBroker.pendingFor?.(args.conversationId).length
          ),
        ...(args.watchdog
          ? { timeoutMs: args.watchdog.timeoutMs, graceMs: args.watchdog.graceMs, deadlineMs: args.watchdog.deadlineMs }
          : {}),
      })

      if (outcome.stalled) toolAbort.abort()
      const runResult = outcome.waitResult
      diagnostics.cancelInvoked = outcome.cancelInvoked

      args.manager.assertAccountIdentity(args.accountIdentity)
      const stateAfter = mapper.state()
      diagnostics.runId = stateAfter.runId ?? run.id ?? runResult?.id ?? null
      diagnostics.requestId = stateAfter.requestId ?? run.requestId ?? runResult?.requestId ?? null

      let resolution = resolveCursorTerminalEvidence(stateAfter.finishStatus, runResult?.status)
      const runStalled = outcome.stalled
      diagnostics.stalled = runStalled
      diagnostics.timeoutKind = outcome.timeoutKind
      const stallDetail = runStalled
        ? `Cursor run stalled (${runStalled}: ${outcome.timeoutKind ?? 'inactivity'} budget exceeded)`
        : null
      if (runStalled) {
        resolution = { status: 'ERROR', conflict: false }
      }
      const terminalStatus = resolution.status
      const unknownTerminal = terminalStatus === null

      const userAborted = outcome.aborted || args.signal.aborted

      const terminalSucceeded = terminalStatus === 'FINISHED' && !resolution.conflict
      if (userAborted || runStalled || !stateAfter.finished || stateAfter.openToolCallIds.length > 0) {
        const reconcileStatus: CursorRunTerminalStatus = userAborted ? 'CANCELLED' : (terminalStatus ?? 'ERROR')
        const reconcileDetail =
          stallDetail ??
          (resolution.conflict
            ? 'Cursor run ended with conflicting terminal evidence'
            : unknownTerminal
              ? 'Cursor run ended without a terminal status'
              : runResult?.error?.message)
        for (const event of mapper.reconcileOpenTools(reconcileStatus, reconcileDetail)) {
          apply(event)
        }
      }

      usage = withSubagentUsage(enrichCursorMainUsage(mapper.state().lastUsage, args), subagentUsage)
      const streamFailed =
        stateAfter.finishStatus === 'ERROR' ||
        stateAfter.finishStatus === 'CANCELLED' ||
        stateAfter.finishStatus === 'EXPIRED'

      const terminalEvent: ChatStreamEvent = (() => {
        if (userAborted) {
          return { kind: 'aborted', messageId: assistantId, ...(usage ? { usage } : {}) }
        }
        if (resolution.conflict) {
          if (streamFailed && terminalStatus === 'CANCELLED') {
            return { kind: 'aborted', messageId: assistantId, ...(usage ? { usage } : {}) }
          }
          if (streamFailed) {
            return {
              kind: 'error',
              messageId: assistantId,
              message: redactCursorCredentials(
                stateAfter.finishMessage ?? runResult?.error?.message ?? 'Cursor run error'
              ),
              ...(usage ? { usage } : {}),
            }
          }
          return {
            kind: 'error',
            messageId: assistantId,
            message: 'Cursor run ended with conflicting terminal evidence',
            ...(usage ? { usage } : {}),
          }
        }
        if (terminalStatus === 'CANCELLED') {
          return { kind: 'aborted', messageId: assistantId, ...(usage ? { usage } : {}) }
        }
        if (terminalStatus === 'ERROR' || terminalStatus === 'EXPIRED') {
          return {
            kind: 'error',
            messageId: assistantId,
            message: redactCursorCredentials(
              stallDetail ??
                stateAfter.finishMessage ??
                runResult?.error?.message ??
                `Cursor run ${terminalStatus.toLowerCase()}`
            ),
            ...(usage ? { usage } : {}),
          }
        }
        if (terminalStatus === 'FINISHED') {
          return {
            kind: 'finish',
            messageId: assistantId,
            finishReason: 'stop',
            ...(usage ? { usage } : {}),
            responseDurationMs: responseDurationMs(responseStartedAt, Date.now()),
          }
        }

        return {
          kind: 'error',
          messageId: assistantId,
          message: 'Cursor run ended without a terminal status',
          ...(usage ? { usage } : {}),
        }
      })()

      messages = applyChatEvent(messages, terminalEvent)

      if (outcome.abortGraceExpired) {
        chatDiag({
          kind: 'cursor-run-abort-grace-expired',
          runtime: 'cursor-subscription',
          conv: args.conversationId,
          agentId,
          phase: outcome.abortGraceExpired,
          runId: diagnostics.runId,
          requestId: diagnostics.requestId,
        })
      } else if (runStalled) {
        chatDiag({
          kind: 'cursor-run-stall',
          runtime: 'cursor-subscription',
          conv: args.conversationId,
          agentId,
          stalled: runStalled,
          runId: diagnostics.runId,
          requestId: diagnostics.requestId,
        })
      } else if (resolution.conflict) {
        chatDiag({
          kind: 'cursor-terminal-conflict',
          runtime: 'cursor-subscription',
          conv: args.conversationId,
          agentId,
          streamStatus: stateAfter.finishStatus,
          waitStatus: runResult?.status ?? null,
          runId: diagnostics.runId,
          requestId: diagnostics.requestId,
        })
      }
      if (usage && args.onModelContextWindow && args.contextWindow) {
        args.onModelContextWindow(args.contextWindow)
      }

      const identityOk = (() => {
        try {
          args.manager.assertAccountIdentity(args.accountIdentity)
          return true
        } catch {
          return false
        }
      })()

      const mayPersistMessage = ephemeral || (canPersistBinding() && identityOk && !args.signal.aborted)
      const mayPersistBinding = !ephemeral && mayPersistMessage && terminalSucceeded && canPersistBinding()
      let postRunFailure: unknown = null
      if (mayPersistMessage) {
        try {
          persist()
        } catch (error) {
          postRunFailure = error
        }

        if (!postRunFailure && mayPersistBinding) {
          try {
            putCursorAgentBinding({
              conversationId: args.conversationId,
              agentId,
              modelId: resolvedModel.modelId,
              modelParams: resolvedModel.params,
              cwd: args.cwd,
              harnessProfile,
              instructionHash,
              toolSignature,
              lastMessageId: assistantId,
              accountFingerprint,
              accountId: args.manager.accountId ?? null,
              usageJson: JSON.stringify(usage ?? {}),
            })
            bindingPersisted = true
          } catch (error) {
            postRunFailure = error
          }
        }
      } else {
        try {
          deleteChatMessage(assistantId)
        } catch (error) {
          postRunFailure = error
        }
      }
      if (postRunFailure) {
        const failureEvent: ChatStreamEvent =
          terminalEvent.kind === 'aborted'
            ? { kind: 'aborted', messageId: assistantId, ...(usage ? { usage } : {}) }
            : {
                kind: 'error',
                messageId: assistantId,
                message: cursorSdkErrorMessage(postRunFailure),
                ...(usage ? { usage } : {}),
              }
        messages = applyChatEvent(messages, failureEvent)
        coalescer.push(failureEvent)
        if (mayPersistMessage) {
          try {
            persist()
          } catch {
            // Earlier incremental writes may already have persisted this message.
          }
        }
        chatDiag({
          kind: 'cursor-post-run-failed',
          runtime: 'cursor-subscription',
          conv: args.conversationId,
          agentId,
          code: classifyCursorSdkError(postRunFailure),
          runId: diagnostics.runId,
          requestId: diagnostics.requestId,
        })
      } else {
        coalescer.push(terminalEvent)
      }
      return { planSubmitted: state.planSubmitted, agentId, diagnostics }
    } finally {
      await mcp.close().catch(() => undefined)
      await app.close().catch(() => undefined)
    }
  } catch (error) {
    const code = classifyCursorSdkError(error)
    const message = cursorSdkErrorMessage(error)

    toolAbort.abort()

    const terminalUsage = withSubagentUsage(usage, subagentUsage)
    if (code === 'cursor-cancelled' || args.signal.aborted) {
      apply({ kind: 'aborted', messageId: assistantId, ...(terminalUsage ? { usage: terminalUsage } : {}) })
    } else {
      apply({
        kind: 'error',
        messageId: assistantId,
        message,
        ...(terminalUsage ? { usage: terminalUsage } : {}),
      })
    }
    chatDiag({
      kind: 'cursor-run-error',
      runtime: 'cursor-subscription',
      conv: args.conversationId,
      agentId,
      code,
      runId: diagnostics.runId,
      requestId: diagnostics.requestId,
    })

    const identityOk = (() => {
      try {
        args.manager.assertAccountIdentity(args.accountIdentity)
        return true
      } catch {
        return false
      }
    })()
    if (ephemeral || (canPersistBinding() && identityOk)) {
      persist()
    } else {
      deleteChatMessage(assistantId)
    }
    throw error
  } finally {
    toolAbort.abort()

    coalescer.flush()
    coalescer.dispose()

    if (agentHandle) {
      try {
        await closeCursorLease(agentHandle)
      } catch {
        orphanHandled = true /* Retain ownership if close fails. */
      }
    }
    await handleOrphanAgent()
  }
}

/** Account teardown also reaches helpers and children hosted by another provider. */
export function runCursorSubscriptionChat(
  args: Parameters<typeof runCursorSubscriptionChatInScope>[0]
): ReturnType<typeof runCursorSubscriptionChatInScope> {
  return withCursorAccountRun(args, (signal) => runCursorSubscriptionChatInScope({ ...args, signal }))
}
