/**
 * Shell environment that belongs to one conversation. A fleet bot sharing an environment with other bots has
 * its own apps display, session bus and browser; every shell it starts (the bash tool, drawer terminals and the
 * Codex/Claude runtimes) must see those instead of the process-wide values. Only these keys can be set, so a
 * registration can never change PATH, credentials or runtime flags.
 */
export const CONVERSATION_SHELL_ENV_KEYS = [
  'DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'BROWSER',
  'MAESTRLY_BOT_BROWSER_PROFILE',
  'GTK_THEME',
  'MAESTRLY_DESKTOP_SOCKET',
] as const

export type ConversationShellEnv = Partial<Record<(typeof CONVERSATION_SHELL_ENV_KEYS)[number], string>>

const registry = new Map<string, ConversationShellEnv>()

/** Keeps only the allowed keys with string values that an environment variable can hold. */
export function allowedConversationShellEnv(env: unknown): ConversationShellEnv {
  const allowed: ConversationShellEnv = {}
  if (!env || typeof env !== 'object') return allowed
  for (const key of CONVERSATION_SHELL_ENV_KEYS) {
    const value = (env as Record<string, unknown>)[key]
    if (typeof value === 'string' && !value.includes('\0')) allowed[key] = value
  }
  return allowed
}

/** Registers (or with `null` removes) the shell environment of one conversation. Unknown keys are dropped. */
export function setConversationShellEnv(conversationId: string, env: ConversationShellEnv | null): void {
  const allowed = allowedConversationShellEnv(env)
  if (Object.keys(allowed).length === 0) registry.delete(conversationId)
  else registry.set(conversationId, allowed)
}

/** A copy of the conversation's shell environment; empty when it has none, so the process values apply. */
export function conversationShellEnv(conversationId: string | undefined): ConversationShellEnv {
  const env = conversationId === undefined ? undefined : registry.get(conversationId)
  return env ? { ...env } : {}
}
