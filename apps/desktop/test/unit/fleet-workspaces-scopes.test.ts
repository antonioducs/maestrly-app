import { describe, expect, it } from 'vitest'
import { hostTint } from '../../src/renderer/lib/hosts/host-tint'
import {
  ENVIRONMENT_TINTS,
  cpuLimitChoices,
  cpuLimitFromValue,
  idleStopChoices,
  idleStopFromValue,
  idleStopParts,
  nextEnvironmentTint,
} from '../../src/renderer/lib/fleet/environments'
import { instanceColor } from '../../src/shared/instance-color'

describe('choices for a workspaces environment', () => {
  it('offers CPU limits up to the server, keeping one set elsewhere', () => {
    expect(cpuLimitChoices(null, 4).map((choice) => choice.cpus)).toEqual([null, 0.5, 1, 2, 4])
    expect(cpuLimitChoices(null, 6).map((choice) => choice.cpus)).toEqual([null, 0.5, 1, 2, 4, 6])
    expect(cpuLimitChoices(2.5, 4).map((choice) => choice.cpus)).toEqual([null, 0.5, 1, 2, 2.5, 4])
    // Unknown server: every whole choice.
    expect(cpuLimitChoices(null, null).map((choice) => choice.cpus)).toEqual([null, 0.5, 1, 2, 4, 8, 16])
    expect(cpuLimitFromValue('none')).toBeNull()
    expect(cpuLimitFromValue('2')).toBe(2)
  })

  it('offers idle stops from half an hour to a day, named in minutes or hours', () => {
    expect(idleStopChoices(null).map((choice) => choice.minutes)).toEqual([null, 30, 60, 120, 240, 480, 1440])
    expect(idleStopChoices(90).map((choice) => choice.minutes)).toContain(90)
    expect(idleStopFromValue('never')).toBeNull()
    expect(idleStopParts(30)).toEqual({ unit: 'minutes', count: 30 })
    expect(idleStopParts(90)).toEqual({ unit: 'minutes', count: 90 })
    expect(idleStopParts(120)).toEqual({ unit: 'hours', count: 2 })
  })

  it('suggests a color no other environment uses', () => {
    expect(nextEnvironmentTint([])).toBe(ENVIRONMENT_TINTS[0])
    expect(nextEnvironmentTint([null, ENVIRONMENT_TINTS[0].toUpperCase()])).toBe(ENVIRONMENT_TINTS[1])
    expect(nextEnvironmentTint([...ENVIRONMENT_TINTS])).toBe(ENVIRONMENT_TINTS[0])
  })
})

describe('the color of a machine in the sidebar', () => {
  it("is its environment's when chosen, one derived from its id otherwise, and the app's for this computer", () => {
    const remote = { id: 'server/personal', remote: true }
    expect(hostTint({ ...remote, tint: '#4c9a87' })).toEqual([0x4c, 0x9a, 0x87])
    expect(hostTint({ ...remote, tint: null })).toEqual(instanceColor('server/personal').rgb)
    expect(hostTint({ ...remote, tint: 'red' })).toEqual(instanceColor('server/personal').rgb)
    expect(hostTint({ id: 'local', remote: false, tint: '#4c9a87' })).toEqual([230, 223, 208])
  })
})
