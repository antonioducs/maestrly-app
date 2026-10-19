import type { MobileArgs, MobilePlan, MobilePlanImplementation } from '@maestrly/bot-fleet-protocol'

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const HEADING = /^\s{0,3}#{1,6}\s/
const HEADING_TEXT = /^\s{0,3}#{1,6}\s+(.*)$/
const STEP = /^(?:\d+[.)]|[-*+])\s+(.*)$/
const QUOTE = /^\s{0,3}>/
const FENCE = /^\s{0,3}(```|~~~)/
const TABLE = /^\s*\|/

/**
 * A piece of the plan as the sheet shows it. `line` is where it starts in the plan (1-based); a commentable block
 * starts on a line the desktop's Plan tab takes comments on too, so the host quotes the same line either way.
 */
export type PlanBlock = { line: number; source: string; commentable: boolean; indent: number }

/**
 * The plan in blocks: each paragraph, heading, list item and quote on its own, as the desktop's Markdown viewer holds
 * comments on them, and fenced code and tables whole, without comments.
 */
export function planBlocks(plan: string): PlanBlock[] {
  const blocks: Array<{ line: number; lines: string[]; commentable: boolean; kind: 'text' | 'fence' | 'table' }> = []
  let fence: string | null = null
  let previousBlank = true
  let previousHeading = false
  plan.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '')
    const current = blocks.at(-1)
    const start = (kind: 'text' | 'fence' | 'table', commentable: boolean) =>
      blocks.push({ line: index + 1, lines: [line], commentable, kind })
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      current?.lines.push(line)
      if (fenceMatch && fenceMatch[1] === fence) fence = null
      previousBlank = false
      previousHeading = false
      return
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      start('fence', false)
      previousBlank = false
      previousHeading = false
      return
    }
    const blank = !line.trim()
    const heading = HEADING.test(line)
    const table = TABLE.test(line)
    if (blank) current?.lines.push(line)
    else if (!table && (previousBlank || previousHeading || heading || LIST_ITEM.test(line) || QUOTE.test(line)))
      start('text', true)
    else if (table && current?.kind !== 'table') start('table', false)
    else if (!table && current?.kind !== 'text') start('text', false)
    else current?.lines.push(line)
    previousBlank = blank
    previousHeading = heading
  })
  return blocks.map((block) => {
    // A nested list item shows indented, as Markdown of its own: four leading spaces would read as code.
    const indent = block.kind === 'fence' ? 0 : (/^\s*/.exec(block.lines[0])?.[0].length ?? 0)
    const lines = block.lines.map((line) => line.slice(Math.min(indent, /^\s*/.exec(line)?.[0].length ?? 0)))
    while (lines.length > 1 && !lines.at(-1)?.trim()) lines.pop()
    return { line: block.line, source: lines.join('\n'), commentable: block.commentable, indent }
  })
}

const plainText = (value: string) =>
  value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()

/** The plan's top-level steps, or its section headings when it has no list, as the desktop sums a plan up. */
export function planOutline(plan: string): string[] {
  let title = false
  const steps: string[] = []
  const headings: string[] = []
  let fence = false
  for (const line of plan.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (fence) continue
    const heading = HEADING_TEXT.exec(line)
    if (heading) {
      // The first heading names the plan, as its title does.
      if (title) headings.push(plainText(heading[1]))
      title = true
      continue
    }
    const step = STEP.exec(line)
    if (step) steps.push(plainText(step[1]))
  }
  return (steps.length ? steps : headings).filter(Boolean)
}

/** A plan's first words, for a plan with no steps to list. */
export function planExcerpt(plan: string): string {
  return plainText(
    plan
      .split('\n')
      .filter((line) => line.trim() && !FENCE.test(line) && !HEADING.test(line))
      .slice(0, 4)
      .join(' ')
  ).replace(/\s+/g, ' ')
}

export type DiffRow = { kind: 'add' | 'del' | 'same'; text: string }

/** What changed between two versions of a plan, line by line (their longest common sequence of lines kept). */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.replace(/\n$/, '').split('\n')
  const b = after.replace(/\n$/, '').split('\n')
  // Plans are short; a pathological size falls back to showing one version replacing the other.
  if (a.length * b.length > 4_000_000)
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({ kind: 'del', text: a[i++] })
    else rows.push({ kind: 'add', text: b[j++] })
  }
  while (i < a.length) rows.push({ kind: 'del', text: a[i++] })
  while (j < b.length) rows.push({ kind: 'add', text: b[j++] })
  return rows
}

/** What the person has written on a plan so far: their edit of it, a general comment and comments on its lines. */
export type PlanDraft = { text: string; feedback: string; comments: Record<number, string> }

export const emptyDraft = (plan: MobilePlan): PlanDraft => ({ text: plan.text, feedback: '', comments: {} })

export const draftComments = (draft: PlanDraft) =>
  Object.entries(draft.comments)
    .map(([line, text]) => ({ line: Number(line), text: text.trim() }))
    .filter((comment) => comment.line > 0 && comment.text)
    .sort((a, b) => a.line - b.line)

export const draftEdited = (plan: MobilePlan, draft: PlanDraft) => draft.text.trim() !== plan.text.trim()

/** Whether there is anything to send back: a comment, a general comment or an edit, as the desktop requires. */
export const canRevise = (plan: MobilePlan, draft: PlanDraft) =>
  !!draft.feedback.trim() || draftComments(draft).length > 0 || draftEdited(plan, draft)

/** The words the phone uses when it folds comments into one message for a host that takes only a general comment. */
export type FeedbackWords = { general: string; lines: string; line: (ref: string, text: string) => string }
const ENGLISH_WORDS: FeedbackWords = {
  general: 'General comment:',
  lines: 'Comments on the plan:',
  line: (ref, text) => `On “${ref}”: ${text}`,
}

export type PlanDecisionArgs = Omit<MobileArgs<'plan'>, 'conversationId'>

/**
 * The decision the phone sends. A host that answered `planOptions` gets the draft as the Plan tab sends it; an older
 * one only takes a general comment, so line comments are written into it, quoting their lines.
 */
export function planDecision(
  plan: MobilePlan,
  draft: PlanDraft,
  action: 'approve' | 'revise' | 'discard',
  options: { full: boolean; implementation?: MobilePlanImplementation; words?: FeedbackWords }
): PlanDecisionArgs {
  if (action === 'discard') return { action }
  const edited = draftEdited(plan, draft) ? draft.text.trim() : undefined
  const feedback = draft.feedback.trim()
  const comments = draftComments(draft)
  if (action === 'approve')
    return options.full
      ? {
          action,
          ...(edited ? { editedPlan: edited } : {}),
          ...(options.implementation ? { implementation: options.implementation } : {}),
        }
      : { action }
  if (options.full)
    return {
      action,
      ...(feedback ? { feedback } : {}),
      ...(edited ? { editedPlan: edited } : {}),
      ...(comments.length ? { lineComments: comments } : {}),
    }
  const words = options.words ?? ENGLISH_WORDS
  const lines = plan.text.split('\n')
  const parts: string[] = []
  if (feedback) parts.push(comments.length ? `${words.general}\n${feedback}` : feedback)
  if (comments.length)
    parts.push(
      [
        words.lines,
        ...comments.map(
          (comment) => `- ${words.line(lines[comment.line - 1]?.trim() || `#${comment.line}`, comment.text)}`
        ),
      ].join('\n')
    )
  const folded = parts.join('\n\n').slice(0, 10_000)
  return { action, ...(folded ? { feedback: folded } : {}) }
}

/** Drafts by chat, kept while the app runs: closing the sheet, or leaving the chat for a while, loses nothing. */
const drafts = new Map<string, { version: number; text: string; draft: PlanDraft }>()
const draftListeners = new Set<() => void>()

/** The draft of a chat's plan; the same object until it changes, so a component can subscribe to it. */
export function draftFor(key: string, plan: MobilePlan): PlanDraft {
  const saved = drafts.get(key)
  // A new version, or the same version rewritten, starts over, as the desktop's draft does.
  if (saved && saved.version === plan.version && saved.text === plan.text) return saved.draft
  const draft = emptyDraft(plan)
  drafts.set(key, { version: plan.version, text: plan.text, draft })
  return draft
}

export function setDraft(key: string, plan: MobilePlan, draft: PlanDraft) {
  drafts.set(key, { version: plan.version, text: plan.text, draft })
  for (const listener of draftListeners) listener()
}

/** A decided plan leaves nothing behind. */
export function clearDraft(key: string) {
  if (!drafts.delete(key)) return
  for (const listener of draftListeners) listener()
}

export function subscribeDrafts(listener: () => void) {
  draftListeners.add(listener)
  return () => {
    draftListeners.delete(listener)
  }
}
