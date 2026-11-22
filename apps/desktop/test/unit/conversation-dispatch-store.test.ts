import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  deleteConversation,
  dispatchOriginsFor,
  getConversation,
  getDb,
  listAllConversations,
  listConversations,
  renameConversation,
  withDispatchOrigin,
} from '../../src/main/store'
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

  it('records whether the source wants the first result back, false by default', () => {
    expect(reserveConversationDispatch(entry()).record.reportBack).toBe(false)
    const wanted = reserveConversationDispatch(
      entry({ dispatchId: 'dispatch-2', requestKey: 'PROJ-2', conversationId: 'destination-2', reportBack: true })
    )
    expect(wanted.record.reportBack).toBe(true)
    restartDb()
    expect(getConversationDispatch('dispatch-2')?.reportBack).toBe(true)
    expect(getConversationDispatch('dispatch-1')?.reportBack).toBe(false)
  })

  it('adds the reportBack column to a journal created before it existed', () => {
    reserveConversationDispatch(entry())
    getDb().exec('ALTER TABLE conversation_dispatches DROP COLUMN report_back')
    restartDb()
    expect(getConversationDispatch('dispatch-1')).toMatchObject({ dispatchId: 'dispatch-1', reportBack: false })
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

describe('conversation dispatch origins', () => {
  it('resolves immediate source and chain root on withDispatchOrigin, listConversations, and listAllConversations without loading on getConversation', () => {
    renameConversation(sourceId, 'FixTest')
    const child = makeConversation(workspaceId, { id: 'child-1', name: 'Child Task' })
    const grandchild = makeConversation(workspaceId, { id: 'grandchild-1', name: 'Subtask' })

    reserveConversationDispatch(
      entry({
        dispatchId: 'd-child',
        sourceConversationId: sourceId,
        requestKey: 'CHILD',
        conversationId: child.id,
        conversationName: 'Child Task',
      })
    )
    reserveConversationDispatch(
      entry({
        dispatchId: 'd-grandchild',
        sourceConversationId: child.id,
        requestKey: 'GRANDCHILD',
        conversationId: grandchild.id,
        conversationName: 'Subtask',
      })
    )

    // Plain getConversation stays a single-row lookup without querying conversation_dispatches.
    expect(getConversation(child.id)?.dispatchOrigin).toBeUndefined()

    expect(withDispatchOrigin(getConversation(sourceId)!).dispatchOrigin).toBeUndefined()
    expect(withDispatchOrigin(getConversation(child.id)!).dispatchOrigin).toEqual({
      sourceConversationId: sourceId,
      sourceName: 'FixTest',
      rootConversationId: sourceId,
      rootName: 'FixTest',
    })
    // Asking only for the grandchild still walks up through the unrequested intermediate child to the root.
    const grandchildOnly = dispatchOriginsFor([grandchild.id])
    expect([...grandchildOnly.keys()]).toEqual([grandchild.id])
    expect(grandchildOnly.get(grandchild.id)).toEqual({
      sourceConversationId: child.id,
      sourceName: 'Child Task',
      rootConversationId: sourceId,
      rootName: 'FixTest',
    })
    expect(withDispatchOrigin(getConversation(grandchild.id)!).dispatchOrigin).toEqual({
      sourceConversationId: child.id,
      sourceName: 'Child Task',
      rootConversationId: sourceId,
      rootName: 'FixTest',
    })

    // Renaming the root or intermediate conversation reflects on subsequent listings.
    renameConversation(sourceId, 'FixTest v2')
    renameConversation(child.id, 'Child Task v2')

    const listed = listConversations(workspaceId)
    expect(listed.find((c) => c.id === grandchild.id)?.dispatchOrigin).toEqual({
      sourceConversationId: child.id,
      sourceName: 'Child Task v2',
      rootConversationId: sourceId,
      rootName: 'FixTest v2',
    })
    const all = listAllConversations()
    expect(all.find((c) => c.id === child.id)?.dispatchOrigin).toEqual({
      sourceConversationId: sourceId,
      sourceName: 'FixTest v2',
      rootConversationId: sourceId,
      rootName: 'FixTest v2',
    })
  })

  it('ignores discarded and deleted dispatches', () => {
    const discarded = makeConversation(workspaceId, { id: 'dest-discarded', name: 'Discarded' })
    const deleted = makeConversation(workspaceId, { id: 'dest-deleted', name: 'Deleted' })

    reserveConversationDispatch(
      entry({
        dispatchId: 'd-discarded',
        requestKey: 'DISC',
        conversationId: discarded.id,
        conversationName: discarded.name,
      })
    )
    transitionConversationDispatch('d-discarded', ['reserved'], 'discarded')

    reserveConversationDispatch(
      entry({
        dispatchId: 'd-deleted',
        requestKey: 'DEL',
        conversationId: deleted.id,
        conversationName: deleted.name,
      })
    )
    getDb().prepare("UPDATE conversation_dispatches SET phase='deleted' WHERE dispatch_id='d-deleted'").run()

    expect(withDispatchOrigin(getConversation(discarded.id)!).dispatchOrigin).toBeUndefined()
    expect(withDispatchOrigin(getConversation(deleted.id)!).dispatchOrigin).toBeUndefined()
    expect(dispatchOriginsFor([discarded.id, deleted.id]).size).toBe(0)
  })

  it('ignores cyclic dispatch chains without looping', () => {
    const a = makeConversation(workspaceId, { id: 'cycle-a', name: 'A' })
    const b = makeConversation(workspaceId, { id: 'cycle-b', name: 'B' })
    const self = makeConversation(workspaceId, { id: 'cycle-self', name: 'Self' })

    reserveConversationDispatch(
      entry({
        dispatchId: 'd-ab',
        sourceConversationId: a.id,
        requestKey: 'AB',
        conversationId: b.id,
        conversationName: 'B',
      })
    )
    reserveConversationDispatch(
      entry({
        dispatchId: 'd-ba',
        sourceConversationId: b.id,
        requestKey: 'BA',
        conversationId: a.id,
        conversationName: 'A',
      })
    )
    reserveConversationDispatch(
      entry({
        dispatchId: 'd-self',
        sourceConversationId: self.id,
        requestKey: 'SELF',
        conversationId: self.id,
        conversationName: 'Self',
      })
    )

    expect(dispatchOriginsFor([a.id, b.id, self.id]).size).toBe(0)
    expect(withDispatchOrigin(getConversation(a.id)!).dispatchOrigin).toBeUndefined()
    expect(withDispatchOrigin(getConversation(b.id)!).dispatchOrigin).toBeUndefined()
    expect(withDispatchOrigin(getConversation(self.id)!).dispatchOrigin).toBeUndefined()
  })

  it('turns the child back into a loose conversation when its origin is deleted via ON DELETE CASCADE', () => {
    const child = makeConversation(workspaceId, { id: 'child-orphan', name: 'Child' })
    reserveConversationDispatch(
      entry({
        dispatchId: 'd-orphan',
        sourceConversationId: sourceId,
        requestKey: 'ORPHAN',
        conversationId: child.id,
        conversationName: child.name,
      })
    )
    expect(withDispatchOrigin(getConversation(child.id)!).dispatchOrigin?.sourceConversationId).toBe(sourceId)

    deleteConversation(sourceId)
    expect(withDispatchOrigin(getConversation(child.id)!).dispatchOrigin).toBeUndefined()
  })
})
