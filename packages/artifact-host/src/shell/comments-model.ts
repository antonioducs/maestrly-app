// How the viewer arranges comments. No DOM here, so the rules are tested directly.
import type { PublicComment, TextQuote } from './contract.js'

export interface Thread {
  comment: PublicComment
  replies: PublicComment[]
}

const byDate = (a: PublicComment, b: PublicComment): number => a.createdAt - b.createdAt

/**
 * Threads of the version on screen, and threads started on other versions. Open threads come first, then by date;
 * replies follow their thread in the order they were written.
 */
export function groupComments(
  comments: readonly PublicComment[],
  displayedVersion: number
): { current: Thread[]; earlier: Thread[] } {
  const threads = new Map<string, Thread>()
  for (const comment of comments) if (comment.parentId === null) threads.set(comment.id, { comment, replies: [] })
  for (const comment of comments) if (comment.parentId !== null) threads.get(comment.parentId)?.replies.push(comment)
  const ordered = [...threads.values()].sort(
    (a, b) =>
      Number(a.comment.status === 'resolved') - Number(b.comment.status === 'resolved') || byDate(a.comment, b.comment)
  )
  for (const thread of ordered) thread.replies.sort(byDate)
  return {
    current: ordered.filter((thread) => thread.comment.version === displayedVersion),
    earlier: ordered.filter((thread) => thread.comment.version !== displayedVersion),
  }
}

/** What the page is asked to highlight: the quotes of open threads, which are the page's own text. */
export function quotesToHighlight(threads: readonly Thread[]): ({ id: string } & TextQuote)[] {
  const quotes: ({ id: string } & TextQuote)[] = []
  for (const { comment } of threads) {
    const quote = comment.anchor?.quote
    if (comment.status === 'open' && quote)
      quotes.push({ id: comment.id, exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix })
  }
  return quotes
}

type Translate = (key: CommentLabelKey, vars?: Record<string, string | number>) => string
export type CommentLabelKey =
  | 'commentYou'
  | 'commentOwner'
  | 'commentOwnerUnnamed'
  | 'commentAgent'
  | 'commentAgentUnnamed'
  | 'unverified'

/** How an author is named next to a comment. A guest's name is marked: nobody confirmed it. */
export function authorLabel(t: Translate, author: PublicComment['author']): string {
  if (author.self) return t('commentYou')
  if (author.kind === 'owner') return author.name ? t('commentOwner', { name: author.name }) : t('commentOwnerUnnamed')
  if (author.kind === 'agent') return author.name ? t('commentAgent', { name: author.name }) : t('commentAgentUnnamed')
  if (author.kind === 'guest') return t('unverified', { name: author.name })
  return author.name
}
