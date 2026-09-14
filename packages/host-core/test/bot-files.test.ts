import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { workspacePath } from '../src/bots/files.js'
import { readyBot, setup, sha } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})
describe('workspace paths', () => {
  it('rejects traversal, absolute and drive paths', () => {
    expect(workspacePath('reports/out.md')).toBe('reports/out.md')
    expect(workspacePath('./a/b')).toBe('a/b')
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'C:\\x', 'a\0b', 'a/./b'])
      expect(() => workspacePath(bad), bad).toThrow()
  })
})
describe.skipIf(skipWindows)('bot files', () => {
  it('lists, downloads in chunks with digest pinning, uploads with resumable offsets and detects mutation', async () => {
    const ctx = await setup()
    cleanups.push(async () => {
      await ctx.service.close()
      await rm(ctx.dir, { recursive: true, force: true })
    })
    const bot = await readyBot(ctx)
    const guest = ctx.connector.guest(bot.vmId)
    const content = randomBytes(100_000)
    guest.files.set('relatorio.bin', content)
    const listing = await ctx.call('bot.files.list', { botId: bot.id })
    expect(listing).toMatchObject([{ path: 'relatorio.bin', size: 100_000, digest: sha(content) }])
    await expect(ctx.call('bot.files.list', { botId: bot.id, path: '../x' })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    let transfer = await ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'download', path: 'relatorio.bin' })
    expect(transfer).toMatchObject({ size: 100_000, offset: 0, chunkBytes: 49_152, digest: sha(content) })
    const chunks: Buffer[] = []
    while (!transfer.done) {
      transfer = await ctx.call('bot.files.transferChunk', { transferId: transfer.transferId, offset: transfer.offset })
      chunks.push(Buffer.from(transfer.dataBase64, 'base64'))
    }
    expect(chunks).toHaveLength(3)
    expect(Buffer.concat(chunks).equals(content)).toBe(true)
    await expect(ctx.call('bot.files.transferChunk', { transferId: transfer.transferId, offset: 0 })).rejects.toMatchObject({ code: 'TRANSFER_OFFSET' })
    expect((await ctx.call('bot.files.transferFinish', { transferId: transfer.transferId })).done).toBe(true)
    // Mutation during download is detected by the pinned digest.
    let mutating = await ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'download', path: 'relatorio.bin' })
    mutating = await ctx.call('bot.files.transferChunk', { transferId: mutating.transferId, offset: 0 })
    guest.files.set('relatorio.bin', randomBytes(100_000))
    await expect(ctx.call('bot.files.transferChunk', { transferId: mutating.transferId, offset: mutating.offset })).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    // Upload: refuses silent overwrite, chunks with offsets, atomic finish.
    const upload = randomBytes(60_000)
    await expect(ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'upload', path: 'relatorio.bin', size: upload.length })).rejects.toMatchObject({ code: 'FILE_EXISTS' })
    let up = await ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'upload', path: 'dados/entrada.csv', size: upload.length, digest: sha(upload) })
    up = await ctx.call('bot.files.transferChunk', { transferId: up.transferId, offset: 0, dataBase64: upload.subarray(0, 49_152).toString('base64') })
    expect(up.offset).toBe(49_152)
    expect(guest.files.has('dados/entrada.csv')).toBe(false)
    await expect(ctx.call('bot.files.transferFinish', { transferId: up.transferId })).rejects.toMatchObject({ code: 'TRANSFER_INCOMPLETE' })
    up = await ctx.call('bot.files.transferChunk', { transferId: up.transferId, offset: 49_152, dataBase64: upload.subarray(49_152).toString('base64') })
    expect(up.done).toBe(true)
    await ctx.call('bot.files.transferFinish', { transferId: up.transferId })
    expect(guest.files.get('dados/entrada.csv')!.equals(upload)).toBe(true)
    await expect(ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'upload', path: 'big.bin', size: 40 * 1024 * 1024 })).rejects.toMatchObject({ code: 'LIMIT' })
    const aborted = await ctx.call('bot.files.transferBegin', { botId: bot.id, direction: 'upload', path: 'tmp.bin', size: 10 })
    expect((await ctx.call('bot.files.transferAbort', { transferId: aborted.transferId })).done).toBe(false)
    await expect(ctx.call('bot.files.transferChunk', { transferId: aborted.transferId, offset: 0, dataBase64: 'AA==' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
