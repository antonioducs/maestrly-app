import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Small app preferences (theme, language, whether the intro and the screen's gesture guide were seen). Never secrets:
 * tokens are in the secure store.
 */
type PrefKey = 'prefs.theme' | 'prefs.locale' | 'prefs.intro' | 'prefs.screenGuide'

export const prefs = {
  async get(key: PrefKey): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key)
    } catch {
      return null
    }
  },
  async set(key: PrefKey, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value)
    } catch {
      // A preference that is not saved only lasts until the app closes.
    }
  },
}
