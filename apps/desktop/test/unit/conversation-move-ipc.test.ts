import { describe, expect, it, vi } from 'vitest'
import { registerConversationMoveIpc } from '../../src/main/conversation-move/ipc'
import type { ConversationMoveService } from '../../src/main/conversation-move/service'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { makeConversationMoveApi } from '../../src/preload/api-conversation-move'
import type { MoveChangedEvent } from '../../src/shared/conversation-move'

const REMOTE = 'server-1/env-1'
const OP = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup() {
  const handlers: Record<string, Handler> = {}
  const record = (channel: string, fn: Handler) => {
    handlers[channel] = fn
  }
  const reg = { handle: record, mhandle: record, on: vi.fn(), mon: vi.fn() } as unknown as IpcRegistrar
  let changed: ((event: MoveChangedEvent) => void) | null = null
  const service = {
    prepare: vi.fn(async () => ({ operationId: OP })),
    execute: vi.fn(async () => ({ operationId: OP, status: 'completed' })),
    cancel: vi.fn(async () => undefined),
    resolve: vi.fn(async () => ({ operationId: OP, status: 'rolled-back' })),
    listRecoveries: vi.fn(() => []),
    onChanged: vi.fn((listener: (event: MoveChangedEvent) => void) => {
      changed = listener
      return () => {
        changed = null
      }
    }),
  }
  const emitChanged = vi.fn()
  const dispose = registerConversationMoveIpc(reg, {
    service: service as unknown as ConversationMoveService,
    emitChanged,
  })
  return { handlers, service, emitChanged, dispose, change: (event: MoveChangedEvent) => changed?.(event) }
}

describe('conversation move IPC', () => {
  it('validates prepare input and forwards it', async () => {
    const { handlers, service } = setup()
    expect(() => handlers['conversation-move:prepare']({}, { conversationId: '' })).toThrow(/Invalid payload/)
    await handlers['conversation-move:prepare'](
      {},
      { sourceHostId: 'local', conversationId: 'c1', targetHostId: REMOTE }
    )
    expect(service.prepare).toHaveBeenCalledWith({ sourceHostId: 'local', conversationId: 'c1', targetHostId: REMOTE })
    await handlers['conversation-move:prepare'](
      {},
      { sourceHostId: REMOTE, conversationId: 'c1', targetHostId: 'local', targetBranch: 'feat-2' }
    )
    expect(service.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ targetBranch: 'feat-2' }))
  })

  it('validates execute, cancel and resolve', async () => {
    const { handlers, service } = setup()
    expect(() => handlers['conversation-move:execute']({}, { operationId: 'x', selectedIgnoredPaths: [] })).toThrow(
      /Invalid payload/
    )
    await handlers['conversation-move:execute']({}, { operationId: OP, selectedIgnoredPaths: ['.env'] })
    expect(service.execute).toHaveBeenCalledWith({
      operationId: OP,
      selectedIgnoredPaths: ['.env'],
      confirmedSensitivePaths: [],
    })
    await handlers['conversation-move:cancel']({}, { operationId: OP })
    expect(service.cancel).toHaveBeenCalledWith(OP)
    expect(() => handlers['conversation-move:resolve']({}, { operationId: OP, action: 'drop' })).toThrow(
      /Invalid payload/
    )
    await handlers['conversation-move:resolve']({}, { operationId: OP, action: 'rollback' })
    expect(service.resolve).toHaveBeenCalledWith(OP, 'rollback')
    expect(handlers['conversation-move:recoveries']({})).toEqual([])
  })

  it('broadcasts progress events until disposed', () => {
    const { change, emitChanged, dispose } = setup()
    const event = {
      operationId: OP,
      conversationId: 'c1',
      sourceHostId: 'local',
      targetHostId: REMOTE,
      phase: 'exporting',
      status: 'running',
    } as const
    change(event)
    expect(emitChanged).toHaveBeenCalledWith(event)
    dispose()
    change(event)
    expect(emitChanged).toHaveBeenCalledTimes(1)
  })

  it('sends the preload calls on the coordinator channels', async () => {
    const invoke = vi.fn(async () => undefined)
    const on = vi.fn()
    const removeListener = vi.fn()
    const api = makeConversationMoveApi({ invoke, send: vi.fn(), on, removeListener } as never)
    await api.cancelConversationMove(OP)
    expect(invoke).toHaveBeenLastCalledWith('conversation-move:cancel', { operationId: OP })
    await api.resolveConversationMove(OP, 'continue')
    expect(invoke).toHaveBeenLastCalledWith('conversation-move:resolve', { operationId: OP, action: 'continue' })
    const callback = vi.fn()
    const stop = api.onConversationMoveChanged(callback)
    const listener = on.mock.calls[0][1] as (event: unknown, payload: unknown) => void
    listener({}, { operationId: OP })
    expect(callback).toHaveBeenCalledWith({ operationId: OP })
    stop()
    expect(removeListener).toHaveBeenCalledWith('conversation-move:changed', listener)
  })
})
