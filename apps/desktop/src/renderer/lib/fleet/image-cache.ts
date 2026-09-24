import type { FleetImageData } from '../../../preload/api-fleet'

type Entry = { url: string; users: number }
export function createFleetImageCache(
  load: (botId: string, imageId: string) => Promise<FleetImageData>,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
  capacity = 64
) {
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Promise<string>>()
  let disposed = false
  const keyFor = (botId: string, imageId: string) => `${botId}:${imageId}`
  const evict = (limit = capacity) => {
    while (entries.size > limit) {
      const key = [...entries].find(([, entry]) => entry.users === 0)?.[0]
      if (!key) break
      urls.revokeObjectURL(entries.get(key)!.url)
      entries.delete(key)
    }
  }
  return {
    async get(botId: string, imageId: string): Promise<string> {
      const key = keyFor(botId, imageId)
      const hit = entries.get(key)
      if (hit) {
        entries.delete(key)
        entries.set(key, hit)
        return hit.url
      }
      if (disposed) throw new Error('Image cache disposed')
      let task = pending.get(key)
      if (!task) {
        task = load(botId, imageId)
          .then((image) => {
            if (disposed) throw new Error('Image cache disposed')
            evict(capacity - 1)
            const url = urls.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mediaType }))
            entries.set(key, { url, users: 0 })
            return url
          })
          .finally(() => pending.delete(key))
        pending.set(key, task)
      }
      return task
    },
    retain(botId: string, imageId: string) {
      const entry = entries.get(keyFor(botId, imageId))
      if (entry) entry.users++
    },
    release(botId: string, imageId: string) {
      const entry = entries.get(keyFor(botId, imageId))
      if (entry) entry.users = Math.max(0, entry.users - 1)
      evict()
    },
    dispose() {
      disposed = true
      for (const entry of entries.values()) urls.revokeObjectURL(entry.url)
      entries.clear()
    },
  }
}
export type FleetImageCache = ReturnType<typeof createFleetImageCache>
