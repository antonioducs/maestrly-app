import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileIdentity, hashFile, publishExclusive, readAt, writeAt } from '../../src/main/transfer-io'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'transfer-io-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('transfer io', () => {
  it('writes and reads exact ranges at their positions', async () => {
    const file = path.join(root, 'a.bin')
    const handle = await open(file, 'w+')
    try {
      await handle.truncate(10)
      await writeAt(handle, Buffer.from('56789'), 5)
      await writeAt(handle, Buffer.from('01234'), 0)
      expect((await readAt(handle, 4, 3)).toString()).toBe('3456')
      await expect(readAt(handle, 4, 8)).rejects.toThrow()
    } finally {
      await handle.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('0123456789')
  })

  it('hashes a range or the whole file', async () => {
    const file = path.join(root, 'b.txt')
    writeFileSync(file, 'abcdefghij')
    expect(await hashFile(file, 3, 4)).toBe(sha(Buffer.from('defg')))
    expect(await hashFile(file)).toBe(sha(Buffer.from('abcdefghij')))
    expect(await hashFile(file, 0, 0)).toBe(sha(Buffer.alloc(0)))
  })

  it('publishes without replacing a file, and removes the partial', async () => {
    const first = path.join(root, '.one.partial')
    const second = path.join(root, '.two.partial')
    writeFileSync(first, 'one')
    writeFileSync(second, 'two')
    expect(await publishExclusive(first, root, 'a.csv')).toBe(path.join(root, 'a.csv'))
    expect(await publishExclusive(second, root, 'a.csv')).toBe(path.join(root, 'a (1).csv'))
    expect(readFileSync(path.join(root, 'a.csv'), 'utf8')).toBe('one')
    expect(readFileSync(path.join(root, 'a (1).csv'), 'utf8')).toBe('two')
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
  })

  it('names a file by its size, modification time and inode', () => {
    const file = path.join(root, 'c.txt')
    writeFileSync(file, 'abc')
    const before = fileIdentity(statSync(file))
    expect(before).toMatch(/^3:\d+:\d+$/)
    utimesSync(file, new Date(0), new Date(1_000))
    expect(fileIdentity(statSync(file))).not.toBe(before)
  })
})
