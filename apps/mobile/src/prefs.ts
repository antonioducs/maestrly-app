import AsyncStorage from '@react-native-async-storage/async-storage'

/** Small app preferences (theme, language). Never secrets: tokens live in the secure store. */
export const prefs = {
  async get(key: 'prefs.theme' | 'prefs.locale'): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key)
    } catch {
      return null
    }
  },
  async set(key: 'prefs.theme' | 'prefs.locale', value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value)
    } catch {
      // A preference that is not saved only lasts until the app closes.
    }
  },
}
