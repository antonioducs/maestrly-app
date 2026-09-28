import { useEffect, useState } from 'react'
import { SettingsView } from '@/components/SettingsView'
import type { ChatSettingsTab } from '@/components/chat/chat-settings-tabs'
import { BOT_INSTANCE_CHAT_TABS, BOT_INSTANCE_SETTINGS_SECTIONS, chatSettingsTabFor } from '@/lib/bot-instance'

/**
 * The main window of a bot's own Maestrly. The bot works in its browser window and is driven from the owner's Mac,
 * so this window only offers the settings the bot needs. Chats, workspaces and fleet views are never mounted: a
 * conversation started on the bot's screen would bypass the Mac's queue and the fleet.
 */
export function BotInstanceApp() {
  const [requestedTab, setRequestedTab] = useState<{ tab: ChatSettingsTab; seq: number } | null>(null)
  // The owner's Mac asks the bot to show where accounts, skills or MCP servers are managed.
  useEffect(
    () =>
      window.api.onFleetInstanceOpenAccounts((target) =>
        setRequestedTab((current) => ({ tab: chatSettingsTabFor(target), seq: (current?.seq ?? 0) + 1 }))
      ),
    []
  )
  return (
    <div className="flex h-full bg-background text-foreground">
      <main className="flex min-w-0 flex-1 flex-col">
        <SettingsView
          initialSection="chat"
          sections={BOT_INSTANCE_SETTINGS_SECTIONS}
          chat={{ tabs: BOT_INSTANCE_CHAT_TABS, requestedTab, appToolsLocked: true, backgroundCompactionLocked: true }}
          onClose={() => void window.api.fleetInstanceHideWindow()}
        />
      </main>
    </div>
  )
}
