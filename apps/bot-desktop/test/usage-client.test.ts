import { describe, expect, it } from 'vitest'
import type { Bot, BotTurn, UsageSummary } from '@maestrly/host-protocol'
import { UsageClient, validateUsageCall } from '../src/main/usage-client'
import { FixtureUsage } from '../src/main/fixture-usage'
import { usageRows } from '../src/renderer/features/usage/useUsage'

const SINCE = '2026-09-01T00:00:00.000Z'

describe('usage client', () => {
  it('refuses methods outside the namespace, extra params and a window nobody can serve', () => {
    expect(() => validateUsageCall({ method: 'bot.list', params: {} })).toThrow(/Invalid usage request/)
    expect(() => validateUsageCall({ method: 'usage.summary', params: { since: SINCE, force: true } })).toThrow()
    expect(validateUsageCall({ method: 'usage.summary', params: { since: SINCE } })).toEqual({ method: 'usage.summary', params: { since: SINCE } })
  })
  it('validates the reply and requires a connection', async () => {
    const summary: UsageSummary = { since: SINCE, until: SINCE, turns: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, toolCalls: 0, byModel: [], byBot: [], byDay: [] }
    const client = new UsageClient(async () => summary)
    await expect(client.call({ method: 'usage.summary', params: { since: SINCE } })).rejects.toThrow(/Conecte-se/)
    client.connected('host-1')
    expect(await client.call({ method: 'usage.summary', params: { since: SINCE } })).toEqual(summary)
    const broken = new UsageClient(async () => ({ ...summary, byModel: [{ provider: 'codex', model: 'x', turns: 1, input: 1, cachedInput: 0, output: 1, reasoningOutput: 0, toolCalls: 0, costUsd: 3 }] }))
    broken.connected('host-1')
    await expect(broken.call({ method: 'usage.summary', params: { since: SINCE } })).rejects.toThrow()
  })
})

describe('fixture usage and pricing', () => {
  const bot = { id: 'bot-1', name: 'Ana', model: { model: 'fixture-small', source: 'recommended' } } as Bot
  const turn = (id: string, finishedAt: string, input: number, cached = 0): BotTurn =>
    ({ id, botId: 'bot-1', conversationId: 'c', messageId: 'm', status: 'succeeded', generation: 1, revision: 1, createdAt: finishedAt, updatedAt: finishedAt, finishedAt, usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: 10 } }) as BotTurn
  it('sums finished turns in the window by model, bot and day, like the Host', () => {
    const fixture = new FixtureUsage(() => [turn('a', '2026-09-02T10:00:00.000Z', 100, 40), turn('b', '2026-09-03T10:00:00.000Z', 200), { ...turn('c', '2026-10-03T10:00:00.000Z', 999) }], () => bot)
    const summary = fixture.request('usage.summary', { since: SINCE, until: '2026-09-30T00:00:00.000Z' }) as UsageSummary
    expect(summary).toMatchObject({ turns: 2, input: 300, cachedInput: 40, output: 20 })
    expect(summary.byModel).toEqual([{ provider: 'codex', model: 'fixture-small', turns: 2, input: 300, cachedInput: 40, output: 20, reasoningOutput: 0, toolCalls: 0 }])
    expect(summary.byBot[0]).toMatchObject({ botId: 'bot-1', name: 'Ana', turns: 2 })
    expect(summary.byDay.map((row) => row.day)).toEqual(['2026-09-02', '2026-09-03'])
    expect(() => fixture.request('usage.summary', { since: '2026-09-30T00:00:00.000Z', until: SINCE })).toThrow(/inválido/)
  })
  it('prices a model row with the catalogue and leaves an unknown model unpriced', () => {
    const summary: UsageSummary = {
      since: SINCE, until: SINCE, turns: 2, input: 1_000_000, cachedInput: 0, output: 0, reasoningOutput: 0, toolCalls: 0, byBot: [], byDay: [],
      byModel: [
        { provider: 'codex', model: 'fixture-small', turns: 1, input: 1_000_000, cachedInput: 200_000, output: 0, reasoningOutput: 0, toolCalls: 0 },
        { provider: 'codex', model: 'mystery', turns: 1, input: 10, cachedInput: 0, output: 0, reasoningOutput: 0, toolCalls: 0 },
      ],
    }
    const rows = usageRows(summary, { 'openai/fixture-small': { inputPer1M: 1, outputPer1M: 10, cacheReadPer1M: 0.5 } }, 'tasks')
    // Cached input is priced at the cache rate, the rest at the input rate.
    expect(rows[0]).toMatchObject({ modelId: 'fixture-small', input: 800_000, cacheRead: 200_000, cost: 0.9, sub: 'codex · 1 tasks' })
    expect(rows[1].cost).toBeNull()
  })
})
