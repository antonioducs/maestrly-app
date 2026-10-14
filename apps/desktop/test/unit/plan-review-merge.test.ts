import { describe, expect, it } from 'vitest'
import {
  commentablePlanLines,
  mergePlanReviewFindings,
  mergeReviewInfo,
  snapToCommentableLine,
} from '../../src/renderer/lib/review'
import { tFor } from '../../src/shared/i18n'
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

const t = tFor('en', 'chat') as never

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

  it('adds findings to line comments and general feedback without losing the draft', () => {
    const merged = mergePlanReviewFindings(
      t,
      plan,
      [
        finding({ planLine: 6, suggestion: 'Add a backfill step.' }),
        finding({ id: 'F2', severity: 'blocking', title: 'Wrong API', planLine: 7, path: 'src/api.ts', line: 9 }),
        finding({ id: 'F3', severity: 'minor', title: 'No tests planned' }),
      ],
      { lineComments: { 7: 'Mine.' }, feedback: 'Overall fine.' }
    )
    expect(merged.lineComments[5]).toBe(
      '[important] Missing migration\nStored rows keep the old shape.\nSuggestion: Add a backfill step.'
    )
    expect(merged.lineComments[7]).toBe('Mine.\n\n[blocking] Wrong API (src/api.ts:9)\nStored rows keep the old shape.')
    expect(merged.feedback).toBe('Overall fine.\n\n[minor] No tests planned\nStored rows keep the old shape.')
  })
})

describe('review state from a start result', () => {
  const info = (reviewId: string, status: ReviewJobInfo['status']): ReviewJobInfo => ({
    reviewId,
    conversationId: 'conv',
    target: 'plan',
    status,
    startedAt: 0,
    lenses: [],
    verification: 'pending',
  })

  it('shows a review it just started, but never moves the same review backwards', () => {
    expect(mergeReviewInfo(null, info('r1', 'running'))).toEqual(info('r1', 'running'))
    expect(mergeReviewInfo(info('r1', 'verifying'), info('r1', 'running'))?.status).toBe('verifying')
    expect(mergeReviewInfo(info('r1', 'completed'), info('r1', 'running'))?.status).toBe('completed')
    expect(mergeReviewInfo(info('r1', 'running'), info('r1', 'verifying'))?.status).toBe('verifying')
    // A new review replaces the last finished one.
    expect(mergeReviewInfo(info('r1', 'completed'), info('r2', 'running'))?.reviewId).toBe('r2')
    expect(mergeReviewInfo(info('r1', 'failed'), null)?.reviewId).toBe('r1')
  })
})
