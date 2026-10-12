import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginCatalogEntryDto } from '../../../shared/plugins'
import { CompatibilityBadge } from './CompatibilityBadge'
import type { PluginsSource } from './plugins-source'
import { initials } from './plugin-ui'

/** Logo loaded on demand from the source (PNG, JPEG or WebP checked by the host), or the name's initials. */
export function PluginLogo({
  source,
  marketplaceId,
  name,
  displayName,
  hasLogo,
  size = 36,
}: {
  source: PluginsSource
  marketplaceId: string
  name: string
  displayName: string
  hasLogo: boolean
  size?: number
}) {
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    if (!hasLogo) return
    let alive = true
    void source
      .pluginsLogo({ marketplaceId, name })
      .then((value) => {
        if (alive) setLogo(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [source, marketplaceId, name, hasLogo])
  const style = { width: size, height: size }
  if (logo)
    return <img src={logo} alt="" style={style} className="shrink-0 rounded-md bg-white/[0.04] object-contain" />
  return (
    <span
      aria-hidden="true"
      style={style}
      className="flex shrink-0 items-center justify-center rounded-md bg-indigo-500/15 text-[12px] font-semibold text-indigo-200"
    >
      {initials(displayName)}
    </span>
  )
}

export function PluginCard({
  source,
  entry,
  onOpen,
}: {
  source: PluginsSource
  entry: PluginCatalogEntryDto
  onOpen: () => void
}) {
  const { t } = useTranslation('plugins')
  const blocked = entry.policy.installation === 'NOT_AVAILABLE'
  return (
    <button
      type="button"
      onClick={onOpen}
      data-plugin={entry.name}
      className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-white/[0.02] p-2.5 text-left hover:border-white/20 hover:bg-white/[0.04]"
    >
      <PluginLogo
        source={source}
        marketplaceId={entry.marketplaceId}
        name={entry.name}
        displayName={entry.displayName}
        hasLogo={entry.hasLogo}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">{entry.displayName}</span>
          {entry.version && <span className="shrink-0 text-[10px] text-muted-foreground">{entry.version}</span>}
        </div>
        {entry.publisher && <div className="truncate text-[11px] text-muted-foreground">{entry.publisher}</div>}
        {entry.description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{entry.description}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {blocked ? (
            <CompatibilityBadge
              compatibility={{ level: 'unavailable', reasons: [{ code: 'install-not-available' }] }}
            />
          ) : (
            <CompatibilityBadge compatibility={entry.compatibility} />
          )}
          {entry.installed && (
            <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] text-indigo-200">
              {t('browse.installed')}
            </span>
          )}
          {entry.updateAvailable && (
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200">
              {t('browse.updateAvailable')}
            </span>
          )}
          {entry.category && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {entry.category}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
