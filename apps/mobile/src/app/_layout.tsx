import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold'
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular'
import { InstrumentSans_500Medium } from '@expo-google-fonts/instrument-sans/500Medium'
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { I18nProvider, useI18n } from '../i18n'
import { ThemeProvider, useTheme } from '../theme/ThemeProvider'

void SplashScreen.preventAutoHideAsync()

function Root() {
  const theme = useTheme()
  const i18n = useI18n()
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_600SemiBold,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    JetBrainsMono_400Regular,
  })
  // A font that fails to load falls back to the system font rather than keeping the splash up.
  const ready = (fontsLoaded || fontError !== null) && theme.ready && i18n.ready
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.palette.canvas } }} />
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Root />
      </I18nProvider>
    </ThemeProvider>
  )
}
