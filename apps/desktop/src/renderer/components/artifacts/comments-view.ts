/** How the app arranges an artifact's comments, and the draft it builds from them. No React, so it is tested directly. */
import type { ArtifactCommentView } from '../../../shared/artifacts'
// A relative import: unit tests compile this file without the renderer's path aliases.
import type { TFn } from '../settings/shared'

export interface CommentThread {
  comment: ArtifactCommentView
  replies: ArtifactCommentView[]
}

const byDate = (a: ArtifactCommentView, b: ArtifactCommentView): number => a.createdAt - b.createdAt

/** Threads with their replies in the order they were written; open threads first, then by date. */
export function threadsOf(comments: readonly ArtifactCommentView[]): CommentThread[] {
  const threads = new Map<string, CommentThread>()
  for (const comment of comments) if (comment.parentId === null) threads.set(comment.id, { comment, replies: [] })
  for (const comment of comments) if (comment.parentId !== null) threads.get(comment.parentId)?.replies.push(comment)
  const ordered = [...threads.values()].sort(
    (a, b) =>
      Number(a.comment.status === 'resolved') - Number(b.comment.status === 'resolved') || byDate(a.comment, b.comment)
  )
  for (const thread of ordered) thread.replies.sort(byDate)
  return ordered
}

/** Who wrote a comment, as the owner reads it. A guest's name is marked: nobody confirmed it. */
export function commentAuthor(t: TFn, author: ArtifactCommentView['author']): string {
  if (author.kind === 'owner') return t('artifacts.comments.you')
  if (author.kind === 'agent')
    return author.name ? t('artifacts.comments.agent', { name: author.name }) : t('artifacts.comments.agentUnnamed')
  if (author.kind === 'guest') return t('artifacts.comments.unverified', { name: author.name })
  return author.name
}

/** In a draft the owner speaks to the agent, so the owner is "me" and the agent is "you". */
function draftAuthor(t: TFn, author: ArtifactCommentView['author']): string {
  if (author.kind === 'owner') return t('artifacts.comments.draft.me')
  if (author.kind === 'agent') return t('artifacts.comments.draft.agent')
  return commentAuthor(t, author)
}

const indent = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')

/**
 * A message for the artifact's conversation that quotes every open thread. It says that other people wrote the
 * comments, so the agent weighs them as feedback. Empty when nothing is open.
 */
export function draftFromComments(t: TFn, title: string, comments: readonly ArtifactCommentView[]): string {
  const open = threadsOf(comments).filter((thread) => thread.comment.status === 'open')
  if (!open.length) return ''
  const blocks = open.map(({ comment, replies }, index) => {
    const author = draftAuthor(t, comment.author)
    const heading = comment.quote
      ? t('artifacts.comments.draft.threadQuoted', { author, version: comment.version, quote: comment.quote })
      : t('artifacts.comments.draft.thread', { author, version: comment.version })
    const lines = [`${index + 1}. ${heading}`, indent(comment.body, '   ')]
    for (const reply of replies)
      lines.push(
        `   - ${t('artifacts.comments.draft.reply', { author: draftAuthor(t, reply.author) })}`,
        indent(reply.body, '     ')
      )
    return lines.join('\n')
  })
  return [t('artifacts.comments.draft.intro', { title }), ...blocks, t('artifacts.comments.draft.outro')].join('\n\n')
}
