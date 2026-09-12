import { createContext, useContext, useMemo, type ReactNode, type SyntheticEvent } from 'react'
import type { SettingsSection } from '@/components/settings/nav'

interface SettingsContextValue {
  openSettings: (sectionOrEvent?: SettingsSection | SyntheticEvent) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({
  openSettings,
  children,
}: {
  openSettings: (sectionOrEvent?: SettingsSection | SyntheticEvent) => void
  children: ReactNode
}) {
  const value = useMemo(() => ({ openSettings }), [openSettings])
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

const NOOP: SettingsContextValue = { openSettings: () => {} }

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext) ?? NOOP
}
