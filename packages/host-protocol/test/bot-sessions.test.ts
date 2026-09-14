import { expect, it } from 'vitest'
import { botSessionSchema, sessionProfileSchema } from '../src/bot-sessions.js'
import { botRequestSchema, botResultSchemas } from '../src/bot-rpc.js'

const profile = { cpuQuotaPercent: 100, memoryMiB: 768, tasksMax: 128, diskMiB: 1024 }
it('exposes session identity and resources without guest administration fields', () => {
  const session = { id: '00000000-0000-4000-8000-000000000001', botId: 'bot', vmId: 'vm', state: 'reserved', transport: 'managed', generation: 0, revision: 0, profile, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  expect(botSessionSchema.parse(session)).toEqual(session)
  for (const key of ['uid', 'path', 'display', 'command', 'secret'])
    expect(botSessionSchema.safeParse({ ...session, [key]: 'x' }).success).toBe(false)
  expect(sessionProfileSchema.safeParse({ ...profile, memoryMiB: 0 }).success).toBe(false)
  expect(botResultSchemas['bot.session.inspect'].parse(null)).toBeNull()
})
it('adds typed reads and a shared destination without changing the v1 envelope', () => {
  for (const [method, params] of [
    ['bot.session.inspect', { botId: 'bot' }],
    ['bot.sessions.list', { vmId: 'vm' }],
    ['bot.setup.preview', { destination: { kind: 'shared-vm', vmId: 'vm' } }],
  ]) expect(botRequestSchema.safeParse({ version: 1, id: 'request', method, params }).success).toBe(true)
  expect(botRequestSchema.safeParse({ version: 1, id: 'request', method: 'bot.session.inspect', params: { botId: 'bot', uid: 0 } }).success).toBe(false)
})
