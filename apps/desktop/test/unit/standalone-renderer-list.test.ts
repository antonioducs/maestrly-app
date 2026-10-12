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
        state.values[index] = value
      },
    ]
  },
}))
import { useStandaloneChats } from '../../src/renderer/lib/use-standalone-chats'

// One stub for the whole file: the host context keeps the API object it got from the preload.
const listStandaloneConversations = vi.fn()
vi.stubGlobal('window', { api: { hostApi: () => ({ listStandaloneConversations }) } })

beforeEach(() => {
  state.index = 0
  state.values = []
  listStandaloneConversations.mockReset()
})

describe('standalone list refresh', () => {
  it('counts archived chats while hiding them until requested', async () => {
    const chats = [
      { id: 'active', archived: 0 },
      { id: 'archived', archived: 1 },
    ]
    listStandaloneConversations.mockResolvedValue(chats as never)
    const list = useStandaloneChats()
    await list.refresh(false)
    expect(state.values).toEqual([[chats[0]], 1])
    await list.refresh(true)
    expect(state.values).toEqual([chats, 1])
    expect(listStandaloneConversations).toHaveBeenCalledWith(true)
  })
  it('does not let an earlier request overwrite newer visibility', async () => {
    let finishOld!: (value: never[]) => void
    listStandaloneConversations
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          })
      )
      .mockResolvedValueOnce([{ id: 'archived', archived: 1 }] as never)
    const list = useStandaloneChats()
    const old = list.refresh(false)
    await list.refresh(true)
    finishOld([])
    await old
    expect(state.values).toEqual([[{ id: 'archived', archived: 1 }], 1])
  })
})
