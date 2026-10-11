import { describe, expect, it, vi } from 'vitest'
import { createArtifactEventHandler } from '../../src/main/artifacts/activity'
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from '../../src/shared/sound'

const id = 'A'.repeat(22)

function setup(sound: Partial<SoundSettings> = {}) {
  const broadcast = vi.fn()
  const playSound = vi.fn()
  const handle = createArtifactEventHandler({
    broadcast,
    playSound,
    soundSettings: () => ({ ...DEFAULT_SOUND_SETTINGS, ...sound }),
  })
  return { broadcast, playSound, handle }
}

describe('artifact host events', () => {
  it('refreshes the lists on a change, without activity or sound', () => {
    const { broadcast, playSound, handle } = setup()
    handle({ type: 'changed', artifactId: id })
    expect(broadcast.mock.calls).toEqual([['artifacts:changed']])
    expect(playSound).not.toHaveBeenCalled()
  })

  it('announces activity, and sounds only when someone asks for access', () => {
    const { broadcast, playSound, handle } = setup({
      volume: 0.5,
      events: { ...DEFAULT_SOUND_SETTINGS.events, permission: 'ping' },
    })
    handle({ type: 'activity', artifactId: id, kind: 'device_added' })
    expect(broadcast.mock.calls).toEqual([
      ['artifacts:changed'],
      ['artifacts:activity', { artifactId: id, kind: 'device_added' }],
    ])
    expect(playSound).not.toHaveBeenCalled()
    handle({ type: 'activity', artifactId: id, kind: 'access_requested' })
    expect(broadcast).toHaveBeenLastCalledWith('artifacts:activity', { artifactId: id, kind: 'access_requested' })
    expect(playSound).toHaveBeenCalledWith('ping', 0.5)
  })

  it('stays silent when sounds or the permission sound are muted', () => {
    for (const sound of [
      { muted: true },
      { mutedEvents: { ...DEFAULT_SOUND_SETTINGS.mutedEvents, permission: true } },
      { volume: 0 },
    ]) {
      const { playSound, broadcast, handle } = setup(sound)
      handle({ type: 'activity', artifactId: id, kind: 'access_requested' })
      expect(playSound).not.toHaveBeenCalled()
      expect(broadcast).toHaveBeenCalledTimes(2)
    }
  })
})
