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
/** Side conversations one mark names at most; past them, only this computer clears it. */
const MAX_LANES = 20
const MAX_LANE = 300

/**
 * A mark, and why: the side conversations it is for (`run:<id>`, `thread:<id>`), which the owner may see on another
 * device, and whether something only this computer clears marked it too, such as a turn of the bot's own conversation.
 */
type Mark = FleetBotAttentionEntry & { lanes: Set<string>; local: boolean }

function entryOf(key: unknown): FleetBotAttentionEntry | null {
  if (typeof key !== 'string') return null
  const at = key.indexOf('/')
  const serverId = key.slice(0, at)
  const botId = key.slice(at + 1)
  return at > 0 && isFleetServerId(serverId) && botId && botId.length <= MAX_BOT_ID ? { serverId, botId } : null
}

/**
 * Marks are stored as their keys, as before side conversations were told apart, and a mark for side conversations
 * only as `{ key, lanes }`: a version that reads only keys drops those, and a key alone is a mark only this computer
 * clears.
 */
function parse(raw: string | null): Map<string, Mark> {
  const marks = new Map<string, Mark>()
  let value: unknown
  try {
    value = raw === null ? [] : JSON.parse(raw)
  } catch {
    return marks
  }
  if (!Array.isArray(value)) return marks
  for (const item of value) {
    const stored = typeof item === 'object' && item !== null ? (item as { key?: unknown; lanes?: unknown }) : null
    const entry = entryOf(stored ? stored.key : item)
    if (!entry) continue
    const lanes = stored
      ? (Array.isArray(stored.lanes) ? stored.lanes : []).filter(
          (lane): lane is string => typeof lane === 'string' && lane.length > 0 && lane.length <= MAX_LANE
        )
      : []
    if (stored && !lanes.length) continue
    const local = !stored || lanes.length > MAX_LANES
    marks.set(fleetKey(entry.serverId, entry.botId), { ...entry, lanes: new Set(local ? [] : lanes), local })
  }
  return marks
}

/**
 * The bots with something new for the owner on this computer, by server: a bot of two servers may share an id. Marks
 * last until the owner opens the bot, across restarts, or until they see every side conversation it was for on any
 * of their devices.
 */
export class FleetBotAttention {
  private readonly marks: Map<string, Mark>

  constructor(private readonly deps: FleetBotAttentionDeps) {
    this.marks = parse(deps.load())
  }

  list(): FleetBotAttentionEntry[] {
    return [...this.marks.values()].map(({ serverId, botId }) => ({ serverId, botId }))
  }

  has(serverId: FleetServerId, botId: string): boolean {
    return this.marks.has(fleetKey(serverId, botId))
  }

  /** Marks the bot for a side conversation (`lane`), or for something only this computer clears. */
  mark(serverId: FleetServerId, botId: string, lane?: string): void {
    if (!botId || botId.length > MAX_BOT_ID) return
    const key = fleetKey(serverId, botId)
    const known = lane && lane.length <= MAX_LANE ? lane : undefined
    const current = this.marks.get(key)
    if (current) {
      if (current.local || (known && current.lanes.has(known))) return
      if (known && current.lanes.size < MAX_LANES) current.lanes.add(known)
      else {
        current.local = true
        current.lanes.clear()
      }
      this.save()
      return
    }
    this.marks.set(key, { serverId, botId, lanes: new Set(known ? [known] : []), local: !known })
    const max = this.deps.max ?? MAX_MARKS
    for (const [oldest, entry] of this.marks) {
      if (this.marks.size <= max) break
      this.marks.delete(oldest)
      this.deps.emit({ serverId: entry.serverId, botId: entry.botId, attention: false })
    }
    this.save()
    this.deps.emit({ serverId, botId, attention: true })
  }

  /** The owner saw a side conversation, here or on another device: the mark goes once nothing else holds it. */
  seenLane(serverId: FleetServerId, botId: string, lane: string): boolean {
    const mark = this.marks.get(fleetKey(serverId, botId))
    if (!mark?.lanes.delete(lane)) return false
    if (mark.lanes.size || mark.local) {
      this.save()
      return false
    }
    return this.clear(serverId, botId)
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
    this.deps.save(
      JSON.stringify([...this.marks].map(([key, mark]) => (mark.local ? key : { key, lanes: [...mark.lanes] })))
    )
  }
}
