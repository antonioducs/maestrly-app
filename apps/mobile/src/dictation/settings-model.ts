import { FLEET_DICTATION_FEATURE, type FleetDictationStatus } from '@maestrly/bot-fleet-protocol'

/**
 * What the Dictation settings offer for the active server. `serverOption`: whether **Server** can be chosen, or why
 * not. `keyForm`: whether the server's key can be set from here (any paired server that supports dictation).
 */
export function dictationSettingsView(input: {
  features: readonly string[]
  demo: boolean
  status: FleetDictationStatus | null
}): { serverOption: 'available' | 'no-key' | 'old-server' | 'offline'; keyForm: boolean } {
  if (input.demo) return { serverOption: 'offline', keyForm: false }
  if (!input.features.includes(FLEET_DICTATION_FEATURE)) return { serverOption: 'old-server', keyForm: false }
  if (!input.status) return { serverOption: 'offline', keyForm: true }
  return { serverOption: input.status.configured ? 'available' : 'no-key', keyForm: true }
}
