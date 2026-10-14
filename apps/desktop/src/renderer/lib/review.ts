import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import type { HostApi } from '../../preload'
import type { ReviewFinding, ReviewJobInfo } from '../../shared/review'

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

/** The conversation's running review, or its last finished one, kept current from main. */
export function useConversationReview(api: HostApi, conversationId: string): ReviewJobInfo | null {
  const [review, setReview] = useState<ReviewJobInfo | null>(null)
  useEffect(() => {
    let alive = true
    setReview(null)
    void api.chatReviewStatus(conversationId).then((info) => {
      if (alive) setReview((current) => current ?? info)
    })
    const off = api.onChatReviewChanged((info) => {
      if (info.conversationId === conversationId) setReview(info)
    })
    return () => {
      alive = false
      off()
    }
  }, [api, conversationId])
  return review
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
