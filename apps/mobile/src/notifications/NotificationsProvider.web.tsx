import { FLEET_PUSH_DEFAULTS } from '@maestrly/bot-fleet-protocol'
import { createContext, useContext, type ReactNode } from 'react'
import type { useNotifications as useNativeNotifications } from './NotificationsProvider'

type NotificationsValue = ReturnType<typeof useNativeNotifications>

/** The web preview has no push notifications: its Settings say so, and expo-notifications is never loaded. */
const unavailable: NotificationsValue = {
  available: false,
  permission: 'unavailable',
  problem: null,
  preferences: FLEET_PUSH_DEFAULTS,
  setPreference: () => {},
  enable: async () => 'unavailable',
  results: {},
  sendTest: async () => {},
  offered: true,
  markOffered: () => {},
}
const NotificationsContext = createContext<NotificationsValue>(unavailable)

export function NotificationsProvider({ children }: { children: ReactNode }) {
  return <NotificationsContext.Provider value={unavailable}>{children}</NotificationsContext.Provider>
}

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext)
}
