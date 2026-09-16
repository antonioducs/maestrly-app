import { describe, expect, it } from 'vitest'
import {
  BOT_DESKTOP_METHODS,
  BOT_MUTATIONS,
  BOT_SECRET_METHODS,
  botMethods,
  botRequestSchema,
  botResultSchemas,
  desktopAttachRequestSchema,
  desktopInputBatchSchema,
  desktopOperationSchema,
  desktopStateSchema,
  mediaOpenSchema,
  mediaWelcomeSchema,
  requestSchema,
  vmDesktopInfoSchema,
  vmRequestSchema,
} from '../src/index.js'

const token = 'a'.repeat(64)
const state = {
  botId: 'bot',
  sessionId: '6dc3300d-5547-4e38-8caf-89a229f29bd8',
  revision: 1,
  controlEpoch: 2,
  mode: 'human',
  desktopGeneration: 'gen-1',
  width: 1280,
  height: 800,
  controlled: true,
  viewers: 1,
  capabilities: ['desktop.live.v1', 'desktop.handoff.v1'],
  available: true,
  updatedAt: '2026-09-14T10:00:00.000Z',
}
const request = (method: string, params: unknown) => botRequestSchema.safeParse({ version: 1, id: 'r', method, params })

describe('desktop contracts', () => {
  it('declares every desktop method with an exhaustive result schema and keeps it off the renderer bridge', () => {
    const desktop = botMethods.filter((method) => method.startsWith('bot.desktop.'))
    expect(desktop).toEqual([
      'bot.desktop.inspect', 'bot.desktop.open', 'bot.desktop.close', 'bot.desktop.acquire',
      'bot.desktop.operation.get', 'bot.desktop.operation.lookup', 'bot.desktop.claimControl',
      'bot.desktop.renew', 'bot.desktop.input', 'bot.desktop.return',
    ])
    for (const method of desktop) expect(botResultSchemas[method]).toBeDefined()
    expect(BOT_DESKTOP_METHODS).toEqual(desktop)
    for (const method of ['bot.desktop.open', 'bot.desktop.claimControl', 'bot.desktop.renew', 'bot.desktop.input', 'bot.desktop.return'])
      expect(BOT_SECRET_METHODS).toContain(method)
    expect(BOT_MUTATIONS).toContain('bot.desktop.acquire')
    // The public wire keeps envelope v1 and accepts desktop methods.
    expect(requestSchema.safeParse({ version: 1, id: 'x', method: 'bot.desktop.inspect', params: { botId: 'b' } }).success).toBe(true)
    expect(requestSchema.safeParse({ version: 2, id: 'x', method: 'bot.desktop.inspect', params: { botId: 'b' } }).success).toBe(false)
  })
  it('public state carries no sockets, PIDs, paths or tokens', () => {
    expect(desktopStateSchema.parse(state)).toEqual(state)
    for (const extra of [{ socketPath: '/run/x' }, { pid: 3 }, { mediaTicket: token }, { controlCapability: token }])
      expect(desktopStateSchema.safeParse({ ...state, ...extra }).success).toBe(false)
    expect(desktopOperationSchema.safeParse({ id: 'o', botId: 'b', sessionId: state.sessionId, kind: 'acquire', status: 'failed', phase: 'failed', controlEpoch: 3, failureCode: 'HANDOFF_UNCERTAIN', createdAt: state.updatedAt, updatedAt: state.updatedAt }).success).toBe(true)
    expect(desktopOperationSchema.safeParse({ id: 'o', botId: 'b', sessionId: state.sessionId, kind: 'acquire', status: 'failed', phase: 'failed', controlEpoch: 3, failureCode: 'lower case', createdAt: state.updatedAt, updatedAt: state.updatedAt }).success).toBe(false)
  })
  it('bounds input batches, text, coordinates and wheel steps', () => {
    const key = { kind: 'key', code: 'KeyA', keysym: 0x61, down: true }
    expect(desktopInputBatchSchema.safeParse([key, { kind: 'pointer', x: 4095, y: 0 }, { kind: 'text', text: 'ação €' }, { kind: 'releaseAll' }]).success).toBe(true)
    expect(desktopInputBatchSchema.safeParse(Array.from({ length: 65 }, () => key)).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'text', text: 'x'.repeat(4097) }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'text', text: 'x'.repeat(3000) }, { kind: 'text', text: 'y'.repeat(1200) }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'text', text: 'a\u0000b' }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'text', text: 'linha\n' }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'text', text: 'tab\u009b' }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'pointer', x: 4096, y: 0 }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'pointer', x: -1, y: 0 }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 11 }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ ...key, extra: true }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'exec', command: 'rm' }]).success).toBe(false)
    expect(desktopInputBatchSchema.safeParse([{ kind: 'key', code: 'Key A;', keysym: 1, down: true }]).success).toBe(false)
  })
  it('requires capabilities and exact generations on input and never accepts renderer-chosen targets', () => {
    const base = { viewId: 'v', controlCapability: token, controlEpoch: 1, desktopGeneration: 'g', sequence: 0, events: [{ kind: 'releaseAll' }] }
    expect(request('bot.desktop.input', base).success).toBe(true)
    expect(request('bot.desktop.input', { ...base, controlCapability: 'short' }).success).toBe(false)
    expect(request('bot.desktop.input', { ...base, sessionId: state.sessionId }).success).toBe(false)
    expect(request('bot.desktop.input', { ...base, vmId: 'vm' }).success).toBe(false)
    expect(request('bot.desktop.open', { botId: 'b', clientInstanceId: 'c', display: ':10' }).success).toBe(false)
    expect(request('bot.desktop.return', { botId: 'b', expectedRevision: 1, idempotencyKey: 'k', continueTask: true }).success).toBe(true)
    expect(request('bot.desktop.return', { expectedRevision: 1, idempotencyKey: 'k', continueTask: true }).success).toBe(false)
  })
  it('keeps supervisor desktop requests fixed and scoped to session, generation and epoch', () => {
    const scope = { sessionId: state.sessionId, generation: 1, epoch: 1 }
    const vm = (method: string, params: unknown) => vmRequestSchema.safeParse({ type: 'vm.request', id: 'i', method, params })
    expect(vm('desktop.input', { ...scope, desktopGeneration: 'g', sequence: 1, events: [{ kind: 'pointer', x: 1, y: 1 }] }).success).toBe(true)
    expect(vm('desktop.input', { ...scope, epoch: 0, desktopGeneration: 'g', sequence: 1, events: [{ kind: 'pointer', x: 1, y: 1 }] }).success).toBe(false)
    expect(vm('desktop.viewer.open', { sessionId: state.sessionId, generation: 1, grantId: 'not-a-uuid' }).success).toBe(false)
    expect(vm('desktop.exec', { ...scope, command: ['sh'] }).success).toBe(false)
    expect(vm('desktop.capture', { ...scope, observationId: '6dc3300d-5547-4e38-8caf-89a229f29bd8', path: '/etc/shadow' }).success).toBe(false)
    expect(vmDesktopInfoSchema.safeParse({ sessionId: state.sessionId, mode: 'human', epoch: 3, width: 1280, height: 800, automation: 'stopped', services: 'running', viewers: 1, capabilities: [] }).success).toBe(true)
  })
  it('attach and media control payloads accept only exact tokens and identities', () => {
    expect(desktopAttachRequestSchema.safeParse({ version: 1, ticket: token }).success).toBe(true)
    expect(desktopAttachRequestSchema.safeParse({ version: 1, ticket: token, host: 'evil' }).success).toBe(false)
    expect(desktopAttachRequestSchema.safeParse({ version: 1, ticket: 'A'.repeat(64) }).success).toBe(false)
    expect(mediaOpenSchema.safeParse({ sessionId: state.sessionId, generation: 1, grantId: state.sessionId, port: 5900 }).success).toBe(false)
    expect(mediaWelcomeSchema.safeParse({ protocol: 'bot.desktop.v1', nonce: state.sessionId, hostId: 'host', hostGeneration: 1 }).success).toBe(false)
  })
})
