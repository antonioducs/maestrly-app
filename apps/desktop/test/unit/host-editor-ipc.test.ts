import { describe, expect, it, vi } from 'vitest'
import { type HostEditorIpcDeps, registerHostEditorIpc } from '../../src/main/remote-host/server/host-editor-ipc'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const remote = { id: -1000 }
const local = { id: 7 }
const project = { id: 'conv-1', scope: 'project', cwd: '/srv/maestrly/app' }
const chat = { id: 'chat-1', scope: 'standalone', cwd: '/home/bot/.config/chats/chat-1' }

function setup(overrides: Partial<HostEditorIpcDeps> = {}) {
  let running = false
  const deps: HostEditorIpcDeps = {
    isRemoteViewer: (sender) => sender === remote,
    conversation: (id) => ([project, chat].find((item) => item.id === id) as never) ?? null,
    standaloneFolder: vi.fn(async (conversation) => conversation.cwd),
    ignoreSidecars: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    start: vi.fn(async () => {
      running = true
    }),
    running: () => running,
    cliReady: () => false,
    probe: vi.fn(async () => 'ready' as const),
    restart: vi.fn(async () => undefined),
    waitReady: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      dirtyDocuments: 1,
      debugActive: false,
      operationInFlight: false,
      lastActivityAt: 5,
    })),
    bridgeInFlight: () => false,
    ...overrides,
  }
  const { reg, mhandles } = createTestRegistrar()
  registerHostEditorIpc(reg, deps)
  const call = (channel: string, sender: unknown, ...args: unknown[]) =>
    Promise.resolve(mhandles.get(channel)!({ sender } as never, ...args))
  return { deps, call, mhandles }
}

describe("a workspaces host's editor channels", () => {
  it('serve only another computer, never a window of the host', async () => {
    const h = setup()
    expect([...h.mhandles.keys()].sort()).toEqual([
      'editor:navigate',
      'editor:open',
      'editor:restart',
      'editor:snapshot',
      'editor:status',
    ])
    for (const channel of h.mhandles.keys())
      await expect(h.call(channel, local, 'conv-1', 'back')).rejects.toMatchObject({ code: 'remote-viewer-only' })
    expect(h.deps.start).not.toHaveBeenCalled()
    expect(h.deps.watch).not.toHaveBeenCalled()
  })

  it("opens a project conversation's folder: sidecars ignored, selections followed, editor started", async () => {
    const h = setup()
    await expect(h.call('editor:open', remote, 'conv-1')).resolves.toEqual({ folder: project.cwd, phase: 'ready' })
    expect(h.deps.ignoreSidecars).toHaveBeenCalledWith(project.cwd)
    expect(h.deps.watch).toHaveBeenCalledWith('conv-1', project.cwd)
    expect(h.deps.start).toHaveBeenCalledTimes(1)
    expect(h.deps.standaloneFolder).not.toHaveBeenCalled()
  })

  it("opens a chat's managed folder only after checking it", async () => {
    const h = setup()
    await expect(h.call('editor:open', remote, 'chat-1')).resolves.toMatchObject({ folder: chat.cwd })
    expect(h.deps.standaloneFolder).toHaveBeenCalledWith(chat)
    expect(h.deps.ignoreSidecars).not.toHaveBeenCalled()

    const refused = setup({
      standaloneFolder: vi.fn(async () => Promise.reject(new Error('Unsafe standalone chat directory.'))),
    })
    await expect(refused.call('editor:open', remote, 'chat-1')).rejects.toThrow('Unsafe standalone')
    expect(refused.deps.start).not.toHaveBeenCalled()
    await expect(refused.call('editor:open', remote, 'nope')).rejects.toThrow('Unknown conversation.')
  })

  it('reports downloading and starting, then a failed start until the editor is opened again', async () => {
    let fail = true
    const h = setup({
      start: vi.fn(() => (fail ? Promise.reject(new Error('no network')) : Promise.resolve())),
      running: () => false,
    })
    await expect(h.call('editor:open', remote, 'conv-1')).resolves.toMatchObject({ phase: 'downloading' })
    await vi.waitFor(async () => expect(await h.call('editor:status', remote)).toBe('error'))
    // A failed start stays reported, without starting again, until the editor is opened again.
    const attempts = vi.mocked(h.deps.start).mock.calls.length
    await expect(h.call('editor:status', remote)).resolves.toBe('error')
    expect(h.deps.start).toHaveBeenCalledTimes(attempts)
    fail = false
    await expect(h.call('editor:open', remote, 'conv-1')).resolves.toMatchObject({ phase: 'downloading' })
    await new Promise((resolve) => setImmediate(resolve))
    await expect(h.call('editor:status', remote)).resolves.toBe('downloading')
  })

  it('asks the editor itself once it runs', async () => {
    const h = setup({ probe: vi.fn(async () => 'downloading' as const) })
    await h.call('editor:open', remote, 'conv-1')
    await expect(h.call('editor:status', remote)).resolves.toBe('downloading')
    expect(h.deps.probe).toHaveBeenCalledWith(800)
  })

  it('restarts the editor and waits until it serves again', async () => {
    const h = setup()
    await h.call('editor:restart', remote)
    expect(h.deps.restart).toHaveBeenCalled()
    expect(h.deps.waitReady).toHaveBeenCalled()
  })

  it('moves through history only in a known direction', async () => {
    const h = setup()
    await h.call('editor:navigate', remote, 'conv-1', 'forward')
    await h.call('editor:navigate', remote, 'conv-1', 'sideways')
    expect(h.deps.navigate).toHaveBeenCalledTimes(1)
    expect(h.deps.navigate).toHaveBeenCalledWith('conv-1', 'forward')
  })

  it("says what closing an editor window would lose, the agent's debug calls included", async () => {
    const h = setup()
    await expect(h.call('editor:snapshot', remote, 'conv-1')).resolves.toEqual({
      dirtyDocuments: 1,
      debugActive: false,
      operationInFlight: false,
      lastActivityAt: 5,
    })
    expect(h.deps.snapshot).toHaveBeenCalledWith(project.cwd)
    const busy = setup({ bridgeInFlight: () => true })
    await expect(busy.call('editor:snapshot', remote, 'conv-1')).resolves.toMatchObject({ operationInFlight: true })
    const silent = setup({ snapshot: vi.fn(async () => null) })
    await expect(silent.call('editor:snapshot', remote, 'conv-1')).resolves.toBeNull()
  })
})
