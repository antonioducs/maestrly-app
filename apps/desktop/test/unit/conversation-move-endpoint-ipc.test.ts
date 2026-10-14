import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import {
  MOVE_ENDPOINT_METHODS,
  MOVE_ENDPOINT_PROGRESS,
  type MoveEndpoint,
  moveEndpointChannel,
} from '../../src/main/conversation-move/endpoint'
import { registerConversationMoveEndpointIpc } from '../../src/main/conversation-move/endpoint-ipc'
import { createPackageRelay } from '../../src/main/conversation-move/relay'
import { createRemoteMoveEndpoint } from '../../src/main/conversation-move/remote-endpoint'
import type { HostTransferEngine } from '../../src/main/host-transfers/engine'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { registerRemoteUiTarget } from '../../src/main/remote-ui-targets'
import type { ExportedPackage, MoveEndpointProgress } from '../../src/shared/conversation-move'
import type { HostTransferView } from '../../src/shared/host-transfers'
import { remoteChannelRefusal } from '../../src/shared/host-channels'

const OP = '8b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const REMOTE = 'server-1/env-1'
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function setup() {
  const handlers: Record<string, Handler> = {}
  const reg = {
    handle: vi.fn(),
    on: vi.fn(),
    mon: vi.fn(),
    mhandle: (channel: string, fn: Handler) => {
      handlers[channel] = fn
    },
  } as unknown as IpcRegistrar
  const listeners = new Set<(progress: MoveEndpointProgress) => void>()
  const methods = Object.fromEntries(
    MOVE_ENDPOINT_METHODS.map((method) => [method, vi.fn<(input: unknown) => Promise<unknown>>(async () => method)])
  ) as Record<(typeof MOVE_ENDPOINT_METHODS)[number], Mock<(input: unknown) => Promise<unknown>>>
  const onProgress: MoveEndpoint['onProgress'] = (_operationId, listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const endpoint = { ...methods, onProgress }
  registerConversationMoveEndpointIpc(reg, { hostId: 'local', ...endpoint } as unknown as MoveEndpoint)
  return { handlers, endpoint, listeners }
}

const remoteSender = () => {
  const sender = { id: -1, send: vi.fn(), isDestroyed: () => false }
  return { sender, unregister: registerRemoteUiTarget(sender, { role: 'main' }) }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('conversation move endpoint channels', () => {
  it('names one channel per method, all reachable through a host bridge', () => {
    const { handlers } = setup()
    expect(moveEndpointChannel('inspectSource')).toBe('conversation-move-endpoint:inspect-source')
    expect(moveEndpointChannel('prepareTargetWorkspace')).toBe('conversation-move-endpoint:prepare-target-workspace')
    expect(Object.keys(handlers).sort()).toEqual(MOVE_ENDPOINT_METHODS.map(moveEndpointChannel).sort())
    for (const channel of Object.keys(handlers)) expect(remoteChannelRefusal(channel)).toBeNull()
  })

  it('refuses a local sender', async () => {
    const { handlers, endpoint } = setup()
    await expect(
      handlers['conversation-move-endpoint:inspect-source']({ sender: { send: vi.fn() } }, { conversationId: 'c' })
    ).rejects.toMatchObject({ code: 'remote-only' })
    expect(endpoint.inspectSource).not.toHaveBeenCalled()
  })

  it('runs a remote sender call with validated input and streams progress to it', async () => {
    const { handlers, endpoint, listeners } = setup()
    const { sender, unregister } = remoteSender()
    cleanups.push(unregister)
    const input = {
      operationId: OP,
      packagePath: '/srv/conversation-moves/x/conv.maestrly-move',
      sha256: 'a'.repeat(64),
      workspaceId: 'ws-1',
      plan: {
        workspace: { kind: 'existing', workspaceId: 'ws-1', name: 'repo', path: '/srv/repo' },
        branch: 'feat',
        branchAction: 'create',
      },
    }
    endpoint.importTarget.mockImplementationOnce(async () => {
      for (const listener of listeners) listener({ operationId: OP, step: 'import', phase: 'git' })
      return 'imported'
    })
    await expect(handlers['conversation-move-endpoint:import-target']({ sender }, input)).resolves.toBe('imported')
    expect(endpoint.importTarget).toHaveBeenCalledWith(input)
    expect(sender.send).toHaveBeenCalledWith(MOVE_ENDPOINT_PROGRESS, { operationId: OP, step: 'import', phase: 'git' })
    // The subscription ends with the call.
    expect(listeners.size).toBe(0)
  })

  it('rejects malformed input', async () => {
    const { handlers, endpoint } = setup()
    const { sender, unregister } = remoteSender()
    cleanups.push(unregister)
    await expect(
      handlers['conversation-move-endpoint:release-source']({ sender }, { operationId: 'not-a-uuid' })
    ).rejects.toThrow(/Invalid releaseSource input/)
    await expect(
      handlers['conversation-move-endpoint:inspect-source']({ sender }, { conversationId: 'c', extra: true })
    ).rejects.toThrow(/Invalid inspectSource input/)
    expect(endpoint.releaseSource).not.toHaveBeenCalled()
  })

  it('maps every method of the remote endpoint to its channel and filters progress by operation', async () => {
    const call = vi.fn(async (channel: string) => channel)
    const eventListeners = new Set<(hostId: string, channel: string, args: unknown[]) => void>()
    const remote = createRemoteMoveEndpoint(REMOTE, {
      call,
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
    })
    for (const method of MOVE_ENDPOINT_METHODS) {
      await expect((remote[method] as (input: unknown) => Promise<unknown>)({ operationId: OP })).resolves.toBe(
        moveEndpointChannel(method)
      )
    }
    expect(call).toHaveBeenCalledTimes(MOVE_ENDPOINT_METHODS.length)
    const seen: MoveEndpointProgress[] = []
    const off = remote.onProgress(OP, (progress) => seen.push(progress))
    const emit = (hostId: string, channel: string, progress: unknown) => {
      for (const listener of eventListeners) listener(hostId, channel, [progress])
    }
    emit(REMOTE, MOVE_ENDPOINT_PROGRESS, { operationId: OP, step: 'clone', percent: 10 })
    emit('other/host', MOVE_ENDPOINT_PROGRESS, { operationId: OP, step: 'clone', percent: 20 })
    emit(REMOTE, MOVE_ENDPOINT_PROGRESS, { operationId: 'other', step: 'clone', percent: 30 })
    emit(REMOTE, 'chat:delta', { operationId: OP })
    off()
    emit(REMOTE, MOVE_ENDPOINT_PROGRESS, { operationId: OP, step: 'clone', percent: 40 })
    expect(seen).toEqual([{ operationId: OP, step: 'clone', percent: 10 }])
  })

  it('reports a lost bridge as an unavailable host and keeps the host refusals', async () => {
    const lost = createRemoteMoveEndpoint(REMOTE, {
      call: async () => {
        throw Object.assign(new Error('The connection to the server was lost.'), { code: 'connection-lost' })
      },
      onEvent: () => () => {},
    })
    await expect(lost.verifyTarget({ operationId: OP })).rejects.toMatchObject({ code: 'host-unavailable' })
    const refused = createRemoteMoveEndpoint(REMOTE, {
      call: async () => {
        throw Object.assign(new Error('The destination branch moved.'), { code: 'branch-changed' })
      },
      onEvent: () => () => {},
    })
    await expect(refused.importTarget({} as never)).rejects.toMatchObject({ code: 'branch-changed' })
  })
})

describe('conversation move package relay', () => {
  const pkg = {
    path: '/src/staging/conv.maestrly-move',
    name: 'conv.maestrly-move',
    size: 10,
    sha256: 'a'.repeat(64),
  } as ExportedPackage
  const view = (overrides: Partial<HostTransferView>): HostTransferView =>
    ({
      id: 't',
      state: 'done',
      size: 10,
      doneBytes: 10,
      sha256: pkg.sha256,
      error: null,
      errorMessage: null,
      ...overrides,
    }) as HostTransferView

  function fakeEngine(settle: (id: string) => HostTransferView) {
    const engine = {
      download: vi.fn(async () => 'down'),
      upload: vi.fn(async () => ({ queued: ['up'], skipped: [] })),
      whenSettled: vi.fn(async (id: string, onProgress?: (view: HostTransferView) => void) => {
        onProgress?.(view({ id, state: 'running', doneBytes: 5 }))
        return settle(id)
      }),
    }
    return engine as typeof engine & HostTransferEngine
  }
  const args = (from: string, to: string) => ({
    operationId: OP,
    from,
    to,
    pkg,
    targetDirectory: to === 'local' ? null : '/home/maestrly/.config/Maestrly/conversation-moves/x',
    localDirectory: '/local/staging',
    onProgress: vi.fn(),
  })

  it('uploads from this computer, replacing what an interrupted attempt left', async () => {
    const engine = fakeEngine((id) =>
      view({ id, remotePath: '/home/maestrly/.config/Maestrly/conversation-moves/x/conv.maestrly-move' })
    )
    const call = args('local', REMOTE)
    const moved = await createPackageRelay(() => engine)(call)
    expect(engine.upload).toHaveBeenCalledWith(REMOTE, [pkg.path], call.targetDirectory, true)
    expect(moved).toEqual({
      path: '/home/maestrly/.config/Maestrly/conversation-moves/x/conv.maestrly-move',
      transferIds: ['up'],
    })
    expect(call.onProgress).toHaveBeenCalledWith({ doneBytes: 5, size: 10 })
  })

  it('downloads into this computer and relays between two hosts', async () => {
    const engine = fakeEngine((id) =>
      id === 'down'
        ? view({ id, localPath: '/local/staging/conv.maestrly-move' })
        : view({ id, remotePath: '/other/conv.maestrly-move' })
    )
    const relay = createPackageRelay(() => engine)
    expect(await relay(args(REMOTE, 'local'))).toEqual({
      path: '/local/staging/conv.maestrly-move',
      transferIds: ['down'],
    })
    expect(engine.download).toHaveBeenCalledWith(REMOTE, pkg.path, 'save', { directory: '/local/staging' })
    expect(await relay(args(REMOTE, 'other-server/env-2'))).toEqual({
      path: '/other/conv.maestrly-move',
      transferIds: ['down', 'up'],
    })
    expect(engine.upload).toHaveBeenLastCalledWith(
      'other-server/env-2',
      ['/local/staging/conv.maestrly-move'],
      expect.any(String),
      true
    )
  })

  it('fails a transfer that did not finish or changed the package', async () => {
    const failed = fakeEngine((id) => view({ id, state: 'failed', error: 'disk-full', errorMessage: null }))
    await expect(createPackageRelay(() => failed)(args('local', REMOTE))).rejects.toMatchObject({
      code: 'transfer-failed',
      message: 'disk-full',
    })
    const changed = fakeEngine((id) => view({ id, remotePath: '/x', sha256: 'b'.repeat(64) }))
    await expect(createPackageRelay(() => changed)(args('local', REMOTE))).rejects.toMatchObject({
      code: 'transfer-failed',
    })
    await expect(createPackageRelay(() => null)(args('local', REMOTE))).rejects.toMatchObject({
      code: 'host-unavailable',
    })
  })
})
