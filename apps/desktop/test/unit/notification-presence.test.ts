import { describe, expect, it } from 'vitest'
import { Presence } from '../../src/main/notifications/presence'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId

function setup() {
  const window = { destroyed: false, visible: true, focused: true, minimized: false }
  const state = { hasWindow: true, visible: null as string | null, focusedKeys: new Set<string>() }
  const presence = new Presence({
    mainWindow: () =>
      state.hasWindow
        ? ({
            isDestroyed: () => window.destroyed,
            isVisible: () => window.visible,
            isFocused: () => window.focused,
            isMinimized: () => window.minimized,
          } as never)
        : null,
    visibleConversation: () => state.visible,
    chatWindowFocused: (key) => state.focusedKeys.has(key),
  })
  return { presence, window, state }
}

describe('Presence', () => {
  it('sees the conversation the focused main window shows, or its own focused window', () => {
    const { presence, window, state } = setup()
    state.visible = 'chat-1'
    expect(presence.seesConversation('chat-1')).toBe(true)
    expect(presence.seesConversation('chat-2')).toBe(false)
    for (const change of [{ focused: false }, { visible: false }, { minimized: true }, { destroyed: true }]) {
      Object.assign(window, { destroyed: false, focused: true, visible: true, minimized: false }, change)
      expect(presence.seesConversation('chat-1')).toBe(false)
    }
    state.focusedKeys.add('conversation:chat-2')
    expect(presence.seesConversation('chat-2')).toBe(true)
    state.hasWindow = false
    expect(presence.seesConversation('chat-1')).toBe(false)
  })

  it('sees the bot the main window shows, by server, or its own focused window', () => {
    const { presence, state } = setup()
    presence.setVisibleBot({ serverId: SERVER, botId: 'alex' })
    expect(presence.visibleBot()).toEqual({ serverId: SERVER, botId: 'alex' })
    expect(presence.seesBot(SERVER, 'alex')).toBe(true)
    expect(presence.seesBot(OTHER, 'alex')).toBe(false)
    presence.setVisibleBot(null)
    expect(presence.seesBot(SERVER, 'alex')).toBe(false)
    state.focusedKeys.add(`bot:${SERVER}/alex`)
    expect(presence.seesBot(SERVER, 'alex')).toBe(true)
  })
})
