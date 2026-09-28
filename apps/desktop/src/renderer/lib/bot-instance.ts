import type { SettingsSection } from '../components/settings/nav'
import { CHAT_SETTINGS_TABS, type ChatSettingsTab } from '../components/chat/chat-settings-tabs'

/**
 * What a bot's own Maestrly offers on its screen. The bot is driven from the owner's Mac, so only the settings it
 * needs remain: model accounts, models and agents, tools and MCP servers, skills, prompts and runtime components.
 */
export const BOT_INSTANCE_SETTINGS_SECTIONS: readonly SettingsSection[] = ['chat']

/** Maestro is left out: a bot always runs in agent mode. */
export const BOT_INSTANCE_CHAT_TABS: readonly ChatSettingsTab[] = CHAT_SETTINGS_TABS.map((tab) => tab.id).filter(
  (id) => id !== 'maestro'
)

/** The chat settings tab for a place the owner's Mac asks the bot to show. */
export function chatSettingsTabFor(target: 'accounts' | 'skills' | 'mcp'): ChatSettingsTab {
  return target === 'mcp' ? 'tools' : target
}
