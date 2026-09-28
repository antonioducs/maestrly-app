import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import type { SoundEvent } from '../../../shared/sound'

export type FleetAlert = Extract<SoundEvent, 'ready' | 'error' | 'permission'>

/** A turn answering one of these ends with an alert: the owner's own messages and what resumes after a takeover. */
const ownerSources: readonly string[] = ['owner', 'continuation']

/**
 * The alert a live activity entry calls for. A turn sounds when the owner started it, or when a gateway from before
 * turns carried their source does not say; routines and peer messages end silently. What waits for the owner always
 * sounds, whoever started the turn.
 */
export function fleetAlertFor(entry: FleetActivityEntry): FleetAlert | null {
  if (!entry.botId) return null
  if (entry.kind === 'needs_you') return 'permission'
  if (entry.kind !== 'turn_completed' && entry.kind !== 'turn_failed') return null
  const source = entry.data.source
  if (typeof source === 'string' && !ownerSources.includes(source)) return null
  return entry.kind === 'turn_completed' ? 'ready' : 'error'
}
