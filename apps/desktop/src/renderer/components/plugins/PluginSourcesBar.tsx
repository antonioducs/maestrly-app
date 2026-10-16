import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { relativeTime } from '@/components/sidebar/relative-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { InstalledPluginDto, PluginMarketplaceDto } from '../../../shared/plugins'
import { AddPluginSourceDialog } from './AddPluginSourceDialog'
import type { PluginsSource } from './plugins-source'
import { errorText, marketplaceLabel, shortCommit } from './plugin-ui'

const sourceName = marketplaceLabel

/** One card per marketplace source, with refresh and remove, plus the dialog that adds a source. */
export function PluginSourcesBar({
  source,
  marketplaces,
  installed,
  gitAvailable,
  selected,
  onSelect,
  onChanged,
}: {
  source: PluginsSource
  marketplaces: PluginMarketplaceDto[]
  installed: InstalledPluginDto[]
  gitAvailable: boolean
  selected: string
  onSelect: (marketplaceId: string) => void
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation('plugins')
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PluginMarketplaceDto | null>(null)
  const [uninstallToo, setUninstallToo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (marketplace: PluginMarketplaceDto) => {
    setRefreshing(marketplace.id)
    setError(null)
    try {
      const result = await source.pluginsMarketplaceRefresh(marketplace.id)
      if (!result.ok) setError(t(`sources.error.${result.error}`, { defaultValue: errorText(t, result.error) }))
      source.notifyChanged()
      onChanged()
    } finally {
      setRefreshing(null)
    }
  }

  const fromSource = removing ? installed.filter((plugin) => plugin.marketplaceId === removing.id) : []
  const remove = async () => {
    if (!removing) return
    setBusy(true)
    setError(null)
    try {
      const result = await source.pluginsMarketplaceRemove({ id: removing.id, uninstall: uninstallToo })
      if (!result.ok) {
        setError(errorText(t, result.error))
        return
      }
      setRemoving(null)
      source.notifyChanged()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('sources.heading')} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-medium text-foreground">{t('sources.heading')}</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAdding(true)}
          disabled={!gitAvailable}
          className="h-7 px-2 text-[12px]"
        >
          <Plus /> {t('sources.add')}
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {marketplaces.map((marketplace) => (
          <li
            key={marketplace.id}
            className={cn(
              'flex min-w-56 max-w-80 flex-1 items-start gap-2 rounded-lg border bg-white/[0.02] px-2.5 py-2',
              selected === marketplace.id ? 'border-indigo-500/60' : 'border-border'
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelect(marketplace.id)}
              aria-pressed={selected === marketplace.id}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] text-foreground">{sourceName(marketplace)}</span>
                {marketplace.preset ? (
                  <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                    {t('sources.preset')}
                  </span>
                ) : (
                  <span
                    className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-200"
                    title={t('sources.thirdParty')}
                  >
                    {t('sources.thirdPartyLabel')}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-muted-foreground" title={marketplace.url}>
                {marketplace.url}
                {marketplace.ref ? (
                  <span className="ml-1 inline-flex items-center gap-0.5">
                    <GitBranch className="inline h-3 w-3" />
                    {marketplace.ref}
                  </span>
                ) : null}
              </div>
              <div className="text-[10px] text-muted-foreground/80">
                {marketplace.fetchedAt
                  ? t('sources.fetchedAt', { time: relativeTime(i18n.language, marketplace.fetchedAt) })
                  : t('sources.neverFetched')}
                {marketplace.commit ? ` · ${t('sources.commit', { commit: shortCommit(marketplace.commit) })}` : ''}
                {marketplace.pluginCount !== null
                  ? ` · ${t('sources.plugins', { count: marketplace.pluginCount })}`
                  : ''}
              </div>
              {marketplace.error && (
                <div className="text-[11px] text-destructive">{t(`sources.error.${marketplace.error}`)}</div>
              )}
            </button>
            <button
              type="button"
              onClick={() => void refresh(marketplace)}
              disabled={!gitAvailable || refreshing !== null}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              title={refreshing === marketplace.id ? t('sources.refreshing') : t('sources.refresh')}
              aria-label={`${t('sources.refresh')} ${sourceName(marketplace)}`}
            >
              {refreshing === marketplace.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setUninstallToo(false)
                setError(null)
                setRemoving(marketplace)
              }}
              className="text-muted-foreground hover:text-destructive"
              title={t('sources.remove')}
              aria-label={`${t('sources.remove')} ${sourceName(marketplace)}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {error && !removing && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {adding && (
        <AddPluginSourceDialog
          source={source}
          gitAvailable={gitAvailable}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            onSelect(id)
            onChanged()
          }}
        />
      )}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && !busy && setRemoving(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('sources.removeTitle', { name: sourceName(removing) })}</DialogTitle>
              <DialogDescription>
                {fromSource.length
                  ? t('sources.removeBlocked', { count: fromSource.length })
                  : t('sources.removeConfirm')}
              </DialogDescription>
            </DialogHeader>
            {fromSource.length > 0 && (
              <label className="flex items-center gap-2 text-[12px] text-foreground">
                <input
                  type="checkbox"
                  checked={uninstallToo}
                  onChange={(event) => setUninstallToo(event.target.checked)}
                />
                {t('sources.uninstallToo', { count: fromSource.length })}
              </label>
            )}
            {error && (
              <p role="alert" className="text-[12px] text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(null)} disabled={busy}>
                {t('installed.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || (fromSource.length > 0 && !uninstallToo)}
                onClick={() => void remove()}
              >
                {busy && <Loader2 className="animate-spin" />}
                {t('sources.remove')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
