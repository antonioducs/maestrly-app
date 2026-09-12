/**
 * Grok / xAI subscription provider (OAuth → OpenAI-compatible API).
 *
 * Client ID (public, no secret): defaults to the Grok-CLI/OpenCode OAuth client.
 * Optional overrides: MAIN_VITE_XAI_OAUTH_CLIENT_ID (build) / MAESTRLY_XAI_OAUTH_CLIENT_ID (dev).
 *
 * Tokens never cross preload/IPC. Runtime uses the generic AI SDK runner with an authenticated fetch.
 */
export * from './errors'
export * from './oauth'
export * from './token-store'
export * from './manager'
export * from './models'
