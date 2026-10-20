import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import {
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_OFFLINE,
  FLEET_SCREEN_RESTART_REQUIRED,
  FLEET_SCREEN_UPDATE_REQUIRED,
} from '../../src/shared/fleet-targets'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_SERVER = 'bbbbbbbb-0000-4000-8000-000000000002'
const mocks = vi.hoisted(() => ({
  view: vi.fn((): unknown => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    installed: false,
    connection: { state: 'connected', url: 'https://bots.example' },
  })),
  hasFeature: vi.fn((_feature: string) => false),
  call: vi.fn(async (): Promise<unknown> => undefined),
  getImage: vi.fn(async () => ({ mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) })),
  downloadFile: vi.fn(async () => {}),
  cancelDownload: vi.fn(),
  getActiveDownload: vi.fn(() => null),
  attend: vi.fn(),
  revealDownload: vi.fn(),
  getDownload: vi.fn(async () => null),
  prepareMedia: vi.fn(async () => 'maestrly-media://fleet/bot/f-file/' + '0'.repeat(32)),
  screens: { openScreen: vi.fn(), send: vi.fn(), close: vi.fn(), writeClipboard: vi.fn(), readClipboard: vi.fn() },
  dictationEngine: vi.fn((): string => 'local'),
  dictationKey: vi.fn((_provider: string): string | null => null),
}))
vi.mock('../../src/main/fleet/client/download-notices', () => ({ setAttendedFleetFiles: mocks.attend }))
vi.mock('../../src/main/dictation/settings', () => ({
  getDictationEngine: mocks.dictationEngine,
  getDictationKey: mocks.dictationKey,
}))
vi.mock('../../src/main/fleet/client/service', () => ({
  fleetClientService: {
    serverId: 'aaaaaaaa-0000-4000-8000-000000000001',
    view: mocks.view,
    servers: () => {
      const view = mocks.view()
      return view ? [view] : []
    },
    start: vi.fn(),
    stop: vi.fn(),
    getConnection: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getSnapshot: vi.fn(),
    refresh: vi.fn(),
    call: mocks.call,
    hasFeature: mocks.hasFeature,
    getImage: mocks.getImage,
    downloadFile: mocks.downloadFile,
    cancelDownload: mocks.cancelDownload,
    getActiveDownload: mocks.getActiveDownload,
    revealDownload: mocks.revealDownload,
    getDownload: mocks.getDownload,
    prepareMedia: mocks.prepareMedia,
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
  it('accepts only bot and opaque file ids for downloads, without a renderer-selected destination', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar)
    const download = mutations.get('fleet:downloadFile')!
    expect(() => download({}, SERVER, '../bot', 'f-file')).toThrow()
    expect(() => download({}, SERVER, 'bot', '../../secret')).toThrow()
    expect(mocks.downloadFile).not.toHaveBeenCalled()
    await download({}, SERVER, 'bot', 'f-file', '/arbitrary/destination')
    expect(mocks.downloadFile).toHaveBeenCalledExactlyOnceWith('bot', 'f-file')
    const reveal = mutations.get('fleet:revealDownload')!
    expect(() => reveal({}, '/arbitrary/path')).toThrow()
    expect(mocks.revealDownload).not.toHaveBeenCalled()
    await reveal({}, '550e8400-e29b-41d4-a716-446655440000')
    expect(mocks.revealDownload).toHaveBeenCalledExactlyOnceWith('550e8400-e29b-41d4-a716-446655440000')
    const lookup = reads.get('fleet:getDownload')!
    expect(() => lookup({}, SERVER, '../bot', 'f-file')).toThrow()
    expect(() => lookup({}, SERVER, 'bot', '../file')).toThrow()
    await lookup({}, SERVER, 'bot', 'f-file')
    expect(mocks.getDownload).toHaveBeenCalledExactlyOnceWith('bot', 'f-file')
  })
  it('prepares videos only from trusted windows, by bot and opaque file id, and marks missing files', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar)
    expect(reads.has('fleet:prepareMedia')).toBe(false)
    const prepare = mutations.get('fleet:prepareMedia')!
    expect(() => prepare({}, SERVER, '../bot', 'f-file')).toThrow()
    expect(() => prepare({}, SERVER, 'bot', '../../secret')).toThrow()
    expect(mocks.prepareMedia).not.toHaveBeenCalled()
    await expect(prepare({}, SERVER, 'bot', 'f-file')).resolves.toMatch(/^maestrly-media:\/\/fleet\/bot\/f-file\//)
    expect(mocks.prepareMedia).toHaveBeenCalledExactlyOnceWith('bot', 'f-file')
    mocks.prepareMedia.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'gone'))
    await expect(prepare({}, SERVER, 'bot', 'f-file')).rejects.toThrow('FLEET_FILE_NOT_FOUND')
  })
  it('validates file ids to follow and cancel a transfer, and takes only valid lists of shown files', () => {
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar)
    // Canceling changes main's state, so it is guarded; following a transfer only reads it.
    const cancel = mutations.get('fleet:cancelDownload')!
    const active = reads.get('fleet:getActiveDownload')!
    expect(reads.has('fleet:cancelDownload')).toBe(false)
    expect(() => cancel({}, SERVER, '../bot', 'f-file')).toThrow()
    expect(() => active({}, SERVER, 'bot', '../file')).toThrow()
    cancel({}, SERVER, 'bot', 'f-file')
    active({}, SERVER, 'bot', 'f-file')
    expect(mocks.cancelDownload).toHaveBeenCalledExactlyOnceWith('bot', 'f-file')
    expect(mocks.getActiveDownload).toHaveBeenCalledExactlyOnceWith('bot', 'f-file')
    const attend = mutations.get('fleet:attendDownloads')!
    const sender = {}
    const file = { serverId: SERVER, botId: 'bot', fileId: 'f-file' }
    for (const invalid of [
      null,
      [{ ...file, botId: '../bot' }],
      [{ ...file, path: '/tmp' }],
      [{ botId: 'bot', fileId: 'f-file' }],
      [{ ...file, serverId: 'Server/1' }],
      Array.from({ length: 1_001 }, () => file),
    ])
      expect(() => attend({ sender }, invalid)).toThrow()
    expect(mocks.attend).not.toHaveBeenCalled()
    // Each shown file names its server: windows can show the files of several servers.
    attend({ sender }, [file])
    expect(mocks.attend).toHaveBeenCalledExactlyOnceWith(sender, [file])
  })
  it('refuses a call for a server this computer is not paired with, before it reaches a client', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const getBot = handlers.get('fleet:getBot')!
    expect(() => getBot({}, OTHER_SERVER, 'bot')).toThrow('FLEET_SERVER_UNKNOWN')
    expect(() => getBot({}, 'bot')).toThrow('FLEET_SERVER_UNKNOWN')
    mocks.view.mockReturnValueOnce(null)
    expect(() => getBot({}, SERVER, 'bot')).toThrow('FLEET_SERVER_UNKNOWN')
    expect(mocks.call).not.toHaveBeenCalled()
    await getBot({}, SERVER, 'bot')
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith('botGet', { params: { id: 'bot' } })
  })
  it('lists the paired servers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    expect(await handlers.get('fleet:servers')!({})).toEqual([mocks.view()])
    mocks.view.mockReturnValueOnce(null)
    expect(await handlers.get('fleet:servers')!({})).toEqual([])
  })
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
    expect(() => mutate('fleet:ownerMemoryCreate', SERVER, { content: 'a'.repeat(501) })).toThrow()
    expect(() => mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', {})).toThrow()
    expect(() => mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', { status: 'superseded' })).toThrow()
    expect(() => mutate('fleet:patchBotMemory', SERVER, 'scout', 'm1', {})).toThrow()
    expect(() => reads.get('fleet:listRoutineRuns')?.({}, SERVER, '../bad', 'r1')).toThrow()
    expect(() => reads.get('fleet:listRoutineRuns')?.({}, SERVER, 'scout', '')).toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    await mutate('fleet:ownerMemoryCreate', SERVER, { content: 'Prefer short answers.' })
    await mutate('fleet:ownerMemoryUpdate', SERVER, 'm1', { status: 'archived' })
    await reads.get('fleet:listRoutineRuns')?.({}, SERVER, 'scout', 'r1')
    await mutate('fleet:patchBotMemory', SERVER, 'scout', 'm1', { pinned: true })
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
    const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await invoke('fleet:sendMessage', SERVER, 'bot', '', [{ name: 'small.png', mediaType: 'image/png', data }])
    expect(mocks.call).toHaveBeenCalledWith('botMessageSend', {
      params: { id: 'bot' },
      body: {
        text: '',
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
        attachments: [
          {
            kind: 'image',
            name: 'small.png',
            mediaType: 'image/png',
            dataBase64: Buffer.from(data).toString('base64'),
          },
        ],
      },
    })
    expect(() => invoke('fleet:sendMessage', SERVER, 'bot', '', [])).toThrow()
    expect(() =>
      invoke('fleet:sendMessage', SERVER, 'bot', 'hello', [
        { name: 'bad.png', mediaType: 'image/png', data: new Uint8Array(5 * 1024 * 1024 + 1) },
      ])
    ).toThrow()
    await invoke('fleet:getImage', SERVER, 'bot', 't-valid')
    expect(mocks.getImage).toHaveBeenCalledWith('bot', 't-valid', null)
    await invoke('fleet:getImage', SERVER, 'bot', 't-valid', 'run-1')
    expect(mocks.getImage).toHaveBeenLastCalledWith('bot', 't-valid', 'run-1')
    expect(() => invoke('fleet:getImage', SERVER, 'bot', '../bad')).toThrow()
  })
  it('gates documents on gateway and bot support and rejects corrupt binary text', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const send = (data = new TextEncoder().encode('Olá')) =>
      handlers.get('fleet:sendMessage')?.({}, SERVER, 'bot', '', [
        { kind: 'text', name: 'code.ts', mediaType: 'text/plain', data },
      ])
    mocks.hasFeature.mockReturnValue(false)
    expect(() => send()).toThrow('FLEET_FILES_UNSUPPORTED')
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.hasFeature.mockReturnValue(true)
    mocks.call.mockResolvedValueOnce({ capabilities: [] })
    await expect(send()).rejects.toThrow('FLEET_FILES_UNSUPPORTED')
    expect(mocks.call).not.toHaveBeenCalledWith('botMessageSend', expect.anything())
    mocks.call.mockResolvedValueOnce({ capabilities: ['files'] })
    await send()
    expect(mocks.call).toHaveBeenCalledWith(
      'botMessageSend',
      expect.objectContaining({
        body: expect.objectContaining({
          text: '',
          attachments: [
            {
              kind: 'text',
              name: 'code.ts',
              mediaType: 'text/plain',
              dataBase64: Buffer.from('Olá').toString('base64'),
            },
          ],
        }),
      })
    )
    expect(() => send(new Uint8Array([0xff]))).toThrow('FLEET_ATTACHMENT_INVALID')
    expect(() => send(new Uint8Array([0]))).toThrow('FLEET_ATTACHMENT_INVALID')
    mocks.hasFeature.mockReturnValue(false)
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
    await reads.get('fleet:listArchivedBots')?.({ sender: {} }, SERVER)
    await mutations.get('fleet:restoreArchivedBot')?.({ sender: {} }, SERVER, 'scout')
    await mutations.get('fleet:deleteArchivedBot')?.({ sender: {} }, SERVER, 'scout')
    expect(mocks.call.mock.calls).toEqual([
      ['archivedBotsList', { query: { separateEnvironments: 1 } }],
      ['archivedBotRestore', { params: { id: 'scout' } }],
      ['archivedBotDelete', { params: { id: 'scout' } }],
    ])
    expect(() => mutations.get('fleet:deleteArchivedBot')?.({ sender: {} }, SERVER, '../scout')).toThrow()
    expect(() => mutations.get('fleet:restoreArchivedBot')?.({ sender: {} }, SERVER, undefined)).toThrow()
  })
  it('marks only a missing image as not found, so the UI can offer a retry for other failures', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args)
    mocks.getImage.mockRejectedValueOnce(new FleetClientError('NOT_FOUND', 404, 'Image not found'))
    await expect(invoke('fleet:getImage', SERVER, 'bot', 't-gone')).rejects.toThrow('FLEET_IMAGE_NOT_FOUND')
    mocks.getImage.mockRejectedValueOnce(new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'Gateway unavailable'))
    await expect(invoke('fleet:getImage', SERVER, 'bot', 't-later')).rejects.toThrow('Gateway unavailable')
  })
  it('rejects invalid bot IDs, creation bodies, actions, resolutions, and screen frames before dispatch', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)?.({ sender: {} }, ...args)
    expect(() => invoke('fleet:getBot', SERVER, '../bad')).toThrow()
    expect(() =>
      invoke('fleet:createBot', SERVER, { name: '', instructions: '', ceiling: 'ask', talksTo: [] })
    ).toThrow()
    expect(() => invoke('fleet:botAction', SERVER, 'bot', 'delete')).toThrow()
    expect(() =>
      invoke('fleet:resolveInteraction', SERVER, 'bot', 'id', { kind: 'permission', reply: 'forever' })
    ).toThrow()
    expect(() => invoke('fleet:screenSend', 'channel', 'text')).toThrow()
    expect(() => invoke('fleet:screenClipboardRead', '')).toThrow()
    mocks.screens.readClipboard.mockResolvedValueOnce('host text')
    await expect(invoke('fleet:screenClipboardRead', 'channel')).resolves.toBe('host text')
    expect(mocks.screens.readClipboard).toHaveBeenCalledWith({}, 'channel')
    mocks.screens.readClipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await expect(invoke('fleet:screenClipboardRead', 'channel')).rejects.toThrow('Clipboard unavailable')
    expect(() => invoke('fleet:screenClipboardWrite', '', 'text')).toThrow()
    mocks.screens.writeClipboard.mockResolvedValueOnce(undefined)
    await expect(invoke('fleet:screenClipboardWrite', 'channel', 'copied text')).resolves.toBeUndefined()
    expect(mocks.screens.writeClipboard).toHaveBeenCalledWith({}, 'channel', 'copied text')
    mocks.screens.writeClipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await expect(invoke('fleet:screenClipboardWrite', 'channel', 'failed copy')).rejects.toThrow(
      'Clipboard unavailable'
    )
    expect(mocks.call).not.toHaveBeenCalled()
    await invoke('fleet:createBot', SERVER, { name: 'Valid', instructions: '', ceiling: 'ask', talksTo: [] })
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
      handlers.get('fleet:conversationCall')?.({ sender: {} }, SERVER, botId, op, args)
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
    await expect(handlers.get('fleet:takeover')?.({ sender: {} }, SERVER, 'bot')).rejects.toThrow(
      'FLEET_TAKEOVER_CONFLICT'
    )
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
    // A gateway that streams screens as video.
    mocks.hasFeature.mockReturnValue(true)
    const open = (mode: 'view' | 'control') =>
      (screenOpen({ sender: {} }, SERVER, 'scout', mode) as Promise<unknown>).then(
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
  it('creates a pairing code for a phone only on a gateway that offers it', async () => {
    process.env.MAESTRLY_BOT_MODE = '1'
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: () => {},
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
      on: () => {},
      mon: () => {},
    } as unknown as IpcRegistrar)
    const create = mutations.get('fleet:createPairing')!
    mocks.hasFeature.mockReturnValue(false)
    await expect(create({}, SERVER)).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      message: 'Update the bot server to pair a phone',
    })
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.hasFeature.mockReturnValue(true)
    await create({}, SERVER)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith('pairingsCreate', { body: {} })
    mocks.hasFeature.mockReturnValue(false)
  })

  it('lists and removes paired devices only on a gateway that offers it', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const list = handlers.get('fleet:devices')!
    const revoke = handlers.get('fleet:revokeDevice')!
    mocks.call.mockClear()
    mocks.hasFeature.mockReturnValue(false)
    await expect(async () => list({}, SERVER)).rejects.toThrow('FLEET_DEVICES_UNSUPPORTED')
    await expect(async () => revoke({}, SERVER, 'device-2')).rejects.toThrow('FLEET_DEVICES_UNSUPPORTED')
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.hasFeature.mockReturnValue(true)
    await list({}, SERVER)
    await revoke({}, SERVER, 'device-2')
    expect(mocks.call.mock.calls).toEqual([['devicesList'], ['deviceRevoke', { params: { deviceId: 'device-2' } }]])
    await expect(async () => revoke({}, SERVER, '')).rejects.toThrow()
    mocks.hasFeature.mockReturnValue(false)
  })

  it('refuses screens on gateways without video screens', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetClientIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    const open = (target: unknown) => handlers.get('fleet:screenOpen')!({ sender: {} }, SERVER, target, 'view')
    mocks.hasFeature.mockImplementation((feature: string) => feature === 'environments')
    for (const target of ['scout', { botId: 'scout', surface: 'apps' }, { environmentId: 'work' }])
      expect(() => open(target)).toThrow(FLEET_SCREEN_UPDATE_REQUIRED)
    expect(mocks.screens.openScreen).not.toHaveBeenCalled()
    mocks.hasFeature.mockImplementation((feature: string) => ['environments', 'video-screens'].includes(feature))
    mocks.screens.openScreen.mockResolvedValueOnce({ channelId: 'c1' })
    await expect(open('scout')).resolves.toEqual({ channelId: 'c1' })
    mocks.hasFeature.mockReset()
    mocks.hasFeature.mockReturnValue(false)
  })
  it('recognizes the screen refusals by the exact messages the gateway sends', () => {
    const gateway = readFileSync(new URL('../../../bot-gateway/src/screen.ts', import.meta.url), 'utf8')
    expect(gateway).toContain(`export const SCREEN_CONTROLLED = '${GATEWAY_SCREEN_CONTROLLED}'`)
    expect(gateway).toContain(`export const RESTART_TO_OPEN_SCREEN = '${GATEWAY_RESTART_TO_OPEN_SCREEN}'`)
    expect(gateway).toContain("throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')")
    expect(gateway).toContain("throw new GatewayError('BOT_NOT_RUNNING', 'Environment not running')")
  })
})

describe('fleet dictation IPC', () => {
  afterEach(() => {
    mocks.hasFeature.mockImplementation(() => false)
    mocks.dictationEngine.mockImplementation(() => 'local')
    mocks.dictationKey.mockImplementation(() => null)
  })
  const register = () => {
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const reads = new Map<string, (...args: unknown[]) => unknown>()
    registerFleetClientIpc({
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar)
    return { mutations, reads }
  }

  it('reads nothing from a server that lacks dictation', async () => {
    mocks.hasFeature.mockImplementation(() => false)
    const { reads } = register()
    expect(await reads.get('fleet:dictation')!({}, SERVER)).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("reads the server's dictation state", async () => {
    mocks.hasFeature.mockImplementation((feature) => feature === 'dictation')
    mocks.call.mockResolvedValueOnce({ configured: false, provider: null, keyHint: null })
    const { reads } = register()
    expect(await reads.get('fleet:dictation')!({}, SERVER)).toEqual({
      configured: false,
      provider: null,
      keyHint: null,
    })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith('dictationGet')
  })

  it("sends this computer's engine and key to the server", async () => {
    mocks.hasFeature.mockImplementation((feature) => feature === 'dictation')
    mocks.dictationEngine.mockReturnValue('openai')
    mocks.dictationKey.mockImplementation((provider) => (provider === 'openai' ? 'sk-x' : null))
    const { mutations } = register()
    await mutations.get('fleet:dictationUseLocal')!({}, SERVER)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith('dictationKeySet', {
      body: { provider: 'openai', key: 'sk-x' },
    })
  })

  it('sends nothing without a key on this computer', async () => {
    mocks.hasFeature.mockImplementation((feature) => feature === 'dictation')
    const { mutations } = register()
    mocks.dictationEngine.mockReturnValue('local')
    mocks.dictationKey.mockReturnValue('sk-x')
    await expect(async () => mutations.get('fleet:dictationUseLocal')!({}, SERVER)).rejects.toThrow(
      'No dictation key on this computer'
    )
    mocks.dictationEngine.mockReturnValue('groq')
    mocks.dictationKey.mockReturnValue(null)
    await expect(async () => mutations.get('fleet:dictationUseLocal')!({}, SERVER)).rejects.toThrow(
      'No dictation key on this computer'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("removes the server's key, and refuses on a server without dictation", async () => {
    mocks.hasFeature.mockImplementation((feature) => feature === 'dictation')
    const { mutations } = register()
    await mutations.get('fleet:dictationRemove')!({}, SERVER)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith('dictationKeyDelete')
    mocks.hasFeature.mockImplementation(() => false)
    await expect(async () => mutations.get('fleet:dictationRemove')!({}, SERVER)).rejects.toThrow(
      'Update the bot server to dictate from the phone'
    )
  })
})
