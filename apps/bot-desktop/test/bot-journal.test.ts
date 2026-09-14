import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BotJournal } from '../src/main/bot-journal'
import { BotClient } from '../src/main/bot-client'
import { HostRequestError } from '../src/main/host-client'
import { FixtureHost } from '../src/main/fixture'
const hostId = 'd9a02e5b-0c12-4411-9393-b5106ecff181'
async function readyBot(fixture: FixtureHost) {
  const preview = (await fixture.request('bot.setup.preview', {})) as any
  const op = (await fixture.request('bot.setup.start', { idempotencyKey: 'k', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Ana', confirmations: { destination: true, permissions: true } })) as any
  for (let i = 0; i < 100; i++) {
    const current = (await fixture.request('bot.setup.inspect', { operationId: op.id })) as any
    if (current.status === 'waiting_user') break
    await new Promise((r) => setTimeout(r, 20))
  }
  await fixture.request('bot.auth.setApiKey', { botId: op.botId, apiKey: 'sk-fixture-key-123456' })
  return (await fixture.request('bot.inspect', { botId: op.botId })) as any
}
it('journals the message key before sending, records the receipt, and recovers a lost reply by lookup without resending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-journal-'))
  try {
    const fixture = new FixtureHost({ autoLoginMs: 10 })
    fixture.connected = true
    const bot = await readyBot(fixture)
    const file = join(dir, 'journal.json')
    let lose = true
    const sends: string[] = []
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === 'bot.messages.send') {
        sends.push(String(params.clientMessageId))
        expect(JSON.parse(await readFile(file, 'utf8'))[0].key).toBe(`${bot.id}:c1`)
        const result = await fixture.request(method, params)
        if (lose) {
          lose = false
          throw new Error('SSH disconnected')
        }
        return result
      }
      return fixture.request(method, params)
    }
    const client = new BotClient(new BotJournal(file), request)
    client.connected(hostId)
    await expect(client.call({ method: 'bot.messages.send', params: { botId: bot.id, clientMessageId: 'c1', content: 'olá' } })).rejects.toThrow('SSH disconnected')
    expect(await client.unresolved()).toHaveLength(1)
    const reopened = new BotClient(new BotJournal(file), request)
    reopened.connected(hostId)
    expect(await reopened.recover()).toEqual({ recovered: 1, unresolved: 0 })
    expect(sends).toEqual(['c1'])
    const entry = JSON.parse(await readFile(file, 'utf8'))[0]
    expect(entry.receipt.kind).toBe('turn')
    // A definitive Host rejection removes the entry; nothing is retried later.
    const rejecting = new BotClient(new BotJournal(file), async () => {
      throw new HostRequestError('busy', 'BOT_BUSY')
    })
    rejecting.connected(hostId)
    await expect(rejecting.call({ method: 'bot.messages.send', params: { botId: bot.id, clientMessageId: 'c2', content: 'x' } })).rejects.toMatchObject({ code: 'BOT_BUSY' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1)
    fixture.bots.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('never persists API keys and rejects malformed or oversized bot calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-journal-secret-'))
  try {
    const file = join(dir, 'journal.json')
    const seen: string[] = []
    const client = new BotClient(new BotJournal(file), async (method) => {
      seen.push(method)
      return { state: 'connected', provider: 'codex', method: 'apiKey' }
    })
    client.connected(hostId)
    await client.call({ method: 'bot.auth.setApiKey', params: { botId: 'b', apiKey: 'sk-super-secret-value' } })
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(seen).toEqual(['bot.auth.setApiKey'])
    await expect(client.call({ method: 'bot.exec', params: {} })).rejects.toThrow('Invalid bot request')
    await expect(client.call({ method: 'bot.messages.send', params: { botId: 'b', clientMessageId: 'c', content: 'x', extra: 1 } })).rejects.toThrow()
    await expect(client.call({ method: 'bot.messages.send', params: { botId: 'b', clientMessageId: 'c', content: 'x'.repeat(200_000) } })).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('passes long chat content and guest paths through typed projections without diagnostic truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-projection-'))
  try {
    const fixture = new FixtureHost({ autoLoginMs: 10 })
    fixture.connected = true
    const bot = await readyBot(fixture)
    const client = new BotClient(new BotJournal(join(dir, 'j.json')), (m, p) => fixture.request(m, p))
    client.connected(hostId)
    const content = `Leia /home/maestrlybot/workspace/dados/entrada.csv e ${'x'.repeat(5000)}`
    const receipt = await client.call<'bot.messages.send'>({ method: 'bot.messages.send', params: { botId: bot.id, clientMessageId: 'c1', content } })
    expect(receipt.message.content).toBe(content)
    const page = await client.call<'bot.messages.list'>({ method: 'bot.messages.list', params: { botId: bot.id } })
    expect(page.messages[0].content).toBe(content)
    fixture.bots.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
