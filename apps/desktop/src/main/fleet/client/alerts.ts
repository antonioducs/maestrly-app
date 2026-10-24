import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import type { SoundEvent } from '../../../shared/sound'

export type FleetAlert = Extract<SoundEvent, 'ready' | 'error' | 'permission'>

export type FleetBotNoticeKind =
  | 'finished'
  | 'failed'
  | 'routineFinished'
  | 'routineFailed'
  | 'needsYou'
  | 'threadPaused'

/** What a live activity entry means to the owner on this computer. */
export interface FleetBotEvent {
  botId: string
  /** The sound it plays, as the sound settings allow. */
  alert: FleetAlert | null
  /** What its system notification says; null when it shows none. */
  notice: FleetBotNoticeKind | null
  /** Whether it marks the bot in the sidebar until the owner opens it. */
  mark: boolean
  /** The routine run it happened in, which the notification opens. */
  runId?: string
  /** The conversation between bots it happened in, which the notification opens. */
  threadId?: string
  /**
   * The side conversation whose mark the owner clears by seeing it on any device (`owner-seen`): a run's own end
   * (`run:<id>`) or a thread's activity (`thread:<id>`). Absent for what only this computer clears: the bot's own
   * conversation, and the bot's answers to the owner's changes in a run, which a run's seen state does not cover.
   */
  lane?: string
  /** What the bot said last, or what waits for the owner. */
  summary: string | null
}

/** A turn answering one of these ends with an alert: the owner's own messages and what resumes after a takeover. */
const ownerSources: readonly string[] = ['owner', 'continuation']

/**
 * What a live activity entry calls for. A turn alerts when the owner started it, or when a gateway from before turns
 * carried their source does not say; a routine run alerts as the bot's "Tell me about finished runs" setting says;
 * a turn answering another bot only marks the bot. What waits for the owner always alerts, whoever started the turn,
 * and marks the bot only for a paused conversation between bots, which no inbox counts.
 */
export function fleetBotEventFor(entry: FleetActivityEntry): FleetBotEvent | null {
  const { botId, kind, data, summary } = entry
  if (!botId) return null
  // A turn of a conversation between bots names its thread, and its side conversation as its run.
  const threadId = typeof data.threadId === 'string' ? data.threadId : undefined
  const runId = !threadId && typeof data.runId === 'string' ? data.runId : undefined
  const where = { ...(runId ? { runId } : {}), ...(threadId ? { threadId } : {}) }
  const threadLane = threadId ? { lane: `thread:${threadId}` } : {}
  if (kind === 'needs_you')
    return {
      botId,
      alert: 'permission',
      notice: threadId ? 'threadPaused' : 'needsYou',
      mark: !!threadId,
      ...where,
      ...threadLane,
      summary,
    }
  if (kind !== 'turn_completed' && kind !== 'turn_failed') return null
  const completed = kind === 'turn_completed'
  const source = data.source
  if (source === 'routine')
    // A run that found nothing new, or that the bot's settings keep quiet, alerts no one.
    return data.alert === false
      ? null
      : {
          botId,
          alert: completed ? 'ready' : 'error',
          notice: completed ? 'routineFinished' : 'routineFailed',
          mark: true,
          ...where,
          ...(runId ? { lane: `run:${runId}` } : {}),
          summary,
        }
  if (typeof source === 'string' && !ownerSources.includes(source))
    return { botId, alert: null, notice: null, mark: true, ...where, ...threadLane, summary }
  return {
    botId,
    alert: completed ? 'ready' : 'error',
    notice: completed ? 'finished' : 'failed',
    mark: true,
    ...where,
    ...threadLane,
    summary,
  }
}

/** The alert a live activity entry calls for (see fleetBotEventFor). */
export function fleetAlertFor(entry: FleetActivityEntry): FleetAlert | null {
  return fleetBotEventFor(entry)?.alert ?? null
}
