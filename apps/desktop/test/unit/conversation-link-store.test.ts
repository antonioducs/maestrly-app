import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation } from '../../src/main/store'
import {
  reserveConversationDispatch,
  transitionConversationDispatch,
} from '../../src/main/conversation-dispatch-store'
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
  type NewConversationPeerMessage,
} from '../../src/main/conversation-link-store'

let workspaceId: string
let a: string
let b: string
let c: string

function message(overrides: Partial<NewConversationPeerMessage> = {}): NewConversationPeerMessage {
  return {
    messageId: 'peer-1',
    fromConversationId: a,
    toConversationId: b,
    originKey: 'message:m1',
    dedupeKey: 'dedupe-1',
    kind: 'message',
    body: 'Review the README.',
    hop: 1,
    reportBack: false,
    resultStatus: null,
    ...overrides,
  }
}

function dispatch(source: string, destination: string, phase: 'started' | 'discarded' = 'started'): void {
  reserveConversationDispatch({
    dispatchId: `dispatch-${destination}`,
    sourceConversationId: source,
    originKey: 'message:m0',
    requestKey: destination,
    kind: 'task',
    fingerprint: 'fp',
    title: 'Task',
    prompt: 'Do it',
    placement: 'shared',
    settings: { providerId: 'p', modelId: 'm', reasoning: 'off', fastMode: false },
    inherited: [],
    sourceRef: null,
    workspaceId,
    conversationId: destination,
    conversationName: 'Task',
    branch: null,
    baseRevision: null,
  })
  transitionConversationDispatch(`dispatch-${destination}`, ['reserved'], phase)
}

beforeEach(() => {
  freshDb()
  workspaceId = makeWorkspace().id
  a = makeConversation(workspaceId, { name: 'A' }).id
  b = makeConversation(workspaceId, { name: 'B' }).id
  c = makeConversation(workspaceId, { name: 'C' }).id
})

afterEach(() => closeDb())

describe('conversation peer message journal', () => {
  it('records once per (sender, origin, dedupe key) and round-trips every field', () => {
    const first = reservePeerMessage(message({ reportBack: true }))
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({ ...message({ reportBack: true }), phase: 'queued', error: null })
    const again = reservePeerMessage(message({ messageId: 'peer-2' }))
    expect(again).toMatchObject({ created: false, record: { messageId: 'peer-1' } })
    // A later turn of the sender is a different origin.
    expect(reservePeerMessage(message({ messageId: 'peer-3', originKey: 'message:m2' })).created).toBe(true)
  })

  it('transitions only from the expected phases', () => {
    reservePeerMessage(message())
    expect(transitionPeerMessage('peer-1', ['queued'], 'delivered')).toBe(true)
    expect(transitionPeerMessage('peer-1', ['queued'], 'delivered')).toBe(false)
    expect(transitionPeerMessage('peer-1', ['delivered'], 'failed', 'boom')).toBe(true)
    expect(getPeerMessage('peer-1')).toMatchObject({ phase: 'failed', error: 'boom' })
    expect(transitionPeerMessage('peer-1', [], 'queued')).toBe(false)
  })

  it('queues messages for a target in arrival order', () => {
    reservePeerMessage(message({ messageId: 'first', dedupeKey: '1' }))
    reservePeerMessage(message({ messageId: 'second', dedupeKey: '2', fromConversationId: c }))
    reservePeerMessage(message({ messageId: 'other-target', dedupeKey: '3', toConversationId: c }))
    expect(listQueuedPeerMessagesTo(b).map((record) => record.messageId)).toEqual(['first', 'second'])
    expect(hasQueuedPeerMessage(a, b)).toBe(true)
    expect(hasQueuedPeerMessage(b, a)).toBe(false)
    transitionPeerMessage('first', ['queued'], 'delivered')
    expect(listQueuedPeerMessagesTo(b).map((record) => record.messageId)).toEqual(['second'])
    expect(listPeerMessagesInPhases(['delivered']).map((record) => record.messageId)).toEqual(['first'])
    expect(listPeerMessagesInPhases([])).toEqual([])
  })

  it('relates conversations through dispatches and exchanged messages', () => {
    expect(relationBetween(a, b)).toBeNull()
    dispatch(a, b)
    expect(relationBetween(a, b)).toBe('child')
    expect(relationBetween(b, a)).toBe('source')
    expect(relationBetween(a, a)).toBeNull()

    reservePeerMessage(message({ fromConversationId: a, toConversationId: c }))
    expect(relationBetween(a, c)).toBe('linked')
    expect(relationBetween(c, a)).toBe('linked')
    transitionPeerMessage('peer-1', ['queued'], 'failed', 'target-deleted')
    expect(relationBetween(a, c)).toBeNull()

    // A message to a child does not downgrade the dispatch relation.
    reservePeerMessage(message({ messageId: 'peer-2', dedupeKey: '2', toConversationId: b }))
    expect(conversationRelations(a)).toEqual(new Map([[b, 'child']]))
    expect(conversationRelations(b)).toEqual(new Map([[a, 'source']]))
  })

  it('ignores discarded dispatches', () => {
    dispatch(a, b, 'discarded')
    expect(relationBetween(a, b)).toBeNull()
    expect(conversationRelations(a).size).toBe(0)
  })

  it('names the latest sender of work, ignoring results and failed deliveries', () => {
    expect(latestPeerSender(b)).toBeNull()
    reservePeerMessage(message({ messageId: 'from-a', dedupeKey: '1' }))
    transitionPeerMessage('from-a', ['queued'], 'delivered')
    expect(latestPeerSender(b)).toBe(a)
    reservePeerMessage(message({ messageId: 'failed-from-c', dedupeKey: '2', fromConversationId: c }))
    transitionPeerMessage('failed-from-c', ['queued'], 'failed')
    reservePeerMessage(
      message({ messageId: 'result-from-c', dedupeKey: 'result', fromConversationId: c, kind: 'result', resultStatus: 'success' })
    )
    transitionPeerMessage('result-from-c', ['queued'], 'delivered')
    expect(latestPeerSender(b)).toBe(a)
  })

  it('removes the messages of a deleted conversation and survives restarts', () => {
    reservePeerMessage(message())
    reservePeerMessage(message({ messageId: 'peer-2', dedupeKey: '2', fromConversationId: c, toConversationId: a }))
    restartDb()
    expect(getPeerMessage('peer-1')).toMatchObject({ body: 'Review the README.', phase: 'queued' })
    deleteConversation(b)
    expect(getPeerMessage('peer-1')).toBeNull()
    expect(getPeerMessage('peer-2')).not.toBeNull()
  })
})
