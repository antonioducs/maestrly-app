import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  Link2,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  PanelRight,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import type { ArtifactListItem } from '../../../shared/artifacts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ArtifactThumbnail } from './ArtifactThumbnail'
import type { Arrival } from './artifacts-view'

/** Sheets behind a preview, one per earlier version up to three: how much history an artifact has, at a glance. */
export function VersionStack({ versions }: { versions: number }) {
  const depth = Math.min(3, versions - 1)
  return (
    <>
      {[3, 2, 1]
        .filter((layer) => layer <= depth)
        .map((layer) => (
          <span key={layer} aria-hidden="true" className="artifact-stack-layer" data-depth={layer} />
        ))}
    </>
  )
}

export function ArtifactOrigin({
  item,
  onGoToConversation,
}: {
  item: ArtifactListItem
  onGoToConversation: () => void
}) {
  const { t } = useTranslation('ui')
  const conversation = item.conversation
  const icon = <MessagesSquare className="size-3.5 shrink-0" aria-hidden="true" />
  if (!conversation)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{t('artifacts.origin.none')}</span>
      </span>
    )
  if (!conversation.exists)
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        title={t('artifacts.origin.deletedHint')}
      >
        {icon}
        <span className="truncate italic">
          {conversation.title
            ? t('artifacts.origin.deleted', { title: conversation.title })
            : t('artifacts.origin.deletedUntitled')}
        </span>
      </span>
    )
  return (
    <span className="relative z-[2] flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      <button
        type="button"
        className="truncate text-foreground/75 hover:text-foreground hover:underline hover:underline-offset-2"
        title={t('artifacts.origin.goTo')}
        onClick={onGoToConversation}
      >
        {conversation.title ?? t('artifacts.origin.untitled')}
      </button>
    </span>
  )
}

export function ArtifactGridCard({
  item,
  projectLabel,
  showSize,
  arrival,
  entering,
  selected,
  opening,
  onSelect,
  onOpen,
  onShare,
  onDelete,
  onGoToConversation,
}: {
  item: ArtifactListItem
  /** Shown above the title while the list spans several projects. */
  projectLabel: string | null
  showSize: boolean
  arrival: Arrival | undefined
  entering: boolean
  selected: boolean
  opening: boolean
  onSelect: () => void
  onOpen: () => void
  onShare: () => void
  onDelete: () => void
  onGoToConversation: () => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const conversation = item.conversation
  const shared = item.visibility !== 'private'
  return (
    <li
      data-testid="artifact-card"
      data-artifact-id={item.id}
      className={cn(
        'artifact-card group relative flex flex-col rounded-[10px] pt-4',
        entering && 'artifact-enter',
        arrival && 'artifact-arrived',
        selected && 'is-selected'
      )}
    >
      <button
        type="button"
        data-testid="artifact-card-select"
        className="absolute inset-0 z-[1] rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        aria-label={t('artifacts.card.details', { title: item.title, version: item.currentVersion })}
        aria-pressed={selected}
        onClick={onSelect}
      />
      <div className="relative">
        <VersionStack versions={item.versionCount} />
        <div className="artifact-thumb relative aspect-[16/10] overflow-hidden rounded-[10px] border border-border-strong bg-[#141416]">
          <ArtifactThumbnail item={item} />
          {arrival && (
            <span className="absolute left-2 top-2 rounded-full bg-primary px-2 text-[11px] font-semibold leading-[18px] text-primary-foreground">
              {arrival === 'artifact' ? t('artifacts.card.newArtifact') : t('artifacts.card.newVersion')}
            </span>
          )}
          {item.pendingRequests > 0 && (
            <span
              data-testid="artifact-card-requests"
              className="absolute right-2 top-2 rounded-full bg-artifact-warn px-2 text-[11px] font-semibold leading-[18px] text-black"
            >
              {t('artifacts.requests.badge', { count: item.pendingRequests })}
            </span>
          )}
          <span className="absolute bottom-2 right-2 rounded-full bg-black/75 px-1.5 font-mono text-[11px] leading-[18px] text-primary backdrop-blur-sm">
            v{item.currentVersion}
          </span>
          <button
            type="button"
            data-testid="artifact-open"
            className={cn(
              'artifact-open absolute left-1/2 top-1/2 z-[2] flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-lg transition-[opacity,translate] hover:bg-primary/90',
              opening && 'is-busy'
            )}
            aria-label={opening ? t('artifacts.opening') : t('artifacts.card.openLabel', { title: item.title })}
            aria-disabled={opening || undefined}
            onClick={() => !opening && onOpen()}
          >
            {opening ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            )}
            {opening ? t('artifacts.opening') : t('artifacts.card.open')}
          </button>
        </div>
      </div>
      <div className="min-w-0 px-0.5 pt-2.5">
        {projectLabel && (
          <p className="mb-0.5 truncate font-mono text-[11px] leading-4 text-muted-foreground">{projectLabel}</p>
        )}
        <div className="flex items-start gap-1.5">
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground" title={item.title}>
            {item.title}
          </h3>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="artifact-menu"
                className="relative z-[2] -mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                aria-label={t('artifacts.card.more', { title: item.title })}
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem] backdrop-blur-xl">
              <DropdownMenuItem onSelect={onOpen}>
                <ArrowUpRight /> {t('artifacts.menu.open')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onSelect}>
                <PanelRight /> {t('artifacts.menu.details')}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="artifact-share-open" onSelect={onShare}>
                <Share2 /> {t('artifacts.menu.share')}
              </DropdownMenuItem>
              {conversation?.exists && (
                <DropdownMenuItem onSelect={onGoToConversation}>
                  <MessagesSquare /> {t('artifacts.menu.conversation')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive data-testid="artifact-delete" onSelect={onDelete}>
                <Trash2 /> {t('artifacts.menu.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {item.description && (
          <p className="mb-2 mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
            {item.description}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {t('artifacts.card.updated', { when: relativeTime(locale, item.updatedAt) })}
          </span>
          {shared && (
            <span
              data-testid="artifact-card-visibility"
              title={t(`artifacts.visibility.${item.visibility}`)}
              className="flex shrink-0 items-center gap-1 rounded-full border border-border-strong px-1.5 text-[11px] leading-[18px] text-foreground/75"
            >
              {item.visibility === 'people' ? (
                <Users className="size-3" aria-hidden="true" />
              ) : (
                <Link2 className="size-3" aria-hidden="true" />
              )}
              {t(`artifacts.visibility.${item.visibility === 'people' ? 'peopleShort' : 'linkShort'}`)}
            </span>
          )}
          {showSize && (
            <span className="ml-auto font-mono text-[11.5px] text-foreground/75">{formatBytes(item.storageBytes)}</span>
          )}
        </div>
        <div className="mt-1.5">
          <ArtifactOrigin item={item} onGoToConversation={onGoToConversation} />
        </div>
      </div>
    </li>
  )
}
