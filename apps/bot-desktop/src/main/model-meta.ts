import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseModelsDev } from '@maestrly/chat-ui/model-meta'
import type { ChatModelMeta } from '@maestrly/chat-ui/cost'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const CACHE_FILE = 'models-dev.json'

interface Snapshot {
  fetchedAt: number
  meta: Record<string, ChatModelMeta>
}

/**
 * The public models.dev catalogue (context windows and prices) for the context meter and the
 * cost estimate. It is convenience data: fetched at most once a day, kept on disk so an
 * offline start still has yesterday's numbers, and absent — never guessed — when nothing was
 * ever fetched. The Host is never involved; this is the application's own lookup.
 */
export class ModelMetaCatalogue {
  private memory: Snapshot | null = null
  private inflight: Promise<Record<string, ChatModelMeta>> | null = null
  constructor(
    private readonly directory: string,
    private readonly fetchJson: (url: string, signal: AbortSignal) => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}

  async current(): Promise<Record<string, ChatModelMeta>> {
    if (this.memory && this.now() - this.memory.fetchedAt < TTL_MS) return this.memory.meta
    if (this.inflight) return this.inflight
    this.inflight = this.refresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async refresh(): Promise<Record<string, ChatModelMeta>> {
    const disk = this.memory ?? (await this.readDisk())
    if (disk && this.now() - disk.fetchedAt < TTL_MS) {
      this.memory = disk
      return disk.meta
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let json: unknown
      try {
        json = await this.fetchJson(MODELS_DEV_URL, controller.signal)
      } finally {
        clearTimeout(timer)
      }
      const meta = parseModelsDev(json)
      if (!Object.keys(meta).length) throw new Error('models.dev returned no usable entries')
      this.memory = { fetchedAt: this.now(), meta }
      await writeFile(join(this.directory, CACHE_FILE), JSON.stringify(this.memory), { mode: 0o600 }).catch(() => {})
      return meta
    } catch {
      // Offline or broken: yesterday's numbers beat none, and none beats an invented figure.
      if (disk) {
        // Retry in a minute rather than on every call while the network is down.
        this.memory = { ...disk, fetchedAt: this.now() - TTL_MS + 60_000 }
        return disk.meta
      }
      this.memory = { fetchedAt: this.now() - TTL_MS + 60_000, meta: {} }
      return {}
    }
  }

  private async readDisk(): Promise<Snapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, CACHE_FILE), 'utf8')) as Snapshot
      if (typeof parsed?.fetchedAt !== 'number' || !parsed.meta || typeof parsed.meta !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }
}
