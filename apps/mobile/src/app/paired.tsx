import { router } from 'expo-router'
import { View } from 'react-native'
import { useFleet } from '../fleet/react'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useNotifications } from '../notifications/NotificationsProvider'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { OnboardingScreen } from '../ui/Onboarding'
import { PairingMark } from '../ui/PairingMark'
import { Button } from '../ui/primitives/Button'
import { AppText } from '../ui/primitives/Text'

const selectCount = (state: FleetState) => (state.loaded ? state.bots.length : null)

function BotCount() {
  const { palette } = useTheme()
  const { plural } = useI18n()
  const count = useFleet(selectCount)
  if (count === null) return null
  return (
    <View
      style={{
        marginTop: 18,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: palette.surface,
      }}
    >
      <AppText style={{ fontSize: 13.5, fontWeight: '600' }}>{plural('bots.count', count)}</AppText>
    </View>
  )
}

export default function Paired() {
  const { t } = useI18n()
  const { active, controller, deviceName } = useServers()
  const notifications = useNotifications()
  // After pairing from the server list, the screens under this one are dropped too. Notifications are offered once.
  const done = () => {
    if (notifications.available && notifications.permission === 'undetermined' && !notifications.offered)
      router.replace('/notifications')
    else if (router.canDismiss()) router.dismissTo('/home')
    else router.replace('/home')
  }
  return (
    <OnboardingScreen center actions={<Button label={t('common.continue')} size="lg" onPress={done} />}>
      <PairingMark state="done" />
      <AppText
        variant="display"
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
        style={{ fontSize: 28, lineHeight: 32, textAlign: 'center' }}
      >
        {t('paired.title', { name: active?.name ?? '' })}
      </AppText>
      <AppText tone="muted" style={{ textAlign: 'center', marginTop: 12, maxWidth: 300 }}>
        {t('paired.body', { device: active?.deviceName ?? deviceName })}
      </AppText>
      {controller ? <BotCount /> : null}
    </OnboardingScreen>
  )
}
