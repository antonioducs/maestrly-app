import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UpdateState } from '../../shared/update'

interface UpdateContextValue {
  /** Null until the first snapshot arrives from the main process. */
  state: UpdateState | null
  check: (ignoreSkip?: boolean) => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  skip: () => Promise<void>
  openRelease: () => Promise<void>
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

/**
 * Mirror of the update state owned by the main process: it reads the current snapshot once and then
 * follows the `update:status` broadcast. The renderer never decides anything about updating.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let active = true
    void window.api
      .getUpdateState()
      .then((snapshot) => {
        if (active) setState(snapshot)
      })
      .catch(() => {})
    const off = window.api.onUpdateStatus((snapshot) => setState(snapshot))
    return () => {
      active = false
      off()
    }
  }, [])

  const run = useCallback(async (action: () => Promise<UpdateState | void>) => {
    try {
      const snapshot = await action()
      if (snapshot) setState(snapshot)
    } catch {
      /* failures already land in the broadcast state */
    }
  }, [])

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      check: (ignoreSkip = false) => run(() => window.api.checkForUpdates({ ignoreSkip })),
      download: () => run(() => window.api.downloadUpdate()),
      install: () => run(() => window.api.installUpdate()),
      skip: () => run(() => window.api.skipUpdateVersion()),
      openRelease: () => run(() => window.api.openUpdateRelease()),
    }),
    [state, run]
  )

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

const NOOP: UpdateContextValue = {
  state: null,
  check: async () => {},
  download: async () => {},
  install: async () => {},
  skip: async () => {},
  openRelease: async () => {},
}

export function useUpdate(): UpdateContextValue {
  return useContext(UpdateContext) ?? NOOP
}
