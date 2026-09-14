import { execFileSync } from 'node:child_process'
import { readFile, symlink, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { digest, FileService } from '../src/files/service.js'
import { temporary } from './helpers.js'
const chunk = (path: string, value: string, extra = {}) => ({
  transferId: 'transfer',
  path,
  offset: 0,
  dataBase64: Buffer.from(value).toString('base64'),
  final: true,
  overwrite: false,
  ...extra,
})
describe('workspace files', () => {
  it('lists, stats and reads with the whole-file digest', async () => {
    const root = await temporary()
    const files = new FileService(root)
    await writeFile(join(root, 'hello.txt'), 'abcdef')
    expect(await files.list({ path: '' })).toMatchObject([
      { path: 'hello.txt', name: 'hello.txt', size: 6, kind: 'file' },
    ])
    expect(await files.stat({ path: 'hello.txt' })).toMatchObject({ digest: digest('abcdef'), size: 6 })
    expect(await files.read({ path: 'hello.txt', offset: 2, length: 2 })).toEqual({
      dataBase64: Buffer.from('cd').toString('base64'),
      digest: digest('abcdef'),
    })
  })
  it('publishes atomically, refuses overwrite and aborts staging', async () => {
    const root = await temporary()
    const files = new FileService(root)
    await files.write(chunk('new.txt', 'hello', { final: false }))
    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    await files.write(chunk('new.txt', ' world', { offset: 5 }))
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello world')
    await expect(files.write(chunk('new.txt', 'bad'))).rejects.toThrow()
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello world')
    await files.abort({ transferId: 'transfer' })
    await expect(access(join(root, 'new.txt.part-transfer'))).rejects.toThrow()
    await files.write(chunk('new.txt', 'replacement', { overwrite: true }))
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('replacement')
  })
  it('rejects traversal, absolute paths, private aliases, escapes and FIFOs', async () => {
    const root = await temporary()
    const outside = await temporary()
    const files = new FileService(root)
    await symlink(outside, join(root, 'escape'))
    await files.init()
    execFileSync('mkfifo', [join(root, 'pipe')])
    for (const path of ['../secret', '/etc/passwd', 'bad\0name', '.maestrly-private/key', 'escape', 'pipe'])
      await expect(files.safePath(path)).rejects.toThrow()
    await expect(files.write(chunk('escape/new', 'bad'))).rejects.toThrow()
  })
  it('checks digest before publication and rejects inconsistent transfer offsets', async () => {
    const root = await temporary()
    const files = new FileService(root)
    await expect(files.write(chunk('file', 'hello', { expectedDigest: digest('wrong') }))).rejects.toThrow('Digest')
    await expect(access(join(root, 'file'))).rejects.toThrow()
    await files.abort({ transferId: 'transfer' })
    await expect(files.write(chunk('file', 'hello', { offset: 4 }))).rejects.toThrow()
  })
})
