import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { FleetController } from './controller'
import type { FleetState } from './state'

const FleetContext = createContext<FleetController | null>(null)

/** The active server's controller; null until a server is paired and its controller has started. */
export function FleetProvider({ controller, children }: { controller: FleetController | null; children: ReactNode }) {
  return <FleetContext.Provider value={controller}>{children}</FleetContext.Provider>
}

export function useFleetController(): FleetController {
  const controller = useContext(FleetContext)
  if (!controller) throw new Error('useFleetController must be used where a server is active')
  return controller
}

/**
 * Reads the fleet state. The store's state object only changes on updates, so it is safe to subscribe to as a whole;
 * the selector then runs once per change.
 */
export function useFleet<T>(selector: (state: FleetState) => T): T {
  const controller = useFleetController()
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState)
  return useMemo(() => selector(state), [state, selector])
}
