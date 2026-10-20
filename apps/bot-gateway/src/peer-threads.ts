import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_PEER_THREAD_LIMITS,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  fleetInstanceTurns,
  type FleetInputReceipt,
  type FleetInternalPeerMessageRequest,
  type FleetPeerThread,
  type FleetPeerThreadSettings,
  type FleetSendMessageRequest,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store, StoredPeerThread, StoredPeerThreadSide } from './store.js'

const DAY = 86_400_000
const SWEEP_MS = 10 * 60_000
/** Conversations retention deletes in one sweep at most; the others wait for the next one. */
const SWEEP_MAX = 20

/** The thread a send opens: derived from the sender's idempotency key, so a retried send opens the same one. */
export const threadIdFor = (key: string) => {
  const hex = createHash('sha256')
    .update('peer-thread:' + key)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The thread a message goes to: one it continues, or one it opens. */
export interface PreparedThread {
  thread: StoredPeerThread
  opened: boolean
}

/**
 * Conversations between bots in threads of their own (`peer-conversations`). Each thread has a conversation on both
 * sides, apart from each bot's conversation with its owner. A thread pauses once the bots exchanged their `hopLimit`
 * messages in a row without the owner, until the owner writes in it or lets it go on; each bot keeps its side's
 * conversation as its settings say, and what a bot opened from its owner's conversation can bring its answer back there.
 */
export class PeerThreads {
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  /** Conversations being deleted, so a sweep and the owner never delete one twice. */
  private readonly deleting = new Map<string, Promise<FleetPeerThread>>()

  constructor(
    readonly store: Store,
    readonly lifecycle: Lifecycle,
    readonly now: () => number = Date.now,
    readonly sweepMs = SWEEP_MS
  ) {}

  start() {
    this.timer ??= setInterval(() => void this.sweep(), this.sweepMs)
    this.timer.unref()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Whether a bot's Maestrly holds its threads in conversations of their own. */
  isolates(botId: string): boolean {
    return this.lifecycle.statuses.get(botId)?.capabilities.includes(FLEET_PEER_CONVERSATIONS_FEATURE) === true
  }
  settings(botId: string): FleetPeerThreadSettings {
    return this.store.peerSettings(botId) ?? FLEET_PEER_THREAD_SETTINGS_DEFAULT
  }
  saveSettings(botId: string, settings: FleetPeerThreadSettings): FleetPeerThreadSettings {
    this.store.savePeerSettings(botId, settings)
    this.lifecycle.botChanged(botId)
    for (const { thread } of this.store.botPeerThreads(botId, FLEET_PEER_THREAD_LIMITS.listMax)) this.emit(thread)
    return settings
  }

  /**
   * The thread a bot's message goes to, before it is sent: the one it names, which must be between these two bots and
   * not paused, or a new one. A paused thread refuses the message and remembers who was refused.
   */
  prepare(from: string, request: FleetInternalPeerMessageRequest): PreparedThread {
    if (request.thread) {
      const thread = this.store.peerThread(request.thread)
      const members = thread ? [thread.botA, thread.botB] : []
      if (!thread || !members.includes(from) || !members.includes(request.to) || from === request.to)
        throw new GatewayError('FORBIDDEN', 'This conversation is not between you and that bot.')
      if (thread.status === 'paused') {
        if (thread.blockedBot !== from) {
          const next = { ...thread, blockedBot: from }
          this.store.updatePeerThread(next)
          this.emit(next)
        }
        throw new GatewayError(
          'RATE_LIMITED',
          `This conversation with ${this.nameOf(request.to)} is paused until your owner answers.`
        )
      }
      return { thread, opened: false }
    }
    const id = threadIdFor('peer:' + from + ':' + request.idempotencyKey)
    const known = this.store.peerThread(id)
    if (known) return { thread: known, opened: false }
    const at = new Date(this.now()).toISOString()
    const title = (request.topic ?? request.text.replace(/\s+/g, ' ').trim().slice(0, 60)) || 'Conversation'
    return {
      thread: {
        id,
        botA: from,
        botB: request.to,
        title: title.slice(0, FLEET_PEER_THREAD_LIMITS.titleMax),
        hops: 0,
        messages: 0,
        status: 'open',
        blockedBot: null,
        createdAt: at,
        lastActivityAt: at,
      },
      opened: true,
    }
  }

  /**
   * Records a message the thread takes, before it is delivered: a new thread gets its two sides; then the bots'
   * messages in a row grow, and at the bots' limit the thread pauses until the owner answers.
   */
  sent(prepared: PreparedThread, from: string, origin: 'primary' | 'side'): StoredPeerThread {
    const at = new Date(this.now()).toISOString()
    const counted = {
      ...prepared.thread,
      hops: prepared.thread.hops + 1,
      messages: prepared.thread.messages + 1,
      lastActivityAt: at,
    }
    const limit = this.hopLimit(counted.botA, counted.botB)
    const next: StoredPeerThread = counted.hops >= limit ? { ...counted, status: 'paused', blockedBot: null } : counted
    if (prepared.opened) {
      const to = next.botA === from ? next.botB : next.botA
      this.store.insertPeerThread(next, [this.side(next.id, from, origin), this.side(next.id, to, 'peer')])
    } else this.store.updatePeerThread(next)
    if (next.status === 'paused' && prepared.thread.status !== 'paused')
      for (const botId of [next.botA, next.botB])
        this.lifecycle.recordActivity(
          botId,
          'needs_you',
          `Conversation paused after ${limit} messages: ${next.title}`,
          {
            threadId: next.id,
          }
        )
    this.emit(next)
    return next
  }

  /** What delivery tells the receiving bot of the thread, when its Maestrly holds threads apart. */
  delivery(threadId: string | null, to: string): { id: string; title: string } | null {
    if (!threadId || !this.isolates(to)) return null
    const thread = this.store.peerThread(threadId)
    return thread ? { id: thread.id, title: thread.title } : null
  }

  list(botId: string): FleetPeerThread[] {
    return this.store
      .botPeerThreads(botId, FLEET_PEER_THREAD_LIMITS.listMax)
      .map(({ thread, side }) => this.view(thread, side))
  }
  get(botId: string, threadId: string): FleetPeerThread {
    const { thread, side } = this.require(botId, threadId)
    return this.view(thread, side)
  }

  /** The owner keeps a thread, or lets a paused one go on: the bot whose message was refused continues it. */
  async patch(botId: string, threadId: string, patch: { pinned?: boolean; resume?: true }): Promise<FleetPeerThread> {
    let { thread, side } = this.require(botId, threadId)
    if (patch.pinned !== undefined && patch.pinned !== side.pinned) {
      side = { ...side, pinned: patch.pinned }
      this.store.savePeerThreadSide(side)
    }
    if (patch.resume) {
      const target = thread.blockedBot ?? botId
      thread = {
        ...thread,
        hops: 0,
        status: 'open',
        blockedBot: null,
        lastActivityAt: new Date(this.now()).toISOString(),
      }
      this.store.updatePeerThread(thread)
      const other = target === thread.botA ? thread.botB : thread.botA
      if (this.isolates(target))
        await this.lifecycle.instanceFor(target).postInput({
          source: 'continuation',
          text: `Your owner let this conversation with ${this.nameOf(other)} go on for ${this.hopLimit(thread.botA, thread.botB)} more messages. If a message of yours was held back while it was paused, or something is still to settle with ${this.nameOf(other)}, continue it; otherwise end your turn without sending anything.`,
          attachments: [],
          idempotencyKey: randomUUID(),
          thread: { id: thread.id, title: thread.title },
        })
    }
    this.emit(thread)
    return this.view(thread, side)
  }

  /** An owner's message in the bot's conversation of a thread: the bots' messages in a row start again from it. */
  async message(botId: string, threadId: string, input: FleetSendMessageRequest): Promise<FleetInputReceipt> {
    const { thread } = this.requireConversation(botId, threadId)
    const receipt: FleetInputReceipt = await this.lifecycle.instanceFor(botId).postInput({
      source: 'owner',
      text: input.text,
      attachments: input.attachments,
      idempotencyKey: input.idempotencyKey,
      thread: { id: thread.id, title: thread.title },
    })
    // Read again: the thread may have changed while the message was on its way.
    const current = this.store.peerThread(threadId) ?? thread
    const next: StoredPeerThread = {
      ...current,
      hops: 0,
      status: 'open',
      blockedBot: null,
      lastActivityAt: new Date(this.now()).toISOString(),
    }
    this.store.updatePeerThread(next)
    this.emit(next)
    return receipt
  }

  transcript(
    botId: string,
    threadId: string,
    before: string | undefined,
    limit: number,
    reasoning: boolean
  ): Promise<FleetTranscriptPage> {
    this.requireConversation(botId, threadId)
    return this.lifecycle.instanceFor(botId).runTranscript(threadId, before, limit, reasoning)
  }

  /** What a bot brings back to its owner's conversation from a thread it opened there. */
  report(botId: string, threadId: string, text: string): { ok: true } {
    const side = this.store.peerThreadSide(threadId, botId)
    const thread = this.store.peerThread(threadId)
    if (!side || !thread) throw new GatewayError('NOT_FOUND', 'Conversation not found')
    if (side.origin !== 'primary')
      throw new GatewayError('FORBIDDEN', 'Only a conversation opened from your conversation with your owner reports.')
    const next = { ...side, report: text.slice(0, FLEET_PEER_THREAD_LIMITS.reportMax) }
    this.store.savePeerThreadSide({ ...next, reportAt: new Date(this.now()).toISOString() })
    this.emit(thread)
    return { ok: true }
  }

  /** A turn of the thread's conversation ended on one side: the thread was active then. */
  touched(botId: string, threadId: string) {
    const thread = this.store.peerThread(threadId)
    if (!thread || !this.store.peerThreadSide(threadId, botId)) return
    const next = { ...thread, lastActivityAt: new Date(this.now()).toISOString() }
    this.store.updatePeerThread(next)
    this.emit(next)
  }

  /**
   * Deletes the bot's conversation of a thread; what it kept of it (its images and attachments, in a folder of the
   * bot's conversation) stays with its side. Once neither bot has its conversation, the thread goes.
   */
  deleteConversation(botId: string, threadId: string): Promise<FleetPeerThread> {
    const { thread, side } = this.require(botId, threadId)
    if (side.conversation === 'deleted') return Promise.resolve(this.view(thread, side))
    const key = threadId + '\0' + botId
    const pending = this.deleting.get(key)
    if (pending) return pending
    if (this.working(botId, threadId))
      throw new GatewayError('CONFLICT', 'The conversation is still working. Stop it or wait for it to end.')
    const task = (async () => {
      let kept: StoredPeerThreadSide['kept'] = null
      try {
        kept = (await this.lifecycle.instanceFor(botId).deleteRun(threadId)).kept
      } catch (error) {
        // A conversation the bot does not have (never had, or already gave back) is deleted already.
        if (!(error instanceof GatewayError && error.code === 'NOT_FOUND')) throw error
      }
      const current = this.store.peerThreadSide(threadId, botId) ?? side
      const next: StoredPeerThreadSide = {
        ...current,
        conversation: 'deleted',
        conversationDeletedAt: new Date(this.now()).toISOString(),
        kept,
      }
      this.store.savePeerThreadSide(next)
      const latest = this.store.peerThread(threadId) ?? thread
      const view = this.view(latest, next)
      if (this.store.deletePeerThreadIfGone(threadId)) this.removed(latest)
      else this.emit(latest)
      return view
    })()
    this.deleting.set(key, task)
    const clear = () => this.deleting.delete(key)
    task.then(clear, clear)
    return task
  }

  /**
   * Deletes the conversations of the threads whose time is up, as each bot's settings say: never one pinned, one
   * working, or one of a bot kept until deleted. At most `SWEEP_MAX` go each time.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      let budget = SWEEP_MAX
      for (const { thread, side } of this.store.ownPeerThreadSides()) {
        if (budget <= 0) return
        const bot = this.lifecycle.get(side.botId)
        if (bot?.lifecycle !== 'running' || !this.lifecycle.statuses.get(side.botId)?.ready) continue
        const expires = this.expiresAt(thread, side)
        if (!expires || Date.parse(expires) > this.now()) continue
        budget--
        await this.deleteConversation(side.botId, thread.id).catch(() => undefined)
      }
    } finally {
      this.sweeping = false
    }
  }

  /** A thread as one of its bots sees it. */
  view(thread: StoredPeerThread, side: StoredPeerThreadSide): FleetPeerThread {
    const peerId = side.botId === thread.botA ? thread.botB : thread.botA
    return {
      id: thread.id,
      botId: side.botId,
      peer: { botId: peerId, name: this.nameOf(peerId) },
      title: thread.title,
      origin: side.origin,
      status: thread.status,
      hops: thread.hops,
      hopLimit: this.hopLimit(thread.botA, thread.botB),
      messages: thread.messages,
      pinned: side.pinned,
      conversation: side.conversation,
      report: side.report,
      reportAt: side.reportAt,
      working: this.working(side.botId, thread.id),
      peerWorking: this.working(peerId, thread.id),
      createdAt: thread.createdAt,
      lastActivityAt: thread.lastActivityAt,
      expiresAt: this.expiresAt(thread, side),
      conversationDeletedAt: side.conversationDeletedAt,
      kept: side.kept,
    }
  }

  /** The thread's record changed: each of its bots hears of its side. */
  emit(thread: StoredPeerThread) {
    const at = new Date(this.now()).toISOString()
    for (const botId of [thread.botA, thread.botB]) {
      const side = this.store.peerThreadSide(thread.id, botId)
      if (side) this.lifecycle.onEvent({ type: 'peer_thread.updated', at, botId, thread: this.view(thread, side) })
    }
  }

  private removed(thread: StoredPeerThread) {
    const at = new Date(this.now()).toISOString()
    for (const botId of [thread.botA, thread.botB])
      this.lifecycle.onEvent({ type: 'peer_thread.removed', at, botId, threadId: thread.id })
  }
  private expiresAt(thread: StoredPeerThread, side: StoredPeerThreadSide): string | null {
    const days = this.settings(side.botId).retentionDays
    if (side.conversation !== 'own' || side.pinned || days === null || this.working(side.botId, thread.id)) return null
    return new Date(Date.parse(thread.lastActivityAt) + days * DAY).toISOString()
  }
  /** Whether a bot has a turn running in its conversation of the thread. */
  private working(botId: string, threadId: string): boolean {
    const status = this.lifecycle.statuses.get(botId)
    return !!status && fleetInstanceTurns(status).some((turn) => turn.runId === threadId)
  }
  /** The bots' messages in a row a thread takes: the lower of its two bots' limits. */
  private hopLimit(a: string, b: string): number {
    return Math.min(this.settings(a).hopLimit, this.settings(b).hopLimit)
  }
  private nameOf(botId: string): string {
    return this.lifecycle.get(botId)?.name ?? botId
  }
  private side(threadId: string, botId: string, origin: StoredPeerThreadSide['origin']): StoredPeerThreadSide {
    return {
      threadId,
      botId,
      origin,
      pinned: false,
      conversation: 'own',
      conversationDeletedAt: null,
      kept: null,
      report: null,
      reportAt: null,
    }
  }
  private require(botId: string, threadId: string): { thread: StoredPeerThread; side: StoredPeerThreadSide } {
    const thread = this.store.peerThread(threadId)
    const side = thread ? this.store.peerThreadSide(threadId, botId) : null
    if (!thread || !side) throw new GatewayError('NOT_FOUND', 'Conversation not found')
    return { thread, side }
  }
  private requireConversation(botId: string, threadId: string) {
    const found = this.require(botId, threadId)
    if (found.side.conversation !== 'own') throw new GatewayError('NOT_FOUND', 'This conversation was deleted')
    return found
  }
}
