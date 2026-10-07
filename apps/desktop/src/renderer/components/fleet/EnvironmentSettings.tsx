import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { FLEET_ENVIRONMENT_SETTINGS_FEATURE, type FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useFleetProvisioning } from '@/lib/fleet/provisioning'
import { MAIN_NAVIGATION_EVENT, requestMainNavigation, type MainNavigationDetail } from '@/lib/main-navigation'
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
import { EnvironmentAccounts } from './environment-settings/EnvironmentAccounts'
import { EnvironmentModels } from './environment-settings/EnvironmentModels'
import { EnvironmentSkills } from './environment-settings/EnvironmentSkills'
import { EnvironmentMcp } from './environment-settings/EnvironmentMcp'
import { EnvironmentComponents } from './environment-settings/EnvironmentComponents'
import { EnvironmentPreferences } from './environment-settings/EnvironmentPreferences'
import { SharedSaveBarScope } from './environment-settings/shared'
import { EnvironmentConfirm } from './EnvironmentConfirm'
import { MacImportDialog } from './MacImportDialog'
import {
  ENVIRONMENT_SETTINGS_SECTIONS,
  type EnvironmentSettingsSection,
  type EnvironmentSettingsDraft,
} from './environment-settings/sections'

const panels = {
  accounts: EnvironmentAccounts,
  models: EnvironmentModels,
  skills: EnvironmentSkills,
  tools: EnvironmentMcp,
  components: EnvironmentComponents,
  preferences: EnvironmentPreferences,
}
/** The settings sections, then archiving the environment, which acts at once. */
const TABS = [...ENVIRONMENT_SETTINGS_SECTIONS, 'archive'] as const
type Tab = (typeof TABS)[number]
const tabId = (tab: Tab) => `environment-settings-tab-${tab}`
const panelId = (tab: Tab) => `environment-settings-panel-${tab}`
const saveShortcut = () => (window.api.platformInfo.os === 'mac' ? '⌘S' : 'Ctrl+S')

/** A leave the owner is asked about: what to save or discard first, and where to go then. */
interface Pending {
  tabs: EnvironmentSettingsSection[]
  proceed: () => void
}

/**
 * An environment's settings, in a panel over its view: one tab per section of the existing desktop settings, bound
 * exclusively to the environment. A section's panel mounts when its tab is first opened and stays, so its draft
 * survives moving between tabs; one bar saves every section with unsaved changes. Leaving the panel, or the view,
 * with unsaved changes asks first; so does leaving one editor of a section, about that section only.
 */
export function EnvironmentSettingsSheet({
  environment,
  fleet,
  section,
  onClose,
  onOpenScreen,
  onOpenBot,
  onArchived,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  /** The tab to show; a later one moves the panel to it. */
  section?: EnvironmentSettingsSection
  onClose: () => void
  onOpenScreen: () => void
  onOpenBot: (botId: string) => void
  onArchived: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const [active, setActive] = useState<Tab>(section ?? 'accounts')
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([section ?? 'accounts']))
  const show = useCallback((tab: Tab) => {
    setActive(tab)
    setVisited((current) => (current.has(tab) ? current : new Set([...current, tab])))
  }, [])
  useEffect(() => {
    if (section) show(section)
  }, [section, show])

  // ---- Drafts: each section reports its own; the panel saves, discards and asks about them together. ----
  const drafts = useRef(new Map<EnvironmentSettingsSection, EnvironmentSettingsDraft>())
  const [dirty, setDirty] = useState<EnvironmentSettingsSection[]>([])
  const report = useMemo(
    () =>
      Object.fromEntries(
        ENVIRONMENT_SETTINGS_SECTIONS.map((name) => [
          name,
          (isDirty: boolean, save: () => Promise<boolean>, discard: () => void) => {
            drafts.current.set(name, { dirty: isDirty, save, discard })
            setDirty((current) => {
              const next = ENVIRONMENT_SETTINGS_SECTIONS.filter((item) =>
                item === name ? isDirty : current.includes(item)
              )
              return next.length === current.length && next.every((item, index) => item === current[index])
                ? current
                : next
            })
          },
        ])
      ) as Record<
        EnvironmentSettingsSection,
        (dirty: boolean, save: () => Promise<boolean>, discard: () => void) => void
      >,
    []
  )
  const dirtyOf = (tabs: EnvironmentSettingsSection[]) => tabs.filter((tab) => drafts.current.get(tab)?.dirty)

  const serverCapable = fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const imageCapable = environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const connected = fleet.state.connection.state === 'connected'
  const running = environment.lifecycle === 'running'
  const ready = serverCapable && imageCapable && connected && running
  const reason = !serverCapable
    ? 'updateServer'
    : !imageCapable
      ? 'updateEnvironment'
      : !connected
        ? 'offline'
        : !running
          ? 'stopped'
          : null

  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  /** Saves the sections in order; the first that fails is shown, with its error, and stops the rest. */
  const saveTabs = useCallback(
    async (tabs: EnvironmentSettingsSection[]): Promise<boolean> => {
      if (saving || !ready) return false
      setSaving(true)
      setSaveFailed(false)
      try {
        for (const tab of dirtyOf(tabs)) {
          let ok = false
          try {
            ok = (await drafts.current.get(tab)?.save()) ?? true
          } catch {
            ok = false
          }
          if (!ok) {
            setSaveFailed(true)
            show(tab)
            return false
          }
        }
        return true
      } finally {
        setSaving(false)
      }
    },
    [saving, ready, show]
  )
  const discardTabs = useCallback((tabs: EnvironmentSettingsSection[]) => {
    for (const tab of dirtyOf(tabs)) drafts.current.get(tab)?.discard()
    setSaveFailed(false)
  }, [])

  // A leave that the owner allowed must not be asked about again: the drafts report their new state only later.
  const leaving = useRef(false)
  const go = useCallback((proceed: () => void) => {
    leaving.current = true
    try {
      proceed()
    } finally {
      leaving.current = false
    }
  }, [])
  /** Runs `proceed` at once, or once the owner saved or discarded the changes of `tabs`. */
  const leave = useCallback(
    (proceed: () => void, tabs: EnvironmentSettingsSection[] = [...ENVIRONMENT_SETTINGS_SECTIONS]) => {
      const unsaved = dirtyOf(tabs)
      if (!unsaved.length) go(proceed)
      else {
        setSaveFailed(false)
        setPending({ tabs: unsaved, proceed })
      }
    },
    [go]
  )
  const latestActive = useRef(active)
  latestActive.current = active
  useEffect(() => {
    const request = (event: Event) => {
      if (leaving.current) return
      const { proceed, scope } = (event as CustomEvent<MainNavigationDetail>).detail
      // Closing a section's editor asks about that section only; leaving the view, about every section.
      const tabs =
        scope === 'section'
          ? (ENVIRONMENT_SETTINGS_SECTIONS as readonly string[]).includes(latestActive.current)
            ? [latestActive.current as EnvironmentSettingsSection]
            : []
          : [...ENVIRONMENT_SETTINGS_SECTIONS]
      const unsaved = dirtyOf(tabs)
      if (!unsaved.length) return
      event.preventDefault()
      setSaveFailed(false)
      setPending({ tabs: unsaved, proceed })
    }
    window.addEventListener(MAIN_NAVIGATION_EVENT, request)
    return () => window.removeEventListener(MAIN_NAVIGATION_EVENT, request)
  }, [])
  const requestClose = () => leave(onClose)
  const latest = useRef({ pending, ready, saveTabs })
  latest.current = { pending, ready, saveTabs }
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return
      // Read the drafts, not the rendered list: a key pressed right after an edit arrives before that list updates.
      if (![...drafts.current.values()].some((draft) => draft.dirty)) return
      event.preventDefault()
      if (latest.current.ready && !latest.current.pending)
        void latest.current.saveTabs([...ENVIRONMENT_SETTINGS_SECTIONS])
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const finish = () => {
    const proceed = pending?.proceed
    setPending(null)
    if (proceed) go(proceed)
  }
  const saveAndLeave = async () => {
    if (!pending || saving || !ready) return
    if (await saveTabs(pending.tabs)) finish()
  }

  // ---- Bringing skills or MCP servers from this computer remounts that section, with what was brought. ----
  const [importing, setImporting] = useState<'skills' | 'tools' | null>(null)
  const [revisions, setRevisions] = useState<Partial<Record<EnvironmentSettingsSection, number>>>({})
  const importLists = useFleetProvisioning({ environmentId: environment.id }, importing !== null && ready)

  const [archiving, setArchiving] = useState(false)
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(active)
    const next =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index + TABS.length - 1) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS[TABS.length - 1]
              : null
    if (!next) return
    event.preventDefault()
    show(next)
    const button = document.getElementById(tabId(next))
    button?.focus()
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const tabLabel = (tab: Tab) => t(`environmentSettingsShell.sections.${tab}`)
  const bots = fleet.state.snapshot.bots.filter((bot) => environment.botIds.includes(bot.id))
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        data-environment-settings-sheet
        data-testid="environment-settings"
        // Asking opens a dialog of its own: wait out the press, or its focus change would dismiss that dialog at once.
        onPointerDownOutside={(event) => {
          event.preventDefault()
          window.setTimeout(requestClose, 0)
        }}
        className="left-auto right-0 top-0 flex h-full w-[min(780px,94vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 shadow-[-30px_0_60px_rgba(0,0,0,0.45)] data-[state=open]:slide-in-from-right-8 sm:rounded-none"
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 pl-[18px] pr-3">
          <DialogTitle className="truncate text-[15px] leading-none tracking-normal">
            {t('environmentSettingsShell.sheetTitle', { name: environment.name })}
          </DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-[30px] shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t('environmentSettingsShell.close')}
            title={t('environmentSettingsShell.close')}
            onClick={requestClose}
          >
            <X />
          </Button>
        </header>
        <p className="-mt-1.5 px-[18px] pb-2.5 text-[12.5px] text-muted-foreground">
          {t('environmentSettingsShell.shared')}{' '}
          {bots.length
            ? bots.map((bot, index) => (
                <span key={bot.id}>
                  {index > 0 && ', '}
                  <button
                    type="button"
                    className="text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => leave(() => onOpenBot(bot.id))}
                  >
                    {bot.name}
                  </button>
                </span>
              ))
            : t('environmentSettingsShell.noBots')}
          {'. '}
          {t('environmentSettingsShell.localSeparate')}
        </p>
        <div
          role="tablist"
          aria-label={t('environmentSettingsShell.tabs')}
          className="flex shrink-0 gap-4 overflow-x-auto border-b border-border px-[18px] [scrollbar-width:none]"
        >
          {TABS.map((tab) => {
            const selected = tab === active
            const changed = (dirty as string[]).includes(tab)
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={tabId(tab)}
                aria-selected={selected}
                aria-controls={panelId(tab)}
                tabIndex={selected ? 0 : -1}
                onClick={() => show(tab)}
                onKeyDown={onTabKey}
                className={cn(
                  'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap py-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t after:bg-primary after:content-[" "]',
                  selected
                    ? 'text-foreground after:opacity-100'
                    : 'text-muted-foreground after:opacity-0 hover:text-foreground'
                )}
              >
                <span>{tabLabel(tab)}</span>
                {changed && (
                  <>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                    <span className="sr-only">, {t('botSettings.sectionDirty')}</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-1 flex-col gap-4 px-[18px] pb-4 pt-5">
            {reason && active !== 'archive' && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[12.5px]"
              >
                <p className="min-w-56 flex-1">{t(`environmentSettingsShell.${reason}`)}</p>
                {running && (
                  <Button size="sm" variant="outline" onClick={() => leave(onOpenScreen)}>
                    {t('environment.openScreen')}
                  </Button>
                )}
                {!running && connected && (
                  <Button size="sm" onClick={() => void fleet.environmentAction(environment.id, 'start')}>
                    {t('environment.start')}
                  </Button>
                )}
              </div>
            )}
            {serverCapable &&
              imageCapable &&
              ENVIRONMENT_SETTINGS_SECTIONS.filter((tab) => visited.has(tab)).map((tab) => {
                const Panel = panels[tab]
                return (
                  <div
                    key={tab}
                    id={panelId(tab)}
                    role="tabpanel"
                    aria-labelledby={tabId(tab)}
                    hidden={tab !== active}
                    inert={!ready}
                    className={cn('space-y-3', !ready && 'opacity-60')}
                  >
                    {(tab === 'skills' || tab === 'tools') && (
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!ready}
                          onClick={() => requestMainNavigation(() => setImporting(tab), 'section')}
                        >
                          {t('provisioning.fromMacButton')}
                        </Button>
                      </div>
                    )}
                    <SharedSaveBarScope>
                      <Panel
                        key={`${environment.id}:${tab}:${revisions[tab] ?? 0}`}
                        environment={environment}
                        fleet={fleet}
                        onDirtyChange={report[tab]}
                      />
                    </SharedSaveBarScope>
                  </div>
                )
              })}
            {active === 'archive' && (
              <div id={panelId('archive')} role="tabpanel" aria-labelledby={tabId('archive')} className="space-y-3">
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('environment.lifecycleNote')}</p>
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 p-[18px]">
                  <p className="min-w-64 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {t('environment.archiveNote')}
                  </p>
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setArchiving(true)}
                  >
                    {t('environment.archive', { name: environment.name })}
                  </Button>
                </div>
              </div>
            )}
          </div>
          {(dirty.length > 0 || saveFailed) && (
            <div className="sticky bottom-0 px-[18px] pb-4">
              <section
                aria-label={t('botSettings.saveBar.region')}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-border-strong bg-popover py-2.5 pl-4 pr-2.5 shadow-[0_14px_44px_rgba(0,0,0,0.5)] backdrop-blur-xl animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <strong className="text-[13px] font-semibold">
                    {t('botSettings.saveBar.count', { count: dirty.length })}
                  </strong>
                  <span className="flex flex-wrap gap-1">
                    {dirty.map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => show(tab)}
                        className="rounded-full border border-border-strong px-2 py-px text-xs text-foreground/75 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {tabLabel(tab)}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => discardTabs([...ENVIRONMENT_SETTINGS_SECTIONS])}
                  >
                    {t('botSettings.saveBar.discard')}
                  </Button>
                  <Button
                    disabled={saving || !ready || !dirty.length}
                    onClick={() => void saveTabs([...ENVIRONMENT_SETTINGS_SECTIONS])}
                  >
                    {saving ? t('botSettings.saveBar.saving') : t('botSettings.save')}
                    {!saving && (
                      <kbd
                        aria-hidden="true"
                        className="rounded border border-current px-1 font-sans text-[11px] font-medium opacity-55"
                      >
                        {saveShortcut()}
                      </kbd>
                    )}
                  </Button>
                </div>
                {(saveFailed || (reason && dirty.length > 0)) && (
                  <p
                    role="alert"
                    className={cn(
                      'order-3 basis-full text-[12.5px]',
                      saveFailed ? 'text-destructive' : 'text-amber-300'
                    )}
                  >
                    {saveFailed ? t('environmentSettingsShell.saveFailed') : t(`environmentSettingsShell.${reason}`)}
                  </p>
                )}
              </section>
            </div>
          )}
        </div>
        {importing && (
          <MacImportDialog
            subject={{ target: { environmentId: environment.id }, name: environment.name, running }}
            lists={importLists}
            groups={importing === 'skills' ? ['skills'] : ['mcp']}
            onClose={() => {
              const tab = importing
              setImporting(null)
              setRevisions((current) => ({ ...current, [tab]: (current[tab] ?? 0) + 1 }))
            }}
          />
        )}
        {archiving && (
          <EnvironmentConfirm
            kind="archive"
            environment={environment}
            fleet={fleet}
            onCancel={() => setArchiving(false)}
            onDone={() => {
              // The environment and its drafts are gone: nothing is left to ask about.
              discardTabs([...ENVIRONMENT_SETTINGS_SECTIONS])
              setArchiving(false)
              go(onArchived)
            }}
          />
        )}
        <Dialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open && !saving) setPending(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('environmentSettingsShell.leaveTitle')}</DialogTitle>
              <DialogDescription>
                {t('environmentSettingsShell.leaveDescription', {
                  name: environment.name,
                  sections: list.format((pending?.tabs ?? []).map(tabLabel)),
                })}
              </DialogDescription>
            </DialogHeader>
            {saveFailed && (
              <p role="alert" className="text-xs text-destructive">
                {t('environmentSettingsShell.saveFailed')}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" disabled={saving} onClick={() => setPending(null)}>
                {t('environmentSettingsShell.keepEditing')}
              </Button>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  if (pending) discardTabs(pending.tabs)
                  finish()
                }}
              >
                {t('environmentSettingsShell.discardLeave')}
              </Button>
              <Button disabled={saving || !ready} onClick={() => void saveAndLeave()}>
                {t('environmentSettingsShell.saveLeave')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
