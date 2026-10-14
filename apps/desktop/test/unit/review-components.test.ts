import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatReviewReport, ReviewJobInfo } from '../../src/shared/review'

vi.mock('react-i18next', async () => {
  const { tFor } = await import('../../src/shared/i18n')
  return { useTranslation: (ns: 'chat' | 'ui') => ({ t: tFor('en', ns) }) }
})
import {
  ReviewReceiptCard,
  type ReviewReceiptActions,
} from '../../src/renderer/components/chat/review/ReviewReceiptCard'
import {
  buildEvidenceMap,
  composeReviewHandoff,
  formatReviewClock,
  formatReviewDuration,
  nextUndecided,
} from '../../src/renderer/lib/review'
import { tFor } from '../../src/shared/i18n'

const t = tFor('en', 'chat') as never

const report: ChatReviewReport = {
  reviewId: 'r1',
  target: 'code',
  findings: [
    {
      id: 'F1',
      severity: 'blocking',
      title: 'Each worker keeps its own buckets',
      details: 'Two workers double the limit.',
      path: 'src/export/rate-limit.ts',
      line: 5,
      lens: 'integration',
    },
    {
      id: 'F2',
      severity: 'important',
      title: 'Client key comes from X-Forwarded-For',
      details: 'Any caller can set it.',
      lens: 'security',
    },
    {
      id: 'F3',
      severity: 'minor',
      title: 'Refill test is loose',
      details: 'Passes with a wrong rate.',
      lens: 'correctness',
    },
  ],
  candidates: 7,
  model: { providerId: 'p', modelId: 'claude-opus-5', reasoning: 'max', fastMode: true },
  startedAt: 0,
  finishedAt: 125_000,
  decisions: { F1: 'fix', F2: 'fix', F3: 'dismiss' },
  notes: { F3: 'The integration test covers it.' },
  dropped: [
    { id: 'C5', lens: 'security', severity: 'minor', title: 'Style', verdict: 'discarded', reason: 'Not a defect.' },
  ],
  handoff: { state: 'sent', at: 130_000, message: 'Fix F1 and F2.' },
}

const actions: ReviewReceiptActions = {
  send: () => undefined,
  check: async () => null,
  sendBack: () => undefined,
  errorText: (error) => error,
}

const render = (props: Partial<Parameters<typeof ReviewReceiptCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(ReviewReceiptCard, { messageId: 'review:r1', report, actions, ...props }))

describe('review receipt', () => {
  it('shows the decisions, where the hand-off stands and offers to check the fixes', () => {
    const html = render()
    expect(html).toContain('Code review')
    expect(html).toContain('claude-opus-5 · max · Fast · 2m 05s · 7 candidates → 3 confirmed')
    for (const step of ['Reviewed', 'Decided', 'Sent', 'Agent fixing', 'Check the fixes']) expect(html).toContain(step)
    expect(html).toContain('Fix</span>')
    expect(html).toContain('Dismissed</span>')
    expect(html).toContain('What the verifier dropped (1)')
    expect(html).toContain('One verifier pass over F1, F2')
  })

  it('shows the agent working while it works, and the check live while it runs', () => {
    expect(render({ busy: true })).toContain('The agent is working on F1, F2.')
    const live: ReviewJobInfo = {
      reviewId: 'r1',
      conversationId: 'conv',
      kind: 'check',
      target: 'code',
      status: 'running',
      startedAt: 0,
      lenses: [],
      verification: 'running',
      activity: {},
      candidateList: [],
      verdicts: [],
      messageId: 'review:r1',
      checks: [{ findingId: 'F1', state: 'resolved', note: 'Redis now.' }],
    }
    const html = render({ check: live })
    expect(html).toContain('Holds up')
    expect(html).toContain('Checking F2… the conversation is paused until the check ends.')
    // A check of another receipt does not show here.
    expect(render({ check: { ...live, messageId: 'review:other' } })).not.toContain('Holds up')
  })

  it('offers to send open findings back after a check, and closes when every fix holds', () => {
    const open = render({
      report: {
        ...report,
        check: {
          status: 'completed',
          startedAt: 1,
          finishedAt: 2,
          results: [
            { findingId: 'F1', state: 'open', note: 'The key is shared with imports.' },
            { findingId: 'F2', state: 'resolved' },
          ],
        },
      },
    })
    expect(open).toContain('1 finding is still open.')
    expect(open).toContain('The key is shared with imports.')
    expect(open).toContain('Send F1 back to the agent')
    const closed = render({
      report: {
        ...report,
        check: {
          status: 'completed',
          startedAt: 1,
          finishedAt: 2,
          results: [
            { findingId: 'F1', state: 'resolved' },
            { findingId: 'F2', state: 'resolved' },
          ],
        },
      },
    })
    expect(closed).toContain('All 2 fixes hold up. This review is closed.')
  })

  it('offers to send a saved report, and shows plan receipts in their own words', () => {
    const saved = render({ report: { ...report, handoff: { state: 'saved', at: 1 } } })
    expect(saved).toContain('Not sent yet. The agent sees this report once you send it.')
    expect(saved).toContain('Report saved')
    expect(render({ report: { ...report, handoff: { state: 'saved', at: 1 } }, actions: undefined })).not.toContain(
      '<button type="button" class="inline-flex h-7'
    )
    const plan = render({
      report: {
        ...report,
        target: 'plan',
        decisions: { F1: 'comment', F2: 'dismiss', F3: 'dismiss' },
        handoff: { state: 'revised', at: 1, planVersion: 2 },
      },
    })
    expect(plan).toContain('Plan review')
    expect(plan).toContain('Revision requested')
    expect(plan).toContain('Check the revision')
    expect(render({ report: { ...report, target: 'plan', handoff: { state: 'approved', at: 1 } } })).toContain(
      'Plan approved as written.'
    )
  })
})

describe('review room helpers', () => {
  it('builds the hand-off message from the decisions', () => {
    expect(
      composeReviewHandoff(t, report.findings, {
        decisions: { F1: 'fix', F2: 'discuss', F3: 'dismiss' },
        notes: report.notes!,
      })
    ).toBe(
      [
        'Fix these review findings and verify the fixes:',
        '- F1 Each worker keeps its own buckets (src/export/rate-limit.ts:5)',
        '',
        'Before changing anything, tell me what you think of:',
        '- F2 Client key comes from X-Forwarded-For',
        '',
        'Skip these; I decided against them:',
        '- F3 Refill test is loose — The integration test covers it.',
      ].join('\n')
    )
  })

  it('moves to the next undecided finding, wrapping around', () => {
    expect(nextUndecided(report.findings, { decisions: { F2: 'fix' }, notes: {}, comments: {} }, 0)).toBe(2)
    expect(nextUndecided(report.findings, { decisions: { F2: 'fix', F3: 'fix' }, notes: {}, comments: {} }, 2)).toBe(0)
    expect(nextUndecided(report.findings, { decisions: report.decisions!, notes: {}, comments: {} }, 0)).toBe(-1)
  })

  it('maps who read what, in the change and outside it, and where candidates point', () => {
    const review: ReviewJobInfo = {
      reviewId: 'r1',
      conversationId: 'conv',
      kind: 'review',
      target: 'code',
      status: 'verifying',
      startedAt: 0,
      lenses: [{ id: 'correctness', status: 'done' }],
      verification: 'running',
      activity: {
        correctness: [
          { id: 'a', kind: 'read', text: 'src/a.ts', path: 'src/a.ts', status: 'done' },
          { id: 'b', kind: 'grep', text: 'Date.now(', files: ['src/a.ts', 'src/server.ts'], status: 'done', count: 3 },
        ],
        verifier: [{ id: 'c', kind: 'read', text: 'src/server.ts', path: 'src/server.ts', status: 'done' }],
      },
      candidateList: [
        { id: 'C1', lens: 'correctness', severity: 'minor', title: 'x', path: 'src/server.ts' },
        { id: 'C2', lens: 'correctness', severity: 'blocking', title: 'y', path: 'src/server.ts' },
        { id: 'C3', lens: 'correctness', severity: 'blocking', title: 'z', path: 'src/a.ts' },
      ],
      verdicts: [{ candidateId: 'C3', verdict: 'discarded', reason: 'no' }],
      scope: {
        kind: 'code',
        branch: 'b',
        head: 'h',
        files: [
          { path: 'src/a.ts', added: 3, deleted: 1 },
          { path: 'src/untouched.ts', added: 1, deleted: 0 },
        ],
        filesTotal: 2,
        added: 4,
        deleted: 1,
      },
    }
    expect(buildEvidenceMap(review)).toEqual([
      { path: 'src/a.ts', inScope: true, added: 3, deleted: 1, touches: { correctness: 2 }, flags: 0 },
      { path: 'src/untouched.ts', inScope: true, added: 1, deleted: 0, touches: {}, flags: 0 },
      {
        path: 'src/server.ts',
        inScope: false,
        touches: { correctness: 1, verifier: 1 },
        flags: 2,
        severity: 'blocking',
      },
    ])
  })

  it('formats the clock and durations', () => {
    expect(formatReviewClock(67_000)).toBe('1:07')
    expect(formatReviewDuration(5_000)).toBe('5s')
    expect(formatReviewDuration(125_000)).toBe('2m 05s')
  })
})
