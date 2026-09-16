import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BOT_SECRET_METHODS, type BotMethod, type TeamMethod } from '@maestrly/host-protocol'

/** Methods whose durable key the Host can be asked about after a lost reply. */
export type JournaledMethod = BotMethod | TeamMethod
export type BotJournalEntry = {
  hostId: string
  method: JournaledMethod
  key: string
  /** Minimal, secret-free reference to what was sent (botId/clientMessageId/operationId). */
  reference: Record<string, string>
  receipt?: { id: string; kind: 'turn' | 'operation' | 'interaction' | 'memory' | 'transfer' | 'policy' }
  createdAt: string
}
/** Mutation keys that the Host can look up after a lost reply. Secret-bearing methods are never journaled. */
export const journaled: Partial<Record<JournaledMethod, (params: Record<string, unknown>) => { key: string; reference: Record<string, string> } | undefined>> = {
  // Team mutations use the team namespace explicitly: bot.operation.lookup cannot answer
  // for them, so their keys are prefixed and resolved by team.operation.lookup.
  'team.messages.send': (p) => ({ key: `team:${p.teamId}:${p.clientMessageId}`, reference: { teamId: String(p.teamId), clientMessageId: String(p.clientMessageId) } }),
  'team.create': (p) => ({ key: String(p.idempotencyKey), reference: { idempotencyKey: String(p.idempotencyKey) } }),
  'team.archive': (p) => ({ key: String(p.idempotencyKey), reference: { teamId: String(p.teamId), idempotencyKey: String(p.idempotencyKey) } }),
  'team.members.set': (p) => ({ key: String(p.idempotencyKey), reference: { teamId: String(p.teamId), idempotencyKey: String(p.idempotencyKey) } }),
  'team.run.cancel': (p) => ({ key: String(p.idempotencyKey), reference: { runId: String(p.runId), idempotencyKey: String(p.idempotencyKey) } }),
  'team.artifacts.share': (p) => ({ key: String(p.idempotencyKey), reference: { teamId: String(p.teamId), idempotencyKey: String(p.idempotencyKey) } }),
  'team.artifacts.revoke': (p) => ({ key: String(p.idempotencyKey), reference: { teamId: String(p.teamId), idempotencyKey: String(p.idempotencyKey) } }),
  'environment.create': p => ({ key: String(p.idempotencyKey), reference: { idempotencyKey: String(p.idempotencyKey) } }),
  'environment.prepare': p => ({ key: String(p.idempotencyKey), reference: { idempotencyKey: String(p.idempotencyKey) } }),
  'bot.messages.send': (p) => ({ key: `${p.botId}:${p.clientMessageId}`, reference: { botId: String(p.botId), clientMessageId: String(p.clientMessageId) } }),
  'bot.setup.start': (p) => ({ key: String(p.idempotencyKey), reference: { idempotencyKey: String(p.idempotencyKey) } }),
  'bot.archive': (p) => ({ key: String(p.idempotencyKey), reference: { botId: String(p.botId), idempotencyKey: String(p.idempotencyKey) } }),
  'bot.network.update': (p) => ({ key: String(p.idempotencyKey), reference: { botId: String(p.botId), idempotencyKey: String(p.idempotencyKey) } }),
  'bot.runtime.prepare': (p) => ({ key: String(p.idempotencyKey), reference: { botId: String(p.botId), idempotencyKey: String(p.idempotencyKey) } }),
  'bot.create': (p) => ({ key: String(p.idempotencyKey), reference: { idempotencyKey: String(p.idempotencyKey) } }),
}
export class BotJournal {
  private entries: BotJournalEntry[] = []
  private loaded = false
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (Array.isArray(data))
        this.entries = data.filter(
          (e): e is BotJournalEntry =>
            !!e && typeof e === 'object' && typeof e.hostId === 'string' && typeof e.method === 'string' && typeof e.key === 'string' && !BOT_SECRET_METHODS.includes(e.method as BotMethod)
        )
    } catch {
      this.entries = []
    }
  }
  /** Records the durable key before the wire write. Returns undefined for methods that are not journaled. */
  async begin(hostId: string, method: JournaledMethod, params: Record<string, unknown>): Promise<BotJournalEntry | undefined> {
    if (BOT_SECRET_METHODS.includes(method as BotMethod)) return undefined
    const derive = journaled[method]?.(params)
    if (!derive) return undefined
    await this.load()
    const existing = this.entries.find((e) => e.hostId === hostId && e.method === method && e.key === derive.key)
    if (existing) return existing
    const entry: BotJournalEntry = { hostId, method, key: derive.key, reference: derive.reference, createdAt: new Date().toISOString() }
    this.entries.push(entry)
    await this.save()
    return entry
  }
  async receipt(entry: BotJournalEntry, receipt: BotJournalEntry['receipt']) {
    entry.receipt = receipt
    await this.save()
  }
  async forget(entry: BotJournalEntry) {
    this.entries = this.entries.filter((e) => e !== entry)
    await this.save()
  }
  /** Entries without a receipt: the reply was lost and the Host must be asked before any resend. */
  async unresolved(hostId: string): Promise<BotJournalEntry[]> {
    await this.load()
    return this.entries.filter((e) => e.hostId === hostId && !e.receipt)
  }
  async resolvedCount(hostId: string) {
    await this.load()
    return this.entries.filter((e) => e.hostId === hostId && e.receipt).length
  }
  async prune(keep = 500) {
    await this.load()
    const resolved = this.entries.filter((e) => e.receipt)
    if (resolved.length > keep) {
      const drop = new Set(resolved.slice(0, resolved.length - keep))
      this.entries = this.entries.filter((e) => !drop.has(e))
      await this.save()
    }
  }
  private save() {
    const snapshot = JSON.stringify(this.entries)
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      const handle = await open(temp, 'w', 0o600)
      try {
        await handle.writeFile(snapshot)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, this.file)
    })
    this.writes = write.catch(() => {})
    return write
  }
}
