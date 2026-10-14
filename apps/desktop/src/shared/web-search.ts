/** Web search provider choice shared by the main process (tool, settings IPC) and the settings UI. */
export const WEB_SEARCH_PROVIDERS = ['auto', 'tavily', 'brave', 'chatgpt', 'duckduckgo', 'off'] as const
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number]

/** Providers that need a user API key. */
export const WEB_SEARCH_KEY_PROVIDERS = ['tavily', 'brave'] as const
export type WebSearchKeyProvider = (typeof WEB_SEARCH_KEY_PROVIDERS)[number]

/** What the renderer learns: the selected provider and whether each key is set, never the keys themselves. */
export interface WebSearchConfig {
  provider: WebSearchProvider
  keys: Record<WebSearchKeyProvider, boolean>
}

export const WEB_SEARCH_TOOL_NAME = 'web_search'

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value)
}

export function isWebSearchKeyProvider(value: unknown): value is WebSearchKeyProvider {
  return typeof value === 'string' && (WEB_SEARCH_KEY_PROVIDERS as readonly string[]).includes(value)
}
