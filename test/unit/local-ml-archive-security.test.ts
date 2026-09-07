import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import tar from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractLocalMlArchive as extractArchive } from '../../scripts/extract-local-ml-archive.mjs'

let temporary: string
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'ml-archive-security-'))
})
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

async function fixture(entries: Array<{ name: string; type?: 'file' | 'symlink' | 'link'; body?: string }>) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', (chunk) => chunks.push(chunk))
  for (const entry of entries)
    pack.entry({ name: entry.name, type: entry.type ?? 'file', linkname: '../outside' }, entry.body ?? 'content')
  pack.finalize()
  await new Promise<void>((resolve, reject) => pack.once('end', resolve).once('error', reject))
  const archive = path.join(temporary, 'archive.tgz')
  await writeFile(archive, gzipSync(Buffer.concat(chunks)))
  return archive
}

describe('local ML smoke archive boundaries', () => {
  it.each([
    '../escape',
    '/absolute',
    'nested/../escape',
    '..\\escape',
    'nested\\..\\escape',
    'C:escape',
    'C:/escape',
    'nested/file:stream',
    'nested/.. /escape',
  ])('rejects portable unsafe path %s', async (name) => {
    const archive = await fixture([{ name }])
    await expect(extractArchive(archive, path.join(temporary, 'out'))).rejects.toThrow(/unsafe/i)
  })

  it.each(['symlink', 'link'] as const)('rejects %s entries', async (type) => {
    const archive = await fixture([{ name: 'link', type, body: '' }])
    await expect(extractArchive(archive, path.join(temporary, 'out'))).rejects.toThrow(/unsupported/i)
  })

  it('rejects duplicate file entries rather than overwriting the first', async () => {
    const archive = await fixture([
      { name: 'runtime.mjs', body: 'first' },
      { name: 'runtime.mjs', body: 'second' },
    ])
    const out = path.join(temporary, 'out')
    await expect(extractArchive(archive, out)).rejects.toThrow(/exist/i)
    expect(await readFile(path.join(out, 'runtime.mjs'), 'utf8')).toBe('first')
  })

  it('propagates corrupt gzip errors without leaving a pending extraction', async () => {
    const archive = path.join(temporary, 'corrupt.tgz')
    await writeFile(archive, 'not gzip')
    await expect(extractArchive(archive, path.join(temporary, 'out'))).rejects.toThrow()
  })

  it('extracts a nested regular file', async () => {
    const archive = await fixture([{ name: 'nested/runtime.mjs', body: 'safe' }])
    const out = path.join(temporary, 'out')
    await extractArchive(archive, out)
    expect(await readFile(path.join(out, 'nested/runtime.mjs'), 'utf8')).toBe('safe')
  })
})
