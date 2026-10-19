import { FLEET_CONVERSATION_COMPUTER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { setConversationShellEnv } from '../../chat/conversation-env'
import { type ScreenArea, setConversationScreen } from '../../conversation-screen'
import { type BotDisplay, type DisplayManager, computerOwnerKey } from './displays'

/** Desktops of side conversations running at once in one environment: each holds an X server and its programs. */
export const LANE_COMPUTERS_MAX = 8

export interface LaneComputersDeps {
  displays: Pick<DisplayManager, 'startDesktop' | 'stopBot' | 'ownProcessIds'>
  /** The windows on a display, with the process id each reports (`null` when it reports none). */
  listWindows(display: string): Promise<{ pid: number | null }[]>
  now(): number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  log(message: string): void
}

type Running = {
  key: string
  display: BotDisplay
  /** Puts back what the conversation had before its desktop started. */
  restore: () => void
  /** Since when no window but its desktop's own was open on it, or null while one is. */
  idleSince: number | null
}
type Entry = {
  computer: Running | null
  starting: Promise<{ display: BotDisplay; started: boolean }> | null
  /** The teardown of its last desktop: the next one starts once it is over. */
  stopping: Promise<void> | null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The desktops of a bot's side conversations (its routine runs and its conversations with other bots), which work at
 * the same time as its own: each side conversation that uses the computer tools gets a desktop of its own, on a display
 * number of its own and without a browser tile, so its programs never open on the desktop of the bot's conversation or
 * of another side conversation. A desktop starts on first use and is given back once, for a minute, no window but its
 * desktop's own was open on it.
 */
export class LaneComputers {
  private readonly entries = new Map<string, Entry>()
  private readonly numbers = new Map<string, number>()
  private nextNumber: number = FLEET_CONVERSATION_COMPUTER_LIMITS.firstDisplay
  private readonly timer: ReturnType<typeof setInterval>
  private ticking = false
  private disposing: Promise<void> | null = null

  constructor(private readonly deps: LaneComputersDeps) {
    this.timer = deps.setInterval(() => void this.tick(), FLEET_CONVERSATION_COMPUTER_LIMITS.checkEveryMs)
    this.timer.unref?.()
  }

  /**
   * Starts the side conversation's own desktop, or returns the one running. Its screen keeps `botArea` as the place its
   * browser shows when the conversation comes forward; `restore` runs when the desktop is given back.
   */
  async open(
    conversationId: string,
    options: { botArea: ScreenArea; restore: () => void }
  ): Promise<{ display: BotDisplay; started: boolean }> {
    if (this.disposing) throw new Error('The desktops of side conversations are shutting down.')
    let entry = this.entries.get(conversationId)
    if (entry?.computer) {
      entry.computer.idleSince = null
      return { display: entry.computer.display, started: false }
    }
    if (entry?.starting) return entry.starting
    if (!entry) {
      if (this.running() >= LANE_COMPUTERS_MAX)
        throw new Error(`All ${LANE_COMPUTERS_MAX} desktops for side conversations are in use. Try again in a minute.`)
      entry = { computer: null, starting: null, stopping: null }
      this.entries.set(conversationId, entry)
    }
    const held = entry
    const starting = this.start(conversationId, held, options)
    held.starting = starting
    try {
      return await starting
    } finally {
      if (held.starting === starting) held.starting = null
    }
  }

  /** The conversation's desktop while it runs. */
  computer(conversationId: string): BotDisplay | null {
    return this.entries.get(conversationId)?.computer?.display ?? null
  }

  /** Gives the conversation's desktop back at once: its conversation is deleted or its bot goes away. */
  async close(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId)
    if (!entry) return
    if (entry.starting) await entry.starting.catch(() => undefined)
    await this.stop(conversationId, entry)
    if (this.entries.get(conversationId) === entry && !entry.computer && !entry.starting)
      this.entries.delete(conversationId)
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.deps.clearInterval(this.timer)
      await Promise.all([...this.entries.keys()].map((conversationId) => this.close(conversationId)))
    })()
    return this.disposing
  }

  private running(): number {
    return [...this.entries.values()].filter((entry) => entry.computer || entry.starting).length
  }

  private async start(
    conversationId: string,
    entry: Entry,
    options: { botArea: ScreenArea; restore: () => void }
  ): Promise<{ display: BotDisplay; started: boolean }> {
    const key = computerOwnerKey(conversationId)
    if (entry.stopping) await entry.stopping
    const number = this.numberFor(conversationId)
    let display: BotDisplay
    try {
      display = await this.deps.displays.startDesktop({
        key,
        slot: null,
        display: number,
        folder: 'maestrly-desktops',
      })
      if (this.disposing) throw new Error('The desktops of side conversations are shutting down.')
    } catch (error) {
      await this.deps.displays.stopBot(key).catch((cause: unknown) => this.deps.log(describeError(cause)))
      if (this.entries.get(conversationId) === entry && !entry.computer) this.entries.delete(conversationId)
      this.deps.log(`The desktop of side conversation ${conversationId} did not start: ${describeError(error)}`)
      throw error
    }
    entry.computer = { key, display, restore: options.restore, idleSince: null }
    setConversationScreen(conversationId, {
      display: display.display,
      width: display.width,
      height: display.height,
      windowArea: options.botArea,
    })
    setConversationShellEnv(conversationId, display.env)
    this.deps.log(`Started the desktop of side conversation ${conversationId} on ${display.display}.`)
    return { display, started: true }
  }

  /**
   * The conversation's display number: the one it had, or the next one no running desktop holds. Numbers are not given
   * to another conversation until they wrap around, so a program a conversation left running cannot open on another
   * conversation's desktop.
   */
  private numberFor(conversationId: string): number {
    const known = this.numbers.get(conversationId)
    if (known !== undefined) return known
    const { firstDisplay, lastDisplay } = FLEET_CONVERSATION_COMPUTER_LIMITS
    const held = new Set(
      [...this.entries.entries()].flatMap(([id, entry]) => {
        const number = entry.computer ? Number(entry.computer.display.display.slice(1)) : this.numbers.get(id)
        return number === undefined ? [] : [number]
      })
    )
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
        const own = new Set(this.deps.displays.ownProcessIds(computer.key))
        let windows: { pid: number | null }[]
        try {
          windows = await this.deps.listWindows(computer.display.display)
        } catch {
          windows = [{ pid: null }]
        }
        if (entry.computer !== computer || this.disposing) continue
        if (windows.some((window) => window.pid === null || !own.has(window.pid))) {
          computer.idleSince = null
          continue
        }
        const now = this.deps.now()
        computer.idleSince ??= now
        if (now - computer.idleSince < FLEET_CONVERSATION_COMPUTER_LIMITS.idleMs) continue
        await this.stop(conversationId, entry)
        if (this.entries.get(conversationId) === entry && !entry.computer && !entry.starting)
          this.entries.delete(conversationId)
      }
    } catch (error) {
      this.deps.log(`Checking the desktops of side conversations failed: ${describeError(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /** Stops the entry's desktop, gives the conversation back what it had before, and settles once the desktop stopped. */
  private stop(conversationId: string, entry: Entry): Promise<void> {
    const computer = entry.computer
    if (!computer) return entry.stopping ?? Promise.resolve()
    entry.computer = null
    try {
      computer.restore()
    } catch (error) {
      this.deps.log(describeError(error))
    }
    const stopping = (async () => {
      await this.deps.displays.stopBot(computer.key).catch((error: unknown) => this.deps.log(describeError(error)))
      this.deps.log(`The desktop of side conversation ${conversationId} on ${computer.display.display} was given back.`)
    })()
    entry.stopping = stopping
    return stopping.finally(() => {
      if (entry.stopping === stopping) entry.stopping = null
    })
  }
}
