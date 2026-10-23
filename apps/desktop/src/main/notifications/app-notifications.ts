import type { BrowserWindow } from 'electron'
import { chatWindowKey } from '../../shared/chat-window'
import type { NotificationTarget } from '../../shared/notifications'
import type { SoundEvent } from '../../shared/sound'
import type { ChatWindowManager } from '../chat-window-manager'
import { ConversationNotices } from './conversation-notices'
import { HostConversationAlerts } from './host-conversations'
import { Presence } from './presence'
import { SystemNotices } from './system-notices'

export interface AppNotificationsDeps {
  mainWindow(): BrowserWindow | null
  chatWindows(): Pick<ChatWindowManager, 'isFocused' | 'reveal'> | null
  visibleConversation(): string | null
  conversationLabel(conversationId: string): { name: string; projectName?: string } | null
  focusMainWindow(): void
  sendToMainWindow(channel: 'notification:open', target: NotificationTarget): void
  playHostAlert(conversationKey: string, event: SoundEvent): void
}

/** This computer's system notifications: of its conversations, of remote hosts' conversations, and of bots. */
export class AppNotifications {
  readonly notices = new SystemNotices()
  readonly presence: Presence
  readonly conversations: ConversationNotices
  /** Remote hosts' conversations, which also sound here: their hosts play nothing on this computer. */
  readonly hosts: HostConversationAlerts

  constructor(private readonly deps: AppNotificationsDeps) {
    this.presence = new Presence({
      mainWindow: deps.mainWindow,
      visibleConversation: deps.visibleConversation,
      chatWindowFocused: (key) => deps.chatWindows()?.isFocused(key) ?? false,
    })
    this.conversations = new ConversationNotices({
      notices: this.notices,
      sees: (id) => this.presence.seesConversation(id),
      label: deps.conversationLabel,
      open: (id) => this.open({ kind: 'conversation', conversationId: id }),
    })
    this.hosts = new HostConversationAlerts({ notices: this.conversations, play: deps.playHostAlert })
  }

  /**
   * Shows what a clicked notification is about. A conversation or bot in a window of its own comes forward there; a
   * bot's run or thread still opens in it, since that window shows the main window's view of the bot.
   */
  open(target: NotificationTarget): void {
    const key =
      target.kind === 'conversation'
        ? chatWindowKey({ kind: 'conversation', id: target.conversationId })
        : chatWindowKey({ kind: 'bot', serverId: target.serverId, id: target.botId })
    const revealed = this.deps.chatWindows()?.reveal(key) ?? false
    if (target.kind === 'conversation' && revealed) return
    if (!revealed) this.deps.focusMainWindow()
    this.deps.sendToMainWindow('notification:open', target)
  }
}
