import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ChatReviewReport, ReviewJobInfo } from '../../src/shared/review'
import type { SubagentExecutionSnapshotV1 } from '../../src/shared/subagent-profiles'
import { createReviewService, REVIEWER_AGENT, type ReviewServiceDeps } from '../../src/main/chat/review/service'
import type { DiffStats } from '../../src/main/chat/review/git-diff'

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

const repo = mkdtempSync(path.join(os.tmpdir(), 'review-service-'))
mkdirSync(path.join(repo, 'src'))
writeFileSync(path.join(repo, 'src', 'a.ts'), ['one', 'two', 'listen()', 'four', 'five', 'six', 'seven'].join('\n'))
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const STATS: DiffStats = {
  repository: true,
  branch: 'feat/x',
  head: 'abc1234def',
  files: [
    { path: 'src/a.ts', added: 7, deleted: 1 },
    { path: 'src/new.ts', added: 30, deleted: 0, isNew: true },
  ],
}

const FINDING_INPUT = {
  severity: 'important',
  title: 'Missing cleanup',
  details: 'The listener is never removed.',
  evidence: 'a.ts:3 adds it; nothing removes it.',
  path: 'src/a.ts',
  line: 3,
  plan_line: 2,
}

type Tools = Record<string, { execute: (input: unknown, options: unknown) => Promise<string> }>

function deps(overrides: Partial<ReviewServiceDeps> = {}) {
  const changes: ReviewJobInfo[] = []
  const reports = new Map<string, ChatReviewReport>()
  let busy = false
  const base: ReviewServiceDeps = {
    getConversation: (id) => (id === 'conv' ? { id, cwd: repo, projectId: 'ws', archived: false } : null),
    isBusy: () => busy,
    pendingPlan: () => ({ plan: '# Plan\n- Add the listener\n- Test it', version: 2 }),
    selection: () => ({ providerId: 'provider-1', modelId: 'model-1', reasoning: 'high', fastMode: false }),
    reviewerOptions: () => ({
      conversation: { providerId: 'provider-1', modelId: 'model-1', reasoning: 'high', fastMode: false },
      last: null,
    }),
    resolveProfile: vi.fn(async () => PROFILE),
    conversationContext: () => '[{"role":"user","content":"add a listener"}]',
    locale: () => 'pt-BR',
    // Each reviewer submits through its own host tool and reads through the recorder, exactly like a real child run.
    runReviewer: vi.fn(async ({ tools, task, recorder }) => {
      // executeSubagent instruments the whole tool set, core read tools included.
      const tool = recorder.instrumentTools({
        ...tools,
        read: { execute: async () => 'src/a.ts:\n1 one' } as never,
      }) as unknown as Tools
      await tool.read.execute({ path: 'src/a.ts', offset: 1, limit: 7 }, {})
      if (tool.record_verdicts)
        await tool.record_verdicts.execute({ verdicts: [{ candidate_id: 'C1', verdict: 'confirmed' }] }, {})
      else if (tool.record_checks)
        await tool.record_checks.execute(
          { results: [{ finding_id: 'F1', state: 'open', note: 'Still added twice.' }] },
          {}
        )
      else if (task.includes('Lens: correctness') || task.includes('Lens: feasibility'))
        await tool.submit_findings.execute({ findings: [FINDING_INPUT] }, {})
      else await tool.submit_findings.execute({ findings: [] }, {})
      return { text: '', usage: { input: 100, output: 10, cacheRead: 0, cacheCreate: 0, totalInput: 100 } }
    }),
    persistReport: vi.fn(({ report }) => {
      reports.set(`review:${report.reviewId}`, report)
      return `review:${report.reviewId}`
    }),
    getReport: (_conversationId, messageId) => reports.get(messageId) ?? null,
    updateReport: vi.fn((_conversationId, messageId, report) => {
      reports.set(messageId, report)
    }),
    persistSpend: vi.fn(),
    onChange: (info) => changes.push(info),
    readStats: vi.fn(async () => STATS),
    now: () => 1_000,
    publishIntervalMs: 0,
    ...overrides,
  }
  return { deps: base, changes, reports, setBusy: (value: boolean) => (busy = value) }
}

type Service = ReturnType<typeof createReviewService>

async function until(service: Service, statuses: ReviewJobInfo['status'][], conversationId = 'conv') {
  await vi.waitFor(() => expect(statuses).toContain(service.status(conversationId)?.status))
  return service.status(conversationId)!
}

describe('review service', () => {
  it('shows what will be reviewed and who can review it, without starting anything or holding the conversation', async () => {
    const { deps: d } = deps()
    const service = createReviewService(d)
    expect(await service.prepare('conv', 'code')).toEqual({
      ok: true,
      scope: {
        kind: 'code',
        branch: 'feat/x',
        head: 'abc1234def',
        files: [
          { path: 'src/new.ts', added: 30, deleted: 0, isNew: true },
          { path: 'src/a.ts', added: 7, deleted: 1 },
        ],
        filesTotal: 2,
        added: 37,
        deleted: 1,
      },
      reviewer: expect.objectContaining({ last: null }),
      lenses: ['correctness', 'integration', 'security'],
    })
    expect(await service.prepare('conv', 'plan')).toMatchObject({
      ok: true,
      scope: { kind: 'plan', version: 2, title: 'Plan', steps: ['Add the listener', 'Test it'] },
      lenses: ['feasibility', 'completeness'],
    })
    expect(service.lockFor('conv')).toBeNull()
    expect(d.runReviewer).not.toHaveBeenCalled()
  })

  it('runs reviewers live, waits for the decisions while holding the conversation, and hands the report off', async () => {
    const { deps: d, changes, reports } = deps()
    const service = createReviewService(d)
    const started = await service.start('conv', { target: 'code' })
    expect(started).toMatchObject({
      ok: true,
      review: { kind: 'review', target: 'code', status: 'running', model: { modelId: 'model-1', reasoning: 'high' } },
    })
    expect(service.lockFor('conv')).toMatchObject({ kind: 'review' })

    const ready = await until(service, ['ready'])
    expect(ready).toMatchObject({
      candidates: 1,
      verification: 'done',
      candidateList: [expect.objectContaining({ id: 'C1', lens: 'correctness' })],
      verdicts: [{ candidateId: 'C1', verdict: 'confirmed', severity: 'important' }],
      draft: { decisions: {}, notes: {}, comments: {} },
    })
    // The finding carries the lines it is about, read from the checkout.
    expect(ready.findings).toEqual([
      expect.objectContaining({
        id: 'F1',
        path: 'src/a.ts',
        line: 3,
        snippet: {
          source: 'file',
          path: 'src/a.ts',
          start: 1,
          lines: ['one', 'two', 'listen()', 'four', 'five', 'six'],
          highlight: 3,
        },
      }),
    ])
    // Each lane shows what its reviewer read.
    expect(ready.activity.correctness).toEqual([
      expect.objectContaining({ kind: 'read', path: 'src/a.ts', range: '1–7', status: 'done' }),
      expect.objectContaining({ kind: 'submit', status: 'done', count: 1 }),
    ])
    expect(ready.activity.verifier?.[0]).toMatchObject({ kind: 'read', path: 'src/a.ts' })
    expect(changes.some((info) => info.status === 'verifying')).toBe(true)
    expect(service.lockFor('conv')).not.toBeNull()

    // Decisions are validated against the findings and the target.
    expect(service.updateDraft('conv', { reviewId: ready.reviewId, decisions: { F1: 'comment', F9: 'fix' } })).toEqual({
      ok: true,
    })
    expect(service.status('conv')?.draft?.decisions).toEqual({})
    expect(service.handoff('conv', { reviewId: ready.reviewId, action: 'send', message: 'Fix it' })).toEqual({
      ok: false,
      error: 'findings-undecided',
    })
    service.updateDraft('conv', {
      reviewId: ready.reviewId,
      decisions: { F1: 'dismiss' },
      notes: { F1: 'On purpose.' },
    })
    expect(service.handoff('conv', { reviewId: ready.reviewId, action: 'send', message: 'Fix it' })).toEqual({
      ok: false,
      error: 'nothing-to-send',
    })
    service.updateDraft('conv', { reviewId: ready.reviewId, decisions: { F1: 'fix' }, notes: { F1: '' } })
    expect(service.handoff('conv', { reviewId: ready.reviewId, action: 'revise' })).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(service.handoff('conv', { reviewId: 'other', action: 'send', message: 'x' })).toEqual({
      ok: false,
      error: 'review-not-open',
    })

    const released = service.lockFor('conv')!.released
    const handed = service.handoff('conv', { reviewId: ready.reviewId, action: 'send', message: 'Fix F1, please.' })
    expect(handed).toEqual({ ok: true, messageId: `review:${ready.reviewId}` })
    await released
    expect(service.lockFor('conv')).toBeNull()
    expect(service.status('conv')).toMatchObject({ status: 'completed', messageId: `review:${ready.reviewId}` })
    expect(d.persistReport).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv',
        spend: expect.objectContaining({ usage: expect.objectContaining({ input: 400 }) }),
      })
    )
    expect(reports.get(`review:${ready.reviewId}`)).toMatchObject({
      target: 'code',
      decisions: { F1: 'fix' },
      scope: { branch: 'feat/x', head: 'abc1234def' },
      handoff: { state: 'sent', at: 1_000, message: 'Fix F1, please.' },
    })
    expect(reports.get(`review:${ready.reviewId}`)?.notes).toBeUndefined()

    // Every reviewer is the read-only reviewer agent, with only its submission tool and the diff.
    const calls = (d.runReviewer as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
      Object.keys(input.tools).sort()
    )
    expect(calls).toContainEqual(['git_diff', 'submit_findings'])
    expect(calls).toContainEqual(['git_diff', 'record_verdicts'])
    expect(REVIEWER_AGENT.tools).toEqual([
      'read',
      'grep',
      'glob',
      'git_diff',
      'submit_findings',
      'record_verdicts',
      'record_checks',
    ])
    expect(d.persistSpend).not.toHaveBeenCalled()
  })

  it('checks the fixes of a sent report and stores the results on the receipt', async () => {
    const { deps: d, reports } = deps()
    const service = createReviewService(d)
    const ready = (await service.start('conv', { target: 'code' })) as { ok: true; review: ReviewJobInfo }
    await until(service, ['ready'])
    service.updateDraft('conv', { reviewId: ready.review.reviewId, decisions: { F1: 'fix' } })
    const { messageId } = service.handoff('conv', {
      reviewId: ready.review.reviewId,
      action: 'send',
      message: 'Fix it',
    }) as {
      messageId: string
    }

    const check = await service.check('conv', messageId)
    expect(check).toMatchObject({
      ok: true,
      review: { kind: 'check', status: 'running', messageId, findings: [expect.objectContaining({ id: 'F1' })] },
    })
    expect(service.lockFor('conv')).toMatchObject({ kind: 'check' })
    // The check reuses the reviewing model, validated like a chosen one.
    expect(d.resolveProfile).toHaveBeenLastCalledWith(
      { providerId: 'provider-1', modelId: 'model-1', reasoning: 'high', fastMode: false },
      { chosen: true }
    )
    const done = await until(service, ['completed'])
    expect(done.checks).toEqual([{ findingId: 'F1', state: 'open', note: 'Still added twice.' }])
    expect(service.lockFor('conv')).toBeNull()
    expect(reports.get(messageId)?.check).toMatchObject({
      status: 'completed',
      results: [{ findingId: 'F1', state: 'open', note: 'Still added twice.' }],
    })
    // A check is billed on its own; the review's usage went with its receipt.
    expect(d.persistSpend).toHaveBeenCalledTimes(1)
  })

  it('refuses checks with nothing to check', async () => {
    const { deps: d, reports } = deps()
    const service = createReviewService(d)
    const base = {
      reviewId: 'r',
      target: 'code',
      findings: [],
      candidates: 0,
      startedAt: 0,
      finishedAt: 0,
    } as ChatReviewReport
    reports.set('saved', { ...base, handoff: { state: 'saved', at: 1 } })
    reports.set('sent', { ...base, handoff: { state: 'sent', at: 1 } })
    reports.set('plan', {
      ...base,
      target: 'plan',
      planVersion: 2,
      handoff: { state: 'revised', at: 1, planVersion: 2 },
      findings: [{ id: 'F1', severity: 'minor', title: 't', details: 'd', lens: 'feasibility' }],
      decisions: { F1: 'comment' },
    })
    expect(await service.check('conv', 'missing')).toEqual({ ok: false, error: 'nothing-to-check' })
    expect(await service.check('conv', 'saved')).toEqual({ ok: false, error: 'nothing-to-check' })
    expect(await service.check('conv', 'sent')).toEqual({ ok: false, error: 'nothing-to-check' })
    // The agent has not sent a revised plan yet: the pending one is still version 2.
    expect(await service.check('conv', 'plan')).toEqual({ ok: false, error: 'no-revision' })
  })

  it('turns plan findings into editable comments and hands a revision off', async () => {
    const { deps: d, reports } = deps()
    const service = createReviewService(d)
    await service.start('conv', { target: 'plan' })
    const ready = await until(service, ['ready'])
    expect(ready).toMatchObject({ planVersion: 2, scope: { kind: 'plan', version: 2 } })
    expect(ready.findings?.[0]).toMatchObject({ planLine: 2, snippet: { source: 'plan', highlight: 2 } })
    // Plan comments start from the finding and can be edited before sending.
    expect(ready.draft?.comments).toEqual({ F1: 'Missing cleanup\n\nThe listener is never removed.' })
    const plan = (d.runReviewer as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => Object.keys(input.tools))
    expect(plan.every((tools) => !tools.includes('git_diff'))).toBe(true)
    expect(service.updateDraft('conv', { reviewId: ready.reviewId, decisions: { F1: 'fix' } })).toEqual({ ok: true })
    expect(service.status('conv')?.draft?.decisions).toEqual({})
    service.updateDraft('conv', {
      reviewId: ready.reviewId,
      decisions: { F1: 'comment' },
      comments: { F1: 'Remove it on stop.' },
    })
    expect(service.handoff('conv', { reviewId: ready.reviewId, action: 'send', message: 'x' })).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    const handed = service.handoff('conv', { reviewId: ready.reviewId, action: 'revise' }) as {
      ok: true
      messageId: string
    }
    expect(handed.ok).toBe(true)
    expect(reports.get(handed.messageId)).toMatchObject({
      target: 'plan',
      planVersion: 2,
      comments: { F1: 'Remove it on stop.' },
      handoff: { state: 'revised', planVersion: 2 },
    })
  })

  it('refuses a plan hand-off when the plan changed while it was reviewed', async () => {
    let version = 2
    const { deps: d } = deps({ pendingPlan: () => ({ plan: '# Plan\n- Add the listener\n- Test it', version }) })
    const service = createReviewService(d)
    await service.start('conv', { target: 'plan' })
    const ready = await until(service, ['ready'])
    version = 3
    expect(service.handoff('conv', { reviewId: ready.reviewId, action: 'approve' })).toEqual({
      ok: false,
      error: 'plan-changed',
    })
    expect(service.lockFor('conv')).not.toBeNull()
  })

  it('discards a ready review without a receipt but still bills it', async () => {
    const { deps: d } = deps()
    const service = createReviewService(d)
    await service.start('conv', { target: 'code' })
    const ready = await until(service, ['ready'])
    expect(service.discard('conv', 'other')).toEqual({ ok: false })
    expect(service.discard('conv', ready.reviewId)).toEqual({ ok: true })
    expect(service.status('conv')?.status).toBe('discarded')
    expect(service.lockFor('conv')).toBeNull()
    expect(d.persistReport).not.toHaveBeenCalled()
    expect(d.persistSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv',
        spend: expect.objectContaining({ usage: expect.objectContaining({ input: 400 }) }),
      })
    )
  })

  it("runs on the conversation's model unless the person chose another reviewer, and refuses bad reviewers", async () => {
    const { deps: d } = deps({ reviewerProviderSupported: (providerId) => providerId !== 'builtin_chatgpt_web' })
    const service = createReviewService(d)
    const reviewer = { providerId: 'provider-2', modelId: 'm', reasoning: 'off', fastMode: false }
    expect(await service.start('conv', { target: 'code', reviewer: { ...reviewer, fastMode: 'yes' } })).toEqual({
      ok: false,
      error: 'invalid-reviewer',
    })
    expect(
      await service.start('conv', { target: 'plan', reviewer: { ...reviewer, providerId: 'builtin_chatgpt_web' } })
    ).toEqual({ ok: false, error: 'reviewer-unsupported' })
    expect(d.resolveProfile).not.toHaveBeenCalled()
    await service.start('conv', { target: 'code', reviewer })
    expect(d.resolveProfile).toHaveBeenLastCalledWith(reviewer, { chosen: true })
    const ready = await until(service, ['ready'])
    service.discard('conv', ready.reviewId)
    await service.start('conv', { target: 'code' })
    expect(d.resolveProfile).toHaveBeenLastCalledWith(
      { providerId: 'provider-1', modelId: 'model-1', reasoning: 'high', fastMode: false },
      { chosen: false }
    )
  })

  it('refuses to start when there is nothing to review, the agent is working, or a review is open', async () => {
    const { deps: d, setBusy } = deps()
    const service = createReviewService(d)
    expect(await service.start('other', { target: 'code' })).toEqual({ ok: false, error: 'invalid-conversation' })
    expect(await service.start('conv', { target: 'docs' })).toEqual({ ok: false, error: 'invalid-input' })
    setBusy(true)
    expect(await service.start('conv', { target: 'code' })).toEqual({ ok: false, error: 'conversation-busy' })
    expect(await service.prepare('conv', 'code')).toEqual({ ok: false, error: 'conversation-busy' })
    setBusy(false)
    ;(d.readStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...STATS, files: [] })
    expect(await service.start('conv', { target: 'code' })).toEqual({ ok: false, error: 'nothing-to-review' })
    ;(d.readStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...STATS, repository: false })
    expect(await service.prepare('conv', 'code')).toEqual({ ok: false, error: 'not-a-repository' })
    await service.start('conv', { target: 'code' })
    expect(await service.start('conv', { target: 'plan' })).toEqual({ ok: false, error: 'review-active' })
    expect(await service.prepare('conv', 'plan')).toEqual({ ok: false, error: 'review-active' })
  })

  it('reports a failure when no reviewer finishes, and frees the conversation', async () => {
    const { deps: d } = deps({
      runReviewer: vi.fn(async () => ({ text: 'I could not finish.', error: 'stream closed' })),
    })
    const service = createReviewService(d)
    await service.start('conv', { target: 'code' })
    const failed = await until(service, ['failed'])
    expect(failed.error).toBe('stream closed')
    expect(service.lockFor('conv')).toBeNull()
    service.forget('conv')
    expect(service.status('conv')).toBeNull()
  })

  it('cancels and discards running reviews, and stops them when the conversation goes away', async () => {
    const pending = () =>
      vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      )
    const { deps: d } = deps({ runReviewer: pending() as never })
    const service = createReviewService(d)
    const first = (await service.start('conv', { target: 'code' })) as { ok: true; review: ReviewJobInfo }
    expect(service.cancel('conv')).toEqual({ ok: true })
    expect((await until(service, ['cancelled'])).status).toBe('cancelled')
    expect(service.cancel('conv')).toEqual({ ok: false })
    expect(first.review.reviewId).toBeTruthy()

    const second = (await service.start('conv', { target: 'code' })) as { ok: true; review: ReviewJobInfo }
    expect(service.discard('conv', second.review.reviewId)).toEqual({ ok: true })
    expect((await until(service, ['discarded'])).status).toBe('discarded')

    await service.start('conv', { target: 'code' })
    await service.close('conv')
    expect(service.status('conv')).toBeNull()
    expect(service.lockFor('conv')).toBeNull()

    await service.start('conv', { target: 'code' })
    await service.dispose()
    expect(service.status('conv')?.status).toBe('cancelled')
  })
})
