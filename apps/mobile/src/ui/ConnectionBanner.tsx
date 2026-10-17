import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useFleet, useFleetController } from '../fleet/react'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { mix } from '../theme/tokens'
import { Icon, type IconName } from './icons'
import { Button } from './primitives/Button'
import { AppText } from './primitives/Text'
import { useHeldFor } from './useHeldFor'

const selectConnection = (state: FleetState) => ({ connection: state.connection, retryAt: state.retryAt })
/** Coming back to the app reconnects at once; only a reconnection that takes longer than this is shown. */
const RECONNECT_GRACE_MS = 2500

/** Whether this phone reaches its server; it only shows when something is off, and says nothing once it is back. */
export function ConnectionBanner() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const { active, forget } = useServers()
  const { connection, retryAt } = useFleet(selectConnection)
  const [now, setNow] = useState(Date.now())
  const wasOpen = useRef(false)
  if (connection === 'open') wasOpen.current = true
  const server = active?.name ?? ''
  const slowReconnect = useHeldFor(connection === 'connecting' && wasOpen.current, RECONNECT_GRACE_MS)

  useEffect(() => {
    if (connection !== 'retrying') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [connection])

  let icon: IconName = 'wifi-off'
  const tone = palette.brick
  let title: string
  let detail: string | null = null
  let action: { label: string; onPress: () => void } | null = null
  if (connection === 'retrying') {
    title = t('conn.offline', { server })
    detail = t('conn.retrying', { seconds: Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000)) })
    action = { label: t('conn.retryNow'), onPress: () => controller.foreground() }
  } else if (slowReconnect) {
    title = t('conn.reconnecting', { server })
  } else if (connection === 'unauthorized') {
    title = t('conn.unauthorized', { server })
    action = {
      label: t('conn.pairAgain'),
      onPress: () => {
        if (active) void forget(active.id, { remote: false }).then(() => router.replace('/pair'))
      },
    }
  } else if (connection === 'incompatible') {
    icon = 'alert'
    title = t('conn.incompatible', { server })
  } else {
    return null
  }

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 12,
        marginBottom: 4,
        paddingVertical: 8,
        paddingLeft: 12,
        paddingRight: 8,
        borderRadius: 12,
        backgroundColor: mix(tone, palette.raised, 0.12),
      }}
    >
      <Icon name={icon} size={18} color={tone} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 13.5, lineHeight: 18 }}>{title}</AppText>
        {detail ? (
          <AppText variant="small" tone="muted">
            {detail}
          </AppText>
        ) : null}
      </View>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" size="sm" /> : null}
    </View>
  )
}
