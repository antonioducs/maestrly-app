import { router } from 'expo-router'
import { View } from 'react-native'
import { useI18n } from '../i18n'
import { useNotifications } from '../notifications/NotificationsProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts } from '../theme/tokens'
import { BrandMark } from '../ui/BrandMark'
import { OnboardingScreen } from '../ui/Onboarding'
import { Button } from '../ui/primitives/Button'
import { AppText } from '../ui/primitives/Text'

/** A notification as the lock screen shows it, to show what to expect. */
function Sample({ title, body }: { title: string; body: string }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 18,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <BrandMark size={34} radius={9} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 14 }}>{title}</AppText>
        <AppText variant="sub" tone="muted">
          {body}
        </AppText>
      </View>
    </View>
  )
}

/** After pairing: notifications, offered once, with what they say and what they never say. */
export default function NotificationsOffer() {
  const { t } = useI18n()
  const notifications = useNotifications()
  const done = () => {
    notifications.markOffered()
    if (router.canDismiss()) router.dismissTo('/home')
    else router.replace('/home')
  }
  return (
    <OnboardingScreen
      center
      actions={
        <>
          <Button
            label={t('notifications.turnOn')}
            size="lg"
            onPress={() => void notifications.enable().finally(done)}
          />
          <Button label={t('notifications.notNow')} variant="ghost" onPress={done} />
        </>
      }
    >
      <View aria-hidden style={{ alignSelf: 'stretch', gap: 8, marginBottom: 28 }}>
        <Sample title="maestrly" body={t('notifications.sampleChat')} />
        <Sample title="Juno" body={t('notifications.sampleReply')} />
        <Sample title="Atlas" body={t('notifications.sampleApproval')} />
      </View>
      <AppText
        variant="display"
        accessibilityRole="header"
        style={{ fontSize: 28, lineHeight: 32, textAlign: 'center' }}
      >
        {t('notifications.offerTitle')}
      </AppText>
      <AppText tone="muted" style={{ textAlign: 'center', marginTop: 12, maxWidth: 320 }}>
        {t('notifications.offerBody')}
      </AppText>
    </OnboardingScreen>
  )
}
