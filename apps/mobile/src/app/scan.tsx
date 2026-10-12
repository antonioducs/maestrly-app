import { parsePairingLink } from '@maestrly/bot-fleet-protocol'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { useRef, useState } from 'react'
import { Linking, Platform, View } from 'react-native'
import { useI18n } from '../i18n'
import { OnboardingScreen } from '../ui/Onboarding'
import { Button } from '../ui/primitives/Button'
import { AppText } from '../ui/primitives/Text'

const FRAME = 250
const corner = (position: 'tl' | 'tr' | 'bl' | 'br', color: string) => ({
  position: 'absolute' as const,
  width: 46,
  height: 46,
  borderColor: color,
  ...(position[0] === 't' ? { top: 0, borderTopWidth: 4 } : { bottom: 0, borderBottomWidth: 4 }),
  ...(position[1] === 'l' ? { left: 0, borderLeftWidth: 4 } : { right: 0, borderRightWidth: 4 }),
  [`border${position[0] === 't' ? 'Top' : 'Bottom'}${position[1] === 'l' ? 'Left' : 'Right'}Radius`]: 20,
})

export default function Scan() {
  const { t } = useI18n()
  const [permission, requestPermission] = useCameraPermissions()
  const [notMaestrly, setNotMaestrly] = useState(false)
  const handled = useRef(false)
  const close = () => (router.canGoBack() ? router.back() : router.replace('/welcome'))

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return
    const link = parsePairingLink(data)
    // Only a Maestrly pairing link leaves this screen; any other code is named and ignored.
    if (!link) {
      setNotMaestrly(true)
      return
    }
    handled.current = true
    router.replace({ pathname: '/pair', params: { server: link.origin, code: link.code } })
  }

  const camera = Platform.OS !== 'web' && permission?.granted
  let status = t('scan.point')
  let help = notMaestrly ? t('scan.notMaestrly') : t('scan.help')
  let action: { label: string; onPress: () => void } | null = null
  if (Platform.OS === 'web') {
    status = t('scan.title')
    help = t('scan.unavailable')
  } else if (permission && !permission.granted) {
    status = t('scan.permissionTitle')
    help = permission.canAskAgain ? t('scan.permissionHelp') : t('scan.denied')
    action = permission.canAskAgain
      ? { label: t('scan.allow'), onPress: () => void requestPermission() }
      : { label: t('scan.openSettings'), onPress: () => void Linking.openSettings() }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#050605' }}>
      {camera ? (
        <CameraView
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScanned}
        />
      ) : null}
      <OnboardingScreen
        dark
        title={t('scan.title')}
        back={{ icon: 'x', label: t('common.close'), onPress: close }}
        actions={
          <>
            {action ? <Button label={action.label} size="lg" variant="onDark" onPress={action.onPress} /> : null}
            <Button label={t('welcome.manual')} icon="keyboard" size="lg" variant="onDark" onPress={() => router.replace('/pair')} />
          </>
        }
      >
        <View
          aria-hidden
          style={{ width: FRAME, height: FRAME, alignSelf: 'center', marginTop: 56, marginBottom: 28 }}
        >
          {(['tl', 'tr', 'bl', 'br'] as const).map((position) => (
            <View key={position} style={corner(position, notMaestrly ? '#ff8288' : '#ffffff')} />
          ))}
        </View>
        <AppText
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          style={{ color: '#ffffff', textAlign: 'center', fontSize: 18, fontWeight: '600', marginBottom: 6 }}
        >
          {status}
        </AppText>
        <AppText
          accessibilityLiveRegion="polite"
          style={{ color: 'rgba(255,255,255,0.68)', textAlign: 'center', fontSize: 14, lineHeight: 20, maxWidth: 290, alignSelf: 'center' }}
        >
          {help}
        </AppText>
      </OnboardingScreen>
    </View>
  )
}
