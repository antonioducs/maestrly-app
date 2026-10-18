import { FLEET_DICTATION_FEATURE } from '@maestrly/bot-fleet-protocol'

/** Where the phone's dictation is transcribed: by the phone's own recognizer, or by the bot server. */
export type DictationChoice = 'phone' | 'server'

/** The choice is the phone's, kept per paired server. */
export const dictationChoiceKey = (serverId: string) => `dictation.engine.${serverId}`

export const isDictationChoice = (value: unknown): value is DictationChoice => value === 'phone' || value === 'server'

/**
 * The engine a dictation uses. The server's when the person chose it, or by default once the server has a key; the
 * phone's when the server cannot transcribe (too old, no key, the demo). `configured` is null until the server
 * answers, which keeps a stored choice of the server meanwhile.
 */
export function effectiveDictationChoice(
  stored: DictationChoice | null,
  server: { features: readonly string[]; configured: boolean | null; demo: boolean }
): DictationChoice {
  if (server.demo || !server.features.includes(FLEET_DICTATION_FEATURE) || server.configured === false) return 'phone'
  return stored ?? (server.configured ? 'server' : 'phone')
}
