import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold'
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular'
import { InstrumentSans_500Medium } from '@expo-google-fonts/instrument-sans/500Medium'
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { I18nProvider, useI18n } from '../i18n'
import { ServersProvider, useServers } from '../servers/ServersProvider'
import { ThemeProvider, useTheme } from '../theme/ThemeProvider'

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
  // A font that fails to load falls back to the system font rather than keeping the splash up.
  const ready = (fontsLoaded || fontError !== null) && theme.ready && i18n.ready && servers.ready
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  const sheet = { ...SHEET, contentStyle: { backgroundColor: theme.palette.sheet } }
  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.palette.canvas } }}>
        <Stack.Screen name="settings" options={sheet} />
        <Stack.Screen name="servers" options={sheet} />
        <Stack.Screen name="bot-details/[id]" options={sheet} />
        <Stack.Screen name="bot-setup/[id]" options={{ ...sheet, sheetAllowedDetents: [1] }} />
        <Stack.Screen name="new-chat" options={sheet} />
        <Stack.Screen name="chat-setup/[id]" options={{ ...sheet, sheetAllowedDetents: [1] }} />
        <Stack.Screen name="chat-defaults" options={{ ...sheet, sheetAllowedDetents: [1] }} />
      </Stack>
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
