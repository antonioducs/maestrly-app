import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FleetRunnerManifest } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleJobFolder } from '../../src/main/runner/assemble'
import { BlobCache } from '../../src/main/runner/blob-cache'
import { RunnerJobError } from '../../src/main/runner/errors'
import { cleanTempDirs, JOB_ID, sha256Hex, tempDir, zstdTar } from '../helpers/runner-core'

afterEach(cleanTempDirs)
const posix = process.platform === 'win32' ? it.skip : it

async function cacheWith(
  contents: Record<string, string>
): Promise<{ cache: BlobCache; digest: (name: string) => string }> {
  const cache = new BlobCache(tempDir(), 'scope')
  const blobs = Object.entries(contents).map(([name, content]) => ({ name, content, digest: sha256Hex(content) }))
  await cache.ingest(
    Readable.from([await zstdTar(blobs.map((blob) => ({ name: blob.digest, content: blob.content })))]),
    new Map(blobs.map((blob) => [blob.digest, Buffer.byteLength(blob.content)]))
  )
  return { cache, digest: (name) => sha256Hex(contents[name]!) }
}

const manifestOf = (entries: unknown[]): FleetRunnerManifest => ({
  jobId: JOB_ID,
  entries: entries as FleetRunnerManifest['entries'],
  bytes: 0,
  skipped: 0,
})

describe('assembling a job folder', () => {
  posix('builds folders, files with their modes, and links', async () => {
    const { cache, digest } = await cacheWith({ tool: '#!/bin/sh\necho hi\n', notes: 'read only', data: 'payload' })
    const work = path.join(tempDir(), 'work')
    await assembleJobFolder(
      manifestOf([
        { kind: 'directory', path: 'bin', mode: 0o755 },
        { kind: 'file', path: 'bin/tool', mode: 0o755, size: 18, sha256: digest('tool') },
        { kind: 'directory', path: 'locked', mode: 0o555 },
        { kind: 'file', path: 'locked/notes.txt', mode: 0o444, size: 9, sha256: digest('notes') },
        { kind: 'file', path: 'data.bin', mode: 0o640, size: 7, sha256: digest('data') },
        { kind: 'file', path: 'copy.bin', mode: 0o600, size: 7, sha256: digest('data') },
        { kind: 'symlink', path: 'bin/latest', target: 'tool' },
        { kind: 'symlink', path: 'bin/up', target: '../data.bin' },
      ]),
      cache,
      work
    )
    expect(readFileSync(path.join(work, 'bin/tool'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(statSync(path.join(work, 'bin/tool')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(work, 'locked/notes.txt')).mode & 0o777).toBe(0o444)
    expect(statSync(path.join(work, 'data.bin')).mode & 0o777).toBe(0o640)
    expect(readFileSync(path.join(work, 'copy.bin'), 'utf8')).toBe('payload')
    // A folder keeps its mode, except that its owner always keeps full access so the folder can be removed.
    expect(statSync(path.join(work, 'locked')).mode & 0o777).toBe(0o755)
    expect(lstatSync(path.join(work, 'bin/latest')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(work, 'bin/latest'))).toBe('tool')
    expect(readlinkSync(path.join(work, 'bin/up'))).toBe('../data.bin')
    expect(readFileSync(path.join(work, 'bin/up'), 'utf8')).toBe('payload')
  })

  it('never changes the cache when the job changes a file', async () => {
    const { cache, digest } = await cacheWith({ input: 'original content' })
    const work = path.join(tempDir(), 'work')
    await assembleJobFolder(
      manifestOf([
        { kind: 'file', path: 'a.txt', mode: 0o644, size: 16, sha256: digest('input') },
        { kind: 'file', path: 'b.txt', mode: 0o644, size: 16, sha256: digest('input') },
      ]),
      cache,
      work
    )
    writeFileSync(path.join(work, 'a.txt'), 'changed by the job')
    expect(readFileSync(path.join(work, 'b.txt'), 'utf8')).toBe('original content')
    expect(readFileSync(cache.path(digest('input')), 'utf8')).toBe('original content')
    expect(sha256Hex(readFileSync(cache.path(digest('input'))))).toBe(digest('input'))
  })

  it('fails with transfer_failed when a blob is missing from the cache', async () => {
    const { cache } = await cacheWith({})
    const error = await assembleJobFolder(
      manifestOf([{ kind: 'file', path: 'a.txt', mode: 0o644, size: 1, sha256: sha256Hex('absent') }]),
      cache,
      path.join(tempDir(), 'work')
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerJobError)
    expect((error as RunnerJobError).code).toBe('transfer_failed')
  })

  describe('refuses what the manifest schema already forbids', () => {
    const refused = async (entries: unknown[]) => {
      const { cache, digest } = await cacheWith({ file: 'content' })
      const parent = tempDir()
      const work = path.join(parent, 'work')
      const fixed = entries.map((entry) =>
        (entry as { sha256?: string }).sha256 === 'DIGEST' ? { ...(entry as object), sha256: digest('file') } : entry
      )
      const error = await assembleJobFolder(manifestOf(fixed), cache, work).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RunnerJobError)
      return { parent, work }
    }
    const file = (name: string) => ({ kind: 'file', path: name, mode: 0o644, size: 7, sha256: 'DIGEST' })

    it('paths that climb out of the folder', async () => {
      const { parent } = await refused([file('../escaped.txt')])
      expect(existsSync(path.join(parent, 'escaped.txt'))).toBe(false)
    })
    it('absolute paths, backslashes, empty and dot segments', async () => {
      await refused([file('/tmp/absolute.txt')])
      await refused([file('a\\b')])
      await refused([file('a//b')])
      await refused([file('a/./b')])
      await refused([{ kind: 'directory', path: 'a/../../x', mode: 0o755 }])
    })
    it('entries under a link, which would be written through it', async () => {
      const { work } = await refused([
        { kind: 'directory', path: 'real', mode: 0o755 },
        { kind: 'symlink', path: 'alias', target: 'real' },
        file('alias/through.txt'),
      ])
      expect(existsSync(path.join(work, 'real', 'through.txt'))).toBe(false)
    })
    it('links that point out of the folder', async () => {
      await refused([{ kind: 'symlink', path: 'out', target: '../../etc' }])
      await refused([{ kind: 'symlink', path: 'abs', target: '/etc/passwd' }])
    })
    it('the same path twice', async () => {
      await refused([file('same.txt'), file('same.txt')])
    })
  })
})
