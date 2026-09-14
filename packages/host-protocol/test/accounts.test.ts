import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { botRequestSchema, accountSchema, guestFrameSchema, BOT_SECRET_METHODS } from '../src/index.js'
it('connects accounts independently of bots and rejects renderer-supplied secrets or routing fields in metadata', () => {
  expect(botRequestSchema.parse({ version: 1, id: 'x', method: 'account.start', params: { accountId: 'account' } }).method).toBe('account.start')
  expect(botRequestSchema.safeParse({ version: 1, id: 'x', method: 'account.start', params: { botId: 'bot', accountId: 'account' } }).success).toBe(false)
  const time = new Date().toISOString()
  const account = { id: 'account', authorityHostId: randomUUID(), name: 'General', provider: 'codex', role: 'authority', status: { state: 'connected', provider: 'codex' }, available: true, isDefault: true, revision: 0, createdAt: time, updatedAt: time }
  expect(accountSchema.safeParse({ ...account, apiKey: 'secret' }).success).toBe(false)
  expect(accountSchema.safeParse({ ...account, status: { ...account.status, refreshToken: 'secret' } }).success).toBe(false)
  expect(BOT_SECRET_METHODS).toContain('account.setApiKey')
  expect(guestFrameSchema.safeParse({ type: 'account.request', id: 'x', forceRefresh: true, accountId: 'other' }).success).toBe(false)
  expect(guestFrameSchema.safeParse({ type: 'account.request', id: 'x', forceRefresh: true, botId: 'other' }).success).toBe(false)
})
