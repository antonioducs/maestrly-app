import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold'
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular'
import { InstrumentSans_500Medium } from '@expo-google-fonts/instrument-sans/500Medium'
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { I18nProvider, useI18n } from '../i18n'
import { NotificationsProvider } from '../notifications/NotificationsProvider'
import { ServersProvider, useServers } from '../servers/ServersProvider'
import { ThemeProvider, useTheme } from '../theme/ThemeProvider'
import { Intro } from '../ui/Intro'

void SplashScreen.preventAutoHideAsync()

const SHEET = {
  presentation: 'formSheet' as const,
  sheetAllowedDetents: [0.6, 1],
  sheetGrabberVisible: true,
  sheetCornerRadius: 26,
}

function Root() {
  const theme = useTheme()
  const i18n = useI18n()
  const servers = useServers()
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_600SemiBold,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    JetBrainsMono_400Regular,
  })
  // A font that fails to load falls back to the system font rather than keeping the intro up.
  const ready = (fontsLoaded || fontError !== null) && theme.ready && i18n.ready && servers.ready
  // The intro hides the native splash and covers the app while it gets ready below.
  const [intro, setIntro] = useState(true)
  const closeIntro = useCallback(() => setIntro(false), [])
  const sheet = { ...SHEET, contentStyle: { backgroundColor: theme.palette.sheet } }
  return (
    <>
      <StatusBar style={intro || theme.scheme === 'dark' ? 'light' : 'dark'} />
      {ready ? (
        <NotificationsProvider>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.palette.canvas } }}>
            <Stack.Screen name="settings" options={sheet} />
            <Stack.Screen name="servers" options={sheet} />
            <Stack.Screen name="devices" options={sheet} />
            <Stack.Screen name="bot-details/[id]" options={sheet} />
            <Stack.Screen name="bot-files/[id]" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="bot-setup/[id]" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="new-bot" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="new-chat" options={sheet} />
            <Stack.Screen name="chat-setup/[id]" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="chat-defaults" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="usage" options={sheet} />
            {/* The screen's own gestures pan and zoom it: no swipe closes it. */}
            <Stack.Screen
              name="bot-screen/[id]"
              options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'slide_from_bottom' }}
            />
          </Stack>
        </NotificationsProvider>
      ) : null}
      {intro ? <Intro ready={ready} onDone={closeIntro} /> : null}
    </>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nProvider>
          <ServersProvider>
            <Root />
          </ServersProvider>
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
