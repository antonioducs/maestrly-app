import { createHash, randomUUID } from 'node:crypto'
import type {
  BotClaim,
  BotCompletion,
  BotControls,
  BotEventUpload,
  BotInventory,
  BotSelection,
} from '@maestrly/protocol'
import type { ProjectConversation } from '../../shared/conversation'
import type { BotIdentity } from '../../shared/bot'
import type { ChatHostEvent } from '../chat/host-events'
import { BotCommandJournal } from './command-journal'
import { BotConversationProjection, botPublicText, type BotPublicInteraction } from './projection'

export interface BotWorkerClient {
  claim(signal?: AbortSignal): Promise<BotClaim | null>
  lease(claim: BotClaim): Promise<BotControls>
  controls(claim: BotClaim): Promise<BotControls>
  upload(claim: BotClaim, events: BotEventUpload[]): Promise<void>
  complete(claim: BotClaim, result: BotCompletion): Promise<void>
  inventory(value: BotInventory): Promise<void>
}

export interface BotNativeHost {
  /**
   * Take the chat's single execution slot and hold it until the returned function is called.
   *
   * A released chat has two writers, so a bot command waits here for a turn the person started
   * instead of configuring the account, model and permission mode underneath it. The wait ends when
   * the command's signal aborts: a pause, a revocation, an expired lease or Stop.
   */
  acquire?(conversationId: string, signal: AbortSignal): Promise<() => void>
  configure(conversationId: string, selection: BotSelection): Promise<void>
  start(input: {
    conversationId: string
    prompt: string
    identity: BotIdentity
    commandId: string
    selection: BotSelection
    signal: AbortSignal
    assertCurrent(): void
  }): Promise<{ done: Promise<{ status: string; error?: string }>; cancel(): void }>
  observe(conversationId: string, listener: (event: ChatHostEvent) => void): () => void
  answer(conversationId: string, requestId: string, answers: string[][]): void | Promise<void>
  stop(conversationId: string): Promise<void>
}

export interface BotConversationRepository {
  create(
    identity: BotIdentity,
    input: {
      workspaceId: string
      requestId: string
      name: string
      baseBranch: string
      selection: BotSelection
    }
  ): Promise<ProjectConversation>
  find(identity: BotIdentity, remoteConversationId: string): string | null
  resume(identity: BotIdentity, conversationId: string): Promise<ProjectConversation>
  management(conversationId: string): 'active' | 'paused' | 'revoked' | undefined
  setManagement(conversationId: string, state: 'paused' | 'revoked'): void
  rename(conversationId: string, name: string): void
}

export interface BotWorkerOptions {
  instanceId: string
  desktopId: string
  ownerUserId: string
  connectionId: string
  workspaceIds: string[]
  client: BotWorkerClient
  native: BotNativeHost
  conversations: BotConversationRepository
  now?: () => number
}

interface RunningCommand {
  abort: AbortController
  conversationId?: string
  done: Promise<void>
}

function publicId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })

/** No runner engine, board mapping or project chat context participates in this controller. */
export class BotConversationWorker {
  private readonly journal: BotCommandJournal
  private readonly running = new Map<string, RunningCommand>()
  private readonly stopSignal = new AbortController()
  private readonly now: () => number

  constructor(private readonly options: BotWorkerOptions) {
    this.journal = new BotCommandJournal(options.instanceId)
    this.now = options.now ?? Date.now
  }

  async pollOnce(): Promise<boolean> {
    if (this.stopSignal.signal.aborted || this.running.size >= 8) return false
    const claim = await this.options.client.claim(this.stopSignal.signal)
    if (!claim) return false
    this.validateClaim(claim)
    if (this.running.has(claim.command.id)) return false
    const running: RunningCommand = { abort: new AbortController(), done: Promise.resolve() }
    this.running.set(claim.command.id, running)
    running.done = this.execute(claim, running).finally(() => this.running.delete(claim.command.id))
    // The loop keeps polling so question answers and cancellation can arrive during a native turn.
    void running.done.catch(() => {
      /* The durable receipt/outbox is retried on the next claim. */
    })
    return true
  }

  async run(onError: (error: unknown) => void = () => {}): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      try {
        await this.pollOnce()
      } catch (error) {
        if (!this.stopSignal.signal.aborted) onError(error)
      }
      await pause(500, this.stopSignal.signal)
    }
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((command) => command.done))
  }

  interrupt(conversationId: string): void {
    for (const command of this.running.values()) {
      if (command.conversationId === conversationId) command.abort.abort(new Error('Bot management was paused.'))
    }
  }

  async stop(): Promise<void> {
    this.stopSignal.abort()
    for (const command of this.running.values()) command.abort.abort(new Error('Bot connection stopped.'))
    await this.idle()
  }

  private validateClaim(claim: BotClaim): void {
    const { ownerUserId, desktopId, connectionId, workspaceIds } = this.options
    if (
      claim.owner.userId !== ownerUserId ||
      claim.connection.ownerUserId !== ownerUserId ||
      claim.connection.id !== connectionId ||
      claim.connection.desktopId !== desktopId ||
      claim.conversation.desktopId !== desktopId ||
      claim.conversation.connectionId !== connectionId ||
      claim.command.conversationId !== claim.conversation.id ||
      !claim.command.leaseToken ||
      claim.connection.revokedAt ||
      !workspaceIds.includes(claim.conversation.workspaceId)
    )
      throw new Error('The bot command does not belong to this authorized desktop connection.')
    const action =
      claim.command.kind === 'answer'
        ? 'chats:answer'
        : claim.command.kind === 'cancel'
          ? 'chats:control'
          : 'chats:write'
    if (
      !claim.connection.grants.some(
        (grant) => grant.workspaceId === claim.conversation.workspaceId && grant.actions.includes(action)
      )
    )
      throw new Error('The bot workspace grant no longer allows this command.')
  }

  private async execute(claim: BotClaim, running: RunningCommand): Promise<void> {
    const { client, conversations, native } = this.options
    const command = claim.command
    const identity: BotIdentity = {
      instanceId: this.options.instanceId,
      desktopId: this.options.desktopId,
      ownerUserId: claim.owner.userId,
      connectionId: claim.connection.id,
      botName: claim.connection.name,
    }
    let deadline = Date.parse(claim.leaseExpiresAt)
    const assertCurrent = () => {
      if (
        running.abort.signal.aborted ||
        this.stopSignal.signal.aborted ||
        !Number.isFinite(deadline) ||
        this.now() >= deadline
      )
        throw new Error('The bot command lease expired or was interrupted.')
      if (running.conversationId && conversations.management(running.conversationId) !== 'active')
        throw new Error('Bot management is paused or revoked.')
    }
    let pumping = false
    let leaseFailure: unknown
    const check = setInterval(() => {
      if (this.now() >= deadline) running.abort.abort(new Error('Bot command lease expired.'))
    }, 200)
    const heartbeat = setInterval(() => {
      if (pumping || running.abort.signal.aborted) return
      pumping = true
      void (async () => {
        const controls = await client.lease(claim)
        deadline = Date.parse(controls.leaseExpiresAt)
        if (controls.managementState !== 'active' && running.conversationId)
          conversations.setManagement(running.conversationId, controls.managementState)
        if (controls.cancellationRequested || controls.managementState !== 'active') running.abort.abort()
        await this.flush(claim)
      })()
        .catch((error) => {
          leaseFailure = error
          running.abort.abort(error)
        })
        .finally(() => {
          pumping = false
        })
    }, 1_000)
    let detach = () => {}
    let releaseSlot = () => {}
    let projection: BotConversationProjection | undefined
    try {
      if (claim.conversation.managementState !== 'active') throw new Error('Bot management is paused or revoked.')
      assertCurrent()
      const admitted = this.journal.admit(command.id, claim.conversation.id, command.kind, command.payload)
      const previous = this.journal.receipt(command.id)
      const safeCreationRecovery =
        !admitted && command.kind === 'create' && previous?.state === 'admitted' && !previous.nativeStarted
      if (!admitted && !safeCreationRecovery) {
        if (!previous?.result) {
          this.journal.complete(command.id, {
            status: 'failed',
            error:
              'Execution was interrupted after admission. Inspect the native conversation before issuing a new instruction; this command was not replayed.',
          })
        }
        await this.finish(claim)
        return
      }
      const conversation =
        command.kind === 'create'
          ? await conversations.create(identity, {
              workspaceId: claim.conversation.workspaceId,
              requestId: claim.conversation.id,
              name: claim.conversation.name,
              baseBranch: claim.conversation.baseBranch,
              selection: claim.conversation.selection,
            })
          : await conversations.resume(identity, this.requiredConversation(identity, claim.conversation.id))
      running.conversationId = conversation.id
      assertCurrent()
      if (command.kind === 'answer') {
        const questionId = typeof command.payload.questionId === 'string' ? command.payload.questionId : ''
        const requestId = this.journal.question(questionId, conversation.id)
        if (!requestId || !Array.isArray(command.payload.answers))
          throw new Error('The question no longer belongs to this conversation.')
        await native.answer(conversation.id, requestId, command.payload.answers as string[][])
      } else if (command.kind === 'cancel') {
        await native.stop(conversation.id)
      } else {
        const selection =
          command.kind === 'configure' && command.payload.selection && typeof command.payload.selection === 'object'
            ? { ...claim.conversation.selection, ...command.payload.selection }
            : claim.conversation.selection
        // Configuring and starting are one turn: the slot is held across both, and released with it.
        releaseSlot = (await native.acquire?.(conversation.id, running.abort.signal)) ?? releaseSlot
        assertCurrent()
        await native.configure(conversation.id, selection)
        assertCurrent()
        if (command.kind === 'configure' && typeof command.payload.name === 'string')
          conversations.rename(conversation.id, command.payload.name)
        const prompt =
          command.kind === 'send' ? command.payload.text : command.kind === 'create' ? command.payload.message : null
        if (typeof prompt === 'string' && prompt.trim()) {
          projection = new BotConversationProjection((event) => this.project(claim, conversation.id, event))
          detach = native.observe(conversation.id, (event) => {
            try {
              projection?.receive(event)
            } catch (error) {
              leaseFailure = error
              running.abort.abort(error)
            }
          })
          this.journal.markNativeStart(command.id)
          const turn = await native.start({
            conversationId: conversation.id,
            prompt,
            identity,
            commandId: command.id,
            selection,
            signal: running.abort.signal,
            assertCurrent,
          })
          const cancel = () => turn.cancel()
          running.abort.signal.addEventListener('abort', cancel, { once: true })
          if (running.abort.signal.aborted) cancel()
          let outcome: Awaited<typeof turn.done>
          try {
            outcome = await turn.done
          } finally {
            running.abort.signal.removeEventListener('abort', cancel)
          }
          if (outcome.error) throw new Error(outcome.error)
          if (outcome.status === 'cancelled' || running.abort.signal.aborted)
            throw new Error('Bot execution was interrupted.')
          if (!['success', 'succeeded', 'completed', 'done'].includes(outcome.status))
            throw new Error(`Native conversation ended with status ${outcome.status}.`)
        }
      }
      projection?.finish()
      this.journal.complete(command.id, { status: 'succeeded', error: null })
    } catch (error) {
      projection?.finish()
      const reason = leaseFailure ?? error
      this.journal.complete(command.id, {
        status: running.abort.signal.aborted ? 'cancelled' : 'failed',
        error: botPublicText(reason instanceof Error ? reason.message : String(reason), 8_000),
      })
    } finally {
      clearInterval(check)
      clearInterval(heartbeat)
      detach()
      releaseSlot()
    }
    await this.finish(claim)
  }

  private requiredConversation(identity: BotIdentity, remoteId: string): string {
    const id = this.options.conversations.find(identity, remoteId)
    if (!id) throw new Error('The bot conversation is missing on this desktop; it was not recreated.')
    return id
  }

  private project(claim: BotClaim, localConversationId: string, event: Record<string, unknown>): void {
    const { conversation, command } = claim
    let payload: BotEventUpload['payload'] | undefined
    if (event.type === 'message' && typeof event.messageId === 'string' && typeof event.text === 'string') {
      payload = {
        type: 'message',
        message: {
          id: publicId(`${this.options.instanceId}:${conversation.id}:${command.id}:${event.messageId}`),
          conversationId: conversation.id,
          commandId: command.id,
          role: 'assistant',
          parts: [{ id: 'text', type: 'text', text: event.text }],
          createdAt: new Date(this.now()).toISOString(),
        },
      }
    } else if (event.type === 'interaction') {
      const interaction = event.interaction as BotPublicInteraction
      if (interaction.type === 'question' && interaction.questions?.length) {
        const id = publicId(`${this.options.instanceId}:${command.id}:${interaction.requestId}`)
        this.journal.bindQuestion(id, localConversationId, interaction.requestId)
        payload = {
          type: 'question',
          question: {
            id,
            conversationId: conversation.id,
            commandId: command.id,
            questions: interaction.questions,
            state: 'pending',
            answers: null,
            createdAt: new Date(this.now()).toISOString(),
          },
        }
      } else if (interaction.ownerOnly && (interaction.type === 'permission' || interaction.type === 'plan')) {
        payload = { type: 'owner-attention', attention: { kind: interaction.type, title: interaction.title ?? '' } }
      }
      // Owner-only permissions and plans stay on the desktop. The bot cannot answer those gates.
    } else if (event.type === 'owner-attention' && event.attention === null) {
      payload = { type: 'owner-attention', attention: null }
    }
    if (payload) this.journal.enqueue(command.id, randomUUID(), payload)
  }

  private async flush(claim: BotClaim): Promise<void> {
    for (;;) {
      const events = this.journal.outbox(claim.command.id) as BotEventUpload[]
      if (!events.length) return
      await this.options.client.upload(claim, events)
      this.journal.acknowledge(
        claim.command.id,
        events.map((event) => event.eventId)
      )
    }
  }

  private async finish(claim: BotClaim): Promise<void> {
    const receipt = this.journal.receipt(claim.command.id)
    if (!receipt?.result) return
    await this.flush(claim)
    const result = receipt.result
    await this.options.client.complete(claim, {
      leaseToken: claim.command.leaseToken!,
      fence: claim.fence,
      status: result.status as BotCompletion['status'],
      error: typeof result.error === 'string' ? result.error : null,
    })
  }
}
