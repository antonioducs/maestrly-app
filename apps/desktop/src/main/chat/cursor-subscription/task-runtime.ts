import type { ToolSet } from 'ai'
import type {
  ChatModelRef,
  ChatPermMode,
  ChatStreamEvent,
  ChatSubagentUsage,
  SubagentRunMeta,
} from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../../shared/maestro'
import type { GeneratedImageEmission, GeneratedImageUsage } from '../tools/util'
import type { ChatAgent } from '../agents'
import { isClaudeSubscriptionProvider, isCursorSubscriptionProvider } from '../catalog'
import type { PermissionScope } from '../../../shared/conversation-scope'
import type { PermissionBroker } from '../permission'
import type { QuestionBroker } from '../question-broker'
import type { SubagentCoordinator, SubagentLease } from '../subagent-coordinator'
import { resolveSubagentExecutionProfile } from '../subagent-execution-profile'
import {
  assertSubagentSelection,
  recordSubagentDispatch,
  type ExplicitSubagentTurnState,
} from '../subagent-selection-guard'
import { namespaceSubagentToolSet } from '../subagent-runner'
import { isSubagentReadOnly } from '../tools'
import { selectedSubagentToolNames } from '../claude-agent-sdk/task-runtime'
import { describeEphemeralToolImage, hasConfiguredImageInterpreter } from '../image-interpreter'
import { adaptToolSetForModel, supportsChatToolImages } from '../tool-capabilities'
import { getSubagentProfileModelMeta } from '../subagent-profile-model-meta'
import { executeSubagent } from '../subagent-executor'
import { prepareMaestroDelegation } from '../maestro-delegation'
import type { MaestroLiveRunPort } from '../maestro-live'
import { startMaestroDelegation } from '../maestro-delegation-registry'
import type { SubagentSessionRecorder } from '../subagent-session'
import type { CursorSubscriptionAccountIdentity, CursorSubscriptionManager } from './manager'
import type { NormalizedAiUsage } from '../subagent-runner'

export interface CursorManagedTaskUpdate {
  output?: string
  sub?: SubagentRunMeta
}

export interface CursorManagedTaskResult {
  output: string
  error?: string
  sub?: SubagentRunMeta
}

export type CursorManagedTaskRunner = (
  input: unknown,
  toolCallId: string,
  /** Child host lifetime; a parent SDK transport disconnect must not abort it. */
  signal: AbortSignal,
  update: (state: CursorManagedTaskUpdate) => void
) => Promise<CursorManagedTaskResult>

export interface CreateCursorTaskRuntimeArgs {
  conversationId: string
  /** Null for standalone chats, which have no workspace; permissionScope then carries the isolation. */
  projectId: string | null
  permissionScope?: PermissionScope
  cwd: string
  mode: ChatBehavior
  maestro?: MaestroTurnSnapshotV1
  maestroLive?: MaestroLiveRunPort
  permMode: ChatPermMode
  selection: ChatModelRef
  reasoningEffort?: string
  /** Conversation speed variant, explicitly propagated to child runtimes. */
  fastMode: boolean
  /** Reuse the admitted account only when the child selects the same provider. */
  manager?: CursorSubscriptionManager
  accountIdentity?: CursorSubscriptionAccountIdentity
  broker: PermissionBroker
  questionBroker: QuestionBroker
  assistantId: string
  agents: readonly ChatAgent[]
  tools: ToolSet
  coordinator: SubagentCoordinator
  subagentUsage: Map<string, ChatSubagentUsage>
  apply: (event: ChatStreamEvent) => void
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
  /** Turn state containing explicitly requested agents (host guard). */
  turnState: ExplicitSubagentTurnState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function createCursorTaskRuntime(args: CreateCursorTaskRuntimeArgs): CursorManagedTaskRunner {
  return async (input, toolCallId, signal, update) => {
    const parsed = isRecord(input) ? input : {}
    let agentName = typeof parsed.agent === 'string' ? parsed.agent : ''
    let task = typeof parsed.prompt === 'string' ? parsed.prompt : ''
    const maestroPrepared =
      args.mode === 'maestro' && args.maestro
        ? await prepareMaestroDelegation({
            input,
            turn: args.maestro,
            parent: { ...args.selection, effort: args.reasoningEffort || 'off' },
            parentFastMode: args.fastMode,
            turnState: args.turnState,
            delegationId: toolCallId,
            owner: { conversationId: args.conversationId, parentMessageId: args.assistantId },
          })
        : undefined
    if (maestroPrepared) {
      agentName = maestroPrepared.agentName
      task = maestroPrepared.task
    }
    if (!agentName || !task) throw new Error('task requires agent and prompt.')
    // Agent selection is semantic and happens before execution-profile resolution.
    // Execution routing is host-managed and keyed by the selected agent name.
    // A role mentioned inside task.prompt must never alter profile resolution.
    if (!maestroPrepared) {
      assertSubagentSelection({
        state: args.turnState,
        selectedAgent: agentName,
        availableAgents: args.agents.map((agent) => agent.name),
        runtime: 'cursor-subscription',
        conversationId: args.conversationId,
      })
      recordSubagentDispatch(args.turnState, agentName)
    }
    const startedAt = Date.now()
    const lines: string[] = []
    const resolved = maestroPrepared
      ? {
          definition: args.agents.find((agent) => agent.name === agentName) ?? null,
          profile: maestroPrepared.execution.profile,
        }
      : await resolveSubagentExecutionProfile({
          agentName,
          agents: [...args.agents],
          conversationId: args.conversationId,
          parentFastMode: args.fastMode,
          parent: {
            ...args.selection,
            effort: args.reasoningEffort && args.reasoningEffort !== 'off' ? args.reasoningEffort : '',
          },
        })
    const meta = (usage?: NormalizedAiUsage, final = false, runtimeEstimatedCostUsd?: number): SubagentRunMeta => ({
      profile: resolved.profile,
      ...(maestroPrepared ? { maestro: maestroPrepared.execution.snapshot } : {}),
      startedAt,
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
    const updateRun = (output: string | undefined, sub: SubagentRunMeta): void => {
      update({ ...(output ? { output } : {}), sub })
      args.apply({
        kind: 'tool-state',
        messageId: args.assistantId,
        toolCallId,
        state: { status: 'running', ...(output ? { output } : {}), sub },
      })
    }
    updateRun(undefined, meta())
    if (!resolved.definition || !resolved.profile.effective) {
      const sub = meta(undefined, true)
      updateRun(undefined, sub)
      return {
        output: '',
        error: `Subagent "${agentName}" has no runnable execution profile.`,
        sub,
      }
    }
    const readOnly = isSubagentReadOnly(args.mode, resolved.definition.tools, args.tools)
    let usageRecorded = false
    const recordSubagentUsage = (
      model: ChatModelRef | undefined,
      usage: NormalizedAiUsage | undefined,
      runtimeEstimatedCostUsd?: number
    ): void => {
      if (!model || (!usage && runtimeEstimatedCostUsd == null) || usageRecorded) return
      usageRecorded = true
      const key = `${model.providerId}\0${model.modelId}`
      const previous = args.subagentUsage.get(key)
      args.subagentUsage.set(key, {
        providerId: model.providerId,
        modelId: model.modelId,
        input: (previous?.input ?? 0) + (usage?.input ?? 0),
        output: (previous?.output ?? 0) + (usage?.output ?? 0),
        cachedInput: (previous?.cachedInput ?? 0) + (usage?.cacheRead ?? 0),
        cacheCreate: (previous?.cacheCreate ?? 0) + (usage?.cacheCreate ?? 0),
        catalogInput: (previous?.catalogInput ?? 0) + (runtimeEstimatedCostUsd == null ? (usage?.input ?? 0) : 0),
        catalogOutput: (previous?.catalogOutput ?? 0) + (runtimeEstimatedCostUsd == null ? (usage?.output ?? 0) : 0),
        catalogCacheRead:
          (previous?.catalogCacheRead ?? 0) + (runtimeEstimatedCostUsd == null ? (usage?.cacheRead ?? 0) : 0),
        catalogCacheCreate:
          (previous?.catalogCacheCreate ?? 0) + (runtimeEstimatedCostUsd == null ? (usage?.cacheCreate ?? 0) : 0),
        ...(previous?.runtimeEstimatedCostUsd != null || runtimeEstimatedCostUsd != null
          ? {
              runtimeEstimatedCostUsd: (previous?.runtimeEstimatedCostUsd ?? 0) + (runtimeEstimatedCostUsd ?? 0),
            }
          : {}),
      })
    }
    const executeResolved = async (
      workSignal: AbortSignal,
      sessionRecorder?: SubagentSessionRecorder,
      background = false
    ): Promise<CursorManagedTaskResult> => {
      const progress = (line: string): void => {
        if (!line.trim() || background) return
        lines.push(line.trim())
        updateRun(lines.slice(-12).join('\n'), meta())
      }
      let lease: SubagentLease | null = null
      try {
        lease = await args.coordinator.acquire({ agent: agentName, signal: workSignal })
        const effective = resolved.profile.effective!
        const childMeta = isClaudeSubscriptionProvider(effective.providerId)
          ? { meta: { vision: true } }
          : isCursorSubscriptionProvider(effective.providerId)
            ? { meta: null } // The Cursor catalog does not advertise vision; avoid an extra auth round-trip.
            : await getSubagentProfileModelMeta(effective.providerId, effective.modelId).catch(() => ({ meta: null }))
        const childTools = adaptToolSetForModel({
          tools: args.tools,
          supportsImages: supportsChatToolImages({
            modelVision: childMeta.meta?.vision,
            unknownVision: 'unsupported',
            imageInterpreterConfigured: hasConfiguredImageInterpreter(),
          }),
          describeImage: (image) =>
            describeEphemeralToolImage({
              image,
              conversationId: args.conversationId,
              cwd: args.cwd,
              signal: workSignal,
            }),
        })
        const namespacedChildTools = namespaceSubagentToolSet(childTools, toolCallId)
        const selectedChildToolNames = selectedSubagentToolNames(
          readOnly,
          resolved.definition!.tools,
          namespacedChildTools,
          resolved.definition!
        )
        const worker = await executeSubagent({
          conversationId: args.conversationId,
          projectId: args.projectId,
          permissionScope: args.permissionScope,
          cwd: args.cwd,
          parentMessageId: args.assistantId,
          toolCallId,
          delegationId: maestroPrepared?.execution.snapshot.delegationId,
          delegationLabel: maestroPrepared?.execution.snapshot.resource.label,
          maestroSnapshot: maestroPrepared?.execution.snapshot,
          mode: args.mode,
          permMode: args.permMode,
          profile: resolved.profile,
          definition: resolved.definition!,
          agentName,
          task,
          readOnly,
          tools: namespacedChildTools,
          allowedToolNames: selectedChildToolNames,
          broker: args.broker,
          questionBroker: args.questionBroker,
          signal: workSignal,
          progress,
          sessionRecorder,
          emitGeneratedImage: args.emitGeneratedImage,
          onGeneratedImageUsage: args.onGeneratedImageUsage,
          account: {
            parentProviderId: args.selection.providerId,
            ...(args.manager && args.accountIdentity
              ? { cursor: { manager: args.manager, identity: args.accountIdentity } }
              : {}),
          },
        })
        recordSubagentUsage(worker.model, worker.usage, worker.runtimeEstimatedCostUsd)
        const summary = sessionRecorder?.summary()
        const sub = {
          ...meta(worker.usage, true, worker.runtimeEstimatedCostUsd),
          ...(sessionRecorder
            ? {
                sessionId: sessionRecorder.id,
                phase: summary?.phase,
                lastActivityAt: summary?.lastActivityAt,
              }
            : {}),
        }
        if (!background) updateRun(lines.slice(-12).join('\n'), sub)
        return worker.error
          ? { output: worker.text, error: `Subagent "${agentName}" failed: ${worker.error}`, sub }
          : { output: worker.text, sub }
      } catch (error) {
        const withUsage = error as Error & {
          subagentUsage?: NormalizedAiUsage
          subagentModel?: ChatModelRef
          subagentRuntimeEstimatedCostUsd?: number
        }
        recordSubagentUsage(withUsage.subagentModel, withUsage.subagentUsage, withUsage.subagentRuntimeEstimatedCostUsd)
        if (!background) {
          updateRun(
            lines.slice(-12).join('\n'),
            meta(withUsage.subagentUsage, true, withUsage.subagentRuntimeEstimatedCostUsd)
          )
        }
        throw error
      } finally {
        lease?.release()
      }
    }

    if (maestroPrepared) {
      return startMaestroDelegation({
        conversationId: args.conversationId,
        parentMessageId: args.assistantId,
        toolCallId,
        agentName,
        task,
        profile: resolved.profile,
        maestro: maestroPrepared.execution.snapshot,
        parentSignal: signal,
        maestroLive: args.maestroLive,
        execute: (workSignal, sessionRecorder) => executeResolved(workSignal, sessionRecorder, true),
      })
    }
    return executeResolved(signal)
  }
}

export { READ_ONLY_TOOL_NAMES } from '../tools'
