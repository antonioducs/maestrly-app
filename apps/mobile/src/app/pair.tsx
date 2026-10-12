import { isAllowedFleetUrl, normalizePairingCode } from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import { useI18n } from '../i18n'
import { PairingError } from '../servers/pairing'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts, mix } from '../theme/tokens'
import { Icon } from '../ui/icons'
import { OnboardingScreen } from '../ui/Onboarding'
import { PairingMark } from '../ui/PairingMark'
import { Button } from '../ui/primitives/Button'
import { AppText } from '../ui/primitives/Text'

const rawCode = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
const formatCode = (raw: string) => (raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw)
const hostOf = (address: string) => {
  try {
    return new URL(address.trim()).host
  } catch {
    return address.trim()
  }
}

/** A link from a QR code or a `maestrly://pair` link: shown for confirmation, never paired without a tap. */
function linkFromParams(params: { server?: string; code?: string }) {
  if (!params.server || !params.code) return null
  const allowed = isAllowedFleetUrl(params.server)
  const code = normalizePairingCode(params.code)
  return allowed.ok && code ? { origin: allowed.origin, code } : null
}

export default function Pair() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { pair } = useServers()
  const params = useLocalSearchParams<{ server?: string; code?: string }>()
  const [link] = useState(() => linkFromParams(params))
  const [address, setAddress] = useState(link?.origin ?? params.server ?? '')
  const [code, setCode] = useState(formatCode(rawCode(link?.code ?? params.code ?? '')))
  const [phase, setPhase] = useState<'form' | 'confirm' | 'pairing'>(link ? 'confirm' : 'form')
  const [error, setError] = useState<{ text: string; field: 'address' | 'code' | null } | null>(null)
  const [focused, setFocused] = useState<'address' | 'code' | null>(null)
  const host = hostOf(address)

  async function submit() {
    const back = phase
    setPhase('pairing')
    setError(null)
    try {
      await pair({ address: address.trim(), code })
      router.replace('/paired')
    } catch (cause) {
      const reason = cause instanceof PairingError ? cause.reason : 'failed'
      setError({
        text: t(`pair.error.${reason}`, { host }),
        field: reason === 'address' || reason === 'unreachable' ? 'address' : reason === 'code' || reason === 'expired' ? 'code' : null,
      })
      setPhase(back === 'confirm' && reason !== 'address' && reason !== 'code' ? 'confirm' : 'form')
    }
  }

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/welcome'))

  if (phase === 'pairing')
    return (
      <OnboardingScreen center>
        <PairingMark state="pairing" />
        <AppText variant="display" accessibilityRole="header" accessibilityLiveRegion="polite" style={{ fontSize: 28, lineHeight: 32, textAlign: 'center' }}>
          {t('pair.pairing')}
        </AppText>
        <AppText tone="muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {t('pair.talking', { host })}
        </AppText>
      </OnboardingScreen>
    )

  const errorBox = error ? (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        gap: 8,
        alignItems: 'flex-start',
        marginBottom: 16,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: mix(palette.brick, palette.raised, 0.12),
      }}
    >
      <Icon name="alert" size={18} color={palette.brick} />
      <AppText style={{ flex: 1, color: palette.brick, fontSize: 14, lineHeight: 20 }}>{error.text}</AppText>
    </View>
  ) : null

  if (phase === 'confirm')
    return (
      <OnboardingScreen
        center
        back={{ icon: 'x', label: t('common.cancel'), onPress: leave }}
        actions={
          <>
            <Button label={t('pair.confirm')} size="lg" onPress={() => void submit()} />
            <Button label={t('common.cancel')} variant="ghost" onPress={leave} />
          </>
        }
      >
        {errorBox}
        <PairingMark state="idle" />
        <AppText variant="display" accessibilityRole="header" style={{ fontSize: 28, lineHeight: 32, textAlign: 'center' }}>
          {t('pair.confirmTitle', { host })}
        </AppText>
        <AppText tone="muted" style={{ textAlign: 'center', marginTop: 12, maxWidth: 320 }}>
          {t('pair.confirmBody')}
        </AppText>
      </OnboardingScreen>
    )

  const input = (field: 'address' | 'code') => ({
    onFocus: () => setFocused(field),
    onBlur: () => setFocused(null),
    placeholderTextColor: palette.faint,
    autoCorrect: false,
    spellCheck: false,
    'aria-invalid': error?.field === field,
    style: {
      height: 50,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderRadius: 14,
      borderColor: error?.field === field ? palette.brick : focused === field ? palette.ink : palette.line,
      backgroundColor: palette.raised,
      color: palette.ink,
      fontFamily: field === 'code' ? fonts.mono : fonts.body,
      fontSize: field === 'code' ? 22 : 16,
      letterSpacing: field === 'code' ? 3 : 0,
    },
  })
  const ready = address.trim() !== '' && rawCode(code).length === 8

  return (
    <OnboardingScreen
      title={t('pair.title')}
      back={{ icon: 'chev-left', label: t('common.back'), onPress: leave }}
      actions={<Button label={t('pair.submit')} size="lg" disabled={!ready} onPress={() => void submit()} />}
    >
      <View style={{ paddingTop: 8 }}>
        {errorBox}
        <AppText variant="label" style={{ fontSize: 14, marginBottom: 6 }} nativeID="pair-address-label">
          {t('pair.address')}
        </AppText>
        <TextInput
          {...input('address')}
          value={address}
          onChangeText={setAddress}
          placeholder={t('pair.addressPlaceholder')}
          accessibilityLabel={t('pair.address')}
          inputMode="url"
          keyboardType="url"
          autoCapitalize="none"
          autoComplete="url"
          textContentType="URL"
          returnKeyType="next"
        />
        <AppText variant="label" style={{ fontSize: 14, marginTop: 18, marginBottom: 6 }}>
          {t('pair.code')}
        </AppText>
        <TextInput
          {...input('code')}
          value={code}
          onChangeText={(value) => setCode(formatCode(rawCode(value)))}
          placeholder="7KQ2-M9XD"
          accessibilityLabel={t('pair.code')}
          accessibilityHint={t('pair.codeHelp')}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={9}
          returnKeyType="go"
          onSubmitEditing={() => ready && void submit()}
        />
        <AppText variant="sub" tone="muted" style={{ marginTop: 8, fontSize: 13.5, lineHeight: 20 }}>
          {t('pair.codeHelp')}
        </AppText>
      </View>
    </OnboardingScreen>
  )
}
