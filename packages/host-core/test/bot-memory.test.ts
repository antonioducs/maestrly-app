import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { readyBot, setup, until } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})
describe.skipIf(skipWindows)('bot memory', () => {
  it('is per bot, revisioned, inspectable and feeds only active items into the next snapshot', async () => {
    const ctx = await setup()
    cleanups.push(async () => {
      await ctx.service.close()
      await rm(ctx.dir, { recursive: true, force: true })
    })
    const bot = await readyBot(ctx, 'Um')
    const other = await readyBot(ctx, 'Dois')
    const memory = await ctx.call('bot.memory.upsert', { botId: bot.id, content: 'Prefere relatórios em Markdown' })
    await ctx.call('bot.memory.upsert', { botId: other.id, content: 'Segredo do outro bot' })
    expect((await ctx.call('bot.memory.list', { botId: bot.id })).map((m: any) => m.content)).toEqual(['Prefere relatórios em Markdown'])
    await expect(ctx.call('bot.memory.upsert', { botId: bot.id, memoryId: memory.id, expectedRevision: 5, content: 'x' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(ctx.call('bot.memory.delete', { botId: other.id, memoryId: memory.id, expectedRevision: memory.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const inactive = await ctx.call('bot.memory.upsert', { botId: bot.id, content: 'Desativada', active: false })
    const receipt = await ctx.call('bot.messages.send', { botId: bot.id, clientMessageId: 'm1', content: 'oi' })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    const snapshot = ctx.connector.guest(bot.vmId).requests.find((r) => r.method === 'turn.start')!.params
    expect(snapshot.memory).toEqual([{ id: memory.id, content: 'Prefere relatórios em Markdown' }])
    expect(JSON.stringify(snapshot)).not.toContain('Segredo do outro bot')
    ctx.connector.guest(bot.vmId).finish(receipt.turn.id)
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'succeeded')
    // Deleting stops future injection but does not rewrite the past conversation.
    await ctx.call('bot.memory.delete', { botId: bot.id, memoryId: memory.id, expectedRevision: memory.revision })
    expect(await ctx.call('bot.memory.list', { botId: bot.id, includeInactive: true })).toMatchObject([{ id: inactive.id }])
    const next = await ctx.call('bot.messages.send', { botId: bot.id, clientMessageId: 'm2', content: 'de novo' })
    await until(() => ctx.call('bot.turn.get', { turnId: next.turn.id }), (t: any) => t.status === 'running')
    const second = ctx.connector.guest(bot.vmId).requests.filter((r) => r.method === 'turn.start').at(-1)!.params
    expect(second.memory).toEqual([])
    expect(second.recentMessages.map((m: any) => m.content)).toEqual(['oi', 'done'])
  })
  it('explains the active memory budget instead of truncating silently', async () => {
    const ctx = await setup()
    cleanups.push(async () => {
      await ctx.service.close()
      await rm(ctx.dir, { recursive: true, force: true })
    })
    const bot = await readyBot(ctx)
    for (let i = 0; i < 5; i++) await ctx.call('bot.memory.upsert', { botId: bot.id, content: 'm'.repeat(8000) })
    await expect(ctx.call('bot.messages.send', { botId: bot.id, clientMessageId: 'm1', content: 'oi' })).rejects.toMatchObject({ code: 'MEMORY_BUDGET_EXCEEDED' })
    expect(await ctx.call('bot.messages.lookup', { botId: bot.id, clientMessageId: 'm1' })).toBeNull()
  })
})
