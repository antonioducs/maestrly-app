import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }))
vi.mock('react', () => ({
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

beforeEach(() => {
  state.index = 0
  state.values = []
  vi.stubGlobal('window', { api: { listStandaloneConversations: vi.fn() } })
})

describe('standalone list refresh', () => {
  it('counts archived chats while hiding them until requested', async () => {
    const chats = [
      { id: 'active', archived: 0 },
      { id: 'archived', archived: 1 },
    ]
    vi.mocked(window.api.listStandaloneConversations).mockResolvedValue(chats as never)
    const list = useStandaloneChats()
    await list.refresh(false)
    expect(state.values).toEqual([[chats[0]], 1])
    await list.refresh(true)
    expect(state.values).toEqual([chats, 1])
    expect(window.api.listStandaloneConversations).toHaveBeenCalledWith(true)
  })
  it('does not let an earlier request overwrite newer visibility', async () => {
    let finishOld!: (value: never[]) => void
    vi.mocked(window.api.listStandaloneConversations)
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
