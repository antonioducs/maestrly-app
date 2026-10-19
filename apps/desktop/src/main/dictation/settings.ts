import { getAppSetting, setAppSetting } from '../store'
import { secureGet, secureRemove, secureSet } from '../secure-store'
import {
  isDictationEngine,
  type DictationApiProvider,
  type DictationConfig,
  type DictationEngine,
} from '../../shared/dictation'

export const DICTATION_ENGINE_SETTING = 'chat.dictation.engine'
// "apiKey" keeps the ciphertext out of data exports, whose secret filter matches setting names.
const keySetting = (provider: DictationApiProvider) => `chat.dictation.apiKey.${provider}`
/** Session-only fallback when the OS keyring is unavailable, as chat/credentials.ts does for provider keys. */
const memoryKeys = new Map<DictationApiProvider, string>()

export function getDictationEngine(): DictationEngine {
  try {
    const raw = getAppSetting(DICTATION_ENGINE_SETTING)
    return isDictationEngine(raw) ? raw : 'local'
  } catch {
    // No database yet: absence means the default.
    return 'local'
  }
}

export function setDictationEngine(engine: DictationEngine): void {
  setAppSetting(DICTATION_ENGINE_SETTING, engine)
}

export function getDictationKey(provider: DictationApiProvider): string | null {
  return memoryKeys.get(provider) ?? secureGet(keySetting(provider))
}

export function setDictationKey(provider: DictationApiProvider, key: string): 'secure' | 'memory' {
  const value = key.trim()
  if (!value) throw new Error('Empty dictation key')
  if (secureSet(keySetting(provider), value)) {
    memoryKeys.delete(provider)
    return 'secure'
  }
  memoryKeys.set(provider, value)
  return 'memory'
}

export function clearDictationKey(provider: DictationApiProvider): void {
  memoryKeys.delete(provider)
  secureRemove(keySetting(provider))
}

export function dictationConfig(): DictationConfig {
  return {
    engine: getDictationEngine(),
    keys: { openai: Boolean(getDictationKey('openai')), groq: Boolean(getDictationKey('groq')) },
  }
}
