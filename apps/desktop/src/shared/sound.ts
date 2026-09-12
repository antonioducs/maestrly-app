export type SoundEvent = 'ready' | 'error' | 'permission' | 'plan'

export const SOUND_EVENTS: readonly SoundEvent[] = ['ready', 'error', 'permission', 'plan']

export type SoundVoice = 'glass' | 'submarine' | 'ping' | 'pop' | 'hero' | 'funk' | 'sosumi' | 'tink'

export const SOUND_VOICES: readonly SoundVoice[] = [
  'glass',
  'submarine',
  'ping',
  'pop',
  'hero',
  'funk',
  'sosumi',
  'tink',
]

export const SOUND_VOICE_LABELS: Record<SoundVoice, string> = {
  glass: 'Crystal',
  submarine: 'Bass Bell',
  ping: 'Cadence',
  pop: 'Pizzicato',
  hero: 'Crescendo',
  funk: 'Synth',
  sosumi: 'Dissonance',
  tink: 'Baton',
}

export interface SoundSettings {
  muted: boolean

  volume: number
  /** Voice for each event. */
  events: Record<SoundEvent, SoundVoice>

  mutedEvents: Record<SoundEvent, boolean>
  /** Volume (0..1) for each event. */
  volumes: Record<SoundEvent, number>
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  muted: false,
  volume: 1,
  events: { ready: 'glass', error: 'glass', permission: 'glass', plan: 'submarine' },
  mutedEvents: { ready: false, error: false, permission: false, plan: false },
  volumes: { ready: 1, error: 1, permission: 1, plan: 1 },
}

function isVoice(v: unknown): v is SoundVoice {
  return typeof v === 'string' && (SOUND_VOICES as readonly string[]).includes(v)
}

export function coerceVolume(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function coerceSoundSettings(raw: unknown): SoundSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawEvents = (r.events && typeof r.events === 'object' ? r.events : {}) as Record<string, unknown>
  const rawMuted = (r.mutedEvents && typeof r.mutedEvents === 'object' ? r.mutedEvents : {}) as Record<string, unknown>
  const rawVols = (r.volumes && typeof r.volumes === 'object' ? r.volumes : {}) as Record<string, unknown>

  const events = {} as Record<SoundEvent, SoundVoice>
  const mutedEvents = {} as Record<SoundEvent, boolean>
  const volumes = {} as Record<SoundEvent, number>
  for (const e of SOUND_EVENTS) {
    const v = rawEvents[e]
    if (v === 'off') {
      // Legacy format: 'off' mutes the default voice.
      events[e] = DEFAULT_SOUND_SETTINGS.events[e]
      mutedEvents[e] = true
    } else {
      events[e] = isVoice(v) ? v : DEFAULT_SOUND_SETTINGS.events[e]
      mutedEvents[e] =
        typeof rawMuted[e] === 'boolean' ? (rawMuted[e] as boolean) : DEFAULT_SOUND_SETTINGS.mutedEvents[e]
    }
    volumes[e] = coerceVolume(rawVols[e])
  }
  return {
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SOUND_SETTINGS.muted,
    volume: coerceVolume(r.volume),
    events,
    mutedEvents,
    volumes,
  }
}

export function effectiveVolume(s: SoundSettings, event: SoundEvent): number {
  if (s.muted || s.mutedEvents[event]) return 0
  return coerceVolume(s.volume) * coerceVolume(s.volumes[event])
}
