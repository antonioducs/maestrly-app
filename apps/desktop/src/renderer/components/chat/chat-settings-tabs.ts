export type ChatSettingsTab = 'accounts' | 'models' | 'maestro' | 'tools' | 'skills' | 'prompts' | 'components'

export const CHAT_SETTINGS_TABS: ReadonlyArray<{ id: ChatSettingsTab; labelKey: string }> = [
  { id: 'accounts', labelKey: 'settings.tabAccounts' },
  { id: 'models', labelKey: 'settings.tabModelsAgents' },
  { id: 'maestro', labelKey: 'settings.tabMaestro' },
  { id: 'tools', labelKey: 'settings.tabTools' },
  { id: 'skills', labelKey: 'settings.tabSkills' },
  { id: 'prompts', labelKey: 'settings.tabPrompts' },
  { id: 'components', labelKey: 'settings.tabComponents' },
]

/** Chat settings options for a host that shows a subset (a bot's own Maestrly). The desktop uses the defaults. */
export interface ChatSettingsOptions {
  /** Tabs to show, kept in the desktop's order; all by default. */
  tabs?: readonly ChatSettingsTab[]
  /** Switches to `tab` whenever `seq` changes, e.g. when the owner's Mac asks the bot to show its accounts. */
  requestedTab?: { tab: ChatSettingsTab; seq: number } | null
  /** A bot always runs its conversation with Maestrly tools, so their global default is shown locked on. */
  appToolsLocked?: boolean
  /** The bot's own window displays the owner's saved preparation values without edit controls. */
  backgroundCompactionLocked?: boolean
}
