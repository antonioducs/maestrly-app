import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  activeMaestroDelegationCount,
  cancelMaestroDelegation,
  listTurnDelegations,
  startMaestroDelegation,
  unobservedTurnDelegations,
  waitForMaestroDelegation,
} from '../../src/main/chat/maestro-delegation-registry'
import { waitForSubagentSession } from '../../src/main/chat/subagent-session'
import { buildSubagentSupervisionTools } from '../../src/main/chat/maestro-supervision-tools'
import {
  createSubagentSession,
  getSubagentSession,
  upsertSubagentTranscriptPart,
} from '../../src/main/chat/subagent-session-store'
import { createMaestroLiveRunPort } from '../../src/main/chat/maestro-live'

const profile = {
  version: 1 as const,
  agentName: 'frontend-specialist',
  effective: {
    providerId: 'test-provider',
    modelId: 'test-model',
    configuredEffort: 'high',
    sentEffort: 'high',
    source: 'maestro-resource' as const,
    candidateIndex: 0,
  },
  attempts: [],
}

function fixture() {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id, { experience: 'maestro' })
  const parentMessageId = 'maestro-parent'
  upsertChatMessage({
    id: parentMessageId,
    conversationId: conversation.id,
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
  })
  return { conversation, parentMessageId }
}

describe('Maestro async delegation registry', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('returns a handle immediately, deduplicates replay and exposes terminal deltas by cursor', async () => {
    const { conversation, parentMessageId } = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let executions = 0
    const maestroLive = createMaestroLiveRunPort({ conversationId: conversation.id, emit: () => {} })
    expect(maestroLive.post('Use the new compact layout.').ok).toBe(true)
    const start = () =>
      startMaestroDelegation({
        conversationId: conversation.id,
        parentMessageId,
        toolCallId: 'delegate-call-1',
        agentName: 'frontend-specialist',
        task: 'Implement the panel.',
        profile,
        maestro: {
          delegationId: 'delegate-call-1',
          kind: 'implement',
          domain: 'frontend',
          independent: true,
          reviewOf: [],
          resource: {
            id: 'frontend-specialist',
            label: 'Frontend Specialist',
            capability: 'worker',
          },
        } as never,
        parentSignal: new AbortController().signal,
        maestroLive,
        execute: async (_signal, recorder) => {
          executions += 1
          await gate
          recorder.text({ kind: 'append', text: 'Implemented.' })
          recorder.complete({ status: 'completed' })
          return { output: 'Implemented.' }
        },
      })

    const first = start()
    const handle = JSON.parse(first.output) as { sessionId: string; status: string }
    expect(handle.sessionId).toMatch(/^subagent-/)
    expect(activeMaestroDelegationCount()).toBe(1)
    expect(start().output).toContain(handle.sessionId)
    expect(executions).toBe(0)

    release()
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
    expect(executions).toBe(1)
    const waited = await waitForSubagentSession(handle.sessionId, 0, 0)
    expect(waited?.session.status).toBe('completed')
    expect(waited?.changes.some((change) => change.part.type === 'text')).toBe(true)
    expect(
      waited?.changes
        .filter((change) => change.part.type === 'text')
        .map((change) => (change.part.type === 'text' ? change.part.text : ''))
        .join('\n')
    ).toContain('<maestrly-user-updates')
    expect(listTurnDelegations(conversation.id, parentMessageId)).toHaveLength(1)
    expect(unobservedTurnDelegations(conversation.id, parentMessageId)).toHaveLength(1)

    const supervision = buildSubagentSupervisionTools({
      conversationId: conversation.id,
      parentMessageId,
      maestro: true,
      signal: new AbortController().signal,
    })
    const terminalWait = await (supervision.wait_delegation as { execute: (...args: any[]) => Promise<any> }).execute(
      { session_id: handle.sessionId, cursor: 0 },
      {}
    )
    expect(terminalWait).toMatchObject({
      reason: 'terminal',
      terminal: true,
      liveness: { alive: false, stalled: false },
      session: { sessionId: handle.sessionId, status: 'completed' },
      cursor: expect.any(Number),
    })
    // The parent gets the worker's final report (host user-updates included), never the raw transcript.
    expect(terminalWait.report).toContain('Implemented.')
    expect(terminalWait.report).toContain('<maestrly-user-updates')
    expect(terminalWait.changes).toBeUndefined()

    const inspected = await (supervision.inspect_subagent as { execute: (...args: any[]) => Promise<any> }).execute(
      { session_id: handle.sessionId, cursor: 0, limit: 20 },
      {}
    )
    expect(inspected).toMatchObject({
      session: { sessionId: handle.sessionId, status: 'completed' },
      hasMore: false,
    })
    expect(inspected.changes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message' })]))
    expect(unobservedTurnDelegations(conversation.id, parentMessageId)).toEqual([])

    const replay = start()
    expect(JSON.parse(replay.output)).toMatchObject({ sessionId: handle.sessionId, status: 'completed' })
    expect(executions).toBe(1)
  })

  it('cancels only a live session owned by the same parent turn', async () => {
    const { conversation, parentMessageId } = fixture()
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-cancel',
      agentName: 'frontend-specialist',
      task: 'Wait.',
      profile,
      maestro: {
        delegationId: 'delegate-call-cancel',
        kind: 'implement',
        domain: 'frontend',
        independent: true,
        reviewOf: [],
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async (signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
        return { output: '' }
      },
    })
    const sessionId = (JSON.parse(started.output) as { sessionId: string }).sessionId
    expect(
      cancelMaestroDelegation({ conversationId: conversation.id, parentMessageId: 'other-parent', sessionId })
    ).toEqual({ ok: false, status: 'running' })
    expect(cancelMaestroDelegation({ conversationId: conversation.id, parentMessageId, sessionId })).toEqual({
      ok: true,
      status: 'cancelled',
    })
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
    const waited = await waitForSubagentSession(sessionId, 0, 0)
    expect(waited?.session.status).toBe('cancelled')
  })

  it('coalesces routine progress in the host and wakes the parent immediately on terminal state', async () => {
    const { conversation, parentMessageId } = fixture()
    let recorder: Parameters<Parameters<typeof startMaestroDelegation>[0]['execute']>[1] | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-coalesced',
      agentName: 'frontend-specialist',
      task: 'Implement while emitting routine progress.',
      profile,
      maestro: {
        delegationId: 'delegate-call-coalesced',
        kind: 'implement',
        domain: 'frontend',
        independent: true,
        reviewOf: [],
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async (_signal, sessionRecorder) => {
        recorder = sessionRecorder
        sessionRecorder.phase('model-running')
        await gate
        sessionRecorder.text({ kind: 'append', text: 'Implemented after routine progress.' })
        sessionRecorder.complete({ status: 'completed' })
        return { output: 'Implemented after routine progress.' }
      },
    })
    const sessionId = (JSON.parse(started.output) as { sessionId: string }).sessionId
    await expect.poll(() => recorder).toBeDefined()
    const cursor = getSubagentSession(sessionId)!.revision
    const waiting = waitForMaestroDelegation(sessionId, cursor, new AbortController().signal, {
      checkIntervalMs: 5,
      stallMs: 1_000,
      checkpointMs: 1_000,
    })
    let settled = false
    void waiting.then(() => {
      settled = true
    })

    recorder!.phase('tool-running', 'read')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    release()
    const result = await waiting
    expect(result).toMatchObject({ reason: 'terminal', alive: false, session: { status: 'completed' } })
    expect(
      result?.changes.some(
        (change) => change.part.type === 'text' && change.part.text.includes('Implemented after routine progress.')
      )
    ).toBe(true)
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
  })

  it('reports one non-terminal stall without cancelling and then falls back to a spaced checkpoint', async () => {
    const { conversation, parentMessageId } = fixture()
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-stalled',
      agentName: 'frontend-specialist',
      task: 'Remain active without observable progress.',
      profile,
      maestro: {
        delegationId: 'delegate-call-stalled',
        kind: 'test',
        domain: 'frontend',
        independent: true,
        reviewOf: [],
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const sessionId = (JSON.parse(started.output) as { sessionId: string }).sessionId
    await expect.poll(() => activeMaestroDelegationCount()).toBe(1)

    const stalled = await waitForMaestroDelegation(sessionId, 0, new AbortController().signal, {
      checkIntervalMs: 5,
      stallMs: 20,
      checkpointMs: 200,
    })
    expect(stalled).toMatchObject({ reason: 'stalled', alive: true, session: { status: 'running' } })
    expect(activeMaestroDelegationCount()).toBe(1)

    const checkpoint = await waitForMaestroDelegation(sessionId, 0, new AbortController().signal, {
      checkIntervalMs: 5,
      stallMs: 20,
      checkpointMs: 30,
    })
    expect(checkpoint).toMatchObject({ reason: 'checkpoint', alive: true, session: { status: 'running' } })

    expect(cancelMaestroDelegation({ conversationId: conversation.id, parentMessageId, sessionId })).toMatchObject({
      ok: true,
    })
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
  })

  it('recovers a live persisted session without an owner as interrupted and reports it as orphaned', async () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-orphaned',
      origin: 'delegate',
      agentName: 'frontend-specialist',
      task: 'This execution owner disappeared.',
    })

    const result = await waitForMaestroDelegation(session.id, 0, new AbortController().signal, {
      checkIntervalMs: 5,
      stallMs: 20,
      checkpointMs: 30,
    })
    expect(result).toMatchObject({
      reason: 'orphaned',
      alive: false,
      session: { status: 'interrupted', phase: 'orphaned' },
    })
    expect(getSubagentSession(session.id)?.status).toBe('interrupted')
  })

  it('aborts a host-owned wait promptly without cancelling the worker', async () => {
    const { conversation, parentMessageId } = fixture()
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-wait-abort',
      agentName: 'frontend-specialist',
      task: 'Keep running while the observer aborts.',
      profile,
      maestro: {
        delegationId: 'delegate-call-wait-abort',
        kind: 'test',
        domain: 'frontend',
        independent: true,
        reviewOf: [],
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const sessionId = (JSON.parse(started.output) as { sessionId: string }).sessionId
    await expect.poll(() => activeMaestroDelegationCount()).toBe(1)
    const observer = new AbortController()
    const waiting = waitForMaestroDelegation(sessionId, 0, observer.signal, {
      checkIntervalMs: 1_000,
      stallMs: 1_000,
      checkpointMs: 1_000,
    })
    observer.abort(new Error('observer stopped'))
    await expect(waiting).rejects.toThrow('observer stopped')
    expect(activeMaestroDelegationCount()).toBe(1)

    cancelMaestroDelegation({ conversationId: conversation.id, parentMessageId, sessionId })
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
  })

  it('marks an execution interrupted when its promise exits without a terminal recorder state', async () => {
    const { conversation, parentMessageId } = fixture()
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-missing-terminal',
      agentName: 'frontend-specialist',
      task: 'Return without completing the recorder.',
      profile,
      maestro: {
        delegationId: 'delegate-call-missing-terminal',
        kind: 'test',
        domain: 'frontend',
        independent: true,
        reviewOf: [],
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async () => ({ output: 'Returned without terminal state.' }),
    })
    const sessionId = (JSON.parse(started.output) as { sessionId: string }).sessionId
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)
    expect(getSubagentSession(sessionId)).toMatchObject({
      status: 'interrupted',
      error: 'Delegation execution ended without reporting a terminal status.',
    })
  })

  it('keeps inspect_subagent pages under a fixed budget and clips oversized tool outputs', async () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-noisy',
      origin: 'delegate',
      agentName: 'frontend-specialist',
      task: 'Read many files.',
    })
    for (let index = 0; index < 12; index += 1) {
      upsertSubagentTranscriptPart({
        sessionId: session.id,
        partId: `tool-${index}`,
        position: index + 1,
        part: {
          type: 'tool',
          id: `tool-${index}`,
          toolCallId: `tool-${index}`,
          toolName: 'read',
          input: { path: `src/file-${index}.ts` },
          state: { status: 'completed', output: 'x'.repeat(6_000) },
        },
      })
    }
    const supervision = buildSubagentSupervisionTools({
      conversationId: conversation.id,
      parentMessageId,
      maestro: true,
      signal: new AbortController().signal,
    })
    const page = await (supervision.inspect_subagent as { execute: (...args: any[]) => Promise<any> }).execute(
      { session_id: session.id, cursor: 0 },
      {}
    )
    expect(JSON.stringify(page.changes).length).toBeLessThan(13_000)
    expect(page.changes.length).toBeLessThan(12)
    expect(page.hasMore).toBe(true)
    expect(page.changes[1].output).toMatch(/… \[\+\d+ chars\]$/)
    const rest = await (supervision.inspect_subagent as { execute: (...args: any[]) => Promise<any> }).execute(
      { session_id: session.id, cursor: page.cursor },
      {}
    )
    expect(rest.changes[0].cursor).toBeGreaterThan(page.cursor)
  })

  it('links a continued delegation to its predecessor and surfaces the resume outcome to the parent', async () => {
    const { conversation, parentMessageId } = fixture()
    const previous = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-author-1',
      origin: 'delegate',
      agentName: 'frontend-specialist',
      task: 'Build the panel.',
    })
    const started = startMaestroDelegation({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-call-author-2',
      agentName: 'frontend-specialist',
      task: 'Apply the review findings.',
      profile,
      maestro: {
        delegationId: 'delegate-call-author-2',
        kind: 'fix',
        domain: 'frontend',
        independent: false,
        reviewOf: [],
        resumedFrom: previous.id,
        resource: { id: 'frontend-specialist', label: 'Frontend Specialist', capability: 'worker' },
      } as never,
      parentSignal: new AbortController().signal,
      execute: async (_signal, recorder) => {
        recorder.resumeOutcome('recreated', 'provider-unsupported')
        recorder.complete({ status: 'completed' })
        return { output: 'Applied.' }
      },
    })
    const handle = JSON.parse(started.output) as { sessionId: string; resumedFrom?: string }
    expect(handle.resumedFrom).toBe(previous.id)
    await expect.poll(() => activeMaestroDelegationCount()).toBe(0)

    const supervision = buildSubagentSupervisionTools({
      conversationId: conversation.id,
      parentMessageId,
      maestro: true,
      signal: new AbortController().signal,
    })
    const waited = await (supervision.wait_delegation as { execute: (...args: any[]) => Promise<any> }).execute(
      { session_id: handle.sessionId, cursor: 0 },
      {}
    )
    expect(waited).toMatchObject({
      reason: 'terminal',
      session: {
        sessionId: handle.sessionId,
        resumedFrom: previous.id,
        resumeStatus: 'recreated',
        resumeReason: 'provider-unsupported',
      },
    })
  })
})
