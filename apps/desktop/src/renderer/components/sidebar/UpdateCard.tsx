import { useTranslation } from 'react-i18next'
import { ArrowRight, Download, ExternalLink, RotateCw, X } from 'lucide-react'
import { useUpdate } from '@/lib/use-update'
import { cn } from '@/lib/utils'

/**
 * Update card at the top of the sidebar footer. It only appears when there is something to act on,
 * and the whole card triggers the action for the current phase: download under explicit consent,
 * restart to install, or open the release page when this package cannot update itself. The `×`
 * skips the version, which the main process persists so the card stays gone until a newer release.
 */
export function UpdateCard() {
  const { t } = useTranslation('ui')
  const { state, download, install, skip, openRelease } = useUpdate()

  if (!state) return null
  const { phase, mode } = state
  if (phase !== 'available' && phase !== 'downloading' && phase !== 'downloaded') return null

  const notify = mode === 'notify'
  const percent = state.progressPercent ?? 0
  const clickable = phase !== 'downloading'
  const Icon = notify ? ExternalLink : phase === 'downloaded' ? RotateCw : Download
  const title = notify
    ? t('update.card.view')
    : phase === 'available'
      ? t('update.card.download')
      : phase === 'downloading'
        ? t('update.card.downloading')
        : t('update.card.restart')
  const version = state.availableVersion ? `v${state.availableVersion}` : ''

  const act = (): void => {
    if (notify) void openRelease()
    else if (phase === 'available') void download()
    else if (phase === 'downloaded') void install()
  }

  return (
    <div className="group relative mx-2 mb-1 mt-2 shrink-0">
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? act : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  act()
                }
              }
            : undefined
        }
        data-testid="sidebar-update-card"
        className={cn(
          'no-drag flex items-center gap-2.5 rounded-xl border border-border bg-white/[0.03] px-3 py-2.5 text-left transition-colors',
          clickable && 'cursor-pointer hover:bg-white/[0.06]'
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="size-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight text-foreground" title={title}>
            {title}
          </div>
          {version && <div className="truncate text-xs leading-tight text-muted-foreground">{version}</div>}
        </div>

        {phase === 'downloading' ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{percent}%</span>
        ) : (
          <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        )}
      </div>

      {phase !== 'downloading' && (
        <button
          type="button"
          onClick={() => void skip()}
          aria-label={t('update.card.skip')}
          title={t('update.card.skip')}
          className="no-drag absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
