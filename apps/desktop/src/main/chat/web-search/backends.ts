import { createBraveBackend } from './brave'
import { createChatGptBackend } from './chatgpt'
import { createDuckDuckGoBackend } from './duckduckgo'
import { createGoogleBackend } from './google'
import { createTavilyBackend } from './tavily'
import type { WebSearchBackend, WebSearchBackendId } from './types'

export function webSearchBackends(): Record<WebSearchBackendId, WebSearchBackend> {
  return {
    tavily: createTavilyBackend(),
    brave: createBraveBackend(),
    chatgpt: createChatGptBackend(),
    google: createGoogleBackend(),
    duckduckgo: createDuckDuckGoBackend(),
  }
}
