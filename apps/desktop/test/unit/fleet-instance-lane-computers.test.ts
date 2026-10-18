import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLEET_CONVERSATION_COMPUTER_LIMITS, FLEET_SCREEN } from '@maestrly/bot-fleet-protocol'
import { conversationShellEnv, setConversationShellEnv } from '../../src/main/chat/conversation-env'
import { conversationScreen, setConversationScreen } from '../../src/main/conversation-screen'
import { type BotDisplay, type DesktopOwner, computerOwnerKey } from '../../src/main/fleet/instance/displays'
import { LANE_COMPUTERS_MAX, LaneComputers } from '../../src/main/fleet/instance/lane-computers'

const botArea = { x: 1280, y: 0, width: 1280, height: 800 }

/** Displays that start at once; `windows` lists, per display, the process ids of its windows. */
function setup() {
  let now = 0
  let tick: () => void = () => undefined
  const started: DesktopOwner[] = []
  const stopped: string[] = []
  const own = new Map<string, number[]>()
  const windows = new Map<string, (number | null)[]>()
  const displays = {
    startDesktop: vi.fn(async (owner: DesktopOwner): Promise<BotDisplay> => {
      started.push(owner)
      const name = `:${owner.display}`
      own.set(owner.key, [500 + started.length])
      return {
        botId: owner.key,
        slot: owner.slot,
        display: name,
        width: FLEET_SCREEN.width,
        height: FLEET_SCREEN.height,
        env: {
          DISPLAY: name,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/home/bot/.cache/maestrly-desktops/${owner.key}/bus`,
          BROWSER: '/usr/local/bin/maestrly-open-url',
          MAESTRLY_BOT_BROWSER_PROFILE: `/home/bot/.config/maestrly-desktops/${owner.key}/chromium`,
          GTK_THEME: 'Adwaita:dark',
          MAESTRLY_DESKTOP_SOCKET: `/home/bot/.cache/maestrly-desktops/${owner.key}/desktop.sock`,
        },
        browserArea: null,
      }
    }),
    stopBot: vi.fn(async (key: string) => {
      stopped.push(key)
    }),
    ownProcessIds: (key: string) => own.get(key) ?? [],
  }
  const computers = new LaneComputers({
    displays,
    listWindows: async (display) => (windows.get(display) ?? []).map((pid) => ({ pid })),
    now: () => now,
    setInterval: ((callback: () => void) => {
      tick = callback
      return { unref: () => undefined }
    }) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as unknown as typeof clearInterval,
    log: () => undefined,
  })
  const advance = async (ms: number) => {
    now += ms
    tick()
    for (let round = 0; round < 10; round++) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { computers, displays, started, stopped, own, windows, advance }
}

afterEach(() => {
  for (const id of ['conv-a', 'conv-b']) {
    setConversationScreen(id, null)
    setConversationShellEnv(id, null)
  }
})

describe("side conversations' own desktops", () => {
  it('starts a desktop without a tile on a display number of its own for each side conversation', async () => {
    const { computers, started } = setup()
    const restore = vi.fn()
    const a = await computers.open('conv-a', { botArea, restore })
    const b = await computers.open('conv-b', { botArea, restore })
    const { firstDisplay } = FLEET_CONVERSATION_COMPUTER_LIMITS
    expect(a).toMatchObject({ started: true, display: { display: `:${firstDisplay}` } })
    expect(b).toMatchObject({ started: true, display: { display: `:${firstDisplay + 1}` } })
    expect(started).toEqual([
      { key: computerOwnerKey('conv-a'), slot: null, display: firstDisplay, folder: 'maestrly-desktops' },
      { key: computerOwnerKey('conv-b'), slot: null, display: firstDisplay + 1, folder: 'maestrly-desktops' },
    ])
    // Its tools act on its own desktop; its browser still shows in the bot's area when it comes forward.
    expect(conversationScreen('conv-a')).toEqual({
      display: `:${firstDisplay}`,
      width: FLEET_SCREEN.width,
      height: FLEET_SCREEN.height,
      windowArea: botArea,
    })
    expect(conversationShellEnv('conv-a').DISPLAY).toBe(`:${firstDisplay}`)
    const again = await computers.open('conv-a', { botArea, restore })
    expect(again).toMatchObject({ started: false, display: { display: `:${firstDisplay}` } })
    expect(started).toHaveLength(2)
    expect(restore).not.toHaveBeenCalled()
  })

  it('starts one desktop for calls that open it at the same time', async () => {
    const { computers, started } = setup()
    const options = { botArea, restore: () => undefined }
    const [first, second] = await Promise.all([computers.open('conv-a', options), computers.open('conv-a', options)])
    expect(started).toHaveLength(1)
    expect(first.display).toBe(second.display)
  })

  it('gives a desktop back once, for a minute, only its own windows were open, and restores the conversation', async () => {
    const { computers, stopped, own, windows, advance } = setup()
    const restore = vi.fn()
    const { display } = await computers.open('conv-a', { botArea, restore })
    const key = computerOwnerKey('conv-a')
    // A program the conversation opened keeps its desktop.
    windows.set(display.display, [own.get(key)![0], 4242])
    await advance(FLEET_CONVERSATION_COMPUTER_LIMITS.idleMs * 2)
    expect(stopped).toEqual([])
    windows.set(display.display, [own.get(key)![0]])
    await advance(FLEET_CONVERSATION_COMPUTER_LIMITS.checkEveryMs)
    expect(stopped).toEqual([])
    await advance(FLEET_CONVERSATION_COMPUTER_LIMITS.idleMs)
    expect(stopped).toEqual([key])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(computers.computer('conv-a')).toBeNull()
    // The next use starts it again on the same display number.
    const next = await computers.open('conv-a', { botArea, restore })
    expect(next).toMatchObject({ started: true, display: { display: display.display } })
  })

  it(`runs at most ${LANE_COMPUTERS_MAX} desktops at once`, async () => {
    const { computers } = setup()
    for (let index = 0; index < LANE_COMPUTERS_MAX; index++)
      await computers.open(`conv-${index}`, { botArea, restore: () => undefined })
    await expect(computers.open('conv-last', { botArea, restore: () => undefined })).rejects.toThrow(
      'All 8 desktops for side conversations are in use. Try again in a minute.'
    )
    await computers.close('conv-0')
    await expect(computers.open('conv-last', { botArea, restore: () => undefined })).resolves.toMatchObject({
      started: true,
    })
  })

  it('gives every desktop back on close and on dispose', async () => {
    const { computers, stopped } = setup()
    const restore = vi.fn()
    await computers.open('conv-a', { botArea, restore })
    await computers.open('conv-b', { botArea, restore })
    await computers.close('conv-a')
    expect(stopped).toEqual([computerOwnerKey('conv-a')])
    await computers.dispose()
    expect(stopped).toEqual([computerOwnerKey('conv-a'), computerOwnerKey('conv-b')])
    expect(restore).toHaveBeenCalledTimes(2)
    await expect(computers.open('conv-a', { botArea, restore })).rejects.toThrow(/shutting down/)
  })
})
