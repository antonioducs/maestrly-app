import type { ArtifactHostEvent } from '@maestrly/artifact-host'
import type { ArtifactActivity } from '../../shared/artifacts'
import { effectiveVolume, type SoundSettings, type SoundVoice } from '../../shared/sound'

export interface ArtifactEventDeps {
  broadcast: (channel: string, payload?: unknown) => void
  soundSettings: () => SoundSettings
  playSound: (voice: SoundVoice, volume: number) => void
}

/**
 * Tells the windows what the artifact host reports. Every event refreshes the lists; activity also reaches the
 * sidebar counter, and someone waiting for access sounds like a permission request, since it needs the owner.
 */
export function createArtifactEventHandler(deps: ArtifactEventDeps): (event: ArtifactHostEvent) => void {
  return (event) => {
    deps.broadcast('artifacts:changed')
    if (event.type !== 'activity') return
    const activity: ArtifactActivity = { artifactId: event.artifactId, kind: event.kind }
    deps.broadcast('artifacts:activity', activity)
    if (event.kind !== 'access_requested') return
    const settings = deps.soundSettings()
    const volume = effectiveVolume(settings, 'permission')
    if (volume > 0) deps.playSound(settings.events.permission, volume)
  }
}
