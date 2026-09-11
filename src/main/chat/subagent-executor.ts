import type { ToolSet } from 'ai'
import type { ChatPermMode, SubagentResumeStatus, SubagentRuntimeHandle } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import type { MaestroDelegationSnapshotV1 } from '../../shared/maestro'
import type { SubagentExecutionSnapshotV1 } from '../../shared/subagent-profiles'
import type { GeneratedImageEmission, GeneratedImageUsage } from './tools/util'
import type { ChatAgent } from './agents'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  subscriptionAccountId,
} from './catalog'
import type { ClaudeSubscriptionAccountIdentity, ClaudeSubscriptionManager } from './claude-agent-sdk/manager'
import { queueClaudeSessionCleanup } from './claude-agent-sdk/session-store'
import { runClaudeSubagent } from './claude-agent-sdk/subagent-runner'
import { getCodexSubscriptionManager } from './codex-subscription/manager'
import {
  approvalConfig,
  registerCodexSubagentRequestRoute,
  sandboxPolicyFor,
  toolSetRuntimes,
} from './codex-subscription/runner'
import { runCodexSubagent } from './codex-subscription/subagent-runner'
import { queueCodexThreadCleanup } from './codex-subscription/thread-store'
import {
  planSubagentResume,
  claudeSubagentRuntimeSignature,
  recreatedTask,
  resolveSubagentResume,
  subagentToolSignature,
  type SubagentReplayMessage,
  type SubagentResumeRecreateReason,
  type SubagentResumeSource,
} from './subagent-resume'
import { getAppFlag } from '../store'
import { FABLE_51_PROFILE_FLAG } from './fable/profile'
import { OPUS_5_PROFILE_FLAG } from './opus/profile'
import { resolveClaudeBehaviorProfile } from './behavior-profile'
import { resolveCodexSubagentServiceTier } from './subscription-failover/codex-adapter'
import type { GitHubCopilotAccountIdentity, GitHubCopilotSubscriptionManager } from './github-copilot/manager'
import { getGitHubCopilotSubscriptionManager } from './github-copilot/manager'
import { runGitHubCopilotSubagent } from './github-copilot/subagent-runner'
import { copilotTools } from './github-copilot/tools'
import type { PermissionBroker } from './permission'
import type { QuestionBroker } from './question-broker'
import { withSubagentMessageOwnership, type SubagentMessageOwnership } from './subagent-ownership'
import type { SubagentTextUpdateHandler } from './subagent-text-stream'
import { createSubagentSessionRecorder, type SubagentSessionRecorder } from './subagent-session'
import {
  namespaceSubagentToolCallId,
  namespaceSubagentToolSet,
  runSubagent,
  subagentPermissionAssertInput,
} from './subagent-runner'
import { ALL_TOOL_NAMES, buildTools, selectSubagentToolNames } from './tools'
import { buildMaestroWorkerTools, isMaestroWorkerOperationalToolName } from './maestro-worker-tools'

export type SubagentExecutionResult = Awaited<ReturnType<typeof runSubagent>> & {
  runtimeEstimatedCostUsd?: number
  errorCode?: 'agent-unavailable' | 'agent-failed'
}

export type { SubagentTextUpdate, SubagentTextUpdateHandler } from './subagent-text-stream'

export interface SubagentExecutorAccountContext {
  parentProviderId?: string
  claude?: { manager: ClaudeSubscriptionManager; identity: ClaudeSubscriptionAccountIdentity }
  copilot?: { manager: GitHubCopilotSubscriptionManager; identity: GitHubCopilotAccountIdentity }
}

/** Provider boundary for one already-resolved child execution. Profile resolution, coordinator leases,
 * usage aggregation and UI state deliberately remain with the task runtime. */
export async function executeSubagent(args: {
  conversationId: string
  projectId: string
  cwd: string
  parentMessageId: string
  /** Conversation turns already own this row; host workflows must declare their cleanup contract. */
  parentMessageOwnership?: SubagentMessageOwnership
  toolCallId?: string
  /** Stable Maestro routing identity; falls back to toolCallId for Standard callers. */
  delegationId?: string
  delegationLabel?: string
  maestroSnapshot?: MaestroDelegationSnapshotV1
  mode: ChatBehavior
  permMode: ChatPermMode
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  agentName: string
  task: string
  readOnly: boolean
  /** Host tools are capability/vision-adapted by the caller before crossing this boundary. */
  tools?: ToolSet
  allowedToolNames?: ReadonlySet<string>
  deferredToolNames?: ReadonlySet<string>
  broker: PermissionBroker
  questionBroker: QuestionBroker
  signal: AbortSignal
  progress?: (line: string) => void
  /** Provider-neutral incremental text. Fold append/replace events in arrival order. */
  onTextUpdate?: SubagentTextUpdateHandler
  /** Session precreated by Maestro's asynchronous protocol. */
  sessionRecorder?: SubagentSessionRecorder
  emitGeneratedImage?: (toolCallId: string, image: GeneratedImageEmission) => void
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
  generateImage?: (
    prompt: string,
    signal: AbortSignal,
    onUsage?: (usage: GeneratedImageUsage) => void
  ) => Promise<GeneratedImageEmission>
  account?: SubagentExecutorAccountContext
}): Promise<SubagentExecutionResult> {
  const recorder =
    args.sessionRecorder ??
    (args.toolCallId
      ? createSubagentSessionRecorder({
          conversationId: args.conversationId,
          parentMessageId: args.parentMessageId,
          toolCallId: args.toolCallId,
          origin: args.mode === 'maestro' ? 'delegate' : 'task',
          agentName: args.agentName,
          task: args.task,
          profile: args.profile,
          maestro: args.maestroSnapshot,
          startedAt: Date.now(),
        })
      : null)
  const progress = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed) recorder?.phase(trimmed.startsWith('Starting subagent') ? 'model-started' : trimmed)
    args.progress?.(line)
  }
  const onTextUpdate: SubagentTextUpdateHandler = (update) => {
    recorder?.text(update)
    args.onTextUpdate?.(update)
  }
  const effective = args.profile.effective
  if (!effective) {
    recorder?.complete({ status: 'failed', error: `Subagent "${args.agentName}" has no runnable execution profile.` })
    return {
      text: '',
      error: `Subagent "${args.agentName}" has no runnable execution profile.`,
      errorCode: 'agent-unavailable',
    }
  }
  const taskCallId = args.toolCallId ?? args.parentMessageId
  const maestroRuntime =
    args.mode === 'maestro'
      ? await buildMaestroWorkerTools({
          conversationId: args.conversationId,
          projectId: args.projectId,
          cwd: args.cwd,
          parentMessageId: args.parentMessageId,
          delegationId: args.delegationId ?? taskCallId,
          label: args.delegationLabel ?? args.agentName,
          profile: args.profile,
          broker: args.broker,
          signal: args.signal,
          emitGeneratedImage: args.emitGeneratedImage,
          onGeneratedImageUsage: args.onGeneratedImageUsage,
          generateImage: args.generateImage,
        })
      : null
  const maestroTools = maestroRuntime ? namespaceSubagentToolSet(maestroRuntime.tools, taskCallId) : {}
  // Maestro owns the catalog/loader pair atomically. Never retain a loader captured by the parent turn after
  // the worker re-resolves the effective skill state for its own asynchronous start.
  const inheritedTools = Object.fromEntries(
    Object.entries(args.tools ?? {}).filter(([name]) => args.mode !== 'maestro' || name !== 'use_skill')
  ) as ToolSet
  const providedTools: ToolSet = { ...inheritedTools, ...maestroTools }
  const effectiveReadOnly = args.mode === 'maestro' ? false : args.readOnly
  const policyAllowed = selectSubagentToolNames({
    definition: args.definition,
    readOnly: effectiveReadOnly,
    providedHostTools: providedTools,
    allowSkillLoader: args.mode === 'maestro',
  })
  const allowed = maestroRuntime
    ? new Set(Object.keys(providedTools).filter(isMaestroWorkerOperationalToolName))
    : args.allowedToolNames
      ? new Set([...args.allowedToolNames].filter((name) => policyAllowed.has(name)))
      : policyAllowed
  const effectiveDefinition: ChatAgent = maestroRuntime
    ? {
        ...args.definition,
        tools: [...allowed],
        prompt: [args.definition.prompt, maestroRuntime.skillCatalog].filter(Boolean).join('\n\n'),
      }
    : args.definition
  const builtinNames = new Set([...allowed].filter((name) => ALL_TOOL_NAMES.includes(name)))
  // Official child runtimes such as Claude/Copilot expose only the custom ToolSet supplied here. Rebuild the
  // child's allowed core surface independently from the parent: a Maestro parent remains read-only while a Pool
  // worker can still receive bash/write/edit. Host tools stay limited to the already-gated parent-provided set.
  const builtinTools = maestroRuntime
    ? {}
    : buildTools({
        enabled: builtinNames,
        makeCtx: (toolCallId, toolSignal) => ({
          conversationId: args.conversationId,
          projectId: args.projectId,
          messageId: args.parentMessageId,
          toolCallId: namespaceSubagentToolCallId(taskCallId, toolCallId),
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
                toolCallId: namespaceSubagentToolCallId(taskCallId, toolCallId),
                signal: toolSignal,
              })
            )
          },
          askQuestion: async () => [],
        }),
      })
  const tools: ToolSet = recorder?.instrumentTools({ ...builtinTools, ...providedTools }) ?? {
    ...builtinTools,
    ...providedTools,
  }
  const deferred = new Set([...(args.deferredToolNames ?? []), ...(maestroRuntime?.deferredToolNames ?? [])])
  // Maestro continuity: the parent requested continuation of this agent's previous turn. The host decides per
  // provider whether the native thread can reopen; otherwise recreate the worker with the previous
  // report injected and record the reason — never silently.
  const persistRuntime = args.mode === 'maestro'
  const resumedFrom = args.maestroSnapshot?.resumedFrom
  const resumeSource: SubagentResumeSource | null = resumedFrom
    ? (resolveSubagentResume(resumedFrom) ?? {
        sessionId: resumedFrom,
        agentName: args.agentName,
        handle: null,
        lastReport: '',
        replay: [],
      })
    : null
  let resumeOutcomeRecorded = false
  const recordResume = (status: SubagentResumeStatus, reason?: string): void => {
    if (resumeOutcomeRecorded) return
    resumeOutcomeRecorded = true
    recorder?.resumeOutcome(status, reason)
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
    if (!resumeSource) return { task: args.task, handle: null, fallbackTask: args.task }
    const fallback = (reason: SubagentResumeRecreateReason) => recreatedTask(args.task, resumeSource, reason)
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
    if (plan.mode === 'replay') return { task: args.task, handle: null, fallbackTask: args.task, replay: plan.history }
    return { task: args.task, handle: plan.handle, fallbackTask: fallback('resume-rejected') }
  }
  const settleResume = (result: { resumed?: boolean; resumeReason?: string }): void => {
    if (!resumeSource) return
    if (result.resumed) recordResume('resumed')
    else recordResume('recreated', result.resumeReason ?? 'resume-rejected')
  }
  const runProvider = async (): Promise<SubagentExecutionResult> => {
    if (isClaudeSubscriptionProvider(effective.providerId)) {
      let runtimeSignature = ''
      let behaviorProfile: ReturnType<typeof resolveClaudeBehaviorProfile>['profile'] | undefined
      const result = await runClaudeSubagent({
        ...args,
        definition: effectiveDefinition,
        readOnly: effectiveReadOnly,
        prepareTarget: (target) => {
          if (behaviorProfile === undefined)
            behaviorProfile = resolveClaudeBehaviorProfile({
              requestedModelId: effective.modelId,
              resolvedModelId: target.runtimeModelId,
              fableEnabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
              opusEnabled: getAppFlag(OPUS_5_PROFILE_FLAG, true),
            }).profile
          runtimeSignature = claudeSubagentRuntimeSignature({
            modelId: target.runtimeModelId,
            accountIdentity: target.accountIdentity,
            behaviorProfileId: behaviorProfile?.id ?? null,
            prompt: effectiveDefinition.prompt,
            readOnly: effectiveReadOnly,
            sentEffort: effective.sentEffort,
            fastMode: effective.fastMode === true,
            toolNames: [...allowed],
          })
          const resume = resumeFor(target.providerId, target.accountId, undefined, {
            modelId: target.runtimeModelId,
            behaviorProfileId: behaviorProfile?.id ?? null,
            runtimeSignature,
          })
          return {
            task: resume.task,
            behaviorProfile,
            ...(resume.handle?.kind === 'claude-session'
              ? {
                  resume: {
                    sessionId: resume.handle.sessionId,
                    fallbackTask: resume.fallbackTask,
                    accountId: resume.handle.accountId,
                  },
                }
              : {}),
          }
        },
        tools,
        allowSkillLoader: args.mode === 'maestro',
        progress,
        onTextUpdate,
        persistRuntime,
        onSessionStarted: ({ sessionId, target }) => {
          if (!persistRuntime) return
          recorder?.runtimeHandle({
            kind: 'claude-session',
            sessionId,
            cwd: args.cwd,
            accountId: target.accountId,
            modelId: target.runtimeModelId,
            behaviorProfileId: behaviorProfile?.id ?? null,
            runtimeSignature,
          })
          queueClaudeSessionCleanup(args.conversationId, sessionId, args.cwd, target.accountId)
        },
      })
      settleResume(result)
      return result
    }

    if (isGitHubCopilotSubscriptionProvider(effective.providerId)) {
      const parent = effective.providerId === args.account?.parentProviderId ? args.account.copilot : undefined
      const manager =
        parent?.manager ?? getGitHubCopilotSubscriptionManager(subscriptionAccountId(effective.providerId))
      const identity = parent?.identity ?? manager.getAccountIdentity()
      if (!identity.fingerprint) {
        return { text: '', error: 'GitHub Copilot subscription is not authenticated.', errorCode: 'agent-unavailable' }
      }
      return runGitHubCopilotSubagent({
        ...args,
        task: resumeFor(effective.providerId, null).task,
        definition: effectiveDefinition,
        readOnly: effectiveReadOnly,
        manager,
        accountIdentity: identity,
        progress,
        onTextUpdate,
        tools: await copilotTools(
          Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name))),
          args.signal,
          deferred
        ),
        allowSkillLoader: args.mode === 'maestro',
      })
    }

    if (isCodexSubscriptionProvider(effective.providerId)) {
      // Parent Maestro is read-only, but a Pool worker owns its own capability boundary.
      const childMode = effectiveReadOnly ? ('plan' as const) : ('agent' as const)
      const manager = getCodexSubscriptionManager(subscriptionAccountId(effective.providerId))
      let serviceTier: string
      try {
        serviceTier = await resolveCodexSubagentServiceTier(manager, effective.modelId, effective.fastMode === true)
      } catch (error) {
        return {
          text: '',
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'agent-unavailable',
        }
      }
      const client = await manager.getClient()
      const runtimes = (await toolSetRuntimes(tools, deferred)).filter((entry) => allowed.has(entry.spec.name))
      const registration = registerCodexSubagentRequestRoute({
        client,
        conversationId: args.conversationId,
        projectId: args.projectId,
        messageId: args.parentMessageId,
        broker: args.broker,
        questionBroker: args.questionBroker,
        runtimes,
        signal: args.signal,
        mode: childMode,
        toolCallIdPrefix: args.toolCallId,
      })
      const approval = approvalConfig(childMode, args.permMode)
      const accountId = subscriptionAccountId(effective.providerId)
      const toolSignature = subagentToolSignature(runtimes.map((entry) => entry.spec))
      const resume = resumeFor(effective.providerId, accountId, toolSignature)
      try {
        const result = await runCodexSubagent({
          client,
          cwd: args.cwd,
          profile: args.profile,
          definition: effectiveDefinition,
          signal: args.signal,
          agentName: args.agentName,
          task: resume.task,
          readOnly: effectiveReadOnly,
          serviceTier,
          approvalPolicy: approval.approvalPolicy,
          sandboxPolicy: sandboxPolicyFor(approval.sandbox, args.cwd),
          dynamicTools: runtimes.map((entry) => entry.spec),
          registerThread: (threadId) => registration.addThread(threadId),
          removeThread: (threadId) => registration.removeThread(threadId),
          progress,
          onTextUpdate,
          persistRuntime,
          ...(resume.handle?.kind === 'codex-thread'
            ? { resume: { threadId: resume.handle.threadId, fallbackTask: resume.fallbackTask } }
            : {}),
          onThreadStarted: ({ threadId }) => {
            if (!persistRuntime) return
            recorder?.runtimeHandle({ kind: 'codex-thread', threadId, accountId, toolSignature })
            queueCodexThreadCleanup(args.conversationId, threadId, accountId)
          },
        })
        settleResume(result)
        return result
      } finally {
        registration.remove()
      }
    }

    // BYOK: without a server-side session, resume means replaying the previous turn as history.
    const resume = resumeFor(effective.providerId, null)
    const result = await runSubagent({
      cwd: args.cwd,
      projectId: args.projectId,
      conversationId: args.conversationId,
      parentMessageId: args.parentMessageId,
      toolCallId: args.toolCallId,
      profile: args.profile,
      definition: effectiveDefinition,
      broker: args.broker,
      signal: args.signal,
      agentName: args.agentName,
      task: resume.task,
      ...(resume.replay ? { replayHistory: resume.replay } : {}),
      progress,
      onTextUpdate,
      messageOwnership: args.parentMessageOwnership,
      readOnly: effectiveReadOnly,
      tools,
      allowSkillLoader: args.mode === 'maestro',
    })
    if (resume.replay) settleResume({ resumed: true })
    return result
  }

  try {
    const result = await withSubagentMessageOwnership({
      conversationId: args.conversationId,
      messageId: args.parentMessageId,
      model: { providerId: effective.providerId, modelId: effective.modelId },
      ownership: args.parentMessageOwnership,
      execute: runProvider,
    })
    recorder?.complete({
      status: result.error ? 'failed' : 'completed',
      usage: result.usage,
      runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
      ...(result.error ? { error: result.error } : {}),
    })
    return result
  } catch (error) {
    recorder?.complete({
      status: args.signal.aborted ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await maestroRuntime?.close()
  }
}
