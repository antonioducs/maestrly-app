import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PluginInspectionDto } from '../../../shared/plugins'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import { InstalledPlugins } from './InstalledPlugins'
import { PluginCatalog } from './PluginCatalog'
import { PluginDetails } from './PluginDetails'
import { BringPluginsDialog } from './BringPluginsDialog'
import { PluginInstallDialog } from './PluginInstallDialog'
import { PluginSourcesBar } from './PluginSourcesBar'
import { hostPluginsSource, type PluginsSource } from './plugins-source'
import { usePluginsState } from './use-plugins-state'

const VIEWS = ['browse', 'installed'] as const
type View = (typeof VIEWS)[number]

/**
 * The plugin center of one host (this computer, a remote workspaces host) or of a bot environment: sources, the
 * catalog with compatibility, details, consent-based installs and installed plugins.
 */
export function PluginsSettings({ source: providedSource }: { source?: PluginsSource } = {}) {
  const { t } = useTranslation('plugins')
  const hostApi = useHostApi()
  const remoteHost = useHostId() !== LOCAL_HOST_ID || Boolean(providedSource?.remote)
  const source = useMemo(() => providedSource ?? hostPluginsSource(hostApi), [providedSource, hostApi])
  const { state, refresh, error } = usePluginsState(source)
  const [view, setView] = useState<View>('browse')
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<{ marketplaceId: string; name: string } | null>(null)
  const [installing, setInstalling] = useState<PluginInspectionDto | null>(null)
  const [bringing, setBringing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [detailsRevision, setDetailsRevision] = useState(0)
  const tabsId = useId()
  const tabRefs = useRef<Record<View, HTMLButtonElement | null>>({ browse: null, installed: null })

  const marketplaces = state?.marketplaces ?? []
  // Start on the first source already opened; unopened presets are fetched only when selected.
  useEffect(() => {
    if (selected !== null || !state) return
    setSelected(marketplaces.find((marketplace) => marketplace.commit !== null)?.id ?? 'all')
  }, [state, selected])
  useEffect(() => {
    if (selected && selected !== 'all' && state && !marketplaces.some((marketplace) => marketplace.id === selected))
      setSelected('all')
  }, [state, selected])

  const changed = () => {
    setRevision((value) => value + 1)
    void refresh()
  }

  return (
    <div className="flex flex-col gap-3" data-testid="plugins-settings">
      <div>
        <span className="text-[12px] font-medium text-foreground">{t('heading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {remoteHost ? t('descriptionRemote') : t('description')}
        </p>
      </div>
      {state && !state.git.available && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-200">
          {remoteHost ? t('git.unavailableRemote') : t('git.unavailable')}
        </p>
      )}
      {state && !state.secureStorage && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-200">
          {t('secureStorage.unavailable')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {t('errors.install-failed')}
        </p>
      )}

      {details ? (
        <PluginDetails
          source={source}
          marketplaceId={details.marketplaceId}
          name={details.name}
          reloadSignal={detailsRevision}
          marketplaces={marketplaces}
          onBack={() => setDetails(null)}
          onInstall={setInstalling}
        />
      ) : (
        <>
          {state && source.bring && (
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setBringing(true)}>
                {t('bring.button')}
              </Button>
            </div>
          )}
          {state && (
            <PluginSourcesBar
              source={source}
              marketplaces={marketplaces}
              installed={state.installed}
              gitAvailable={state.git.available}
              selected={selected ?? 'all'}
              onSelect={(id) => {
                setSelected(id)
                setView('browse')
              }}
              onChanged={changed}
            />
          )}
          <div
            role="tablist"
            aria-label={t('views.label')}
            className="flex w-fit gap-1 rounded-lg bg-white/[0.035] p-1"
          >
            {VIEWS.map((id) => (
              <button
                key={id}
                ref={(node) => {
                  tabRefs.current[id] = node
                }}
                id={`${tabsId}-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={view === id}
                aria-controls={`${tabsId}-panel-${id}`}
                tabIndex={view === id ? 0 : -1}
                onClick={() => setView(id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const next = VIEWS[(VIEWS.indexOf(id) + 1) % VIEWS.length]
                  setView(next)
                  tabRefs.current[next]?.focus()
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px]',
                  view === id ? 'bg-white/[0.1] text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`views.${id}`)}
                {id === 'installed' && state ? ` · ${state.installed.length}` : ''}
              </button>
            ))}
          </div>
          <div
            id={`${tabsId}-panel-browse`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-browse`}
            hidden={view !== 'browse'}
          >
            {state && selected !== null && view === 'browse' && (
              <PluginCatalog
                source={source}
                marketplaces={marketplaces}
                selected={selected}
                onSelect={setSelected}
                revision={revision}
                onOpen={(entry) => setDetails({ marketplaceId: entry.marketplaceId, name: entry.name })}
              />
            )}
          </div>
          <div
            id={`${tabsId}-panel-installed`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-installed`}
            hidden={view !== 'installed'}
          >
            {state && view === 'installed' && (
              <InstalledPlugins
                source={source}
                installed={state.installed}
                onChanged={changed}
                onOpenDetails={(plugin) => setDetails({ marketplaceId: plugin.marketplaceId, name: plugin.name })}
              />
            )}
          </div>
        </>
      )}

      {bringing && source.bring && state && (
        <BringPluginsDialog
          source={{ ...source, bring: source.bring }}
          installedThere={new Set(state.installed.map((plugin) => plugin.key))}
          onClose={() => setBringing(false)}
          onBrought={changed}
        />
      )}
      {installing && (
        <PluginInstallDialog
          source={source}
          inspection={installing}
          mode={{ kind: 'install' }}
          onClose={() => setInstalling(null)}
          onDone={() => {
            setInstalling(null)
            setDetailsRevision((value) => value + 1)
            changed()
          }}
          onReinspect={() => {
            // The dialog stays open with the source's current version, so the person reviews it again.
            const current = installing
            setDetailsRevision((value) => value + 1)
            void source.pluginsInspect({ marketplaceId: current.marketplaceId, name: current.name }).then((result) => {
              if (result.ok) setInstalling(result.value)
            })
          }}
        />
      )}
    </div>
  )
}
