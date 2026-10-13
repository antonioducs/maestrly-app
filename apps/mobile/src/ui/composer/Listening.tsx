import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'

const nativeDriver = Platform.OS !== 'web'
const BARS = [0, 0.4, 0.8, 0.2, 0.6]

/** What the composer shows while dictating: a moving wave, then the words as the phone hears them. */
export function Listening({ text, starting }: { text: string; starting: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const phase = useRef(new Animated.Value(0)).current

  useEffect(() => {
    phase.setValue(0)
    if (reduced || starting) return
    const loop = Animated.loop(
      Animated.timing(phase, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: nativeDriver })
    )
    loop.start()
    return () => loop.stop()
  }, [phase, reduced, starting])

  return (
    <View style={{ minHeight: 34, paddingTop: 6, paddingBottom: 4, paddingHorizontal: 8, gap: 4 }}>
      <View
        accessibilityLiveRegion="polite"
        role="status"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View aria-hidden style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 }}>
          {BARS.map((offset) => (
            <Animated.View
              key={offset}
              style={{
                width: 3,
                height: 18,
                borderRadius: 2,
                backgroundColor: palette.brass,
                opacity: starting ? 0.4 : 1,
                transform: [
                  {
                    scaleY: phase.interpolate({
                      inputRange: [0, 0.5, 1],
                      outputRange: reduced
                        ? [0.6, 0.6, 0.6]
                        : [0.3 + offset * 0.5, 1 - offset * 0.4, 0.3 + offset * 0.5],
                    }),
                  },
                ],
              }}
            />
          ))}
        </View>
        <AppText variant="small" tone="muted">
          {starting ? t('dictation.starting') : t('dictation.listening')}
        </AppText>
      </View>
      {text ? (
        <AppText style={{ fontSize: 16, lineHeight: 22 }} numberOfLines={5}>
          {text}
        </AppText>
      ) : null}
    </View>
  )
}
