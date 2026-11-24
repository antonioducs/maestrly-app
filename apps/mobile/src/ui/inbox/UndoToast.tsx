import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'
import { splitDismissedTemplate } from './format'

const TOAST_EASE = Easing.bezier(0.4, 0, 0.2, 1)
const nativeDriver = Platform.OS !== 'web'

export function UndoToast({
  toast,
  onUndo,
  bottomOffset = 0,
}: {
  toast: { id: number; title: string } | null
  onUndo: () => void
  bottomOffset?: number
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const progress = useRef(new Animated.Value(toast ? 1 : 0)).current

  useEffect(() => {
    if (!toast) {
      progress.setValue(0)
      return
    }
    if (reduced) {
      progress.setValue(1)
      return
    }
    progress.setValue(0)
    Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: TOAST_EASE,
      useNativeDriver: nativeDriver,
    }).start()
  }, [toast?.id, reduced, progress])

  if (!toast) return null

  const { before, title, after } = splitDismissedTemplate(t('inbox.dismissed'), toast.title)
  const msgColor = mix(palette.canvas, palette.ink, 0.82)
  const translateY = reduced ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] })

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: insets.bottom + 12 + bottomOffset,
        minHeight: 48,
        borderRadius: 14,
        backgroundColor: palette.ink,
        paddingLeft: 16,
        paddingRight: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.18,
        shadowRadius: 24,
        elevation: 8,
        opacity: progress,
        transform: [{ translateY }],
      }}
    >
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
        {before ? (
          <AppText style={{ fontSize: 14.5, lineHeight: 20, color: msgColor, flexShrink: 0 }}>{before}</AppText>
        ) : null}
        {title ? (
          <AppText
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ fontSize: 14.5, lineHeight: 20, color: msgColor, flexShrink: 1 }}
          >
            {title}
          </AppText>
        ) : null}
        {after ? (
          <AppText style={{ fontSize: 14.5, lineHeight: 20, color: msgColor, flexShrink: 0 }}>{after}</AppText>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('inbox.undo')}
        onPress={onUndo}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 14,
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 15, lineHeight: 20, color: palette.canvas }}>
          {t('inbox.undo')}
        </AppText>
      </Pressable>
    </Animated.View>
  )
}
