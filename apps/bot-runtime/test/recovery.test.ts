import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Journal } from '../src/control/journal.js'
import { FileService } from '../src/files/service.js'
import { FixtureProvider } from '../src/providers/fixture.js'
import { recoverTurns } from '../src/turns/recovery.js'
import { TurnService } from '../src/turns/service.js'
import { snapshot, temporary } from './helpers.js'
describe('turn durability', () => {
  it('reconciles known identities, hashes oversized message bodies, preserves provider threads', async () => {
    const state = await temporary()
    const journal = new Journal(state)
    const input = snapshot({ message: 'x'.repeat(5000) })
    journal.accept(input)
    journal.status(input.turnId, 1, { status: 'running', providerThreadId: 'thread' })
    journal.saveThread(input.conversationId, 'thread')
    journal.nextGeneration()
    const reopened = new Journal(state)
    expect(reopened.reconcile(input.turnId, 1)).toMatchObject({
      known: true,
      status: 'running',
      providerThreadId: 'thread',
    })
    expect(reopened.reconcile(input.turnId, 2)).toEqual({ known: false })
    expect(reopened.thread(input.conversationId)).toBe('thread')
    expect(reopened.lastGeneration()).toBe(1)
    expect(await readFile(join(state, 'journal.jsonl'), 'utf8')).not.toContain('x'.repeat(5000))
  })
  it('recovers running and accepted turns without rerunning and queues interruption', async () => {
    const state = await temporary()
    const journal = new Journal(state)
    const input = snapshot()
    journal.accept(input)
    journal.status(input.turnId, 1, { status: 'running' })
    const restarted = new Journal(state)
    recoverTurns(restarted)
    expect(restarted.reconcile(input.turnId, 1)).toMatchObject({ status: 'interrupted' })
    expect(restarted.pendingEvents()[0].detail).toMatchObject({ error: { code: 'RUNTIME_RESTARTED' } })
    recoverTurns(restarted)
    expect(restarted.pendingEvents()).toHaveLength(1)
  })
  it('accepts duplicate starts once and expires a lease', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const provider = new FixtureProvider(files.workspace)
    const spy = vi.spyOn(provider, 'startTurn')
    const turns = new TurnService(journal, provider, files)
    const input = snapshot({ message: '#slow', leaseMs: 80 })
    expect(turns.start(input)).toEqual({ accepted: true })
    expect(turns.start(input)).toEqual({ accepted: true, duplicate: true })
    await turns.idle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(turns.reconcile(input.turnId, 1)).toMatchObject({ status: 'interrupted' })
    expect(journal.pendingEvents().at(-1)?.detail).toMatchObject({ error: { code: 'LEASE_EXPIRED' } })
    await turns.close()
  })
  it('persists approval intent before resolution and rejects stale actions', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const turns = new TurnService(journal, new FixtureProvider(files.workspace), files)
    const input = snapshot({ message: '#approve #ask' })
    turns.start(input)
    await vi.waitFor(() =>
      expect(journal.pendingEvents().some((event) => event.kind === 'approval.requested')).toBe(true)
    )
    const actionId = String(
      journal.pendingEvents().find((event) => event.kind === 'approval.requested')?.detail?.actionId
    )
    expect(turns.resolve({ turnId: input.turnId, generation: 1, actionId, decision: 'approve' })).toEqual({
      applied: true,
    })
    expect(() => turns.resolve({ turnId: input.turnId, generation: 1, actionId, decision: 'approve' })).toThrow(
      'Unknown'
    )
    await vi.waitFor(() => expect(journal.pendingEvents().some((event) => event.kind === 'question.asked')).toBe(true))
    const question = String(journal.pendingEvents().find((event) => event.kind === 'question.asked')?.detail?.actionId)
    turns.resolve({ turnId: input.turnId, generation: 1, actionId: question, decision: 'answer', answer: '42' })
    await turns.idle()
    expect(await readFile(join(files.workspace, 'approved.txt'), 'utf8')).toBe('')
    expect(journal.pendingEvents().find((event) => event.kind === 'assistant.message')?.detail?.content).toContain('42')
    await turns.close()
  })
  it('compacts acknowledged events while keeping pending events and turn state', async () => {
    const state = await temporary()
    const journal = new Journal(state)
    const input = snapshot()
    journal.accept(input)
    const event = journal.event({ kind: 'diagnostic', summary: 'acknowledged' })
    journal.ack(event.runtimeEventId)
    const pending = journal.event({ kind: 'diagnostic', summary: 'pending' })
    journal.compact()
    const reopened = new Journal(state)
    expect(reopened.pendingEvents()).toEqual([pending])
    expect(reopened.reconcile(input.turnId, 1).known).toBe(true)
  })
})

describe('turn limits and cancellation', () => {
  it('renews leases and emits cancelled only after explicit cancellation finishes', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const turns = new TurnService(journal, new FixtureProvider(files.workspace), files)
    const input = snapshot({ message: '#slow', leaseMs: 1000 })
    turns.start(input)
    expect(turns.lease(input.turnId, 1, 2000)).toEqual({ renewed: true })
    await vi.waitFor(() => expect(turns.reconcile(input.turnId, 1).status).toBe('running'))
    expect(await turns.cancel(input.turnId, 1)).toEqual({ cancelled: true })
    expect(journal.pendingEvents().at(-1)?.detail?.status).toBe('cancelled')
    expect(await turns.cancel(input.turnId, 2)).toEqual({ cancelled: false })
  })
  it('enforces active time and invalidates approvals on expiry', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const turns = new TurnService(journal, new FixtureProvider(files.workspace), files)
    const input = snapshot({ message: '#approve', limits: { activeMs: 50, maxTools: 10, maxLogBytes: 10000 } })
    turns.start(input)
    await turns.idle()
    expect(journal.pendingEvents().at(-1)?.detail).toMatchObject({
      status: 'interrupted',
      error: { code: 'TIME_LIMIT' },
    })
    const actionId = String(
      journal.pendingEvents().find((event) => event.kind === 'approval.requested')?.detail?.actionId
    )
    expect(() => turns.resolve({ turnId: input.turnId, generation: 1, actionId, decision: 'approve' })).toThrow(
      'Unknown'
    )
  })
  it('aggregates deltas and suppresses diagnostics past the log budget while retaining final status', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const turns = new TurnService(journal, new FixtureProvider(files.workspace), files)
    const input = snapshot({ message: 'x'.repeat(100), limits: { activeMs: 1000, maxTools: 10, maxLogBytes: 100000 } })
    turns.start(input)
    await turns.idle()
    expect(journal.pendingEvents().filter((event) => event.kind === 'assistant.delta')).toHaveLength(1)
    const quiet = snapshot({ limits: { activeMs: 1000, maxTools: 10, maxLogBytes: 1 } })
    turns.start(quiet)
    await turns.idle()
    expect(
      journal.pendingEvents().filter((event) => event.turnId === quiet.turnId && event.kind === 'assistant.delta')
    ).toHaveLength(0)
    expect(turns.reconcile(quiet.turnId, 1).status).toBe('succeeded')
  })
  it('stops at the tool budget and deduplicates produced files', async () => {
    const root = await temporary()
    const journal = new Journal(join(root, 'state'))
    const files = new FileService(join(root, 'workspace'))
    const provider = new FixtureProvider(files.workspace)
    const turns = new TurnService(journal, provider, files)
    turns.start(snapshot({ message: '#write:hello.txt' }))
    await turns.idle()
    expect(journal.pendingEvents().filter((event) => event.kind === 'file.produced')).toHaveLength(1)
    vi.spyOn(provider, 'startTurn').mockImplementation(async (_snapshot, hooks) => {
      hooks.emit({ kind: 'tool.started', summary: 'one' })
      hooks.emit({ kind: 'tool.started', summary: 'two' })
      return { status: 'succeeded' }
    })
    const input = snapshot({ limits: { activeMs: 1000, maxTools: 1, maxLogBytes: 10000 } })
    turns.start(input)
    await turns.idle()
    expect(journal.pendingEvents().at(-1)?.detail).toMatchObject({
      status: 'interrupted',
      error: { code: 'TOOL_LIMIT' },
    })
  })
})

it('recovers a terminal status persisted in the outbox before the status append', async () => {
  const state = await temporary()
  const journal = new Journal(state)
  const input = snapshot()
  journal.accept(input)
  journal.event({
    turnId: input.turnId,
    generation: 1,
    kind: 'turn.status',
    summary: 'completed',
    detail: { status: 'succeeded', providerThreadId: 'persisted-thread' },
  })
  const restarted = new Journal(state)
  recoverTurns(restarted)
  expect(restarted.reconcile(input.turnId, 1)).toMatchObject({
    status: 'succeeded',
    providerThreadId: 'persisted-thread',
  })
  expect(restarted.pendingEvents()).toHaveLength(1)
})
