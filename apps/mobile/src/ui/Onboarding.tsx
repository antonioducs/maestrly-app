import type { ReactNode } from 'react'
import { KeyboardAvoidingView, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/ThemeProvider'
import type { IconName } from './icons'
import { IconButton } from './primitives/IconButton'
import { AppText } from './primitives/Text'

/** A full screen of the pairing flow: an optional top bar, scrolling content and actions at the bottom. */
export function OnboardingScreen({
  title,
  back,
  dark,
  center,
  actions,
  children,
}: {
  title?: string
  back?: { icon: IconName; label: string; onPress: () => void }
  dark?: boolean
  center?: boolean
  actions?: ReactNode
  children: ReactNode
}) {
  const { palette } = useTheme()
  const insets = useSafeAreaInsets()
  // A dark screen lies over the camera preview, which its parent draws.
  const background = dark ? 'transparent' : palette.canvas
  return (
    <KeyboardAvoidingView
      // Android draws the app edge to edge, so its window no longer shrinks for the keyboard either.
      behavior="padding"
      style={{ flex: 1, backgroundColor: background }}
    >
      <View style={{ flex: 1, paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14, paddingHorizontal: 24 }}>
        {back || title ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 44,
              marginHorizontal: -10,
              marginBottom: 8,
            }}
          >
            {back ? (
              <IconButton
                icon={back.icon}
                label={back.label}
                onPress={back.onPress}
                color={dark ? '#ffffff' : palette.ink}
                style={dark ? { backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 22 } : undefined}
              />
            ) : (
              <View style={{ width: 44 }} />
            )}
            {title ? (
              <AppText variant="heading" accessibilityRole="header" style={dark ? { color: '#ffffff' } : undefined}>
                {title}
              </AppText>
            ) : null}
            <View style={{ width: 44 }} />
          </View>
        ) : null}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: center ? 'center' : 'flex-start',
            alignItems: center ? 'center' : 'stretch',
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        {actions ? <View style={{ gap: 10, paddingTop: 24 }}>{actions}</View> : null}
      </View>
    </KeyboardAvoidingView>
  )
}
