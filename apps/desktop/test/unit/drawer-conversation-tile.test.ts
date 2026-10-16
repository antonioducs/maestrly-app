import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../../src/main/drawer/browser-stream', () => ({
  refreshBrowserStream: (convId: string) => h.calls.push(`refresh ${convId}`),
}))
vi.mock('../../src/main/drawer/stream-window', () => ({
  handOverStreamWindow: (convId: string) => h.calls.push(`handOver ${convId}`),
}))

import { conversationBrowserArea, setConversationTile } from '../../src/main/conversation-screen'
import { type ConversationTileWindows, placeConversationBrowser } from '../../src/main/drawer/conversation-tile'

function windows(placement: string): ConversationTileWindows {
  return {
    detach: (convId) => void h.calls.push(`detach ${convId}`),
    setPinned: (convId) => void h.calls.push(`pin ${convId}`),
    reattach: (convId) => void h.calls.push(`reattach ${convId}`),
    floatWindow: () => ({ setAlwaysOnTop: (flag) => void h.calls.push(`above ${flag}`) }),
    placement: () => placement,
  }
}

const tile = fleetEnvironmentTile(3)

afterEach(() => {
  h.calls.length = 0
  setConversationTile('c', null)
})

describe('placing a workspaces conversation browser', () => {
  it("opens the computer's window in its tile, kept above", () => {
    setConversationTile('c', tile)
    placeConversationBrowser('c', { kind: 'computer', tile }, windows('slot'))
    expect(conversationBrowserArea('c')).toBeNull()
    expect(h.calls).toEqual(['detach c', 'pin c', 'above true', 'refresh c'])
  })

  it("hands a streamed browser over to the computer's window", () => {
    placeConversationBrowser('c', { kind: 'computer', tile }, windows('stream'))
    expect(h.calls).toEqual(['handOver c', 'detach c', 'pin c', 'above true', 'refresh c'])
  })

  it("puts the browser in its tile, closing the computer's window", () => {
    placeConversationBrowser('c', { kind: 'tile', tile }, windows('floating'))
    expect(conversationBrowserArea('c')).toEqual(tile)
    expect(h.calls).toEqual(['reattach c', 'refresh c'])
    h.calls.length = 0
    placeConversationBrowser('c', { kind: 'tile', tile }, windows('stream'))
    expect(h.calls).toEqual(['refresh c'])
  })

  it('returns the browser to where it goes without computers', () => {
    setConversationTile('c', tile)
    placeConversationBrowser('c', { kind: 'none' }, windows('floating'))
    expect(conversationBrowserArea('c')).toBeNull()
    expect(h.calls).toEqual(['reattach c', 'refresh c'])
    h.calls.length = 0
    placeConversationBrowser('c', { kind: 'none' }, windows('stream'))
    expect(h.calls).toEqual(['handOver c', 'refresh c'])
  })
})
