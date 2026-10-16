import type { FleetDevice } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { formatDateTime } from '../fleet/format'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { confirm } from '../ui/confirm'
import { shownError } from '../ui/conversation/CueCard'
import { Icon } from '../ui/icons'
import { Button } from '../ui/primitives/Button'
import { Group } from '../ui/primitives/Group'
import { AppText } from '../ui/primitives/Text'
import { SheetScreen } from '../ui/SheetScreen'

function DeviceRow({ device, onRemove }: { device: FleetDevice; onRemove: () => void }) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  const what = [
    t(device.kind ? `devices.kind.${device.kind}` : 'devices.kind.unknown'),
    device.platform ? t(`devices.platform.${device.platform}`) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 }}>
      <Icon name={device.kind === 'computer' ? 'laptop' : 'smartphone'} size={20} color={palette.muted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText numberOfLines={1} style={{ fontSize: 16, fontWeight: '600' }}>
          {device.current ? t('devices.thisPhone', { name: device.name }) : device.name}
        </AppText>
        <AppText variant="small" tone="muted">
          {what}
          {device.notifications ? ` · ${t('devices.notifications')}` : ''}
        </AppText>
        <AppText variant="small" tone="muted">
          {t('devices.paired', { date: formatDateTime(device.pairedAt, locale) })}
        </AppText>
        <AppText variant="small" tone="muted">
          {device.lastSeenAt
            ? t('devices.lastSeen', { date: formatDateTime(device.lastSeenAt, locale) })
            : t('devices.neverSeen')}
        </AppText>
      </View>
      {device.current ? null : (
        <Button
          label={t('devices.remove')}
          accessibilityLabel={t('devices.removeNamed', { name: device.name })}
          variant="danger"
          size="sm"
          onPress={onRemove}
        />
      )}
    </View>
  )
}

/** The phones and computers paired with the active server; any of them can remove another one. */
export default function Devices() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { active, controller } = useServers()
  const [devices, setDevices] = useState<FleetDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!controller) return
    setError(null)
    try {
      setDevices((await controller.source.call('devicesList')).devices)
    } catch (cause) {
      setError(shownError(cause, t('devices.loadFailed')))
    }
  }, [controller, t])
  useEffect(() => {
    void load()
  }, [load])

  async function remove(device: FleetDevice) {
    if (!controller) return
    const sure = await confirm({
      title: t('devices.removeTitle', { name: device.name }),
      message: t('devices.removeBody', { name: device.name, server: active?.name ?? '' }),
      confirmLabel: t('devices.remove'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })
    if (!sure) return
    try {
      await controller.source.call('deviceRevoke', { params: { deviceId: device.id } })
      await load()
    } catch (cause) {
      setError(shownError(cause, t('devices.removeFailed')))
    }
  }

  return (
    <SheetScreen title={t('devices.title')} onDone={() => router.back()}>
      <Group foot={t('devices.foot', { server: active?.name ?? '' })}>
        {devices === null && !error ? (
          <ActivityIndicator color={palette.muted} style={{ margin: 16 }} accessibilityLabel={t('common.loading')} />
        ) : (
          (devices ?? []).map((device) => (
            <DeviceRow key={device.id} device={device} onRemove={() => void remove(device)} />
          ))
        )}
      </Group>
      {error ? (
        <View style={{ gap: 8, marginTop: 8, marginHorizontal: 6 }}>
          <AppText accessibilityRole="alert" style={{ color: palette.brick }}>
            {error}
          </AppText>
          <Button label={t('devices.retry')} variant="secondary" size="sm" onPress={() => void load()} />
        </View>
      ) : null}
    </SheetScreen>
  )
}
