import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation, getDb } from '../../src/main/store'
import {
  conversationHasMessages,
  findConversationDispatch,
  getConversationDispatch,
  getConversationDispatchByDestination,
  listConversationDispatchRequestKeys,
  listConversationDispatchesInPhases,
  renewDiscardedConversationDispatch,
  reserveConversationDispatch,
  transitionConversationDispatch,
  type NewConversationDispatch,
} from '../../src/main/conversation-dispatch-store'

let workspaceId: string
let sourceId: string

function entry(overrides: Partial<NewConversationDispatch> = {}): NewConversationDispatch {
  return {
    dispatchId: 'dispatch-1',
    sourceConversationId: sourceId,
    originKey: 'message:m1',
    requestKey: 'PROJ-1',
    kind: 'task',
    fingerprint: 'fp-1',
    title: 'PROJ-1',
    prompt: 'Implement PROJ-1',
    placement: 'worktree',
    settings: { providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: false },
    inherited: ['fastMode'],
    sourceRef: { label: 'PROJ-1 · Export', url: 'https://jira.example.test/browse/PROJ-1' },
    workspaceId,
    conversationId: 'destination-1',
    conversationName: 'PROJ-1',
    branch: 'task/proj-1-abcdef12',
    baseRevision: 'a'.repeat(40),
    ...overrides,
  }
}

beforeEach(() => {
  freshDb()
  workspaceId = makeWorkspace().id
  sourceId = makeConversation(workspaceId).id
})

afterEach(() => closeDb())

describe('conversation dispatch journal', () => {
  it('reserves once per (source, origin, request) and round-trips every field', () => {
    const first = reserveConversationDispatch(entry())
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({
      ...entry(),
      phase: 'reserved',
      error: null,
    })
    const second = reserveConversationDispatch(entry({ dispatchId: 'dispatch-2', conversationId: 'destination-2' }))
    expect(second).toMatchObject({ created: false, record: { dispatchId: 'dispatch-1' } })
    expect(findConversationDispatch(sourceId, 'message:m1', 'PROJ-1')?.dispatchId).toBe('dispatch-1')
    // A different origin (a later explicit request) is a new attempt, not a replay.
    expect(reserveConversationDispatch(entry({ dispatchId: 'dispatch-3', originKey: 'message:m2', conversationId: 'destination-3' })).created).toBe(true)
  })

  it('transitions only from the expected phases', () => {
    reserveConversationDispatch(entry())
    expect(transitionConversationDispatch('dispatch-1', ['prepared'], 'starting')).toBe(false)
    expect(transitionConversationDispatch('dispatch-1', ['reserved'], 'allocating')).toBe(true)
    expect(transitionConversationDispatch('dispatch-1', ['allocating'], 'start-failed', 'no-key')).toBe(true)
    expect(getConversationDispatch('dispatch-1')).toMatchObject({ phase: 'start-failed', error: 'no-key' })
    expect(listConversationDispatchesInPhases(['start-failed']).map((item) => item.dispatchId)).toEqual(['dispatch-1'])
  })

  it('renews only a discarded reservation and excludes discarded keys from the consumed count', () => {
    reserveConversationDispatch(entry())
    const next = {
      conversationId: 'destination-2',
      conversationName: 'PROJ-1 retry',
      branch: 'task/proj-1-99999999',
      baseRevision: 'b'.repeat(40),
      settings: { providerId: 'codex', modelId: 'gpt', reasoning: 'off', fastMode: true },
      inherited: [],
      workspaceId,
    }
    expect(renewDiscardedConversationDispatch('dispatch-1', next)).toBe(false)
    expect(listConversationDispatchRequestKeys(sourceId, 'message:m1')).toEqual(['PROJ-1'])
    transitionConversationDispatch('dispatch-1', ['reserved'], 'discarded')
    expect(listConversationDispatchRequestKeys(sourceId, 'message:m1')).toEqual([])
    expect(renewDiscardedConversationDispatch('dispatch-1', next)).toBe(true)
    expect(getConversationDispatch('dispatch-1')).toMatchObject({ ...next, phase: 'reserved', error: null })
  })

  it('tombstones a deleted destination and survives restarts', () => {
    reserveConversationDispatch(entry())
    makeConversation(workspaceId, { id: 'destination-1' })
    transitionConversationDispatch('dispatch-1', ['reserved'], 'started')
    restartDb()
    expect(getConversationDispatchByDestination('destination-1')?.phase).toBe('started')
    deleteConversation('destination-1')
    expect(getConversationDispatch('dispatch-1')?.phase).toBe('deleted')
  })

  it('keeps a discarded record discarded when its destination is removed, and cascades with the source', () => {
    reserveConversationDispatch(entry())
    makeConversation(workspaceId, { id: 'destination-1' })
    transitionConversationDispatch('dispatch-1', ['reserved'], 'discarded')
    deleteConversation('destination-1')
    expect(getConversationDispatch('dispatch-1')?.phase).toBe('discarded')
    deleteConversation(sourceId)
    expect(getConversationDispatch('dispatch-1')).toBeNull()
  })

  it('detects a persisted first message', () => {
    const destination = makeConversation(workspaceId)
    expect(conversationHasMessages(destination.id)).toBe(false)
    getDb()
      .prepare(
        "INSERT INTO chat_messages(id, conversation_id, role, parts_json, seq, created_at) VALUES ('m', ?, 'user', '[]', 0, 1)"
      )
      .run(destination.id)
    expect(conversationHasMessages(destination.id)).toBe(true)
  })
})
