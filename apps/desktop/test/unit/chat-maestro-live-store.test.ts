import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  bindMaestroLiveAssistantMessage,
  clearMaestroLiveRunsForConversation,
  claimPendingMaestroLiveMessages,
  createMaestroLiveRun,
  finishMaestroLiveRun,
  getActiveMaestroLiveRun,
  getMaestroLiveRun,
  listMaestroLiveMessages,
  markMaestroLiveCheckpointEmbedded,
  postMaestroLiveMessage,
  reconcileInterruptedMaestroLiveRuns,
} from '../../src/main/chat/maestro-live-store'

describe('Maestro live store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists a stable run, ordered messages, and assistant binding', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const run = createMaestroLiveRun({ conversationId: conv.id, startedAt: 10 })
    expect(run.status).toBe('active')
    expect(getActiveMaestroLiveRun(conv.id)?.id).toBe(run.id)

    expect(postMaestroLiveMessage({ runId: run.id, text: 'first', createdAt: 11 }).ok).toBe(true)
    expect(postMaestroLiveMessage({ runId: run.id, text: 'second', createdAt: 12 }).ok).toBe(true)
    expect(listMaestroLiveMessages(run.id).map((message) => [message.seq, message.text])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])

    expect(bindMaestroLiveAssistantMessage(run.id, 'assistant-1')?.assistantMessageId).toBe('assistant-1')
  })

  it('claims each pending message at most once across parallel checkpoints', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const run = createMaestroLiveRun({ conversationId: conv.id })
    postMaestroLiveMessage({ runId: run.id, text: 'one' })
    postMaestroLiveMessage({ runId: run.id, text: 'two' })

    const first = claimPendingMaestroLiveMessages({
      runId: run.id,
      checkpointId: 'delegate-a',
      maxMessages: 8,
      maxBytes: 10_000,
    })
    const second = claimPendingMaestroLiveMessages({
      runId: run.id,
      checkpointId: 'delegate-b',
      maxMessages: 8,
      maxBytes: 10_000,
    })
    expect(first.map((message) => message.text)).toEqual(['one', 'two'])
    expect(second).toEqual([])

    const embedded = markMaestroLiveCheckpointEmbedded(run.id, 'delegate-a', 99)
    expect(embedded.every((message) => message.status === 'embedded' && message.embeddedAt === 99)).toBe(true)
  })

  it('rolls late messages over, cancels aborted messages, and rejects posts after finish', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const completed = createMaestroLiveRun({ conversationId: conv.id })
    postMaestroLiveMessage({ runId: completed.id, text: 'late' })
    finishMaestroLiveRun(completed.id, 'completed')
    expect(listMaestroLiveMessages(completed.id)[0]?.status).toBe('rolled_over')
    expect(postMaestroLiveMessage({ runId: completed.id, text: 'too late' })).toEqual({
      ok: false,
      error: 'run-not-active',
    })

    const aborted = createMaestroLiveRun({ conversationId: conv.id })
    postMaestroLiveMessage({ runId: aborted.id, text: 'cancel me' })
    finishMaestroLiveRun(aborted.id, 'aborted')
    expect(listMaestroLiveMessages(aborted.id)[0]?.status).toBe('cancelled')
  })

  it('recovers active runs as interrupted after restart without losing inbox text', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const run = createMaestroLiveRun({ conversationId: conv.id })
    postMaestroLiveMessage({ runId: run.id, text: 'survive restart' })
    restartDb()

    expect(reconcileInterruptedMaestroLiveRuns(123)).toBe(1)
    expect(getMaestroLiveRun(run.id)).toMatchObject({ status: 'interrupted', finishedAt: 123 })
    expect(listMaestroLiveMessages(run.id)[0]).toMatchObject({ text: 'survive restart', status: 'rolled_over' })
  })

  it('clears sidecar runs and messages with the conversation history', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const run = createMaestroLiveRun({ conversationId: conv.id })
    postMaestroLiveMessage({ runId: run.id, text: 'private update' })
    finishMaestroLiveRun(run.id, 'completed')

    expect(clearMaestroLiveRunsForConversation(conv.id)).toBe(1)
    expect(getMaestroLiveRun(run.id)).toBeNull()
    expect(listMaestroLiveMessages(run.id)).toEqual([])
  })
})
