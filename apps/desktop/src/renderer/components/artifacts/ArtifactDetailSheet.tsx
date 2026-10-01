import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Link2, Loader2, Lock, MessagesSquare, Send, Share2, Trash2, Users, X } from 'lucide-react'
import type {
  ArtifactAccessRequestView,
  ArtifactCommentView,
  ArtifactDetailView,
  ArtifactEventView,
  ArtifactListItem,
  ArtifactSharingView,
} from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { relativeTime } from '@/components/sidebar/relative-time'
import { offerComposerDraft } from '@/lib/composer-prefill'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AccessRequests } from './AccessRequests'
import { CommentThreads } from './CommentThreads'
import { draftFromComments } from './comments-view'
import { ArtifactThumbnail } from './ArtifactThumbnail'
import { VersionStack } from './ArtifactGridCard'
import { eventText, sharingSummary } from './sharing-view'

const MAX_EVENTS_SHOWN = 6

/**
 * The side panel of one artifact: where it came from, who can open it, what happened on it lately, and every
 * version, each of which opens.
 */
export function ArtifactDetailSheet({
  item,
  projectName,
  isOpening,
  onOpen,
  onOpenBot,
  onGoToConversation,
  onShare,
  onDelete,
  onClose,
  onError,
  onNotice,
}: {
  item: ArtifactListItem
  projectName: string
  isOpening: (version?: number) => boolean
  onOpen: (version?: number) => void
  onOpenBot: (id: string) => void
  onGoToConversation: () => void
  onShare: () => void
  onDelete: () => void
  onClose: () => void
  onError: (message: string) => void
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null)
  const [sharing, setSharing] = useState<ArtifactSharingView | null>(null)
  const [events, setEvents] = useState<ArtifactEventView[]>([])
  const [comments, setComments] = useState<ArtifactCommentView[]>([])
  const [deciding, setDeciding] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef(onError)
  errorRef.current = onError
  // Events that arrived unseen while this panel is open stay marked as new until it closes.
  const fresh = useRef<Set<string>>(new Set())

  useEffect(() => {
    closeRef.current?.focus()
  }, [item.id])

  // A new version reloads the timeline; the sheet keeps the old one meanwhile.
  useEffect(() => {
    let alive = true
    window.api.artifacts
      .detail(item.id)
      .then((next) => alive && setDetail(next))
      .catch((reason: unknown) => alive && errorRef.current(String(reason)))
    return () => {
      alive = false
    }
  }, [item.id, item.currentVersion])

  // Who can open it and what happened lately. Showing the events is what makes them seen.
  useEffect(() => {
    let alive = true
    fresh.current = new Set()
    setSharing(null)
    setEvents([])
    setComments([])
    const load = () =>
      Promise.all([
        window.api.artifacts.sharing(item.id),
        window.api.artifacts.events(item.id),
        window.api.artifacts.comments(item.id),
      ])
        .then(([nextSharing, nextEvents, nextComments]) => {
          if (!alive) return
          const unseen = nextEvents.filter((event) => !event.seen)
          for (const event of unseen) fresh.current.add(event.id)
          setSharing(nextSharing)
          setEvents(nextEvents)
          setComments(nextComments)
          if (unseen.length) void window.api.artifacts.markSeen(item.id).catch(() => {})
        })
        // The artifact may have just been deleted; the list reports what matters.
        .catch(() => {})
    void load()
    const off = window.api.artifacts.onChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [item.id])

  const decide = async (request: ArtifactAccessRequestView, approve: boolean, name: string) => {
    setDeciding(true)
    try {
      await window.api.artifacts.decideRequest(item.id, request.id, approve ? { approve, name } : { approve })
      onNotice(
        approve ? t('artifacts.requests.approved', { name }) : t('artifacts.requests.denied', { name: request.name })
      )
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeciding(false)
    }
  }

  /** Runs one action on a comment; the list reloads through the host's change event. */
  const onComment = async (action: () => Promise<unknown>): Promise<boolean> => {
    setCommenting(true)
    try {
      await action()
      setComments(await window.api.artifacts.comments(item.id))
      return true
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setCommenting(false)
    }
  }

  const conversation = item.bot || item.elsewhere ? null : item.conversation
  const openComments = comments.filter((comment) => comment.parentId === null && comment.status === 'open').length
  // Puts the open comments in the conversation's message box, for the owner to edit and send. Nothing is sent here.
  const sendToConversation = () => {
    if (!conversation?.exists) return
    const draft = draftFromComments(t, item.title, comments)
    if (!draft) return
    offerComposerDraft(conversation.id, draft)
    onNotice(t('artifacts.comments.sent'))
    onGoToConversation()
  }
  const summary = sharing ? sharingSummary(sharing.people) : null
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const versions = detail?.id === item.id ? detail.versions : null

  return (
    <aside
      data-testid="artifact-detail"
      aria-labelledby="artifact-detail-title"
      // Escape closes the panel; menus and dialogs above it handle their own Escape first.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.stopPropagation()
        onClose()
      }}
      className="artifact-sheet absolute bottom-0 right-0 top-10 z-20 flex w-[min(440px,100%)] flex-col bg-[#29292d] shadow-[inset_0.5px_0_0_var(--border-strong),-24px_0_60px_rgba(0,0,0,0.35)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pl-[18px] pr-2 hairline-b">
        <p className="flex-1 text-xs text-muted-foreground">{t('artifacts.detail.eyebrow')}</p>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label={t('artifacts.detail.close')}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px] pt-6">
        <div className="relative">
          <VersionStack versions={item.versionCount} />
          <div className="relative aspect-[16/10] overflow-hidden rounded-[10px] border border-border-strong bg-[#141416]">
            <ArtifactThumbnail item={item} />
            <span className="absolute bottom-2 right-2 rounded-full bg-black/75 px-1.5 font-mono text-[11px] leading-[18px] text-primary">
              v{item.currentVersion}
            </span>
          </div>
        </div>
        <h2 id="artifact-detail-title" className="mb-1 mt-4 text-lg font-semibold tracking-tight text-foreground">
          {item.title}
        </h2>
        {item.description && <p className="mb-3.5 text-sm text-muted-foreground">{item.description}</p>}
        <div className="mb-[18px] flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onOpen()} disabled={isOpening()}>
            {isOpening() ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpRight className="size-3.5" />}
            {isOpening() ? t('artifacts.opening') : t('artifacts.detail.openInBrowser')}
          </Button>
          <Button size="sm" variant="outline" onClick={onShare} data-testid="artifact-detail-share">
            <Share2 className="size-3.5" /> {t('artifacts.share.action')}
          </Button>
          {item.bot && (
            <Button size="sm" variant="outline" onClick={() => onOpenBot(item.bot!.id)}>
              {item.bot.name ?? t('artifacts.server.bot')}
            </Button>
          )}
          {conversation?.exists && (
            <Button size="sm" variant="outline" onClick={onGoToConversation}>
              <MessagesSquare className="size-3.5" /> {t('artifacts.origin.goTo')}
            </Button>
          )}
        </div>
        {sharing && sharing.requests.length > 0 && (
          <section className="mb-[18px]" aria-labelledby="artifact-detail-requests">
            <h3
              id="artifact-detail-requests"
              className="mb-2 flex items-baseline justify-between text-xs font-semibold text-foreground/75"
            >
              {t('artifacts.requests.title')}
              <span className="font-normal text-muted-foreground">
                {t('artifacts.requests.badge', { count: sharing.requests.length })}
              </span>
            </h3>
            <AccessRequests
              requests={sharing.requests}
              busy={deciding}
              onDecide={(request, approve, name) => void decide(request, approve, name)}
            />
          </section>
        )}
        <dl className="mb-[22px] grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 py-3 text-[12.5px] hairline-b hairline-t">
          <dt className="text-muted-foreground">{t('artifacts.detail.project')}</dt>
          <dd className="min-w-0 truncate text-foreground/75">{projectName}</dd>
          <dt className="text-muted-foreground">{t('artifacts.detail.origin')}</dt>
          <dd className="min-w-0 truncate text-foreground/75">
            {!conversation ? (
              t('artifacts.origin.none')
            ) : conversation.exists ? (
              <button type="button" className="hover:text-foreground hover:underline" onClick={onGoToConversation}>
                {conversation.title ?? t('artifacts.origin.untitled')}
              </button>
            ) : (
              <span className="italic">
                {conversation.title
                  ? t('artifacts.origin.deleted', { title: conversation.title })
                  : t('artifacts.origin.deletedUntitled')}
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">{t('artifacts.detail.created')}</dt>
          <dd className="text-foreground/75">{dateFormat.format(item.createdAt)}</dd>
          <dt className="text-muted-foreground">{t('artifacts.detail.updated')}</dt>
          <dd className="text-foreground/75">{relativeTime(locale, item.updatedAt)}</dd>
          <dt className="text-muted-foreground">{t('artifacts.detail.storage')}</dt>
          <dd className="text-foreground/75">
            {t('artifacts.detail.storageValue', {
              size: formatBytes(item.storageBytes),
              versions: t('artifacts.versionCount', { count: item.versionCount }),
            })}
          </dd>
          <dt className="text-muted-foreground">{t('artifacts.detail.access')}</dt>
          <dd className="flex items-center gap-1.5 text-foreground/75" data-testid="artifact-detail-access">
            {item.visibility === 'private' ? (
              <Lock className="size-3" aria-hidden="true" />
            ) : item.visibility === 'people' ? (
              <Users className="size-3" aria-hidden="true" />
            ) : (
              <Link2 className="size-3" aria-hidden="true" />
            )}
            {item.visibility === 'private'
              ? t('artifacts.detail.private')
              : t(`artifacts.visibility.${item.visibility}`)}
          </dd>
          {summary && (summary.people > 0 || item.visibility !== 'private') && (
            <>
              <dt className="text-muted-foreground">{t('artifacts.detail.sharing')}</dt>
              <dd className="text-foreground/75" data-testid="artifact-detail-people">
                {summary.people > 0
                  ? t('artifacts.detail.sharedWith', {
                      people: t('artifacts.detail.peopleCount', { count: summary.people }),
                      devices: t('artifacts.detail.deviceCount', { count: summary.devices }),
                    })
                  : t('artifacts.detail.nobodyYet')}
              </dd>
            </>
          )}
        </dl>
        {comments.length > 0 && (
          <section className="mb-[22px]" aria-labelledby="artifact-detail-comments">
            <h3
              id="artifact-detail-comments"
              className="mb-2 flex items-baseline justify-between text-xs font-semibold text-foreground/75"
            >
              {t('artifacts.comments.title')}
              <span className="font-normal text-muted-foreground">
                {t('artifacts.comments.open', { count: openComments })}
              </span>
            </h3>
            <CommentThreads
              comments={comments}
              busy={commenting}
              onReply={(threadId, body) => onComment(() => window.api.artifacts.replyComment(item.id, threadId, body))}
              onResolve={(threadId, resolved) =>
                void onComment(() => window.api.artifacts.resolveComment(item.id, threadId, resolved))
              }
              onDelete={(commentId) => void onComment(() => window.api.artifacts.deleteComment(item.id, commentId))}
            />
            {conversation?.exists && openComments > 0 && (
              <div className="mt-2.5">
                <Button size="sm" variant="outline" onClick={sendToConversation} data-testid="artifact-comments-send">
                  <Send className="size-3.5" /> {t('artifacts.comments.send')}
                </Button>
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('artifacts.comments.sendHint')}</p>
              </div>
            )}
          </section>
        )}
        {events.length > 0 && (
          <section className="mb-[22px]" aria-labelledby="artifact-detail-events">
            <h3 id="artifact-detail-events" className="mb-2 text-xs font-semibold text-foreground/75">
              {t('artifacts.events.title')}
            </h3>
            <ul className="grid gap-1.5" data-testid="artifact-events">
              {events.slice(0, MAX_EVENTS_SHOWN).map((event) => (
                <li key={event.id} className="flex items-baseline gap-2 text-[12.5px] text-foreground/80">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1.5 shrink-0 -translate-y-px rounded-full',
                      fresh.current.has(event.id) ? 'bg-primary' : 'bg-white/15'
                    )}
                  />
                  <span className="min-w-0 flex-1 break-words">{eventText(t, event)}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">
                    {relativeTime(locale, event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <h3 className="mb-2.5 flex items-baseline justify-between text-xs font-semibold text-foreground/75">
          {t('artifacts.detail.versions')}
          <span className="font-normal text-muted-foreground">
            {t('artifacts.versionCount', { count: item.versionCount })}
          </span>
        </h3>
        {versions ? (
          <ol className="artifact-timeline relative" data-testid="artifact-versions">
            {versions.map((version) => {
              const current = version.number === item.currentVersion
              const summary =
                version.summary ||
                (version.number === 1 ? t('artifacts.detail.firstVersion') : t('artifacts.detail.noSummary'))
              const opening = isOpening(version.number)
              return (
                <li key={version.number} className="relative grid grid-cols-[32px_1fr_auto] items-start gap-2.5 py-2">
                  <span
                    className={cn(
                      'relative z-[1] grid h-[22px] place-items-center rounded-full font-mono text-[11px]',
                      current
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-[#29292d] text-muted-foreground shadow-[0_0_0_0.5px_var(--border-strong)]'
                    )}
                  >
                    v{version.number}
                  </span>
                  <div className="min-w-0">
                    <span
                      className={cn('block text-[13px]', version.summary ? 'text-foreground' : 'text-foreground/70')}
                    >
                      {summary}
                      {current && (
                        <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 text-[11px] text-foreground/75">
                          {t('artifacts.detail.current')}
                        </span>
                      )}
                    </span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {t('artifacts.detail.versionMeta', {
                        when: relativeTime(locale, version.createdAt),
                        files: t('artifacts.fileCount', { count: version.fileCount }),
                        size: formatBytes(version.totalBytes),
                      })}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-[26px] px-2"
                    disabled={opening}
                    aria-label={t('artifacts.detail.openVersion', { version: version.number })}
                    onClick={() => onOpen(version.number)}
                  >
                    {opening ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpRight className="size-3.5" />}
                    {t('artifacts.card.open')}
                  </Button>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t('artifacts.loading')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 px-[18px] py-3 hairline-t">
        <p className="text-[11.5px] text-muted-foreground">
          {t('artifacts.detail.deleteNote', { count: item.versionCount })}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          data-testid="artifact-detail-delete"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" /> {t('artifacts.detail.delete')}
        </Button>
      </div>
    </aside>
  )
}
