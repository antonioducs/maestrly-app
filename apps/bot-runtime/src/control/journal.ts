import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  guestEventSchema,
  TURN_TERMINAL,
  turnStatusSchema,
  type BotTurn,
  type GuestEvent,
  type TurnSnapshot,
} from '@maestrly/host-protocol'
import type { ProviderEvent } from '../providers/provider.js'
import { encodeFrame } from './framing.js'

/** Writes every byte: a short write is continued, and any error surfaces to the caller. */
function writeAll(fd: number, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; ) offset += writeSync(fd, bytes, offset, bytes.length - offset)
}
function parseRecord(text: string): JournalRecord | undefined {
  try {
    const value = JSON.parse(text) as JournalRecord
    return value && typeof value === 'object' && typeof value.kind === 'string' && value.data && typeof value.data === 'object' ? value : undefined
  } catch {
    return undefined
  }
}
/**
 * A write that failed midway (for example on a full disk) can leave a torn prefix that the next
 * append completes into one line: `{"kind":"event.pe{"kind":"turn.status",...}`. The torn record
 * was never acknowledged (append throws before applying it); the complete record after it is kept.
 */
function afterTornPrefix(line: string): JournalRecord | undefined {
  for (let start = line.indexOf('{"kind":"', 1); start > 0; start = line.indexOf('{"kind":"', start + 1)) {
    const record = parseRecord(line.slice(start))
    if (record) return record
  }
  return undefined
}
type RecordKind =
  | 'generation'
  | 'turn.accepted'
  | 'turn.status'
  | 'action.intent'
  | 'action.result'
  | 'event.pending'
  | 'event.acked'
  | 'provider.thread'
interface JournalRecord {
  kind: RecordKind
  data: Record<string, unknown>
}
export interface JournalTurn {
  turnId: string
  generation: number
  conversationId: string
  status: BotTurn['status']
  providerThreadId?: string
  providerTurnId?: string
}
/** All writes are synchronous and fsynced: acceptance and effects cannot outrun persistence. */
export class Journal {
  readonly path: string
  private records: JournalRecord[] = []
  private turns = new Map<string, JournalTurn>()
  private pending = new Map<string, GuestEvent>()
  private threads = new Map<string, string>()
  private generation = 0
  private listeners = new Set<() => void>()
  constructor(readonly state: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 })
    this.path = join(state, 'journal.jsonl')
    if (!existsSync(this.path)) {
      const fd = openSync(this.path, 'wx', 0o600)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const directory = openSync(state, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      return
    }
    const bytes = readFileSync(this.path)
    const end = bytes.lastIndexOf(10) + 1
    // A crash may leave a partial final record; it was never acknowledged and is dropped.
    if (end !== bytes.length) truncateSync(this.path, end)
    const records: JournalRecord[] = []
    let torn = 0
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
      const whole = parseRecord(line)
      const record = whole ?? afterTornPrefix(line)
      // Anything other than a torn prefix completed by the next append stays fatal.
      if (!record) throw new Error('JOURNAL_CORRUPT: a completed journal record is malformed')
      if (!whole) torn++
      records.push(record)
    }
    if (torn) this.replace(bytes, records, torn)
    for (const record of records) {
      this.records.push(record)
      this.apply(record)
    }
  }
  /** Keeps the damaged original beside the journal and atomically replaces it with the repair. */
  private replace(original: Buffer, records: JournalRecord[], torn: number) {
    const kept = `${this.path}.torn-${Date.now()}`
    writeFileSync(kept, original, { mode: 0o600, flag: 'wx' })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeAll(fd, Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join('')))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.path)
    const directory = openSync(this.state, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    process.stderr.write(`Journal: dropped ${torn} torn record prefix(es) left by a failed write; the original is kept as ${basename(kept)}\n`)
  }
  private key(turnId: string, generation: number) {
    return `${turnId}:${generation}`
  }
  append(kind: RecordKind, data: Record<string, unknown>) {
    const record = { kind, data }
    const fd = openSync(this.path, 'a', 0o600)
    try {
      const size = fstatSync(fd).size
      try {
        writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`))
        fsyncSync(fd)
      } catch (error) {
        // A failed or short write (for example a full disk) must not leave a torn record that the
        // next append would complete into a malformed line. The record was never acknowledged.
        try {
          ftruncateSync(fd, size)
          fsyncSync(fd)
        } catch {
          /* the loader still recognises a torn prefix */
        }
        throw error
      }
    } finally {
      closeSync(fd)
    }
    this.records.push(record)
    this.apply(record)
    if (statSync(this.path).size > 8 * 1024 * 1024) this.compact()
  }
  private apply({ kind, data }: JournalRecord) {
    if (kind === 'generation') this.generation = Number(data.generation)
    if (kind === 'provider.thread') this.threads.set(String(data.conversationId), String(data.providerThreadId))
    if (kind === 'turn.accepted') {
      const snapshot = data.snapshot as TurnSnapshot
      this.turns.set(this.key(snapshot.turnId, snapshot.generation), {
        turnId: snapshot.turnId,
        generation: snapshot.generation,
        conversationId: snapshot.conversationId,
        status: 'starting',
      })
    }
    if (kind === 'turn.status') {
      const key = this.key(String(data.turnId), Number(data.generation))
      const turn = this.turns.get(key)
      if (turn) this.turns.set(key, { ...turn, ...data } as JournalTurn)
    }
    if (kind === 'event.pending') {
      const event = guestEventSchema.parse(data.event)
      this.pending.set(event.runtimeEventId, event)
      // The durable status event is also a recovery record, closing the crash window
      // between outbox persistence and the dedicated turn.status append.
      if (event.kind === 'turn.status' && event.turnId && event.generation) {
        const key = this.key(event.turnId, event.generation)
        const turn = this.turns.get(key)
        const status = turnStatusSchema.safeParse(event.detail?.status)
        if (turn && status.success && !TURN_TERMINAL.has(turn.status)) {
          this.turns.set(key, { ...turn, ...event.detail, status: status.data } as JournalTurn)
        }
      }
    }
    if (kind === 'event.acked') this.pending.delete(String(data.runtimeEventId))
  }
  accept(snapshot: TurnSnapshot) {
    const bounded = (text: string) =>
      Buffer.byteLength(text) > 4096 ? { sha256: createHash('sha256').update(text).digest('hex') } : text
    this.append('turn.accepted', {
      snapshot: {
        ...snapshot,
        message: bounded(snapshot.message),
        recentMessages: snapshot.recentMessages.map((m) => ({ ...m, content: bounded(m.content) })),
      },
    })
  }
  status(turnId: string, generation: number, detail: Record<string, unknown>) {
    this.append('turn.status', { turnId, generation, ...detail })
  }
  reconcile(turnId: string, generation: number) {
    const turn = this.turns.get(this.key(turnId, generation))
    return turn
      ? {
          known: true,
          status: turn.status,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.providerTurnId,
        }
      : { known: false }
  }
  hasToolRequest(turnId: string, requestId: string) {
    return this.records.some(
      (record) =>
        record.kind === 'action.intent' && record.data.turnId === turnId && record.data.requestId === requestId
    )
  }
  allTurns() {
    return [...this.turns.values()]
  }
  lastGeneration() {
    return this.generation
  }
  nextGeneration() {
    const generation = this.generation + 1
    this.append('generation', { generation })
    return generation
  }
  thread(conversationId: string) {
    return this.threads.get(conversationId)
  }
  saveThread(conversationId: string, providerThreadId: string) {
    this.append('provider.thread', { conversationId, providerThreadId })
  }
  pendingEvents() {
    return [...this.pending.values()]
  }
  event(input: ProviderEvent) {
    const event = guestEventSchema.parse({
      ...input,
      type: 'event',
      runtimeEventId: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    encodeFrame(event)
    this.append('event.pending', { event })
    for (const listener of this.listeners) listener()
    return event
  }
  ack(runtimeEventId: string) {
    if (this.pending.has(runtimeEventId)) this.append('event.acked', { runtimeEventId })
  }
  onEvent(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  compact() {
    const retained = new Set([...this.turns.keys()].slice(-500))
    const records = this.records.filter((r) => {
      const d = r.kind === 'turn.accepted' ? (r.data.snapshot as Record<string, unknown>) : r.data
      return (
        ['turn.accepted', 'turn.status', 'action.intent', 'action.result'].includes(r.kind) &&
        retained.has(this.key(String(d.turnId), Number(d.generation)))
      )
    })
    records.push({ kind: 'generation', data: { generation: this.generation } })
    for (const [conversationId, providerThreadId] of this.threads)
      records.push({ kind: 'provider.thread', data: { conversationId, providerThreadId } })
    for (const event of this.pending.values()) records.push({ kind: 'event.pending', data: { event } })
    const temp = `${this.path}.compact`
    const fd = openSync(temp, 'w', 0o600)
    try {
      for (const record of records) writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.path)
    const directory = openSync(this.state, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    this.records = records
    for (const key of this.turns.keys()) if (!retained.has(key)) this.turns.delete(key)
  }
}
