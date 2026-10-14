import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }))
vi.mock('react', () => ({
  // The hook reaches its host through the host context module, which creates a context when it loads.
  createContext: (value: unknown) => ({ value }),
  useContext: (context: { value: unknown }) => context.value,
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = state.index++
    state.values[index] = initial
    return [
      initial,
      (value: unknown) => {
        state.values[index] = typeof value === 'function' ? value(state.values[index]) : value
      },
    ]
  },
}))
vi.mock('../../src/renderer/lib/i18n', () => ({ i18n: { t: (key: string) => key } }))
import { useWorkspaces } from '../../src/renderer/lib/use-workspaces'

// useState order inside useWorkspaces: workspaces, then the standalone chats hook (chats, archived count).
const WORKSPACES = 0
const STANDALONE = 1

type Row = { id: string; workspaceId: string | null; scope: 'project' | 'standalone'; archived: number }

/** The store as main sees it: a row leaves only when its deletion finishes. */
let rows: Row[] = []
const deleteGates = new Map<string, { promise: Promise<void>; finish: () => void; fail: (error: Error) => void }>()

function gate(id: string) {
  let finish!: () => void
  let fail!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  // A gate may fail before the deletion awaits it; the deletion still sees the rejection.
  promise.catch(() => undefined)
  deleteGates.set(id, { promise, finish, fail })
  return deleteGates.get(id)!
}

const api = {
  listWorkspaces: vi.fn(async () => [
    { id: 'ws', conversations: rows.filter((row) => row.workspaceId === 'ws').map((row) => ({ ...row })) },
  ]),
  listGroups: vi.fn(async () => []),
  listStandaloneConversations: vi.fn(async () =>
    rows.filter((row) => row.scope === 'standalone').map((row) => ({ ...row }))
  ),
  deleteConversation: vi.fn(async (id: string) => {
    await deleteGates.get(id)?.promise
    rows = rows.filter((row) => row.id !== id)
  }),
}
// One stub for the whole file: the host context keeps the API object it got from the preload.
vi.stubGlobal('window', { api: { hostApi: () => api } })
const alert = vi.fn()
vi.stubGlobal('alert', alert)
vi.stubGlobal('confirm', () => true)

const project = (id: string): Row => ({ id, workspaceId: 'ws', scope: 'project', archived: 0 })
const chat = (id: string): Row => ({ id, workspaceId: null, scope: 'standalone', archived: 0 })

function visibleProjectIds(): string[] {
  const workspaces = state.values[WORKSPACES] as { conversations: { id: string }[] }[]
  return workspaces.flatMap((workspace) => workspace.conversations.map((conversation) => conversation.id))
}
const visibleChatIds = (): string[] => (state.values[STANDALONE] as { id: string }[]).map((c) => c.id)

async function mount() {
  const hook = useWorkspaces({ active: null, setActive: vi.fn(), forgetConvDrawerState: vi.fn() })
  await hook.refreshWorkspaces()
  return hook
}

beforeEach(() => {
  state.index = 0
  state.values = []
  rows = []
  deleteGates.clear()
  alert.mockReset()
  api.listWorkspaces.mockClear()
  api.deleteConversation.mockClear()
})

describe('conversation deletion in the renderer list', () => {
  it('keeps a slow deletion hidden while a faster one refreshes the list', async () => {
    rows = [project('slow'), project('fast'), project('kept')]
    const hook = await mount()
    const slow = gate('slow')

    const slowDeletion = hook.handleDelete(project('slow') as never)
    await hook.handleDelete(project('fast') as never)
    // The faster deletion refreshed from a store that still has the slow row.
    expect(rows.map((row) => row.id)).toContain('slow')
    expect(visibleProjectIds()).toEqual(['kept'])

    slow.finish()
    await slowDeletion
    expect(visibleProjectIds()).toEqual(['kept'])
  })

  it('keeps a standalone chat hidden while a workspace broadcast refreshes the list', async () => {
    rows = [chat('slow'), chat('kept')]
    const hook = await mount()
    const slow = gate('slow')

    const deletion = hook.handleDelete({ ...chat('slow'), name: 'slow' } as never)
    await hook.refreshWorkspaces()
    expect(visibleChatIds()).toEqual(['kept'])

    slow.finish()
    await deletion
    expect(visibleChatIds()).toEqual(['kept'])
  })

  it('shows the conversation again when its deletion fails', async () => {
    rows = [project('broken'), project('kept')]
    const hook = await mount()
    gate('broken').fail(new Error('worktree is locked'))

    await hook.handleDelete(project('broken') as never)
    expect(alert).toHaveBeenCalledWith('Error: worktree is locked')
    expect(visibleProjectIds()).toEqual(['broken', 'kept'])
  })

  it('ignores a refresh that answers after a newer one', async () => {
    rows = [project('old')]
    const hook = await mount()
    let answerStale!: () => void
    api.listWorkspaces.mockImplementationOnce(() => {
      const snapshot = [{ id: 'ws', conversations: rows.map((row) => ({ ...row })) }]
      return new Promise((resolve) => {
        answerStale = () => resolve(snapshot)
      })
    })

    const stale = hook.refreshWorkspaces()
    rows = [project('new')]
    await hook.refreshWorkspaces()
    answerStale()
    await stale
    expect(visibleProjectIds()).toEqual(['new'])
  })

  it('deletes the remaining siblings when one fails and then refreshes', async () => {
    rows = [project('a'), project('b'), project('c'), project('kept')]
    const hook = await mount()
    gate('b').fail(new Error('branch is checked out'))

    await hook.handleDeleteSiblings([project('a'), project('b'), project('c')] as never)
    expect(visibleProjectIds()).toEqual(['kept'])

    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Error: branch is checked out'))
    expect(api.deleteConversation.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    await vi.waitFor(() => expect(visibleProjectIds()).toEqual(['b', 'kept']))
  })
})
