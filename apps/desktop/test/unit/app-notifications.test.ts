import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Notification: { isSupported: () => false },
  nativeImage: { createFromBitmap: () => ({}) },
}))

import { AppNotifications } from '../../src/main/notifications/app-notifications'

function setupNotifications(revealed = false) {
  const sent: unknown[] = []
  const focusMainWindow = vi.fn()
  const reveal = vi.fn((_key: string) => revealed)
  const notifications = new AppNotifications({
    mainWindow: () => null,
    chatWindows: () => ({ isFocused: () => false, reveal }),
    visibleConversation: () => null,
    conversationLabel: () => null,
    focusMainWindow,
    sendToMainWindow: (channel, target) => void sent.push([channel, target]),
  })
  return { notifications, sent, focusMainWindow, reveal }
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
})
