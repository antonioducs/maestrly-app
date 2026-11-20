import { type HostId, hostKey, isRemoteHostId } from '../../shared/host-key'
import type { LocalRoutine, LocalRoutineRun } from '../../shared/routines'
import type { SoundEvent } from '../../shared/sound'
import type { ConversationNoticeKind, ConversationNotices } from './conversation-notices'
import type { RoutineNotices } from './routine-notices'

const SOUNDS: Record<ConversationNoticeKind, SoundEvent> = {
  finished: 'ready',
  failed: 'error',
  question: 'permission',
  permission: 'permission',
  plan: 'plan',
}

const ROUTINE_ALERTS_MAX = 500

export interface HostConversationAlertsDeps {
  notices: Pick<ConversationNotices, 'status' | 'plan' | 'seen'>
  routines?: Pick<RoutineNotices, 'notifyRun' | 'seen'>
  hostLabel?: (hostId: HostId) => string | null
  /** Plays an alert of a host's conversation, by its host key, as the sound settings allow. */
  play(conversationKey: string, event: SoundEvent): void
}

/**
 * The alerts of remote hosts' conversations and routine runs, whose apps play and show nothing on this computer:
 * their statuses, plans, routine toasts, and marks reach it as host events. A host sends each event to every window
 * of this computer that follows it, so repeats are dropped.
 */
export class HostConversationAlerts {
  private readonly statuses = new Map<string, string>()
  private readonly plans = new Map<string, unknown>()
  /** What each remote run last alerted of, by its host key; a run alerts a few times at most, then ends. */
  private readonly routineAlerts = new Map<string, string>()

  constructor(private readonly deps: HostConversationAlertsDeps) {}

  event(hostId: HostId, channel: string, args: unknown[]): void {
    if (!isRemoteHostId(hostId)) return
    const payload = args[0]
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    if (channel === 'routines:toast') {
      if (value.kind !== 'result') return
      const routine = value.routine as Pick<LocalRoutine, 'id' | 'title'> | undefined
      const run = value.run as LocalRoutineRun | undefined
      if (!routine || typeof routine.id !== 'string' || typeof routine.title !== 'string') return
      if (!run || typeof run.id !== 'string' || typeof run.status !== 'string') return
      const runKey = hostKey(hostId, run.id)
      // A run may ask for the owner several times: each request is news, a repeat of the same one is not.
      const alertKey =
        run.status === 'waiting' ? `waiting:${run.waiting?.kind ?? ''}:${run.waiting?.prompt ?? ''}` : run.status
      if (this.routineAlerts.get(runKey) === alertKey) return
      this.routineAlerts.delete(runKey)
      this.routineAlerts.set(runKey, alertKey)
      if (this.routineAlerts.size > ROUTINE_ALERTS_MAX) {
        const oldest = this.routineAlerts.keys().next().value
        if (oldest !== undefined) this.routineAlerts.delete(oldest)
      }
      this.deps.routines?.notifyRun(run, routine, { hostId, label: this.deps.hostLabel?.(hostId) ?? null })
      const soundKey = run.conversationId ? hostKey(hostId, run.conversationId) : runKey
      const sound: SoundEvent =
        run.status === 'failed' ? 'error' : run.status === 'waiting' ? 'permission' : 'ready'
      this.deps.play(soundKey, sound)
      return
    }
    // The host tells when the owner sees a run on any computer.
    if (channel === 'routines:seen') {
      if (typeof value.runId === 'string') this.deps.routines?.seen(hostKey(hostId, value.runId))
      return
    }
    if (channel === 'agent:status') {
      const { agentId, status, alert } = value
      if (typeof agentId !== 'string' || typeof status !== 'string') return
      const key = hostKey(hostId, agentId)
      if (this.statuses.get(key) === status) return
      if (status === 'idle') this.statuses.delete(key)
      else this.statuses.set(key, status)
      if (status === 'working') this.plans.delete(key)
      // A host older than this computer sends no `alert`: each of its statuses counts.
      const kind = this.deps.notices.status(key, status, alert !== false)
      if (kind) this.deps.play(key, SOUNDS[kind])
      return
    }
    if (channel === 'plan:received') {
      if (typeof value.agentId !== 'string') return
      const key = hostKey(hostId, value.agentId)
      if (this.plans.has(key) && this.plans.get(key) === value.version) return
      this.plans.set(key, value.version)
      this.deps.play(key, SOUNDS[this.deps.notices.plan(key)])
      return
    }
    // The host clears a conversation's mark once the owner sees it on any computer.
    if (channel === 'conversation:attention' && value.attention === false && typeof value.conversationId === 'string')
      this.deps.notices.seen(hostKey(hostId, value.conversationId))
  }
}
