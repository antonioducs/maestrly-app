import type { ChatMessage, MessagePart } from '../../../shared/chat'
import { clipMiddle } from '../message'
import { estimatePortablePartsTokens, portableContextReserveTokens } from '../portable-context'
import { compactionSummaryTargetTokens } from './summary-prompt'

/** Where a compaction keeps the recent messages verbatim: the summary covers everything up to `afterPartId`. */
export interface CompactionCut {
  /** Message holding the last summarized part. The marker is inserted right after `afterPartId`, so it is always an
   * assistant message with that part. */
  messageId: string
  afterPartId: string
  /** The kept tail starts inside the latest turn, after its user request, instead of at a user message. */
  splitTurn: boolean
  /** Estimated portable tokens kept verbatim and summarized. */
  tailTokens: number
  prefixTokens: number
}

/** Tail kept verbatim after a summary: up to 20k tokens or 12% of the window, within 70% of it with everything else. */
export function compactionTailBudget(contextWindow: number | undefined, pendingTokens = 0): number {
  const DEFAULT_TAIL_TOKENS = 20_000
  if (!contextWindow || contextWindow <= 0) return DEFAULT_TAIL_TOKENS
  const room =
    Math.floor(contextWindow * 0.7) -
    compactionSummaryTargetTokens(Number.POSITIVE_INFINITY, contextWindow) -
    Math.max(0, pendingTokens) -
    portableContextReserveTokens(contextWindow)
  return Math.max(0, Math.min(DEFAULT_TAIL_TOKENS, Math.floor(contextWindow * 0.12), room))
}

interface Position {
  message: number
  part: number
}

function opensStep(part: MessagePart): boolean {
  return part.type === 'text' || part.type === 'reasoning' || part.type === 'generated-image'
}

function isOpenTool(part: MessagePart): boolean {
  return (
    part.type === 'tool' &&
    (part.state.status === 'pending' || part.state.status === 'awaiting-permission' || part.state.status === 'running')
  )
}

/**
 * Chooses where the verbatim tail of `messages` (the active context after the last portable marker) starts. The unit
 * is the step: text or reasoning followed by its tool parts, whose call and result live in the same part, so a cut
 * never separates them and parallel calls stay together. Preference goes to the oldest user message whose tail fits
 * `tailTokens`; when the latest turn alone does not fit, the oldest step of that turn that fits (a split turn); when
 * not even that fits, the last step if it stays within twice the budget. The last step is always kept, and the
 * summarized prefix is never empty, never ends after an unfinished tool and never ends in a user message. Returns
 * null when no tail is possible: compaction then summarizes everything, as before.
 */
export function selectCompactionCut(
  messages: readonly ChatMessage[],
  opts: { tailTokens: number }
): CompactionCut | null {
  const budget = Math.floor(opts.tailTokens)
  if (!(budget > 0) || messages.length === 0) return null
  const positions: Position[] = []
  const cost: number[] = []
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      positions.push({ message: messageIndex, part: partIndex })
      cost.push(estimatePortablePartsTokens([part]) + (partIndex === 0 ? 16 : 0))
    })
  })
  if (positions.length < 2) return null
  const suffix = new Array<number>(positions.length + 1).fill(0)
  for (let index = positions.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + cost[index]
  const total = suffix[0]
  // A late result can still land on an unfinished tool of the newest message: nothing after it may be summarized.
  const last = messages.length - 1
  const firstOpen = positions.findIndex(
    (position) => position.message === last && isOpenTool(messages[last].parts[position.part])
  )
  let latestUser = -1
  for (let index = messages.length - 1; index >= 0 && latestUser < 0; index -= 1)
    if (messages[index].role === 'user' && messages[index].parts.length > 0) latestUser = index

  const isStepStart = (index: number): boolean => {
    const { message, part } = positions[index]
    if (part === 0) return true
    const parts = messages[message].parts
    return messages[message].role === 'assistant' && opensStep(parts[part]) && parts[part - 1].type === 'tool'
  }
  const valid = (index: number): boolean => {
    if (index <= 0 || (firstOpen >= 0 && index > firstOpen)) return false
    if (total - suffix[index] <= 0) return false
    return messages[positions[index - 1].message].role === 'assistant'
  }
  const cutAt = (index: number, splitTurn: boolean): CompactionCut => {
    const host = positions[index - 1]
    return {
      messageId: messages[host.message].id,
      afterPartId: messages[host.message].parts[host.part].id,
      splitTurn,
      tailTokens: suffix[index],
      prefixTokens: total - suffix[index],
    }
  }

  const candidates = positions.map((_, index) => index).filter((index) => isStepStart(index) && valid(index))
  if (candidates.length === 0) return null
  const userStart = (index: number) => positions[index].part === 0 && messages[positions[index].message].role === 'user'
  const atUser = candidates.find((index) => userStart(index) && suffix[index] <= budget)
  if (atUser != null) return cutAt(atUser, false)
  const inTurn = candidates.filter((index) => positions[index].message > latestUser && !userStart(index))
  const split = inTurn.find((index) => suffix[index] <= budget)
  if (split != null) return cutAt(split, true)
  const newest = candidates.at(-1)!
  return suffix[newest] <= budget * 2 ? cutAt(newest, !userStart(newest)) : null
}

/**
 * A boundary after everything, in the newest assistant message, for a live turn that must commit its marker itself
 * (a degraded summary carries a flag the runner cannot add). Null when that message is not a closed assistant step.
 */
export function historyEndCut(messages: readonly ChatMessage[]): CompactionCut | null {
  const last = messages.at(-1)
  const part = last?.parts.at(-1)
  if (last?.role !== 'assistant' || !part || isOpenTool(part)) return null
  return { messageId: last.id, afterPartId: part.id, splitTurn: false, tailTokens: 0, prefixTokens: 0 }
}

function cutIndex(history: readonly ChatMessage[], cut: Pick<CompactionCut, 'messageId' | 'afterPartId'>) {
  const message = history.findIndex((candidate) => candidate.id === cut.messageId)
  const part = message < 0 ? -1 : history[message].parts.findIndex((candidate) => candidate.id === cut.afterPartId)
  return message < 0 || part < 0 ? null : { message, part }
}

/** History summarized by a cut compaction: everything through `afterPartId`, the previous summary included. */
export function historyThroughCut<T extends ChatMessage>(
  history: readonly T[],
  cut: Pick<CompactionCut, 'messageId' | 'afterPartId'>
): T[] | null {
  const at = cutIndex(history, cut)
  if (!at) return null
  return [
    ...history.slice(0, at.message),
    { ...history[at.message], parts: history[at.message].parts.slice(0, at.part + 1) },
  ]
}

/** Messages kept verbatim after a cut compaction. */
export function historyAfterCut<T extends ChatMessage>(
  history: readonly T[],
  cut: Pick<CompactionCut, 'messageId' | 'afterPartId'>
): T[] {
  const at = cutIndex(history, cut)
  if (!at) return []
  const rest = history[at.message].parts.slice(at.part + 1)
  return [...(rest.length > 0 ? [{ ...history[at.message], parts: rest }] : []), ...history.slice(at.message + 1)]
}

const TURN_REQUEST_BLOCK =
  /\n*The user's request for the turn still in progress[^\n]*\n<current_turn_request>[\s\S]*?<\/current_turn_request>/g
const TURN_REQUEST_MAX_CHARS = 4_000

/** The latest user request before a cut, verbatim (clipped), for a split turn whose request left the context. */
export function turnRequestBeforeCut(
  history: readonly ChatMessage[],
  cut: Pick<CompactionCut, 'messageId' | 'afterPartId'>
): string | null {
  const through = historyThroughCut(history, cut) ?? []
  const user = [...through]
    .reverse()
    .find((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text'))
  if (!user) return null
  const text = user.parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    // The approved plan is carried verbatim on its own.
    .replace(/<approved_plan>[\s\S]*?<\/approved_plan>/g, '[approved plan, kept below]')
    .trim()
  return text ? clipMiddle(text, TURN_REQUEST_MAX_CHARS, '\n… request shortened …\n') : null
}

const CARRIED_APPROVED_PLAN =
  /\n*(?:The plan the user approved, kept verbatim across compaction\.[^\n]*\n)?<approved_plan>[\s\S]*?<\/approved_plan>/g

/** Drops a carried approved plan from a summary whose verbatim tail already holds the latest one. */
export function summaryWithoutApprovedPlan(summary: string): string {
  return summary.replace(CARRIED_APPROVED_PLAN, '').trimEnd()
}

/** Replaces any carried turn request with `request`, or only removes it when there is none. */
export function summaryWithTurnRequest(summary: string, request: string | null): string {
  const base = summary.replace(TURN_REQUEST_BLOCK, '').trimEnd()
  if (!request) return base
  return (
    `${base}\n\n` +
    "The user's request for the turn still in progress, kept verbatim because its message was summarized:\n" +
    `<current_turn_request>\n${request}\n</current_turn_request>`
  )
}
