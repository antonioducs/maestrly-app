import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Notification: { isSupported: () => false },
  nativeImage: { createFromBitmap: () => ({}) },
}))

import { AppNotifications } from '../../src/main/notifications/app-notifications'
import type { FleetBotAttentionChange } from '../../src/shared/notifications'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId

function setupNotifications(revealed = false) {
  const sent: unknown[] = []
  const changes: FleetBotAttentionChange[] = []
  const focusMainWindow = vi.fn()
  const reveal = vi.fn((_key: string) => revealed)
  const window = { focused: true }
  const notifications = new AppNotifications({
    mainWindow: () =>
      ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => window.focused,
        isMinimized: () => false,
      }) as never,
    chatWindows: () => ({ isFocused: () => false, reveal }),
    visibleConversation: () => null,
    conversationLabel: () => null,
    focusMainWindow,
    sendToMainWindow: (channel, target) => void sent.push([channel, target]),
    playHostAlert: vi.fn(),
    botName: () => null,
    serverName: () => null,
    botAttention: { load: () => null, save: () => {}, emit: (change) => void changes.push(change) },
  })
  return { notifications, sent, changes, focusMainWindow, reveal, window }
}

describe('AppNotifications', () => {
  it('opens a conversation in its own window when it has one, else in the main window', () => {
    const own = setupNotifications(true)
    own.notifications.open({ kind: 'conversation', conversationId: 'chat-1' })
    expect(own.reveal).toHaveBeenCalledWith('conversation:chat-1')
    expect(own.focusMainWindow).not.toHaveBeenCalled()
    expect(own.sent).toEqual([])
    const main = setupNotifications(false)
    main.notifications.open({ kind: 'conversation', conversationId: 'chat-1' })
    expect(main.focusMainWindow).toHaveBeenCalledOnce()
    expect(main.sent).toEqual([['notification:open', { kind: 'conversation', conversationId: 'chat-1' }]])
  })

  it('opens a bot run in the bot window it has, through the main window that shows it', () => {
    const s = setupNotifications(true)
    s.notifications.open({ kind: 'bot', serverId: S1, botId: 'alex', runId: 'run-1' })
    expect(s.reveal).toHaveBeenCalledWith(`bot:${S1}/alex`)
    expect(s.focusMainWindow).not.toHaveBeenCalled()
    expect(s.sent).toEqual([['notification:open', { kind: 'bot', serverId: S1, botId: 'alex', runId: 'run-1' }]])
  })

  it('clears a bot mark once the owner sees the bot in the focused main window or in its own window', () => {
    const s = setupNotifications()
    const marked = () => s.notifications.botAttention.list().map(({ botId }) => botId)
    s.window.focused = false
    s.notifications.botAttention.mark(S1, 'alex')
    s.notifications.botAttention.mark(S1, 'sam')
    s.notifications.setVisibleBot({ serverId: S1, botId: 'alex' })
    expect(marked()).toEqual(['alex', 'sam'])
    s.window.focused = true
    s.notifications.mainWindowFocused()
    expect(marked()).toEqual(['sam'])
    s.notifications.chatWindowFocused('conversation:chat-1')
    s.notifications.chatWindowFocused(`bot:${S1}/sam`)
    expect(marked()).toEqual([])
    s.notifications.botAttention.mark(S1, 'alex')
    s.notifications.setVisibleBot({ serverId: S1, botId: 'alex' })
    expect(marked()).toEqual([])
    expect(s.changes.filter(({ attention }) => !attention)).toHaveLength(3)
  })
})
