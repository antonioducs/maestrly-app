import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_ENVIRONMENT_SETTINGS_FEATURE, type FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useFleetProvisioning } from '@/lib/fleet/provisioning'
import { MAIN_NAVIGATION_EVENT, requestMainNavigation } from '@/lib/main-navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EnvironmentAccounts } from './environment-settings/EnvironmentAccounts'
import { EnvironmentModels } from './environment-settings/EnvironmentModels'
import { EnvironmentSkills } from './environment-settings/EnvironmentSkills'
import { EnvironmentMcp } from './environment-settings/EnvironmentMcp'
import { EnvironmentComponents } from './environment-settings/EnvironmentComponents'
import { EnvironmentPreferences } from './environment-settings/EnvironmentPreferences'
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

/** The existing desktop settings composition, bound exclusively to one environment. */
export function EnvironmentSettings({
  environment,
  fleet,
  section = 'accounts',
  onSection,
  onOpenScreen,
  onOpenBot,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  section?: EnvironmentSettingsSection
  onSection: (section: EnvironmentSettingsSection) => void
  onOpenScreen: () => void
  onOpenBot: (botId: string) => void
}) {
  const { t } = useTranslation('fleet')
  const draft = useRef<EnvironmentSettingsDraft | null>(null)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importsRevision, setImportsRevision] = useState(0)
  const serverCapable = fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const imageCapable = environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const connected = fleet.state.connection.state === 'connected'
  const running = environment.lifecycle === 'running'
  const ready = serverCapable && imageCapable && connected && running
  const importLists = useFleetProvisioning({ environmentId: environment.id }, importing && ready)
  const reason = !serverCapable
    ? 'updateServer'
    : !imageCapable
      ? 'updateEnvironment'
      : !connected
        ? 'offline'
        : !running
          ? 'stopped'
          : null
  const Panel = panels[section]
  const onDirtyChange = useCallback((dirty: boolean, save: () => Promise<boolean>, discard: () => void) => {
    draft.current = { dirty, save, discard }
  }, [])
  useEffect(() => {
    draft.current = null
    setSaveFailed(false)
  }, [environment.id, section])
  useEffect(() => {
    const leaving = (event: Event) => {
      if (!draft.current?.dirty) return
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed: () => void }>).detail.proceed
      setPending(() => proceed)
      setSaveFailed(false)
    }
    window.addEventListener(MAIN_NAVIGATION_EVENT, leaving)
    return () => window.removeEventListener(MAIN_NAVIGATION_EVENT, leaving)
  }, [])
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || !draft.current?.dirty) return
      event.preventDefault()
      if (ready && !pending) void draft.current.save()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [ready, pending])
  const changeSection = (next: EnvironmentSettingsSection) => {
    if (next !== section) requestMainNavigation(() => onSection(next))
  }
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ENVIRONMENT_SETTINGS_SECTIONS.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % ENVIRONMENT_SETTINGS_SECTIONS.length
            : event.key === 'ArrowLeft'
              ? (index - 1 + ENVIRONMENT_SETTINGS_SECTIONS.length) % ENVIRONMENT_SETTINGS_SECTIONS.length
              : null
    if (next === null) return
    event.preventDefault()
    changeSection(ENVIRONMENT_SETTINGS_SECTIONS[next])
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>('#environment-settings-tab-' + ENVIRONMENT_SETTINGS_SECTIONS[next])
      ?.focus()
  }
  const finish = () => {
    const proceed = pending
    draft.current = null
    setPending(null)
    proceed?.()
  }
  const saveAndLeave = async () => {
    if (saving || !ready) return
    setSaving(true)
    setSaveFailed(false)
    try {
      if (await draft.current?.save()) finish()
      else setSaveFailed(true)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const bots = fleet.state.snapshot.bots.filter((bot) => environment.botIds.includes(bot.id))
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6" data-testid="environment-settings">
      <div className="mx-auto max-w-3xl space-y-3">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('environmentSettingsShell.title')}</h2>
            {(section === 'skills' || section === 'tools') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!ready}
                onClick={() => requestMainNavigation(() => setImporting(true))}
              >
                {t('provisioning.fromMacButton')}
              </Button>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {t('environmentSettingsShell.shared')}{' '}
            {bots.length
              ? bots.map((bot, index) => (
                  <span key={bot.id}>
                    {index > 0 && ', '}
                    <button
                      type="button"
                      className="text-foreground hover:underline"
                      onClick={() => requestMainNavigation(() => onOpenBot(bot.id))}
                    >
                      {bot.name}
                    </button>
                  </span>
                ))
              : t('environmentSettingsShell.noBots')}
            {'. '}
            {t('environmentSettingsShell.localSeparate')}
          </p>
        </div>
        <div
          role="tablist"
          aria-label={t('environmentSettingsShell.tabs')}
          className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-lg border border-border bg-background/95 p-1 shadow-sm backdrop-blur"
        >
          {ENVIRONMENT_SETTINGS_SECTIONS.map((name, index) => (
            <button
              key={name}
              id={'environment-settings-tab-' + name}
              type="button"
              role="tab"
              aria-selected={section === name}
              aria-controls={'environment-settings-panel-' + name}
              tabIndex={section === name ? 0 : -1}
              onKeyDown={(event) => keyTab(event, index)}
              onClick={() => changeSection(name)}
              className={
                'shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ' +
                (section === name
                  ? 'bg-white/[0.09] text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground')
              }
            >
              {t('environmentSettingsShell.sections.' + name)}
            </button>
          ))}
        </div>
        {reason && (
          <div role="status" className="space-y-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <p>{t('environmentSettingsShell.' + reason)}</p>
            {running && (
              <Button size="sm" variant="outline" onClick={onOpenScreen}>
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
        {serverCapable && imageCapable && (
          <div
            id={'environment-settings-panel-' + section}
            role="tabpanel"
            aria-labelledby={'environment-settings-tab-' + section}
            inert={!ready}
            className={!ready ? 'opacity-60' : undefined}
          >
            {section !== 'skills' && (
              <h3 className="mb-2 text-sm font-semibold">{t('environmentSettingsShell.sections.' + section)}</h3>
            )}
            <Panel
              key={environment.id + ':' + section + ':' + importsRevision}
              environment={environment}
              fleet={fleet}
              onDirtyChange={onDirtyChange}
            />
          </div>
        )}
      </div>
      {importing && (
        <MacImportDialog
          subject={{ target: { environmentId: environment.id }, name: environment.name, running }}
          lists={importLists}
          groups={section === 'skills' ? ['skills'] : ['mcp']}
          onClose={() => {
            setImporting(false)
            setImportsRevision((value) => value + 1)
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
              {t('environmentSettingsShell.leaveDescription', { name: environment.name })}
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
                draft.current?.discard()
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
    </section>
  )
}
