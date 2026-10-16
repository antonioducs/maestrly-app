import { FLEET_PUSH_DEFAULTS, type FleetPushCategory, type FleetPushPreferences } from '@maestrly/bot-fleet-protocol'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Linking, Platform } from 'react-native'
import { DEMO_SERVER } from '../demo/demo-source'
import { useI18n } from '../i18n'
import { asyncKeyValue } from '../servers/adapters'
import { useServers } from '../servers/ServersProvider'
import {
  loadPushPreferences,
  pushLink,
  pushTarget,
  registerWithServers,
  savePushPreferences,
  type PushRegistrationResult,
} from './push'

export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable'
/** Why this phone has no push token: no EAS project in this build, a simulator, or the push service failed. */
export type PushTokenProblem = 'project' | 'device' | 'failed'

type NotificationsValue = {
  /** Whether this platform has notifications at all (not in the web preview). */
  available: boolean
  permission: PushPermission
  problem: PushTokenProblem | null
  preferences: FleetPushPreferences
  setPreference(category: FleetPushCategory, value: boolean): void
  /** Asks for permission when it was never asked, opens the system settings when it was refused. */
  enable(): Promise<PushPermission>
  /** How each paired server took this phone's registration. */
  results: Record<string, PushRegistrationResult>
  sendTest(serverId: string): Promise<void>
  /** Whether the phone already offered notifications after pairing. */
  offered: boolean
  markOffered(): void
}

const NotificationsContext = createContext<NotificationsValue | null>(null)
const OFFERED_KEY = 'prefs.notificationsOffered'
const native = Platform.OS === 'ios' || Platform.OS === 'android'

/** Android 13 and later report `denied` before the app ever asked; that is not the person turning them off. */
const toPermission = ({ status, canAskAgain }: { status: string; canAskAgain: boolean }): PushPermission =>
  status === 'granted' ? 'granted' : status === 'denied' && !canAskAgain ? 'denied' : 'undetermined'

/**
 * Notifications from every paired server: the permission, this phone's push token and what it wants to hear about,
 * registered with each server; a tapped notification opens its bot or chat, on its server, and one about what is
 * already on screen shows no banner.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n()
  const { servers, ready, active, current, environmentId, clientFor } = useServers()
  const [kv] = useState(() => (native ? asyncKeyValue() : null))
  const [permission, setPermission] = useState<PushPermission>(native ? 'undetermined' : 'unavailable')
  const [problem, setProblem] = useState<PushTokenProblem | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<FleetPushPreferences>(FLEET_PUSH_DEFAULTS)
  const [results, setResults] = useState<Record<string, PushRegistrationResult>>({})
  const [offered, setOffered] = useState(true)
  const [opened, setOpened] = useState<unknown>(null)
  const onScreen = useRef<{
    serverId: string | null
    environmentId: string | null
    kind: string | null
    id: string | null
  }>({ serverId: null, environmentId: null, kind: null, id: null })
  onScreen.current = {
    serverId: active?.id ?? null,
    environmentId,
    kind: current?.kind ?? null,
    id: current && 'id' in current ? current.id : null,
  }
  const serversRef = useRef(servers)
  serversRef.current = servers

  useEffect(() => {
    if (!native || !kv) return
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const target = pushTarget(notification.request.content.data, serversRef.current)
        const shown = onScreen.current
        const visible =
          !!target &&
          target.serverId === shown.serverId &&
          target.kind === shown.kind &&
          target.id === shown.id &&
          (!target.environmentId || target.environmentId === shown.environmentId)
        return { shouldShowBanner: !visible, shouldShowList: true, shouldPlaySound: !visible, shouldSetBadge: false }
      },
    })
    if (Platform.OS === 'android')
      void Notifications.setNotificationChannelAsync('default', {
        name: 'Maestrly',
        importance: Notifications.AndroidImportance.HIGH,
      }).catch(() => {})
    void Notifications.getPermissionsAsync().then(
      (value) => setPermission(toPermission(value)),
      () => setPermission('unavailable')
    )
    void loadPushPreferences(kv).then(setPreferences)
    void kv.get(OFFERED_KEY).then(
      (value) => setOffered(value === '1'),
      () => setOffered(true)
    )
    // A notification tapped while the app was closed opened it; later ones arrive here.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) setOpened(response.notification.request.content.data)
    })
    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      setOpened(response.notification.request.content.data)
    )
    return () => subscription.remove()
  }, [kv])

  // Opens what a tapped notification is about once the servers are known.
  useEffect(() => {
    if (!opened || !ready) return
    const target = pushTarget(opened, servers)
    setOpened(null)
    if (target) router.push(pushLink(target) as never)
  }, [opened, ready, servers])

  // A push token, once notifications are allowed.
  useEffect(() => {
    if (!native || permission !== 'granted' || token) return
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
      Constants.easConfig?.projectId
    if (!Device.isDevice) {
      setProblem('device')
      return
    }
    if (!projectId) {
      setProblem('project')
      return
    }
    let alive = true
    Notifications.getExpoPushTokenAsync({ projectId }).then(
      (value) => {
        if (!alive) return
        setProblem(null)
        setToken(value.data)
      },
      () => alive && setProblem('failed')
    )
    return () => {
      alive = false
    }
  }, [permission, token])

  // Every paired server learns where to send this phone's notifications, in its language and as it chose.
  const signature = servers.map((server) => `${server.id}:${server.features.join(',')}`).join('|')
  useEffect(() => {
    if (!token || permission !== 'granted') return
    let alive = true
    void registerWithServers({
      servers,
      token,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      locale,
      preferences,
      clientFor,
      skip: (server) => server.id === DEMO_SERVER.id,
    }).then((value) => alive && setResults(value))
    return () => {
      alive = false
    }
  }, [token, permission, locale, preferences, signature, clientFor])

  const setPreference = useCallback(
    (category: FleetPushCategory, value: boolean) => {
      setPreferences((previous) => {
        const next = { ...previous, [category]: value }
        if (kv) void savePushPreferences(kv, next)
        return next
      })
    },
    [kv]
  )

  const enable = useCallback(async (): Promise<PushPermission> => {
    if (!native) return 'unavailable'
    const existing = await Notifications.getPermissionsAsync()
    if (existing.status === 'denied' && !existing.canAskAgain) {
      await Linking.openSettings().catch(() => {})
      return 'denied'
    }
    const asked = await Notifications.requestPermissionsAsync()
    const next = toPermission(asked)
    setPermission(next)
    return next
  }, [])

  const sendTest = useCallback(
    async (serverId: string) => {
      const server = servers.find((item) => item.id === serverId)
      if (!server) return
      if (server.id === DEMO_SERVER.id) {
        // The demo server lives on the phone: its test is a local notification.
        await Notifications.scheduleNotificationAsync({
          content: { title: 'Maestrly', body: t('notifications.testBody', { server: server.name }) },
          // Android shows it on the app's own channel, as it does the server's, rather than Expo's fallback one.
          trigger: Platform.OS === 'android' ? { channelId: 'default' } : null,
        })
        return
      }
      const client = await clientFor(server)
      if (!client) throw new Error('No token for this server')
      await client.call('devicePushTest', { body: {} })
    },
    [servers, clientFor, t]
  )

  const markOffered = useCallback(() => {
    setOffered(true)
    if (kv) void kv.set(OFFERED_KEY, '1').catch(() => {})
  }, [kv])

  const value = useMemo<NotificationsValue>(
    () => ({
      available: native,
      permission,
      problem,
      preferences,
      setPreference,
      enable,
      results,
      sendTest,
      offered,
      markOffered,
    }),
    [permission, problem, preferences, setPreference, enable, results, sendTest, offered, markOffered]
  )
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext)
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider')
  return value
}
