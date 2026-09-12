import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../src/main/store/conversations'
import type { InternalTurnHandle, InternalTurnOutcome } from '../../src/shared/chat'
import {
  createConversationReviewLoopCoordinator,
  type ConversationReviewLoopDeps,
  type PairedReviewTurnInput,
} from '../../src/main/chat/review-loop/conversation-driver'

function conversation(id: string, cwd = '/repo'): Conversation {
  return {
    id,
    workspaceId: 'workspace',
    name: id,
    branch: 'main',
    mode: 'worktree',
    experience: 'standard',
    cwd,
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
    isMulti: 0,
    uiPrefs: { chat: { providerId: `provider-${id}`, modelId: `model-${id}` } },
  }
}

function immediateHandle(input: PairedReviewTurnInput, outcome: InternalTurnOutcome): InternalTurnHandle {
  return {
    executionId: `${input.role}-${input.iteration}-${Math.random()}`,
    conversationId: input.conversationId,
    assistantMessageId: () => `${input.role}-assistant`,
    done: Promise.resolve(outcome),
    cancel: vi.fn(),
  }
}

function harness(decisions: Array<{ result: 'clean' | 'findings'; summary: string; findings?: any[] }>, mutate = true) {
  const conversations = new Map([
    ['executor', conversation('executor')],
    ['reviewer', conversation('reviewer')],
  ])
  let diff = ''
  let reviewerCalls = 0
  let executorCalls = 0
  const reservations = new Map<string, string>()
  const releaseLease = vi.fn()
  const persistSummary = vi.fn(async ({ loopId, role }: { loopId: string; role: string }) => ({
    ok: true as const,
    messageId: `${loopId}:${role}`,
  }))
  const startTurn = vi.fn(async (input: PairedReviewTurnInput) => {
    if (input.role === 'reviewer') {
      const decision = decisions[reviewerCalls++]
      input.reviewerRuntime!.recordEvidence('diff')
      input.reviewerRuntime!.recordEvidence('search')
      input.reviewerRuntime!.recordEvidence('read')
      input.reviewerRuntime!.submitReview(decision)
      return {
        ok: true as const,
        handle: immediateHandle(input, { status: 'success', assistantMessageId: 'reviewer-assistant' }),
      }
    }
    executorCalls++
    if (mutate) diff = `change-${executorCalls}`
    return {
      ok: true as const,
      handle: immediateHandle(input, {
        status: 'success',
        assistantMessageId: 'executor-assistant',
        summaryText: `fix ${executorCalls}`,
      }),
    }
  })
  const deps: ConversationReviewLoopDeps = {
    getConversation: (id) => conversations.get(id),
    listConversations: () => [...conversations.values()],
    canonicalCwd: (cwd) => cwd,
    validateStart: vi.fn(async () => ({ ok: true as const })),
    resolveSelection: vi.fn(async (id) => ({
      ok: true as const,
      selection: { providerId: `provider-${id}`, modelId: `model-${id}`, reasoning: 'off', fastMode: false },
    })),
    revalidateSelection: vi.fn(async () => ({ ok: true as const })),
    startTurn,
    acquireLease: (_cwd, owner, allowedOwners) =>
      ({
        owner,
        cwd: '/repo',
        allow: vi.fn(),
        disallow: vi.fn(),
        release: releaseLease,
        allowedOwners,
      }) as never,
    registry: {
      reserve: (reservation) => {
        if ([reservation.participants.executor, reservation.participants.reviewer].some((id) => reservations.has(id))) {
          return { ok: false as const, error: 'review-loop-active' }
        }
        reservations.set(reservation.participants.executor, reservation.loopId)
        reservations.set(reservation.participants.reviewer, reservation.loopId)
        return { ok: true as const }
      },
      release: (loopId) => {
        for (const [id, owner] of reservations) if (owner === loopId) reservations.delete(id)
      },
      lockFor: (id) => reservations.get(id) ?? null,
    },
    searchExecutionContext: vi.fn(),
    readExecutionContext: vi.fn(),
    getExecutionBrief: vi.fn(() => ({ messages: [{ role: 'user', content: 'requirements' }] })),
    persistSummary,
    runGit: () => async (args) => {
      const key = args.join(' ')
      if (key === 'rev-parse --abbrev-ref HEAD') return 'main'
      if (key === 'rev-parse HEAD') return 'head'
      if (key === 'diff --no-ext-diff --no-textconv') return diff
      if (key === 'diff --cached --no-ext-diff --no-textconv') return ''
      if (key === 'ls-files --others --exclude-standard') return ''
      return ''
    },
  }
  const coordinator = createConversationReviewLoopCoordinator(deps)
  return {
    coordinator,
    conversations,
    startTurn,
    persistSummary,
    releaseLease,
    deps,
    setDiff: (value: string) => {
      diff = value
    },
    counts: () => ({ reviewer: reviewerCalls, executor: executorCalls }),
  }
}

async function start(h: ReturnType<typeof harness>, maxIterations = 5) {
  const result = await h.coordinator.start({
    executorConversationId: 'executor',
    reviewerConversationId: 'reviewer',
    maxIterations,
    severityThreshold: 'important',
  })
  expect(result.ok).toBe(true)
  return result.ok ? result.loop.loopId : ''
}

describe('paired conversation review coordinator', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects equal ids and different canonical cwd', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    expect(
      await h.coordinator.start({ executorConversationId: 'executor', reviewerConversationId: 'executor' })
    ).toEqual({ ok: false, error: 'participants-must-be-distinct' })
    h.conversations.set('reviewer', conversation('reviewer', '/other'))
    expect(
      await h.coordinator.start({ executorConversationId: 'executor', reviewerConversationId: 'reviewer' })
    ).toEqual({ ok: false, error: 'cwd-mismatch' })
  })

  it('rejects missing and archived participants', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    h.conversations.delete('reviewer')
    await expect(
      h.coordinator.start({ executorConversationId: 'executor', reviewerConversationId: 'reviewer' })
    ).resolves.toEqual({ ok: false, error: 'invalid-conversation' })

    h.conversations.set('reviewer', { ...conversation('reviewer'), archived: 1 })
    await expect(
      h.coordinator.start({ executorConversationId: 'executor', reviewerConversationId: 'reviewer' })
    ).resolves.toEqual({ ok: false, error: 'conversation-archived' })
  })

  it('finishes clean without running the executor and persists one summary per participant', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.finishReason).toBe('clean'))
    expect(h.counts()).toEqual({ reviewer: 1, executor: 0 })
    expect(h.persistSummary).toHaveBeenCalledTimes(2)
    expect(h.releaseLease).toHaveBeenCalledOnce()
  })

  it('runs findings → executor → fresh reviewer → clean', async () => {
    const finding = { id: 'f1', severity: 'important', title: 'Fix', details: 'Fix it' }
    const h = harness([
      { result: 'findings', summary: 'issue', findings: [finding] },
      { result: 'clean', summary: 'clean' },
    ])
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('reviewer')?.finishReason).toBe('clean'))
    expect(h.counts()).toEqual({ reviewer: 2, executor: 1 })
    const reviewerTurns = h.startTurn.mock.calls.map(([input]) => input).filter((input) => input.role === 'reviewer')
    expect(reviewerTurns).toHaveLength(2)
    expect(reviewerTurns[0].reviewerRuntime).not.toBe(reviewerTurns[1].reviewerRuntime)
  })

  it('treats optional-only findings as clean without a correction', async () => {
    const h = harness([
      {
        result: 'findings',
        summary: 'optional',
        findings: [
          {
            id: 'o1',
            severity: 'optional',
            title: 'Polish',
            details: 'Could improve',
          },
        ],
      },
    ])
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.finishReason).toBe('clean'))
    expect(h.counts().executor).toBe(0)
  })

  it('never parses reviewer text when submit_review is missing', async () => {
    const h = harness([])
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('reviewer')?.finishReason).toBe('review-decision-missing'))
    expect(h.counts().executor).toBe(0)
  })

  it('classifies an independently revalidated reviewer profile as unavailable', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    vi.mocked(h.deps.revalidateSelection).mockImplementation(async (conversationId) =>
      conversationId === 'reviewer' ? { ok: false as const, error: 'no-key' } : { ok: true as const }
    )
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.finishReason).toBe('reviewer_unavailable'))
    expect(h.counts()).toEqual({ reviewer: 0, executor: 0 })
  })

  it('performs the final read-only audit after the last allowed correction', async () => {
    const finding = { id: 'f1', severity: 'important', title: 'Fix', details: 'Still open' }
    const h = harness([
      { result: 'findings', summary: 'first', findings: [finding] },
      { result: 'findings', summary: 'remaining', findings: [{ ...finding, id: 'f2' }] },
    ])
    await start(h, 1)
    await vi.waitFor(() => expect(h.coordinator.status('reviewer')?.finishReason).toBe('max_iterations'))
    expect(h.counts()).toEqual({ reviewer: 2, executor: 1 })
  })

  it('stops on repeated findings after a no-progress correction', async () => {
    const finding = { id: 'f1', severity: 'important', title: 'Fix', details: 'Still open' }
    const h = harness(
      [
        { result: 'findings', summary: 'first', findings: [finding] },
        { result: 'findings', summary: 'same', findings: [finding] },
      ],
      false
    )
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.finishReason).toBe('no_progress'))
    expect(h.counts()).toEqual({ reviewer: 2, executor: 1 })
  })

  it('Stop from either participant cancels the same active reviewer turn once', async () => {
    const h = harness([{ result: 'clean', summary: 'unused' }])
    let settle!: (outcome: InternalTurnOutcome) => void
    const cancel = vi.fn(() => settle({ status: 'cancelled', assistantMessageId: null }))
    h.startTurn.mockImplementationOnce(async (input: PairedReviewTurnInput) => ({
      ok: true as const,
      handle: {
        executionId: 'reviewer-pending',
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        done: new Promise<InternalTurnOutcome>((resolve) => {
          settle = resolve
        }),
        cancel,
      },
    }))

    await start(h)
    await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledOnce())
    expect(h.coordinator.stop('executor')).toBe(true)
    expect(h.coordinator.stop('reviewer')).toBe(false)
    await vi.waitFor(() => expect(h.coordinator.status('reviewer')).toBeNull())
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.persistSummary).toHaveBeenCalledTimes(2)
  })

  it('detects an external workspace change during a read-only reviewer round', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    let settle!: (outcome: InternalTurnOutcome) => void
    h.startTurn.mockImplementationOnce(async (input: PairedReviewTurnInput) => {
      input.reviewerRuntime!.recordEvidence('diff')
      input.reviewerRuntime!.recordEvidence('search')
      input.reviewerRuntime!.recordEvidence('read')
      input.reviewerRuntime!.submitReview({ result: 'clean', summary: 'clean' })
      return {
        ok: true as const,
        handle: {
          executionId: 'reviewer-external-change',
          conversationId: input.conversationId,
          assistantMessageId: () => null,
          done: new Promise<InternalTurnOutcome>((resolve) => {
            settle = resolve
          }),
          cancel: vi.fn(),
        },
      }
    })
    await start(h)
    await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledOnce())
    h.setDiff('external-change')
    settle({ status: 'success', assistantMessageId: 'reviewer' })
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.finishReason).toBe('workspace_changed_externally'))
  })

  it('Stop during preflight cancels without materializing a public loop or lease', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(h.deps.validateStart).mockImplementation(async () => {
      await gate
      return { ok: true as const }
    })
    const pending = h.coordinator.start({
      executorConversationId: 'executor',
      reviewerConversationId: 'reviewer',
    })
    await vi.waitFor(() => expect(h.deps.validateStart).toHaveBeenCalledTimes(2))
    expect(h.coordinator.stop('reviewer')).toBe(true)
    release()
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' })
    expect(h.coordinator.status('executor')).toBeNull()
    expect(h.releaseLease).not.toHaveBeenCalled()
  })

  it('summary persistence failure never strands the registry or checkout lease', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    h.persistSummary.mockRejectedValue(new Error('disk unavailable'))
    await start(h)
    await vi.waitFor(() => expect(h.coordinator.status('executor')?.status).toBe('finished'))
    expect(h.releaseLease).toHaveBeenCalledOnce()
    await expect(h.coordinator.compatible('executor')).resolves.toHaveLength(1)
  })

  it('dispose waits for a cancelled preflight to release its pending ownership', async () => {
    const h = harness([{ result: 'clean', summary: 'clean' }])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(h.deps.validateStart).mockImplementation(async () => {
      await gate
      return { ok: true as const }
    })
    const pending = h.coordinator.start({
      executorConversationId: 'executor',
      reviewerConversationId: 'reviewer',
    })
    await vi.waitFor(() => expect(h.deps.validateStart).toHaveBeenCalledTimes(2))
    const disposed = h.coordinator.dispose()
    release()
    await disposed
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' })
  })
})
