import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../secure-store'
import { getAppSetting, setAppSetting } from '../store'
import type { PeerStorage } from './identity'

/** Peer state in this profile: records in app settings, keys and tokens through the OS keyring. */
export const appPeerStorage: PeerStorage = {
  get: (key) => getAppSetting(key),
  set: (key, value) => setAppSetting(key, value),
  getSecret: (key) => secureGet(key),
  setSecret: (key, value) => secureSet(key, value),
  removeSecret: (key) => void secureRemove(key),
  secretsAvailable: () => isSecureStorageAvailable(),
}
