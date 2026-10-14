import { getAppSetting, setAppSetting } from '../../store'
import { secureGet, secureRemove, secureSet } from '../../secure-store'
import { isWebSearchProvider, type WebSearchKeyProvider, type WebSearchProvider } from '../../../shared/web-search'

export const WEB_SEARCH_PROVIDER_SETTING = 'chat.webSearch.provider'
// "apiKey" keeps the ciphertext out of data exports, whose secret filter matches setting names.
const keySetting = (provider: WebSearchKeyProvider) => `chat.webSearch.apiKey.${provider}`
/** Session-only fallback when the OS keyring is unavailable, as chat/credentials.ts does for provider keys. */
const memoryKeys = new Map<WebSearchKeyProvider, string>()

export function getWebSearchProvider(): WebSearchProvider {
  try {
    const raw = getAppSetting(WEB_SEARCH_PROVIDER_SETTING)
    return isWebSearchProvider(raw) ? raw : 'auto'
  } catch {
    // Tool registry callers run before/without a database in some paths; absence means the default.
    return 'auto'
  }
}

export function setWebSearchProvider(provider: WebSearchProvider): void {
  setAppSetting(WEB_SEARCH_PROVIDER_SETTING, provider)
}

export function webSearchToolEnabled(): boolean {
  return getWebSearchProvider() !== 'off'
}

export function getWebSearchKey(provider: WebSearchKeyProvider): string | null {
  return memoryKeys.get(provider) ?? secureGet(keySetting(provider))
}

export function setWebSearchKey(provider: WebSearchKeyProvider, key: string): 'secure' | 'memory' {
  const value = key.trim()
  if (!value) throw new Error('Empty web search key')
  if (secureSet(keySetting(provider), value)) {
    memoryKeys.delete(provider)
    return 'secure'
  }
  memoryKeys.set(provider, value)
  return 'memory'
}

export function clearWebSearchKey(provider: WebSearchKeyProvider): void {
  memoryKeys.delete(provider)
  secureRemove(keySetting(provider))
}

export function webSearchKeysPresent(): Record<WebSearchKeyProvider, boolean> {
  return { tavily: Boolean(getWebSearchKey('tavily')), brave: Boolean(getWebSearchKey('brave')) }
}
