/**
 * Messages between conversations: list, read and wait for other conversations, send them messages, report back to
 * the conversation that gave the work, and bring a final answer back when the sender asked for it.
 *
 * Authorization is decided by the caller's turn provenance (see chat/conversation-link-authorization): a turn the
 * person typed may read any conversation and message any of them (the first message to one not linked to it needs
 * the person's confirmation); a turn started by another conversation only reaches linked conversations, within the
 * hop limit. Every message is journaled first, so a repeated call replays it, a busy target receives it when its
 * turn ends, and queued messages survive a restart. A target never runs two turns at once: one drain per target.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { InternalTurnOutcome } from '../shared/chat'
import type { Conversation } from '../shared/conversation'
import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  CONVERSATION_READ_DEFAULT_MESSAGES,
  CONVERSATION_READ_MAX_TEXT,
  CONVERSATION_RESULT_MAX_BODY,
  CONVERSATION_WAIT_DEFAULT_SECONDS,
  type ConversationLinkError,
  type ConversationLinkErrorCode,
  type ConversationReadResult,
  type ConversationRelation,
  type ConversationSendResult,
  type ConversationSummary,
  type ConversationTranscriptEntry,
  type ConversationTurnResultStatus,
  type ConversationWaitResult,
  type ListConversationsInput,
  type ReadConversationInput,
  type ReportToSourceInput,
  type SendToConversationInput,
  type WaitConversationInput,
} from '../shared/conversation-link'
import type { SequencedChatMessage } from './chat/chat-store'
import { isConversationContextMessage } from './chat/chat-store'
import { hopAllowed } from './chat/conversation-link-authorization'
import type { ConversationPeerTurnInput } from './chat/service'
import { getConversationDispatchByDestination } from './conversation-dispatch-store'
import {
  conversationRelations,
  getPeerMessage,
  hasQueuedPeerMessage,
  latestPeerSender,
  listPeerMessagesInPhases,
  listQueuedPeerMessagesTo,
  relationBetween,
  reservePeerMessage,
  transitionPeerMessage,
  type ConversationPeerMessageRecord,
  type NewConversationPeerMessage,
} from './conversation-link-store'

/** Who is calling: bound to one admitted turn of `conversationId`. */
export interface ConversationLinkCaller {
  conversationId: string
  /** `message:<id of the message that started the turn>`; replays are deduplicated within it. */
  originKey: string
  kind: 'human' | 'linked'
  hop: number
  /** Linked turns: the conversation whose message or dispatch started this turn. */
  peerConversationId: string | null
  /** Linked turns: the sender asked for this turn's final answer. */
  reportBack: boolean
  /** Throws when the turn is no longer the conversation's live turn. */
  assertCurrent(): void
}

export interface ConversationLinkServiceDeps {
  getConversation(id: string): Conversation | undefined
  listConversations(): Conversation[]
  workspaceName(workspaceId: string | null): string | null
  isRunning(conversationId: string): boolean
  startPeerTurn(input: ConversationPeerTurnInput): Promise<{ ok: true } | { ok: false; error: string }>
  waitForSlot(conversationId: string): Promise<void>
  messagesPage(
    conversationId: string,
    opts: { beforeSeq?: number; limit: number }
  ): { messages: SequencedChatMessage[]; hasMore: boolean }
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  /** `prompts` catalog in the app locale. */
  text(key: string, params?: Record<string, string>): string
}

const PAGE = 100
/** Bounds how far back read_conversation looks for text. */
const MAX_SCAN_PAGES = 20
const DRAIN_SETTLE_MS = 250
/** The chat engine or its window is not ready (app start or shutdown): try again later, keep the message queued. */
const UNAVAILABLE_ERRORS = new Set(['chat-unavailable', 'desktop-window-unavailable'])
const UNAVAILABLE_RETRY_MS = 2_000
const UNAVAILABLE_MAX_RETRIES = 30
const WAIT_POLL_MS = 1_000

function fail(code: ConversationLinkErrorCode, error: string): ConversationLinkError {
  return { ok: false, code, error }
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function textOf(message: SequencedChatMessage['message']): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function cut(text: string, max: number): { text: string; truncated?: true } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text }
}

function sha256(...values: string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex')
}

export function createConversationLinkService(deps: ConversationLinkServiceDeps) {
  const draining = new Map<string, Promise<void>>()

  function summarize(conversation: Conversation, relation: ConversationRelation | null): ConversationSummary {
    return {
      conversationId: conversation.id,
      name: conversation.name,
      scope: conversation.scope,
      workspaceId: conversation.workspaceId,
      workspaceName: deps.workspaceName(conversation.workspaceId),
      branch: conversation.scope === 'project' ? conversation.branch : null,
      status: conversation.status,
      running: deps.isRunning(conversation.id),
      archived: !!conversation.archived,
      relation,
      lastActivityAt: conversation.lastActivityAt ?? null,
    }
  }

  /** The target of read/wait: exists, is not the caller, and is linked when the caller's turn is. */
  function readable(
    caller: ConversationLinkCaller,
    conversationId: string
  ): { conversation: Conversation; relation: ConversationRelation | null } | ConversationLinkError {
    if (conversationId === caller.conversationId)
      return fail('self', 'That is this conversation; read your own transcript instead.')
    const conversation = deps.getConversation(conversationId)
    if (!conversation) return fail('not-found', 'No conversation has this conversationId; use list_conversations.')
    const relation = relationBetween(caller.conversationId, conversationId)
    if (caller.kind === 'linked' && !relation)
      return fail(
        'not-linked',
        'Turns not started by the person can only reach linked conversations (the one that started this ' +
          'conversation, conversations started from it, or ones that exchanged messages with it).'
      )
    return { conversation, relation }
  }

  function list(caller: ConversationLinkCaller, input: ListConversationsInput): ConversationSummary[] {
    const relations = conversationRelations(caller.conversationId)
    const words = input.query ? fold(input.query).split(/\s+/).filter(Boolean) : []
    return deps
      .listConversations()
      .filter((conversation) => conversation.id !== caller.conversationId)
      .filter((conversation) => input.includeArchived || !conversation.archived)
      .filter((conversation) => !input.workspaceId || conversation.workspaceId === input.workspaceId)
      .map((conversation) => summarize(conversation, relations.get(conversation.id) ?? null))
      .filter((summary) => caller.kind === 'human' || summary.relation !== null)
      .filter((summary) => {
        if (!words.length) return true
        const haystack = fold(`${summary.name} ${summary.workspaceName ?? ''}`)
        return words.every((word) => haystack.includes(word))
      })
      .sort(
        (a, b) =>
          (a.relation ? 0 : 1) - (b.relation ? 0 : 1) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
      )
      .slice(0, input.limit ?? CONVERSATION_LIST_DEFAULT_LIMIT)
  }

  /**
   * Readable text of a conversation, newest last: tool activity, hidden framing, internal and review-loop messages are
   * omitted. Also finds the latest assistant answer with text unless paging older messages.
   */
  function transcript(conversationId: string, input: { messages: number; beforeSeq?: number }) {
    const entries: ConversationTranscriptEntry[] = []
    let lastReply: ConversationReadResult['lastReply'] = null
    let hasMore = false
    let before = input.beforeSeq
    const wantsReply = input.beforeSeq === undefined
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const { messages, hasMore: older } = deps.messagesPage(conversationId, {
        ...(before !== undefined ? { beforeSeq: before } : {}),
        limit: PAGE,
      })
      for (let index = messages.length - 1; index >= 0; index--) {
        const { seq, message } = messages[index]
        if (message.internal || !isConversationContextMessage(message)) continue
        const text = textOf(message)
        if (!text) continue
        if (wantsReply && !lastReply && message.role === 'assistant')
          lastReply = { seq, ...cut(text, CONVERSATION_RESULT_MAX_BODY) }
        if (entries.length < input.messages)
          entries.unshift({
            seq,
            role: message.role,
            ...(message.peer ? { from: message.peer.fromConversationName } : {}),
            ...cut(text, CONVERSATION_READ_MAX_TEXT),
          })
        else hasMore = true
        if (entries.length >= input.messages && (lastReply || !wantsReply))
          return { entries, lastReply, hasMore: hasMore || index > 0 || older }
      }
      if (!older || !messages.length) return { entries, lastReply, hasMore }
      before = messages[0].seq
    }
    return { entries, lastReply, hasMore: true }
  }

  function read(caller: ConversationLinkCaller, input: ReadConversationInput): ConversationReadResult | ConversationLinkError {
    const target = readable(caller, input.conversationId)
    if ('ok' in target) return target
    const { entries, lastReply, hasMore } = transcript(target.conversation.id, {
      messages: input.messages ?? CONVERSATION_READ_DEFAULT_MESSAGES,
      ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
    })
    return {
      conversation: summarize(target.conversation, target.relation),
      lastReply,
      messages: entries,
      hasMore,
      earliestSeq: entries[0]?.seq ?? null,
    }
  }

  async function wait(
    caller: ConversationLinkCaller,
    input: WaitConversationInput,
    signal: AbortSignal
  ): Promise<ConversationWaitResult> {
    const target = readable(caller, input.conversationId)
    if ('ok' in target) return target
    const id = target.conversation.id
    const deadline = deps.now() + (input.timeoutSeconds ?? CONVERSATION_WAIT_DEFAULT_SECONDS) * 1000
    const busy = () => deps.isRunning(id) || hasQueuedPeerMessage(caller.conversationId, id)
    const result = () => read(caller, { conversationId: id }) as ConversationReadResult
    while (busy()) {
      if (signal.aborted) throw new Error('The wait was cancelled.')
      const remaining = deadline - deps.now()
      if (remaining <= 0) return { ok: true, status: 'timeout', result: result() }
      await Promise.race([deps.waitForSlot(id), deps.sleep(Math.min(WAIT_POLL_MS, remaining), signal)])
    }
    if (signal.aborted) throw new Error('The wait was cancelled.')
    return { ok: true, status: 'idle', result: result() }
  }

  function sent(
    record: ConversationPeerMessageRecord,
    status: 'delivered' | 'queued',
    extra: { replayed?: true; note?: string } = {}
  ): ConversationSendResult {
    return {
      ok: true,
      status,
      conversationId: record.toConversationId,
      conversationName: deps.getConversation(record.toConversationId)?.name ?? record.toConversationId,
      messageId: record.messageId,
      ...extra,
    }
  }

  function replayed(record: ConversationPeerMessageRecord): ConversationSendResult {
    if (record.phase === 'failed')
      return fail('delivery-failed', `This message was already sent in this turn and could not be delivered: ${record.error ?? 'unknown error'}.`)
    return sent(record, record.phase === 'queued' ? 'queued' : 'delivered', { replayed: true })
  }

  function peerInput(record: ConversationPeerMessageRecord): ConversationPeerTurnInput {
    return {
      conversationId: record.toConversationId,
      messageId: record.messageId,
      fromConversationId: record.fromConversationId,
      fromConversationName: deps.getConversation(record.fromConversationId)?.name ?? record.fromConversationId,
      kind: record.kind,
      body: record.body,
      hop: record.hop,
      reportBack: record.reportBack,
      ...(record.resultStatus ? { resultStatus: record.resultStatus } : {}),
      ...(record.kind === 'message' && record.reportBack
        ? { onOutcome: (outcome: InternalTurnOutcome) => void relayPeerResult(record.messageId, outcome) }
        : {}),
    }
  }

  /** One delivery attempt of a queued record. */
  async function attempt(
    record: ConversationPeerMessageRecord
  ): Promise<'delivered' | 'busy' | 'unavailable' | 'failed'> {
    if (!deps.getConversation(record.toConversationId)) {
      transitionPeerMessage(record.messageId, ['queued'], 'failed', 'target-deleted')
      return 'failed'
    }
    let result: { ok: true } | { ok: false; error: string }
    try {
      result = await deps.startPeerTurn(peerInput(record))
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok) {
      transitionPeerMessage(record.messageId, ['queued'], 'delivered')
      return 'delivered'
    }
    if (result.error === 'busy') return 'busy'
    if (UNAVAILABLE_ERRORS.has(result.error)) return 'unavailable'
    transitionPeerMessage(record.messageId, ['queued'], 'failed', result.error)
    return 'failed'
  }

  /** Deliver queued messages to `to` in order, each once its current turn has ended. */
  function enqueue(to: string): void {
    if (draining.has(to)) return
    const run = (async () => {
      try {
        let unavailable = 0
        for (;;) {
          const next = listQueuedPeerMessagesTo(to)[0]
          if (!next) return
          await deps.waitForSlot(to)
          await deps.sleep(DRAIN_SETTLE_MS)
          if ((await attempt(next)) !== 'unavailable') continue
          if (++unavailable > UNAVAILABLE_MAX_RETRIES) return
          await deps.sleep(UNAVAILABLE_RETRY_MS)
        }
      } catch {
        // A failed drain leaves the rest queued; the next send or restart drains them again.
      } finally {
        draining.delete(to)
      }
    })()
    draining.set(to, run)
  }

  /** Try a newly recorded message now, unless older messages are already waiting for the same target. */
  async function deliver(record: ConversationPeerMessageRecord): Promise<ConversationSendResult> {
    const waiting = listQueuedPeerMessagesTo(record.toConversationId)
    if (draining.has(record.toConversationId) || waiting[0]?.messageId !== record.messageId) {
      enqueue(record.toConversationId)
      return sent(record, 'queued', { note: 'The conversation is busy; it receives the message when its turn ends.' })
    }
    const outcome = await attempt(record)
    if (outcome === 'delivered') return sent(record, 'delivered')
    if (outcome === 'busy' || outcome === 'unavailable') {
      enqueue(record.toConversationId)
      return sent(record, 'queued', { note: 'The conversation is busy; it receives the message when its turn ends.' })
    }
    const latest = getPeerMessage(record.messageId)
    return fail('delivery-failed', `Could not deliver the message: ${latest?.error ?? 'unknown error'}.`)
  }

  function guarded(caller: ConversationLinkCaller): ConversationLinkError | null {
    try {
      caller.assertCurrent()
      return null
    } catch (error) {
      return fail('turn-ended', error instanceof Error ? error.message : String(error))
    }
  }

  async function record(value: Omit<NewConversationPeerMessage, 'messageId'>): Promise<ConversationSendResult> {
    const { record: entry, created } = reservePeerMessage({ messageId: randomUUID(), ...value })
    return created ? deliver(entry) : replayed(entry)
  }

  async function send(
    caller: ConversationLinkCaller,
    input: SendToConversationInput,
    confirm: (target: ConversationSummary, preview: string) => Promise<boolean>
  ): Promise<ConversationSendResult> {
    if (input.conversationId === caller.conversationId)
      return fail('self', 'That is this conversation; a message to yourself is not needed.')
    const conversation = deps.getConversation(input.conversationId)
    if (!conversation) return fail('not-found', 'No conversation has this conversationId; use list_conversations.')
    if (conversation.archived)
      return fail('archived', `"${conversation.name}" is archived; ask the person to restore it first.`)
    const relation = relationBetween(caller.conversationId, conversation.id)
    const reportBack = input.reportBack === true
    if (caller.kind === 'linked') {
      if (!relation)
        return fail(
          'not-linked',
          'Turns not started by the person can only message linked conversations (the one that started this ' +
            'conversation, conversations started from it, or ones that exchanged messages with it). Tell the person instead.'
        )
      if (!hopAllowed(caller.hop, 1))
        return fail(
          'hop-limit',
          'Agent-to-agent hop limit reached: conversations cannot keep messaging each other without the person. ' +
            'Finish this turn and let the person continue.'
        )
      if (reportBack && !hopAllowed(caller.hop, 2))
        return fail(
          'hop-limit',
          'Agent-to-agent hop limit reached for bringing a result back: send without reportBack or let the person ' +
            'continue.'
        )
    }
    if (caller.kind === 'human' && !relation) {
      const confirmed = await confirm(summarize(conversation, null), input.message.slice(0, 400)).catch(() => false)
      if (!confirmed) return fail('declined', 'The person declined sending this message. Do not send it or retry.')
    }
    const ended = guarded(caller)
    if (ended) return ended
    return record({
      fromConversationId: caller.conversationId,
      toConversationId: conversation.id,
      originKey: caller.originKey,
      dedupeKey: sha256('message', conversation.id, input.message, String(reportBack)),
      kind: 'message',
      body: input.message,
      hop: caller.hop + 1,
      reportBack,
      resultStatus: null,
    })
  }

  function reportTarget(caller: ConversationLinkCaller): Conversation | null {
    const exists = (id: string | null | undefined) => (id ? (deps.getConversation(id) ?? null) : null)
    if (caller.kind === 'linked') {
      const peer = exists(caller.peerConversationId)
      if (peer) return peer
    }
    const dispatch = getConversationDispatchByDestination(caller.conversationId)
    if (dispatch && dispatch.phase !== 'discarded' && dispatch.phase !== 'deleted') {
      const source = exists(dispatch.sourceConversationId)
      if (source) return source
    }
    return exists(latestPeerSender(caller.conversationId))
  }

  async function report(caller: ConversationLinkCaller, input: ReportToSourceInput): Promise<ConversationSendResult> {
    const target = reportTarget(caller)
    if (!target)
      return fail('no-source', 'No conversation gave this conversation work: there is nobody to report to.')
    if (caller.kind === 'linked' && caller.reportBack && target.id === caller.peerConversationId)
      return {
        ok: true,
        status: 'deferred',
        conversationId: target.id,
        conversationName: target.name,
        note: `Your final answer in this turn is delivered to "${target.name}" automatically; put the report there.`,
      }
    if (caller.kind === 'linked' && !hopAllowed(caller.hop, 1))
      return fail(
        'hop-limit',
        'Agent-to-agent hop limit reached: finish this turn with your answer; the person can pass it on.'
      )
    if (target.archived) return fail('archived', `"${target.name}" is archived; ask the person to restore it first.`)
    const ended = guarded(caller)
    if (ended) return ended
    return record({
      fromConversationId: caller.conversationId,
      toConversationId: target.id,
      originKey: caller.originKey,
      dedupeKey: sha256('report', target.id, input.message),
      kind: 'report',
      body: input.message,
      hop: caller.hop + 1,
      reportBack: false,
      resultStatus: null,
    })
  }

  function latestReplyText(conversationId: string): string | null {
    return transcript(conversationId, { messages: 0 }).lastReply?.text ?? null
  }

  function resultBody(
    outcome: InternalTurnOutcome,
    conversationId: string
  ): { body: string; status: ConversationTurnResultStatus } {
    if (outcome.status === 'success') {
      const text = outcome.summaryText?.trim() || latestReplyText(conversationId)
      if (text) {
        const { text: kept, truncated } = cut(text, CONVERSATION_RESULT_MAX_BODY)
        return { body: truncated ? kept + deps.text('conversationLink.resultTruncated') : kept, status: 'success' }
      }
      return { body: deps.text('conversationLink.resultEmpty', { status: 'success', error: '' }), status: 'success' }
    }
    const error = outcome.status === 'error' ? `; error: ${outcome.error}` : ''
    return { body: deps.text('conversationLink.resultEmpty', { status: outcome.status, error }), status: outcome.status }
  }

  /** Bring the final answer of a turn started by a message back to its sender, once. */
  async function relayPeerResult(messageId: string, outcome: InternalTurnOutcome): Promise<void> {
    const original = getPeerMessage(messageId)
    if (!original || (original.phase !== 'delivered' && original.phase !== 'queued')) return
    if (!deps.getConversation(original.fromConversationId)) return
    const { body, status } = resultBody(outcome, original.toConversationId)
    const { record: result, created } = reservePeerMessage({
      messageId: randomUUID(),
      fromConversationId: original.toConversationId,
      toConversationId: original.fromConversationId,
      originKey: `result:${original.messageId}`,
      dedupeKey: 'result',
      kind: 'result',
      body,
      hop: original.hop + 1,
      reportBack: false,
      resultStatus: status,
    })
    if (!created) return
    transitionPeerMessage(original.messageId, ['queued', 'delivered'], 'reported')
    await deliver(result)
  }

  /** Bring the final answer of a dispatched conversation's first turn back to its source, once. */
  async function relayDispatchResult(input: {
    dispatchId: string
    sourceConversationId: string
    conversationId: string
    outcome: InternalTurnOutcome
  }): Promise<void> {
    if (!deps.getConversation(input.sourceConversationId) || !deps.getConversation(input.conversationId)) return
    const { body, status } = resultBody(input.outcome, input.conversationId)
    const { record: result, created } = reservePeerMessage({
      messageId: randomUUID(),
      fromConversationId: input.conversationId,
      toConversationId: input.sourceConversationId,
      originKey: `dispatch-result:${input.dispatchId}`,
      dedupeKey: 'result',
      kind: 'result',
      body,
      // The person's turn (0) started the seed (1); its result is the next agent turn.
      hop: 2,
      reportBack: false,
      resultStatus: status,
    })
    if (created) await deliver(result)
  }

  /** After a restart: drain queued messages; a result whose turn died with the app is never delivered. */
  async function reconcile(): Promise<void> {
    for (const record of listPeerMessagesInPhases(['delivered']))
      if (record.reportBack) transitionPeerMessage(record.messageId, ['delivered'], 'failed', 'interrupted-before-result')
    const targets = new Set(listPeerMessagesInPhases(['queued']).map((record) => record.toConversationId))
    for (const target of targets) enqueue(target)
  }

  /** Test seam: resolves when every drain in flight has finished. */
  async function idle(): Promise<void> {
    while (draining.size) await Promise.all([...draining.values()])
  }

  return { list, read, wait, send, report, relayDispatchResult, reconcile, idle }
}

export type ConversationLinkService = ReturnType<typeof createConversationLinkService>

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function buildDefaultConversationLinkService(): Promise<ConversationLinkService> {
  const [store, chat, chatStore, i18n] = await Promise.all([
    import('./store'),
    import('./chat/service'),
    import('./chat/chat-store'),
    import('./i18n'),
  ])
  return createConversationLinkService({
    getConversation: store.getConversation,
    listConversations: store.listAllConversations,
    workspaceName: (workspaceId) => (workspaceId ? (store.getWorkspace(workspaceId)?.name ?? null) : null),
    isRunning: chat.isChatConversationRunning,
    startPeerTurn: chat.startConversationPeerTurn,
    waitForSlot: chat.waitForChatConversationSlot,
    messagesPage: (conversationId, opts) =>
      chatStore.listSequencedChatMessagesBefore(conversationId, opts.beforeSeq, opts.limit),
    sleep: abortableSleep,
    now: Date.now,
    text: (key, params) => i18n.tFor(store.getLocale(), 'prompts')(key, params),
  })
}

let instance: Promise<ConversationLinkService> | null = null

export function getConversationLinkService(): Promise<ConversationLinkService> {
  instance ??= buildDefaultConversationLinkService().catch((error) => {
    instance = null
    throw error
  })
  return instance
}
