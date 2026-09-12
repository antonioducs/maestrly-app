import { EventEmitter } from 'node:events'
import { playSound } from './platform'
import { DEFAULT_SOUND_SETTINGS, effectiveVolume, type SoundEvent, type SoundSettings } from '../shared/sound'

/**
 * Per-agent status machine driven by Claude Code hooks: UserPromptSubmit moves idle/ready to working;
 * Stop or Notification(idle_prompt) moves working to ready with an alert; StopFailure moves to error
 * with an alert. Stop fires per turn, not on interruption. Stop/UserPromptSubmit do not accept
 * matchers; Notification uses notification_type. With --dangerously-skip-permissions,
 * permission_prompt rarely occurs, so idle_prompt supplies the signal.
 */

export type AgentStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'asking' | 'error'

interface AgentState {
  id: string
  status: AgentStatus
  lastSoundAt: number
  lastPlanSoundAt: number
}

const SOUND_DEDUPE_MS = 2000
// platform.playSound(voice, volume) uses Maestrly WAV assets with native fallback. Settings select voice,
// mute, and volume per event plus global mute/volume (#315).

export class AgentRegistry extends EventEmitter {
  private agents = new Map<string, AgentState>()
  // Main loads persisted alert settings at boot and applies Settings changes immediately through
  // setSoundSettings, without restart (#315).
  private soundSettings: SoundSettings = DEFAULT_SOUND_SETTINGS

  /** Update sound configuration at boot and when Settings change. */
  setSoundSettings(s: SoundSettings): void {
    this.soundSettings = s
  }

  /**
   * Play the event voice at effective master-times-event volume, respecting global/event mute and key
   * deduplication. Zero effective volume is silent and does not consume the dedupe window.
   */
  private maybePlay(a: AgentState, event: SoundEvent, key: 'lastSoundAt' | 'lastPlanSoundAt'): void {
    const vol = effectiveVolume(this.soundSettings, event)
    if (vol <= 0) return
    if (Date.now() - a[key] <= SOUND_DEDUPE_MS) return
    a[key] = Date.now()
    playSound(this.soundSettings.events[event], vol)
  }

  private ensure(id: string): AgentState {
    let a = this.agents.get(id)
    if (!a) {
      a = { id, status: 'idle', lastSoundAt: 0, lastPlanSoundAt: 0 }
      this.agents.set(id, a)
    }
    return a
  }

  getStatus(id: string): AgentStatus {
    return this.agents.get(id)?.status ?? 'idle'
  }

  /** Chat started a turn. */
  markWorking(id: string): void {
    this.transition(this.ensure(id), 'working')
  }

  /** Chat completed a turn. */
  markReady(id: string, silent = false): void {
    const a = this.ensure(id)
    if (a.status !== 'working') return
    this.transition(a, 'ready', !silent)
  }

  /** Chat failed during a turn. */
  markError(id: string): void {
    const a = this.ensure(id)
    if (a.status !== 'working') return
    this.transition(a, 'error', true)
  }

  /**
   * A pending ask_question pauses a BYOK Chat turn for the user. Enter asking, play the permission
   * alert, and show the sidebar question mark. Repeated asking updates are silent; answering returns to
   * working.
   */
  markAsking(id: string): void {
    const a = this.ensure(id)
    if (a.status === 'asking') return
    this.transition(a, 'asking', true)
  }

  /**
   * Alert when review_plan arrives without changing turn status. A separate lastPlanSoundAt dedupe
   * window prevents interference with other event sounds; sound settings still apply.
   */
  playPlanSound(id: string): void {
    this.maybePlay(this.ensure(id), 'plan', 'lastPlanSoundAt')
  }

  /**
   * Play the configured ready alert without changing or emitting status. Used for external attention
   * events such as Companion completion.
   */
  playReadySound(id: string): void {
    this.maybePlay(this.ensure(id), 'ready', 'lastSoundAt')
  }

  private transition(a: AgentState, status: AgentStatus, sound = false): void {
    a.status = status
    if (sound) {
      // Derive the sound event from the target status (ready/error/permission). These mutually exclusive
      // transitions share lastSoundAt deduplication, preserving the pre-#315 behavior.
      const event: SoundEvent =
        status === 'error' ? 'error' : status === 'waiting' || status === 'asking' ? 'permission' : 'ready'
      this.maybePlay(a, event, 'lastSoundAt')
    }
    this.emit('status', { agentId: a.id, status })
  }
}
