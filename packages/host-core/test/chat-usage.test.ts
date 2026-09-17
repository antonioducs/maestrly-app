import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore } from '../src/persistence/store.js'
import { BotRepository } from '../src/bots/repository.js'
import { UsageService } from '../src/chat/usage-service.js'
import { directory } from './bot-helpers.js'

const stamp = '2026-09-01T00:00:00.000Z'
const dirs: string[] = []
const stores: HostStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A Host with two bots and a ledger written the way the coordinator writes it: one row per finished turn. */
async function ledger() {
  const dir = await directory()
  dirs.push(dir)
  const store = new HostStore(dir)
  stores.push(store)
  const repo = new BotRepository(store)
  const db = repo.db
  db.prepare('INSERT INTO vms(id,body) VALUES(?,?)').run('vm-1', JSON.stringify({ id: 'vm-1' }))
  for (const [id, name] of [['bot-a', 'Ana'], ['bot-b', 'Beto']])
    db.prepare('INSERT INTO bots(id,vm_id,status,body) VALUES(?,?,?,?)').run(id, 'vm-1', 'ready', JSON.stringify({ id, name, status: 'ready' }))
  db.prepare('INSERT INTO bot_conversations(id,bot_id,body) VALUES(?,?,?)').run('conv', 'bot-a', JSON.stringify({ id: 'conv' }))
  let n = 0
  const turn = (botId: string, finishedAt: string, model: string, input: number, output: number, cachedInput = 0) => {
    const id = `turn-${++n}`
    db.prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?)').run(id, botId, 'conv', 'succeeded', JSON.stringify({ id }))
    repo.saveTurnUsage({ turnId: id, botId, finishedAt, provider: 'codex', model, input, cachedInput, output, reasoningOutput: 1, toolCalls: 2 })
  }
  turn('bot-a', '2026-09-01T10:00:00.000Z', 'gpt-5', 100, 10, 40)
  turn('bot-a', '2026-09-02T10:00:00.000Z', 'gpt-5', 200, 20)
  turn('bot-b', '2026-09-02T11:00:00.000Z', 'gpt-5-mini', 50, 5)
  turn('bot-a', '2026-10-01T10:00:00.000Z', 'gpt-5', 999, 99)
  return { repo, service: new UsageService(repo, () => new Date('2026-09-30T00:00:00.000Z')) }
}

describe.skipIf(process.platform === 'win32')('usage summary over the turn ledger', () => {
  it('sums a window by model, bot and day, and leaves rows outside the window out', async () => {
    const { service } = await ledger()
    const summary = await service.handle({ version: 1, id: 'r', method: 'usage.summary', params: { since: stamp, until: '2026-09-03T00:00:00.000Z' } })
    expect(summary).toMatchObject({ turns: 3, input: 350, cachedInput: 40, output: 35, reasoningOutput: 3, toolCalls: 6, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-02T11:00:00.000Z' })
    expect(summary.byModel).toEqual([
      { provider: 'codex', model: 'gpt-5', turns: 2, input: 300, cachedInput: 40, output: 30, reasoningOutput: 2, toolCalls: 4 },
      { provider: 'codex', model: 'gpt-5-mini', turns: 1, input: 50, cachedInput: 0, output: 5, reasoningOutput: 1, toolCalls: 2 },
    ])
    expect(summary.byBot.map((row) => [row.botId, row.name, row.turns])).toEqual([
      ['bot-a', 'Ana', 2],
      ['bot-b', 'Beto', 1],
    ])
    expect(summary.byDay.map((row) => [row.day, row.turns])).toEqual([
      ['2026-09-01', 1],
      ['2026-09-02', 2],
    ])
  })
  it('narrows to one bot, defaults the end to now, and refuses a bot that does not exist', async () => {
    const { service } = await ledger()
    const mine = service.summary({ botId: 'bot-b', since: stamp })
    expect(mine).toMatchObject({ botId: 'bot-b', turns: 1, input: 50, until: '2026-09-30T00:00:00.000Z' })
    expect(mine.byBot).toHaveLength(1)
    expect(() => service.summary({ botId: 'nobody', since: stamp })).toThrow(/Bot not found/)
  })
  it('refuses an inverted, unparsable or longer-than-90-day window with one code', async () => {
    const { service } = await ledger()
    for (const params of [
      { since: '2026-09-03T00:00:00.000Z', until: stamp },
      { since: 'not-a-date-at-all-x', until: stamp },
      { since: '2026-06-01T00:00:00.000Z', until: '2026-09-01T00:00:00.001Z' },
    ])
      expect(() => service.summary(params)).toThrow(expect.objectContaining({ code: 'USAGE_RANGE_INVALID' }))
    // Exactly 90 days is still fine.
    expect(service.summary({ since: '2026-06-03T12:00:00.000Z', until: '2026-09-01T12:00:00.000Z' }).turns).toBe(1)
  })
  it('keeps the rows of a bot whose record is gone, with an empty name', async () => {
    const { repo, service } = await ledger()
    repo.db.prepare("UPDATE bot_turn_usage SET bot_id='gone' WHERE bot_id='bot-b'").run()
    const summary = service.summary({ since: stamp, until: '2026-09-03T00:00:00.000Z' })
    expect(summary.byBot.find((row) => row.botId === 'gone')).toMatchObject({ name: '', turns: 1 })
  })
})
