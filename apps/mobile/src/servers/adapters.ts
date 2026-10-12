import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { KeyValueStore, SecretStore } from './registry'

/** Keychain on iOS, Keystore on Android; readable after the first unlock and never restored to another device. */
export function secureSecrets(): SecretStore {
  const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
  return {
    get: (key) => SecureStore.getItemAsync(key, options),
    set: (key, value) => SecureStore.setItemAsync(key, value, options),
    delete: (key) => SecureStore.deleteItemAsync(key, options),
  }
}

export function asyncKeyValue(): KeyValueStore {
  return {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    delete: (key) => AsyncStorage.removeItem(key),
  }
}
