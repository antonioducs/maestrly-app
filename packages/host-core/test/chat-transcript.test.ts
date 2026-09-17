import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_HOST_CAPABILITY } from '@maestrly/host-protocol'
import { labBot, routineLab, until, type RoutineLab } from './routine-helpers.js'

const labs: RoutineLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close().catch(() => {})
})
async function open() {
  const lab = await routineLab()
  labs.push(lab)
  await lab.service.ready()
  return lab
}
const send = async (lab: RoutineLab, botId: string, content: string) => {
  const receipt = await lab.call('bot.messages.send', { botId, clientMessageId: randomUUID(), content })
  await until(() => lab.guest(botId).turns.has(receipt.turn.id), (reached) => reached)
  return receipt.turn.id as string
}

describe.skipIf(process.platform === 'win32')('the transcript a person reads', () => {
  it('shows a tool running live, then done with its output once the turn finishes', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const guest = lab.guest(bot.id)
    const turnId = await send(lab, bot.id, 'liste os arquivos')
    guest.emit({ turnId, generation: 1, kind: 'tool.started', summary: 'Executando um comando', detail: { callId: 'c1', tool: 'commandExecution', command: 'ls' } })
    await until(
      () => lab.call('bot.transcript.list', { botId: bot.id }),
      (page) => page.messages.some((m: { id: string }) => m.id === `turn:${turnId}`)
    )
    const live = await lab.call('bot.transcript.list', { botId: bot.id })
    const card = live.messages.find((m: { id: string }) => m.id === `turn:${turnId}`)
    expect(card.streaming).toBe(true)
    expect(card.parts.at(-1)).toMatchObject({ type: 'tool', callId: 'c1', state: 'running', input: 'ls' })
    // The card sits right after the person's message.
    expect(live.messages.findIndex((m: { role: string }) => m.role === 'user')).toBeLessThan(live.messages.indexOf(card))

    guest.emit({ turnId, generation: 1, kind: 'tool.finished', summary: 'Executando um comando', detail: { callId: 'c1', tool: 'commandExecution', output: 'a\nb', exitCode: 0 } })
    guest.finish(turnId, 'succeeded', 'dois arquivos')
    const done = await until(
      () => lab.call('bot.transcript.list', { botId: bot.id }),
      (page) => page.messages.find((m: { id: string }) => m.id === `turn:${turnId}`)?.streaming === false
    )
    const finished = done.messages.find((m: { id: string }) => m.id === `turn:${turnId}`)
    expect(finished.turnStatus).toBe('succeeded')
    expect(finished.responseDurationMs).toBeGreaterThanOrEqual(0)
    expect(finished.parts.map((part: { type: string }) => part.type)).toEqual(['tool', 'text'])
    expect(finished.parts[0]).toMatchObject({ state: 'done', output: 'a\nb', exitCode: 0 })
    expect(finished.parts[1].text).toBe('dois arquivos')
    // The cursor is where a live subscription continues from.
    const events = await lab.call('bot.events.list', { botId: bot.id, after: 0, limit: 500 })
    expect(done.cursor).toBe(Math.max(...events.events.filter((e: { turnId?: string }) => e.turnId === turnId).map((e: { seq: number }) => e.seq)))
  })

  it('records the model the bot had when the turn was admitted and writes the usage ledger on finish', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const inspected = await lab.call('bot.inspect', { botId: bot.id })
    const turnId = await send(lab, bot.id, 'oi')
    const turn = await lab.call('bot.turn.get', { turnId })
    expect(turn.model).toEqual(inspected.model)
    const guest = lab.guest(bot.id)
    guest.emit({ turnId, generation: 1, kind: 'assistant.message', summary: 'reply', detail: { content: 'olá' } })
    guest.emit({ turnId, generation: 1, kind: 'turn.status', summary: 'succeeded', detail: { status: 'succeeded', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 } } })
    const finished = await until(() => lab.call('bot.turn.get', { turnId }), (value) => value.status === 'succeeded')
    expect(finished.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 })
    const rows = lab.service.domains.bots!.repo.turnUsage(bot.id, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ turnId, input: 10, output: 5, cachedInput: 3, model: inspected.model?.model ?? 'unknown', provider: 'codex' })
  })

  it('announces the chat experience on host.inspect', async () => {
    const lab = await open()
    expect((await lab.call('host.inspect', {})).capabilities).toContain(CHAT_HOST_CAPABILITY)
  })
})
