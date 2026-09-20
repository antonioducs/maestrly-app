import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, FrozenChatSelection } from '../../src/shared/chat'
import {
  ChatBackgroundCompactionCoordinator,
  type BackgroundCompactionCoordinatorDeps,
  type BackgroundCompactionSummarizeInput,
} from '../../src/main/chat/background-compaction'
import type { PortableSummaryCheckpoint } from '../../src/main/chat/portable-context'
import { getDb } from '../../src/main/store/db'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const frozen: FrozenChatSelection = {
  providerId: 'provider',
  modelId: 'summarizer',
  reasoning: 'off',
  fastMode: false,
  providerFingerprint: 'opaque-fingerprint',
}

function assistant(conversationId: string, id: string, value = 'source'): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}:part`, text: value }],
    finishReason: 'stop',
    createdAt: 1,
  }
}

interface Harness {
  coordinator: ChatBackgroundCompactionCoordinator
  deps: BackgroundCompactionCoordinatorDeps
  messages: Map<string, ChatMessage[]>
  summarize: ReturnType<typeof vi.fn<(input: BackgroundCompactionSummarizeInput) => Promise<{ summary: string }>>>
  recordAttempt: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
}

function harness(summarizeImpl?: (input: BackgroundCompactionSummarizeInput) => Promise<{ summary: string }>): Harness {
  const messages = new Map<string, ChatMessage[]>()
  let sequence = 0
  const recordAttempt = vi.fn()
  const publish = vi.fn()
  const summarize = vi.fn(
    summarizeImpl ??
      (async (input: BackgroundCompactionSummarizeInput) => {
        const attempt = input.onAttempt('chunk')
        attempt.settle({ outcome: 'success' })
        return { summary: `summary:${input.conversationId}` }
      })
  )
  const deps: BackgroundCompactionCoordinatorDeps = {
    getConfig: () => ({
      enabled: true,
      intervalTokens: 1,
      selection: { providerId: 'provider', modelId: 'summarizer', effort: 'off', fastMode: false },
    }),
    getConversation: (id) => ({ id, archived: false }),
    getMessages: (id) => messages.get(id) ?? [],
    resolveSelection: async () => ({ selection: frozen, contextWindow: 128_000 }),
    summarize,
    publish,
    recordAttempt,
    revalidate: () => true,
    randomId: () => `id-${++sequence}`,
  }
  return {
    coordinator: new ChatBackgroundCompactionCoordinator(deps),
    deps,
    messages,
    summarize,
    recordAttempt,
    publish,
  }
}

function createConversation(): string {
  return makeConversation(makeWorkspace().id).id
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count))
}

describe('chat background compaction coordinator', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('does not backfill or resume anything until the conversation is used', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'old')])

    await test.coordinator.settled()

    expect(test.summarize).not.toHaveBeenCalled()
    expect(test.coordinator.status(id)).toEqual({ revision: 0, status: 'idle' })
  })

  it('persists only the explicit frozen selection projection, never adapter credentials', async () => {
    const id = createConversation()
    const test = harness()
    test.deps.resolveSelection = async () => ({
      selection: { ...frozen, apiKey: 'DO_NOT_PERSIST' } as FrozenChatSelection,
      contextWindow: 128_000,
    })
    test.messages.set(id, [assistant(id, 'source')])

    test.coordinator.notify(id, { conversationWindow: 128_000 })
    await test.coordinator.settled()

    const row = getDb()
      .prepare('SELECT ready_json, work_json FROM chat_background_compaction WHERE conversation_id = ?')
      .get(id) as { ready_json: string; work_json: string }
    expect(`${row.ready_json}${row.work_json}`).not.toContain('DO_NOT_PERSIST')
  })

  it('runs only one summarization globally', async () => {
    const ids = [createConversation(), createConversation()]
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    const test = harness(async (input) => {
      active += 1
      maximum = Math.max(maximum, active)
      const attempt = input.onAttempt('chunk')
      await new Promise<void>((resolve) => releases.push(resolve))
      attempt.settle({ outcome: 'success' })
      active -= 1
      return { summary: `summary:${input.conversationId}` }
    })
    for (const id of ids) {
      test.messages.set(id, [assistant(id, 'old')])
      test.coordinator.notify(id, { conversationWindow: 128_000 })
    }

    await waitForCalls(test.summarize, 1)
    expect(maximum).toBe(1)
    releases.shift()?.()
    await waitForCalls(test.summarize, 2)
    expect(maximum).toBe(1)
    releases.shift()?.()
    await test.coordinator.settled()

    expect(ids.map((id) => test.coordinator.status(id).status)).toEqual(['ready', 'ready'])
  })

  it('gives other conversations a turn between interval-sized rounds', async () => {
    const first = createConversation()
    const second = createConversation()
    const order: string[] = []
    const test = harness(async (input) => {
      order.push(input.conversationId)
      input.onAttempt('chunk').settle({ outcome: 'success' })
      return { summary: `summary:${input.conversationId}:${order.length}` }
    })
    test.messages.set(first, [assistant(first, 'first-1'), assistant(first, 'first-2')])
    test.messages.set(second, [assistant(second, 'second-1')])

    test.coordinator.notify(first, { conversationWindow: 128_000 })
    test.coordinator.notify(second, { conversationWindow: 128_000 })
    await test.coordinator.settled()

    expect(order).toEqual([first, second, first])
    expect(test.coordinator.getCandidate(first)?.boundary.messageId).toBe('first-2')
  })

  it('accepts appends while running but rejects edits in the covered prefix', async () => {
    const appendId = createConversation()
    const editId = createConversation()
    const releases = new Map<string, () => void>()
    const test = harness(async (input) => {
      input.onAttempt('chunk').settle({ outcome: 'success' })
      await new Promise<void>((resolve) => releases.set(input.conversationId, resolve))
      return { summary: 'prepared' }
    })
    const appendSource = assistant(appendId, 'append-source')
    const editSource = assistant(editId, 'edit-source')
    test.messages.set(appendId, [appendSource])
    test.messages.set(editId, [editSource])

    test.coordinator.notify(appendId, {
      conversationWindow: 128_000,
      boundary: { messageId: appendSource.id, partId: appendSource.parts[0].id },
    })
    await waitForCalls(test.summarize, 1)
    test.messages.get(appendId)!.push(assistant(appendId, 'later'))
    releases.get(appendId)?.()
    await vi.waitFor(() => expect(test.coordinator.status(appendId).status).toBe('ready'))

    test.coordinator.notify(editId, {
      conversationWindow: 128_000,
      boundary: { messageId: editSource.id, partId: editSource.parts[0].id },
    })
    await waitForCalls(test.summarize, 2)
    editSource.parts[0] = { type: 'text', id: 'edit-source:part', text: 'edited source' }
    releases.get(editId)?.()
    await test.coordinator.settled()

    expect(test.coordinator.getCandidate(appendId)?.boundary.messageId).toBe('append-source')
    expect(test.coordinator.getCandidate(editId)).toBeNull()
    expect(test.coordinator.status(editId).status).toBe('idle')
  })

  it('rolls back candidate consumption and emits nothing when the marker transaction fails', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    test.coordinator.notify(id, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const before = test.coordinator.record(id)!
    const candidate = test.coordinator.getCandidate(id)!
    const published = test.publish.mock.calls.length

    expect(() =>
      test.coordinator.consume(id, candidate.id, () => {
        throw new Error('marker insert failed')
      })
    ).toThrow('marker insert failed')

    expect(test.coordinator.record(id)).toEqual(before)
    expect(test.publish).toHaveBeenCalledTimes(published)
  })

  it('consumes a validated candidate in the caller transaction and advances generation', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    test.coordinator.notify(id, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const before = test.coordinator.record(id)!
    const candidate = test.coordinator.getCandidate(id)!

    const consumed = test.coordinator.consumeCandidate(id, candidate.id, (value) => value.summary.length)

    expect(consumed).toEqual({ candidate, value: candidate.summary.length })
    expect(test.coordinator.record(id)).toMatchObject({
      generation: before.generation + 1,
      ready: null,
      work: null,
      state: { status: 'idle' },
    })
    expect(test.publish.mock.calls.at(-1)).toEqual([id, expect.objectContaining({ status: 'idle' })])
  })

  it('accounts a late completion exactly once after cancellation', async () => {
    const id = createConversation()
    let release!: () => void
    let attempt!: ReturnType<BackgroundCompactionSummarizeInput['onAttempt']>
    const test = harness(async (input) => {
      attempt = input.onAttempt('chunk')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { summary: 'late summary' }
    })
    test.messages.set(id, [assistant(id, 'source')])
    test.coordinator.notify(id, { conversationWindow: 128_000 })
    await waitForCalls(test.summarize, 1)

    test.coordinator.stop(id)
    attempt.settle({ outcome: 'error', error: new Error('late') })
    attempt.settle({ outcome: 'success' })
    release()
    await test.coordinator.settled()

    expect(test.recordAttempt).toHaveBeenCalledTimes(1)
    expect(test.recordAttempt.mock.calls[0][0]).toMatch(/^background-compaction:id-1:1$/)
    expect(test.coordinator.status(id).status).toBe('paused')
    expect(test.coordinator.record(id)?.ready).toBeNull()
  })

  it('resumes the last durable stage after restart only on explicit retry', async () => {
    const id = createConversation()
    const checkpoint: PortableSummaryCheckpoint = {
      version: 1,
      sourceHash: 'transcript',
      maxChunkBytes: 1_000,
      phase: 'chunk',
      level: 0,
      inputHash: 'input',
      completed: ['stage one'],
    }
    const source = assistant(id, 'source')
    const first = harness(async (input) => {
      input.onAttempt('chunk').settle({ outcome: 'error' })
      input.onCheckpoint(checkpoint)
      throw new Error('temporary outage')
    })
    first.messages.set(id, [source])
    first.coordinator.notify(id, { conversationWindow: 128_000 })
    await first.coordinator.settled()
    expect(first.coordinator.status(id).status).toBe('failed')
    expect(first.coordinator.record(id)?.work?.resume).toEqual(checkpoint)

    restartDb()
    let resumed: PortableSummaryCheckpoint | undefined
    const restarted = harness(async (input) => {
      input.onAttempt('chunk').settle({ outcome: 'success' })
      resumed = input.resume
      return { summary: 'resumed result' }
    })
    restarted.messages.set(id, [source])
    await restarted.coordinator.settled()
    expect(restarted.summarize).not.toHaveBeenCalled()

    expect(restarted.coordinator.retry(id)).toBe(true)
    await restarted.coordinator.settled()

    expect(resumed).toEqual(checkpoint)
    expect(restarted.coordinator.status(id).status).toBe('ready')
  })

  it('continues the global queue after a failure and preserves an older ready candidate', async () => {
    const first = createConversation()
    const second = createConversation()
    let failFirst = false
    const test = harness(async (input) => {
      input.onAttempt('chunk').settle({ outcome: failFirst && input.conversationId === first ? 'error' : 'success' })
      if (failFirst && input.conversationId === first) throw new Error('engine failed')
      return { summary: `summary:${input.conversationId}` }
    })
    test.messages.set(first, [assistant(first, 'first-1')])
    test.messages.set(second, [assistant(second, 'second-1')])
    test.coordinator.notify(first, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const oldCandidate = test.coordinator.getCandidate(first)!

    test.messages.get(first)!.push(assistant(first, 'first-2'))
    failFirst = true
    test.coordinator.notify(first, { conversationWindow: 128_000 })
    test.coordinator.notify(second, { conversationWindow: 128_000 })
    await test.coordinator.settled()

    expect(test.coordinator.status(first).status).toBe('failed')
    expect(test.coordinator.record(first)?.ready?.id).toBe(oldCandidate.id)
    expect(test.coordinator.status(second).status).toBe('ready')
  })

  it('drops unused state on configuration change without launching a backfill', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    test.coordinator.notify(id, { conversationWindow: 128_000 })
    await test.coordinator.settled()
    const generation = test.coordinator.record(id)!.generation
    const calls = test.summarize.mock.calls.length

    test.coordinator.configureChanged()
    await test.coordinator.settled()

    expect(test.coordinator.record(id)).toMatchObject({
      generation: generation + 1,
      ready: null,
      work: null,
      state: { status: 'idle' },
    })
    expect(test.summarize).toHaveBeenCalledTimes(calls)
  })
  it('reports failures while resolving the very first profile without retrying on every notification', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    const resolve = vi.fn(async () => {
      throw new Error('Network unavailable')
    })
    test.deps.resolveSelection = resolve
    test.coordinator.notify(id, { conversationWindow: 200000 })
    await test.coordinator.settled()
    expect(test.coordinator.status(id).status).toBe('failed')
    test.coordinator.notify(id, { conversationWindow: 200000 })
    await test.coordinator.settled()
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('explicit retry freezes corrected credentials instead of reusing an invalid failed profile', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    test.summarize.mockRejectedValueOnce(new Error('Authentication failed'))
    test.coordinator.notify(id, { conversationWindow: 200000 })
    await test.coordinator.settled()
    expect(test.coordinator.status(id).status).toBe('failed')
    const corrected = { ...frozen, providerFingerprint: 'new-fingerprint' }
    test.deps.revalidate = (selection) => selection.providerFingerprint === corrected.providerFingerprint
    test.deps.resolveSelection = async () => ({ selection: corrected, contextWindow: 200000 })
    expect(test.coordinator.retry(id)).toBe(true)
    await test.coordinator.settled()
    expect(test.coordinator.getCandidate(id)?.selection.providerFingerprint).toBe('new-fingerprint')
  })

  it('treats a malformed persisted Cursor profile as invalid instead of throwing on history mutations', async () => {
    const id = createConversation()
    const test = harness()
    test.messages.set(id, [assistant(id, 'source')])
    test.coordinator.notify(id, { conversationWindow: 200000 })
    await test.coordinator.settled()
    const candidate = test.coordinator.record(id)!.ready!
    getDb()
      .prepare('UPDATE chat_background_compaction SET ready_json = ? WHERE conversation_id = ?')
      .run(
        JSON.stringify({
          ...candidate,
          selection: { ...frozen, cursorModelSelection: { modelId: 'model', params: null } },
        }),
        id
      )
    expect(() => test.coordinator.record(id)).not.toThrow()
    expect(test.coordinator.record(id)?.ready).toBeNull()
  })
})
