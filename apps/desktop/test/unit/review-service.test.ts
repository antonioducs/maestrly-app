import { describe, expect, it, vi } from 'vitest'
import type { ReviewJobInfo } from '../../src/shared/review'
import type { SubagentExecutionSnapshotV1 } from '../../src/shared/subagent-profiles'
import { createReviewService, REVIEWER_AGENT, type ReviewServiceDeps } from '../../src/main/chat/review/service'
import type { GitSnapshot } from '../../src/main/chat/review/git-diff'

const PROFILE = {
  version: 1,
  agentName: 'reviewer',
  effective: {
    providerId: 'provider-1',
    modelId: 'model-1',
    configuredEffort: 'high',
    sentEffort: 'high',
    fastMode: false,
    source: 'parent',
    candidateIndex: 0,
  },
  attempts: [],
} as unknown as SubagentExecutionSnapshotV1

const CHANGED: GitSnapshot = {
  repository: true,
  branch: 'feat/x',
  head: 'abc123',
  baseDiff: 'diff --git a/a.ts b/a.ts',
  staged: '',
  unstaged: '',
  untracked: [],
  truncated: false,
}

const FINDING_INPUT = {
  severity: 'important',
  title: 'Missing cleanup',
  details: 'The listener is never removed.',
  evidence: 'a.ts:3 adds it; nothing removes it.',
  path: 'a.ts',
  line: 3,
  plan_line: 2,
}

function deps(overrides: Partial<ReviewServiceDeps> = {}) {
  const changes: ReviewJobInfo[] = []
  const base: ReviewServiceDeps = {
    getConversation: (id) => (id === 'conv' ? { id, cwd: '/repo', projectId: 'ws', archived: false } : null),
    isBusy: () => false,
    pendingPlan: () => ({ plan: '# Plan\n- Add the listener', version: 2 }),
    selection: () => ({ providerId: 'provider-1', modelId: 'model-1', reasoning: 'high', fastMode: false }),
    resolveProfile: vi.fn(async () => PROFILE),
    conversationContext: () => '[{"role":"user","content":"add a listener"}]',
    locale: () => 'pt-BR',
    // Each reviewer submits through its own submit_findings tool, exactly like a real child run.
    runReviewer: vi.fn(async ({ tools, task }) => {
      const submit = tools.submit_findings.execute as (input: unknown, options: unknown) => Promise<string>
      if (task.startsWith('You are the verifier'))
        await submit({ findings: [{ ...FINDING_INPUT, candidate_id: 'C1' }] }, {})
      else if (task.includes('Lens: correctness') || task.includes('Lens: feasibility'))
        await submit({ findings: [FINDING_INPUT] }, {})
      else await submit({ findings: [] }, {})
      return { text: '', usage: { input: 100, output: 10, cacheRead: 0, cacheCreate: 0, totalInput: 100 } }
    }),
    persistReport: vi.fn(() => 'review:message'),
    onChange: (info) => changes.push(info),
    readSnapshot: vi.fn(async () => CHANGED),
    now: () => 1_000,
    ...overrides,
  }
  return { deps: base, changes }
}

async function settle(service: ReturnType<typeof createReviewService>, conversationId = 'conv') {
  await vi.waitFor(() => {
    const status = service.status(conversationId)
    expect(status && status.status !== 'running' && status.status !== 'verifying').toBe(true)
  })
  return service.status(conversationId)!
}

describe('review service', () => {
  it('reviews code changes and stores the verified report in the conversation', async () => {
    const { deps: d, changes } = deps()
    const service = createReviewService(d)
    const started = await service.start('conv', { target: 'code' })
    expect(started).toMatchObject({
      ok: true,
      review: { target: 'code', status: 'running', model: { modelId: 'model-1', reasoning: 'high' } },
    })
    const done = await settle(service)
    expect(done).toMatchObject({
      status: 'completed',
      messageId: 'review:message',
      candidates: 1,
      verification: 'done',
    })
    expect(d.persistReport).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv',
        usage: expect.objectContaining({ input: 400 }),
        report: expect.objectContaining({
          target: 'code',
          candidates: 1,
          scope: { branch: 'feat/x', head: 'abc123' },
          findings: [expect.objectContaining({ id: 'F1', lens: 'correctness', path: 'a.ts', line: 3 })],
        }),
      })
    )
    // Code reviewers get the checkout's diff; every reviewer is the read-only reviewer agent.
    const firstRun = (d.runReviewer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(Object.keys(firstRun.tools).sort()).toEqual(['git_diff', 'submit_findings'])
    expect(firstRun.task).toContain('Brazilian Portuguese')
    expect(REVIEWER_AGENT.tools).toEqual(['read', 'grep', 'glob', 'git_diff', 'submit_findings'])
    expect(changes.some((info) => info.status === 'verifying')).toBe(true)
    expect(changes.at(-1)?.status).toBe('completed')
  })

  it('reviews the pending plan and hands its findings back instead of storing a message', async () => {
    const { deps: d } = deps()
    const service = createReviewService(d)
    expect(await service.start('conv', { target: 'plan' })).toMatchObject({ ok: true, review: { planVersion: 2 } })
    const done = await settle(service)
    expect(done.status).toBe('completed')
    expect(done.findings).toEqual([expect.objectContaining({ id: 'F1', lens: 'feasibility', planLine: 2 })])
    expect(d.persistReport).not.toHaveBeenCalled()
    const firstRun = (d.runReviewer as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(Object.keys(firstRun.tools)).toEqual(['submit_findings'])
    service.forget('conv')
    expect(service.status('conv')).toBeNull()
  })

  it('drops plan findings when the plan changed while it was reviewed', async () => {
    let version = 2
    const { deps: d } = deps({ pendingPlan: () => ({ plan: '# Plan\n- Add the listener', version }) })
    const service = createReviewService(d)
    await service.start('conv', { target: 'plan' })
    version = 3
    const done = await settle(service)
    expect(done.status).toBe('cancelled')
    expect(done.findings).toBeUndefined()
  })

  it('refuses to start when there is nothing to review or the conversation cannot run one', async () => {
    const cases: Array<[Partial<ReviewServiceDeps>, unknown, string]> = [
      [{ readSnapshot: async () => ({ ...CHANGED, baseDiff: '' }) }, { target: 'code' }, 'nothing-to-review'],
      [{ readSnapshot: async () => ({ ...CHANGED, repository: false }) }, { target: 'code' }, 'not-a-repository'],
      [{ isBusy: () => true }, { target: 'code' }, 'conversation-busy'],
      [{ pendingPlan: () => null }, { target: 'plan' }, 'no-pending-plan'],
      [{ selection: () => null }, { target: 'code' }, 'no-model'],
      [{}, { target: 'everything' }, 'invalid-input'],
      [
        {
          resolveProfile: async () =>
            ({
              ...PROFILE,
              effective: null,
              attempts: [{ diagnostics: [{ severity: 'error', message: 'Provider is signed out.' }] }],
            }) as unknown as SubagentExecutionSnapshotV1,
        },
        { target: 'code' },
        'Provider is signed out.',
      ],
    ]
    for (const [override, input, error] of cases) {
      const { deps: d } = deps(override)
      expect(await createReviewService(d).start('conv', input)).toEqual({ ok: false, error })
    }
    const { deps: d } = deps()
    expect(await createReviewService(d).start('missing', { target: 'code' })).toEqual({
      ok: false,
      error: 'invalid-conversation',
    })
  })

  it('runs one review per conversation at a time and cancels on request', async () => {
    const { deps: d } = deps({
      runReviewer: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      ),
    })
    const service = createReviewService(d)
    const [first, second] = await Promise.all([
      service.start('conv', { target: 'code' }),
      service.start('conv', { target: 'code' }),
    ])
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, error: 'review-active' })
    expect(service.cancel('conv')).toEqual({ ok: true })
    expect((await settle(service)).status).toBe('cancelled')
    expect(service.cancel('conv')).toEqual({ ok: false })
  })

  it('reports a failure when no reviewer finishes', async () => {
    const { deps: d } = deps({ runReviewer: vi.fn(async () => ({ text: 'I looked around.', error: 'stream closed' })) })
    const service = createReviewService(d)
    await service.start('conv', { target: 'code' })
    expect(await settle(service)).toMatchObject({ status: 'failed', error: 'stream closed' })
  })

  it('aborts running reviews on dispose', async () => {
    const { deps: d } = deps({
      runReviewer: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      ),
    })
    const service = createReviewService(d)
    await service.start('conv', { target: 'code' })
    await service.dispose()
    expect(service.status('conv')?.status).toBe('cancelled')
  })
})
