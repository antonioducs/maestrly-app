import { beforeEach, describe, expect, it, vi } from 'vitest'

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }))
vi.mock('../../src/main/platform', () => ({ playSound }))

import { AgentRegistry } from '../../src/main/agent-registry'

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
})
