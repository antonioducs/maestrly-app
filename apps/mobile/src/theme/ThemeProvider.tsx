import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as SystemUI from 'expo-system-ui'
import { useColorScheme } from 'react-native'
import { prefs } from '../prefs'
import { palettes, type Palette } from './tokens'

export type ThemePreference = 'system' | 'light' | 'dark'
type Theme = {
  palette: Palette
  scheme: 'light' | 'dark'
  preference: ThemePreference
  setPreference: (value: ThemePreference) => void
  ready: boolean
}

const ThemeContext = createContext<Theme | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('system')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void prefs
      .get('prefs.theme')
      .catch(() => null)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark') setPreferenceState(saved)
        setReady(true)
      })
  }, [])
  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value)
    void prefs.set('prefs.theme', value)
  }, [])
  const value = useMemo(() => {
    const scheme = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference
    return { palette: palettes[scheme], scheme, preference, setPreference, ready }
  }, [preference, system, setPreference, ready])
  // The window behind every screen, seen while one slides in or the keyboard moves, follows the theme.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(value.palette.canvas).catch(() => {})
  }, [value.palette.canvas])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
