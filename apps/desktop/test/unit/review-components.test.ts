import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatReviewReport, ReviewJobInfo } from '../../src/shared/review'

vi.mock('react-i18next', async () => {
  const { tFor } = await import('../../src/shared/i18n')
  return { useTranslation: (ns: 'chat' | 'ui') => ({ t: tFor('en', ns) }) }
})
import {
  ReviewReportCard,
  formatReviewDuration,
  reviewFindingIds,
} from '../../src/renderer/components/chat/ReviewReportCard'
import { ReviewStatusBanner } from '../../src/renderer/components/chat/ReviewStatusBanner'

const report: ChatReviewReport = {
  reviewId: 'r1',
  target: 'code',
  findings: [
    {
      id: 'F1',
      severity: 'blocking',
      title: 'Lost update',
      details: 'Two writers overwrite each other.',
      path: 'src/store.ts',
      line: 40,
      lens: 'integration',
    },
    { id: 'F2', severity: 'minor', title: 'Unused branch', details: 'Never reached.', lens: 'correctness' },
  ],
  candidates: 5,
  failedLenses: ['security'],
  model: { providerId: 'p', modelId: 'model-x' },
  startedAt: 0,
  finishedAt: 125_000,
}

const running: ReviewJobInfo = {
  reviewId: 'r2',
  conversationId: 'conv',
  target: 'code',
  status: 'running',
  startedAt: 0,
  lenses: [
    { id: 'correctness', status: 'done', candidates: 1 },
    { id: 'integration', status: 'running' },
    { id: 'security', status: 'failed' },
  ],
  verification: 'pending',
}

describe('review components', () => {
  it('renders a report with severities, locations, discarded candidates and actions', () => {
    const html = renderToStaticMarkup(createElement(ReviewReportCard, { report, onAction: () => undefined }))
    expect(html).toContain('Code review')
    expect(html).toContain('model-x · 2m 5s')
    expect(html).toContain('2 findings · 1 blocking · 1 minor')
    expect(html).toContain('The verifier discarded 3 candidates it could not confirm.')
    expect(html).toContain('These reviewers did not finish: security and tests.')
    expect(html).toContain('Lost update')
    expect(html).toContain('src/store.ts:40')
    expect(html).toContain('Discuss with the model')
    // Minor findings start unselected, so only F1 is chosen.
    expect(html).toContain('Fix selected (1)')
  })

  it('renders a clean report without actions, and no actions where the conversation is read-only', () => {
    const clean = renderToStaticMarkup(
      createElement(ReviewReportCard, { report: { ...report, findings: [], failedLenses: undefined, candidates: 0 } })
    )
    expect(clean).toContain('No problems found.')
    expect(clean).not.toContain('Discuss with the model')
    expect(renderToStaticMarkup(createElement(ReviewReportCard, { report }))).not.toContain('type="checkbox"')
  })

  it('shows progress with the reviewing model, and failures, above the composer', () => {
    const props = { onCancel: () => undefined, onDismiss: () => undefined }
    expect(renderToStaticMarkup(createElement(ReviewStatusBanner, { ...props, review: running }))).toContain(
      '2 of 3 reviewers done'
    )
    expect(
      renderToStaticMarkup(
        createElement(ReviewStatusBanner, {
          ...props,
          review: { ...running, model: { providerId: 'p', modelId: 'reviewer-model' } },
        })
      )
    ).toContain('2 of 3 reviewers done · reviewer-model')
    expect(
      renderToStaticMarkup(
        createElement(ReviewStatusBanner, {
          ...props,
          review: { ...running, status: 'verifying', candidates: 4 },
        })
      )
    ).toContain('verifying 4 findings')
    expect(
      renderToStaticMarkup(
        createElement(ReviewStatusBanner, {
          ...props,
          review: { ...running, status: 'failed', error: 'stream closed' },
        })
      )
    ).toContain('The review failed: stream closed')
    expect(renderToStaticMarkup(createElement(ReviewStatusBanner, { ...props, review: null }))).toBe('')
    expect(
      renderToStaticMarkup(createElement(ReviewStatusBanner, { ...props, review: { ...running, target: 'plan' } }))
    ).toBe('')
  })

  it('formats durations and finding references', () => {
    expect(formatReviewDuration(42_400)).toBe('42s')
    expect(formatReviewDuration(180_000)).toBe('3m')
    expect(reviewFindingIds(report.findings)).toBe('F1, F2')
  })
})
