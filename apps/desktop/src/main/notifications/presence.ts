import type { BrowserWindow } from 'electron'
import { chatWindowKey } from '../../shared/chat-window'
import type { FleetServerId } from '../../shared/fleet-servers'

export interface PresenceDeps {
  mainWindow(): BrowserWindow | null
  /** The conversation the main window shows (a host key for a remote host's), null for any other surface. */
  visibleConversation(): string | null
  /** Whether the chat window of this key (see chatWindowKey) is open and focused. */
  chatWindowFocused(key: string): boolean
}

type BotRef = { serverId: FleetServerId; botId: string }

/** What the owner looks at now: a notification or mark about it would only repeat what is on screen. */
export class Presence {
  private bot: BotRef | null = null

  constructor(private readonly deps: PresenceDeps) {}

  /** The bot the main window shows, as the window reports it; null when it shows anything else. */
  setVisibleBot(target: BotRef | null): void {
    this.bot = target
  }

  visibleBot(): BotRef | null {
    return this.bot
  }

  mainWindowAttended(): boolean {
    const window = this.deps.mainWindow()
    return !!window && !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized()
  }

  seesConversation(conversationId: string): boolean {
    return (
      (this.mainWindowAttended() && this.deps.visibleConversation() === conversationId) ||
      this.deps.chatWindowFocused(chatWindowKey({ kind: 'conversation', id: conversationId }))
    )
  }

  seesBot(serverId: FleetServerId, botId: string): boolean {
    return (
      (this.mainWindowAttended() && this.bot?.serverId === serverId && this.bot.botId === botId) ||
      this.deps.chatWindowFocused(chatWindowKey({ kind: 'bot', serverId, id: botId }))
    )
  }
}
