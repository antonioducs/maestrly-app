import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useChats, useChatsController } from '../../chats/react'
import type { ChatsState } from '../../chats/state'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { shownError } from '../conversation/CueCard'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { environmentState } from '../drawer/EnvironmentSwitcher'

const selectBridge = (state: ChatsState) => ({
  bridge: state.bridge,
  retryAt: state.retryAt,
  loaded: state.lists !== null,
})
const selectFleetOpen = (state: FleetState) => state.connection === 'open'

/**
 * Whether this phone reaches the server's workspaces host, where its chats run. It shows only when the bot server is
 * reachable but the host is not (the connection banner covers the rest); `quiet` hides the first connection.
 */
export function ChatHostBanner({ quiet = false }: { quiet?: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const { active, controller, environmentId } = useServers()
  const fleetOpen = useFleet(selectFleetOpen)
  const { bridge, retryAt, loaded } = useChats(selectBridge)
  const host = useFleet(
    useCallback(
      (state: FleetState) => state.environments.find((item) => item.id === environmentId) ?? null,
      [environmentId]
    )
  )
  const hostState = host ? environmentState(host.lifecycle) : null
  const [now, setNow] = useState(Date.now())
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // A host that starts is reached at once, not at the next retry.
  useEffect(() => {
    if (hostState === 'running' && bridge === 'unavailable') chats.reconnectNow()
  }, [hostState])

  async function start() {
    if (!controller || !host) return
    setStarting(true)
    setStartError(null)
    try {
      await controller.source.call('environmentStart', { params: { eid: host.id } })
    } catch (error) {
      setStartError(shownError(error, t('chatHost.startFailed')))
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (bridge !== 'retrying' && bridge !== 'unavailable') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [bridge])

  if (!fleetOpen || bridge === 'open' || bridge === 'closed' || bridge === 'unauthorized') return null
  const seconds = Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000))
  let title: string
  let detail: string | null = null
  let retry = false
  if (bridge === 'connecting') {
    if (quiet && !loaded) return null
    title = t('chatHost.connecting')
  } else if (bridge === 'retrying') {
    title = t('chatHost.retrying')
    detail = t('conn.retrying', { seconds })
    retry = true
  } else if (bridge === 'unavailable') {
    if (host && hostState !== 'running') {
      title = t(hostState === 'starting' ? 'chatHost.starting' : 'chatHost.stopped', { name: host.name })
      detail = startError ?? (hostState === 'starting' ? null : t('chatHost.stoppedDetail'))
    } else {
      title = t('chatHost.unavailable')
      detail = t('chatHost.unavailableDetail')
      retry = true
    }
  } else if (bridge === 'unsupported') {
    title = t('chatHost.unsupported')
  } else {
    title = t('chatHost.refused', { server: active?.name ?? '' })
  }
  const tone = bridge === 'connecting' ? palette.muted : palette.brick
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
      {bridge === 'connecting' ? (
        <ActivityIndicator size="small" color={palette.muted} />
      ) : (
        <Icon name={bridge === 'unsupported' || bridge === 'refused' ? 'alert' : 'wifi-off'} size={18} color={tone} />
      )}
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 13.5, lineHeight: 18 }}>{title}</AppText>
        {detail ? (
          <AppText variant="small" tone="muted">
            {detail}
          </AppText>
        ) : null}
      </View>
      {retry ? (
        <Button label={t('conn.retryNow')} onPress={() => chats.reconnectNow()} variant="secondary" size="sm" />
      ) : null}
      {bridge === 'unavailable' && hostState === 'stopped' ? (
        <Button
          label={t('chatHost.start')}
          accessibilityLabel={t('chatHost.startNamed', { name: host?.name ?? '' })}
          onPress={() => void start()}
          busy={starting}
          disabled={starting}
          variant="secondary"
          size="sm"
        />
      ) : null}
    </View>
  )
}
