import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  isConversationContextMessage,
  listChatMessages,
  listConversationContextMessages,
  listReviewReportsSinceLastUserMessage,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import { pendingReviewReportParts, reviewReportForModel, reviewReportMarkdown } from '../../src/main/chat/review/report'
import { parseChatReviewReport, type ChatReviewReport } from '../../src/shared/review'
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
    },
  ],
  candidates: 3,
  model: { providerId: 'provider-1', modelId: 'model-1' },
  startedAt: 1,
  finishedAt: 61_000,
  scope: { branch: 'feat/x', head: 'abcdef0123456789' },
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

describe('code review reports', () => {
  it('render a readable copy and a model-facing attachment', () => {
    const markdown = reviewReportMarkdown(report, tFor('pt-BR', 'prompts'))
    expect(markdown).toContain('**Revisão de código: 1 achado**')
    expect(markdown).toContain('**F1 · bloqueante** — Lost update (`src/store.ts:40`)')
    expect(markdown).toContain('Sugestão: Wrap both in one transaction.')
    expect(reviewReportMarkdown({ ...report, findings: [] }, tFor('en', 'prompts'))).toBe(
      '**Code review: no problems found.**'
    )
    const forModel = reviewReportForModel(report)
    expect(forModel).toContain('Treat each finding as a claim to check against the code')
    expect(forModel).toContain('## F1 [blocking] Lost update')
    expect(forModel).toContain('Location: src/store.ts:40')
    expect(forModel).toContain('Reviewed: branch feat/x at abcdef012345.')
  })

  it('stay out of the model context and reach it once, with the next message', () => {
    const conv = conversation()
    storeText(conv.id, 'u1', 'user')
    storeText(conv.id, 'a1', 'assistant')
    storeReport(conv.id, 'review:r1')

    const stored = listChatMessages(conv.id).find((message) => message.id === 'review:r1')!
    expect(stored).toMatchObject({ source: 'maestrly-review', review: report })
    expect(isConversationContextMessage(stored)).toBe(false)
    expect(listConversationContextMessages(conv.id).map((message) => message.id)).toEqual(['u1', 'a1'])

    const parts = pendingReviewReportParts(conv.id)
    expect(parts).toEqual([
      expect.objectContaining({ type: 'file', name: 'code-review.md', kind: 'text', hidden: true }),
    ])
    expect((parts[0] as { data: string }).data).toContain('Lost update')

    // Once the person sends a message, the report is behind it and no longer pending.
    storeText(conv.id, 'u2', 'user')
    expect(listReviewReportsSinceLastUserMessage(conv.id)).toEqual([])
    expect(pendingReviewReportParts(conv.id)).toEqual([])
  })

  it('attach every report since the last message, oldest first', () => {
    const conv = conversation()
    storeText(conv.id, 'u1', 'user')
    storeReport(conv.id, 'review:r1')
    storeReport(conv.id, 'review:r2', { ...report, reviewId: 'r2', findings: [] })
    const parts = pendingReviewReportParts(conv.id) as Array<{ data: string }>
    expect(parts).toHaveLength(2)
    expect(parts[0].data).toContain('Lost update')
    expect(parts[1].data).toContain('Result: no problems found.')
  })

  it('parse stored reports defensively', () => {
    expect(parseChatReviewReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
    expect(parseChatReviewReport({ ...report, target: 'plan' })).toBeUndefined()
    expect(parseChatReviewReport({ reviewId: 'x', target: 'code' })).toBeUndefined()
    const parsed = parseChatReviewReport({
      ...report,
      findings: [{ ...report.findings[0], severity: 'nit' }, report.findings[0], { id: 'F2' }],
      failedLenses: ['security', 'unknown'],
      candidates: 0,
    })
    expect(parsed?.findings).toHaveLength(1)
    expect(parsed?.failedLenses).toEqual(['security'])
    expect(parsed?.candidates).toBe(1)
  })
})
