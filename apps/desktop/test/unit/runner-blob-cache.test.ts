import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { BlobCache } from '../../src/main/runner/blob-cache'
import { RunnerStorage } from '../../src/main/runner/storage'
import { cleanTempDirs, sha256Hex, tempDir, zstdTar } from '../helpers/runner-core'

afterEach(cleanTempDirs)

const blob = (text: string) => ({ digest: sha256Hex(text), content: Buffer.from(text) })
const expecting = (...blobs: Array<{ digest: string; content: Buffer }>) =>
  new Map(blobs.map((item) => [item.digest, item.content.length]))
const stream = (bytes: Buffer) => Readable.from([bytes])

describe('runner blob cache', () => {
  it('keeps the blobs whose digest and size are the ones asked for', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    const [one, two] = [blob('first file'), blob('second file')]
    const archive = await zstdTar([one, two].map((item) => ({ name: item.digest, content: item.content })))
    const result = await cache.ingest(stream(archive), expecting(one, two))
    expect(result).toEqual({ added: [one.digest, two.digest], mismatched: [] })
    expect(cache.has(one.digest)).toBe(true)
    expect(readFileSync(cache.path(two.digest), 'utf8')).toBe('second file')
    expect(cache.path(one.digest)).toBe(path.join(cache.dir, one.digest.slice(0, 2), one.digest))
    expect(readdirSync(path.join(cache.dir, '.tmp'))).toEqual([])
  })

  it('discards entries with a wrong digest or size, repeats and strangers, and reports them', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    const [good, forged, shortSized, repeated] = [blob('good'), blob('forged'), blob('sized'), blob('repeated')]
    const archive = await zstdTar([
      { name: forged.digest, content: 'not what the digest names' },
      { name: good.digest, content: good.content },
      { name: shortSized.digest, content: shortSized.content.subarray(0, 2) },
      { name: repeated.digest, content: repeated.content },
      { name: repeated.digest, content: repeated.content },
      { name: sha256Hex('stranger'), content: 'stranger' },
      { name: '../escape', content: 'x' },
      { name: 'folder', type: 'directory' },
    ])
    const result = await cache.ingest(stream(archive), expecting(good, forged, shortSized, repeated))
    expect(result.added.sort()).toEqual([good.digest, repeated.digest].sort())
    expect(result.mismatched.sort()).toEqual(
      [forged.digest, shortSized.digest, repeated.digest, sha256Hex('stranger'), '../escape', 'folder'].sort()
    )
    expect(cache.has(forged.digest)).toBe(false)
    expect(cache.has(shortSized.digest)).toBe(false)
    expect(readdirSync(path.join(cache.dir, '.tmp'))).toEqual([])
  })

  it('throws on a truncated stream and keeps what arrived whole before it', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    // Random bytes do not compress, so the cut lands inside the second entry's data.
    const [first, second] = [randomBytes(1000), randomBytes(300_000)].map((content) => ({
      digest: sha256Hex(content),
      content,
    }))
    const archive = await zstdTar([first, second].map((item) => ({ name: item.digest, content: item.content })))
    await expect(
      cache.ingest(stream(archive.subarray(0, archive.length - 100_000)), expecting(first, second))
    ).rejects.toThrow()
    expect(cache.has(first.digest)).toBe(true)
    expect(cache.has(second.digest)).toBe(false)
    expect(readdirSync(path.join(cache.dir, '.tmp'))).toEqual([])
  })

  it('refuses to be asked for something that is not a digest', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    expect(() => cache.path('../../etc/passwd')).toThrow()
    await expect(cache.ingest(stream(Buffer.alloc(0)), new Map([['nope', 1]]))).rejects.toThrow()
  })

  it('lists the digests it lacks, each once and in order', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    const [have, lack, other] = [blob('have'), blob('lack'), blob('other')]
    await cache.ingest(stream(await zstdTar([{ name: have.digest, content: have.content }])), expecting(have))
    expect(cache.missing([lack.digest, have.digest, other.digest, lack.digest])).toEqual([lack.digest, other.digest])
  })

  it('evicts the least recently used blobs of every scope first, sparing the ones to keep', async () => {
    const root = tempDir()
    const a = new BlobCache(root, 'scope-a')
    const b = new BlobCache(root, 'scope-b')
    const items = ['one', 'two', 'three', 'four'].map((name) => blob(name.padEnd(300, name)))
    const [one, two, three, four] = items
    for (const [cache, item] of [
      [a, one],
      [b, two],
      [a, three],
      [b, four],
    ] as const)
      await cache.ingest(stream(await zstdTar([{ name: item.digest, content: item.content }])), expecting(item))
    // Age them: one is the oldest, then two, three, four.
    const age = (cache: BlobCache, item: { digest: string }, seconds: number) =>
      utimesSync(cache.path(item.digest), new Date(1_000_000 + seconds * 1000), new Date(1_000_000 + seconds * 1000))
    age(a, one, 1)
    age(b, two, 2)
    age(a, three, 3)
    age(b, four, 4)
    expect(await a.bytes()).toBe(1200)

    // Room for two: one and two go.
    expect(await a.evict(600, new Set())).toBe(600)
    expect([one, two, three, four].map((item) => a.has(item.digest) || b.has(item.digest))).toEqual([
      false,
      false,
      true,
      true,
    ])
    expect(await a.bytes()).toBe(600)

    // Touching `three` makes `four` the oldest; keeping `four` forces `three` out instead.
    await a.touch([three.digest])
    expect(await a.evict(300, new Set([four.digest]))).toBe(300)
    expect(a.has(three.digest)).toBe(false)
    expect(b.has(four.digest)).toBe(true)
    // Under the cap nothing is removed.
    expect(await a.evict(10_000, new Set())).toBe(0)
  })

  it('touch ignores blobs it does not hold and moves the others to now', async () => {
    const cache = new BlobCache(tempDir(), 'scope-a')
    const item = blob('touched')
    await cache.ingest(stream(await zstdTar([{ name: item.digest, content: item.content }])), expecting(item))
    utimesSync(cache.path(item.digest), new Date(1_000), new Date(1_000))
    await cache.touch([item.digest, sha256Hex('absent')])
    expect(statSync(cache.path(item.digest)).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('clears the half-written files an interrupted ingest left', async () => {
    const root = tempDir()
    const cache = new BlobCache(root, 'scope-a')
    const item = blob('kept')
    await cache.ingest(stream(await zstdTar([{ name: item.digest, content: item.content }])), expecting(item))
    expect(existsSync(path.join(cache.dir, '.tmp'))).toBe(true)
    await BlobCache.sweepTemporary(root)
    expect(existsSync(path.join(cache.dir, '.tmp'))).toBe(false)
    expect(cache.has(item.digest)).toBe(true)
  })
})

describe('runner storage', () => {
  it('keys a bot by server and bot, and lays folders out under one root', () => {
    const storage = new RunnerStorage('/data/runner')
    const scope = storage.scope('server-1', 'bot_1')
    expect(scope).toMatch(/^[a-f0-9]{32}$/)
    expect(storage.scope('server-1', 'bot_2')).not.toBe(scope)
    expect(storage.scope('server-2', 'bot_1')).not.toBe(scope)
    expect(storage.blobsDir(scope)).toBe(path.join('/data/runner', 'blobs', scope))
    expect(storage.cacheDir(scope, 'npm')).toBe(path.join('/data/runner', 'caches', scope, 'npm'))
    const key = storage.jobKey('server-1', 'job_AAAAAAAAAAAAAAAA0001')
    expect(storage.workDir(key)).toBe(path.join('/data/runner', 'jobs', key, 'work'))
    expect(storage.logFile(key)).toBe(path.join('/data/runner', 'jobs', key, 'job.log'))
    expect(storage.outputsFile(key)).toBe(path.join('/data/runner', 'jobs', key, 'outputs.tar.zst'))
    expect(storage.stateFile()).toBe(path.join('/data/runner', 'state.json'))
    expect(() => storage.cacheDir(scope, '../x')).toThrow()
    expect(() => storage.blobsDir('../x')).toThrow()
    expect(() => storage.jobKey('server-1', '../job')).toThrow()
  })

  it('measures blobs and caches per bot, clears caches alone, and forgets a bot whole', async () => {
    const root = tempDir()
    const storage = new RunnerStorage(root)
    const keep = await storage.remember('server-1', 'bot_1')
    const other = await storage.remember('server-1', 'bot_2')
    const item = blob('x'.repeat(500))
    await new BlobCache(storage.blobsRoot(), keep).ingest(
      stream(await zstdTar([{ name: item.digest, content: item.content }])),
      expecting(item)
    )
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(storage.cacheDir(keep, 'npm'), { recursive: true })
    writeFileSync(path.join(storage.cacheDir(keep, 'npm'), 'pkg'), 'y'.repeat(300))
    mkdirSync(storage.cacheDir(other, 'models'), { recursive: true })
    writeFileSync(path.join(storage.cacheDir(other, 'models'), 'w'), 'z'.repeat(40))

    const usage = await storage.usage()
    expect(usage.blobBytes).toBe(500)
    expect(usage.cacheBytes).toBe(340)
    const first = usage.scopes.find((scope) => scope.scope === keep)
    expect(first).toMatchObject({ serverId: 'server-1', botId: 'bot_1', blobBytes: 500, cacheBytes: 300 })
    expect(first?.caches).toEqual([{ name: 'npm', bytes: 300 }])

    await storage.clearCaches(keep)
    expect((await storage.usage()).cacheBytes).toBe(40)
    await storage.clearCaches()
    expect((await storage.usage()).cacheBytes).toBe(0)
    expect((await storage.usage()).blobBytes).toBe(500)

    await storage.clearScope(keep)
    const after = await storage.usage()
    expect(after.blobBytes).toBe(0)
    expect(after.scopes.map((scope) => scope.scope)).toEqual([other])
  })

  it('writes its state whole', async () => {
    const storage = new RunnerStorage(tempDir())
    expect(await storage.readState()).toBeNull()
    await storage.writeState({ jobs: [{ jobId: 'job_x' }] })
    expect(await storage.readState()).toEqual({ jobs: [{ jobId: 'job_x' }] })
  })
})
