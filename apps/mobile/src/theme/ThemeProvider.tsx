import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
    void prefs.get('prefs.theme').then((saved) => {
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
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
