import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import type { PluginCatalogEntryDto, PluginMarketplaceDto } from '../../../shared/plugins'
import { partitionCatalog } from './catalog-partition'
import { PluginCard } from './PluginCard'
import type { PluginsSource } from './plugins-source'
import { errorText, inputCls, marketplaceLabel, reasonText } from './plugin-ui'

/**
 * Plugins of one source, or of every source already opened. A source that was never fetched is fetched only when
 * the user selects it.
 */
export function PluginCatalog({
  source,
  marketplaces,
  selected,
  onSelect,
  revision,
  onOpen,
}: {
  source: PluginsSource
  marketplaces: PluginMarketplaceDto[]
  selected: string
  onSelect: (marketplaceId: string) => void
  /** Changes whenever sources or installs change, to reload the catalog. */
  revision: number
  onOpen: (entry: PluginCatalogEntryDto) => void
}) {
  const { t } = useTranslation('plugins')
  const [entries, setEntries] = useState<PluginCatalogEntryDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [category, setCategory] = useState('')
  const request = useRef(0)

  const targets = useMemo(
    () =>
      selected === 'all'
        ? marketplaces.filter((marketplace) => marketplace.commit !== null)
        : marketplaces.filter((marketplace) => marketplace.id === selected),
    [marketplaces, selected]
  )
  const targetKey = targets.map((marketplace) => `${marketplace.id}@${marketplace.commit}`).join(',')

  useEffect(() => {
    const current = ++request.current
    if (!targets.length) {
      setEntries([])
      return
    }
    setLoading(true)
    setError(null)
    void Promise.all(targets.map((marketplace) => source.pluginsCatalog(marketplace.id)))
      .then((results) => {
        if (current !== request.current) return
        const failed = results.find((result) => !result.ok)
        if (failed && !failed.ok) setError(errorText(t, failed.error))
        setEntries(results.flatMap((result) => (result.ok ? result.value : [])))
      })
      .catch((cause) => {
        if (current === request.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current === request.current) setLoading(false)
      })
  }, [source, targetKey, revision])

  // Only plugins that work the same with every model are offered; the rest are counted, with why, below the list.
  const { offered, incompatible } = useMemo(() => partitionCatalog(entries), [entries])
  const categories = useMemo(
    () => [...new Set(offered.map((entry) => entry.category).filter((value): value is string => !!value))].sort(),
    [offered]
  )
  const needle = query.trim().toLowerCase()
  const visible = offered.filter((entry) => {
    if (category && entry.category !== category) return false
    if (!needle) return true
    return `${entry.displayName} ${entry.name} ${entry.description ?? ''} ${entry.publisher ?? ''}`
      .toLowerCase()
      .includes(needle)
  })

  if (!marketplaces.length) return <p className="text-[12px] text-muted-foreground">{t('browse.noSources')}</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputCls} pl-7`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('browse.search')}
            aria-label={t('browse.search')}
          />
        </div>
        <OptionSelect
          value={selected}
          onValueChange={onSelect}
          className="h-8 w-48 text-xs"
          aria-label={t('filters.source')}
        >
          <SelectOption value="all">{t('browse.all')}</SelectOption>
          {marketplaces.map((marketplace) => (
            <SelectOption key={marketplace.id} value={marketplace.id}>
              {marketplaceLabel(marketplace)}
            </SelectOption>
          ))}
        </OptionSelect>
        {categories.length > 0 && (
          <OptionSelect
            value={category}
            onValueChange={setCategory}
            className="h-8 w-44 text-xs"
            aria-label={t('filters.category')}
          >
            <SelectOption value="">{t('filters.allCategories')}</SelectOption>
            {categories.map((value) => (
              <SelectOption key={value} value={value}>
                {value}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
      </div>
      {loading && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('browse.loading')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && offered.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('browse.empty')}</p>
      )}
      {!loading && offered.length > 0 && visible.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('browse.noMatches')}</p>
      )}
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 lg:grid-cols-2">
        {visible.map((entry) => (
          <PluginCard
            key={`${entry.marketplaceId}/${entry.name}`}
            source={source}
            entry={entry}
            onOpen={() => onOpen(entry)}
          />
        ))}
      </div>
      {incompatible.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-2">
          <button
            type="button"
            aria-expanded={showIncompatible}
            onClick={() => setShowIncompatible((value) => !value)}
            className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {showIncompatible ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('browse.incompatible', { count: incompatible.length })}
          </button>
          {showIncompatible && (
            <ul className="flex flex-col gap-1 pl-5" data-testid="incompatible-plugins">
              {incompatible.map(({ entry, reason }) => (
                <li key={`${entry.marketplaceId}/${entry.name}`} className="text-[12px] text-muted-foreground">
                  <span className="text-foreground">{entry.displayName}</span> · {reasonText(t, reason)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
