import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConversation, getWorkspace, listAllConversations, setConversationArchived } from '../../src/main/store'
import { listSequencedChatMessagesBefore, upsertChatMessage } from '../../src/main/chat/chat-store'
import { reserveConversationDispatch, transitionConversationDispatch } from '../../src/main/conversation-dispatch-store'
import {
  getPeerMessage,
  listPeerMessagesInPhases,
  reservePeerMessage,
  transitionPeerMessage,
} from '../../src/main/conversation-link-store'
import {
  createConversationLinkService,
  type ConversationLinkCaller,
  type ConversationLinkServiceDeps,
} from '../../src/main/conversation-link-service'
import type { ConversationPeerTurnInput } from '../../src/main/chat/service'
import { tFor } from '../../src/shared/i18n'
import type { StoredChatMessage } from '../../src/main/chat/chat-store'

let workspaceId: string
let source: string
let child: string
let other: string
let clock: number

function harness(overrides: Partial<ConversationLinkServiceDeps> = {}) {
  const deps: ConversationLinkServiceDeps = {
    getConversation,
    listConversations: listAllConversations,
    workspaceName: (id) => (id ? (getWorkspace(id)?.name ?? null) : null),
    isRunning: vi.fn(() => false),
    startPeerTurn: vi.fn(async (_input: ConversationPeerTurnInput) => ({ ok: true as const })),
    waitForSlot: vi.fn(async () => undefined),
    messagesPage: (conversationId, opts) => listSequencedChatMessagesBefore(conversationId, opts.beforeSeq, opts.limit),
    sleep: vi.fn(async (ms: number) => {
      clock += ms
    }),
    now: () => clock,
    text: (key, params) => tFor('en', 'prompts')(key, params),
    ...overrides,
  }
  return { deps, service: createConversationLinkService(deps) }
}

function human(conversationId = source, overrides: Partial<ConversationLinkCaller> = {}): ConversationLinkCaller {
  return {
    conversationId,
    originKey: 'message:typed-1',
    kind: 'human',
    hop: 0,
    peerConversationId: null,
    reportBack: false,
    assertCurrent: () => undefined,
    ...overrides,
  }
}

function linked(
  conversationId: string,
  peer: string,
  hop: number,
  overrides: Partial<ConversationLinkCaller> = {}
): ConversationLinkCaller {
  return {
    conversationId,
    originKey: `message:linked-${hop}`,
    kind: 'linked',
    hop,
    peerConversationId: peer,
    reportBack: false,
    assertCurrent: () => undefined,
    ...overrides,
  }
}

function dispatch(from: string, to: string): void {
  reserveConversationDispatch({
    dispatchId: `dispatch-${to}`,
    sourceConversationId: from,
    originKey: 'message:m0',
    requestKey: to,
    kind: 'task',
    fingerprint: 'fp',
    title: 'Review',
    prompt: 'Review it',
    placement: 'shared',
    settings: { providerId: 'p', modelId: 'm', reasoning: 'off', fastMode: false },
    inherited: [],
    sourceRef: null,
    workspaceId,
    conversationId: to,
    conversationName: 'Review',
    branch: null,
    baseRevision: null,
  })
  transitionConversationDispatch(`dispatch-${to}`, ['reserved'], 'started')
}

let messageSeq = 0
function say(conversationId: string, role: 'user' | 'assistant', text: string, extra: Partial<StoredChatMessage> = {}) {
  messageSeq += 1
  upsertChatMessage({
    id: `m-${messageSeq}`,
    conversationId,
    role,
    parts: text ? [{ type: 'text', id: `p-${messageSeq}`, text }] : [],
    createdAt: messageSeq,
    ...extra,
  })
}

const peerCalls = (deps: ConversationLinkServiceDeps) =>
  vi.mocked(deps.startPeerTurn).mock.calls.map(([input]) => input)

beforeEach(() => {
  freshDb()
  clock = 1_000
  workspaceId = makeWorkspace({ name: 'Repo' }).id
  source = makeConversation(workspaceId, { name: 'Source', lastActivityAt: 3 }).id
  child = makeConversation(workspaceId, { name: 'Review', lastActivityAt: 1 }).id
  other = makeConversation(workspaceId, { name: 'Ótimo Other', lastActivityAt: 2 }).id
})

afterEach(() => closeDb())

describe('sending messages', () => {
  it('asks the person before the first message to a conversation that is not linked', async () => {
    const { deps, service } = harness()
    const decline = vi.fn(async () => false)
    expect(await service.send(human(), { conversationId: other, message: 'README changed.' }, decline)).toMatchObject({
      ok: false,
      code: 'declined',
    })
    expect(decline).toHaveBeenCalledWith(expect.objectContaining({ conversationId: other, relation: null }), 'README changed.')
    expect(listPeerMessagesInPhases(['queued', 'delivered', 'failed'])).toEqual([])
    expect(deps.startPeerTurn).not.toHaveBeenCalled()

    const accept = vi.fn(async () => true)
    const result = await service.send(human(), { conversationId: other, message: 'README changed.' }, accept)
    expect(result).toMatchObject({ ok: true, status: 'delivered', conversationId: other, conversationName: 'Ótimo Other' })
    expect(peerCalls(deps)[0]).toMatchObject({
      conversationId: other,
      fromConversationId: source,
      fromConversationName: 'Source',
      kind: 'message',
      body: 'README changed.',
      hop: 1,
      reportBack: false,
    })
    expect(peerCalls(deps)[0].onOutcome).toBeUndefined()
    // Linked now: a later message does not ask again.
    await service.send(human(source, { originKey: 'message:typed-2' }), { conversationId: other, message: 'More.' }, accept)
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('messages a conversation started from this one without asking', async () => {
    dispatch(source, child)
    const { service } = harness()
    const confirm = vi.fn(async () => true)
    expect(await service.send(human(), { conversationId: child, message: 'Fix item 2.' }, confirm)).toMatchObject({
      status: 'delivered',
    })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('refuses unknown, archived and own targets', async () => {
    const { service } = harness()
    const confirm = vi.fn(async () => true)
    expect(await service.send(human(), { conversationId: source, message: 'x' }, confirm)).toMatchObject({ code: 'self' })
    expect(await service.send(human(), { conversationId: 'missing', message: 'x' }, confirm)).toMatchObject({
      code: 'not-found',
    })
    setConversationArchived(other, true)
    expect(await service.send(human(), { conversationId: other, message: 'x' }, confirm)).toMatchObject({
      code: 'archived',
    })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('lets turns started by another conversation reach only linked conversations, within the hop limit', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    const confirm = vi.fn(async () => true)
    expect(await service.send(linked(child, source, 1), { conversationId: other, message: 'x' }, confirm)).toMatchObject({
      code: 'not-linked',
    })
    expect(confirm).not.toHaveBeenCalled()

    expect(await service.send(linked(child, source, 2), { conversationId: source, message: 'Done.' }, confirm)).toMatchObject({
      status: 'delivered',
    })
    expect(peerCalls(deps).at(-1)).toMatchObject({ conversationId: source, hop: 3 })
    expect(await service.send(linked(child, source, 3), { conversationId: source, message: 'Again.' }, confirm)).toMatchObject({
      code: 'hop-limit',
    })
    expect(
      await service.send(linked(child, source, 2), { conversationId: source, message: 'Tell me.', reportBack: true }, confirm)
    ).toMatchObject({ code: 'hop-limit', error: expect.stringMatching(/without reportBack/) })
    expect(
      await service.send(linked(child, source, 1), { conversationId: source, message: 'Tell me.', reportBack: true }, confirm)
    ).toMatchObject({ status: 'delivered' })
  })

  it('records nothing when the turn that asked has ended', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    const ended = human(source, {
      assertCurrent: () => {
        throw new Error('The turn that made this request is no longer active.')
      },
    })
    expect(await service.send(ended, { conversationId: child, message: 'x' }, async () => true)).toMatchObject({
      code: 'turn-ended',
      error: expect.stringMatching(/no longer active/),
    })
    expect(deps.startPeerTurn).not.toHaveBeenCalled()
    expect(listPeerMessagesInPhases(['queued'])).toEqual([])
  })

  it('replays the same message in the same turn instead of delivering it twice', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    const input = { conversationId: child, message: 'Fix item 2.' }
    const first = await service.send(human(), input, async () => true)
    const again = await service.send(human(), input, async () => true)
    expect(again).toMatchObject({ ok: true, status: 'delivered', replayed: true })
    expect(again.ok && first.ok && again.messageId).toBe(first.ok && first.messageId)
    expect(deps.startPeerTurn).toHaveBeenCalledTimes(1)
  })

  it('queues messages for a busy conversation and delivers them in order when its turn ends', async () => {
    dispatch(source, child)
    let release!: () => void
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, service } = harness({ waitForSlot: vi.fn(() => slot) })
    vi.mocked(deps.startPeerTurn).mockResolvedValueOnce({ ok: false, error: 'busy' })
    const first = await service.send(human(), { conversationId: child, message: 'first' }, async () => true)
    const second = await service.send(human(), { conversationId: child, message: 'second' }, async () => true)
    expect(first).toMatchObject({ status: 'queued' })
    expect(second).toMatchObject({ status: 'queued' })
    expect(peerCalls(deps).map((input) => input.body)).toEqual(['first'])
    release()
    await service.idle()
    expect(peerCalls(deps).map((input) => input.body)).toEqual(['first', 'first', 'second'])
    expect(listPeerMessagesInPhases(['delivered']).map((record) => record.body)).toEqual(['first', 'second'])
  })

  it('queues a message for a conversation held by a review until the review lets go', async () => {
    dispatch(source, child)
    let release!: () => void
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, service } = harness({ waitForSlot: vi.fn(() => slot) })
    vi.mocked(deps.startPeerTurn).mockResolvedValueOnce({ ok: false, error: 'review-active' })
    const queued = await service.send(human(), { conversationId: child, message: 'after the review' }, async () => true)
    expect(queued).toMatchObject({ status: 'queued' })
    release()
    await service.idle()
    expect(listPeerMessagesInPhases(['delivered']).map((record) => record.body)).toEqual(['after the review'])
  })

  it('reports a delivery that cannot start and keeps it out of the links', async () => {
    const { deps, service } = harness()
    vi.mocked(deps.startPeerTurn).mockResolvedValueOnce({ ok: false, error: 'executor-active' })
    expect(await service.send(human(), { conversationId: other, message: 'x' }, async () => true)).toMatchObject({
      ok: false,
      code: 'delivery-failed',
      error: expect.stringContaining('executor-active'),
    })
    expect(listPeerMessagesInPhases(['failed'])).toHaveLength(1)
    const confirm = vi.fn(async () => false)
    await service.send(human(source, { originKey: 'message:typed-2' }), { conversationId: other, message: 'y' }, confirm)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('keeps a message queued while the chat engine is not ready', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    vi.mocked(deps.startPeerTurn).mockResolvedValue({ ok: false, error: 'desktop-window-unavailable' })
    expect(await service.send(human(), { conversationId: child, message: 'x' }, async () => true)).toMatchObject({
      status: 'queued',
    })
    await service.idle()
    expect(listPeerMessagesInPhases(['queued'])).toHaveLength(1)
  })
})

describe('bringing results back', () => {
  it('delivers the final answer of a message sent with reportBack once', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    const sent = await service.send(human(), { conversationId: child, message: 'Review it.', reportBack: true }, async () => true)
    expect(sent).toMatchObject({ status: 'delivered' })
    const delivery = peerCalls(deps)[0]
    expect(delivery).toMatchObject({ reportBack: true, hop: 1 })
    delivery.onOutcome!({ status: 'success', assistantMessageId: 'a', summaryText: 'OK' })
    await vi.waitFor(() => expect(deps.startPeerTurn).toHaveBeenCalledTimes(2))
    expect(peerCalls(deps)[1]).toMatchObject({
      conversationId: source,
      fromConversationId: child,
      fromConversationName: 'Review',
      kind: 'result',
      body: 'OK',
      hop: 2,
      resultStatus: 'success',
    })
    expect(getPeerMessage(sent.ok ? sent.messageId! : '')?.phase).toBe('reported')
    delivery.onOutcome!({ status: 'success', assistantMessageId: 'a', summaryText: 'OK again' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deps.startPeerTurn).toHaveBeenCalledTimes(2)
  })

  it('says why there is no answer and falls back to the latest reply', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    await service.send(human(), { conversationId: child, message: 'A', reportBack: true }, async () => true)
    peerCalls(deps)[0].onOutcome!({ status: 'error', error: 'turn-failed', assistantMessageId: null })
    await vi.waitFor(() => expect(deps.startPeerTurn).toHaveBeenCalledTimes(2))
    expect(peerCalls(deps)[1]).toMatchObject({ resultStatus: 'error' })
    expect(peerCalls(deps)[1].body).toMatch(/No final answer/)
    expect(peerCalls(deps)[1].body).toMatch(/turn-failed/)

    say(child, 'assistant', 'Reviewed after the guard.')
    await service.send(human(source, { originKey: 'message:typed-2' }), { conversationId: child, message: 'B', reportBack: true }, async () => true)
    peerCalls(deps)[2].onOutcome!({ status: 'success', assistantMessageId: null })
    await vi.waitFor(() => expect(deps.startPeerTurn).toHaveBeenCalledTimes(4))
    expect(peerCalls(deps)[3].body).toBe('Reviewed after the guard.')
  })

  it('cuts a long answer and says where to read the rest', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    await service.send(human(), { conversationId: child, message: 'A', reportBack: true }, async () => true)
    peerCalls(deps)[0].onOutcome!({ status: 'success', assistantMessageId: 'a', summaryText: 'x'.repeat(25_000) })
    await vi.waitFor(() => expect(deps.startPeerTurn).toHaveBeenCalledTimes(2))
    expect(peerCalls(deps)[1].body).toMatch(/^x{20000}\n\n\[Truncated; read_conversation shows the full reply\.\]$/)
  })

  it('brings a dispatched conversation result back to its source once', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    const relay = () =>
      service.relayDispatchResult({
        dispatchId: `dispatch-${child}`,
        sourceConversationId: source,
        conversationId: child,
        outcome: { status: 'success', assistantMessageId: 'a', summaryText: 'Review: README OK.' },
      })
    await relay()
    await relay()
    expect(peerCalls(deps)).toHaveLength(1)
    expect(peerCalls(deps)[0]).toMatchObject({
      conversationId: source,
      fromConversationId: child,
      kind: 'result',
      body: 'Review: README OK.',
      hop: 2,
    })
  })
})

describe('reporting to the source', () => {
  it('reports to the sender of the current turn, or defers to the automatic result', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    expect(await service.report(linked(child, source, 1), { message: 'Fixed item 2.' })).toMatchObject({
      ok: true,
      status: 'delivered',
      conversationId: source,
    })
    expect(peerCalls(deps)[0]).toMatchObject({ conversationId: source, kind: 'report', hop: 2, reportBack: false })

    const deferred = await service.report(linked(child, source, 1, { reportBack: true, originKey: 'message:x' }), {
      message: 'Done.',
    })
    expect(deferred).toMatchObject({ ok: true, status: 'deferred', conversationId: source })
    expect(deps.startPeerTurn).toHaveBeenCalledTimes(1)
    expect(await service.report(linked(child, source, 3), { message: 'Late.' })).toMatchObject({ code: 'hop-limit' })
  })

  it('reports from a typed turn to the conversation that started this one or last sent work', async () => {
    dispatch(source, child)
    const { deps, service } = harness()
    expect(await service.report(human(child), { message: 'Status.' })).toMatchObject({ conversationId: source })

    reservePeerMessage({
      messageId: 'from-source',
      fromConversationId: source,
      toConversationId: other,
      originKey: 'message:m',
      dedupeKey: 'd',
      kind: 'message',
      body: 'Do it.',
      hop: 1,
      reportBack: false,
      resultStatus: null,
    })
    transitionPeerMessage('from-source', ['queued'], 'delivered')
    expect(await service.report(human(other), { message: 'Done.' })).toMatchObject({ conversationId: source })
    expect(peerCalls(deps).map((input) => input.hop)).toEqual([1, 1])

    // A report hands over work too: the latest one the source received came from `other`.
    expect(await service.report(human(source), { message: 'Back.' })).toMatchObject({ conversationId: other })
    const lonely = makeConversation(workspaceId, { name: 'Lonely' }).id
    expect(await service.report(human(lonely), { message: 'Nobody.' })).toMatchObject({ code: 'no-source' })
  })
})

describe('reading conversations', () => {
  it('returns the latest answer and recent text, omitting internal, review-loop and tool-only messages', async () => {
    dispatch(source, child)
    const { service } = harness()
    say(child, 'user', 'Review the README.')
    say(child, 'assistant', 'Looking.')
    say(child, 'assistant', '', {
      parts: [{ type: 'tool', id: 't', toolCallId: 't', toolName: 'read', input: {}, state: { status: 'running' } }],
    })
    say(child, 'user', 'Hidden plan', { internal: true })
    say(child, 'assistant', 'Loop work', {
      executionScope: { kind: 'review-loop', executionId: 'e', loopId: 'l', iteration: 1, maxIterations: 2 },
    })
    say(child, 'user', 'Fix item 2.', {
      source: 'conversation-message',
      peer: { messageId: 'pm', fromConversationId: source, fromConversationName: 'Source', kind: 'message' },
    })
    say(child, 'assistant', 'y'.repeat(5_000))

    const result = await service.read(human(), { conversationId: child })
    if ('ok' in result) throw new Error(result.error)
    expect(result.conversation).toMatchObject({ conversationId: child, name: 'Review', relation: 'child', workspaceName: 'Repo' })
    expect(result.messages.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(result.messages[2]).toMatchObject({ text: 'Fix item 2.', from: 'Source' })
    expect(result.messages[3]).toMatchObject({ truncated: true })
    expect(result.messages[3].text).toHaveLength(4_000)
    expect(result.lastReply?.text).toHaveLength(5_000)
    expect(result.hasMore).toBe(false)

    const older = await service.read(human(), { conversationId: child, messages: 1, beforeSeq: result.messages[2].seq })
    if ('ok' in older) throw new Error(older.error)
    expect(older.messages.map((entry) => entry.text)).toEqual(['Looking.'])
    expect(older.lastReply).toBeNull()
    expect(older.hasMore).toBe(true)
  })

  it('keeps turns started by another conversation to linked conversations', async () => {
    dispatch(source, child)
    const { service } = harness()
    expect(await service.read(linked(child, source, 1), { conversationId: other })).toMatchObject({ code: 'not-linked' })
    expect(await service.read(linked(child, source, 1), { conversationId: source })).toMatchObject({
      conversation: { relation: 'source' },
    })
    expect(await service.read(human(), { conversationId: other })).toMatchObject({ conversation: { relation: null } })
  })

  it('lists conversations with their relation, filtered by name and access', () => {
    dispatch(source, child)
    const archived = makeConversation(workspaceId, { name: 'Old' }).id
    setConversationArchived(archived, true)
    const { service } = harness()
    const all = service.list(human(), {})
    expect(all.map((item) => [item.name, item.relation])).toEqual([
      ['Review', 'child'],
      ['Ótimo Other', null],
    ])
    expect(service.list(human(), { includeArchived: true }).map((item) => item.name)).toContain('Old')
    expect(service.list(human(), { query: 'otimo' }).map((item) => item.name)).toEqual(['Ótimo Other'])
    expect(service.list(human(), { query: 'REPO review' }).map((item) => item.name)).toEqual(['Review'])
    expect(service.list(linked(child, source, 1), {}).map((item) => [item.name, item.relation])).toEqual([
      ['Source', 'source'],
    ])
    expect(service.list(human(), { limit: 1 })).toHaveLength(1)
  })
})

describe('waiting for a conversation', () => {
  it('returns once the turn and the queued messages are done', async () => {
    dispatch(source, child)
    let running = true
    const { service } = harness({
      isRunning: vi.fn(() => running),
      waitForSlot: vi.fn(async () => {
        running = false
      }),
    })
    say(child, 'assistant', 'Done.')
    const result = await service.wait(human(), { conversationId: child }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, status: 'idle', result: { lastReply: { text: 'Done.' } } })
  })

  it('times out with what is there so far, and stops when cancelled', async () => {
    dispatch(source, child)
    const { service } = harness({ isRunning: vi.fn(() => true), waitForSlot: vi.fn(() => new Promise<void>(() => undefined)) })
    expect(
      await service.wait(human(), { conversationId: child, timeoutSeconds: 5 }, new AbortController().signal)
    ).toMatchObject({ ok: true, status: 'timeout', result: { conversation: { running: true } } })
    const controller = new AbortController()
    controller.abort()
    await expect(service.wait(human(), { conversationId: child }, controller.signal)).rejects.toThrow(/cancelled/)
    expect(
      await service.wait(linked(child, source, 1), { conversationId: other }, new AbortController().signal)
    ).toMatchObject({ code: 'not-linked' })
  })
})

describe('restart', () => {
  it('delivers queued messages and drops results whose turn died with the app', async () => {
    dispatch(source, child)
    const base = {
      fromConversationId: source,
      toConversationId: child,
      originKey: 'message:m',
      kind: 'message' as const,
      hop: 1,
      resultStatus: null,
    }
    reservePeerMessage({ ...base, messageId: 'queued', dedupeKey: 'q', body: 'Queued.', reportBack: false })
    reservePeerMessage({ ...base, messageId: 'waiting', dedupeKey: 'w', body: 'Waiting.', reportBack: true })
    transitionPeerMessage('waiting', ['queued'], 'delivered')
    const { deps, service } = harness()
    await service.reconcile()
    await service.idle()
    expect(getPeerMessage('queued')?.phase).toBe('delivered')
    expect(getPeerMessage('waiting')).toMatchObject({ phase: 'failed', error: 'interrupted-before-result' })
    expect(peerCalls(deps).map((input) => input.body)).toEqual(['Queued.'])
  })

  it('fails queued messages for a deleted target', async () => {
    dispatch(source, child)
    reservePeerMessage({
      messageId: 'orphan',
      fromConversationId: source,
      toConversationId: child,
      originKey: 'message:m',
      dedupeKey: 'o',
      kind: 'message',
      body: 'x',
      hop: 1,
      reportBack: false,
      resultStatus: null,
    })
    const { deps, service } = harness({ getConversation: (id) => (id === child ? undefined : getConversation(id)) })
    await service.reconcile()
    await service.idle()
    expect(getPeerMessage('orphan')).toMatchObject({ phase: 'failed', error: 'target-deleted' })
    expect(deps.startPeerTurn).not.toHaveBeenCalled()
  })
})
