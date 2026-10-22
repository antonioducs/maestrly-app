import { createContext, useContext, useMemo, type ReactNode, type SyntheticEvent } from 'react'
import type { SettingsSection } from '@/components/settings/nav'
import type { ChatSettingsTab } from '@/components/chat/chat-settings-tabs'
import type { HostId } from '../../shared/host-key'
import type { FleetServerId } from '../../shared/fleet-servers'

/**
 * Where Settings opens: inside the chat section, a tab, on a host's profile (this computer by default); in
 * Computers, the dialog that pairs with another computer, blank or for one paired before (its device id); in Bot
 * servers, one paired server, or adding one.
 */
export interface OpenSettingsOptions {
  chatTab?: ChatSettingsTab
  hostId?: HostId
  connectComputer?: true | string
  fleetServer?: FleetServerId | 'add'
}

/** One request to show Settings at a place; `seq` changes on every request, so repeating one still applies. */
export interface SettingsRequest extends OpenSettingsOptions {
  section: SettingsSection
  seq: number
}

export type OpenSettings = (sectionOrEvent?: SettingsSection | SyntheticEvent, options?: OpenSettingsOptions) => void

interface SettingsContextValue {
  openSettings: OpenSettings
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ openSettings, children }: { openSettings: OpenSettings; children: ReactNode }) {
  const value = useMemo(() => ({ openSettings }), [openSettings])
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

const NOOP: SettingsContextValue = { openSettings: () => {} }

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext) ?? NOOP
}
