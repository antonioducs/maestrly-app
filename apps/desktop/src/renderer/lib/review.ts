import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { HostApi } from '../../preload'
import type { ReviewFinding, ReviewJobInfo, ReviewTarget } from '../../shared/review'

/** Window event the app header uses to start a code review in the conversation that owns it. */
export const REVIEW_CODE_EVENT = 'maestrly:review-code'

export interface ReviewCodeEventDetail {
  conversationId: string
  hostId: string
}

export function requestCodeReview(detail: ReviewCodeEventDetail): void {
  window.dispatchEvent(new CustomEvent<ReviewCodeEventDetail>(REVIEW_CODE_EVENT, { detail }))
}

const KNOWN_ERRORS = new Set([
  'review-active',
  'conversation-busy',
  'conversation-archived',
  'not-a-repository',
  'nothing-to-review',
  'no-pending-plan',
  'no-model',
  'invalid-conversation',
])

/** Localized reason a review could not start or failed; unknown errors are shown as reported. */
export function reviewErrorText(t: TFunction, error: string | undefined): string {
  if (error && KNOWN_ERRORS.has(error)) return t(`review.error.${error}`, { ns: 'chat' })
  return error?.trim() || t('review.error.unknown', { ns: 'chat' })
}

export function isReviewRunning(review: ReviewJobInfo | null | undefined): boolean {
  return review?.status === 'running' || review?.status === 'verifying'
}

/** "2 of 3 reviewers done" while the lenses run, then the verification step. Uses the `chat` namespace. */
export function reviewProgressText(t: TFunction, review: ReviewJobInfo): string {
  if (review.status === 'verifying') {
    return t('review.progressVerifying', { ns: 'chat', count: review.candidates ?? 0 })
  }
  const done = review.lenses.filter((lens) => lens.status === 'done' || lens.status === 'failed').length
  return t('review.progressReviewers', { ns: 'chat', done, total: review.lenses.length })
}

const STAGE: Record<ReviewJobInfo['status'], number> = {
  running: 0,
  verifying: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
}

/**
 * A snapshot read on demand (a start result or a status query) can arrive after events of the same review that are
 * further along; it then keeps the newer one. Events arrive in order and always replace.
 */
export function mergeReviewInfo(current: ReviewJobInfo | null, incoming: ReviewJobInfo | null): ReviewJobInfo | null {
  if (!incoming) return current
  if (current?.reviewId === incoming.reviewId && STAGE[current.status] >= STAGE[incoming.status]) return current
  return incoming
}

/**
 * The conversation's running review, or its last finished one, kept current from main; `start` starts one and shows
 * it at once. It resolves to why the review could not start, or null.
 */
export function useConversationReview(
  api: HostApi,
  conversationId: string
): { review: ReviewJobInfo | null; start: (target: ReviewTarget) => Promise<string | null> } {
  const [review, setReview] = useState<ReviewJobInfo | null>(null)
  const currentConversation = useRef(conversationId)
  useEffect(() => {
    let alive = true
    currentConversation.current = conversationId
    setReview(null)
    void api.chatReviewStatus(conversationId).then((info) => {
      if (alive) setReview((current) => mergeReviewInfo(current, info))
    })
    const off = api.onChatReviewChanged((info) => {
      if (info.conversationId === conversationId) setReview(info)
    })
    return () => {
      alive = false
      off()
    }
  }, [api, conversationId])

  const start = useCallback(
    async (target: ReviewTarget): Promise<string | null> => {
      const show = (info: ReviewJobInfo | null) => {
        if (currentConversation.current === conversationId) setReview((current) => mergeReviewInfo(current, info))
      }
      try {
        const result = await api.chatReviewStart(conversationId, { target })
        if (result.ok) {
          show(result.review)
          return null
        }
        if (result.error !== 'review-active') return result.error
        // Already running: show it, unless it reviews something else, which this surface does not display.
        const running = await api.chatReviewStatus(conversationId)
        show(running)
        return running?.target === target ? null : result.error
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    [api, conversationId]
  )
  return { review, start }
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const HEADING = /^\s{0,3}#{1,6}\s/
const QUOTE = /^\s{0,3}>/
const FENCE = /^\s{0,3}(```|~~~)/
const TABLE = /^\s*\|/

/**
 * Plan lines where the Markdown viewer can hold a comment: the first line of a paragraph, heading, list item or quote,
 * outside fenced code and tables.
 */
export function commentablePlanLines(plan: string): Set<number> {
  const lines = plan.split('\n')
  const out = new Set<number>()
  let fence: string | null = null
  let previousBlank = true
  let previousHeading = false
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null
      previousBlank = false
      previousHeading = false
      return
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      previousBlank = false
      previousHeading = false
      return
    }
    const blank = !line.trim()
    const heading = HEADING.test(line)
    if (
      !blank &&
      !TABLE.test(line) &&
      (previousBlank || previousHeading || heading || LIST_ITEM.test(line) || QUOTE.test(line))
    ) {
      out.add(index + 1)
    }
    previousBlank = blank
    previousHeading = heading
  })
  return out
}

/** The commentable line at or before `line`, or null when the finding cannot sit on the plan. */
export function snapToCommentableLine(commentable: ReadonlySet<number>, line: number | undefined): number | null {
  if (!line || line < 1) return null
  for (let candidate = line; candidate >= 1; candidate--) if (commentable.has(candidate)) return candidate
  return null
}

function findingText(t: TFunction, finding: ReviewFinding): string {
  const where = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : ''
  const parts = [
    `[${t(`review.severity.${finding.severity}`, { ns: 'chat' })}] ${finding.title}${where}`,
    finding.details,
  ]
  if (finding.suggestion) parts.push(`${t('review.suggestion', { ns: 'chat' })}: ${finding.suggestion}`)
  return parts.join('\n')
}

/**
 * Adds plan review findings to the person's draft: a finding anchored to a plan line becomes (or extends) that line's
 * comment; the rest are appended to the general feedback. The person edits or removes them before asking for a
 * revision.
 */
export function mergePlanReviewFindings(
  t: TFunction,
  plan: string,
  findings: readonly ReviewFinding[],
  draft: { lineComments: Record<number, string>; feedback: string }
): { lineComments: Record<number, string>; feedback: string } {
  const commentable = commentablePlanLines(plan)
  const lineComments = { ...draft.lineComments }
  const general: string[] = []
  for (const finding of findings) {
    const line = snapToCommentableLine(commentable, finding.planLine)
    const text = findingText(t, finding)
    if (line === null) {
      general.push(text)
      continue
    }
    const existing = lineComments[line]?.trim()
    lineComments[line] = existing ? `${existing}\n\n${text}` : text
  }
  const feedback = [draft.feedback.trim(), ...general].filter(Boolean).join('\n\n')
  return { lineComments, feedback }
}
