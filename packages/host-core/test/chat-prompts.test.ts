import { afterEach, describe, expect, it } from 'vitest'
import { expandPrompt } from '@maestrly/host-protocol'
import { labBot, routineLab, type RoutineLab } from './routine-helpers.js'

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

describe.skipIf(process.platform === 'win32')('stored prompt templates', () => {
  it('keeps a Host prompt and a bot prompt with the same name apart, and lists both for that bot', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const shared = await lab.call('prompt.upsert', { scope: 'host', name: 'resumo', description: 'Resumo do dia', template: 'Resuma $ARGUMENTS' })
    const own = await lab.call('prompt.upsert', { scope: 'bot', botId: bot.id, name: 'resumo', template: 'Resuma para este bot: $ARGUMENTS' })
    expect(shared.scope).toBe('host')
    expect(own.botId).toBe(bot.id)
    const listed = await lab.call('prompt.list', { botId: bot.id })
    expect(listed.prompts.map((p: { scope: string; name: string }) => `${p.scope}:${p.name}`)).toEqual(['host:resumo', 'bot:resumo'])
    // A second Host prompt with the same name is refused; only the scope keeps them distinct.
    await expect(lab.call('prompt.upsert', { scope: 'host', name: 'resumo', template: 'x' })).rejects.toMatchObject({ code: 'PROMPT_NAME_TAKEN' })
    expect(expandPrompt(shared.template, '  ontem ')).toBe('Resuma ontem')
  })
  it('refuses vague names, unknown bots and stale revisions', async () => {
    const lab = await open()
    await expect(lab.call('prompt.upsert', { scope: 'host', name: 'Não Vale', template: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(lab.call('prompt.upsert', { scope: 'bot', botId: '11111111-1111-1111-1111-111111111111', name: 'ok', template: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const created = await lab.call('prompt.upsert', { scope: 'host', name: 'ok', template: 'x' })
    await expect(lab.call('prompt.upsert', { id: created.id, scope: 'host', name: 'ok', template: 'y', expectedRevision: 7 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const updated = await lab.call('prompt.upsert', { id: created.id, scope: 'host', name: 'ok', template: 'y', expectedRevision: 0 })
    expect(updated.revision).toBe(1)
    expect(updated.template).toBe('y')
  })
  it('deletes once and treats a repeated delete as already done', async () => {
    const lab = await open()
    const created = await lab.call('prompt.upsert', { scope: 'host', name: 'apagar', template: 'x' })
    await expect(lab.call('prompt.delete', { id: created.id, expectedRevision: 3 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await lab.call('prompt.delete', { id: created.id, expectedRevision: 0 })).toEqual({ deleted: true })
    expect(await lab.call('prompt.delete', { id: created.id, expectedRevision: 0 })).toEqual({ deleted: true })
    expect((await lab.call('prompt.list', {})).prompts).toEqual([])
  })
})
