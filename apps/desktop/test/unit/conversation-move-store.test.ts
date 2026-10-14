import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { assertConversationMigrationMutationAllowed } from '../../src/main/conversation-migration/store'
import {
  activeMoveEndpointForConversation,
  getMoveEndpoint,
  insertMoveEndpoint,
  listActiveMoveEndpoints,
  listTerminalMoveEndpointsBefore,
  updateMoveEndpoint,
} from '../../src/main/conversation-move/endpoint-store'
import {
  advanceMove,
  type ConversationMoveRecord,
  findIncompleteMoveForConversation,
  getMove,
  insertMove,
  listIncompleteMoves,
  markMoveRecoveryRequired,
  patchMoveState,
} from '../../src/main/conversation-move/store'
import { canRollbackMovePhase, type MovePreview } from '../../src/shared/conversation-move'
import { remoteChannelRefusal } from '../../src/shared/host-channels'

const id = '11111111-2222-4333-8444-555555555555'
const REMOTE = 'server-1/env-1'

function record(overrides: Partial<ConversationMoveRecord> = {}): ConversationMoveRecord {
  return {
    id,
    conversationId: 'conv-1',
    conversationName: 'Feature',
    sourceHostId: 'local',
    targetHostId: REMOTE,
    phase: 'prepared',
    status: 'prepared',
    preview: { operationId: id, conversationId: 'conv-1' } as MovePreview,
    selection: { selectedIgnoredPaths: [], confirmedSensitivePaths: [] },
    state: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(freshDb)
afterEach(closeDb)

describe('conversation move journals', () => {
  it('keeps the coordinator channels local and the endpoint channels reachable through the bridge', () => {
    expect(remoteChannelRefusal('conversation-move:prepare')).toBe('local-only')
    expect(remoteChannelRefusal('conversation-move:changed')).toBe('local-only')
    expect(remoteChannelRefusal('conversation-move-endpoint:inspect-source')).toBeNull()
  })

  it('journals a move and advances it with compare-and-set', () => {
    insertMove(record())
    expect(advanceMove(id, 'prepared', { phase: 'freezing', status: 'running' })).toBe(true)
    expect(advanceMove(id, 'prepared', { phase: 'freezing', status: 'running' })).toBe(false)
    patchMoveState(id, { targetWorkspaceId: 'ws-2' })
    patchMoveState(id, { transferIds: ['t1'] })
    expect(getMove(id)).toMatchObject({
      phase: 'freezing',
      status: 'running',
      state: { targetWorkspaceId: 'ws-2', transferIds: ['t1'] },
      preview: { operationId: id },
    })
    expect(listIncompleteMoves().map((move) => move.id)).toEqual([id])
    expect(findIncompleteMoveForConversation('conv-1')?.id).toBe(id)
  })

  it('records a recovery with its code and clears it when the move goes on', () => {
    insertMove(record({ phase: 'importing', status: 'running' }))
    markMoveRecoveryRequired(id, 'Import failed.', 'package-invalid')
    expect(getMove(id)).toMatchObject({
      status: 'recovery-required',
      error: 'Import failed.',
      errorCode: 'package-invalid',
    })
    expect(advanceMove(id, 'importing', { phase: 'importing', status: 'running', error: null })).toBe(true)
    const resumed = getMove(id)!
    expect(resumed.error).toBeUndefined()
    expect(resumed.errorCode).toBeUndefined()
  })

  it('drops terminal moves from the incomplete list', () => {
    for (const [index, status] of (['completed', 'cancelled', 'rolled-back'] as const).entries()) {
      insertMove(
        record({ id: `${id.slice(0, -1)}${index}`, status, phase: status === 'cancelled' ? 'cancelled' : status })
      )
    }
    expect(listIncompleteMoves()).toEqual([])
    expect(findIncompleteMoveForConversation('conv-1')).toBeUndefined()
  })

  it('offers rollback only before the source is released', () => {
    expect(canRollbackMovePhase('verifying')).toBe(true)
    expect(canRollbackMovePhase('releasing-source')).toBe(false)
    expect(canRollbackMovePhase('committing')).toBe(false)
  })

  it('reports only active endpoint journals as blocking', () => {
    insertMoveEndpoint({
      operationId: id,
      role: 'source',
      conversationId: 'conv-1',
      state: 'frozen',
      cwd: '/x',
      data: {},
    })
    expect(activeMoveEndpointForConversation('conv-1')?.state).toBe('frozen')
    expect(listActiveMoveEndpoints()).toHaveLength(1)
    updateMoveEndpoint(id, 'source', { state: 'releasing', data: { a: 1 } })
    updateMoveEndpoint(id, 'source', { data: { b: 2 } })
    expect(activeMoveEndpointForConversation('conv-1')).toBeUndefined()
    expect(getMoveEndpoint(id, 'source')?.data).toEqual({ a: 1, b: 2 })
    expect(getMoveEndpoint(id, 'target')).toBeUndefined()
  })

  it('lists finished endpoint journals by age for sweeping', () => {
    insertMoveEndpoint({
      operationId: id,
      role: 'source',
      conversationId: 'conv-1',
      state: 'released',
      cwd: null,
      data: {},
    })
    insertMoveEndpoint({
      operationId: id,
      role: 'target',
      conversationId: 'conv-1',
      state: 'imported',
      cwd: null,
      data: {},
    })
    expect(listTerminalMoveEndpointsBefore(Date.now() + 1).map((endpoint) => endpoint.role)).toEqual(['source'])
    expect(listTerminalMoveEndpointsBefore(0)).toEqual([])
  })

  it('blocks delete and archive while a move endpoint is active', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id)
    expect(() => assertConversationMigrationMutationAllowed(conv.id, 'Delete conversation')).not.toThrow()
    insertMoveEndpoint({
      operationId: id,
      role: 'source',
      conversationId: conv.id,
      state: 'exported',
      cwd: conv.cwd,
      data: {},
    })
    expect(() => assertConversationMigrationMutationAllowed(conv.id, 'Delete conversation')).toThrow(/being moved/)
    updateMoveEndpoint(id, 'source', { state: 'thawed' })
    expect(() => assertConversationMigrationMutationAllowed(conv.id, 'Archive conversation')).not.toThrow()
  })
})
