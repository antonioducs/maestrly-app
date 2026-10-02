import { useTranslation } from 'react-i18next'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { environmentOf, takeoverBlocksResume } from '@/lib/fleet/selectors'
import { hasEnvironments, startBot } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useBotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'
import { BotConversation } from './BotConversation'
import { BotScreen, type ScreenCloseGuard } from './BotScreen'
import { BotSettings, type SettingsLeaveGuard } from './BotSettings'
import { BotWorkspace } from './BotWorkspace'

const tabs = ['conversation', 'screen', 'settings'] as const
type BotViewProps = {
  bot: FleetBot
  view: Extract<FleetView, { kind: 'bot' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
}

export function BotView(props: BotViewProps) {
  return <BotViewContent key={JSON.stringify([props.fleet.state.connection.url, props.bot.id])} {...props} />
}

function BotViewContent({ bot, view, fleet, onView, onOpenBot }: BotViewProps) {
  const { t } = useTranslation('fleet')
  const layout = useBotWorkspaceLayout(fleet.state.connection.url, bot.id, view.tab === 'screen' ? 'split' : 'chat')
  const tab = view.tab === 'settings' ? 'settings' : layout.mode === 'chat' ? 'conversation' : 'screen'
  const screenCloseGuard = useRef<ScreenCloseGuard | null>(null)
  const { openComputer } = layout
  useEffect(() => {
    // Existing destinations (including help requests) still reveal the computer.
    if (view.tab === 'screen') openComputer()
  }, [view.tab, openComputer])
  const environment = hasEnvironments(fleet.state.connection)
    ? environmentOf(fleet.state.snapshot.environments, bot)
    : undefined
  // Settings with unsaved changes ask before this view leaves them.
  const leaveGuard = useRef<SettingsLeaveGuard | null>(null)
  const go = (next: FleetView) => {
    const guard = tab === 'settings' ? leaveGuard.current : null
    if (guard) guard(() => onView(next))
    else onView(next)
  }
  const openEnvironment = (next: 'overview' | 'screen') =>
    environment && go({ kind: 'environment', environmentId: environment.id, tab: next })
  const setTab = (next: typeof tab) => {
    const navigate = () => {
      const apply = () => {
        if (next === 'screen') layout.openComputer()
        else if (next === 'conversation') layout.closeComputer()
        onView({ kind: 'bot', botId: bot.id, tab: next })
      }
      if (next === 'conversation' && layout.mode !== 'chat' && screenCloseGuard.current) {
        if (!screenCloseGuard.current(apply)) {
          // A pending return dialog lives in this pane, including after leaving settings or a narrow chat.
          layout.openComputer()
          onView({ kind: 'bot', botId: bot.id, tab: 'screen' })
        }
      } else apply()
    }
    if (tab === 'settings' && next !== tab && leaveGuard.current) leaveGuard.current(navigate)
    else navigate()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(tab)
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    event.preventDefault()
    setTab(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#fleet-tab-${next}`)?.focus()
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-b border-border px-5 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
            style={{ background: bot.tint }}
          >
            {bot.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 shrink-0">
            <h1 className="truncate text-sm font-semibold">{bot.name}</h1>
            {bot.role && <p className="max-w-32 truncate text-xs text-muted-foreground">{bot.role}</p>}
          </div>
          <button
            type="button"
            onClick={() => go({ kind: 'server' })}
            className="max-w-36 truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            title={fleet.state.snapshot.host?.hostname ?? t('view.server')}
          >
            {fleet.state.snapshot.host?.hostname ?? t('view.server')}
          </button>
          {environment && (
            <button
              type="button"
              onClick={() => openEnvironment('overview')}
              aria-label={t('environment.link', { name: environment.name })}
              title={t('environment.link', { name: environment.name })}
              className="max-w-36 truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {environment.name}
            </button>
          )}
          <div
            role="tablist"
            aria-label={t('view.botTabs')}
            className="flex min-w-0 items-center gap-1 rounded-lg border border-border p-0.5"
          >
            {tabs.map((name) => (
              <button
                key={name}
                id={`fleet-tab-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={name === 'settings' ? 'fleet-panel-settings' : 'fleet-panel-workspace'}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={onKeyDown}
                className={`rounded-md px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring ${tab === name ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t(`view.${name}`)}
              </button>
            ))}
          </div>
          <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
            {t(`status.${bot.status}`)}
          </span>
          {bot.status === 'offline' ? (
            <button
              type="button"
              onClick={() => void startBot(fleet, bot)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            >
              {t('action.start')}
            </button>
          ) : bot.status === 'paused' ? (
            <button
              type="button"
              disabled={takeoverBlocksResume(bot.takeover)}
              title={takeoverBlocksResume(bot.takeover) ? t('action.resumeBlocked') : undefined}
              onClick={() => void fleet.botAction(bot.id, 'resume')}
              className="rounded-md border border-border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('action.resume')}
            </button>
          ) : (
            !['starting', 'human'].includes(bot.status) && (
              <button
                type="button"
                onClick={() => void fleet.botAction(bot.id, 'pause')}
                className="rounded-md border border-border px-3 py-1.5 text-xs"
              >
                {t('action.pause')}
              </button>
            )
          )}
        </div>
      </header>
      {fleet.actionError &&
        (fleet.actionError.botId === bot.id ||
          (bot.environmentId !== null && fleet.actionError.environmentId === bot.environmentId)) && (
          <p role="alert" className="px-5 py-2 text-xs text-destructive">
            {fleetErrorText(fleet.actionError.message, t)}
          </p>
        )}
      <div
        id="fleet-panel-workspace"
        role="tabpanel"
        aria-labelledby={layout.mode === 'chat' ? 'fleet-tab-conversation' : 'fleet-tab-screen'}
        className={tab === 'settings' ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}
        inert={tab === 'settings'}
      >
        <BotWorkspace
          botId={bot.id}
          name={bot.name}
          layout={layout}
          visible={tab !== 'settings'}
          onOpenComputer={() => setTab('screen')}
          onCloseComputer={() => setTab('conversation')}
          conversation={
            <BotConversation
              bot={bot}
              fleet={fleet}
              visible={tab !== 'settings' && layout.showChat}
              onOpenBot={onOpenBot}
              onOpenScreen={() => setTab('screen')}
              onOpenSettings={() => setTab('settings')}
              onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
            />
          }
          computer={
            layout.computerOpened ? (
              <BotScreen
                bot={bot}
                fleet={fleet}
                streaming={layout.mode !== 'chat'}
                visible={tab !== 'settings' && layout.showComputer}
                closeGuard={screenCloseGuard}
                onOpenSettings={() => setTab('settings')}
                onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
                onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
              />
            ) : null
          }
        />
      </div>
      {tab === 'settings' && (
        <div
          id="fleet-panel-settings"
          role="tabpanel"
          aria-labelledby="fleet-tab-settings"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <BotSettings
            key={bot.id}
            bot={bot}
            fleet={fleet}
            onOpenScreen={() => setTab('screen')}
            onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
            onArchived={() => onView({ kind: 'server' })}
            leaveGuard={leaveGuard}
          />
        </div>
      )}
    </div>
  )
}
