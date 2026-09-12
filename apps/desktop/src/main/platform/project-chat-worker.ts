import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import {
  CHAT_CAPABILITY,
  type ChatInventory,
  type ChatPayload,
  type ProjectChatClaim,
  type ProjectChatInteraction,
  type ProjectChatSession,
} from '@maestrly/protocol'
import { inspectRepositories } from '@maestrly/runner-core'
import { getWorkspace, getConversation, patchConvUiPrefs } from '../store'
import { observeChatHost } from '../chat/host-events'
import { registerRemoteChatPolicy, withRemoteChatPolicy, type RemoteChatPolicy } from '../chat/remote-policy'
import { listMcpServers } from '../chat/mcp'
import { listSkills } from '../chat/skills'
import { isWorkspaceMemoryEnabled } from '../memory/access'
import type { PlatformProjectBinding } from '../../shared/platform'
import type { DesktopModelCatalog } from './desktop-executor'
import type { DesktopExecutorSettings } from './executor-settings'
import type { DesktopProjectChatClient } from './project-chat-client'
import { registerProjectChatContext } from './project-chat-context'
import { ProjectChatProjection, chatPublicId, publicChatText } from './project-chat-projection'
import * as journal from './project-chat-store'

export const chatWorkspaceKey = (b: PlatformProjectBinding) =>
  chatPublicId(b.connectionId + ':' + b.projectId + ':' + b.workspaceId)
export function projectChatPreferences(
  session: Pick<ProjectChatSession, 'mode' | 'reasoning' | 'fastMode' | 'permMode'>,
  settings: DesktopExecutorSettings,
  mcpServerIds: string[]
) {
  return {
    mode: session.mode === 'chat' ? ('ask' as const) : session.mode,
    permMode: session.permMode,
    reasoning: session.reasoning ?? 'off',
    fastMode: session.fastMode,
    tools: {
      app: settings.allowAppTools,
      mcpDisabled: settings.allowMcp ? [] : mcpServerIds,
      imageGen: false,
    },
    skillSelection: { kind: settings.skills ? ('all' as const) : ('none' as const) },
    subagentsEnabled: true,
  }
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const terminalError = (e: unknown) => [401, 403, 404, 409].includes((e as { status?: number }).status ?? 0)
export interface RemoteChatHost {
  start(
    conversationId: string,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ done: Promise<{ status: string; error?: string }>; cancel(): void }>
  decide(conversationId: string, interaction: ProjectChatInteraction): Promise<void>
}
const nativeHost: RemoteChatHost = {
  async start(conversationId, prompt, signal) {
    const { startExecutorChatTurn } = await import('../chat/service')
    return startExecutorChatTurn({ conversationId, prompt, signal, remoteAdmission: true })
  },
  async decide(conversationId, i) {
    const { getChatPermissionBroker, getChatQuestionBroker } = await import('../chat/service')
    if (i.payload.type === 'permission' && i.decision?.type === 'permission') {
      if (
        !getChatPermissionBroker()
          .pendingFor(conversationId)
          .some((p) => p.id === i.payload.requestId)
      )
        throw new Error('Permission no longer belongs to this conversation.')
      getChatPermissionBroker().reply({ requestId: i.payload.requestId, reply: i.decision.reply })
    } else if (i.payload.type === 'question' && i.decision?.type === 'question') {
      if (!getChatQuestionBroker().pendingFor(conversationId).includes(i.payload.requestId))
        throw new Error('Question no longer belongs to this conversation.')
      getChatQuestionBroker().reply(i.payload.requestId, i.decision.answers)
    }
  },
}
export class ProjectChatWorker {
  private stopped = false
  private controller: AbortController | null = null
  constructor(
    private client: DesktopProjectChatClient,
    private catalog: DesktopModelCatalog,
    private settings: DesktopExecutorSettings,
    private bindings: PlatformProjectBinding[],
    private instanceId: string,
    private url: string,
    private host: RemoteChatHost = nativeHost
  ) {}
  async inventory(): Promise<ChatInventory> {
    const workspaces: ChatInventory['workspaces'] = []
    let skills = false,
      memory = false
    for (const binding of this.bindings) {
      const workspace = getWorkspace(binding.workspaceId)
      if (!workspace) continue
      const key = chatWorkspaceKey(binding)
      const [repo] = await inspectRepositories([{ bindingId: key, localPath: workspace.path }])
      if (!repo.available) continue
      const branches = repo.branches.includes(workspace.defaultBranch)
        ? [workspace.defaultBranch, ...repo.branches.filter((b) => b !== workspace.defaultBranch)]
        : repo.branches
      workspaces.push({ projectId: binding.projectId, key, label: workspace.name, branches })
      skills ||= this.settings.skills && (await listSkills(workspace.path)).length > 0
      memory ||= this.settings.allowAppTools && isWorkspaceMemoryEnabled(binding.workspaceId)
    }
    return {
      capability: CHAT_CAPABILITY,
      enabled: !!this.settings.interactiveChat,
      workspaces,
      models: await this.catalog.chatModels(),
      conversationSettings: {
        version: 1,
        // Web project chat is either acting (agent) or read-only (ask); planning/design belong to the desktop.
        modes: ['agent', 'ask'],
        permissionModes: ['ask', 'auto', 'full'],
        operatorLimits: {
          commands: this.settings.allowCommands,
          web: this.settings.allowWeb,
          appTools: this.settings.allowAppTools,
          mcp: this.settings.allowMcp,
          push: this.settings.allowPush,
        },
      },
      integrations: { skills, memory, mcp: this.settings.allowMcp && listMcpServers().some((s) => s.enabled) },
    }
  }
  stop() {
    this.stopped = true
    this.controller?.abort()
  }
  async recover() {
    for (const turn of journal.pendingChatTurns(this.instanceId)) {
      try {
        if (turn.state === 'finishing') await this.flush(turn.turn_id, turn.lease_id)
        await this.client.complete(
          turn.turn_id,
          turn.completion
            ? JSON.parse(turn.completion)
            : {
                leaseId: turn.lease_id,
                state: 'interrupted',
                error: 'Desktop restarted before this turn finished. Continue explicitly.',
              }
        )
        journal.finishLocalChatTurn(turn.turn_id)
      } catch (e) {
        if (terminalError(e)) journal.finishLocalChatTurn(turn.turn_id)
        else throw e
      }
    }
  }
  async run() {
    await this.recover()
    let at = 0
    while (!this.stopped) {
      try {
        await this.recover()
        if (Date.now() - at > 30000) {
          await this.client.inventory(await this.inventory())
          at = Date.now()
        }
        await this.runOnce()
      } catch (e) {
        if (terminalError(e)) throw e
      }
      if (!this.stopped) await pause(500)
    }
  }
  private async flush(turnId: string, leaseId: string) {
    for (let batch = journal.chatOutbox(turnId); batch.length; batch = journal.chatOutbox(turnId)) {
      const result = await this.client.events(turnId, leaseId, batch)
      if (result.accepted.length !== batch.length) throw new Error('Chat upload acknowledgement was incomplete.')
      journal.ackChatEvents(result.accepted)
    }
  }
  private async prepare(claim: ProjectChatClaim) {
    const b = this.bindings.find(
      (b) =>
        b.projectId === claim.session.projectId &&
        b.organizationId === claim.session.organizationId &&
        chatWorkspaceKey(b) === claim.session.workspaceKey
    )
    if (!b) throw new Error('Chat workspace is no longer bound to this executor.')
    let id = journal.chatConversation(this.instanceId, claim.session.id)
    if (id) {
      const conv = getConversation(id)
      if (!conv || conv.workspaceId !== b.workspaceId)
        throw new Error('The conversation workspace is missing. Restore it before continuing.')
      await access(conv.cwd)
    } else {
      const { createConversation } = await import('../workspace-service')
      const branch = 'chat/' + claim.session.id
      const conversation = await createConversation({
        workspaceId: b.workspaceId,
        branch,
        isNewBranch: true,
        base: claim.session.baseBranch,
        mode: 'worktree',
        name: claim.session.title,
      })
      id = conversation.id
      journal.bindChatConversation(this.instanceId, claim.session.id, id)
    }
    const selection = await this.catalog.resolve(claim.session.model)
    if (!this.settings.providerIds.includes(selection.providerId))
      throw new Error('Provider is not enabled for this executor.')
    if (claim.session.reasoning && !selection.reasoningEfforts.includes(claim.session.reasoning))
      throw new Error('The selected reasoning effort is no longer available.')
    if (claim.session.fastMode && !selection.fastMode) throw new Error('Fast mode is no longer available.')
    patchConvUiPrefs(id, {
      chat: projectChatPreferences(
        claim.session,
        this.settings,
        listMcpServers().map((server) => server.id)
      ),
    })
    const { primeChatTurnSelection } = await import('../chat/service')
    primeChatTurnSelection(id, {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: claim.session.reasoning ?? undefined,
      fastMode: claim.session.fastMode,
    })
    return id
  }
  async runOnce(): Promise<boolean> {
    if (this.stopped) return false
    const claim = await this.client.claim()
    if (!claim) return false
    const { turn, session } = claim,
      leaseId = turn.leaseId!
    if (!journal.admitChatTurn(this.instanceId, turn.id, leaseId)) {
      await this.recover()
      return true
    }
    const abort = new AbortController()
    this.controller = abort
    if (this.stopped) abort.abort()
    let leaseDeadline = Date.parse(turn.leaseExpiresAt!)
    let detach = () => {},
      releasePolicy = () => {},
      releaseContext = () => {},
      finished = false,
      failure: Error | undefined
    let pump: Promise<void> | undefined
    let handle: Awaited<ReturnType<RemoteChatHost['start']>> | undefined
    const watchdog = setInterval(() => {
      if (Date.now() >= leaseDeadline) {
        failure = new Error('Chat lease expired.')
        abort.abort()
        handle?.cancel()
      }
    }, 250)
    let pending: ChatPayload[] = []
    const enqueue = (payload: ChatPayload) => {
      // Adjacent text chunks are coalesced; identifiers and durable ordering survive upload retries.
      const last = pending.at(-1)
      if (
        payload.type === 'delta' &&
        last?.type === 'delta' &&
        last.messageId === payload.messageId &&
        last.partId === payload.partId &&
        last.delta.length + payload.delta.length < 32000
      )
        last.delta += payload.delta
      else pending.push(structuredClone(payload))
    }
    const persist = () => {
      for (const payload of pending) journal.queueChatEvent(turn.id, { eventId: randomUUID(), payload })
      pending = []
    }
    try {
      const conversationId = await this.prepare(claim),
        conv = getConversation(conversationId)!
      const policy: RemoteChatPolicy = {
        ...this.settings,
        conversationId,
        cwd: conv.cwd,
        mode: session.mode === 'chat' ? 'ask' : session.mode,
        permMode: session.permMode,
      }
      releasePolicy = registerRemoteChatPolicy(policy)
      releaseContext = registerProjectChatContext(conversationId, {
        url: this.url,
        organizationId: session.organizationId,
        projectId: session.projectId,
        sessionId: session.id,
        turnId: turn.id,
        token: claim.token,
      })
      const projection = new ProjectChatProjection(session.id, turn.id, enqueue)
      detach = observeChatHost(conversationId, (e) => {
        try {
          projection.receive(e)
        } catch (error) {
          failure = error as Error
          abort.abort()
          handle?.cancel()
        }
      })
      let renewed = Date.now(),
        controlsAt = 0
      const handled = new Set<string>()
      pump = (async () => {
        while (!finished) {
          try {
            if (Date.now() >= leaseDeadline) {
              failure = new Error('Chat lease expired.')
              abort.abort()
              handle?.cancel()
              return
            }
            persist()
            await this.flush(turn.id, leaseId)
            if (Date.now() - renewed > 15000) {
              const result = await this.client.renew(turn.id, leaseId)
              renewed = Date.now()
              leaseDeadline = Date.parse(result.leaseExpiresAt)
              if (result.cancellationRequested) {
                abort.abort()
                handle?.cancel()
              }
            }
            if (Date.now() - controlsAt > 200) {
              const controls = await this.client.controls(turn.id, leaseId)
              controlsAt = Date.now()
              if (controls.cancellationRequested) {
                abort.abort()
                handle?.cancel()
              }
              for (const i of controls.interactions) {
                if (handled.has(i.id)) continue
                await withRemoteChatPolicy(policy, () => this.host.decide(conversationId, i))
                handled.add(i.id)
              }
            }
          } catch (error) {
            if (terminalError(error) || Date.now() >= leaseDeadline) {
              failure = error as Error
              abort.abort()
              handle?.cancel()
              return
            }
          }
          await pause(60)
        }
      })()
      let prompt = claim.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      if (!claim.decision) {
        const { clearPlan } = await import('../plan-broker')
        clearPlan(conversationId)
      }
      if (claim.decision) {
        const { interaction, decision } = claim.decision
        if (decision.type === 'plan' && interaction.payload.type === 'plan') {
          const { getPending, decidePlan, clearPlan } = await import('../plan-broker')
          const native = getPending(conversationId)
          if (native && String(native.version) === interaction.payload.requestId) decidePlan(conversationId, decision)
          else clearPlan(conversationId)
          prompt =
            decision.action === 'approve'
              ? 'Implement the final approved plan below. It is inline context, not a file.\n\n' +
                (decision.editedPlan ?? interaction.payload.plan)
              : 'Revise this plan using the feedback.\n\n' +
                interaction.payload.plan +
                '\n\nFeedback:\n' +
                decision.feedback
        }
      }
      const contextText = `You are participating in a persistent Kanban project chat. Project: ${session.projectId}. Board context: ${session.boardId ?? 'all project boards'}. Card context: ${session.cardId ?? 'none'}. Code base: ${session.baseBranch}. Use the scoped board tools to inspect current work, search completed/archived cards and follow card IDs. Use project memory and enabled skills when relevant. Questions, permissions and plan reviews are answered by the person in the web chat. Never assume a completed answer means a card is done.\n\n`
      handle = await withRemoteChatPolicy(policy, () =>
        this.host.start(conversationId, contextText + prompt, abort.signal)
      )
      if (abort.signal.aborted) handle.cancel()
      const result = await handle.done
      finished = true
      await pump
      projection.finish()
      persist()
      await this.flush(turn.id, leaseId)
      const completion = {
        leaseId,
        state: failure
          ? ('failed' as const)
          : abort.signal.aborted || result.status === 'cancelled'
            ? ('cancelled' as const)
            : result.status === 'success'
              ? ('succeeded' as const)
              : ('failed' as const),
        error: failure?.message ?? result.error ?? null,
      }
      journal.recordChatCompletion(turn.id, completion)
      await this.client.complete(turn.id, completion)
      journal.finishLocalChatTurn(turn.id)
    } catch (error) {
      abort.abort()
      handle?.cancel()
      finished = true
      await pump
      // An ACK can be lost after completion committed. Keep the exact recorded outcome for recovery.
      if (journal.pendingChatTurns(this.instanceId).some((t) => t.turn_id === turn.id && t.state === 'finishing'))
        return true
      const completion = {
        leaseId,
        state: abort.signal.aborted && this.stopped ? ('cancelled' as const) : ('failed' as const),
        error: publicChatText((error as Error).message, 7900),
      }
      journal.recordChatCompletion(turn.id, completion)
      try {
        persist()
        await this.flush(turn.id, leaseId)
        await this.client.complete(turn.id, completion)
        journal.finishLocalChatTurn(turn.id)
      } catch (e) {
        if (terminalError(e)) journal.finishLocalChatTurn(turn.id)
      }
    } finally {
      finished = true
      clearInterval(watchdog)
      detach()
      releasePolicy()
      releaseContext()
      this.controller = null
    }
    return true
  }
}
