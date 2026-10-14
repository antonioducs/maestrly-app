import { randomUUID } from 'node:crypto'
import { FLEET_SCREEN, fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationShellEnv, setConversationShellEnv } from '../../src/main/chat/conversation-env'
import {
  conversationScreen,
  presentedBrowserSize,
  setConversationScreen,
  setPresentedBrowserSize,
} from '../../src/main/conversation-screen'
import type { BotDesktopHooks } from '../../src/main/fleet/instance/desktop/bot-desktop'
import type { BotDisplay, DesktopOwner, DisplayScreen, ScreenLease } from '../../src/main/fleet/instance/displays'
import type { BotDesktopTarget } from '../../src/main/fleet/instance/environment'
import type { ScreenSession } from '../../src/main/fleet/instance/screen-session'
import {
  type BrowserPlacement,
  ComputerUnavailableError,
  ConversationComputers,
  computerOwnerKey,
} from '../../src/main/remote-host/server/computers'

const used: string[] = []
afterEach(() => {
  for (const id of used.splice(0)) {
    setConversationScreen(id, null)
    setConversationShellEnv(id, null)
  }
})

/** A conversation id this test registers; its screen and shell variables are cleared afterwards. */
function conversation(): string {
  const id = randomUUID()
  used.push(id)
  return id
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function setup(titles: Record<string, string | null> = {}) {
  let now = 0
  let interval: (() => void) | null = null
  const started: DesktopOwner[] = []
  const stopped: string[] = []
  const acquired: DisplayScreen[] = []
  const placements: [string, BrowserPlacement][] = []
  const targets = new Map<string, BotDesktopTarget>()
  const hooks = new Map<string, BotDesktopHooks>()
  const disposed: string[] = []
  /** The windows each display shows, by display name. */
  const windows = new Map<string, { pid: number | null }[]>()
  const ownPids = new Map<string, number[]>()
  const releases: DisplayScreen[] = []
  const displays = {
    startDesktop: vi.fn(async (owner: DesktopOwner): Promise<BotDisplay> => {
      started.push(owner)
      const name = `:${owner.display}`
      ownPids.set(owner.key, [100 + started.length])
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
        browserArea: fleetEnvironmentTile(owner.slot),
      }
    }),
    stopBot: vi.fn(async (key: string) => {
      stopped.push(key)
    }),
    acquireScreen: vi.fn(async (screen: DisplayScreen): Promise<ScreenLease> => {
      acquired.push(screen)
      return { session: {} as ScreenSession, release: () => void releases.push(screen) }
    }),
    ownProcessIds: (key: string) => ownPids.get(key) ?? [],
  }
  const computers = new ConversationComputers({
    displays,
    desktop: async (target, desktopHooks) => {
      const conversationId = target.conversationId()!
      targets.set(conversationId, target)
      hooks.set(conversationId, desktopHooks)
      return {
        present: () => undefined,
        ownProcessIds: () => [900],
        dispose: async () => void disposed.push(conversationId),
      }
    },
    listWindows: async (display) => windows.get(display) ?? [],
    conversation: (id) => (id in titles ? { title: titles[id], cwd: '/srv/work' } : { title: id, cwd: null }),
    placeBrowser: (id, placement) => void placements.push([id, placement]),
    untitled: 'Untitled conversation',
    now: () => now,
    setInterval: ((callback: () => void) => {
      interval = callback
      return { unref: () => undefined }
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      interval = null
    }) as unknown as typeof clearInterval,
    log: () => undefined,
  })
  /** Advances the clock by `ms`, running the 5 s check on the way. */
  const advance = async (ms: number) => {
    const end = now + ms
    while (now + 5_000 <= end) {
      now += 5_000
      interval?.()
      await settle()
    }
    now = end
  }
  return {
    computers,
    displays,
    started,
    stopped,
    acquired,
    releases,
    placements,
    targets,
    hooks,
    disposed,
    windows,
    advance,
    placementsOf: (id: string) => placements.filter(([of]) => of === id).map(([, placement]) => placement),
  }
}

describe('ConversationComputers', () => {
  it('starts computers in the lowest free slot, on display numbers of their own', async () => {
    const t = setup()
    const a = conversation()
    const b = conversation()
    expect(await t.computers.open(a, 'owner')).toEqual({ ok: true, display: ':10', started: true })
    expect(t.started[0]).toEqual({ key: computerOwnerKey(a), slot: 1, display: 10, folder: 'maestrly-desktops' })
    expect(computerOwnerKey(a)).toMatch(/^c[0-9a-f]{31}$/)
    expect(conversationShellEnv(a).DISPLAY).toBe(':10')
    expect(conversationScreen(a)?.windowArea).toEqual(fleetEnvironmentTile(1))
    expect(t.placementsOf(a)).toEqual([{ kind: 'computer', tile: fleetEnvironmentTile(1) }])
    expect(await t.computers.open(b, 'agent')).toEqual({ ok: true, display: ':11', started: true })
    expect(t.started[1]).toMatchObject({ slot: 2, display: 11 })
    expect(await t.computers.open(a, 'agent')).toEqual({ ok: true, display: ':10', started: false })
    expect(t.started).toHaveLength(2)
    expect(t.computers.computer(a)?.display).toBe(':10')
    expect(t.hooks.get(a)?.filesFolder?.(a)).toBeTruthy()
  })

  it('refuses a ninth computer, naming the conversations that hold the slots', async () => {
    const ids = Array.from({ length: 8 }, () => conversation())
    const untitled = ids[3]
    const t = setup({ [untitled]: null })
    for (const id of ids) expect((await t.computers.open(id, 'owner')).ok).toBe(true)
    const holders = ids.map((id) => (id === untitled ? 'Untitled conversation' : id))
    expect(await t.computers.open(conversation(), 'owner')).toEqual({ ok: false, reason: 'busy', holders })
  })

  it('gives an idle computer back after a minute and frees its slot', async () => {
    const t = setup()
    const a = conversation()
    await t.computers.open(a, 'owner')
    setPresentedBrowserSize(a, { width: 1120, height: 640 })
    await t.advance(55_000)
    expect(t.stopped).toEqual([])
    await t.advance(10_000)
    expect(t.stopped).toEqual([computerOwnerKey(a)])
    expect(t.disposed).toEqual([a])
    expect(conversationShellEnv(a)).toEqual({})
    expect(conversationScreen(a)).toBeNull()
    expect(presentedBrowserSize(a)).toBeNull()
    expect(t.placementsOf(a).at(-1)).toEqual({ kind: 'none' })
    expect(t.computers.computer(a)).toBeNull()
    const c = conversation()
    await t.computers.open(c, 'owner')
    expect(t.started.at(-1)).toMatchObject({ slot: 1 })
  })

  it.each([
    ['a screen lease', 'lease'],
    ['the agent using it every 30 s', 'agent'],
    ['a window of another program', 'foreign'],
    ['a window without a process id', 'anonymous'],
  ] as const)('keeps a computer while %s holds it, and gives it back a minute after', async (_label, holder) => {
    const t = setup()
    const a = conversation()
    await t.computers.open(a, 'owner')
    let lease: ScreenLease | null = null
    if (holder === 'lease') lease = await t.computers.acquireScreen(a, 'apps', 'view')
    if (holder === 'foreign') t.windows.set(':10', [{ pid: 4242 }])
    if (holder === 'anonymous') t.windows.set(':10', [{ pid: null }])
    for (let elapsed = 0; elapsed < 180_000; elapsed += 30_000) {
      if (holder === 'agent') await t.computers.open(a, 'agent')
      await t.advance(30_000)
    }
    expect(t.stopped).toEqual([])
    // The holder goes away now: the agent's last use, the screen closing, the window closing.
    if (holder === 'agent') await t.computers.open(a, 'agent')
    lease?.release()
    t.windows.delete(':10')
    await t.advance(55_000)
    expect(t.stopped).toEqual([])
    await t.advance(15_000)
    expect(t.stopped).toEqual([computerOwnerKey(a)])
  })

  it("does not count the desktop's own windows", async () => {
    const t = setup()
    const a = conversation()
    await t.computers.open(a, 'owner')
    // 101 is a display program (the presenter, tint2…); 900 a terminal window or file manager of its services.
    t.windows.set(':10', [{ pid: 101 }, { pid: 900 }])
    await t.advance(70_000)
    expect(t.stopped).toEqual([computerOwnerKey(a)])
  })

  it('keeps a conversation on its display number and gives new conversations new ones', async () => {
    const t = setup()
    const a = conversation()
    const b = conversation()
    await t.computers.open(a, 'owner')
    await t.advance(70_000)
    expect((await t.computers.open(b, 'owner')).ok && t.started.at(-1)?.display).toBe(11)
    expect(await t.computers.open(a, 'owner')).toEqual({ ok: true, display: ':10', started: true })
  })

  it('shares a slot between the Browser tab and the computer', async () => {
    const t = setup()
    const a = conversation()
    const tile = fleetEnvironmentTile(1)
    const lease = t.computers.leaseTile(a)
    expect(lease?.tile).toEqual(tile)
    expect(t.placementsOf(a)).toEqual([{ kind: 'tile', tile }])
    await t.computers.open(a, 'owner')
    expect(t.started[0].slot).toBe(1)
    expect(t.placementsOf(a).at(-1)).toEqual({ kind: 'computer', tile })
    await t.advance(70_000)
    expect(t.stopped).toEqual([computerOwnerKey(a)])
    expect(t.placementsOf(a).at(-1)).toEqual({ kind: 'tile', tile })
    // Still held by the tile: another conversation gets slot 2.
    expect(t.computers.leaseTile(conversation())?.tile).toEqual(fleetEnvironmentTile(2))
    lease?.release()
    lease?.release()
    expect(t.placementsOf(a).at(-1)).toEqual({ kind: 'none' })
    expect(t.computers.leaseTile(conversation())?.tile).toEqual(tile)
  })

  it('has no tile for a Browser tab once every slot is taken', async () => {
    const t = setup()
    for (let i = 0; i < 8; i++) await t.computers.open(conversation(), 'owner')
    expect(t.computers.leaseTile(conversation())).toBeNull()
  })

  it('gives a computer back at once when its conversation closes', async () => {
    const t = setup()
    const a = conversation()
    await t.computers.open(a, 'owner')
    const lease = t.computers.leaseTile(a)
    await t.computers.close(a)
    expect(t.stopped).toEqual([computerOwnerKey(a)])
    expect(conversationShellEnv(a)).toEqual({})
    expect(t.placementsOf(a).at(-1)).toEqual({ kind: 'none' })
    lease?.release()
    expect(t.computers.leaseTile(conversation())?.tile).toEqual(fleetEnvironmentTile(1))
  })

  it('holds its desktop back from bringing windows forward while a device controls it', async () => {
    const t = setup()
    const a = conversation()
    await t.computers.open(a, 'owner')
    expect(t.computers.controlled(a)).toBe(false)
    const view = await t.computers.acquireScreen(a, 'apps', 'view')
    expect(t.computers.controlled(a)).toBe(false)
    const control = await t.computers.acquireScreen(a, 'apps', 'control')
    expect(t.acquired).toEqual([
      { kind: 'apps', botId: computerOwnerKey(a) },
      { kind: 'apps', botId: computerOwnerKey(a) },
    ])
    expect(t.computers.controlled(a)).toBe(true)
    expect(t.targets.get(a)?.hold()).toEqual({ state: 'held', reason: 'takeover', since: null, interruptedTurn: false })
    control.release()
    control.release()
    expect(t.computers.controlled(a)).toBe(false)
    expect(t.targets.get(a)?.hold()).toEqual({ state: 'none', reason: null, since: null, interruptedTurn: false })
    view.release()
    expect(t.releases).toHaveLength(2)
  })

  it('refuses screens a conversation does not have', async () => {
    const t = setup()
    const a = conversation()
    await expect(t.computers.acquireScreen(a, 'apps', 'view')).rejects.toBeInstanceOf(ComputerUnavailableError)
    await expect(t.computers.acquireScreen(a, 'browser', 'view')).rejects.toBeInstanceOf(ComputerUnavailableError)
    const lease = t.computers.leaseTile(a)
    await expect(t.computers.acquireScreen(a, 'apps', 'view')).rejects.toBeInstanceOf(ComputerUnavailableError)
    await t.computers.acquireScreen(a, 'browser', 'view')
    expect(t.acquired).toEqual([{ kind: 'tile', slot: 1 }])
    lease?.release()
  })

  it('starts a computer once for opens that come together', async () => {
    const t = setup()
    const a = conversation()
    const results = await Promise.all([t.computers.open(a, 'owner'), t.computers.open(a, 'agent')])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(t.displays.startDesktop).toHaveBeenCalledTimes(1)
  })

  it('frees the slot of a computer that failed to start', async () => {
    const t = setup()
    const a = conversation()
    t.displays.startDesktop.mockRejectedValueOnce(new Error('Display :10 did not start.'))
    await expect(t.computers.open(a, 'owner')).rejects.toThrow('did not start')
    expect(conversationShellEnv(a)).toEqual({})
    expect(t.computers.leaseTile(conversation())?.tile).toEqual(fleetEnvironmentTile(1))
  })

  it('names a computer after its conversation', async () => {
    const a = conversation()
    const t = setup({ [a]: 'Fix the login page' })
    await t.computers.open(a, 'owner')
    expect(t.computers.titleOfKey(computerOwnerKey(a))).toBe('Fix the login page')
    expect(t.computers.titleOfKey('c' + '0'.repeat(31))).toBeNull()
  })
})
