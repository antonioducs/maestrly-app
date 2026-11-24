/**
 * Host tools that start persistent conversations from natural-language requests, and create or clone the projects
 * they work in. The tools are thin: the runner gives the MAIN tool context a runtime bound to the admitted human turn,
 * and everything else (explicit-intent check for conversations, scope, settings validation, journaling, admission)
 * happens in main-owned services. Child contexts never receive the runtime, and the tool names are parent-only in
 * every child filter.
 */
import { z } from 'zod'
import {
  CONVERSATION_DISPATCH_MAX_PROMPT,
  conversationDispatchBatchSchema,
  type ConversationDispatchBatch,
  type ConversationDispatchBatchResult,
  type ConversationDispatchItemResult,
  type ConversationDispatchModelOption,
  type ConversationDispatchSettings,
  type ConversationDispatchSettingsRequest,
  type ConversationDispatchTask,
  type ConversationDispatchWorkspaceOption,
} from '../../../shared/conversation-dispatch'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import {
  createWorkspaceInputSchema,
  findGithubRepositoriesInputSchema,
  type CreateWorkspaceInput,
  type FindGithubRepositoriesInput,
  type GithubRepositoryOption,
  type WorkspaceCreationResult,
} from '../../../shared/workspace-creation'
import type { ChatQuestion } from '../../../shared/chat'
import {
  assertConversationDispatchGrantCurrent,
  conversationDispatchDenialMessage,
  currentHostTurnOrigin,
  currentHumanTurnOrigin,
  evaluateConversationDispatchGrant,
  evaluateHumanTurnGrant,
  type ConversationDispatchGrant,
} from '../conversation-dispatch-authorization'
import { autonomousPolicy } from '../autonomous'
import { remoteChatPolicy } from '../remote-policy'
import { HOST_CONVERSATION_DISPATCH_GUIDANCE, HOST_WORKSPACE_CREATION_GUIDANCE } from '../harness/host-contracts'
import {
  CONVERSATION_DISPATCH_TOOL_NAMES,
  conversationDispatchToolsAllowed,
  MAESTRO_SWARM_TOOL_NAMES,
} from '../tool-policy'
import { defineTool } from './util'

/** Worker modes that Maestro conversations can dispatch via Agent Pool resources. */
export const MAESTRO_DISPATCH_MODES = ['agent', 'design', 'ask'] as const

type GithubRepositoriesResult = { repositories: GithubRepositoryOption[] } | { error: string }
type AskQuestion = (questions: ChatQuestion[]) => Promise<string[][]>

export interface ConversationDispatchToolRuntime {
  listWorkspaces(): Promise<ConversationDispatchWorkspaceOption[]>
  listModels(): Promise<{ models: ConversationDispatchModelOption[]; current: ConversationDispatchSettings | null }>
  /** `askQuestion` lets the person confirm a request the message did not state explicitly. */
  startConversations(
    batch: ConversationDispatchBatch,
    signal: AbortSignal,
    askQuestion: AskQuestion
  ): Promise<ConversationDispatchBatchResult>
  findGithubRepositories(input: FindGithubRepositoriesInput, signal: AbortSignal): Promise<GithubRepositoriesResult>
  /** `askQuestion` lets the person confirm what cannot be undone, such as publishing a repository. */
  createWorkspace(
    input: CreateWorkspaceInput,
    signal: AbortSignal,
    askQuestion: AskQuestion
  ): Promise<WorkspaceCreationResult>
}

/** Ask the person in the chat before a repository becomes public; a dismissed question cancels. */
async function confirmPublicRepository(askQuestion: AskQuestion, repo: string): Promise<'public' | 'private' | 'cancel'> {
  const { tMain } = await import('../../i18n')
  const t = tMain('main')
  const labels = {
    public: t('workspace.publicRepoConfirm'),
    private: t('workspace.publicRepoPrivate'),
    cancel: t('workspace.publicRepoCancel'),
  }
  const answers = await askQuestion([
    {
      header: t('workspace.publicRepoHeader'),
      question: t('workspace.publicRepoQuestion', { repo }),
      options: [{ label: labels.public }, { label: labels.private }, { label: labels.cancel }],
    },
  ])
  const answer = answers[0]?.[0]
  if (answer === labels.public) return 'public'
  if (answer === labels.private) return 'private'
  return 'cancel'
}

/** Request keys the person confirmed per admitted turn; replays of the same batch do not ask again. */
const confirmedKeys = new WeakMap<object, Set<string>>()

/** Name of a batch destination for the confirmation question; never fails the request. */
async function destinationLabel(workspaceId: string | undefined, thisProject: string): Promise<string> {
  if (!workspaceId) return thisProject
  try {
    const { listConversationDispatchWorkspaces } = await import('../../conversation-dispatch-service')
    const workspaces = await listConversationDispatchWorkspaces()
    return workspaces?.find((workspace) => workspace.workspaceId === workspaceId)?.name ?? workspaceId
  } catch {
    return workspaceId
  }
}

/**
 * Ask the person in the chat to start conversations their message did not ask for in so many words. A dismissed or
 * unavailable question starts nothing.
 */
async function confirmConversationBatch(askQuestion: AskQuestion, batch: ConversationDispatchBatch): Promise<boolean> {
  const { tMain } = await import('../../i18n')
  const t = tMain('main')
  const labels = { start: t('conversationDispatch.confirmStart'), cancel: t('conversationDispatch.confirmCancel') }
  const thisProject = t('conversationDispatch.confirmThisProject')
  const list = await Promise.all(
    batch.tasks.map(async (task) =>
      t('conversationDispatch.confirmItem', {
        title: task.title,
        workspace: await destinationLabel(task.target?.workspaceId ?? batch.target?.workspaceId, thisProject),
      })
    )
  )
  try {
    const answers = await askQuestion([
      {
        header: t('conversationDispatch.confirmHeader'),
        question: t('conversationDispatch.confirmQuestion', {
          count: String(batch.tasks.length),
          list: list.join('\n'),
        }),
        options: [{ label: labels.start }, { label: labels.cancel }],
      },
    ])
    return answers[0]?.[0] === labels.start
  } catch {
    return false
  }
}

/**
 * Why a turn the app ran on its own may not use these tools now, or null when it may: only while the owner keeps the
 * confirmation off (except Maestro, where worker results wake host turns that must dispatch), and never in a
 * conversation an agent created. Read on every call, so the setting applies at once.
 */
async function hostTurnRefusal(conversationId: string, skipConfirmCheck = false): Promise<string | null> {
  const store = await import('../../store')
  if (!skipConfirmCheck && store.getConfirmConversationDispatch()) return conversationDispatchDenialMessage('host-turn')
  if (store.dispatchOriginsFor([conversationId]).has(conversationId))
    return conversationDispatchDenialMessage('agent-created')
  return null
}

/**
 * Runtime for the turn currently admitted in `conversationId`, or undefined when the tools must not be offered:
 * Plan mode and turns run for nobody in this app. Ask receives it too: creating a project is judged by the agent
 * from the conversation, and starting conversations is still checked against the message when it runs. Maestro
 * orchestrators dispatch Agent Pool workers in isolated worktrees with reportBack enabled, including on host turns
 * woken by worker results. A turn the app ran on its own in another conversation gets a runtime that refuses unless
 * the owner turned the confirmation off (see hostTurnRefusal).
 */
export function conversationDispatchRuntimeFor(
  conversationId: string,
  mode: ChatBehavior
): ConversationDispatchToolRuntime | undefined {
  if (!conversationDispatchToolsAllowed(mode)) return undefined
  const origin = currentHumanTurnOrigin(conversationId) ?? currentHostTurnOrigin(conversationId)
  if (!origin) return undefined
  const refusal = () =>
    mode === 'maestro'
      ? hostTurnRefusal(conversationId, true)
      : origin.host
        ? hostTurnRefusal(conversationId)
        : Promise.resolve(null)
  return {
    async listWorkspaces() {
      const refused = await refusal()
      if (refused) throw new Error(refused)
      const { listConversationDispatchWorkspaces } = await import('../../conversation-dispatch-service')
      return listConversationDispatchWorkspaces()
    },
    async listModels() {
      const refused = await refusal()
      if (refused) throw new Error(refused)
      const [service, chat] = await Promise.all([
        import('../../conversation-dispatch-service'),
        import('../service'),
      ])
      return {
        models: await service.listConversationDispatchModels(),
        current: chat.conversationExecutionSettings(conversationId),
      }
    },
    async startConversations(batch, signal, askQuestion) {
      const refused = await refusal()
      if (refused) return { ok: false, error: refused, items: [] }
      if (mode === 'maestro') {
        const turn = evaluateHumanTurnGrant(origin)
        if (!turn.ok) return { ok: false, error: turn.message, items: [] }
        const grant: ConversationDispatchGrant = { ...turn.grant, maxConversations: null }
        const [maestroConfig, maestroSwarm, maestroDispatch, dispatchServiceModule] = await Promise.all([
          import('../maestro-config'),
          import('../maestro-swarm'),
          import('../maestro-swarm-dispatch'),
          import('../../conversation-dispatch-service'),
        ])
        const pool = maestroConfig.getConversationMaestroConfig(conversationId).config.pool
        const failedByIndex = new Map<number, ConversationDispatchItemResult>()
        const validEntries: { task: ConversationDispatchTask; resourceId: string }[] = []

        for (let index = 0; index < batch.tasks.length; index++) {
          const task = batch.tasks[index]
          if (batch.defaults !== undefined || task.settings !== undefined) {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: 'settings are not accepted in Maestro; choose an Agent Pool resource with agent',
            })
            continue
          }
          if (task.placement === 'shared' || batch.placement === 'shared') {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: 'Maestro workers always run in their own worktree',
            })
            continue
          }
          // Workers branch from the orchestrator's HEAD (the feature branch) so their work merges back locally.
          const target = { ...batch.target, ...task.target }
          if (target.workspaceId !== undefined || target.baseBranch !== undefined) {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: "Maestro workers start from this conversation's HEAD; omit target.workspaceId and target.baseBranch",
            })
            continue
          }
          if (!task.agent) {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: 'agent is required in Maestro',
            })
            continue
          }
          const resolved = await maestroDispatch.resolveMaestroDispatchAgent({
            pool,
            agentId: task.agent,
            supportedModes: MAESTRO_DISPATCH_MODES,
            resolve: (requested) => dispatchServiceModule.resolveConversationDispatchSettingsFor(conversationId, requested),
          })
          if (!resolved.ok) {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: resolved.message,
            })
            continue
          }
          const prompt = maestroDispatch.composeMaestroWorkerPrompt({
            instructions: resolved.resource.instructions,
            task: task.prompt,
          })
          if (prompt.length > CONVERSATION_DISPATCH_MAX_PROMPT) {
            failedByIndex.set(index, {
              requestKey: task.requestKey,
              title: task.title,
              status: 'failed',
              error: `Composed worker prompt exceeds the ${CONVERSATION_DISPATCH_MAX_PROMPT}-character limit (${prompt.length} characters).`,
            })
            continue
          }
          const settings: ConversationDispatchSettingsRequest = {
            ...resolved.settings,
            ...(resolved.mode !== 'agent' ? { mode: resolved.mode } : {}),
          }
          const { agent: _agent, settings: _settings, ...rest } = task
          validEntries.push({
            resourceId: resolved.resource.id,
            task: {
              ...rest,
              settings,
              placement: 'worktree',
              reportBack: true,
              prompt,
            },
          })
        }

        if (validEntries.length === 0) {
          return {
            ok: false,
            error: 'No task could be dispatched',
            items: batch.tasks.map((_, index) => failedByIndex.get(index)!),
          }
        }

        maestroSwarm.ensureSwarmTasks(
          conversationId,
          validEntries.map((entry) => ({
            key: entry.task.requestKey,
            title: entry.task.title,
            resourceId: entry.resourceId,
          }))
        )

        const rewrittenBatch: ConversationDispatchBatch = {
          ...(batch.target ? { target: batch.target } : {}),
          placement: 'worktree',
          reportBack: true,
          tasks: validEntries.map((entry) => entry.task),
        }
        const service = await dispatchServiceModule.getConversationDispatchService()
        const serviceResult = await service.dispatchBatch({
          grant,
          batch: rewrittenBatch,
          signal: AbortSignal.any([signal, grant.signal]),
          assertCurrent: () => assertConversationDispatchGrantCurrent(grant),
        })

        const serviceItemByKey = new Map(serviceResult.items.map((item) => [item.requestKey, item]))
        const items: ConversationDispatchItemResult[] = []
        for (let index = 0; index < batch.tasks.length; index++) {
          const failed = failedByIndex.get(index)
          if (failed) {
            items.push(failed)
          } else {
            const item = serviceItemByKey.get(batch.tasks[index].requestKey)
            if (item) items.push(item)
          }
        }
        return { ...serviceResult, items }
      }

      if (batch.tasks.some((task) => task.agent !== undefined)) {
        return { ok: false, error: 'agent is only accepted in Maestro conversations', items: [] }
      }

      const evaluated = evaluateConversationDispatchGrant(origin)
      let grant: ConversationDispatchGrant
      if (evaluated.ok) grant = evaluated.grant
      else {
        // An explicit "do not open conversations" always wins.
        const turn = evaluateHumanTurnGrant(origin)
        if (!turn.ok || evaluated.code === 'negated') return { ok: false, error: evaluated.message, items: [] }
        // Working in a project created for the person in this turn needs no separate request for a conversation:
        // one conversation per created project.
        const { createdWorkspaceIdsForTurn } = await import('../../workspace-creation-service')
        const created = createdWorkspaceIdsForTurn(turn.grant.conversationId, turn.grant.originKey)
        const inCreated = (task: ConversationDispatchBatch['tasks'][number]) => {
          const workspaceId = task.target?.workspaceId ?? batch.target?.workspaceId
          return !!workspaceId && created.includes(workspaceId)
        }
        if (created.length && batch.tasks.every(inCreated)) {
          grant = { ...turn.grant, maxConversations: created.length, onlyWorkspaceIds: created }
        } else {
          // The agent judged that the person wants these conversations, but the message does not say so in a way the
          // host can verify: the person confirms in the chat. Content the agent read can never answer for them.
          // The owner may turn this question off in Settings and trust the agent's judgment instead.
          const { getConfirmConversationDispatch } = await import('../../store')
          const confirmed = confirmedKeys.get(origin.token) ?? new Set<string>()
          if (getConfirmConversationDispatch() && !batch.tasks.every((task) => confirmed.has(task.requestKey))) {
            if (!(await confirmConversationBatch(askQuestion, batch)))
              return { ok: false, error: conversationDispatchDenialMessage('declined'), items: [] }
            for (const task of batch.tasks) confirmed.add(task.requestKey)
            confirmedKeys.set(origin.token, confirmed)
          }
          grant = { ...turn.grant, maxConversations: null }
        }
      }
      const { getConversationDispatchService } = await import('../../conversation-dispatch-service')
      const service = await getConversationDispatchService()
      return service.dispatchBatch({
        grant,
        batch,
        signal: AbortSignal.any([signal, grant.signal]),
        assertCurrent: () => assertConversationDispatchGrantCurrent(grant),
      })
    },
    async findGithubRepositories(input, signal) {
      const refused = await refusal()
      if (refused) return { error: refused }
      const { findGithubRepositoriesForChat } = await import('../../workspace-creation-service')
      return findGithubRepositoriesForChat(input, signal)
    },
    async createWorkspace(input, signal, askQuestion) {
      const refused = await refusal()
      if (refused) return { ok: false, code: 'unavailable', error: refused, requestKey: input.requestKey }
      const evaluated = evaluateHumanTurnGrant(origin)
      if (!evaluated.ok) return { ok: false, code: 'unavailable', error: evaluated.message, requestKey: input.requestKey }
      const grant = evaluated.grant
      const { getWorkspaceCreationService } = await import('../../workspace-creation-service')
      const service = await getWorkspaceCreationService()
      return service.create({
        grant,
        input,
        signal: AbortSignal.any([signal, grant.signal]),
        assertCurrent: () => assertConversationDispatchGrantCurrent(grant),
        confirmPublic: (repo) => confirmPublicRepository(askQuestion, repo),
      })
    },
  }
}

/**
 * Runner helper: in the modes that allow them, add the tool names to the enabled built-ins, and return the runtime to
 * place ONLY in the main tool context when this turn may start conversations.
 *
 * The names do not depend on who started the turn. A native session is resumed only while its tool set holds, so
 * hiding the tools from host-started turns discarded the session on every switch between typed and host turns. Such
 * a turn gets the same names, with a runtime that refuses while the owner keeps the confirmation on (or none at all
 * for a turn run for nobody here), and every tool refuses without it. Unattended executor and remote turns never have
 * a typed origin and stay without the names.
 */
export function enableConversationDispatchTools(
  enabled: Set<string>,
  conversationId: string,
  mode: ChatBehavior
): ConversationDispatchToolRuntime | undefined {
  if (!conversationDispatchToolsAllowed(mode) || autonomousPolicy(conversationId) || remoteChatPolicy(conversationId))
    return undefined
  for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) enabled.add(name)
  if (mode === 'maestro') {
    for (const name of MAESTRO_SWARM_TOOL_NAMES) enabled.add(name)
  }
  return conversationDispatchRuntimeFor(conversationId, mode)
}

const UNAVAILABLE =
  'Starting conversations and creating projects is not available here. It only works in the main agent turn of a ' +
  'standalone or project conversation, started by a message the person typed.'

export const listConversationWorkspacesTool = defineTool<
  z.ZodObject<Record<string, never>>,
  { workspaces: ConversationDispatchWorkspaceOption[] } | { error: string }
>({
  name: 'list_conversation_workspaces',
  description:
    'List registered development workspaces with canonical workspaceId, name, path, defaultBranch and branches. ' +
    'Call before targeting a workspace with start_conversations. Match the requested project to a canonical ID; ' +
    'ask the person when names are ambiguous. Never invent a workspaceId.',
  parameters: z.object({}).strict(),
  execute: async (_args, ctx) => {
    if (!ctx.conversationDispatch) return { error: UNAVAILABLE }
    try {
      return { workspaces: await ctx.conversationDispatch.listWorkspaces() }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})

export const listConversationModelsTool = defineTool<
  z.ZodObject<Record<string, never>>,
  { models: ConversationDispatchModelOption[]; current: ConversationDispatchSettings | null } | { error: string }
>({
  name: 'list_conversation_models',
  description:
    'List the models that new conversations can use (canonical providerId/modelId, supported effort levels and ' +
    'whether Fast mode is available), plus the settings of this conversation that omitted fields inherit. Use it to ' +
    'map what the person said ("Opus", "GPT high", "fast on") before calling start_conversations.',
  parameters: z.object({}).strict(),
  execute: async (_args, ctx) => {
    if (!ctx.conversationDispatch) return { error: UNAVAILABLE }
    try {
      return await ctx.conversationDispatch.listModels()
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})

export const findGithubRepositoriesTool = defineTool<typeof findGithubRepositoriesInputSchema, GithubRepositoriesResult>({
  name: 'find_github_repositories',
  description:
    "Find GitHub repositories with the person's signed-in gh CLI: an exact owner/name, or a name search over the " +
    'repositories of an owner (default: the signed-in account; pass owner for an organization). Read-only. Use it ' +
    'when the person names a repository that is not in list_conversation_workspaces, before create_workspace. Ask ' +
    'the person when several repositories match or none does.',
  parameters: findGithubRepositoriesInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationDispatch) return { error: UNAVAILABLE }
    try {
      return await ctx.conversationDispatch.findGithubRepositories(args, ctx.signal)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})

export const createWorkspaceTool = defineTool<typeof createWorkspaceInputSchema, WorkspaceCreationResult>({
  name: 'create_workspace',
  description: HOST_WORKSPACE_CREATION_GUIDANCE,
  parameters: createWorkspaceInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationDispatch) return { ok: false, code: 'unavailable', error: UNAVAILABLE }
    try {
      return await ctx.conversationDispatch.createWorkspace(args, ctx.signal, ctx.askQuestion)
    } catch (error) {
      return { ok: false, code: 'setup-failed', error: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})

export const startConversationsTool = defineTool<typeof conversationDispatchBatchSchema, ConversationDispatchBatchResult>({
  name: 'start_conversations',
  description: HOST_CONVERSATION_DISPATCH_GUIDANCE,
  parameters: conversationDispatchBatchSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationDispatch) return { ok: false, error: UNAVAILABLE, items: [] }
    try {
      return await ctx.conversationDispatch.startConversations(args, ctx.signal, ctx.askQuestion)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), items: [] }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})
