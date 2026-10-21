import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  open,
  rename,
  realpath,
  utimes,
  lstat,
} from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLEET_FILE_LIMITS, FLEET_FILE_SETTINGS_DEFAULT, fleetFileQuotaBytes } from '@maestrly/bot-fleet-protocol'
import { FleetFileQuotaError, FleetFileSettingsError, FleetFileStore } from '../../src/main/fleet/instance/files'

let folder: string
let root: string
let store: FleetFileStore
async function source(name: string, bytes: string | Buffer) {
  const target = path.join(root, name)
  await writeFile(target, bytes)
  return { root, target }
}
async function bytes(id: string, current = store) {
  const result = await current.open(id)
  if (!result) throw new Error('Missing file')
  try {
    return await result.handle.readFile()
  } finally {
    await result.handle.close()
  }
}
beforeEach(async () => {
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-files-')))
  root = path.join(folder, 'source')
  await mkdir(root)
  store = new FleetFileStore(path.join(folder, 'published'))
  await store.load()
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

describe('private file snapshots', () => {
  it('never splits Unicode characters when shortening a source filename', async () => {
    const ref = await store.publish(await source('a'.repeat(199) + '😀', 'data'))
    expect(ref.name.length).toBeLessThanOrEqual(200)
    expect(() => encodeURIComponent(ref.name)).not.toThrow()
    expect(await bytes(ref.id)).toEqual(Buffer.from('data'))
    const unpaired = await store.publish(await source('second', 'data'), { name: 'broken\uD800.txt' })
    expect(() => encodeURIComponent(unpaired.name)).not.toThrow()
  })
  it('enforces the total byte quota from the persisted manifest', async () => {
    const files = Array.from({ length: 10 }, () => ({
      id: `f-${randomUUID()}`,
      name: 'retained.bin',
      mediaType: 'application/octet-stream',
      byteSize: FLEET_FILE_LIMITS.downloadMaxBytes,
    }))
    files.push({
      ...files[0]!,
      id: `f-${randomUUID()}`,
      byteSize:
        fleetFileQuotaBytes(FLEET_FILE_LIMITS.publishedQuotaGbDefault) -
        files.reduce((sum, ref) => sum + ref.byteSize, 0),
    })
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files }))
    await store.load()
    await expect(store.publish(await source('one-byte', 'x'))).rejects.toThrow(FleetFileQuotaError)
    expect(store.meta(files[0]!.id)).toEqual(files[0])
    // Empty files do not consume bytes, but still consume one count slot.
    expect((await store.publish(await source('empty', ''))).byteSize).toBe(0)
  })
  it('rejects replacement of the loaded store directory', async () => {
    const ref = await store.publish(await source('a', 'a'))
    await rename(path.join(folder, 'published'), path.join(folder, 'original'))
    await mkdir(path.join(folder, 'published'))
    await writeFile(path.join(folder, 'published', ref.id), 'a')
    await expect(store.open(ref.id)).rejects.toThrow('directory changed')
    await expect(store.publish(await source('b', 'b'))).rejects.toThrow('directory changed')
  })
  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    const target = path.join(root, 'pipe')
    execFileSync('mkfifo', [target])
    await expect(store.publish({ root, target })).rejects.toThrow('regular files')
  })

  it.each([
    ['report.pdf', Buffer.from('%PDF-1.7\nsynthetic'), 'application/pdf'],
    ['archive.zip', Buffer.from([80, 75, 3, 4, 0, 255]), 'application/zip'],
    ['empty.txt', Buffer.alloc(0), 'text/plain'],
    ['résumé 日本語.txt', Buffer.from('synthetic text'), 'text/plain'],
    ['data.unknown', Buffer.from('data'), 'application/octet-stream'],
    ['clip.mp4', Buffer.from('synthetic mp4'), 'video/mp4'],
    ['clip.M4V', Buffer.from('synthetic m4v'), 'video/mp4'],
    ['clip.webm', Buffer.from('synthetic webm'), 'video/webm'],
    ['clip.mov', Buffer.from('synthetic mov'), 'video/quicktime'],
    ['loop.gif', Buffer.from('GIF89a'), 'image/gif'],
  ])('roundtrips %s through restart', async (name, content, mediaType) => {
    const input = await source(name, content)
    const ref = await store.publish(input)
    expect(ref).toMatchObject({ name, mediaType, byteSize: content.length })
    expect(ref.id).toMatch(/^f-/)
    await writeFile(input.target, 'modified')
    const restored = new FleetFileStore(path.join(folder, 'published'))
    await restored.load()
    expect(await bytes(ref.id, restored)).toEqual(content)
    expect(Object.isFrozen(restored.meta(ref.id))).toBe(true)
  })
  it('sanitizes display names and scopes IDs to one store', async () => {
    const ref = await store.publish(await source('a', 'a'), { name: '../private/résumé\n.pdf' })
    expect(ref.name).toBe('résumé.pdf')
    const other = new FleetFileStore(path.join(folder, 'other'))
    await other.load()
    expect(other.meta(ref.id)).toBeNull()
    expect(await other.open(ref.id)).toBeNull()
    expect(await store.open('../source/a')).toBeNull()
  })
  it('rejects source symlinks, directory symlinks, traversal and directories', async () => {
    const input = await source('a', 'a')
    await symlink(input.target, path.join(root, 'link'))
    await symlink(root, path.join(root, 'directory-link'))
    for (const target of [
      path.join(root, 'link'),
      path.join(root, 'directory-link/a'),
      root,
      path.join(folder, 'outside'),
    ]) {
      await expect(store.publish({ root, target })).rejects.toThrow()
    }
  })
  it('rejects stored symlinks and mismatched lengths', async () => {
    const ref = await store.publish(await source('a', 'abc'))
    const target = path.join(folder, 'published', ref.id)
    await writeFile(target, 'shorter or longer')
    await expect(store.open(ref.id)).rejects.toThrow('size')
    await rm(target)
    await symlink(path.join(root, 'a'), target)
    await expect(store.open(ref.id)).rejects.toThrow()
  })
  it('rejects files larger than the download limit', async () => {
    const input = await source('large', '')
    const handle = await open(input.target, 'r+')
    await handle.truncate(FLEET_FILE_LIMITS.downloadMaxBytes + 1)
    await handle.close()
    await expect(store.publish(input)).rejects.toThrow(FleetFileQuotaError)
  })
  it('serializes concurrent publishes and enforces count quota without eviction', async () => {
    const input = await source('empty', '')
    const refs = await Promise.all(
      Array.from({ length: FLEET_FILE_LIMITS.publishedCountMax }, () => store.publish(input))
    )
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(refs.length)
    await expect(store.publish(input)).rejects.toThrow(FleetFileQuotaError)
    expect(await bytes(refs[0]!.id)).toEqual(Buffer.alloc(0))
    const manifest = JSON.parse(await readFile(path.join(folder, 'published/manifest.json'), 'utf8'))
    expect(manifest.files).toHaveLength(refs.length)
  }, 30_000)
  it('preserves metadata when manifest replacement fails and can retry', async () => {
    const input = await source('a', 'abc')
    const ref = await store.publish(input)
    const manifest = path.join(folder, 'published/manifest.json')
    await rename(manifest, `${manifest}.backup`)
    await mkdir(manifest)
    await expect(store.publish(input)).rejects.toThrow()
    expect(store.meta(ref.id)).toEqual(ref)
    expect(await bytes(ref.id)).toEqual(Buffer.from('abc'))
    await rm(manifest, { recursive: true })
    await rename(`${manifest}.backup`, manifest)
    await store.publish(input)
    expect(JSON.parse(await readFile(manifest, 'utf8')).files).toHaveLength(2)
  })
  it('rejects malformed manifests without losing loaded metadata', async () => {
    const ref = await store.publish(await source('a', 'a'))
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files: [ref, ref] }))
    await expect(store.load()).rejects.toThrow()
    expect(store.meta(ref.id)).toEqual(ref)
  })
  it('records where and when each file was shared and keeps it across restart', async () => {
    const origin = { kind: 'routine' as const, runId: 'r1', title: 'Daily' }
    await store.publish(await source('report.pdf', 'pdf'), { origin })
    expect(store.list()[0]).toMatchObject({ origin, sharedAt: expect.any(String) })
    const restored = new FleetFileStore(path.join(folder, 'published'))
    await restored.load()
    expect(restored.list()).toEqual(store.list())
    const manifest = JSON.parse(await readFile(path.join(folder, 'published/manifest.json'), 'utf8'))
    expect(manifest.version).toBe(2)
  })
  it('reads a version 1 manifest with unknown origins and the blob time', async () => {
    const ref = {
      id: `f-${randomUUID()}`,
      name: 'old.txt',
      mediaType: 'text/plain',
      byteSize: 3,
    }
    const blobPath = path.join(folder, 'published', ref.id)
    await writeFile(blobPath, 'abc')
    const time = new Date('2026-01-02T03:04:05Z')
    await utimes(blobPath, time, time)
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files: [ref] }))
    await store.load()
    expect(store.needsOrigins).toBe(true)
    expect(store.list()[0]?.origin).toEqual({ kind: 'unknown' })
    expect(store.list()[0]?.sharedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(store.settings()).toEqual(FLEET_FILE_SETTINGS_DEFAULT)
  })
  it('deletes files, forgets their bytes and remembers them', async () => {
    const a = await store.publish(await source('a.txt', 'aaa'))
    const b = await store.publish(await source('b.txt', 'bb'))
    const result = await store.remove([a.id, 'f-00000000-0000-4000-8000-000000000000'])
    expect(result).toEqual({ deleted: [a.id], freedBytes: a.byteSize })
    expect(await store.open(a.id)).toBeNull()
    await expect(lstat(path.join(folder, 'published', a.id))).rejects.toThrow()
    expect(store.removedFiles()).toEqual([{ id: a.id, removedAt: expect.any(String) }])
    expect(store.usage().updatedAt).not.toBeNull()
    const restored = new FleetFileStore(path.join(folder, 'published'))
    await restored.load()
    expect(restored.list().map((f) => f.id)).toEqual([b.id])
  })
  it('keeps every file when the manifest cannot be replaced during a delete', async () => {
    const a = await store.publish(await source('a.txt', 'aaa'))
    const manifest = path.join(folder, 'published/manifest.json')
    await rename(manifest, `${manifest}.backup`)
    await mkdir(manifest)
    await expect(store.remove([a.id])).rejects.toThrow()
    expect(store.list().map((f) => f.id)).toEqual([a.id])
    expect(await bytes(a.id)).toEqual(Buffer.from('aaa'))
  })
  it('sweeps blobs a crashed delete left behind', async () => {
    const a = await store.publish(await source('a.txt', 'aaa'))
    const orphan = path.join(folder, 'published', `f-${randomUUID()}`)
    const tmp = path.join(folder, 'published', '.manifest-keep.tmp')
    await writeFile(orphan, 'leftover')
    await writeFile(tmp, 'tmp')
    await store.load()
    await expect(lstat(orphan)).rejects.toThrow()
    expect((await lstat(path.join(folder, 'published/manifest.json'))).isFile()).toBe(true)
    expect((await lstat(tmp)).isFile()).toBe(true)
    expect(store.list().map((f) => f.id)).toEqual([a.id])
  })
  it('says which limit stopped a publication', async () => {
    const fullCount = Array.from({ length: FLEET_FILE_LIMITS.publishedCountMax }, () => ({
      id: `f-${randomUUID()}`,
      name: 'item.txt',
      mediaType: 'text/plain',
      byteSize: 1,
    }))
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files: fullCount }))
    await store.load()
    await expect(store.publish(await source('extra.txt', 'x'))).rejects.toMatchObject({
      reason: 'count',
    })

    const almostFull = Array.from({ length: 10 }, () => ({
      id: `f-${randomUUID()}`,
      name: 'chunk.bin',
      mediaType: 'application/octet-stream',
      byteSize: FLEET_FILE_LIMITS.downloadMaxBytes,
    }))
    const quota1Gb = fleetFileQuotaBytes(1)
    almostFull.push({
      id: `f-${randomUUID()}`,
      name: 'rest.bin',
      mediaType: 'application/octet-stream',
      byteSize: quota1Gb - almostFull.reduce((sum, f) => sum + f.byteSize, 0) - 1,
    })
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files: almostFull }))
    await store.load()
    const twoBytes = await source('two.bin', 'ab')
    await expect(store.publish(twoBytes)).rejects.toMatchObject({
      reason: 'space',
      fileBytes: 2,
      usage: expect.objectContaining({ quotaBytes: quota1Gb }),
    })

    await store.setSettings({ quotaGb: 2, deleteWithConversations: true })
    await expect(store.publish(twoBytes)).resolves.toMatchObject({ byteSize: 2 })

    const large = await source('oversize.bin', '')
    const handle = await open(large.target, 'r+')
    await handle.truncate(FLEET_FILE_LIMITS.downloadMaxBytes + 1)
    await handle.close()
    await expect(store.publish(large)).rejects.toMatchObject({
      reason: 'size',
    })
  })
  it('refuses a space smaller than what the files take', async () => {
    const files = Array.from({ length: 16 }, () => ({
      id: `f-${randomUUID()}`,
      name: 'chunk.bin',
      mediaType: 'application/octet-stream',
      byteSize: FLEET_FILE_LIMITS.downloadMaxBytes,
      sharedAt: '2026-10-01T00:00:00.000Z',
      origin: { kind: 'primary' as const },
    }))
    await writeFile(
      path.join(folder, 'published/manifest.json'),
      JSON.stringify({
        version: 2,
        settings: { quotaGb: 2, deleteWithConversations: true },
        originsKnown: true,
        updatedAt: null,
        files,
        removed: [],
      })
    )
    await store.load()
    await expect(store.setSettings({ quotaGb: 1, deleteWithConversations: true })).rejects.toThrow(
      FleetFileSettingsError
    )
    expect(store.settings().quotaGb).toBe(2)
  })
  it('lists the files of one side conversation', async () => {
    const r = await store.publish(await source('r.txt', 'r'), {
      origin: { kind: 'routine', runId: 'r1', title: 'R1' },
    })
    const t = await store.publish(await source('t.txt', 't'), {
      origin: { kind: 'thread', threadId: 't1', title: 'T1' },
    })
    await store.publish(await source('p.txt', 'p'), { origin: { kind: 'primary' } })
    expect(store.idsFrom('r1')).toEqual([r.id])
    expect(store.idsFrom('t1')).toEqual([t.id])
  })
  it('assigns origins once', async () => {
    const a = { id: `f-${randomUUID()}`, name: 'a.txt', mediaType: 'text/plain', byteSize: 1 }
    const b = { id: `f-${randomUUID()}`, name: 'b.txt', mediaType: 'text/plain', byteSize: 1 }
    await writeFile(path.join(folder, 'published', a.id), 'a')
    await writeFile(path.join(folder, 'published', b.id), 'b')
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files: [a, b] }))
    await store.load()
    expect(store.needsOrigins).toBe(true)
    await store.assignOrigins(new Map([[a.id, { origin: { kind: 'primary' }, sharedAt: '2026-10-01T00:00:00.000Z' }]]))
    expect(store.needsOrigins).toBe(false)
    expect(store.list().find((f) => f.id === a.id)).toMatchObject({
      origin: { kind: 'primary' },
      sharedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(store.list().find((f) => f.id === b.id)?.origin).toEqual({ kind: 'unknown' })
    const restored = new FleetFileStore(path.join(folder, 'published'))
    await restored.load()
    expect(restored.needsOrigins).toBe(false)
  })
  it('keeps the latest deletions only', async () => {
    const oldRemoved = Array.from({ length: FLEET_FILE_LIMITS.removedKeptMax }, () => ({
      id: `f-${randomUUID()}`,
      removedAt: '2026-09-01T00:00:00.000Z',
    }))
    const target = {
      id: `f-${randomUUID()}`,
      name: 'x.txt',
      mediaType: 'text/plain',
      byteSize: 1,
      sharedAt: '2026-10-01T00:00:00.000Z',
      origin: { kind: 'primary' as const },
    }
    await writeFile(path.join(folder, 'published', target.id), 'x')
    await writeFile(
      path.join(folder, 'published/manifest.json'),
      JSON.stringify({
        version: 2,
        settings: FLEET_FILE_SETTINGS_DEFAULT,
        originsKnown: true,
        updatedAt: null,
        files: [target],
        removed: oldRemoved,
      })
    )
    await store.load()
    await store.remove([target.id])
    expect(store.removedFiles()).toHaveLength(FLEET_FILE_LIMITS.removedKeptMax)
    expect(store.removedFiles()[0]?.id).toBe(oldRemoved[1]!.id)
    expect(store.removedFiles().at(-1)?.id).toBe(target.id)
  })
})
