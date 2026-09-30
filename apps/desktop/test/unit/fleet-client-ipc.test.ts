import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import {
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_OFFLINE,
  FLEET_SCREEN_RESTART_REQUIRED,
} from '../../src/shared/fleet-targets'

const mocks = vi.hoisted(() => ({
  call: vi.fn(async (): Promise<unknown> => undefined),
  getImage: vi.fn(async () => ({ mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) })),
  screens: { openScreen: vi.fn(), send: vi.fn(), close: vi.fn(), writeClipboard: vi.fn(), readClipboard: vi.fn() },
}))
vi.mock('../../src/main/fleet/client/service', () => ({
  fleetClientService: {
    start: vi.fn(),
    stop: vi.fn(),
    getConnection: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getSnapshot: vi.fn(),
    refresh: vi.fn(),
    call: mocks.call,
    getImage: mocks.getImage,
    screens: mocks.screens,
    idempotencyKey: () => '550e8400-e29b-41d4-a716-446655440000',
  },
}))
import { registerFleetClientIpc } from '../../src/main/fleet/client/ipc'
import { FleetClientError } from '../../src/main/fleet/client/api'
import { GATEWAY_RESTART_TO_OPEN_SCREEN, GATEWAY_SCREEN_CONTROLLED } from '../../src/main/fleet/client/targets'

afterEach(() => {
  delete process.env.MAESTRLY_BOT_MODE
  vi.clearAllMocks()
})

describe('fleet IPC validation', () => {
  it('validates all login mutations before dispatch', () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar)
    const mutate = (channel: string, ...args: unknown[]) => mutations.get(channel)?.({}, ...args)
    expect(() => mutate('fleet:login:start', 'bot', { kind: 'grok', method: 'browser' })).toThrow()
    expect(() => mutate('fleet:login:code', 'bot', 'l1', '')).toThrow()
    expect(() => mutate('fleet:login:cancel', '../bot', 'l1')).toThrow()
    expect(() => mutate('fleet:login:open', 'bot', 'l1', 'arbitrary')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(reads.has('fleet:login:status')).toBe(true)
    for (const channel of ['fleet:login:start', 'fleet:login:code', 'fleet:login:cancel', 'fleet:login:open']) {
      expect(mutations.has(channel)).toBe(true)
      expect(reads.has(channel)).toBe(false)
    }
  })
  it('validates memory mutations before trusted dispatch and validates routine run ids', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
      on: () => {},
      mon: () => {},
    } as unknown as IpcRegistrar)
    const mutate = (channel: string, ...args: unknown[]) => mutations.get(channel)?.({}, ...args)
    expect(() => mutate('fleet:ownerMemoryCreate', { content: 'a'.repeat(501) })).toThrow()
    expect(() => mutate('fleet:ownerMemoryUpdate', 'm1', {})).toThrow()
    expect(() => mutate('fleet:ownerMemoryUpdate', 'm1', { status: 'superseded' })).toThrow()
    expect(() => mutate('fleet:patchBotMemory', 'scout', 'm1', {})).toThrow()
    expect(() => reads.get('fleet:listRoutineRuns')?.({}, '../bad', 'r1')).toThrow()
    expect(() => reads.get('fleet:listRoutineRuns')?.({}, 'scout', '')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await mutate('fleet:ownerMemoryCreate', { content: 'Prefer short answers.' })
    await mutate('fleet:ownerMemoryUpdate', 'm1', { status: 'archived' })
    await reads.get('fleet:listRoutineRuns')?.({}, 'scout', 'r1')
    await mutate('fleet:patchBotMemory', 'scout', 'm1', { pinned: true })
    expect(mocks.call.mock.calls).toEqual([
      [
        'ownerMemoryCreate',
        {
          body: {
            content: 'Prefer short answers.',
            environmentId: null,
            idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
          },
        },
      ],
      ['ownerMemoryPatch', { params: { mid: 'm1' }, body: { status: 'archived' } }],
      ['botRoutineRuns', { params: { id: 'scout', rid: 'r1' } }],
      ['botMemoryPatch', { params: { id: 'scout', mid: 'm1' }, body: { pinned: true } }],
    ])
    for (const channel of [
      'fleet:ownerMemoryCreate',
      'fleet:ownerMemoryUpdate',
      'fleet:ownerMemoryDelete',
      'fleet:patchBotMemory',
      'fleet:deleteBotMemory',
    ]) {
      expect(mutations.has(channel)).toBe(true)
      expect(reads.has(channel)).toBe(false)
    }
  })

  it('encodes validated image attachments in main and validates image ids', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args)
    const data = new Uint8Array([137, 80, 78, 71])
    await invoke('fleet:sendMessage', 'bot', '', [{ name: 'small.png', mediaType: 'image/png', data }])
    expect(mocks.call).toHaveBeenCalledWith('botMessageSend', {
      params: { id: 'bot' },
      body: {
        text: '',
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
        attachments: [{ name: 'small.png', mediaType: 'image/png', dataBase64: Buffer.from(data).toString('base64') }],
      },
    })
    expect(() => invoke('fleet:sendMessage', 'bot', '', [])).toThrow()
    expect(() =>
      invoke('fleet:sendMessage', 'bot', 'hello', [
        { name: 'bad.png', mediaType: 'image/png', data: new Uint8Array(5 * 1024 * 1024 + 1) },
      ])
    ).toThrow()
    await invoke('fleet:getImage', 'bot', 't-valid')
    expect(mocks.getImage).toHaveBeenCalledWith('bot', 't-valid')
    expect(() => invoke('fleet:getImage', 'bot', '../bad')).toThrow()
  })
  it('lists archived bots, and restores or deletes one only through trusted, validated calls', async () => {
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
      on: () => {},
      mon: () => {},
    } as unknown as IpcRegistrar)
    expect(reads.has('fleet:listArchivedBots')).toBe(true)
    // Restoring and deleting change the server: both go through the trusted-sender guard.
    expect(reads.has('fleet:restoreArchivedBot') || reads.has('fleet:deleteArchivedBot')).toBe(false)
    await reads.get('fleet:listArchivedBots')?.({ sender: {} })
    await mutations.get('fleet:restoreArchivedBot')?.({ sender: {} }, 'scout')
    await mutations.get('fleet:deleteArchivedBot')?.({ sender: {} }, 'scout')
    expect(mocks.call.mock.calls).toEqual([
      ['archivedBotsList', { query: { separateEnvironments: 1 } }],
      ['archivedBotRestore', { params: { id: 'scout' } }],
      ['archivedBotDelete', { params: { id: 'scout' } }],
    ])
    expect(() => mutations.get('fleet:deleteArchivedBot')?.({ sender: {} }, '../scout')).toThrow()
    expect(() => mutations.get('fleet:restoreArchivedBot')?.({ sender: {} }, undefined)).toThrow()
  })
  it('marks only a missing image as not found, so the UI can offer a retry for other failures', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args)
    mocks.getImage.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'Image not found'))
    await expect(invoke('fleet:getImage', 'bot', 't-gone')).rejects.toThrow('FLEET_IMAGE_NOT_FOUND')
    mocks.getImage.mockRejectedValueOnce(new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'Gateway unavailable'))
    await expect(invoke('fleet:getImage', 'bot', 't-later')).rejects.toThrow('Gateway unavailable')
  })
  it('rejects invalid bot IDs, creation bodies, actions, resolutions, and screen frames before dispatch', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)?.({ sender: {} }, ...args)
    expect(() => invoke('fleet:getBot', '../bad')).toThrow()
    expect(() => invoke('fleet:createBot', { name: '', instructions: '', ceiling: 'ask', talksTo: [] })).toThrow()
    expect(() => invoke('fleet:botAction', 'bot', 'delete')).toThrow()
    expect(() => invoke('fleet:resolveInteraction', 'bot', 'id', { kind: 'permission', reply: 'forever' })).toThrow()
    expect(() => invoke('fleet:screenSend', 'channel', 'text')).toThrow()
    expect(() => invoke('fleet:screenClipboardRead', '')).toThrow()
    mocks.screens.readClipboard.mockReturnValueOnce('host text')
    expect(invoke('fleet:screenClipboardRead', 'channel')).toBe('host text')
    expect(mocks.screens.readClipboard).toHaveBeenCalledWith({}, 'channel')
    expect(() => invoke('fleet:screenClipboardWrite', '', 'text')).toThrow()
    invoke('fleet:screenClipboardWrite', 'channel', 'copied text')
    expect(mocks.screens.writeClipboard).toHaveBeenCalledWith({}, 'channel', 'copied text')
    expect(mocks.call).not.toHaveBeenCalled()
    await invoke('fleet:createBot', { name: 'Valid', instructions: '', ceiling: 'ask', talksTo: [] })
    expect(mocks.call).toHaveBeenCalledWith('botsCreate', {
      body: {
        name: 'Valid',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      },
    })
  })
  it('validates conversation calls and returns only the operation result', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (botId: unknown, op: unknown, args: unknown) =>
      handlers.get('fleet:conversationCall')?.({ sender: {} }, botId, op, args)
    mocks.call.mockResolvedValueOnce({ result: { imageGen: true } })
    await expect(invoke('bot', 'chatGetConvTools', [])).resolves.toEqual({ imageGen: true })
    expect(mocks.call).toHaveBeenCalledWith('botConversationCall', {
      params: { id: 'bot' },
      body: { op: 'chatGetConvTools', args: [] },
    })
    expect(() => invoke('../bad', 'chatGetConvTools', [])).toThrow()
    expect(() => invoke('bot', 'unknown', [])).toThrow()
    expect(() => invoke('bot', 'chatGetConvTools', [1, 2, 3, 4, 5])).toThrow()
  })
  it('preserves a takeover conflict marker across IPC error serialization', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    mocks.call.mockRejectedValueOnce(new FleetClientError('CONFLICT', 409, 'Bot is finishing a step'))
    await expect(handlers.get('fleet:takeover')?.({ sender: {} }, 'bot')).rejects.toThrow('FLEET_TAKEOVER_CONFLICT')
  })
  it('calls only a control session on the shared display a screen conflict, among the 409s of a screen ticket', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const screenOpen = handlers.get('fleet:screenOpen')
    if (!screenOpen) throw new Error('fleet:screenOpen is not registered')
    const open = (mode: 'view' | 'control') =>
      (screenOpen({ sender: {} }, 'scout', mode) as Promise<unknown>).then(
        () => 'opened',
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
      )
    // Each refusal of the gateway's screen tickets as the Mac receives it, and what crosses IPC for it.
    const refusals: Array<[FleetClientError, string]> = [
      [new FleetClientError('CONFLICT', 409, GATEWAY_SCREEN_CONTROLLED), FLEET_SCREEN_CONFLICT],
      [new FleetClientError('CONFLICT', 409, GATEWAY_RESTART_TO_OPEN_SCREEN), FLEET_SCREEN_RESTART_REQUIRED],
      [new FleetClientError('BOT_NOT_RUNNING', 409, 'Bot not running'), FLEET_SCREEN_OFFLINE],
      [new FleetClientError('BOT_NOT_RUNNING', 409, 'Environment not running'), FLEET_SCREEN_OFFLINE],
      // Any other refusal keeps its own message and is never shown as a screen conflict.
      [
        new FleetClientError('CONFLICT', 409, 'Idempotency key used with different request'),
        'Idempotency key used with different request',
      ],
      [new FleetClientError('FORBIDDEN', 403, 'Takeover required for control'), 'Takeover required for control'],
    ]
    for (const mode of ['view', 'control'] as const)
      for (const [error, expected] of refusals) {
        mocks.screens.openScreen.mockRejectedValueOnce(error)
        await expect(open(mode)).resolves.toBe(expected)
      }
  })
  it('recognizes the screen refusals by the exact messages the gateway sends', () => {
    const gateway = readFileSync(new URL('../../../bot-gateway/src/screen.ts', import.meta.url), 'utf8')
    expect(gateway).toContain(`export const SCREEN_CONTROLLED = '${GATEWAY_SCREEN_CONTROLLED}'`)
    expect(gateway).toContain(`export const RESTART_TO_OPEN_SCREEN = '${GATEWAY_RESTART_TO_OPEN_SCREEN}'`)
    expect(gateway).toContain("throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')")
    expect(gateway).toContain("throw new GatewayError('BOT_NOT_RUNNING', 'Environment not running')")
  })
})
