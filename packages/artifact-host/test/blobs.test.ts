import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactHostError } from '../src/errors.js'
import { BlobStore } from '../src/store/blobs.js'
import { tempDir, text, utf8 } from './helpers.js'

let dir: string
let cleanup: () => void

beforeEach(() => {
  ;({ dir, cleanup } = tempDir())
})
afterEach(() => cleanup())

describe('BlobStore', () => {
  it('stores content under its SHA-256', async () => {
    const blobs = new BlobStore(dir)
    const sha = await blobs.put(utf8('hello'))
    expect(sha).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(existsSync(path.join(dir, '2c', sha))).toBe(true)
    expect(text(await blobs.read(sha))).toBe('hello')
    expect(blobs.has(sha)).toBe(true)
  })

  it('deduplicates identical content', async () => {
    const blobs = new BlobStore(dir)
    await blobs.put(utf8('hello'))
    const before = blobs.totalBytes()
    await Promise.all([blobs.put(utf8('hello')), blobs.put(utf8('hello'))])
    expect(blobs.totalBytes()).toBe(before)
    expect(blobs.listAll()).toHaveLength(1)
  })

  it('returns null for missing content and rejects malformed hashes', async () => {
    const blobs = new BlobStore(dir)
    expect(await blobs.read('a'.repeat(64))).toBeNull()
    expect(() => blobs.pathFor('../x')).toThrow(ArtifactHostError)
    try {
      blobs.pathFor('../x')
    } catch (error) {
      expect((error as ArtifactHostError).code).toBe('storage')
    }
  })

  it('tracks the total size across removal and restarts', async () => {
    const blobs = new BlobStore(dir)
    const a = await blobs.put(utf8('aaaa'))
    await blobs.put(utf8('bb'))
    expect(blobs.totalBytes()).toBe(6)
    await blobs.remove(a)
    expect(blobs.totalBytes()).toBe(2)
    expect(new BlobStore(dir).totalBytes()).toBe(2)
  })

  it('clears temporary files and never lists them', async () => {
    const blobs = new BlobStore(dir)
    await blobs.put(utf8('kept'))
    writeFileSync(path.join(dir, 'tmp', 'partial'), 'x')
    expect(blobs.listAll()).toHaveLength(1)
    blobs.clearTemp()
    expect(readdirSync(path.join(dir, 'tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('writes owner-only files', async () => {
    const blobs = new BlobStore(dir)
    const sha = await blobs.put(utf8('private'))
    expect(statSync(blobs.pathFor(sha)).mode & 0o777).toBe(0o600)
  })
})
