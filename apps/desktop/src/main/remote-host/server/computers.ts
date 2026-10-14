import { createHash } from 'node:crypto'
import os from 'node:os'
import {
  FLEET_CONVERSATION_COMPUTER_LIMITS,
  type FleetInstanceHold,
  type ScreenMode,
  fleetEnvironmentTile,
} from '@maestrly/bot-fleet-protocol'
import { setConversationShellEnv } from '../../chat/conversation-env'
import { type ScreenArea, setConversationScreen, setPresentedBrowserSize } from '../../conversation-screen'
import type { BotDesktopHooks } from '../../fleet/instance/desktop/bot-desktop'
import type { BotDisplay, DisplayManager, ScreenLease } from '../../fleet/instance/displays'
import type { BotDesktopHandle, BotDesktopTarget } from '../../fleet/instance/environment'

/**
 * Where a workspaces conversation's browser window goes on the environment display:
 * - `computer`: the frameless window its computer's desktop presents, in the conversation's tile;
 * - `tile`: the window its Browser tab streams as video, at the tile's top left and kept above other windows;
 * - `none`: as without computers, offscreen or in the cascaded window its Browser tab streams as pictures.
 */
export type BrowserPlacement =
  | { kind: 'computer'; tile: ScreenArea }
  | { kind: 'tile'; tile: ScreenArea }
  | { kind: 'none' }

export type ComputerOpenResult =
  | { ok: true; display: string; started: boolean }
  | { ok: false; reason: 'busy'; holders: string[] }
  | { ok: false; reason: 'unavailable' }

/** A conversation's hold on its tile, for its Browser tab's video; `release` gives it back once. */
export type TileLease = { tile: ScreenArea; release(): void }

/** A screen of a conversation that is not there: no computer runs, or its browser holds no tile. */
export class ComputerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComputerUnavailableError'
  }
}

/**
 * The display manager's key for a conversation's computer: a bot id's shape (32 lowercase characters) derived from the
 * conversation id, so the paths of its bus and desktop socket stay short and name no conversation.
 */
export function computerOwnerKey(conversationId: string): string {
  return 'c' + createHash('sha256').update(conversationId).digest('hex').slice(0, 31)
}

export interface ConversationComputersDeps {
  displays: Pick<DisplayManager, 'startDesktop' | 'stopBot' | 'acquireScreen' | 'ownProcessIds'>
  /** Starts the desktop services of a computer: `startBotDesktop` in production. */
  desktop(target: BotDesktopTarget, hooks: BotDesktopHooks): Promise<BotDesktopHandle>
  /** The windows on a display, with the process id each reports (`null` when it reports none). */
  listWindows(display: string): Promise<{ pid: number | null }[]>
  conversation(id: string): { title: string | null; cwd: string | null } | null
  placeBrowser(conversationId: string, placement: BrowserPlacement): void
  /** The name of a conversation without a title, in the app's language. */
  untitled: string
  now(): number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  log(message: string): void
}

type Running = {
  key: string
  display: BotDisplay
  handle: BotDesktopHandle
  /** Screen leases of its apps display, and how many of them control it. */
  leases: number
  controllers: number
  /** Since when nothing has held it, or null while something does. */
  idleSince: number | null
}
type Entry = {
  slot: number
  tileLeases: number
  computer: Running | null
  starting: Promise<ComputerOpenResult> | null
  /** The display number of the computer it runs or starts. */
  number: number | null
  closed: boolean
}

const NOT_HELD: FleetInstanceHold = { state: 'none', reason: null, since: null, interruptedTurn: false }
// While the owner controls the computer, its desktop does not bring the agent's windows forward, as for a takeover.
const CONTROLLED: FleetInstanceHold = { state: 'held', reason: 'takeover', since: null, interruptedTurn: false }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The computers of a workspaces host's conversations. A conversation holds one of the eight slots (the tiles of the
 * environment display that show browsers) while its computer runs or while its Browser tab streams video; its computer
 * is a bot's apps desktop on a display number of its own. A computer starts when the owner opens it or the agent uses
 * it, and is given back once, for a minute, no screen showed it, nobody opened it and no window but its desktop's own
 * was open on it.
 */
export class ConversationComputers {
  private readonly entries = new Map<string, Entry>()
  private readonly numbers = new Map<string, number>()
  private readonly keys = new Map<string, string>()
  private nextNumber: number = FLEET_CONVERSATION_COMPUTER_LIMITS.firstDisplay
  private readonly timer: ReturnType<typeof setInterval>
  private ticking = false
  private disposing: Promise<void> | null = null

  constructor(private readonly deps: ConversationComputersDeps) {
    this.timer = deps.setInterval(() => void this.tick(), FLEET_CONVERSATION_COMPUTER_LIMITS.checkEveryMs)
    this.timer.unref?.()
  }

  /** Starts the conversation's computer, or keeps the one that runs from being given back. */
  async open(conversationId: string, by: 'owner' | 'agent'): Promise<ComputerOpenResult> {
    if (this.disposing) return { ok: false, reason: 'unavailable' }
    let entry = this.entries.get(conversationId)
    if (entry?.computer) {
      entry.computer.idleSince = null
      return { ok: true, display: entry.computer.display.display, started: false }
    }
    if (entry?.starting) return entry.starting
    if (!entry) {
      const slot = this.freeSlot()
      if (slot === null) return { ok: false, reason: 'busy', holders: this.holders() }
      entry = this.newEntry(conversationId, slot)
    }
    const starting = this.start(conversationId, entry, by)
    entry.starting = starting
    try {
      return await starting
    } finally {
      if (entry.starting === starting) entry.starting = null
    }
  }

  /** The conversation's computer while it runs. */
  computer(conversationId: string): BotDisplay | null {
    return this.entries.get(conversationId)?.computer?.display ?? null
  }

  /** Whether a device controls the conversation's computer. */
  controlled(conversationId: string): boolean {
    return (this.entries.get(conversationId)?.computer?.controllers ?? 0) > 0
  }

  /**
   * A stream of the conversation's computer (`apps`), which holds it while it lasts, or of its tile (`browser`). The
   * caller releases the lease when its connection ends.
   */
  async acquireScreen(conversationId: string, surface: 'apps' | 'browser', mode: ScreenMode): Promise<ScreenLease> {
    const entry = this.entries.get(conversationId)
    if (surface === 'browser') {
      if (!entry) throw new ComputerUnavailableError("This conversation's browser is not on a tile.")
      return this.deps.displays.acquireScreen({ kind: 'tile', slot: entry.slot })
    }
    const computer = entry?.computer
    if (!computer) throw new ComputerUnavailableError('This conversation has no computer running.')
    const control = mode === 'control'
    computer.leases++
    if (control) computer.controllers++
    computer.idleSince = null
    let released = false
    const release = () => {
      if (released) return
      released = true
      computer.leases--
      if (control) computer.controllers--
    }
    let lease: ScreenLease
    try {
      lease = await this.deps.displays.acquireScreen({ kind: 'apps', botId: computer.key })
    } catch (error) {
      release()
      throw error
    }
    return {
      session: lease.session,
      release: () => {
        if (released) return
        release()
        lease.release()
      },
    }
  }

  /** A tile for the conversation's Browser tab to stream as video, or null when every slot is taken. */
  leaseTile(conversationId: string): TileLease | null {
    if (this.disposing) return null
    let entry = this.entries.get(conversationId)
    if (!entry) {
      const slot = this.freeSlot()
      if (slot === null) return null
      entry = this.newEntry(conversationId, slot)
    }
    const held = entry
    held.tileLeases++
    const tile = fleetEnvironmentTile(held.slot)
    if (!held.computer) this.deps.placeBrowser(conversationId, { kind: 'tile', tile })
    let released = false
    return {
      tile,
      release: () => {
        if (released) return
        released = true
        if (this.entries.get(conversationId) !== held) return
        held.tileLeases--
        if (held.tileLeases === 0 && !held.computer && !held.starting) this.free(conversationId, held)
      },
    }
  }

  /** The name a computer's wallpaper shows: its conversation's title. */
  titleOfKey(key: string): string | null {
    const conversationId = this.keys.get(key)
    return conversationId === undefined ? null : this.title(conversationId)
  }

  /** Gives the conversation's computer and its tile back at once: it is being closed or deleted. */
  async close(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId)
    if (!entry) return
    this.entries.delete(conversationId)
    entry.closed = true
    entry.tileLeases = 0
    if (entry.starting) await entry.starting.catch(() => undefined)
    await this.stopComputer(conversationId, entry)
    this.deps.placeBrowser(conversationId, { kind: 'none' })
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.deps.clearInterval(this.timer)
      await Promise.all([...this.entries.keys()].map((conversationId) => this.close(conversationId)))
    })()
    return this.disposing
  }

  private async start(conversationId: string, entry: Entry, by: 'owner' | 'agent'): Promise<ComputerOpenResult> {
    const key = computerOwnerKey(conversationId)
    this.keys.set(key, conversationId)
    const number = this.numberFor(conversationId)
    entry.number = number
    const tile = fleetEnvironmentTile(entry.slot)
    let display: BotDisplay | null = null
    let handle: BotDesktopHandle | null = null
    try {
      display = await this.deps.displays.startDesktop({
        key,
        slot: entry.slot,
        display: number,
        folder: 'maestrly-desktops',
      })
      handle = await this.deps.desktop(
        { botId: key, display, conversationId: () => conversationId, hold: () => this.hold(conversationId) },
        {
          floatBrowser: () => this.deps.placeBrowser(conversationId, { kind: 'computer', tile }),
          filesFolder: () => this.deps.conversation(conversationId)?.cwd || os.homedir(),
        }
      )
      if (entry.closed || this.disposing) throw new Error('The conversation was closed while its computer started.')
    } catch (error) {
      if (handle) await handle.dispose().catch((cause: unknown) => this.deps.log(describeError(cause)))
      await this.deps.displays.stopBot(key).catch((cause: unknown) => this.deps.log(describeError(cause)))
      entry.number = null
      if (this.entries.get(conversationId) === entry && entry.tileLeases === 0) this.free(conversationId, entry)
      this.deps.log(`The computer of conversation ${conversationId} did not start: ${describeError(error)}`)
      throw error
    }
    entry.computer = { key, display, handle, leases: 0, controllers: 0, idleSince: null }
    setConversationScreen(conversationId, {
      display: display.display,
      width: display.width,
      height: display.height,
      windowArea: tile,
    })
    setConversationShellEnv(conversationId, display.env)
    this.deps.placeBrowser(conversationId, { kind: 'computer', tile })
    this.deps.log(
      `Started the computer of conversation ${conversationId} on ${display.display} in slot ${entry.slot} for the ${by}.`
    )
    return { ok: true, display: display.display, started: true }
  }

  private hold(conversationId: string): FleetInstanceHold {
    return this.controlled(conversationId) ? CONTROLLED : NOT_HELD
  }

  private newEntry(conversationId: string, slot: number): Entry {
    const entry: Entry = { slot, tileLeases: 0, computer: null, starting: null, number: null, closed: false }
    this.entries.set(conversationId, entry)
    return entry
  }

  private free(conversationId: string, entry: Entry): void {
    if (this.entries.get(conversationId) !== entry) return
    this.entries.delete(conversationId)
    this.deps.placeBrowser(conversationId, { kind: 'none' })
  }

  private freeSlot(): number | null {
    const used = new Set([...this.entries.values()].map((entry) => entry.slot))
    for (let slot = 1; slot <= FLEET_CONVERSATION_COMPUTER_LIMITS.slots; slot++) if (!used.has(slot)) return slot
    return null
  }

  private title(conversationId: string): string {
    return this.deps.conversation(conversationId)?.title?.trim() || this.deps.untitled
  }

  private holders(): string[] {
    return [...this.entries.keys()].map((conversationId) => this.title(conversationId))
  }

  /**
   * The conversation's display number: the one it had, or the next one no running computer holds. Numbers are not
   * given to another conversation until they wrap around, so a program a conversation left running cannot open on
   * another conversation's computer.
   */
  private numberFor(conversationId: string): number {
    const known = this.numbers.get(conversationId)
    if (known !== undefined) return known
    const { firstDisplay, lastDisplay } = FLEET_CONVERSATION_COMPUTER_LIMITS
    const held = new Set([...this.entries.values()].flatMap((entry) => (entry.number === null ? [] : [entry.number])))
    for (let tries = firstDisplay; tries <= lastDisplay; tries++) {
      const candidate = this.nextNumber
      this.nextNumber = candidate >= lastDisplay ? firstDisplay : candidate + 1
      if (held.has(candidate)) continue
      for (const [other, number] of this.numbers) if (number === candidate) this.numbers.delete(other)
      this.numbers.set(conversationId, candidate)
      return candidate
    }
    throw new Error('No display number is free.')
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.disposing) return
    this.ticking = true
    try {
      for (const [conversationId, entry] of [...this.entries]) {
        const computer = entry.computer
        if (!computer) continue
        if (computer.leases > 0) {
          computer.idleSince = null
          continue
        }
        const own = new Set([...this.deps.displays.ownProcessIds(computer.key), ...computer.handle.ownProcessIds()])
        let windows: { pid: number | null }[]
        try {
          windows = await this.deps.listWindows(computer.display.display)
        } catch {
          windows = [{ pid: null }]
        }
        if (entry.computer !== computer || this.disposing) continue
        if (computer.leases > 0 || windows.some((window) => window.pid === null || !own.has(window.pid))) {
          computer.idleSince = null
          continue
        }
        const now = this.deps.now()
        computer.idleSince ??= now
        if (now - computer.idleSince < FLEET_CONVERSATION_COMPUTER_LIMITS.idleMs) continue
        await this.stopComputer(conversationId, entry)
        if (this.entries.get(conversationId) !== entry || entry.computer || entry.starting) continue
        if (entry.tileLeases > 0)
          this.deps.placeBrowser(conversationId, { kind: 'tile', tile: fleetEnvironmentTile(entry.slot) })
        else this.free(conversationId, entry)
      }
    } catch (error) {
      this.deps.log(`Checking the conversations' computers failed: ${describeError(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /** Stops the entry's computer and clears what the conversation's shells and tools knew of it. */
  private async stopComputer(conversationId: string, entry: Entry): Promise<void> {
    const computer = entry.computer
    if (!computer) return
    entry.computer = null
    entry.number = null
    setConversationScreen(conversationId, null)
    setConversationShellEnv(conversationId, null)
    // The size its desktop presented the browser at: a stream window of the browser takes the viewer's size again.
    setPresentedBrowserSize(conversationId, null)
    await computer.handle.dispose().catch((error: unknown) => this.deps.log(describeError(error)))
    await this.deps.displays.stopBot(computer.key).catch((error: unknown) => this.deps.log(describeError(error)))
    this.deps.log(`The computer of conversation ${conversationId} on ${computer.display.display} was given back.`)
  }
}
