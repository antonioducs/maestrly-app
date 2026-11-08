import { describe, expect, it } from 'vitest'
import { tarFiles } from '../src/tar.js'

type Entry = { name: string; type: string; mode: number; uid: string; gid: string; size: number; content: Buffer }

/** A minimal ustar reader, so the test needs no `tar` on the machine (Windows CI has none). */
function readTar(archive: Buffer): { entries: Entry[]; trailer: Buffer } {
  const entries: Entry[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const text = (start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString('ascii')
        .replace(/\0.*$/s, '')
    const stored = Number.parseInt(text(148, 8).trim(), 8)
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : block[index]
    expect(stored).toBe(sum)
    expect(block.subarray(257, 263).toString('ascii')).toBe('ustar\0')
    expect(block.subarray(263, 265).toString('ascii')).toBe('00')
    const size = Number.parseInt(text(124, 12), 8)
    entries.push({
      name: text(0, 100),
      type: text(156, 1),
      mode: Number.parseInt(text(100, 8), 8),
      uid: block.subarray(108, 116).toString('ascii'),
      gid: block.subarray(116, 124).toString('ascii'),
      size,
      content: archive.subarray(offset + 512, offset + 512 + size),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return { entries, trailer: archive.subarray(offset) }
}

describe('helper archives', () => {
  it('writes the file after its parent folders, owned by the bot user', () => {
    const archive = tarFiles([{ path: 'tmp/maestrly-backup/gateway.json', content: '{"a":1}', mode: 0o600 }])
    expect(archive.length % 512).toBe(0)
    const { entries, trailer } = readTar(archive)
    expect(entries.map((entry) => [entry.name, entry.type, entry.mode])).toEqual([
      ['tmp/', '5', 0o700],
      ['tmp/maestrly-backup/', '5', 0o700],
      ['tmp/maestrly-backup/gateway.json', '0', 0o600],
    ])
    for (const entry of entries) {
      expect(entry.uid).toBe('0001750\0')
      expect(entry.gid).toBe('0001750\0')
    }
    expect(entries[2].size).toBe(7)
    expect(entries[2].content.toString()).toBe('{"a":1}')
    expect(trailer.length).toBe(1024)
    expect(trailer.every((byte) => byte === 0)).toBe(true)
  })

  it('lists each folder once and pads binary content', () => {
    const { entries } = readTar(
      tarFiles([
        { path: 'tmp/a.txt', content: 'a', mode: 0o644 },
        { path: 'tmp/b.bin', content: Buffer.alloc(600, 7), mode: 0o600 },
      ])
    )
    expect(entries.map((entry) => entry.name)).toEqual(['tmp/', 'tmp/a.txt', 'tmp/b.bin'])
    expect(entries[2].content).toEqual(Buffer.alloc(600, 7))
  })

  it('refuses paths that could leave the folder or do not fit', () => {
    for (const path of ['../x', '/abs', 'a//b', 'a/./b', 'a/b c', 'a/' + 'x'.repeat(100)])
      expect(() => tarFiles([{ path, content: '', mode: 0o600 }])).toThrow()
  })
})
