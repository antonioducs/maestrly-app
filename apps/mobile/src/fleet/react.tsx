import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { FleetController } from './controller'
import type { FleetState } from './state'

const FleetContext = createContext<FleetController | null>(null)

export function FleetProvider({ controller, children }: { controller: FleetController; children: ReactNode }) {
  return <FleetContext.Provider value={controller}>{children}</FleetContext.Provider>
}

export function useFleetController(): FleetController {
  const controller = useContext(FleetContext)
  if (!controller) throw new Error('useFleetController must be used inside FleetProvider')
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
