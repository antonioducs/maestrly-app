import type { FleetImageData } from '../../../preload/api-fleet'

type Entry = { url: string; bytes: number; users: number }

/**
 * Object URLs for bot images, shared by every view for the app's lifetime. Nothing disposes it on unmount: a cache
 * owned by a component broke every image when React remounted the conversation (StrictMode, or returning to a bot).
 * Images nobody displays are evicted, oldest first, beyond `capacity` entries or `maxBytes`; displayed ones never are.
 */
export function createFleetImageCache(
  load: (botId: string, imageId: string) => Promise<FleetImageData>,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
  capacity = 64,
  maxBytes = 96 * 1024 * 1024
) {
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Promise<string>>()
  // Holds requested while an image loads, counted on arrival so no eviction can slip in between.
  const waiting = new Map<string, number>()
  const keyFor = (botId: string, imageId: string) => `${botId}:${imageId}`
  const evict = () => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [key, entry] of entries) {
      if (entries.size <= capacity && bytes <= maxBytes) break
      if (entry.users > 0) continue
      urls.revokeObjectURL(entry.url)
      entries.delete(key)
      bytes -= entry.bytes
    }
  }
  return {
    /** Resolves to the image's URL and holds it until the matching `release`. */
    acquire(botId: string, imageId: string): Promise<string> {
      const key = keyFor(botId, imageId)
      const hit = entries.get(key)
      if (hit) {
        entries.delete(key)
        entries.set(key, hit)
        hit.users++
        return Promise.resolve(hit.url)
      }
      waiting.set(key, (waiting.get(key) ?? 0) + 1)
      let task = pending.get(key)
      if (!task) {
        task = load(botId, imageId)
          .then((image) => {
            const url = urls.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mediaType }))
            entries.set(key, { url, bytes: image.data.byteLength, users: waiting.get(key) ?? 0 })
            evict()
            return url
          })
          .finally(() => {
            pending.delete(key)
            waiting.delete(key)
          })
        pending.set(key, task)
      }
      return task
    },
    release(botId: string, imageId: string) {
      const entry = entries.get(keyFor(botId, imageId))
      if (entry) entry.users = Math.max(0, entry.users - 1)
      evict()
    },
  }
}
export type FleetImageCache = ReturnType<typeof createFleetImageCache>

export const fleetImageCache: FleetImageCache = createFleetImageCache((botId, imageId) =>
  window.api.fleetGetImage(botId, imageId)
)

/**
 * Effect body for a component showing one image. Returns the cleanup; it releases the hold exactly once, also when
 * the component unmounts before the image arrives.
 */
export function holdFleetImage(
  cache: FleetImageCache,
  botId: string,
  imageId: string,
  onReady: (url: string) => void,
  onError: (cause: unknown) => void
): () => void {
  let active = true
  let held = false
  cache.acquire(botId, imageId).then(
    (url) => {
      if (!active) {
        cache.release(botId, imageId)
        return
      }
      held = true
      onReady(url)
    },
    (cause: unknown) => {
      if (active) onError(cause)
    }
  )
  return () => {
    active = false
    if (held) {
      held = false
      cache.release(botId, imageId)
    }
  }
}
