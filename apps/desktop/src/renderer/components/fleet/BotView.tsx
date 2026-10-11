import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FLEET_ENVIRONMENT_SETTINGS_FEATURE, type FleetBot } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { environmentOf } from '@/lib/fleet/selectors'
import { hasEnvironments } from '@/lib/fleet/environments'
import { botComputerMode } from '@/lib/fleet/provisioning'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useBotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'
import { ChatWindowHost } from '@/components/chat/ChatWindowHost'
import type { EnvironmentSettingsSection } from './environment-settings/sections'
import { BotChatHeader } from './BotChatHeader'
import { BotConversation } from './BotConversation'
import type { BotPane } from './BotPaneSwitch'
import { BotScreen } from './BotScreen'
import type { SettingsLeaveGuard } from './BotSettings'
import { BotSettingsSheet } from './BotSettingsSheet'
import { BotWorkspace } from './BotWorkspace'

type BotViewProps = {
  bot: FleetBot
  view: Extract<FleetView, { kind: 'bot' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
  onDetachedChange?: (detached: boolean) => void
  /**
   * Whether the bot is the one on screen. A bot whose conversation is in a window of its own stays mounted while
   * another bot is shown; its computer then stops streaming.
   */
  active?: boolean
}

export function BotView(props: BotViewProps) {
  return <BotViewContent key={JSON.stringify([props.fleet.state.connection.url, props.bot.id])} {...props} />
}

/**
 * A bot at work: its conversation beside its computer, each under its own header. The `screen` destination opens the
 * computer, `settings` opens the settings panel over both, and `conversation` only closes that panel. The
 * conversation can move to a window of its own; the computer stays here.
 */
function BotViewContent({ bot, view, fleet, onView, onOpenBot, onDetachedChange, active = true }: BotViewProps) {
  const { t } = useTranslation('fleet')
  const layout = useBotWorkspaceLayout(fleet.state.connection.url, bot.id, view.tab === 'screen' ? 'split' : 'chat')
  const settingsOpen = active && view.tab === 'settings'
  const [giveBackRequest, setGiveBackRequest] = useState(0)
  const [detached, setDetached] = useState(false)
  const handleDetachedChange = useCallback(
    (value: boolean) => {
      setDetached(value)
      onDetachedChange?.(value)
    },
    [onDetachedChange]
  )
  const { openComputer, closeComputer, showPane } = layout
  useEffect(() => {
    // Existing destinations (including help requests) still reveal the computer.
    if (active && view.tab === 'screen') openComputer()
  }, [active, view.tab, openComputer])
  const environment = hasEnvironments(fleet.state.connection)
    ? environmentOf(fleet.state.snapshot.environments, bot)
    : undefined
  // Settings with unsaved changes ask before this view leaves them.
  const leaveGuard = useRef<SettingsLeaveGuard | null>(null)
  const go = (next: FleetView) => {
    // From the conversation's own window, a destination in the main window brings that window forward.
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    const guard = settingsOpen ? leaveGuard.current : null
    if (guard) guard(() => onView(next))
    else onView(next)
  }
  const botView = (tab: 'conversation' | 'screen' | 'settings'): FleetView => ({ kind: 'bot', botId: bot.id, tab })
  const showComputer = () => {
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    openComputer()
    onView(botView('screen'))
  }
  const hideComputer = () => {
    closeComputer()
    onView(botView('conversation'))
  }
  const openSettings = () => {
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    onView(botView('settings'))
  }
  const environmentSettings =
    !!environment &&
    fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE) &&
    environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const openEnvironment = (next: 'overview' | 'screen' | 'settings', section?: EnvironmentSettingsSection) =>
    environment && go({ kind: 'environment', environmentId: environment.id, tab: next, section })
  const onShowPane = (pane: BotPane) => (pane === 'computer' ? showComputer() : showPane('chat'))
  const activePane: BotPane = layout.showChat ? 'chat' : 'computer'
  return (
    <div data-bot-view className="flex min-h-0 min-w-0 flex-1 flex-col bg-chat-canvas">
      {fleet.actionError &&
        (fleet.actionError.botId === bot.id ||
          (bot.environmentId !== null && fleet.actionError.environmentId === bot.environmentId)) && (
          <p role="alert" className="px-5 py-2 text-xs text-destructive">
            {fleetErrorText(fleet.actionError.message, t)}
          </p>
        )}
      <BotWorkspace
        botId={bot.id}
        name={bot.name}
        layout={layout}
        conversation={
          <>
            <BotChatHeader
              bot={bot}
              fleet={fleet}
              environment={environment}
              narrow={layout.narrow}
              activePane={activePane}
              computerOpen={layout.mode !== 'chat'}
              onShowPane={onShowPane}
              onOpenComputer={showComputer}
              onOpenSettings={openSettings}
              onOpenServer={() => go({ kind: 'server' })}
              onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
            />
            <ChatWindowHost
              target={{ kind: 'bot', id: bot.id }}
              title={bot.name}
              onDetachedChange={handleDetachedChange}
              onReattach={() => go(botView('conversation'))}
            >
              {(inWindow) => (
                <BotConversation
                  bot={bot}
                  fleet={fleet}
                  visible={inWindow || (active && layout.showChat)}
                  onOpenBot={(id) => {
                    onOpenBot(id)
                    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
                  }}
                  onOpenScreen={showComputer}
                  onOpenSettings={openSettings}
                  onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
                  onOpenEnvironmentSettings={
                    environmentSettings
                      ? (target) => openEnvironment('settings', target === 'mcp' ? 'tools' : 'skills')
                      : undefined
                  }
                  onGiveBack={() => {
                    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
                    setGiveBackRequest((value) => value + 1)
                  }}
                />
              )}
            </ChatWindowHost>
          </>
        }
        computer={
          layout.computerOpened ? (
            <BotScreen
              bot={bot}
              fleet={fleet}
              mode={botComputerMode(bot, environment)}
              layoutMode={layout.mode}
              narrow={layout.narrow}
              activePane={activePane}
              giveBackRequest={giveBackRequest}
              streaming={active && layout.mode !== 'chat'}
              // The panel covers the computer: it keeps streaming, but takes no input meanwhile.
              visible={active && layout.showComputer && !settingsOpen}
              onReveal={openComputer}
              onShowPane={onShowPane}
              onMaximize={layout.maximize}
              onRestore={layout.restore}
              onClose={hideComputer}
              onOpenSettings={openSettings}
              onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
              onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
            />
          ) : null
        }
      />
      {settingsOpen && (
        <BotSettingsSheet
          bot={bot}
          fleet={fleet}
          leaveGuard={leaveGuard}
          onClose={() => onView(botView('conversation'))}
          // The destination opens the computer once the panel has been left (or its changes dealt with).
          onOpenScreen={() => go(botView('screen'))}
          onOpenEnvironment={
            environment ? () => openEnvironment(environmentSettings ? 'settings' : 'overview') : undefined
          }
          onArchived={() => onView({ kind: 'server' })}
        />
      )}
    </div>
  )
}
