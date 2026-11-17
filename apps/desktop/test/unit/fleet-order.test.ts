import { describe, expect, it } from 'vitest'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { botOrderWith, canReorder, placeId, sameOrder, shiftId } from '../../src/renderer/lib/fleet/order'
import { compareByOrder, groupBotsByEnvironment, workspacesEnvironments } from '../../src/renderer/lib/fleet/selectors'
import { fleetReducer, initialFleetState } from '../../src/renderer/lib/fleet/state'

const at = '2026-11-17T00:00:00.000Z'
const bot = (id: string, environmentId: string | null, position: number | null, name = id) =>
  ({ id, name, environmentId, position }) as FleetBot
const environment = (id: string, position: number | null, kind: 'bots' | 'workspaces' = 'bots', name = id) =>
  ({ id, name, kind, position, botIds: [] }) as unknown as FleetEnvironment

describe('fleet order', () => {
  it('places an id before or after another and moves it one step at either end', () => {
    expect(placeId(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(placeId(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a'])
    expect(placeId(['a', 'b', 'c'], 'a', 'b', false)).toEqual(['a', 'b', 'c'])
    expect(placeId(['a', 'b'], 'a', 'ghost', true)).toEqual(['a', 'b'])
    expect(shiftId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(shiftId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(shiftId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(shiftId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(canReorder(['fleet-order'])).toBe(true)
    expect(canReorder([])).toBe(false)
  })

  it('lists environments and bots in the owner order, by name on servers that predate it', () => {
    const { groups, ungrouped } = groupBotsByEnvironment(
      [environment('work', 1), environment('home', 0), environment('host', 2, 'workspaces')],
      [bot('zed', 'home', 3), bot('amy', 'home', 4), bot('kit', 'work', 0), bot('lone', null, null)]
    )
    expect(groups.map((group) => [group.environment.id, group.bots.map((item) => item.id)])).toEqual([
      ['home', ['zed', 'amy']],
      ['work', ['kit']],
    ])
    expect(ungrouped.map((item) => item.id)).toEqual(['lone'])
    expect(
      [bot('b', null, null), bot('a', null, null), bot('z', null, 0)].sort(compareByOrder).map((item) => item.id)
    ).toEqual(['z', 'a', 'b'])
    expect(
      workspacesEnvironments([environment('y', 1, 'workspaces'), environment('x', 0, 'workspaces')]).map(
        (item) => item.id
      )
    ).toEqual(['x', 'y'])
  })

  it('sends every bot with one environment reordered, the others in their places', () => {
    const { groups, ungrouped } = groupBotsByEnvironment(
      [environment('home', 0), environment('work', 1)],
      [bot('a', 'home', 0), bot('b', 'home', 1), bot('c', 'work', 2), bot('d', 'work', 3)]
    )
    expect(botOrderWith(groups, ungrouped, 'work', ['d', 'c'])).toEqual(['a', 'b', 'd', 'c'])
    expect(botOrderWith(groups, ungrouped, 'home', ['b', 'a'])).toEqual(['b', 'a', 'c', 'd'])
  })

  it('keeps the snapshot in the owner order as bots and environments change', () => {
    let state = initialFleetState
    for (const item of [bot('zed', 'home', 0), bot('amy', 'home', 1)])
      state = fleetReducer(state, { type: 'event', value: { type: 'bot.updated', at, bot: item } })
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['zed', 'amy'])
    state = fleetReducer(state, { type: 'event', value: { type: 'bot.updated', at, bot: bot('amy', 'home', -1) } })
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['amy', 'zed'])
    for (const item of [environment('b', 0), environment('a', 1)])
      state = fleetReducer(state, { type: 'event', value: { type: 'environment.updated', at, environment: item } })
    expect(state.snapshot.environments.map((item) => item.id)).toEqual(['b', 'a'])
  })
})
