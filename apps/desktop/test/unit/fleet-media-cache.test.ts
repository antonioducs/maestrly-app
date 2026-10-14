import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { FleetMediaCache, type FleetMediaProgress } from '../../src/main/fleet/client/media-cache'

let root: string
let clock: number
const now = () => ++clock

function video(id: string, size: number, mediaType = 'video/mp4', name = `${id}.mp4`) {
  const bytes = Buffer.alloc(size, id.charCodeAt(id.length - 1))
  const ref: FleetFileRef = { id, name, mediaType, byteSize: size }
  return { ref, bytes }
}

function opener(file: { ref: FleetFileRef; bytes: Buffer }, body: Buffer = file.bytes) {
  return vi.fn(async () => ({ ref: file.ref, response: new Response(new Uint8Array(body)) }))
}

beforeEach(async () => {
  root = path.join(await mkdtemp(path.join(os.tmpdir(), 'fleet-media-cache-')), 'cache')
  clock = 1_700_000_000_000
})
afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true })
})

describe('fleet media cache', () => {
  it('downloads a video once for concurrent callers and serves later calls from disk', async () => {
    const progress: FleetMediaProgress[] = []
    const cache = new FleetMediaCache({ root: () => root, now, onProgress: (item) => progress.push(item) })
    const clip = video('f-clip', 4096)
    const open = opener(clip)
    const [first, second] = await Promise.all([
      cache.prepare('device', 'bot', 'f-clip', open),
      cache.prepare('device', 'bot', 'f-clip', open),
    ])
    expect(open).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
    expect(first).toMatchObject({ ref: clip.ref, mediaType: 'video/mp4' })
    expect(await readFile(first.path)).toEqual(clip.bytes)
    expect(progress.at(-1)).toEqual({ botId: 'bot', fileId: 'f-clip', received: 4096, total: 4096 })
    // A new instance, as after a restart, reads the sidecar instead of the gateway.
    const restarted = new FleetMediaCache({ root: () => root, now })
    const reopen = opener(clip)
    expect(await restarted.prepare('device', 'bot', 'f-clip', reopen)).toEqual(first)
    expect(reopen).not.toHaveBeenCalled()
    expect((await readdir(root)).sort()).toEqual(
      [path.basename(first.path), path.basename(first.path).replace('.media', '.json')].sort()
    )
  })

  it('keeps copies of different pairings and bots apart', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const clip = video('f-clip', 16)
    const one = await cache.prepare('device-a', 'bot', 'f-clip', opener(clip))
    const other = await cache.prepare('device-b', 'bot', 'f-clip', opener(clip))
    const third = await cache.prepare('device-a', 'other-bot', 'f-clip', opener(clip))
    expect(new Set([one.path, other.path, third.path]).size).toBe(3)
  })

  it('downloads again when the copy or its sidecar is damaged', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const clip = video('f-clip', 64)
    const entry = await cache.prepare('device', 'bot', 'f-clip', opener(clip))
    await writeFile(entry.path, Buffer.alloc(10))
    const afterTruncation = opener(clip)
    await cache.prepare('device', 'bot', 'f-clip', afterTruncation)
    expect(afterTruncation).toHaveBeenCalledTimes(1)
    expect(await readFile(entry.path)).toEqual(clip.bytes)
    await writeFile(entry.path.replace('.media', '.json'), '{not json')
    const afterCorruption = opener(clip)
    await cache.prepare('device', 'bot', 'f-clip', afterCorruption)
    expect(afterCorruption).toHaveBeenCalledTimes(1)
    expect(await readFile(entry.path)).toEqual(clip.bytes)
  })

  it('rejects a body of the wrong size without publishing anything', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const clip = video('f-clip', 64)
    await expect(cache.prepare('device', 'bot', 'f-clip', opener(clip, clip.bytes.subarray(0, 32)))).rejects.toThrow(
      'Incomplete file'
    )
    await expect(cache.prepare('device', 'bot', 'f-clip', opener(clip, Buffer.alloc(65)))).rejects.toThrow(
      'File too large'
    )
    expect(await readdir(root)).toEqual([])
  })

  it('caches only videos, accepting a video extension sent as octet-stream', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const pdf = video('f-doc', 8, 'application/pdf', 'doc.pdf')
    await expect(cache.prepare('device', 'bot', 'f-doc', opener(pdf))).rejects.toThrow('FLEET_MEDIA_UNSUPPORTED')
    const legacy = video('f-old', 8, 'application/octet-stream', 'clip.webm')
    expect(await cache.prepare('device', 'bot', 'f-old', opener(legacy))).toMatchObject({ mediaType: 'video/webm' })
    expect((await readdir(root)).filter((name) => name.endsWith('.media'))).toHaveLength(1)
  })

  it('evicts the least recently used videos beyond its limit, never the one just prepared', async () => {
    const cache = new FleetMediaCache({ root: () => root, now, maxBytes: 250 })
    const a = video('f-a', 100)
    const b = video('f-b', 100)
    const c = video('f-c', 100)
    const entryA = await cache.prepare('device', 'bot', 'f-a', opener(a))
    const entryB = await cache.prepare('device', 'bot', 'f-b', opener(b))
    // Watching A again makes B the least recently used.
    const reuse = opener(a)
    await cache.prepare('device', 'bot', 'f-a', reuse)
    expect(reuse).not.toHaveBeenCalled()
    const entryC = await cache.prepare('device', 'bot', 'f-c', opener(c))
    const left = await readdir(root)
    expect(left).toContain(path.basename(entryA.path))
    expect(left).toContain(path.basename(entryC.path))
    expect(left).not.toContain(path.basename(entryB.path))
    expect(left).not.toContain(path.basename(entryB.path).replace('.media', '.json'))
    const big = video('f-big', 300)
    const entryBig = await cache.prepare('device', 'bot', 'f-big', opener(big))
    expect(await readdir(root)).toEqual(
      [path.basename(entryBig.path), path.basename(entryBig.path).replace('.media', '.json')].sort()
    )
  })

  it('removes interrupted copies on the next sweep', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    await cache.prepare('device', 'bot', 'f-a', opener(video('f-a', 8)))
    const stale = `.${'0'.repeat(64)}.00000000-0000-4000-8000-000000000000.partial`
    const orphan = `${'1'.repeat(64)}.media`
    await writeFile(path.join(root, stale), 'partial')
    await writeFile(path.join(root, orphan), 'no sidecar')
    await cache.prepare('device', 'bot', 'f-b', opener(video('f-b', 8)))
    const names = await readdir(root)
    expect(names).not.toContain(stale)
    expect(names).not.toContain(orphan)
    expect(names.filter((name) => name.endsWith('.media'))).toHaveLength(2)
  })

  it("forgets a removed bot's videos and everything on clear", async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const kept = await cache.prepare('device', 'kept', 'f-a', opener(video('f-a', 8)))
    await cache.prepare('device', 'gone', 'f-b', opener(video('f-b', 8)))
    await cache.prepare('other-device', 'gone', 'f-c', opener(video('f-c', 8)))
    await cache.purgeBot('device', 'gone')
    expect((await readdir(root)).filter((name) => name.endsWith('.media')).sort()).toHaveLength(2)
    expect(await readdir(root)).toContain(path.basename(kept.path))
    await cache.clear()
    await expect(readdir(root)).rejects.toThrow()
  })

  it('stops a download when its signal aborts', async () => {
    const cache = new FleetMediaCache({ root: () => root, now })
    const clip = video('f-clip', 32)
    const controller = new AbortController()
    let pull = 0
    const open = vi.fn(async () => ({
      ref: clip.ref,
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            if (pull++ === 0) {
              stream.enqueue(new Uint8Array(clip.bytes.subarray(0, 16)))
              controller.abort()
            } else stream.enqueue(new Uint8Array(clip.bytes.subarray(16)))
          },
        })
      ),
    }))
    await expect(cache.prepare('device', 'bot', 'f-clip', open, controller.signal)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
  })
})
