import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import type { ProjectSetupContext } from '../../src/main/project-setup/service'
import type { Workspace } from '../../src/main/store'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: vi.fn(() => ({})) },
  dialog: { showOpenDialog: vi.fn() },
}))
vi.mock('../../src/main/test-mode', () => ({ consumeE2EProjectPicker: () => undefined }))

import { registerProjectSetupIpc } from '../../src/main/project-setup/ipc'

type Handle = Parameters<IpcRegistrar['handle']>[1]
function registrar() {
  const handles = new Map<string, Handle>()
  const reg: IpcRegistrar = {
    handle: (channel, fn) => void handles.set(channel, fn),
    mhandle: (channel, fn) => void handles.set(channel, fn),
    on: () => {},
    mon: () => {},
  }
  return { reg, handles }
}

class Sender extends EventEmitter {
  destroyed = false
  send = vi.fn()
  constructor(readonly id: number) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const workspace: Workspace = {
  id: 'ws',
  path: '/repo',
  name: 'repo',
  defaultBranch: 'main',
  addedAt: 1,
}
const request = {
  operationId: '00000000-0000-4000-8000-000000000001',
  kind: 'open' as const,
  path: '/repo',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('project setup IPC', () => {
  it('registers guarded channels and sends static progress only to the owning sender', async () => {
    const { reg, handles } = registrar()
    const service = {
      execute: vi.fn(async (_request, ctx: ProjectSetupContext) => {
        ctx.emit({ phase: 'validating' })
        return { status: 'success' as const, workspace, reused: false }
      }),
    }
    registerProjectSetupIpc(reg, { service })
    const sender = new Sender(1)
    const result = await handles.get('project-setup:start')!({ sender } as never, request)
    expect(result).toEqual({ status: 'success', workspace, reused: false })
    expect(sender.send).toHaveBeenCalledWith('project-setup:progress', {
      operationId: request.operationId,
      phase: 'validating',
    })
    expect(handles.has('project-setup:cancel')).toBe(true)
    expect(handles.has('project-setup:resolve-empty-remote')).toBe(true)
  })

  it('rejects invalid UUIDs, collisions, and cancellation/decisions from another sender', async () => {
    const { reg, handles } = registrar()
    let release!: () => void
    const blocker = new Promise<void>((resolve) => (release = resolve))
    const service = {
      execute: vi.fn(async (_request, ctx: ProjectSetupContext) => {
        await blocker
        return ctx.signal.aborted
          ? ({ status: 'canceled' } as const)
          : ({ status: 'success', workspace, reused: false } as const)
      }),
    }
    registerProjectSetupIpc(reg, { service })
    const owner = new Sender(1)
    const other = new Sender(2)
    const start = handles.get('project-setup:start')!
    expect(await start({ sender: owner } as never, { ...request, operationId: 'bad' })).toEqual({
      status: 'error',
      error: { code: 'invalid-request' },
    })
    const running = start({ sender: owner } as never, request)
    expect(await start({ sender: other } as never, request)).toEqual({
      status: 'error',
      error: { code: 'operation-conflict' },
    })
    expect(await handles.get('project-setup:cancel')!({ sender: other } as never, request.operationId)).toBe(false)
    expect(
      await handles.get('project-setup:resolve-empty-remote')!({ sender: other } as never, {
        operationId: request.operationId,
        decision: 'initialize-local',
      })
    ).toBe(false)
    expect(await handles.get('project-setup:cancel')!({ sender: owner } as never, request.operationId)).toBe(true)
    release()
    expect(await running).toEqual({ status: 'canceled' })
  })

  it('pauses on an empty remote, accepts the owner decision, and cancels on destroy without later emissions', async () => {
    const { reg, handles } = registrar()
    const service = {
      execute: vi.fn(async (_request, ctx: ProjectSetupContext) => {
        ctx.emit({ phase: 'awaiting-empty-remote-confirmation' })
        const decision = await ctx.waitForEmptyRemoteDecision()
        return decision === 'initialize-local'
          ? ({ status: 'success', workspace, reused: false } as const)
          : ({ status: 'canceled' } as const)
      }),
    }
    registerProjectSetupIpc(reg, { service })
    const owner = new Sender(1)
    const running = handles.get('project-setup:start')!({ sender: owner } as never, request)
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalled())
    expect(
      await handles.get('project-setup:resolve-empty-remote')!({ sender: owner } as never, {
        operationId: request.operationId,
        decision: 'initialize-local',
      })
    ).toBe(true)
    expect(await running).toEqual({ status: 'success', workspace, reused: false })

    const request2 = { ...request, operationId: '00000000-0000-4000-8000-000000000002' }
    const owner2 = new Sender(2)
    const running2 = handles.get('project-setup:start')!({ sender: owner2 } as never, request2)
    await vi.waitFor(() => expect(owner2.send).toHaveBeenCalled())
    owner2.destroy()
    expect(await running2).toEqual({ status: 'canceled' })
    const callsAfterDestroy = owner2.send.mock.calls.length
    expect(owner2.send).toHaveBeenCalledTimes(callsAfterDestroy)
  })

  it('rejects cancellation after the commit point and completes with the actual result', async () => {
    const { reg, handles } = registrar()
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = {
      execute: vi.fn(async (_request, ctx: ProjectSetupContext) => {
        ctx.markCommitted()
        await blocker
        return { status: 'success' as const, workspace, reused: false }
      }),
    }
    registerProjectSetupIpc(reg, { service })
    const owner = new Sender(1)
    const running = handles.get('project-setup:start')!({ sender: owner } as never, request)
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalled())

    expect(await handles.get('project-setup:cancel')!({ sender: owner } as never, request.operationId)).toBe(false)
    release()
    expect(await running).toEqual({ status: 'success', workspace, reused: false })
  })

  it('cancelAndWait resolves only after the aborted operation finishes', async () => {
    const { reg, handles } = registrar()
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = {
      execute: vi.fn(async (_request, ctx: ProjectSetupContext) => {
        await blocker
        return ctx.signal.aborted
          ? ({ status: 'canceled' } as const)
          : ({ status: 'success', workspace, reused: false } as const)
      }),
    }
    const lifecycle = registerProjectSetupIpc(reg, { service })
    const owner = new Sender(1)
    const running = handles.get('project-setup:start')!({ sender: owner } as never, request)
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalled())

    let settled = false
    const shutdown = lifecycle.cancelAndWait().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(
      await handles.get('project-setup:start')!({ sender: new Sender(2) } as never, {
        ...request,
        operationId: '00000000-0000-4000-8000-000000000009',
      })
    ).toEqual({ status: 'error', error: { code: 'operation-conflict' } })
    release()
    await shutdown
    expect(await running).toEqual({ status: 'canceled' })
  })
})
