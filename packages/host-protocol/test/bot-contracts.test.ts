import { describe, expect, it } from 'vitest'
import {
  BOT_SECRET_METHODS,
  botMethods,
  botRequestSchema,
  botResultSchemas,
  botSetupPreviewSchema,
  guestFrameSchema,
  hostFrameSchema,
  hostnameSchema,
  isExactHostname,
  networkPolicySchema,
  requestSchema,
  botMessageSchema,
  MESSAGE_CONTENT_MAX,
} from '../src/index.js'
const envelope = { version: 1, id: 'r' }
describe('bot wire contracts', () => {
  it('shares the v1 envelope and lists every bot method with a result schema', () => {
    expect(botMethods.length).toBeGreaterThan(30)
    for (const method of botMethods) expect(botResultSchemas[method]).toBeDefined()
    expect(requestSchema.safeParse({ ...envelope, method: 'bot.list', params: {} }).success).toBe(true)
    expect(requestSchema.safeParse({ version: 2, id: 'r', method: 'bot.list', params: {} }).success).toBe(false)
    expect(requestSchema.safeParse({ ...envelope, method: 'bot.exec', params: { command: 'ls' } }).success).toBe(false)
  })
  it('rejects arbitrary method strings, guest paths and shell inside params', () => {
    for (const [method, params] of [
      ['bot.messages.send', { botId: 'b', clientMessageId: 'c', content: 'hi', command: 'rm -rf /' }],
      ['bot.runtime.prepare', { botId: 'b', idempotencyKey: 'k', confirmBackup: false, confirmRestart: true }],
      ['bot.auth.start', { botId: 'b', method: 'apiKey' }],
      ['bot.setup.start', { idempotencyKey: 'k', previewId: 'p', inventoryRevision: '1', name: 'x', confirmations: { destination: true, permissions: false } }],
      ['bot.files.transferChunk', { transferId: 't', offset: 0, dataBase64: 'a'.repeat(70_000) }],
      ['bot.update', { botId: 'b', expectedRevision: 0, stateDirectory: '/tmp' }],
    ] as const)
      expect(botRequestSchema.safeParse({ ...envelope, method, params }).success, method).toBe(false)
    expect(
      botRequestSchema.parse({ ...envelope, method: 'bot.messages.send', params: { botId: 'b', clientMessageId: 'c', content: 'x' } })
        .params
    ).toMatchObject({ attachments: [] })
  })
  it('allows legitimate long chat content without diagnostic truncation limits', () => {
    const content = 'a'.repeat(MESSAGE_CONTENT_MAX)
    expect(
      botRequestSchema.safeParse({ ...envelope, method: 'bot.messages.send', params: { botId: 'b', clientMessageId: 'c', content } })
        .success
    ).toBe(true)
    expect(
      botMessageSchema.safeParse({
        id: 'm',
        conversationId: 'c',
        clientMessageId: 'k',
        role: 'assistant',
        content: '/home/maestrlybot/workspace/report.md written'.repeat(200),
        sequence: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      }).success
    ).toBe(true)
  })
  it('marks secret-bearing methods so journals never persist them', () => {
    expect(BOT_SECRET_METHODS).toContain('bot.auth.setApiKey')
    expect(botRequestSchema.safeParse({ ...envelope, method: 'bot.auth.setApiKey', params: { botId: 'b', apiKey: 'short' } }).success).toBe(false)
  })
})
describe('network policy', () => {
  it('accepts exact hostnames only', () => {
    for (const value of ['api.openai.com', 'Example.ORG']) expect(hostnameSchema.safeParse(value).success).toBe(true)
    expect(hostnameSchema.parse('Example.ORG')).toBe('example.org')
    for (const value of ['*.openai.com', '10.0.0.1', 'localhost', '127.0.0.1', '::1', 'a..b', 'host.', '-x.com', 'a', '1.2.3.4.5'])
      expect(isExactHostname(value.toLowerCase()), value).toBe(false)
    expect(networkPolicySchema.safeParse({ mode: 'allowlist', domains: ['example.com'], revision: 0 }).success).toBe(true)
    expect(networkPolicySchema.safeParse({ mode: 'any', domains: [], revision: 0 }).success).toBe(false)
  })
})
describe('guest channel frames', () => {
  it('requires a versioned hello with boot identity and nonce', () => {
    const hello = {
      type: 'hello',
      protocol: 'bot.runtime.v1',
      runtimeVersion: '0.1.0',
      bootId: '11111111-1111-4111-8111-111111111111',
      generation: 1,
      nonce: 'n'.repeat(32),
      capabilities: ['provider.codex'],
    }
    expect(guestFrameSchema.safeParse(hello).success).toBe(true)
    expect(guestFrameSchema.safeParse({ ...hello, protocol: 'bot.runtime.v2' }).success).toBe(false)
    expect(guestFrameSchema.safeParse({ ...hello, vmId: 'other-vm' }).success).toBe(false)
  })
  it('never accepts a generic exec request from host to guest', () => {
    expect(
      hostFrameSchema.safeParse({ type: 'request', id: '1', method: 'shell.exec', params: { command: 'id' } }).success
    ).toBe(false)
    expect(
      hostFrameSchema.safeParse({ type: 'request', id: '1', method: 'files.list', params: { path: '' } }).success
    ).toBe(true)
  })
})
it('setup preview exposes concrete recommended resources and human blockers', () => {
  const preview = {
    previewId: 'p',
    inventoryRevision: 'abc',
    hostId: '11111111-1111-4111-8111-111111111111',
    destination: { kind: 'new-vm', displayName: 'Mac mini' },
    profile: {
      templateId: 't',
      imageId: 'i',
      runtimeId: 'r',
      resources: { cpus: 2, memoryMiB: 4096, diskGiB: 24 },
      source: 'recommended',
      requirements: { minimum: { cpus: 2, memoryMiB: 3072, diskGiB: 20 }, recommended: { cpus: 2, memoryMiB: 4096, diskGiB: 24 } },
    },
    permissions: { mode: 'ask', summary: ['x'] },
    network: { mode: 'allowlist', domains: ['auth.openai.com'] },
    feasible: false,
    blockers: [{ code: 'CAPACITY_APPROVAL_REQUIRED', message: 'm', alternatives: [] }],
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  expect(botSetupPreviewSchema.safeParse(preview).success).toBe(true)
  expect(botSetupPreviewSchema.safeParse({ ...preview, blockers: [{ code: 'WHATEVER', message: 'm' }] }).success).toBe(false)
})
