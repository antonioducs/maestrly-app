import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUpdate } from '@/lib/use-update'
import type { TFn } from './shared'

/**
 * Updates settings: current version, what this build can do about updates, an on-demand check that
 * ignores a previously skipped version, and the action matching the current phase.
 */
export function UpdatesSection({ t }: { t: TFn }) {
  const { state, check, download, install, openRelease } = useUpdate()

  const checking = state?.phase === 'checking'
  const disabled = !state || checking || state.mode === 'off'

  const status = (): string => {
    if (!state) return ''
    if (state.phase === 'error') return t('update.settings.error', { error: state.error ?? '' })
    if (state.phase === 'downloaded') return t('update.settings.downloaded', { version: state.availableVersion ?? '' })
    if (state.phase === 'available' || state.phase === 'downloading')
      return t('update.settings.available', { version: state.availableVersion ?? '' })
    if (state.lastCheckedAt) return t('update.settings.upToDate')
    return ''
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-foreground">{t('update.settings.title')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{t('update.settings.desc')}</div>
        </div>

        <div className="text-xs text-foreground">
          {t('update.settings.current', { version: state?.currentVersion ?? '' })}
        </div>

        {state?.mode === 'off' && (
          <div className="text-[11px] leading-snug text-muted-foreground">{t('update.settings.modeOff')}</div>
        )}
        {state?.mode === 'notify' && (
          <div className="text-[11px] leading-snug text-muted-foreground">{t('update.settings.modeNotify')}</div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void check(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-white/[0.04] disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
            {checking ? t('update.settings.checking') : t('update.settings.check')}
          </button>

          {state?.mode === 'notify' && state.phase === 'available' && (
            <button
              type="button"
              onClick={() => void openRelease()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-white/[0.04]"
            >
              <ExternalLink className="size-3.5" /> {t('update.card.view')}
            </button>
          )}
          {state?.mode === 'installer' && state.phase === 'available' && (
            <button
              type="button"
              onClick={() => void download()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-white/[0.04]"
            >
              <Download className="size-3.5" /> {t('update.card.download')}
            </button>
          )}
          {state?.phase === 'downloaded' && (
            <button
              type="button"
              onClick={() => void install()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-white/[0.04]"
            >
              <RotateCw className="size-3.5" /> {t('update.card.restart')}
            </button>
          )}
        </div>

        {status() && <div className="text-[11px] text-muted-foreground">{status()}</div>}
        {state?.phase === 'downloading' && (
          <div className="text-[11px] tabular-nums text-muted-foreground">
            {t('update.card.downloading')} {state.progressPercent ?? 0}%
          </div>
        )}
        {state?.lastCheckedAt && (
          <div className="text-[11px] text-muted-foreground">
            {t('update.settings.lastChecked', { time: new Date(state.lastCheckedAt).toLocaleString() })}
          </div>
        )}

        {state?.releaseNotes && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-medium text-foreground">{t('update.settings.releaseNotes')}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-black/30 p-2 text-[10px] leading-relaxed text-muted-foreground">
              {state.releaseNotes}
            </pre>
          </div>
        )}
      </div>
    </section>
  )
}
