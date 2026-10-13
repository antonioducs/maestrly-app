import { router } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts } from '../theme/tokens'
import { Avatar, type AvatarStatus } from '../ui/Avatar'
import { BrandMark } from '../ui/BrandMark'
import { OnboardingScreen } from '../ui/Onboarding'
import { Button } from '../ui/primitives/Button'
import { AppText } from '../ui/primitives/Text'

export default function Welcome() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { exploreDemo } = useServers()
  const [busy, setBusy] = useState(false)
  const preview: { name: string; tint: string; status: AvatarStatus; line: string; tone: 'mono' | 'cue' | 'plain' }[] =
    [
      { name: 'Juno', tint: '#3c8c68', status: 'working', line: t('welcome.previewWorking'), tone: 'mono' },
      { name: 'Atlas', tint: '#4f7cac', status: 'waiting', line: t('status.permission'), tone: 'cue' },
      { name: 'Ledger', tint: '#c0663f', status: 'idle', line: t('welcome.previewIdle'), tone: 'plain' },
    ]
  return (
    <OnboardingScreen
      actions={
        <>
          <Button label={t('welcome.scan')} icon="qr" size="lg" onPress={() => router.push('/scan')} />
          <Button label={t('welcome.manual')} variant="secondary" size="lg" onPress={() => router.push('/pair')} />
          {__DEV__ ? (
            <Button
              label={t('welcome.demo')}
              variant="ghost"
              busy={busy}
              onPress={() => {
                setBusy(true)
                void exploreDemo().then(() => router.replace('/home'))
              }}
            />
          ) : null}
        </>
      }
    >
      <BrandMark size={60} radius={15} />
      <View
        aria-hidden
        style={{
          marginTop: 28,
          marginBottom: 32,
          padding: 6,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: palette.line,
          backgroundColor: palette.raised,
        }}
      >
        {preview.map((row, index) => (
          <View
            key={row.name}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderTopWidth: index ? 1 : 0,
              borderTopColor: palette.line,
            }}
          >
            <Avatar name={row.name} tint={row.tint} status={row.status} size={40} />
            <View style={{ flex: 1 }}>
              <AppText variant="bodyMedium">{row.name}</AppText>
              <AppText
                numberOfLines={1}
                variant={row.tone === 'mono' ? 'mono' : 'small'}
                tone={row.tone === 'cue' ? 'cue' : 'muted'}
                style={row.tone === 'cue' ? { fontFamily: fonts.bodySemi } : undefined}
              >
                {row.line}
              </AppText>
            </View>
          </View>
        ))}
      </View>
      <View style={{ marginTop: 'auto' }}>
        <AppText variant="display" accessibilityRole="header" style={{ marginBottom: 12 }}>
          {t('welcome.title')}
        </AppText>
        <AppText tone="muted">{t('welcome.lede')}</AppText>
      </View>
    </OnboardingScreen>
  )
}
