import { CONVERSATION_TEMP_ENV_KEYS, conversationTempEnv, type ConversationTempEnv } from './conversation-temp'

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

/**
 * What a conversation's processes receive: the registered keys above, and its temporary directory, which this
 * process computes itself (conversation-temp) and no registration can set.
 */
export type ConversationProcessEnv = ConversationShellEnv & ConversationTempEnv

const registry = new Map<string, ConversationShellEnv>()

function allowedKeys<K extends string>(env: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const allowed: Partial<Record<K, string>> = {}
  if (!env || typeof env !== 'object') return allowed
  for (const key of keys) {
    const value = (env as Record<string, unknown>)[key]
    if (typeof value === 'string' && !value.includes('\0')) allowed[key] = value
  }
  return allowed
}

/** Keeps only the allowed keys with string values that an environment variable can hold. */
export function allowedConversationShellEnv(env: unknown): ConversationShellEnv {
  return allowedKeys(env, CONVERSATION_SHELL_ENV_KEYS)
}

/**
 * For a runtime that gets a conversation's environment from conversationShellEnv (a Claude query, a Codex thread):
 * the registered keys and the temporary directory, nothing else.
 */
export function allowedConversationProcessEnv(env: unknown): ConversationProcessEnv {
  return { ...allowedKeys(env, CONVERSATION_SHELL_ENV_KEYS), ...allowedKeys(env, CONVERSATION_TEMP_ENV_KEYS) }
}

/** Registers (or with `null` removes) the shell environment of one conversation. Unknown keys are dropped. */
export function setConversationShellEnv(conversationId: string, env: ConversationShellEnv | null): void {
  const allowed = allowedConversationShellEnv(env)
  if (Object.keys(allowed).length === 0) registry.delete(conversationId)
  else registry.set(conversationId, allowed)
}

/**
 * A copy of the conversation's environment: the registered keys, then its temporary directory. Empty when it has
 * neither, so the process values apply.
 */
export function conversationShellEnv(conversationId: string | undefined): ConversationProcessEnv {
  const env = conversationId === undefined ? undefined : registry.get(conversationId)
  return { ...env, ...conversationTempEnv(conversationId) }
}
