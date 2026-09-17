import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSIONS_CAPABILITY } from '@maestrly/host-protocol'
import { HostError } from '../src/errors.js'
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
const b64 = (text: string) => Buffer.from(text).toString('base64')
const skillMd = '---\ndescription: Revisa código com cuidado\n---\n# Review\nLeia o diff.'
const SECRET = 'x-secret-7f3a9c'

const send = async (lab: RoutineLab, botId: string, content: string) => {
  const receipt = await lab.call('bot.messages.send', { botId, clientMessageId: randomUUID(), content })
  return receipt.turn.id as string
}
const requestsOf = (lab: RoutineLab, botId: string) => lab.guest(botId).requests.map((r) => r.method)

describe.skipIf(process.platform === 'win32')('per-bot extensions', () => {
  it('stores a server, keeps its secret out of the database and out of every reply, and delivers it before the turn', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const state = await lab.call('extension.mcp.upsert', {
      botId: bot.id,
      server: { name: 'echo', transport: 'stdio', command: 'node', args: ['echo.mjs'], env: { TOKEN: SECRET } },
      expectedRevision: 0,
    })
    expect(state.revision).toBe(1)
    expect(state.mcpServers[0]).toMatchObject({ name: 'echo', envKeys: ['TOKEN'] })
    expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(JSON.stringify(await lab.call('extension.inspect', { botId: bot.id }))).not.toContain(SECRET)
    // The secret is nowhere in SQLite: not the configuration, not the outbox, not an event.
    const db = lab.service.domains.bots!.repo.db
    for (const table of ['bot_extensions', 'bot_outbox', 'bot_events', 'bot_turns', 'bot_messages'])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE body LIKE ?`).get(`%${SECRET}%`)!.n, table).toBe(0)
    // It reaches the guest, on its own request, before turn.start.
    const turnId = await send(lab, bot.id, 'oi')
    await until(() => lab.guest(bot.id).turns.has(turnId), (reached) => reached)
    const methods = requestsOf(lab, bot.id)
    expect(methods.indexOf('extensions.apply')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('extensions.apply')).toBeLessThan(methods.indexOf('turn.start'))
    const applied = lab.guest(bot.id).requests.find((r) => r.method === 'extensions.apply')!.params as { revision: number; mcpServers: { env: Record<string, string> }[] }
    expect(applied.revision).toBe(1)
    expect(applied.mcpServers[0].env).toEqual({ TOKEN: SECRET })
    // A second turn on the same session does not re-send; a change does.
    lab.guest(bot.id).finish(turnId, 'succeeded', 'ok')
    await until(() => lab.call('bot.inspect', { botId: bot.id }), (value) => !value.activeTurnId)
    const second = await send(lab, bot.id, 'de novo')
    await until(() => lab.guest(bot.id).turns.has(second), (reached) => reached)
    expect(requestsOf(lab, bot.id).filter((m) => m === 'extensions.apply')).toHaveLength(1)
    lab.guest(bot.id).finish(second, 'succeeded', 'ok')
    await until(() => lab.call('bot.inspect', { botId: bot.id }), (value) => !value.activeTurnId)
    const changed = await lab.call('extension.mcp.upsert', { botId: bot.id, server: { ...state.mcpServers[0], env: {} }, expectedRevision: 1 })
    // A key not named keeps its value; the person did not ask to forget it.
    expect(changed.mcpServers[0].envKeys).toEqual(['TOKEN'])
    const third = await send(lab, bot.id, 'terceira')
    await until(() => lab.guest(bot.id).turns.has(third), (reached) => reached)
    expect(requestsOf(lab, bot.id).filter((m) => m === 'extensions.apply')).toHaveLength(2)
  })

  it('tells the person when the guest cannot take extensions, and lets the turn run', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const guest = lab.guest(bot.id)
    guest.capabilities = guest.capabilities.filter((c) => c !== EXTENSIONS_CAPABILITY)
    await lab.call('extension.mcp.upsert', { botId: bot.id, server: { name: 'echo', transport: 'http', url: 'https://mcp.test/' }, expectedRevision: 0 })
    const turnId = await send(lab, bot.id, 'oi')
    await until(() => guest.turns.has(turnId), (reached) => reached)
    expect(requestsOf(lab, bot.id)).not.toContain('extensions.apply')
    const events = await lab.call('bot.events.list', { botId: bot.id, after: 0, limit: 200 })
    expect(events.events.some((e: { kind: string; detail?: { code?: string } }) => e.kind === 'diagnostic' && e.detail?.code === 'EXTENSIONS_UPDATE_REQUIRED')).toBe(true)
  })

  it('fails the turn once, with a reason, when the guest rejects the extensions', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const guest = lab.guest(bot.id)
    await lab.call('extension.mcp.upsert', { botId: bot.id, server: { name: 'echo', transport: 'http', url: 'https://mcp.test/' }, expectedRevision: 0 })
    guest.handler = async (method) => {
      if (method === 'extensions.apply') throw new HostError('INVALID_REQUEST', 'nope')
      return undefined
    }
    const turnId = await send(lab, bot.id, 'oi')
    const turn = await until(() => lab.call('bot.turn.get', { turnId }), (value) => ['failed', 'succeeded'].includes(value.status))
    expect(turn.status).toBe('failed')
    expect(turn.error?.code).toBe('INVALID_REQUEST')
    expect(requestsOf(lab, bot.id)).not.toContain('turn.start')
    expect(requestsOf(lab, bot.id).filter((m) => m === 'extensions.apply')).toHaveLength(1)
  })

  it('installs a skill into the private state, lists it, toggles it and refuses a malformed one', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    await expect(lab.call('extension.skill.install', { botId: bot.id, name: 'review', files: [{ path: 'README.md', dataBase64: b64('x') }], expectedRevision: 0 })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    const many = Array.from({ length: 65 }, (_, i) => ({ path: `f${i}.txt`, dataBase64: b64('x') }))
    await expect(lab.call('extension.skill.install', { botId: bot.id, name: 'review', files: [{ path: 'SKILL.md', dataBase64: b64(skillMd) }, ...many], expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const state = await lab.call('extension.skill.install', {
      botId: bot.id,
      name: 'review',
      files: [{ path: 'SKILL.md', dataBase64: b64(skillMd) }, { path: 'scripts/check.sh', dataBase64: b64('echo ok') }],
      expectedRevision: 0,
    })
    expect(state.skills[0]).toMatchObject({ name: 'review', description: 'Revisa código com cuidado', files: 2, enabled: true })
    expect(await readdir(join(lab.dir, 'extensions', bot.id, 'skills', 'review'))).toEqual(expect.arrayContaining(['SKILL.md', 'scripts']))
    const off = await lab.call('extension.skill.setEnabled', { botId: bot.id, name: 'review', enabled: false, expectedRevision: state.revision })
    expect(off.skills[0].enabled).toBe(false)
    // Disabled: the guest is not sent the skill files at all.
    const turnId = await send(lab, bot.id, 'oi')
    await until(() => lab.guest(bot.id).turns.has(turnId), (reached) => reached)
    const applied = lab.guest(bot.id).requests.find((r) => r.method === 'extensions.apply')!.params as { skills: unknown[] }
    expect(applied.skills).toEqual([])
    await expect(lab.call('extension.skill.remove', { botId: bot.id, name: 'review', expectedRevision: 0 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const removed = await lab.call('extension.skill.remove', { botId: bot.id, name: 'review', expectedRevision: off.revision })
    expect(removed.skills).toEqual([])
  })
})
