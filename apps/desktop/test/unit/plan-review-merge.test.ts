import { describe, expect, it } from 'vitest'
import {
  commentablePlanLines,
  mergeReviewInfo,
  planReviewRevision,
  roomReview,
  snapToCommentableLine,
} from '../../src/renderer/lib/review'
import type { ReviewFinding, ReviewJobInfo } from '../../src/shared/review'

const plan = [
  '# Plan', // 1
  'Intro paragraph', // 2
  'continues here.', // 3
  '', // 4
  '- Step one', // 5
  '  detail of step one', // 6
  '- Step two', // 7
  '', // 8
  '```ts', // 9
  'const x = 1', // 10
  '```', // 11
  '| a | b |', // 12
  '', // 13
  '> Note', // 14
].join('\n')

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: 'F1',
    severity: 'important',
    title: 'Missing migration',
    details: 'Stored rows keep the old shape.',
    lens: 'completeness',
    ...overrides,
  }
}

describe('plan review findings', () => {
  it('knows which plan lines the viewer can hold a comment on', () => {
    expect([...commentablePlanLines(plan)].sort((a, b) => a - b)).toEqual([1, 2, 5, 7, 14])
  })

  it('snaps a finding to the block that contains its line', () => {
    const lines = commentablePlanLines(plan)
    expect(snapToCommentableLine(lines, 3)).toBe(2)
    expect(snapToCommentableLine(lines, 6)).toBe(5)
    expect(snapToCommentableLine(lines, 10)).toBe(7)
    expect(snapToCommentableLine(lines, undefined)).toBeNull()
    expect(snapToCommentableLine(new Set(), 3)).toBeNull()
  })

  it("turns commented findings into the revision request, keeping the person's own comments and feedback", () => {
    const findings = [
      finding({ planLine: 6 }),
      finding({ id: 'F2', severity: 'blocking', title: 'Wrong API', planLine: 7 }),
      finding({ id: 'F3', severity: 'minor', title: 'No tests planned' }),
      finding({ id: 'F4', title: 'Dismissed one', planLine: 2 }),
    ]
    const revision = planReviewRevision(
      plan,
      findings,
      {
        decisions: { F1: 'comment', F2: 'comment', F3: 'comment', F4: 'dismiss' },
        comments: { F1: 'Add a backfill step.', F2: '  ', F3: 'Plan a test.' },
      },
      { lineComments: { 7: 'Mine.' }, feedback: 'Overall fine.' }
    )
    expect(revision.lineComments).toEqual([
      { line: 5, text: 'Add a backfill step.' },
      // An emptied comment falls back to the finding's title.
      { line: 7, text: 'Mine.\n\nWrong API' },
    ])
    expect(revision.feedback).toBe('Overall fine.\n\nF3: Plan a test.')
    expect(planReviewRevision(plan, findings, { decisions: {}, comments: {} })).toEqual({
      lineComments: [],
      feedback: '',
    })
  })
})

describe('review state from a start result', () => {
  const info = (
    reviewId: string,
    status: ReviewJobInfo['status'],
    kind: ReviewJobInfo['kind'] = 'review'
  ): ReviewJobInfo => ({
    reviewId,
    conversationId: 'conv',
    kind,
    target: 'plan',
    status,
    startedAt: 0,
    lenses: [],
    verification: 'pending',
    activity: {},
    candidateList: [],
    verdicts: [],
  })

  it('shows a review it just started, but never moves the same review backwards', () => {
    expect(mergeReviewInfo(null, info('r1', 'running'))).toEqual(info('r1', 'running'))
    expect(mergeReviewInfo(info('r1', 'verifying'), info('r1', 'running'))?.status).toBe('verifying')
    expect(mergeReviewInfo(info('r1', 'completed'), info('r1', 'running'))?.status).toBe('completed')
    expect(mergeReviewInfo(info('r1', 'running'), info('r1', 'verifying'))?.status).toBe('verifying')
    // A new review replaces the last finished one.
    expect(mergeReviewInfo(info('r1', 'completed'), info('r2', 'running'))?.reviewId).toBe('r2')
    expect(mergeReviewInfo(info('r1', 'failed'), null)?.reviewId).toBe('r1')
    expect(mergeReviewInfo(info('r1', 'ready'), info('r1', 'verifying'))?.status).toBe('ready')
    // A check of the same review is a different job.
    expect(mergeReviewInfo(info('r1', 'completed'), info('r1', 'running', 'check'))?.kind).toBe('check')
  })

  it('shows the room for an open or failed review, never for a check', () => {
    expect(roomReview(info('r1', 'running'), null)?.reviewId).toBe('r1')
    expect(roomReview(info('r1', 'ready'), null)?.reviewId).toBe('r1')
    expect(roomReview(info('r1', 'failed'), null)?.reviewId).toBe('r1')
    expect(roomReview(info('r1', 'failed'), 'r1')).toBeNull()
    expect(roomReview(info('r1', 'completed'), null)).toBeNull()
    expect(roomReview(info('r1', 'running', 'check'), null)).toBeNull()
  })
})
