import type { BrowserWindow } from 'electron'
import { chatWindowKey, parseChatWindowKey } from '../../shared/chat-window'
import type { FleetServerId } from '../../shared/fleet-servers'
import type { NotificationTarget } from '../../shared/notifications'
import type { SoundEvent } from '../../shared/sound'
import type { ChatWindowManager } from '../chat-window-manager'
import { AppBadge, type AppBadgeDeps } from './app-badge'
import { FleetBotAttention, type FleetBotAttentionDeps } from './bot-attention'
import { FleetBotNotices } from './bot-notices'
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
  botName(serverId: FleetServerId, botId: string): string | null
  /** The server's name when the owner pairs several, to tell their bots apart; null otherwise. */
  serverName(serverId: FleetServerId): string | null
  botAttention: Omit<FleetBotAttentionDeps, 'max'>
  badge: Omit<AppBadgeDeps, 'mainWindow'>
}

/** This computer's system notifications: of its conversations, of remote hosts' conversations, and of bots. */
export class AppNotifications {
  readonly notices = new SystemNotices()
  readonly presence: Presence
  readonly conversations: ConversationNotices
  /** Remote hosts' conversations, which also sound here: their hosts play nothing on this computer. */
  readonly hosts: HostConversationAlerts
  readonly botAttention: FleetBotAttention
  readonly bots: FleetBotNotices
  readonly badge: AppBadge

  constructor(private readonly deps: AppNotificationsDeps) {
    this.badge = new AppBadge({ ...deps.badge, mainWindow: deps.mainWindow })
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
    this.botAttention = new FleetBotAttention(deps.botAttention)
    this.bots = new FleetBotNotices({
      notices: this.notices,
      attention: this.botAttention,
      sees: (serverId, botId) => this.presence.seesBot(serverId, botId),
      botName: deps.botName,
      serverName: deps.serverName,
      open: (target) => this.open(target),
    })
  }

  /** The bot the main window shows now, as it reports it; null when it shows anything else. */
  setVisibleBot(target: { serverId: FleetServerId; botId: string } | null): void {
    this.presence.setVisibleBot(target)
    if (target && this.presence.mainWindowAttended()) this.bots.seen(target.serverId, target.botId)
  }

  /** The owner came back to the main window: the bot it shows is seen. */
  mainWindowFocused(): void {
    const bot = this.presence.visibleBot()
    if (bot) this.bots.seen(bot.serverId, bot.botId)
  }

  /** The owner came to a chat window: a bot's is seen. A conversation's window clears its own mark. */
  chatWindowFocused(key: string): void {
    const target = parseChatWindowKey(key)
    if (target?.kind === 'bot') this.bots.seen(target.serverId, target.id)
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
