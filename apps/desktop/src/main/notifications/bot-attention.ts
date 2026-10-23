import { type FleetServerId, fleetKey, isFleetServerId } from '../../shared/fleet-servers'
import type { FleetBotAttentionChange, FleetBotAttentionEntry } from '../../shared/notifications'

export interface FleetBotAttentionDeps {
  /** The stored marks (JSON), or null when none were stored. */
  load(): string | null
  save(value: string): void
  emit(change: FleetBotAttentionChange): void
  /** How many marks it keeps; the oldest go first. */
  max?: number
}

const MAX_MARKS = 1_000
const MAX_BOT_ID = 200

function parse(raw: string | null): Map<string, FleetBotAttentionEntry> {
  const marks = new Map<string, FleetBotAttentionEntry>()
  let value: unknown
  try {
    value = raw === null ? [] : JSON.parse(raw)
  } catch {
    return marks
  }
  if (!Array.isArray(value)) return marks
  for (const key of value) {
    if (typeof key !== 'string') continue
    const at = key.indexOf('/')
    const serverId = key.slice(0, at)
    const botId = key.slice(at + 1)
    if (at > 0 && isFleetServerId(serverId) && botId && botId.length <= MAX_BOT_ID) marks.set(key, { serverId, botId })
  }
  return marks
}

/**
 * The bots with something new for the owner on this computer, by server: a bot of two servers may share an id. Marks
 * last until the owner opens the bot, across restarts.
 */
export class FleetBotAttention {
  private readonly marks: Map<string, FleetBotAttentionEntry>

  constructor(private readonly deps: FleetBotAttentionDeps) {
    this.marks = parse(deps.load())
  }

  list(): FleetBotAttentionEntry[] {
    return [...this.marks.values()]
  }

  has(serverId: FleetServerId, botId: string): boolean {
    return this.marks.has(fleetKey(serverId, botId))
  }

  mark(serverId: FleetServerId, botId: string): void {
    const key = fleetKey(serverId, botId)
    if (this.marks.has(key) || !botId || botId.length > MAX_BOT_ID) return
    this.marks.set(key, { serverId, botId })
    const max = this.deps.max ?? MAX_MARKS
    for (const [oldest, entry] of this.marks) {
      if (this.marks.size <= max) break
      this.marks.delete(oldest)
      this.deps.emit({ ...entry, attention: false })
    }
    this.save()
    this.deps.emit({ serverId, botId, attention: true })
  }

  /** Returns whether the bot was marked. */
  clear(serverId: FleetServerId, botId: string): boolean {
    if (!this.marks.delete(fleetKey(serverId, botId))) return false
    this.save()
    this.deps.emit({ serverId, botId, attention: false })
    return true
  }

  /** Drops the marks of servers no longer paired. */
  retain(serverIds: ReadonlySet<FleetServerId>): void {
    const gone = this.list().filter(({ serverId }) => !serverIds.has(serverId))
    for (const { serverId, botId } of gone) this.clear(serverId, botId)
  }

  private save(): void {
    this.deps.save(JSON.stringify([...this.marks.keys()]))
  }
}
