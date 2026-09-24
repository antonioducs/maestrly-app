import { describe, expect, it } from 'vitest'
import type { FleetBot, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'
import { botsWithDifferentVersion, ownsTakeover, takeoverBlocksResume } from '../../src/renderer/lib/fleet/selectors'

const takeover = (state: FleetTakeoverState['state'], deviceId: string | null = 'this-mac'): FleetTakeoverState => ({
  state,
  deviceId,
  deviceName: 'Mac',
  since: null,
})

describe('fleet renderer selectors', () => {
  it('grants control only to the paired device holding a human takeover', () => {
    expect(ownsTakeover(takeover('human'), 'this-mac')).toBe(true)
    expect(ownsTakeover(takeover('human'), 'other-mac')).toBe(false)
    expect(ownsTakeover(takeover('human'), null)).toBe(false)
    expect(ownsTakeover(takeover('acquiring'), 'this-mac')).toBe(false)
  })

  it('blocks resume throughout the takeover lifecycle', () => {
    for (const state of ['acquiring', 'human', 'releasing'] as const)
      expect(takeoverBlocksResume(takeover(state))).toBe(true)
    expect(takeoverBlocksResume(takeover('none', null))).toBe(false)
  })

  it('reports only known bot versions that differ from this Mac', () => {
    const bots = [
      { name: 'Same', appVersion: '0.9.2' },
      { name: 'Old', appVersion: '0.9.1' },
      { name: 'Pending', appVersion: null },
    ] as FleetBot[]
    expect(botsWithDifferentVersion(bots, '0.9.2').map((bot) => bot.name)).toEqual(['Old'])
    expect(botsWithDifferentVersion(bots, '')).toEqual([])
  })
})
