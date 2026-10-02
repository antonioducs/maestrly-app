import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open, rename, realpath } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLEET_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import { FleetFileStore } from '../../src/main/fleet/instance/files'

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
    const unpaired = await store.publish(await source('second', 'data'), 'broken\uD800.txt')
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
      byteSize: FLEET_FILE_LIMITS.publishedTotalMaxBytes - files.reduce((sum, ref) => sum + ref.byteSize, 0),
    })
    await writeFile(path.join(folder, 'published/manifest.json'), JSON.stringify({ version: 1, files }))
    await store.load()
    await expect(store.publish(await source('one-byte', 'x'))).rejects.toThrow('quota')
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
    const ref = await store.publish(await source('a', 'a'), '../private/résumé\n.pdf')
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
    await expect(store.publish(input)).rejects.toThrow('quota')
  })
  it('serializes concurrent publishes and enforces count quota without eviction', async () => {
    const input = await source('empty', '')
    const refs = await Promise.all(
      Array.from({ length: FLEET_FILE_LIMITS.publishedCountMax }, () => store.publish(input))
    )
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(refs.length)
    await expect(store.publish(input)).rejects.toThrow('quota')
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
})
