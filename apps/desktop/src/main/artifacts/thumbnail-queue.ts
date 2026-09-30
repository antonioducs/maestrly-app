/** A failed capture is tried again only after this long, so a page that never loads is not rendered over and over. */
export const THUMBNAIL_RETRY_MS = 10 * 60_000

export interface ThumbnailQueueDeps {
  /** The owner view of one version, with a fresh single-use ticket. */
  sourceUrl: (id: string, version: number) => Promise<string>
  capture: (url: string) => Promise<Uint8Array>
  save: (id: string, version: number, image: Uint8Array) => Promise<void>
  onError?: (error: unknown) => void
  now?: () => number
}

/**
 * Captures preview images one at a time: rendering a page is heavy, and only the newest version of an artifact is
 * worth a thumbnail, so a newer request replaces an older one still waiting.
 */
export class ThumbnailQueue {
  private pending: { id: string; version: number }[] = []
  private readonly done = new Set<string>()
  private readonly failedAt = new Map<string, number>()
  private active: string | null = null
  private running: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: ThumbnailQueueDeps) {}

  request(id: string, version: number): void {
    const key = `${id}:${version}`
    if (this.disposed || this.done.has(key) || this.active === key) return
    const failed = this.failedAt.get(key)
    if (failed !== undefined && this.now() - failed < THUMBNAIL_RETRY_MS) return
    if (this.pending.some((item) => item.id === id && item.version >= version)) return
    this.pending = this.pending.filter((item) => item.id !== id)
    this.pending.push({ id, version })
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
  }

  /** Resolves once nothing is waiting or being captured. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async run(): Promise<void> {
    // Starts after the caller returns, so `running` is set before the loop can finish.
    await null
    while (!this.disposed && this.pending.length > 0) {
      const next = this.pending.shift()!
      const key = `${next.id}:${next.version}`
      this.active = key
      try {
        const image = await this.deps.capture(await this.deps.sourceUrl(next.id, next.version))
        if (this.disposed) break
        await this.deps.save(next.id, next.version, image)
        this.done.add(key)
        this.failedAt.delete(key)
      } catch (error) {
        this.failedAt.set(key, this.now())
        this.deps.onError?.(error)
      } finally {
        this.active = null
      }
    }
  }
}
