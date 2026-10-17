import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import tar from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractArchive,
  folderEntryRelative,
  packFolder,
  publishFolderExclusive,
  resolveFolderLink,
  scanFolder,
  UnsafeArchiveError,
} from '../../src/main/folder-archive'

let base: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'folder-archive-')))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

type Entry = Partial<tar.Header> & Pick<tar.Header, 'name'> & { content?: string }

/** An archive written entry by entry, as an attacker or another tool could write it. */
async function craft(file: string, entries: Entry[]): Promise<void> {
  const pack = tar.pack()
  const written = pipeline(pack, createZstdCompress(), createWriteStream(file))
  for (const { content, ...header } of entries)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null) => (error ? reject(error) : resolve())
      if (content !== undefined) pack.entry(header, content, done)
      else pack.entry(header, done)
    })
  pack.finalize()
  await written
}

async function refusal(entries: Entry[]): Promise<unknown> {
  const file = path.join(base, 'crafted.tar.zst')
  rmSync(file, { force: true })
  await craft(file, entries)
  const destination = path.join(base, 'out')
  const error = await extractArchive(file, destination).then(
    () => null,
    (cause: unknown) => cause
  )
  // Nothing of a refused archive is kept.
  expect(existsSync(destination)).toBe(false)
  return error
}

describe('folder entry names', () => {
  it('refuses names that leave the destination, and leaves out names a platform cannot hold', () => {
    expect(folderEntryRelative('src/a.ts', 'linux')).toBe('src/a.ts')
    expect(folderEntryRelative('src/', 'linux')).toBe('src')
    for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'a//b', './a', 'a\0b', ''])
      expect(() => folderEntryRelative(name, 'linux')).toThrow(UnsafeArchiveError)
    // Fine on Linux; Windows would read a separator, a drive or a device in them.
    expect(folderEntryRelative('a\\..\\b', 'linux')).toBe('a\\..\\b')
    for (const name of ['a\\..\\b', 'C:x', 'aux.txt', 'name.', 'what?'])
      expect(folderEntryRelative(name, 'win32')).toBeNull()
  })

  it('resolves links through the folder, its other links included, and nowhere outside it', () => {
    const none = new Map<string, string>()
    expect(resolveFolderLink('bin/tool', '../lib/tool.js', none, 'linux')).toBe('lib/tool.js')
    expect(resolveFolderLink('top', '.', none, 'linux')).toBe('')
    expect(resolveFolderLink('top', '..', none, 'linux')).toBeNull()
    expect(resolveFolderLink('a/b', '../../x', none, 'linux')).toBeNull()
    expect(resolveFolderLink('a', '/etc/passwd', none, 'linux')).toBeNull()
    // `x/up` points at the folder itself, so going up once more from it leaves.
    const links = new Map([
      ['x/up', '..'],
      ['loop', 'loop'],
    ])
    expect(resolveFolderLink('x/up', '..', links, 'linux')).toBe('')
    expect(resolveFolderLink('y', 'x/up/..', links, 'linux')).toBeNull()
    expect(resolveFolderLink('loop', 'loop', links, 'linux')).toBeNull()
    // A link under a link is resolved from where the parent link leads.
    expect(resolveFolderLink('x/up/deep', '../..', links, 'linux')).toBeNull()
    expect(resolveFolderLink('w', 'C:\\Windows', none, 'win32')).toBeNull()
  })
})

// Links, modes and FIFOs as POSIX file systems have them.
describe.skipIf(process.platform === 'win32')('folder archives', () => {
  it('moves a folder whole: nested folders, empty ones, modes, long and Unicode names, and inner links', async () => {
    const source = path.join(base, 'project')
    mkdirSync(path.join(source, 'src', 'deep'), { recursive: true })
    mkdirSync(path.join(source, 'empty'))
    mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(path.join(source, 'src', 'deep', 'a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(source, 'blank.txt'), '')
    writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(path.join(source, 'run.sh'), 0o755)
    const long = `${'n'.repeat(140)}.txt`
    writeFileSync(path.join(source, 'src', long), 'long')
    writeFileSync(path.join(source, 'relatório-ção.md'), 'acentos')
    writeFileSync(path.join(source, 'node_modules', 'cli.js'), 'cli')
    symlinkSync('../cli.js', path.join(source, 'node_modules', '.bin', 'cli'))
    symlinkSync('src/deep', path.join(source, 'deep-link'))
    // Links that leave the folder, and a FIFO, are left out.
    symlinkSync('/usr/bin/env', path.join(source, 'python'))
    symlinkSync('../../outside', path.join(source, 'src', 'escape'))
    execFileSync('mkfifo', [path.join(source, 'pipe')])

    const archive = path.join(base, 'project.tar.zst')
    const progress: number[] = []
    const packed = await packFolder(source, archive, { onProgress: ({ bytes }) => progress.push(bytes) })
    expect(packed.skipped).toBe(3)
    expect(progress.at(-1)).toBe(packed.bytes)

    const out = path.join(base, 'out')
    const extracted = await extractArchive(archive, out)
    expect(extracted).toMatchObject({ entries: packed.entries, bytes: packed.bytes, skipped: 0 })
    expect(readFileSync(path.join(out, 'src', 'deep', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(readFileSync(path.join(out, 'src', long), 'utf8')).toBe('long')
    expect(readFileSync(path.join(out, 'relatório-ção.md'), 'utf8')).toBe('acentos')
    expect(statSync(path.join(out, 'blank.txt')).size).toBe(0)
    expect(statSync(path.join(out, 'run.sh')).mode & 0o777).toBe(0o755)
    expect(readdirSync(path.join(out, 'empty'))).toEqual([])
    expect(readlinkSync(path.join(out, 'node_modules', '.bin', 'cli'))).toBe('../cli.js')
    expect(readFileSync(path.join(out, 'node_modules', '.bin', 'cli'), 'utf8')).toBe('cli')
    expect(lstatSync(path.join(out, 'deep-link')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(out, 'deep-link', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    for (const left of ['python', 'pipe', path.join('src', 'escape')])
      expect(existsSync(path.join(out, left))).toBe(false)
    // Tar keeps whole seconds.
    const seconds = (file: string) => Math.floor(statSync(file).mtimeMs / 1_000)
    expect(seconds(path.join(out, 'src'))).toBe(seconds(path.join(source, 'src')))
    expect(seconds(path.join(out, 'run.sh'))).toBe(seconds(path.join(source, 'run.sh')))
  })

  it('leaves out what it is told to, with all it holds', async () => {
    const source = path.join(base, 'home')
    mkdirSync(path.join(source, 'archives'), { recursive: true })
    writeFileSync(path.join(source, 'archives', 'big.tar.zst'), 'x')
    writeFileSync(path.join(source, 'note.txt'), 'n')
    const scan = await scanFolder(source, { exclude: [path.join(source, 'archives')] })
    expect(scan.entries.map((entry) => entry.relative)).toEqual(['note.txt'])
  })

  it('refuses archives that would write outside the destination or hold what a folder does not', async () => {
    const file = { type: 'file' as const, content: 'x' }
    for (const entries of [
      [{ name: '../evil', ...file }],
      [{ name: '/tmp/evil', ...file }],
      [{ name: 'ok/../../evil', ...file }],
      [{ name: 'up', type: 'symlink' as const, linkname: '../outside' }],
      [{ name: 'root', type: 'symlink' as const, linkname: '/etc' }],
      [
        { name: 'x/up', type: 'symlink' as const, linkname: '..' },
        { name: 'y', type: 'symlink' as const, linkname: 'x/up/..' },
      ],
      // A file under a link would be written through it.
      [
        { name: 'd', type: 'directory' as const },
        { name: 'l', type: 'symlink' as const, linkname: 'd' },
        { name: 'l/x', ...file },
      ],
      [{ name: 'tty', type: 'character-device' as const, devmajor: 5, devminor: 0 }],
      [{ name: 'fifo', type: 'fifo' as const }],
      [{ name: 'hard', type: 'link' as const, linkname: '/etc/passwd' }],
      [
        { name: 'twice', ...file },
        { name: 'twice', ...file },
      ],
    ])
      expect(await refusal(entries), JSON.stringify(entries)).toBeInstanceOf(UnsafeArchiveError)
    expect(existsSync(path.join(base, 'evil'))).toBe(false)
    expect(existsSync(path.join(base, 'outside'))).toBe(false)
  })

  it('refuses what is not an archive at all', async () => {
    const file = path.join(base, 'junk.tar.zst')
    writeFileSync(file, 'definitely not zstd')
    await expect(extractArchive(file, path.join(base, 'out'))).rejects.toBeInstanceOf(UnsafeArchiveError)
    expect(existsSync(path.join(base, 'out'))).toBe(false)
  })

  it('stops packing and extracting when asked, keeping nothing', async () => {
    const source = path.join(base, 'src')
    mkdirSync(source)
    for (let index = 0; index < 50; index++) writeFileSync(path.join(source, `f${index}.txt`), 'x'.repeat(1024))
    const controller = new AbortController()
    const archive = path.join(base, 'a.tar.zst')
    const packing = packFolder(source, archive, {
      signal: controller.signal,
      onProgress: ({ entries }) => entries === 10 && controller.abort(),
    })
    await expect(packing).rejects.toThrow()
    expect(existsSync(archive)).toBe(false)

    await packFolder(source, archive)
    const stop = new AbortController()
    stop.abort()
    await expect(extractArchive(archive, path.join(base, 'out'), { signal: stop.signal })).rejects.toThrow()
    expect(existsSync(path.join(base, 'out'))).toBe(false)
  })

  it('publishes a folder under a free name, never over another', async () => {
    const downloads = path.join(base, 'downloads')
    mkdirSync(path.join(downloads, 'site', 'kept'), { recursive: true })
    mkdirSync(path.join(downloads, 'site (2)'))
    const staging = path.join(downloads, '.staging')
    mkdirSync(staging)
    writeFileSync(path.join(staging, 'index.html'), '<p>hi</p>')
    expect(await publishFolderExclusive(staging, downloads, 'site')).toBe(path.join(downloads, 'site (3)'))
    expect(readdirSync(path.join(downloads, 'site'))).toEqual(['kept'])
    expect(readFileSync(path.join(downloads, 'site (3)', 'index.html'), 'utf8')).toBe('<p>hi</p>')
  })
})
