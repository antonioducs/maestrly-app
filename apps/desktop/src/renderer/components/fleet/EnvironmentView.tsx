import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, Monitor, Play, RotateCcw, Settings, Square } from 'lucide-react'
import { FLEET_ENVIRONMENT_SETTINGS_FEATURE, type FleetBot, type FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorText } from '@/lib/fleet/errors'
import { createKeyWatcher, environmentBots, type ProvisioningSubject } from '@/lib/fleet/environments'
import {
  environmentJoinAvailability,
  environmentJoinHint,
  environmentProvisioningKey,
  environmentScreenAvailability,
  provisioningAvailability,
  useFleetProvisioning,
} from '@/lib/fleet/provisioning'
import { useEnvironmentWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { cn } from '@/lib/utils'
import { ApiKeyAccountForm } from './ApiKeyAccountForm'
import { BotAccountsSection } from './BotAccountsSection'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'
import { BotSkillsMcpSection } from './BotSkillsMcpSection'
import { EnvironmentCompaction } from './EnvironmentCompaction'
import { EnvironmentConfirm, type EnvironmentConfirmKind } from './EnvironmentConfirm'
import { EnvironmentRack } from './EnvironmentRack'
import { EnvironmentResources } from './EnvironmentResources'
import { EnvironmentRuntimes } from './EnvironmentRuntimes'
import { EnvironmentScreen } from './EnvironmentScreen'
import { EnvironmentSettingsSheet } from './EnvironmentSettings'
import { EnvironmentSharedSummary } from './EnvironmentSharedSummary'
import { EnvironmentUpdateNotice } from './EnvironmentUpdateNotice'
import { SplitWorkspace } from './SplitWorkspace'
import type { EnvironmentSettingsSection } from './environment-settings/sections'

type EnvironmentViewProps = {
  environment: FleetEnvironment
  view: Extract<FleetView, { kind: 'environment' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
  onCreateBot: (environmentId: string) => void
}

export function EnvironmentView(props: EnvironmentViewProps) {
  return (
    <EnvironmentViewContent key={JSON.stringify([props.fleet.state.connection.url, props.environment.id])} {...props} />
  )
}

/** The dot before an environment's state: running, on its way, or at rest. */
function lifecycleDot(lifecycle: FleetEnvironment['lifecycle']): string {
  return lifecycle === 'running'
    ? 'bg-status-ready'
    : lifecycle === 'failed'
      ? 'bg-destructive'
      : lifecycle === 'stopped' || lifecycle === 'archived'
        ? 'bg-muted-foreground'
        : 'bg-amber-400 animate-pulse motion-reduce:animate-none'
}

/**
 * An environment, laid out as a bot is: its overview (its bots, what they share, its resources) beside its screen,
 * each under its own header, and its settings in a panel over both. The `screen` destination opens the screen,
 * `settings` opens the panel on a section, and `overview` only closes that panel.
 */
function EnvironmentViewContent({ environment, view, fleet, onView, onOpenBot, onCreateBot }: EnvironmentViewProps) {
  const { t } = useTranslation('fleet')
  const layout = useEnvironmentWorkspaceLayout(
    fleet.state.connection.url,
    environment.id,
    view.tab === 'screen' ? 'split' : 'chat'
  )
  const { openComputer, closeComputer, showPane } = layout
  useEffect(() => {
    if (view.tab === 'screen') openComputer()
  }, [view.tab, openComputer])
  const settingsOpen = view.tab === 'settings'
  const environmentView = (
    tab: 'overview' | 'screen' | 'settings',
    section?: EnvironmentSettingsSection
  ): FleetView => ({
    kind: 'environment',
    environmentId: environment.id,
    tab,
    ...(section ? { section } : {}),
  })
  const showScreen = () => {
    openComputer()
    onView(environmentView('screen'))
  }
  const hideScreen = () => {
    closeComputer()
    onView(environmentView('overview'))
  }
  // What the overview sums up is read again once the settings panel closes, with what changed there.
  const [summaryRevision, setSummaryRevision] = useState(0)
  const closeSettings = () => {
    setSummaryRevision((value) => value + 1)
    onView(environmentView('overview'))
  }
  const openSettings = (section?: EnvironmentSettingsSection) => onView(environmentView('settings', section))
  const onShowPane = (pane: BotPane) => (pane === 'computer' ? showScreen() : showPane('chat'))
  const activePane: BotPane = layout.showChat ? 'chat' : 'computer'
  const [confirm, setConfirm] = useState<EnvironmentConfirmKind | null>(null)
  const archived = () => onView({ kind: 'server' })
  return (
    <div data-environment-view className="flex min-h-0 min-w-0 flex-1 flex-col bg-chat-canvas">
      {fleet.actionError?.environmentId === environment.id && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {fleetErrorText(fleet.actionError.message, t)}
        </p>
      )}
      <SplitWorkspace
        layout={layout}
        primaryId="fleet-environment-overview"
        labels={{
          primary: t('environment.overviewRegion', { name: environment.name }),
          secondary: t('environment.screenRegion', { name: environment.name }),
          resize: t('environment.resize'),
        }}
        attributes={{ 'data-environment-workspace': environment.id }}
        primary={
          <>
            <EnvironmentHeader
              environment={environment}
              fleet={fleet}
              narrow={layout.narrow}
              activePane={activePane}
              screenOpen={layout.mode !== 'chat'}
              onShowPane={onShowPane}
              onOpenScreen={showScreen}
              onOpenSettings={() => openSettings()}
              onOpenServer={() => onView({ kind: 'server' })}
              onConfirm={setConfirm}
            />
            <EnvironmentOverview
              environment={environment}
              fleet={fleet}
              summaryRevision={summaryRevision}
              onOpenBot={onOpenBot}
              onCreateBot={() => onCreateBot(environment.id)}
              onOpenScreen={showScreen}
              onOpenSettings={openSettings}
              onOpenInbox={() => onView({ kind: 'inbox' })}
              onConfirm={setConfirm}
            />
          </>
        }
        secondary={
          layout.computerOpened ? (
            <EnvironmentScreen
              environment={environment}
              fleet={fleet}
              streaming={layout.mode !== 'chat'}
              // The panel covers the screen: it keeps streaming, but takes no input meanwhile.
              visible={layout.showComputer && !settingsOpen}
              maximized={layout.mode === 'computer'}
              narrow={layout.narrow}
              activePane={activePane}
              onShowPane={onShowPane}
              onMaximize={layout.maximize}
              onRestore={layout.restore}
              onClose={hideScreen}
            />
          ) : null
        }
      />
      {settingsOpen && (
        <EnvironmentSettingsSheet
          environment={environment}
          fleet={fleet}
          section={view.section}
          onClose={closeSettings}
          onOpenScreen={() => {
            setSummaryRevision((value) => value + 1)
            showScreen()
          }}
          onOpenBot={onOpenBot}
          onArchived={archived}
        />
      )}
      {confirm && (
        <EnvironmentConfirm
          kind={confirm}
          environment={environment}
          fleet={fleet}
          onCancel={() => setConfirm(null)}
          onDone={(kind) => {
            setConfirm(null)
            if (kind === 'archive') archived()
          }}
        />
      )}
    </div>
  )
}

/**
 * The overview's header: the environment and how it is doing, on which server, and what can be done with it — start,
 * restart or stop it with every bot in it, change its settings, and open its screen while that is closed.
 */
function EnvironmentHeader({
  environment,
  fleet,
  narrow,
  activePane,
  screenOpen,
  onShowPane,
  onOpenScreen,
  onOpenSettings,
  onOpenServer,
  onConfirm,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  narrow: boolean
  activePane: BotPane
  screenOpen: boolean
  onShowPane: (pane: BotPane) => void
  onOpenScreen: () => void
  onOpenSettings: () => void
  onOpenServer: () => void
  onConfirm: (kind: EnvironmentConfirmKind) => void
}) {
  const { t } = useTranslation('fleet')
  const host = fleet.state.snapshot.host?.hostname ?? t('view.server')
  const running = environment.lifecycle === 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const quiet = 'h-[30px] text-muted-foreground hover:text-foreground'
  return (
    <header className="@container flex h-[52px] shrink-0 items-center gap-2.5 pl-4 pr-3">
      <span
        aria-hidden="true"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-border-strong bg-white/[0.04] text-foreground/75"
      >
        <Boxes className="size-4" />
      </span>
      <div className="min-w-0 overflow-hidden">
        <h1 className="truncate text-sm font-semibold leading-tight">{environment.name}</h1>
        <p className="mt-px flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-foreground/75">
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', lifecycleDot(environment.lifecycle))} />
            {t(`environment.lifecycle.${environment.lifecycle}`)}
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenServer}
            title={host}
            className="min-w-0 max-w-36 truncate rounded-sm hover:text-foreground hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {host}
          </button>
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {narrow && (
          <BotPaneSwitch
            active={activePane}
            onChange={onShowPane}
            labels={{
              group: t('workspace.panes'),
              chat: t('environment.overview'),
              computer: t('environment.screen'),
            }}
          />
        )}
        {stopped ? (
          <Button size="sm" className="h-[30px]" onClick={() => void fleet.environmentAction(environment.id, 'start')}>
            <Play className="size-3.5" />
            {t('environment.start')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className={quiet}
              disabled={!running}
              aria-label={t('environment.restart')}
              title={t('environment.restart')}
              onClick={() => onConfirm('restart')}
            >
              <RotateCcw className="size-3.5" />
              <span className="hidden @lg:inline">{t('environment.restartButton')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={quiet}
              disabled={!running}
              aria-label={t('environment.stop')}
              title={t('environment.stop')}
              onClick={() => onConfirm('stop')}
            >
              <Square className="size-3.5" />
              <span className="hidden @lg:inline">{t('environment.stopButton')}</span>
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-[30px] text-muted-foreground hover:text-foreground"
          aria-label={t('environmentSettingsShell.title')}
          title={t('environmentSettingsShell.title')}
          onClick={onOpenSettings}
        >
          <Settings />
        </Button>
        {!screenOpen && !narrow && (
          <Button
            size="sm"
            variant="outline"
            className="h-[30px]"
            aria-label={t('environment.openScreen')}
            title={t('environment.openScreen')}
            onClick={onOpenScreen}
          >
            <Monitor className="size-3.5" />
            {t('environment.screen')}
          </Button>
        )}
      </div>
    </header>
  )
}

function EnvironmentOverview({
  environment,
  fleet,
  summaryRevision,
  onOpenBot,
  onCreateBot,
  onOpenScreen,
  onOpenSettings,
  onOpenInbox,
  onConfirm,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  summaryRevision: number
  onOpenBot: (id: string) => void
  onCreateBot: () => void
  onOpenScreen: () => void
  onOpenSettings: (section?: EnvironmentSettingsSection) => void
  onOpenInbox: () => void
  onConfirm: (kind: EnvironmentConfirmKind) => void
}) {
  const { t } = useTranslation('fleet')
  const bots = environmentBots(environment, fleet.state.snapshot.bots)
  const modernSettings =
    fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE) &&
    environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const join = environmentJoinAvailability(fleet, environment)
  const joinHint = join === 'ready' ? null : environmentJoinHint(join)
  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[880px] flex-col gap-[34px] px-7 pb-12 pt-2.5 @max-lg:px-[18px]">
        <EnvironmentUpdateNotice
          environment={environment}
          fleet={fleet}
          onConfirm={onConfirm}
          onOpenInbox={onOpenInbox}
        />
        <EnvironmentRack
          bots={bots}
          joinHint={joinHint ? t(joinHint.key, joinHint.values) : null}
          onOpenBot={onOpenBot}
          onCreateBot={onCreateBot}
        />
        {modernSettings ? (
          <EnvironmentSharedSummary
            key={summaryRevision}
            environment={environment}
            fleet={fleet}
            bots={bots}
            onOpenSettings={onOpenSettings}
            onOpenScreen={onOpenScreen}
          />
        ) : (
          <LegacySharedSetup environment={environment} fleet={fleet} bots={bots} onOpenScreen={onOpenScreen} />
        )}
        <EnvironmentResources environment={environment} fleet={fleet} />
      </div>
    </div>
  )
}

/**
 * What the bots share, as a gateway or an image without app-managed environment settings offers it: the environment's
 * accounts, skills, MCP servers and default compaction model, managed in place, and the runtimes it reports.
 */
function LegacySharedSetup({
  environment,
  fleet,
  bots,
  onOpenScreen,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  bots: FleetBot[]
  onOpenScreen: () => void
}) {
  const { t } = useTranslation('fleet')
  const running = environment.lifecycle === 'running'
  const availability = provisioningAvailability(fleet, environment)
  const lists = useFleetProvisioning({ environmentId: environment.id }, availability === 'ready' && running)
  // The shared lists reload when the environment's Maestrly or its bots' accounts change, never on resource samples.
  const listsKey = environmentProvisioningKey(environment, fleet.state.snapshot.bots)
  const [listsChanged] = useState(() => createKeyWatcher(listsKey))
  useEffect(() => {
    if (listsChanged(listsKey)) lists.refresh()
  }, [listsKey, listsChanged, lists.refresh])
  const subject: ProvisioningSubject = {
    target: { environmentId: environment.id },
    name: environment.name,
    running,
  }
  // An image from before environments has no environment screen: its settings open in its bot's browser area.
  const oldImage = environmentScreenAvailability(environment) === 'restart-environment'
  const [screenBusy, setScreenBusy] = useState(false)
  const [screenError, setScreenError] = useState('')
  async function logInOnScreen() {
    setScreenBusy(true)
    setScreenError('')
    try {
      await window.api.fleetEnvironmentUiOpen(environment.id, 'accounts')
      onOpenScreen()
    } catch {
      setScreenError(t('environment.screenLoginFailed'))
    } finally {
      setScreenBusy(false)
    }
  }
  return (
    <section aria-labelledby="fleet-environment-shared" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="fleet-environment-shared" className="text-[15px] font-semibold">
            {t('environment.sharedTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('environment.sharedConfig')}</p>
        </div>
        <Button size="sm" variant="ghost" disabled={availability !== 'ready' || !running} onClick={lists.refresh}>
          {t('environment.refresh')}
        </Button>
      </div>
      <BotAccountsSection
        key={environment.id}
        subject={subject}
        lists={lists}
        availability={availability}
        onChanged={fleet.refresh}
      >
        <ApiKeyAccountForm
          target={subject.target}
          onAdded={async () => {
            lists.refresh()
            await fleet.refresh()
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={screenBusy || !running || oldImage}
          onClick={() => void logInOnScreen()}
        >
          {t('environment.loginOnScreen')}
        </Button>
        {oldImage && <p className="text-xs text-muted-foreground">{t('environment.loginNeedsRestart')}</p>}
        {screenError && (
          <p role="alert" className="text-xs text-destructive">
            {screenError}
          </p>
        )}
      </BotAccountsSection>
      <BotSkillsMcpSection key={environment.id} subject={subject} lists={lists} availability={availability} />
      <EnvironmentCompaction
        key={`compaction-${environment.id}`}
        environment={environment}
        bots={bots}
        fleet={fleet}
        optionsKey={JSON.stringify([listsKey, lists.accounts ?? null])}
      />
      <EnvironmentRuntimes environment={environment} fleet={fleet} />
    </section>
  )
}
