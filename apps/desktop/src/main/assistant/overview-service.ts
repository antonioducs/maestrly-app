import type { FleetActivity, FleetBot, FleetInboxItem } from '@maestrly/bot-fleet-protocol'
import {
  type AssistantOverview,
  botRef,
  hostRef,
  localRef,
  type OverviewBot,
  type OverviewConversation,
  type OverviewHostState,
  type OverviewPending,
  type OverviewPlace,
  type OverviewWorkspace,
  matchesOverviewQuery,
  overviewSummary,
  summarizeOverview,
} from '../../shared/assistant-overview'
import type { Conversation } from '../../shared/conversation'
import type { HostId } from '../../shared/host-key'
import { botRequestKind, botRequestSummary } from '../../shared/inbox-kind'
import type { HostInvoker } from '../remote-host/host-invoker'

export const OVERVIEW_HOST_TIMEOUT_MS = 3_000

interface WorkspaceWithConversations {
  id: string
  name: string
  conversations: Conversation[]
}

export interface LocalPending {
  permissions: Array<{ id: string; toolName: string; title: string; preview?: string }>
  questions: Array<{ toolCallId: string; questions: Array<{ question: string }> }>
}

export interface OverviewFleetClient {
  serverId: string
  serverName: string
  connected: boolean
  snapshot(): { bots: FleetBot[]; inbox: FleetInboxItem[] }
}

export interface OverviewServiceDeps {
  localWorkspaces(): WorkspaceWithConversations[]
  localStandalone(): Conversation[]
  isRunning(conversationId: string): boolean
  pending(conversationId: string): LocalPending
  hasPendingPlan(conversationId: string): boolean
  /** Remote workspaces hosts this computer knows. */
  hosts(): Array<{ id: HostId; label: string; state: string }>
  invokeHost: HostInvoker['invoke']
  fleetClients(): OverviewFleetClient[]
  now(): number
}

/** Item ids `respond_pending` takes: the kind of request and its id where it lives. */
export const pendingItemId = (kind: 'permission' | 'question' | 'help', id: string): string => `${kind}:${id}`

function localPending(deps: OverviewServiceDeps, conversation: Conversation): OverviewPending[] {
  const { permissions, questions } = deps.pending(conversation.id)
  const out: OverviewPending[] = [
    ...questions.map((question) => ({
      itemId: pendingItemId('question', question.toolCallId),
      need: 'question' as const,
      summary: overviewSummary(question.questions[0]?.question),
    })),
    ...permissions.map((permission) => ({
      itemId: pendingItemId('permission', permission.id),
      need: 'approval' as const,
      summary: overviewSummary(permission.preview ? `${permission.title}: ${permission.preview}` : permission.title),
    })),
  ]
  if (deps.hasPendingPlan(conversation.id)) out.push({ itemId: '', need: 'plan', summary: '' })
  return out
}

/** A remote host's conversation only tells what it waits for by its status: answer it in the app. */
function statusPending(conversation: Conversation): OverviewPending[] {
  if (conversation.status === 'asking') return [{ itemId: '', need: 'question', summary: '' }]
  if (conversation.status === 'waiting') return [{ itemId: '', need: 'approval', summary: '' }]
  return []
}

function overviewConversation(
  conversation: Conversation,
  place: OverviewPlace,
  workspaceName: string | null,
  extra: { ref: string; running: boolean; pending: OverviewPending[] }
): OverviewConversation {
  return {
    ref: extra.ref,
    name: conversation.name,
    place,
    workspaceName,
    branch: conversation.scope === 'project' ? conversation.branch : null,
    status: conversation.status,
    running: extra.running,
    pending: extra.pending,
    botCreated: !!conversation.botOrigin,
    lastActivityAt: conversation.lastActivityAt ?? null,
  }
}

export function describeBotActivity(activity: FleetActivity | null): string | null {
  if (!activity) return null
  switch (activity.kind) {
    case 'tool':
      return activity.target ? `${activity.tool} ${activity.target}` : activity.tool
    case 'thinking':
      return 'thinking'
    case 'permission':
      return `waiting for approval: ${activity.title}`
    case 'question':
      return 'asking a question'
    case 'help':
      return `needs help: ${activity.reason}`
    case 'queued':
      return `${activity.count} queued`
    case 'setup':
      return activity.need === 'compaction' ? 'needs a compaction model' : 'needs a model account'
    default:
      return null
  }
}

function botPending(item: FleetInboxItem): OverviewPending {
  const kind = botRequestKind(item)
  const need = kind === 'approval' ? 'approval' : 'question'
  return {
    itemId: pendingItemId(item.interaction.kind, item.interaction.id),
    need,
    summary: overviewSummary(botRequestSummary(item)),
  }
}

export function createOverviewService(deps: OverviewServiceDeps) {
  function local(exclude: string | null) {
    const conversations: OverviewConversation[] = []
    const workspaces: OverviewWorkspace[] = []
    const place: OverviewPlace = { kind: 'local' }
    const add = (conversation: Conversation, workspaceName: string | null) => {
      if (conversation.archived || conversation.id === exclude) return null
      const item = overviewConversation(conversation, place, workspaceName, {
        ref: localRef(conversation.id),
        running: deps.isRunning(conversation.id),
        pending: localPending(deps, conversation),
      })
      conversations.push(item)
      return item
    }
    for (const workspace of deps.localWorkspaces()) {
      const items = workspace.conversations.map((c) => add(c, workspace.name)).filter(Boolean)
      workspaces.push({
        workspaceId: workspace.id,
        name: workspace.name,
        place,
        conversations: items.length,
        running: items.filter((item) => item?.running).length,
      })
    }
    for (const conversation of deps.localStandalone()) add(conversation, null)
    return { conversations, workspaces }
  }

  async function remote(host: { id: HostId; label: string; state: string }) {
    const place: OverviewPlace = { kind: 'host', hostId: host.id, hostName: host.label || host.id }
    if (host.state !== 'online') {
      return { conversations: [], workspaces: [], state: { place, state: 'offline' } as OverviewHostState }
    }
    try {
      const opts = { timeoutMs: OVERVIEW_HOST_TIMEOUT_MS }
      const [workspaceList, standalone] = await Promise.all([
        deps.invokeHost<WorkspaceWithConversations[] | null>(host.id, 'workspace:list', [false], opts),
        deps.invokeHost<Conversation[] | null>(host.id, 'conversation:list-standalone', [false], opts),
      ])
      const conversations: OverviewConversation[] = []
      const workspaces: OverviewWorkspace[] = []
      const add = (conversation: Conversation, workspaceName: string | null) => {
        if (conversation.archived) return null
        const item = overviewConversation(conversation, place, workspaceName, {
          ref: hostRef(host.id, conversation.id),
          running: conversation.status === 'working',
          pending: statusPending(conversation),
        })
        conversations.push(item)
        return item
      }
      for (const workspace of workspaceList ?? []) {
        const items = workspace.conversations.map((c) => add(c, workspace.name)).filter(Boolean)
        workspaces.push({
          workspaceId: workspace.id,
          name: workspace.name,
          place,
          conversations: items.length,
          running: items.filter((item) => item?.running).length,
        })
      }
      for (const conversation of standalone ?? []) add(conversation, null)
      return { conversations, workspaces, state: { place, state: 'online' } as OverviewHostState }
    } catch (error) {
      return {
        conversations: [],
        workspaces: [],
        state: {
          place,
          state: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        } as OverviewHostState,
      }
    }
  }

  function bots(): { bots: OverviewBot[]; hosts: OverviewHostState[] } {
    const out: OverviewBot[] = []
    const hosts: OverviewHostState[] = []
    for (const client of deps.fleetClients()) {
      const place: OverviewPlace = { kind: 'bot-server', serverId: client.serverId, serverName: client.serverName }
      if (!client.connected) {
        hosts.push({ place, state: 'offline' })
        continue
      }
      hosts.push({ place, state: 'online' })
      const snapshot = client.snapshot()
      const inbox = new Map<string, FleetInboxItem[]>()
      for (const item of snapshot.inbox) inbox.set(item.botId, [...(inbox.get(item.botId) ?? []), item])
      for (const bot of snapshot.bots) {
        if (bot.lifecycle === 'archived') continue
        out.push({
          ref: botRef(client.serverId, bot.id),
          name: bot.name,
          role: bot.role || null,
          place,
          status: bot.status,
          activity: describeBotActivity(bot.activity),
          pending: (inbox.get(bot.id) ?? []).map(botPending),
          runningRoutine: bot.runningRun?.title ?? null,
        })
      }
    }
    return { bots: out, hosts }
  }

  return {
    /**
     * The overview, leaving out `exclude` (the assistant's own conversation). A `query` keeps the conversations, bots
     * and workspaces whose name, workspace, host or bot server holds it; every host keeps its state.
     */
    async collect(exclude: string | null = null, opts: { query?: string } = {}): Promise<AssistantOverview> {
      const mine = local(exclude)
      const fleet = bots()
      const remotes = await Promise.all(deps.hosts().map((host) => remote(host)))
      const query = opts.query?.trim() ?? ''
      const keep = <T extends Parameters<typeof matchesOverviewQuery>[0]>(items: T[]) =>
        query ? items.filter((item) => matchesOverviewQuery(item, query)) : items
      return summarizeOverview({
        conversations: keep([...mine.conversations, ...remotes.flatMap((r) => r.conversations)]),
        bots: keep(fleet.bots),
        workspaces: keep([...mine.workspaces, ...remotes.flatMap((r) => r.workspaces)]),
        hosts: [...remotes.map((r) => r.state), ...fleet.hosts],
        now: deps.now(),
      })
    },
  }
}

export type OverviewService = ReturnType<typeof createOverviewService>
