import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const h = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(),
  resetLocalAppData: vi.fn(),
  buildExportBundle: vi.fn(),
  unwatchProject: vi.fn(),
  unwatchMemory: vi.fn(),
}))
vi.mock('electron', () => ({ dialog: { showSaveDialog: h.showSaveDialog, showMessageBox: h.showMessageBox } }))
vi.mock('../../src/main/local-data/local-data-reset', () => ({ resetLocalAppData: h.resetLocalAppData }))
vi.mock('../../src/main/local-data/data-export', () => ({ buildExportBundle: h.buildExportBundle }))
vi.mock('../../src/main/notes/notes-service', () => ({ unwatchProject: h.unwatchProject }))
vi.mock('../../src/main/memory-service', () => ({ unwatchMemory: h.unwatchMemory }))
vi.mock('../../src/main/store', () => ({
  listWorkspaces: () => [{ id: 'ws-1' }, { id: 'ws-2' }],
  listAllConversations: () => [{ id: 'conversation-1' }],
}))

import { registerLocalDataIpc, type LocalDataIpcDeps } from '../../src/main/local-data/local-data-ipc'

type Handler = Parameters<IpcRegistrar['handle']>[1]
let handlers: Map<string, Handler>
let reg: IpcRegistrar
let deps: LocalDataIpcDeps
let directory: string
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(handlers.get(channel)!({} as Parameters<Handler>[0], ...args))
}

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'maestrly-local-ipc-'))
  handlers = new Map()
  const register = (channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  }
  reg = { handle: vi.fn(register), mhandle: vi.fn(register), on: vi.fn(), mon: vi.fn() }
  deps = {
    getMainWindow: vi.fn(() => ({}) as ReturnType<LocalDataIpcDeps['getMainWindow']>),
    stopAllLiveWork: vi.fn(async () => {}),
    stopConversationLive: vi.fn(async () => {}),
  }
  registerLocalDataIpc(reg, deps)
})
afterEach(async () => {
  await fsp.rm(directory, { recursive: true, force: true })
})

describe('local data IPC', () => {
  it('registers sensitive actions with the guarded registrar and returns local counts', async () => {
    expect(reg.mhandle).toHaveBeenCalledWith('data:reset', expect.any(Function))
    expect(reg.mhandle).toHaveBeenCalledWith('data:export', expect.any(Function))
    expect(await invoke('data:local-summary')).toEqual({ workspaces: 2, conversations: 1 })
  })

  it('ignores renderer confirmation and requires the native destructive choice', async () => {
    h.showMessageBox.mockResolvedValue({ response: 0 })
    expect(await invoke('data:reset', { confirmed: true })).toEqual({
      ok: false,
      error: expect.stringContaining('canceled'),
    })
    expect(h.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultId: 0, cancelId: 0 })
    )
    expect(deps.stopAllLiveWork).not.toHaveBeenCalled()
    expect(h.resetLocalAppData).not.toHaveBeenCalled()
  })

  it('awaits global shutdown before reset and awaits project watcher shutdown', async () => {
    h.showMessageBox.mockResolvedValue({ response: 1 })
    let finishShutdown: (() => void) | undefined
    vi.mocked(deps.stopAllLiveWork).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve
        })
    )
    const reset = invoke('data:reset')
    await vi.waitFor(() => expect(deps.stopAllLiveWork).toHaveBeenCalledOnce())
    expect(h.resetLocalAppData).not.toHaveBeenCalled()
    expect(await invoke('data:reset')).toEqual({ ok: false, error: expect.stringContaining('in progress') })
    finishShutdown!()
    expect(await reset).toEqual({ ok: true })
    const hooks = h.resetLocalAppData.mock.calls[0][0]
    expect(hooks.stopConversation).toBe(deps.stopConversationLive)
    let finishWatcher: (() => void) | undefined
    h.unwatchProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWatcher = resolve
        })
    )
    const stopping = hooks.stopWorkspace('ws-1')
    expect(h.unwatchMemory).not.toHaveBeenCalled()
    finishWatcher!()
    await stopping
    expect(h.unwatchMemory).toHaveBeenCalledWith('ws-1')
  })

  it('returns shutdown and cleanup errors and permits retry', async () => {
    h.showMessageBox.mockResolvedValue({ response: 1 })
    vi.mocked(deps.stopAllLiveWork).mockRejectedValueOnce(new Error('shutdown failed'))
    expect(await invoke('data:reset')).toEqual({ ok: false, error: 'shutdown failed' })
    expect(h.resetLocalAppData).not.toHaveBeenCalled()
    h.resetLocalAppData.mockRejectedValueOnce(new AggregateError([new Error('disk denied')], 'Cleanup incomplete.'))
    expect(await invoke('data:reset')).toEqual({ ok: false, error: 'Cleanup incomplete. disk denied' })
    expect(await invoke('data:reset')).toEqual({ ok: true })
  })

  it('requires a main window for native dialogs', async () => {
    vi.mocked(deps.getMainWindow).mockReturnValue(null)
    expect(await invoke('data:reset')).toEqual({ ok: false, error: expect.stringContaining('unavailable') })
    expect(await invoke('data:export')).toEqual({ ok: false, error: expect.stringContaining('unavailable') })
    expect(h.showMessageBox).not.toHaveBeenCalled()
    expect(h.showSaveDialog).not.toHaveBeenCalled()
  })

  it('writes the complete export to the native selected path and handles cancellation', async () => {
    h.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await invoke('data:export')).toEqual({ ok: false, canceled: true })
    expect(h.buildExportBundle).not.toHaveBeenCalled()
    const filePath = path.join(directory, 'export.json')
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    h.buildExportBundle.mockResolvedValue({ workspaces: [{ id: 'ws-1' }], omissions: [] })
    expect(await invoke('data:export')).toEqual({ ok: true, path: filePath, incomplete: false, omissions: [] })
    expect(JSON.parse(await fsp.readFile(filePath, 'utf8'))).toEqual({ workspaces: [{ id: 'ws-1' }], omissions: [] })
  })

  it('returns visible incompleteness and omissions when an export loses assets', async () => {
    const filePath = path.join(directory, 'partial.json')
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    h.buildExportBundle.mockResolvedValue({ assets: [], omissions: ['Could not export image.'] })
    expect(await invoke('data:export')).toEqual({
      ok: true,
      path: filePath,
      incomplete: true,
      omissions: ['Could not export image.'],
    })
  })

  it('prevents reset while an export is collecting data', async () => {
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(directory, 'export.json') })
    let finishExport: ((bundle: unknown) => void) | undefined
    h.buildExportBundle.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExport = resolve
        })
    )
    const exporting = invoke('data:export')
    await vi.waitFor(() => expect(h.buildExportBundle).toHaveBeenCalledOnce())
    expect(await invoke('data:reset')).toEqual({ ok: false, error: 'Local data export is in progress.' })
    expect(h.showMessageBox).not.toHaveBeenCalled()
    finishExport!({ omissions: [] })
    expect(await exporting).toEqual({
      ok: true,
      path: path.join(directory, 'export.json'),
      incomplete: false,
      omissions: [],
    })
  })

  it('returns errors from native dialogs and failed export writes', async () => {
    h.showMessageBox.mockRejectedValue(new Error('dialog failed'))
    expect(await invoke('data:reset')).toEqual({ ok: false, error: 'dialog failed' })
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath: directory })
    h.buildExportBundle.mockResolvedValue({})
    expect(await invoke('data:export')).toEqual({ ok: false, error: expect.any(String) })
  })
})
