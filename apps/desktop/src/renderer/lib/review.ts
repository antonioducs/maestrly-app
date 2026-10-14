import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { HostApi } from '../../preload'
import {
  reviewLocksConversation,
  type ReviewActivity,
  type ReviewDraft,
  type ReviewFinding,
  type ReviewJobInfo,
  type ReviewLane,
  type ReviewModelChoice,
  type ReviewReviewerOptions,
  type ReviewSeverity,
} from '../../shared/review'

/** Window event the app header uses to open a code review in the conversation that owns it. */
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
  'invalid-reviewer',
  'reviewer-unsupported',
  'plan-changed',
  'nothing-to-check',
  'no-revision',
  'review-not-open',
  'findings-undecided',
  'nothing-to-send',
  'empty-message',
])

/** Localized reason a review could not start or failed; unknown errors are shown as reported. */
export function reviewErrorText(t: TFunction, error: string | undefined): string {
  if (error && KNOWN_ERRORS.has(error)) return t(`review.error.${error}`, { ns: 'chat' })
  return error?.trim() || t('review.error.unknown', { ns: 'chat' })
}

/** Reviewers or the verifier are working. */
export function isReviewRunning(review: ReviewJobInfo | null | undefined): boolean {
  return review?.status === 'running' || review?.status === 'verifying'
}

const STAGE: Record<ReviewJobInfo['status'], number> = {
  running: 0,
  verifying: 1,
  ready: 2,
  completed: 3,
  discarded: 3,
  failed: 3,
  cancelled: 3,
}

/**
 * A snapshot read on demand (a start result or a status query) can arrive after events of the same review that are
 * further along; it then keeps the newer one. Events arrive in order and always replace.
 */
export function mergeReviewInfo(current: ReviewJobInfo | null, incoming: ReviewJobInfo | null): ReviewJobInfo | null {
  if (!incoming) return current
  if (
    current?.reviewId === incoming.reviewId &&
    current.kind === incoming.kind &&
    STAGE[current.status] > STAGE[incoming.status]
  ) {
    return current
  }
  return incoming
}

/**
 * The conversation's open review or running check, or the last one that ended, kept current from main. `apply` shows
 * a snapshot a call returned (a start or check result) at once.
 */
export function useConversationReview(
  api: HostApi,
  conversationId: string
): { review: ReviewJobInfo | null; apply: (info: ReviewJobInfo | null) => void } {
  const [review, setReview] = useState<ReviewJobInfo | null>(null)
  const currentConversation = useRef(conversationId)
  useEffect(() => {
    let alive = true
    currentConversation.current = conversationId
    setReview(null)
    void api
      .chatReviewStatus(conversationId)
      .then((info) => {
        if (alive) setReview((current) => mergeReviewInfo(current, info))
      })
      .catch(() => undefined)
    const off = api.onChatReviewChanged((info) => {
      if (info.conversationId === conversationId) setReview(info)
    })
    return () => {
      alive = false
      off()
    }
  }, [api, conversationId])
  const apply = useCallback(
    (info: ReviewJobInfo | null) => {
      if (
        info &&
        info.conversationId === currentConversation.current &&
        currentConversation.current === conversationId
      ) {
        setReview((current) => mergeReviewInfo(current, info))
      }
    },
    [conversationId]
  )
  return { review, apply }
}

/** A review the room shows: open (held) or failed. A check runs from its receipt instead. */
export function roomReview(review: ReviewJobInfo | null, dismissedId: string | null): ReviewJobInfo | null {
  if (review?.kind !== 'review') return null
  if (reviewLocksConversation(review)) return review
  return review.status === 'failed' && review.reviewId !== dismissedId ? review : null
}

/** The agent's last visible words in the conversation, for the room's paused bar. */
export function lastAgentText(
  messages: ReadonlyArray<{
    role: string
    internal?: boolean
    review?: unknown
    parts: ReadonlyArray<{ type: string; text?: string }>
  }>
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.internal || message.review) continue
    const text = message.parts
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text.slice(0, 300)
  }
  return undefined
}

/** The first stage offers the reviewer used last time, else the conversation's model. */
export function initialReviewerChoice(options: ReviewReviewerOptions): {
  useConversation: boolean
  choice: ReviewModelChoice | null
} {
  const last = options.last
  if (last?.kind === 'model') {
    const { kind: _kind, ...choice } = last
    return { useConversation: false, choice }
  }
  const conversation = options.conversation
    ? {
        providerId: options.conversation.providerId,
        modelId: options.conversation.modelId,
        reasoning: options.conversation.reasoning,
        fastMode: options.conversation.fastMode,
      }
    : null
  // Without a model of its own, the conversation cannot review; a model has to be chosen.
  return { useConversation: !!conversation, choice: conversation }
}

/** "Provider · model · high · Fast". */
export function reviewModelLabel(choice: {
  providerId: string
  modelId: string
  reasoning?: string
  fastMode?: boolean
  providerName?: string
}): string {
  return [
    `${choice.providerName ?? choice.providerId} · ${choice.modelId}`,
    choice.reasoning && choice.reasoning !== 'off' ? choice.reasoning : '',
    choice.fastMode ? 'Fast' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "model · high · Fast": the reviewing model where the provider is already clear. */
export function reviewModelShortLabel(model: { modelId: string; reasoning?: string; fastMode?: boolean }): string {
  return [
    model.modelId,
    model.reasoning && model.reasoning !== 'off' ? model.reasoning : '',
    model.fastMode ? 'Fast' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "1:07" */
export function formatReviewClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function formatReviewDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function findingLocation(finding: Pick<ReviewFinding, 'path' | 'line'>): string {
  if (!finding.path) return ''
  return finding.line ? `${finding.path}:${finding.line}` : finding.path
}

export interface EvidenceRow {
  path: string
  /** Part of the change under review. */
  inScope: boolean
  added?: number
  deleted?: number
  isNew?: boolean
  /** Reads and search hits per lane. */
  touches: Partial<Record<ReviewLane, number>>
  /** Candidates raised about this file. */
  flags: number
  /** The most severe candidate raised about it. */
  severity?: ReviewSeverity
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocking: 0, important: 1, minor: 2 }

/**
 * Files of the change and files the reviewers went to outside it: who read or matched each one, and which ones
 * candidates point at. Rows outside the change are capped.
 */
export function buildEvidenceMap(review: ReviewJobInfo, outsideLimit = 20): EvidenceRow[] {
  const rows = new Map<string, EvidenceRow>()
  const row = (path: string): EvidenceRow => {
    let entry = rows.get(path)
    if (!entry) {
      entry = { path, inScope: false, touches: {}, flags: 0 }
      rows.set(path, entry)
    }
    return entry
  }
  if (review.scope?.kind === 'code') {
    for (const file of review.scope.files) {
      Object.assign(row(file.path), {
        inScope: true,
        ...(file.added !== undefined ? { added: file.added } : {}),
        ...(file.deleted !== undefined ? { deleted: file.deleted } : {}),
        ...(file.isNew ? { isNew: true } : {}),
      })
    }
  }
  for (const [lane, list] of Object.entries(review.activity) as Array<[ReviewLane, ReviewActivity[] | undefined]>) {
    for (const activity of list ?? []) {
      const paths = activity.kind === 'read' && activity.path ? [activity.path] : (activity.files ?? [])
      for (const path of paths) {
        const entry = row(path)
        entry.touches[lane] = (entry.touches[lane] ?? 0) + 1
      }
    }
  }
  for (const candidate of review.candidateList) {
    if (!candidate.path) continue
    const verdict = review.verdicts.find((item) => item.candidateId === candidate.id)
    if (verdict && verdict.verdict !== 'confirmed') continue
    const entry = row(candidate.path)
    entry.flags++
    const severity = verdict?.severity ?? candidate.severity
    if (!entry.severity || SEVERITY_RANK[severity] < SEVERITY_RANK[entry.severity]) entry.severity = severity
  }
  const weight = (entry: EvidenceRow) =>
    entry.flags * 100 + Object.values(entry.touches).reduce((total, count) => total + (count ?? 0), 0)
  const inScope = [...rows.values()].filter((entry) => entry.inScope)
  const outside = [...rows.values()]
    .filter((entry) => !entry.inScope)
    .sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path))
    .slice(0, outsideLimit)
  return [...inScope, ...outside]
}

/** Candidates the verifier dropped, with what it said. */
export function droppedCandidates(review: Pick<ReviewJobInfo, 'candidateList' | 'verdicts'>) {
  return review.candidateList.flatMap((candidate) => {
    const verdict = review.verdicts.find((item) => item.candidateId === candidate.id)
    return verdict && verdict.verdict !== 'confirmed' ? [{ candidate, verdict }] : []
  })
}

/** The next finding without a decision after `from`, wrapping around; -1 when every finding is decided. */
export function nextUndecided(findings: readonly ReviewFinding[], draft: ReviewDraft, from: number): number {
  for (let step = 1; step <= findings.length; step++) {
    const index = (from + step) % findings.length
    if (!draft.decisions[findings[index].id]) return index
  }
  return -1
}

const lineOf = (finding: ReviewFinding): string => {
  const where = findingLocation(finding)
  return `- ${finding.id} ${finding.title.replaceAll('`', '')}${where ? ` (${where})` : ''}`
}

/**
 * The message a code review goes to the agent with, built from the person's decisions; they can edit it before
 * sending. The full report travels with it as an attachment.
 */
export function composeReviewHandoff(
  t: TFunction,
  findings: readonly ReviewFinding[],
  draft: Pick<ReviewDraft, 'decisions' | 'notes'>
): string {
  const by = (decision: string) => findings.filter((finding) => draft.decisions[finding.id] === decision)
  const sections: string[] = []
  const fix = by('fix')
  const discuss = by('discuss')
  const dismiss = by('dismiss')
  if (fix.length) sections.push([t('review.handoff.fixHeading', { ns: 'chat' }), ...fix.map(lineOf)].join('\n'))
  if (discuss.length) {
    sections.push([t('review.handoff.discussHeading', { ns: 'chat' }), ...discuss.map(lineOf)].join('\n'))
  }
  if (dismiss.length) {
    sections.push(
      [
        t('review.handoff.dismissHeading', { ns: 'chat' }),
        ...dismiss.map((finding) => {
          const note = draft.notes[finding.id]?.trim()
          return `- ${finding.id} ${finding.title.replaceAll('`', '')}${note ? ` — ${note}` : ''}`
        }),
      ].join('\n')
    )
  }
  return sections.join('\n\n')
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

/**
 * The revision request a plan review hands off: each commented finding becomes (or extends) the comment on its plan
 * line, and findings without a line join the general feedback. The person's own draft comments and feedback stay.
 */
export function planReviewRevision(
  plan: string,
  findings: readonly ReviewFinding[],
  draft: Pick<ReviewDraft, 'decisions' | 'comments'>,
  own: { lineComments: Record<number, string>; feedback: string } = { lineComments: {}, feedback: '' }
): { lineComments: Array<{ line: number; text: string }>; feedback: string } {
  const commentable = commentablePlanLines(plan)
  const lineComments: Record<number, string> = { ...own.lineComments }
  const general: string[] = []
  for (const finding of findings) {
    if (draft.decisions[finding.id] !== 'comment') continue
    const text = (draft.comments[finding.id] ?? '').trim() || finding.title
    const line = snapToCommentableLine(commentable, finding.planLine)
    if (line === null) {
      general.push(`${finding.id}: ${text}`)
      continue
    }
    const existing = lineComments[line]?.trim()
    lineComments[line] = existing ? `${existing}\n\n${text}` : text
  }
  return {
    lineComments: Object.entries(lineComments)
      .map(([line, text]) => ({ line: Number(line), text: text.trim() }))
      .filter((comment) => comment.text)
      .sort((a, b) => a.line - b.line),
    feedback: [own.feedback.trim(), ...general].filter(Boolean).join('\n\n'),
  }
}
