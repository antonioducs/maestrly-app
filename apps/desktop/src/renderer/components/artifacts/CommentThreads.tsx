import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_ARTIFACT_COMMENT_CHARS, type ArtifactCommentView } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { type CommentThread, commentAuthor, threadsOf } from './comments-view'
import { InlineConfirm } from './PeopleList'

function CommentBody({ comment, reply }: { comment: ArtifactCommentView; reply?: boolean }) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  return (
    <div className={cn(reply && 'border-l border-border-strong pl-2.5')}>
      <p className="flex items-baseline gap-2 text-[12.5px]">
        <span
          className={cn(
            'min-w-0 truncate font-semibold text-foreground',
            comment.author.kind === 'guest' && 'font-medium'
          )}
        >
          {commentAuthor(t, comment.author)}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">{relativeTime(locale, comment.createdAt)}</span>
      </p>
      {/* People outside the app wrote this: it is shown as plain text, never rendered. */}
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-foreground/85">
        {comment.body}
      </p>
    </div>
  )
}

function ThreadCard({
  thread,
  busy,
  onReply,
  onResolve,
  onDelete,
}: {
  thread: CommentThread
  busy: boolean
  onReply: (body: string) => Promise<boolean>
  onResolve: (resolved: boolean) => void
  onDelete: (commentId: string) => void
}) {
  const { t } = useTranslation('ui')
  const { comment, replies } = thread
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const resolved = comment.status === 'resolved'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const body = text.trim()
    if (!body || !(await onReply(body))) return
    setText('')
    setReplying(false)
  }

  const linkClass = 'text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline'
  return (
    <li
      data-testid="artifact-comment-thread"
      data-status={comment.status}
      className={cn(
        'grid gap-2 rounded-lg border border-border-strong bg-black/[0.16] p-2.5',
        resolved && 'opacity-70'
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-white/[0.06] px-1.5 font-mono text-[11px] leading-[18px] text-muted-foreground">
          {t('artifacts.comments.version', { version: comment.version })}
        </span>
        {resolved && (
          <span className="rounded-full bg-white/[0.06] px-1.5 text-[11px] leading-[18px] text-muted-foreground">
            {t('artifacts.comments.resolved')}
          </span>
        )}
      </div>
      {comment.quote && (
        <blockquote className="line-clamp-3 break-words border-l-[3px] border-artifact-warn/80 pl-2 text-xs leading-snug text-muted-foreground">
          {comment.quote}
        </blockquote>
      )}
      {comment.place !== 'passage' && (
        <p className="text-[11.5px] text-muted-foreground">
          {comment.place === 'spot' ? t('artifacts.comments.onSpot') : t('artifacts.comments.onPage')}
        </p>
      )}
      <CommentBody comment={comment} />
      {replies.map((reply) => (
        <div key={reply.id}>
          <CommentBody comment={reply} reply />
          <button
            type="button"
            className="ml-2.5 mt-1 text-[11.5px] text-muted-foreground hover:text-destructive disabled:opacity-50"
            disabled={busy}
            onClick={() => setDeleting(reply.id)}
          >
            {t('artifacts.comments.delete')}
          </button>
        </div>
      ))}
      <div className="flex gap-3">
        {!replying && (
          <button
            type="button"
            className={linkClass}
            disabled={busy}
            data-testid="artifact-comment-reply"
            onClick={() => setReplying(true)}
          >
            {t('artifacts.comments.reply')}
          </button>
        )}
        <button
          type="button"
          className={linkClass}
          disabled={busy}
          data-testid="artifact-comment-resolve"
          onClick={() => onResolve(!resolved)}
        >
          {resolved ? t('artifacts.comments.reopen') : t('artifacts.comments.resolve')}
        </button>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
          disabled={busy}
          onClick={() => setDeleting(comment.id)}
        >
          {t('artifacts.comments.delete')}
        </button>
      </div>
      {deleting && (
        <InlineConfirm
          text={t('artifacts.comments.confirmDelete')}
          confirmLabel={t('artifacts.comments.delete')}
          cancelLabel={t('artifacts.comments.cancel')}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDelete(deleting)
            setDeleting(null)
          }}
        />
      )}
      {replying && (
        <form onSubmit={(event) => void submit(event)} className="grid gap-1.5">
          <textarea
            autoFocus
            rows={2}
            value={text}
            maxLength={MAX_ARTIFACT_COMMENT_CHARS}
            disabled={busy}
            placeholder={t('artifacts.comments.replyPlaceholder')}
            aria-label={t('artifacts.comments.replyPlaceholder')}
            data-testid="artifact-comment-reply-text"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setReplying(false)
              }
            }}
            className="min-h-[52px] w-full resize-y rounded-md border border-border-strong bg-black/[0.2] px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setReplying(false)}>
              {t('artifacts.comments.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-7"
              disabled={busy || !text.trim()}
              data-testid="artifact-comment-reply-send"
            >
              {t('artifacts.comments.reply')}
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}

/** The comment threads of an artifact: the owner reads and answers them here, without opening the viewer. */
export function CommentThreads({
  comments,
  busy,
  onReply,
  onResolve,
  onDelete,
}: {
  comments: ArtifactCommentView[]
  busy: boolean
  /** Resolves to whether the reply was stored, so the text is kept when it was not. */
  onReply: (threadId: string, body: string) => Promise<boolean>
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (commentId: string) => void
}) {
  return (
    <ul className="grid gap-1.5" data-testid="artifact-comments">
      {threadsOf(comments).map((thread) => (
        <ThreadCard
          key={thread.comment.id}
          thread={thread}
          busy={busy}
          onReply={(body) => onReply(thread.comment.id, body)}
          onResolve={(resolved) => onResolve(thread.comment.id, resolved)}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}
