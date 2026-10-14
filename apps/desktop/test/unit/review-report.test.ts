import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  isConversationContextMessage,
  listChatMessages,
  listConversationContextMessages,
  listUndeliveredReviewReports,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import { reviewReportForModel, reviewReportMarkdown, reviewReportPart } from '../../src/main/chat/review/report'
import { parseChatReviewReport, reviewActedFindings, type ChatReviewReport } from '../../src/shared/review'
import { tFor } from '../../src/shared/i18n'

beforeEach(freshDb)
afterEach(closeDb)

const report: ChatReviewReport = {
  reviewId: 'r1',
  target: 'code',
  findings: [
    {
      id: 'F1',
      severity: 'blocking',
      title: 'Lost update',
      details: 'Two writers overwrite each other.',
      evidence: 'store.ts:40 reads then writes without a transaction.',
      suggestion: 'Wrap both in one transaction.',
      path: 'src/store.ts',
      line: 40,
      lens: 'integration',
      candidateId: 'C2',
      merged: ['C4'],
      snippet: { source: 'file', path: 'src/store.ts', start: 38, lines: ['a', 'b', 'c'], highlight: 40 },
    },
    {
      id: 'F2',
      severity: 'minor',
      title: 'Loose check',
      details: 'An empty name passes.',
      lens: 'correctness',
      fromSeverity: 'important',
      unverified: true,
    },
  ],
  candidates: 4,
  model: { providerId: 'provider-1', modelId: 'model-1', reasoning: 'high' },
  startedAt: 1,
  finishedAt: 61_000,
  scope: { branch: 'feat/x', head: 'abcdef0123456789' },
  decisions: { F1: 'fix', F2: 'dismiss' },
  notes: { F2: 'Names are validated upstream.' },
  dropped: [
    { id: 'C3', lens: 'security', severity: 'minor', title: 'Style', verdict: 'discarded', reason: 'Not a defect.' },
    { id: 'C4', lens: 'correctness', severity: 'blocking', title: 'Same race', verdict: 'merged', into: 'C2' },
  ],
  handoff: { state: 'sent', at: 70_000, message: 'Fix F1.' },
}

function conversation() {
  return makeConversation(makeWorkspace().id, { mode: 'local' })
}

function storeReport(conversationId: string, id: string, value: ChatReviewReport = report) {
  upsertChatMessage({
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}:text`, text: 'report' }],
    source: 'maestrly-review',
    executionScope: { kind: 'review-report', reviewId: value.reviewId },
    review: value,
    createdAt: Date.now(),
  })
}

function storeText(conversationId: string, id: string, role: 'user' | 'assistant') {
  upsertChatMessage({
    id,
    conversationId,
    role,
    parts: [{ type: 'text', id: `${id}:t`, text: id }],
    createdAt: Date.now(),
  })
}

describe('review receipts', () => {
  it('render a readable copy and a model-facing attachment with the decisions', () => {
    const markdown = reviewReportMarkdown(report, tFor('pt-BR', 'prompts'))
    expect(markdown).toContain('**Revisão de código: 2 achados**')
    expect(markdown).toContain('**F1 · bloqueante** [corrigir] — Lost update (`src/store.ts:40`)')
    expect(markdown).toContain('Sugestão: Wrap both in one transaction.')
    expect(reviewReportMarkdown({ ...report, findings: [] }, tFor('en', 'prompts'))).toBe(
      '**Code review: no problems found.**'
    )
    expect(reviewReportMarkdown({ ...report, target: 'plan', findings: [] }, tFor('en', 'prompts'))).toBe(
      '**Plan review: no problems found.**'
    )
    const forModel = reviewReportForModel(report)
    expect(forModel).toContain('Follow their message.')
    expect(forModel).toContain('## F1 [blocking] Lost update')
    expect(forModel).toContain('Decision: fix')
    expect(forModel).toContain('Decision: dismissed by the person')
    expect(forModel).toContain('Why: Names are validated upstream.')
    expect(forModel).toContain('Unconfirmed: the verifier did not rule on it.')
    expect(forModel).toContain('Location: src/store.ts:40')
    expect(forModel).toContain('Reviewed: branch feat/x at abcdef012345.')
    expect(reviewReportPart(report)).toMatchObject({ type: 'file', name: 'code-review.md', kind: 'text', hidden: true })
  })

  it('stay out of the model context and are delivered only once they are sent, oldest first', () => {
    const conv = conversation()
    storeText(conv.id, 'u1', 'user')
    storeText(conv.id, 'a1', 'assistant')
    storeReport(conv.id, 'review:saved', { ...report, reviewId: 'saved', handoff: { state: 'saved', at: 1 } })
    storeReport(conv.id, 'review:r1')
    storeReport(conv.id, 'review:r2', { ...report, reviewId: 'r2' })
    storeReport(conv.id, 'review:done', {
      ...report,
      reviewId: 'done',
      handoff: { state: 'sent', at: 1, deliveredAt: 2 },
    })
    storeReport(conv.id, 'review:plan', {
      ...report,
      reviewId: 'plan',
      target: 'plan',
      handoff: { state: 'revised', at: 1 },
    })

    const stored = listChatMessages(conv.id).find((message) => message.id === 'review:r1')!
    expect(stored).toMatchObject({ source: 'maestrly-review', review: report })
    expect(isConversationContextMessage(stored)).toBe(false)
    expect(listConversationContextMessages(conv.id).map((message) => message.id)).toEqual(['u1', 'a1'])
    // A saved report, one already delivered and a plan receipt never ride along with a message.
    expect(listUndeliveredReviewReports(conv.id).map((message) => message.id)).toEqual(['review:r1', 'review:r2'])
  })

  it('parse stored receipts defensively', () => {
    expect(parseChatReviewReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
    expect(parseChatReviewReport({ ...report, target: 'diff' })).toBeUndefined()
    expect(parseChatReviewReport({ reviewId: 'x', target: 'code' })).toBeUndefined()
    const parsed = parseChatReviewReport({
      ...report,
      findings: [{ ...report.findings[0], severity: 'nit' }, report.findings[0], { id: 'F2' }],
      failedLenses: ['security', 'unknown'],
      candidates: 0,
      decisions: { F1: 'fix', F9: 'fix', F2: 'maybe' },
      notes: { F1: '  ', F9: 'gone' },
      dropped: [{ id: 'C1', lens: 'nope' }, report.dropped![0]],
      handoff: { state: 'shipped', at: 1 },
      check: {
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
        results: [
          { findingId: 'F1', state: 'open', note: 'Still racy.' },
          { findingId: 'F1', state: 'resolved' },
          { findingId: 'F9', state: 'open' },
          { findingId: 'F1', state: 'maybe' },
        ],
      },
    })
    expect(parsed?.findings).toHaveLength(1)
    expect(parsed?.failedLenses).toEqual(['security'])
    expect(parsed?.candidates).toBe(1)
    expect(parsed?.decisions).toEqual({ F1: 'fix' })
    expect(parsed?.notes).toBeUndefined()
    expect(parsed?.dropped).toEqual([report.dropped![0]])
    expect(parsed?.handoff).toBeUndefined()
    expect(parsed?.check?.results).toEqual([{ findingId: 'F1', state: 'open', note: 'Still racy.' }])
  })

  it('know which findings the hand-off acted on', () => {
    expect(reviewActedFindings(report).map((finding) => finding.id)).toEqual(['F1'])
    expect(
      reviewActedFindings({ ...report, target: 'plan', decisions: { F1: 'comment', F2: 'dismiss' } }).map(
        (finding) => finding.id
      )
    ).toEqual(['F1'])
  })
})
