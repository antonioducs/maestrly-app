/**
 * One Maestrly chat turn on Google's Antigravity ACP server.
 *
 * Built-in Antigravity tools are disabled; Maestrly's tool set is served to the session over a loopback MCP server
 * that also emits the tool events. Text streams from `session/update`. A session is reused (in memory) or resumed
 * (after a process restart) only while its account, instructions, tool signature, and last assistant message still
 * match; otherwise a new session starts with the conversation transcript as a seed.
 */
import { randomUUID } from 'node:crypto'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { PermissionScope } from '../../../shared/conversation-scope'
import type {
  ChatExecutionScope,
  ChatMessage,
  ChatMessageSource,
  ChatModelRef,
  ChatPermMode,
  ChatReviewLoopMeta,
  ChatStreamEvent,
  ChatSubagentUsage,
  ChatUsage,
  SubagentRunMeta,
  ToolState,
} from '../../../shared/chat'
import { applyChatEvent, toolOutputText } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import { responseDurationMs } from '../../../shared/response-duration'
import { stagePlan } from '../../plan-broker'
import { getAppFlag, getConvUiPrefs } from '../../store'
import { AcpRpcError } from '../acp/client'
import { ACP_RESOURCE_NOT_FOUND_CODE, type AcpPromptResult, type AcpSessionSetupResult } from '../acp/protocol'
import { createBackgroundCompactionPrefixNotifier } from '../background-compaction/runner'
import { runnerContextHistory, upsertChatMessage } from '../chat-store'
import { createDeltaCoalescer } from '../delta-coalescer'
import { chatDiag } from '../diag-log'
import type { ResolvedHarness } from '../harness/types'
import { describeEphemeralToolImage } from '../image-interpreter'
import {
  emitGeneratedImagePart,
  GENERATE_IMAGE_TOOL_NAME,
  generateImageToolEnabled,
  mergeGeneratedImageUsage,
} from '../image-gen'
import { MAESTRO_DELEGATE_TOOL_DESCRIPTION, MAESTRO_DELEGATE_TOOL_SCHEMA } from '../maestro-delegation'
import type { MaestroLiveRunPort } from '../maestro-live'
import { buildSubagentSupervisionTools } from '../maestro-supervision-tools'
import { buildAppTools, buildMcpTools, hasPersonalMemoryTools, PERSONAL_MEMORY_TOOLS } from '../mcp'
import { clipPersistedToolOutput } from '../message'
import type { PermissionBroker } from '../permission'
import type { QuestionBroker } from '../question-broker'
import { findEffectiveSkill } from '../skill-state'
import { renderSkillContext } from '../skills'
import { adaptToolSetForModel } from '../tool-capabilities'
import { buildTools, builtinToolNamesForMode, REVIEWER_READONLY_TOOL_NAMES } from '../tools'
import { enableConversationDispatchTools } from '../tools/conversation-dispatch'
import type { GeneratedImageEmission, ReviewerToolRuntime, ToolContext } from '../tools/util'
import {
  AntigravityModelUnavailableError,
  AntigravityToolsUnavailableError,
  antigravityErrorMessage,
  redactAntigravityCredentials,
} from './errors'
import { type AntigravityHostToolset, registerAntigravityHostToolset } from './host-mcp'
import {
  ANTIGRAVITY_SESSION_META,
  type AntigravityAccountIdentity,
  type AntigravityLiveSession,
  type AntigravitySubscriptionManager,
} from './manager'
import { resolveAntigravityModelValue } from './models'
import {
  buildAntigravityInstructions,
  buildAntigravityPromptBlocks,
  buildAntigravitySeedTranscript,
  hashAntigravityInstructions,
} from './session'
import {
  getAntigravitySessionBinding,
  putAntigravitySessionBinding,
  retireAntigravitySessionBinding,
} from './session-store'
import { createAntigravityStreamMapper } from './stream-map'
import { renderAntigravityToolCatalog } from './tool-catalog'
import { createAntigravityTaskRuntime } from './task-runtime'
import { SubagentCoordinator } from '../subagent-coordinator'
import { createExplicitSubagentTurnState } from '../subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from '../subagent-turn-request'

export interface AntigravityManagedTaskUpdate {
  output?: string
  sub?: SubagentRunMeta
}

export interface AntigravityManagedTaskResult {
  output: string
  error?: string
  sub?: SubagentRunMeta
}

export type AntigravityManagedTaskRunner = (
  input: unknown,
  toolCallId: string,
  signal: AbortSignal,
  update: (state: AntigravityManagedTaskUpdate) => void
) => Promise<AntigravityManagedTaskResult>

export interface RunAntigravitySubscriptionChatArgs {
  conversationId: string
  /** Null for standalone chats, which have no workspace; permissionScope then carries the isolation. */
  projectId: string | null
  permissionScope?: PermissionScope
  cwd: string
  selection: ChatModelRef
  mode: ChatBehavior
  permMode?: ChatPermMode
  harness?: ResolvedHarness
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort
  reasoningEffort?: string
  maestrlyUltra?: boolean
  dropImages?: boolean
  manager: AntigravitySubscriptionManager
  accountIdentity: AntigravityAccountIdentity
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
  responseStartedAt?: number
  canPersistSession?: () => boolean
  onBackgroundCompactionPrefix?: (boundary: { messageId: string; partId: string }) => void
  /** Host-managed subagent executor; built per turn when absent (see task-runtime.ts). */
  runTask?: AntigravityManagedTaskRunner
  ephemeralSession?: boolean
  messageMeta?: {
    source?: ChatMessageSource
    internal?: boolean
    executionScope?: ChatExecutionScope
    reviewLoop?: ChatReviewLoopMeta
  }
  executionScope?: ChatExecutionScope
  reviewerRuntime?: ReviewerToolRuntime
}

export interface RunAntigravitySubscriptionChatResult {
  planSubmitted: boolean
  sessionId: string | null
}

/** How long a cancelled turn may take to acknowledge `session/cancel` before the host stops waiting. */
const CANCEL_GRACE_MS = 5_000

function subagentOnlyUsage(subagents: ReadonlyMap<string, ChatSubagentUsage>): ChatUsage | undefined {
  if (!subagents.size) return undefined
  const usages = [...subagents.values()].sort((a, b) =>
    `${a.providerId}\0${a.modelId}`.localeCompare(`${b.providerId}\0${b.modelId}`)
  )
  const subCachedInput = usages.reduce((total, usage) => total + (usage.cachedInput ?? 0), 0)
  const subCacheCreate = usages.reduce((total, usage) => total + (usage.cacheCreate ?? 0), 0)
  return {
    usageVersion: 2,
    input: 0,
    output: 0,
    billingOnly: true,
    subInput: usages.reduce((total, usage) => total + usage.input, 0),
    subOutput: usages.reduce((total, usage) => total + usage.output, 0),
    ...(subCachedInput ? { subCachedInput } : {}),
    ...(subCacheCreate ? { subCacheCreate } : {}),
    subagentUsage: usages,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

export async function runAntigravitySubscriptionChat(
  args: RunAntigravitySubscriptionChatArgs
): Promise<RunAntigravitySubscriptionChatResult> {
  const dropImages = args.dropImages === true
  const responseStartedAt = args.responseStartedAt ?? Date.now()
  const ephemeral = Boolean(args.ephemeralSession)
  const canPersistSession = args.canPersistSession ?? (() => true)
  const accountId = args.manager.accountId ?? null
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
  const backgroundPrefix = createBackgroundCompactionPrefixNotifier({
    callback: args.onBackgroundCompactionPrefix,
    message: () => messages[0],
  })
  const coalescer = createDeltaCoalescer(args.emit)
  const apply = (event: ChatStreamEvent, force = false): void => {
    if (event.kind === 'text-start' || event.kind === 'reasoning-start') backgroundPrefix.open(event.partId)
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
  const subagentRuns = new Map<string, SubagentRunMeta>()
  const taskTerminalStates = new Map<string, ToolState>()
  let planSubmitted = false
  const emitGeneratedImage = (toolCallId: string, image: GeneratedImageEmission) =>
    emitGeneratedImagePart(apply, assistantId, toolCallId, image)
  const onGeneratedImageUsage = (usage: import('../tools/util').GeneratedImageUsage) =>
    mergeGeneratedImageUsage(subagentUsage, usage)

  const toolAbort = new AbortController()
  const toolSignal = AbortSignal.any([args.signal, toolAbort.signal])
  const releaseProcess = args.manager.retain()
  let toolset: AntigravityHostToolset | null = null
  let sessionId: string | null = null
  let sessionCreated = false
  let sessionKept = false
  let unsubscribe: (() => void) | null = null
  let mcpClose: (() => Promise<void>) | null = null
  let appClose: (() => Promise<void>) | null = null

  try {
    args.signal.throwIfAborted()
    args.manager.assertAccountIdentity(args.accountIdentity)
    const accountFingerprint = args.accountIdentity.fingerprint as string
    const modelValue = resolveAntigravityModelValue(
      await args.manager.listModels(),
      args.selection.modelId,
      args.reasoningEffort
    )
    if (!modelValue) throw new AntigravityModelUnavailableError(args.selection.modelId)

    const makeContext = (toolCallId: string, signal: AbortSignal): ToolContext => ({
      conversationId: args.conversationId,
      projectId: args.projectId,
      permissionScope: args.permissionScope,
      messageId: assistantId,
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
          permissionScope: args.permissionScope,
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
          messageId: assistantId,
          toolCallId,
          questions,
          signal,
        }),
      submitPlan: (plan, title) => {
        const result = stagePlan({ agentId: args.conversationId, cwd: args.cwd, plan, title })
        planSubmitted = result.ok
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
                if (result.ok) planSubmitted = true
                return result
              },
            } satisfies ReviewerToolRuntime,
          }
        : {}),
      emitGeneratedImage: (image: GeneratedImageEmission) => emitGeneratedImage(toolCallId, image),
      onGeneratedImageUsage,
      ...(conversationDispatch ? { conversationDispatch } : {}),
    })

    const enabledBuiltins = args.reviewerRuntime
      ? new Set(REVIEWER_READONLY_TOOL_NAMES)
      : builtinToolNamesForMode(args.mode)
    const conversationDispatch = args.reviewerRuntime
      ? undefined
      : enableConversationDispatchTools(enabledBuiltins, args.conversationId, args.mode)
    if (!args.reviewerRuntime && (await generateImageToolEnabled(args.conversationId, args.mode))) {
      enabledBuiltins.add(GENERATE_IMAGE_TOOL_NAME)
    }
    const core = buildTools({ enabled: enabledBuiltins, makeCtx: makeContext })
    const gate = (toolName: string, toolCallId: string, signal?: AbortSignal) =>
      args.broker.assert({
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
    const describeImage = (image: Parameters<typeof describeEphemeralToolImage>[0]['image']) =>
      describeEphemeralToolImage({ image, conversationId: args.conversationId, cwd: args.cwd, signal: args.signal })
    const prefs = args.reviewerRuntime ? undefined : getConvUiPrefs(args.conversationId).chat?.tools
    const appToolsEnabled = !args.reviewerRuntime && (prefs?.app ?? getAppFlag('chat.appTools', false))
    const mcp = args.reviewerRuntime
      ? { tools: {}, close: async () => {} }
      : await buildMcpTools({
          mode: args.mode,
          signal: args.signal,
          gate,
          disabledIds: new Set(prefs?.mcpDisabled ?? []),
          codexSafeNames: true,
          supportsImages: true,
          describeImage,
        })
    mcpClose = mcp.close
    const app =
      !args.reviewerRuntime && (appToolsEnabled || hasPersonalMemoryTools(args.conversationId))
        ? await buildAppTools({
            only: appToolsEnabled ? undefined : PERSONAL_MEMORY_TOOLS,
            conversationId: args.conversationId,
            mode: args.mode,
            gate,
            exclude: new Set(['review_plan']),
            supportsImages: true,
            describeImage,
          })
        : { tools: {}, close: async () => {} }
    appClose = app.close

    const reviewerInstructions =
      'This is an isolated internal review turn. Use only the supplied reviewer read-only tools and finish by calling submit_review exactly once.'
    const { instructions, instructionHash, skills, agents } = args.reviewerRuntime
      ? {
          instructions: reviewerInstructions,
          instructionHash: hashAntigravityInstructions(reviewerInstructions),
          skills: [],
          agents: [],
        }
      : await buildAntigravityInstructions({
          projectId: args.projectId,
          cwd: args.cwd,
          conversationId: args.conversationId,
          mode: args.mode,
          maestro: args.maestro,
          modelId: args.selection.modelId,
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

    let runTask: AntigravityManagedTaskRunner | null = args.runTask ?? null
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
            // The host MCP server announces the call; this reports the authoritative terminal state (with `sub`).
            execute: async (input, options) => {
              if (!runTask) throw new Error('The Maestrly subagent executor is not ready')
              const toolCallId = options.toolCallId
              let result: AntigravityManagedTaskResult
              try {
                result = await runTask(input, toolCallId, options.abortSignal ?? args.signal, (update) => {
                  if (update.sub) subagentRuns.set(toolCallId, update.sub)
                })
              } catch (error) {
                const sub = subagentRuns.get(toolCallId)
                taskTerminalStates.set(toolCallId, {
                  status: 'error',
                  error: redactAntigravityCredentials(error instanceof Error ? error.message : String(error)),
                  ...(sub ? { sub } : {}),
                })
                throw error
              }
              const sub = result.sub ?? subagentRuns.get(toolCallId)
              if (sub) subagentRuns.set(toolCallId, sub)
              const resultError = result.error ? redactAntigravityCredentials(result.error) : undefined
              taskTerminalStates.set(
                toolCallId,
                resultError
                  ? { status: 'error', error: resultError, ...(sub ? { sub } : {}) }
                  : { status: 'completed', output: result.output, ...(sub ? { sub } : {}) }
              )
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
    const rawTools: ToolSet = { ...core, ...mcp.tools, ...app.tools, ...skillTools, ...taskTools, ...supervisionTools }
    // Antigravity never shows MCP tool images to the model, so tool images are always described instead.
    const tools = adaptToolSetForModel({ tools: rawTools, supportsImages: false, describeImage })
    if (!runTask && agents.length) {
      const selectableAgentNames = agents.map((agent) => agent.name)
      runTask = createAntigravityTaskRuntime({
        conversationId: args.conversationId,
        projectId: args.projectId,
        permissionScope: args.permissionScope,
        cwd: args.cwd,
        mode: args.mode,
        maestro: args.maestro,
        maestroLive: args.maestroLive,
        turnState: createExplicitSubagentTurnState(
          detectExplicitSubagentsForTurn(history, selectableAgentNames),
          selectableAgentNames
        ),
        permMode: args.permMode ?? 'ask',
        selection: args.selection,
        fastMode: false,
        reasoningEffort: args.reasoningEffort,
        manager: args.manager,
        accountIdentity: args.accountIdentity,
        broker: args.broker,
        questionBroker: args.questionBroker,
        assistantId,
        agents,
        tools: rawTools,
        coordinator: new SubagentCoordinator({
          onEvent: (event) =>
            chatDiag({
              kind: 'subagent-coordinator',
              runtime: 'antigravity-subscription',
              conv: args.conversationId,
              ...event,
            }),
        }),
        subagentUsage,
        apply,
        emitGeneratedImage,
        onGeneratedImageUsage,
      })
    }

    // Session selection: reuse the live session, resume the persisted one, or start fresh with a seed.
    const connection = await args.manager.connection(args.signal)
    const client = connection.client
    const workDir = args.manager.workDir
    const binding = ephemeral ? undefined : getAntigravitySessionBinding(args.conversationId)
    const previousMessageId = history.at(-2)?.id ?? null
    const turnToolset = await registerAntigravityHostToolset(tools)
    toolset = turnToolset
    const toolSignature = turnToolset.toolSignature
    const compatible =
      !!binding &&
      !!previousMessageId &&
      binding.lastMessageId === previousMessageId &&
      binding.toolSignature === toolSignature &&
      binding.instructionHash === instructionHash &&
      binding.accountFingerprint === accountFingerprint &&
      binding.accountId === accountId
    const live = ephemeral ? undefined : args.manager.getLiveSession(args.conversationId)
    let current: AntigravityLiveSession | null = null
    if (
      compatible &&
      live &&
      live.sessionId === binding.sessionId &&
      live.generation === connection.generation &&
      live.toolSignature === toolSignature &&
      live.instructionHash === instructionHash
    ) {
      turnToolset.dispose()
      toolset = live.toolset
      current = live
    } else if (live) {
      args.manager.dropLiveSession(args.conversationId)
    }
    if (!current && compatible) {
      try {
        await client.request('session/resume', {
          sessionId: binding.sessionId,
          cwd: workDir,
          mcpServers: [turnToolset.mcpServer],
          _meta: ANTIGRAVITY_SESSION_META,
        })
        current = {
          sessionId: binding.sessionId,
          generation: connection.generation,
          toolset: turnToolset,
          toolSignature,
          instructionHash,
          modelValue: null,
        }
      } catch (error) {
        if (!(error instanceof AcpRpcError && error.code === ACP_RESOURCE_NOT_FOUND_CODE)) throw error
      }
    }
    let newSession = false
    if (!current) {
      if (binding) {
        retireAntigravitySessionBinding(args.conversationId, binding.sessionId)
        if (binding.accountId === accountId) void args.manager.deleteSession(binding.sessionId)
      }
      const created = await client.request<AcpSessionSetupResult>('session/new', {
        cwd: workDir,
        mcpServers: [turnToolset.mcpServer],
        _meta: ANTIGRAVITY_SESSION_META,
      })
      if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
      sessionCreated = true
      newSession = true
      current = {
        sessionId: created.sessionId,
        generation: connection.generation,
        toolset: turnToolset,
        toolSignature,
        instructionHash,
        modelValue: null,
      }
    }
    const session = current
    sessionId = session.sessionId
    const activeToolset = session.toolset
    if (session.modelValue !== modelValue) {
      await client.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: modelValue,
      })
      session.modelValue = modelValue
    }

    // The turn itself.
    const mapper = createAntigravityStreamMapper(assistantId)
    activeToolset.setActiveTurn({
      tools,
      signal: toolSignal,
      onToolStart: ({ toolCallId, toolName, input }) => {
        mapper.breakTextPart()
        backgroundPrefix.closeAll()
        apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId, toolName })
        apply({ kind: 'tool-call', messageId: assistantId, toolCallId, toolName, input }, toolName === 'ask_question')
      },
      onToolResult: ({ toolCallId, output, isError }) => {
        const authoritative = taskTerminalStates.get(toolCallId)
        const text = clipPersistedToolOutput(toolOutputText(output))
        const state: ToolState =
          authoritative ??
          (isError
            ? { status: 'error', error: redactAntigravityCredentials(text || 'Tool failed') }
            : { status: 'completed', output: typeof output === 'string' ? text : { ...output, text } })
        apply({ kind: 'tool-state', messageId: assistantId, toolCallId, state }, true)
        backgroundPrefix.notifyAfterPersist()
      },
    })
    unsubscribe = connection.subscribe(session.sessionId, (update) => {
      for (const event of mapper.push(update)) apply(event)
    })
    const prompt = buildAntigravityPromptBlocks({
      conversationId: args.conversationId,
      message: currentUser,
      newSession,
      instructions,
      toolCatalog: renderAntigravityToolCatalog(activeToolset.specs),
      seedTranscript: newSession ? buildAntigravitySeedTranscript(history) : '',
      dropImages,
    })
    const pending = client.request<AcpPromptResult>('session/prompt', { sessionId: session.sessionId, prompt })
    let cancelSent = false
    const cancel = () => {
      if (cancelSent) return
      cancelSent = true
      client.notify('session/cancel', { sessionId: session.sessionId })
    }
    args.signal.addEventListener('abort', cancel, { once: true })
    if (args.signal.aborted) cancel()
    const outcome = await Promise.race([
      pending.then((result) => ({ result })),
      new Promise<{ result: null }>((resolve) => {
        const giveUp = () => void delay(CANCEL_GRACE_MS).then(() => resolve({ result: null }))
        if (args.signal.aborted) giveUp()
        else args.signal.addEventListener('abort', giveUp, { once: true })
      }),
    ])
    args.signal.removeEventListener('abort', cancel)
    pending.catch(() => undefined)
    const aborted = args.signal.aborted || outcome.result?.stopReason === 'cancelled'
    const usage = subagentOnlyUsage(subagentUsage)

    if (!aborted && !activeToolset.wasInitialized()) {
      chatDiag({ kind: 'antigravity-tools-unavailable', conv: args.conversationId })
      // The session never reached Maestrly's tools; the next turn starts a fresh one.
      if (!ephemeral) retireAntigravitySessionBinding(args.conversationId, session.sessionId)
      apply(
        {
          kind: 'error',
          messageId: assistantId,
          message: new AntigravityToolsUnavailableError().message,
          removeAssistantText: true,
          ...(usage ? { usage } : {}),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
      coalescer.flush()
      return { planSubmitted, sessionId: session.sessionId }
    }

    const stopReason = outcome.result?.stopReason
    const terminal: ChatStreamEvent = aborted
      ? {
          kind: 'aborted',
          messageId: assistantId,
          ...(usage ? { usage } : {}),
          responseDurationMs: responseDurationMs(responseStartedAt),
        }
      : stopReason === 'refusal'
        ? {
            kind: 'error',
            messageId: assistantId,
            message: 'Google declined to answer this request.',
            ...(usage ? { usage } : {}),
            responseDurationMs: responseDurationMs(responseStartedAt),
          }
        : {
            kind: 'finish',
            messageId: assistantId,
            finishReason: stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? 'length' : 'stop',
            ...(usage ? { usage } : {}),
            responseDurationMs: responseDurationMs(responseStartedAt),
          }
    apply(terminal, true)
    if (terminal.kind === 'finish') backgroundPrefix.closeAll()
    backgroundPrefix.notifyAfterPersist()

    const identityCurrent = (() => {
      try {
        args.manager.assertAccountIdentity(args.accountIdentity)
        return true
      } catch {
        return false
      }
    })()
    if (terminal.kind === 'finish' && !ephemeral && identityCurrent && canPersistSession()) {
      putAntigravitySessionBinding({
        conversationId: args.conversationId,
        accountId,
        accountFingerprint,
        sessionId: session.sessionId,
        modelValue,
        toolSignature: session.toolSignature,
        instructionHash: session.instructionHash,
        lastMessageId: assistantId,
      })
      args.manager.setLiveSession(args.conversationId, session)
      sessionKept = true
    }
    if (mapper.state.ignoredNativeTools.length) {
      chatDiag({
        kind: 'antigravity-native-tools-denied',
        conv: args.conversationId,
        count: mapper.state.ignoredNativeTools.length,
      })
    }
    coalescer.flush()
    return { planSubmitted, sessionId: session.sessionId }
  } catch (error) {
    const translated = args.manager.translateError(error)
    const usage = subagentOnlyUsage(subagentUsage)
    if (args.signal.aborted) {
      apply({ kind: 'aborted', messageId: assistantId, ...(usage ? { usage } : {}) }, true)
    } else {
      apply(
        {
          kind: 'error',
          messageId: assistantId,
          message: antigravityErrorMessage(translated).message,
          ...(usage ? { usage } : {}),
          responseDurationMs: responseDurationMs(responseStartedAt),
        },
        true
      )
    }
    chatDiag({
      kind: 'antigravity-run-error',
      conv: args.conversationId,
      error: translated instanceof Error ? translated.name : typeof translated,
    })
    coalescer.flush()
    return { planSubmitted, sessionId }
  } finally {
    toolAbort.abort()
    unsubscribe?.()
    if (toolset && !sessionKept) {
      toolset.setActiveTurn(null)
      // A failed or unfinished turn never leaves a reusable live session behind.
      args.manager.dropLiveSession(args.conversationId)
      toolset.dispose()
    } else {
      toolset?.setActiveTurn(null)
    }
    if (sessionId && sessionCreated && !sessionKept) void args.manager.deleteSession(sessionId)
    await mcpClose?.().catch(() => undefined)
    await appClose?.().catch(() => undefined)
    releaseProcess()
    try {
      persist()
    } catch {
      // Incremental writes already persisted the visible transcript.
    }
    coalescer.flush()
    coalescer.dispose()
  }
}
