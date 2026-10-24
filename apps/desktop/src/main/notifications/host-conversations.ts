import { type HostId, hostKey, isRemoteHostId } from '../../shared/host-key'
import type { SoundEvent } from '../../shared/sound'
import type { ConversationNoticeKind, ConversationNotices } from './conversation-notices'

const SOUNDS: Record<ConversationNoticeKind, SoundEvent> = {
  finished: 'ready',
  failed: 'error',
  question: 'permission',
  plan: 'plan',
}

export interface HostConversationAlertsDeps {
  notices: Pick<ConversationNotices, 'status' | 'plan' | 'seen'>
  /** Plays an alert of a host's conversation, by its host key, as the sound settings allow. */
  play(conversationKey: string, event: SoundEvent): void
}

/**
 * The alerts of remote hosts' conversations, whose apps play and show nothing on this computer: their statuses,
 * plans, and marks reach it as host events. A host sends each event to every window of this computer that follows
 * it, so a repeat of a conversation's last status or plan is dropped.
 */
export class HostConversationAlerts {
  private readonly statuses = new Map<string, string>()
  private readonly plans = new Map<string, unknown>()

  constructor(private readonly deps: HostConversationAlertsDeps) {}

  event(hostId: HostId, channel: string, args: unknown[]): void {
    if (!isRemoteHostId(hostId)) return
    const payload = args[0]
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
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
