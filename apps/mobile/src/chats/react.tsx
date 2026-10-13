import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { ChatsController } from './controller'
import { initialChatsState, type ChatsState } from './state'

const ChatsContext = createContext<ChatsController | null>(null)
const idle = { subscribe: () => () => {}, getState: () => initialChatsState }

/** The active server's chats; null until a server is paired and its controller has started. */
export function ChatsProvider({ controller, children }: { controller: ChatsController | null; children: ReactNode }) {
  return <ChatsContext.Provider value={controller}>{children}</ChatsContext.Provider>
}

export function useChatsController(): ChatsController {
  const controller = useContext(ChatsContext)
  if (!controller) throw new Error('useChatsController must be used where a server is active')
  return controller
}

/** Reads the chats state; with no active server, the state of a server without chats. */
export function useChats<T>(selector: (state: ChatsState) => T): T {
  const store = useContext(ChatsContext)?.store ?? idle
  const state = useSyncExternalStore(store.subscribe, store.getState)
  return useMemo(() => selector(state), [state, selector])
}
