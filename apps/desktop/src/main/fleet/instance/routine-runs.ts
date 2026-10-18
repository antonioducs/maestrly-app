import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { InstanceHelpStore } from './help'
import type { FleetImageStore } from './images'
import { LiveTranscript } from './live-transcript'
import { conversationQueue, type InstanceInputQueue } from './queue'
import { InstanceTranscriptExtras } from './transcript'

/** A run id names a folder of the bot's: the gateway's are UUIDs, and nothing else is accepted. */
export const runIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,80}$/)
export const isRunId = (value: string): boolean => runIdSchema.safeParse(value).success

const recordSchema = z.object({
  runId: runIdSchema,
  routineId: z.string().min(1).max(200),
  routineTitle: z.string().max(200),
  conversationId: z.uuid(),
  createdAt: z.iso.datetime(),
})
const fileSchema = z.object({ version: z.literal(1), runs: z.array(recordSchema) })

/** A routine run's own conversation, as the bot keeps it. */
export type RunRecord = z.infer<typeof recordSchema>

const threadRecordSchema = z.object({
  threadId: runIdSchema,
  peerBotId: z.string().min(1).max(64),
  peerName: z.string().max(200),
  title: z.string().max(200),
  /** `primary`: the bot opened it from its own conversation; `side`: from another side conversation; `peer`: the other bot did. */
  origin: z.enum(['primary', 'side', 'peer']),
  conversationId: z.uuid(),
  createdAt: z.iso.datetime(),
  /**
   * What this bot sent to open it from another conversation, and the owner's request there, for the thread's first
   * answer; null once given, or for a thread the other bot opened.
   */
  opening: z.object({ sent: z.string().max(4000), ask: z.string().max(2000).nullable() }).nullable(),
})
const threadsFileSchema = z.object({ version: z.literal(1), threads: z.array(threadRecordSchema) })

/** A conversation between this bot and another (`peer-conversations`), as the bot keeps its side of it. */
export type ThreadRecord = z.infer<typeof threadRecordSchema>

/**
 * A side conversation of a bot: a routine run's, or a thread's with another bot. Both are keyed by `runId`: the run's
 * id, or the thread's.
 */
export type LaneRecord = (RunRecord & { kind: 'routine' }) | (ThreadRecord & { kind: 'thread'; runId: string })

/** The id a side conversation is known by: its run's, or its thread's. */
export function laneIdOf(record: LaneRecord): string {
  return record.runId
}
const routineLane = (record: RunRecord): LaneRecord => ({ ...record, kind: 'routine' })
const threadLane = (record: ThreadRecord): LaneRecord => ({ ...record, kind: 'thread', runId: record.threadId })
function threadOf(record: Extract<LaneRecord, { kind: 'thread' }>): ThreadRecord {
  const { kind: _kind, runId: _runId, ...thread } = record
  return thread
}
function runOf(record: Extract<LaneRecord, { kind: 'routine' }>): RunRecord {
  const { kind: _kind, ...run } = record
  return run
}

/** Lanes of runs kept in memory at once; a lane in use is never put away. */
const LOADED_MAX = 16

/** One routine run's conversation, loaded: its transcript extras (interactions, notes) and its live transcript. */
export class RunLane {
  readonly extras: InstanceTranscriptExtras
  readonly help: InstanceHelpStore
  readonly live: LiveTranscript
  /** Undoes what the bot registered for this conversation to run turns in it; null while nothing is. */
  unregister: (() => void) | null = null
  constructor(
    readonly record: LaneRecord,
    options: RunConversationsOptions
  ) {
    const publish = (item: FleetTranscriptItem) => options.publish(record.runId, item)
    this.extras = new InstanceTranscriptExtras(path.join(options.folder, record.runId, 'transcript.json'), publish)
    this.help = new InstanceHelpStore(this.extras, options.changed)
    this.live = new LiveTranscript({
      conversationId: () => record.conversationId,
      queue: conversationQueue(options.queue, record.runId),
      extras: this.extras,
      images: options.images,
      publish,
      turnInputId: () => options.turnInputId(record.runId),
    })
  }
  get runId(): string {
    return this.record.runId
  }
  get conversationId(): string {
    return this.record.conversationId
  }
}

interface RunConversationsOptions {
  /** The list of the bot's run conversations. */
  file: string
  /** The list of the bot's thread conversations (`peer-conversations`); none without it. */
  threadsFile?: string
  /** Where each run keeps its transcript extras, in a folder named by its run id. */
  folder: string
  queue: InstanceInputQueue
  images: FleetImageStore
  publish: (runId: string, item: FleetTranscriptItem) => void
  /** The input the turn running in a run's conversation answers, if one runs there. */
  turnInputId: (runId: string) => string | null
  changed: () => void
}

/**
 * The routine runs of one bot that work in conversations of their own (`routine-conversations`): which conversation
 * each run has, kept in a file of the bot's, and the runs in use, loaded when one is read or runs a turn and put away,
 * the least recently used first, beyond `LOADED_MAX`.
 */
export class BotRunConversations {
  private records: LaneRecord[] = []
  private readonly byConversationId = new Map<string, LaneRecord>()
  private readonly lanes = new Map<string, RunLane>()
  private readonly loading = new Map<string, Promise<RunLane>>()
  private writeTail: Promise<void> = Promise.resolve()
  constructor(private readonly options: RunConversationsOptions) {}

  async load(): Promise<void> {
    const records = await readLaneFiles(this.options.file, this.options.threadsFile)
    this.records = records
    this.byConversationId.clear()
    for (const record of records) this.byConversationId.set(record.conversationId, record)
  }
  list(): readonly LaneRecord[] {
    return this.records
  }
  get(runId: string): LaneRecord | undefined {
    return this.records.find((record) => record.runId === runId)
  }
  /** A routine run's conversation, if the id names one. */
  routine(runId: string): Extract<LaneRecord, { kind: 'routine' }> | undefined {
    const record = this.get(runId)
    return record?.kind === 'routine' ? record : undefined
  }
  /** A thread's conversation with another bot, if the id names one. */
  thread(threadId: string): Extract<LaneRecord, { kind: 'thread' }> | undefined {
    const record = this.get(threadId)
    return record?.kind === 'thread' ? record : undefined
  }
  byConversation(conversationId: string | undefined): LaneRecord | undefined {
    return conversationId ? this.byConversationId.get(conversationId) : undefined
  }
  /** Resolves once every write started so far has finished. */
  async idle(): Promise<void> {
    await this.writeTail
    await Promise.all([...this.lanes.values()].map((lane) => lane.extras.idle()))
  }
  async add(record: RunRecord): Promise<void> {
    const valid = routineLane(recordSchema.parse(record))
    if (this.get(valid.runId)) throw new Error('This run already has a conversation.')
    this.records = [...this.records, valid]
    this.byConversationId.set(valid.conversationId, valid)
    await this.write('routine')
  }
  async addThread(record: ThreadRecord): Promise<void> {
    if (!this.options.threadsFile) throw new Error('This bot keeps no conversations with other bots.')
    const valid = threadLane(threadRecordSchema.parse(record))
    if (this.get(valid.runId)) throw new Error('This thread already has a conversation.')
    this.records = [...this.records, valid]
    this.byConversationId.set(valid.conversationId, valid)
    await this.write('thread')
  }
  /** Changes a thread's record, such as once its opening was given to its first answer. */
  async updateThread(record: ThreadRecord): Promise<void> {
    const valid = threadLane(threadRecordSchema.parse(record))
    if (!this.thread(valid.runId)) throw new Error('This thread has no conversation.')
    this.records = this.records.map((entry) => (entry.runId === valid.runId ? valid : entry))
    this.byConversationId.set(valid.conversationId, valid)
    await this.write('thread')
  }
  /** Forgets a run's conversation: its lane, its record and its transcript extras. */
  async remove(runId: string): Promise<void> {
    const record = this.get(runId)
    if (!record) return
    const lane = this.lanes.get(runId)
    if (lane) {
      lane.unregister?.()
      lane.unregister = null
      await lane.extras.idle().catch(() => undefined)
      this.lanes.delete(runId)
    }
    this.records = this.records.filter((entry) => entry.runId !== runId)
    this.byConversationId.delete(record.conversationId)
    await this.write(record.kind)
    await fs.rm(path.join(this.options.folder, runIdSchema.parse(runId)), { recursive: true, force: true })
  }
  /** The run's loaded lane, if it is loaded. */
  loaded(runId: string): RunLane | undefined {
    return this.lanes.get(runId)
  }
  /** The loaded lanes, the least recently used first. */
  loadedLanes(): RunLane[] {
    return [...this.lanes.values()]
  }
  /** The lane of a run that has a conversation, loaded if it was not; null for a run without one. */
  async lane(runId: string, keep: (lane: RunLane) => boolean = () => false): Promise<RunLane | null> {
    const record = this.get(runId)
    if (!record) return null
    const known = this.lanes.get(runId)
    if (known) {
      this.lanes.delete(runId)
      this.lanes.set(runId, known)
      return known
    }
    let pending = this.loading.get(runId)
    if (!pending) {
      pending = (async () => {
        const lane = new RunLane(record, this.options)
        await lane.extras.load()
        lane.live.anchor()
        return lane
      })()
      this.loading.set(runId, pending)
    }
    try {
      const lane = await pending
      // A run removed while it loaded stays removed.
      if (!this.get(runId)) return null
      if (!this.lanes.has(runId)) {
        this.lanes.set(runId, lane)
        this.putAway(keep)
      }
      return this.lanes.get(runId) ?? null
    } finally {
      this.loading.delete(runId)
    }
  }
  /** Puts away the least recently used lanes beyond the limit, but none that `keep` holds. */
  private putAway(keep: (lane: RunLane) => boolean): void {
    for (const lane of [...this.lanes.values()]) {
      if (this.lanes.size <= LOADED_MAX) return
      if (keep(lane)) continue
      lane.unregister?.()
      lane.unregister = null
      this.lanes.delete(lane.runId)
    }
  }
  /** Puts every lane away, as the bot's runtime stops. */
  unloadAll(): void {
    for (const lane of this.lanes.values()) {
      lane.unregister?.()
      lane.unregister = null
    }
    this.lanes.clear()
  }
  /** Writes the list of one kind of side conversation: the runs' file, or the threads'. */
  private write(kind: LaneRecord['kind']): Promise<void> {
    const contents = JSON.stringify(
      kind === 'routine'
        ? { version: 1, runs: this.records.flatMap((record) => (record.kind === 'routine' ? [runOf(record)] : [])) }
        : {
            version: 1,
            threads: this.records.flatMap((record) => (record.kind === 'thread' ? [threadOf(record)] : [])),
          }
    )
    const file = kind === 'routine' ? this.options.file : this.options.threadsFile
    if (!file) return Promise.resolve()
    const write = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temporary, contents, { mode: 0o600 })
        await fs.rename(temporary, file)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }
}

/** Reads a bot's side conversations from their lists: its routine runs', and its threads' with other bots. */
async function readLaneFiles(runsFile: string, threadsFile?: string): Promise<LaneRecord[]> {
  const read = async <T>(file: string, parse: (value: unknown) => T[]): Promise<T[]> => {
    try {
      return parse(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const runs = await read(runsFile, (value) => fileSchema.parse(value).runs)
  const threads = threadsFile ? await read(threadsFile, (value) => threadsFileSchema.parse(value).threads) : []
  return [...runs.map(routineLane), ...threads.map(threadLane)]
}

/** The conversations of a bot's side conversations, read without loading the bot: what a purge deletes. */
export async function readRunConversationIds(files: { runs: string; threads: string }): Promise<string[]> {
  return (await readRunRecords(files)).map((record) => record.conversationId)
}

/** A bot's side conversations (routine runs and threads), read without loading the bot: what a move carries. */
export function readRunRecords(files: { runs: string; threads: string }): Promise<LaneRecord[]> {
  return readLaneFiles(files.runs, files.threads)
}
