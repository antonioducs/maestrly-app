import { beforeEach, describe, expect, it, vi } from 'vitest'

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }))
vi.mock('../../src/main/platform', () => ({ playSound }))

import { AgentRegistry } from '../../src/main/agent-registry'
import { coerceSoundSettings, DEFAULT_SOUND_SETTINGS } from '../../src/shared/sound'

describe('AgentRegistry Chat-only', () => {
  beforeEach(() => playSound.mockClear())

  it('emits the working -> ready lifecycle and plays the final alert', () => {
    const registry = new AgentRegistry()
    const statuses: string[] = []
    registry.on('status', ({ status }) => statuses.push(status))
    registry.markWorking('chat-1')
    registry.markReady('chat-1')
    expect(statuses).toEqual(['working', 'ready'])
    expect(playSound).toHaveBeenCalledTimes(1)
  })

  it('ignores ready/error without an active turn', () => {
    const registry = new AgentRegistry()
    const listener = vi.fn()
    registry.on('status', listener)
    registry.markReady('chat-1')
    registry.markError('chat-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('marks a pending question and avoids duplicate alerts', () => {
    const registry = new AgentRegistry()
    registry.markWorking('chat-1')
    registry.markAsking('chat-1')
    registry.markAsking('chat-1')
    expect(registry.getStatus('chat-1')).toBe('asking')
    expect(playSound).toHaveBeenCalledTimes(1)
  })

  it('plays bot alerts with the event voices, once per bot at a time, unless bots are silenced', () => {
    const registry = new AgentRegistry()
    const statuses = vi.fn()
    registry.on('status', statuses)
    registry.setSoundSettings({
      ...DEFAULT_SOUND_SETTINGS,
      events: { ...DEFAULT_SOUND_SETTINGS.events, error: 'funk', permission: 'tink' },
      volumes: { ...DEFAULT_SOUND_SETTINGS.volumes, permission: 0.5 },
    })
    registry.playBotAlert('scout', 'error')
    registry.playBotAlert('scout', 'ready')
    registry.playBotAlert('orders', 'permission')
    // A conversation of the same id is not the bot: it keeps its own window.
    registry.markWorking('scout')
    registry.markReady('scout')
    expect(playSound.mock.calls).toEqual([
      ['funk', 1],
      ['tink', 0.5],
      ['glass', 1],
    ])
    expect(statuses.mock.calls.map(([event]) => event)).toEqual([
      { agentId: 'scout', status: 'working' },
      { agentId: 'scout', status: 'ready' },
    ])
    registry.setSoundSettings({ ...DEFAULT_SOUND_SETTINGS, bots: false })
    registry.playBotAlert('ads', 'ready')
    registry.setSoundSettings({ ...DEFAULT_SOUND_SETTINGS, muted: true })
    registry.playBotAlert('crm', 'ready')
    expect(playSound).toHaveBeenCalledTimes(3)
  })

  it('reads the bot switch from stored settings, on unless turned off', () => {
    expect(coerceSoundSettings(undefined).bots).toBe(true)
    expect(coerceSoundSettings({ bots: 'no' }).bots).toBe(true)
    expect(coerceSoundSettings({ bots: false })).toEqual({ ...DEFAULT_SOUND_SETTINGS, bots: false })
  })
})
