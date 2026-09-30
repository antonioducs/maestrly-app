import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Loader2, Lock, MessagesSquare, Trash2, X } from 'lucide-react'
import type { ArtifactDetailView, ArtifactListItem } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ArtifactThumbnail } from './ArtifactThumbnail'
import { VersionStack } from './ArtifactGridCard'

/** The side panel of one artifact: where it came from, what it takes, and every version, each of which opens. */
export function ArtifactDetailSheet({
  item,
  projectName,
  isOpening,
  onOpen,
  onGoToConversation,
  onDelete,
  onClose,
  onError,
}: {
  item: ArtifactListItem
  projectName: string
  isOpening: (version?: number) => boolean
  onOpen: (version?: number) => void
  onGoToConversation: () => void
  onDelete: () => void
  onClose: () => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef(onError)
  errorRef.current = onError

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

  const conversation = item.conversation
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
          {conversation?.exists && (
            <Button size="sm" variant="outline" onClick={onGoToConversation}>
              <MessagesSquare className="size-3.5" /> {t('artifacts.origin.goTo')}
            </Button>
          )}
        </div>
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
          <dd className="flex items-center gap-1.5 text-foreground/75">
            <Lock className="size-3" aria-hidden="true" /> {t('artifacts.detail.private')}
          </dd>
        </dl>
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
