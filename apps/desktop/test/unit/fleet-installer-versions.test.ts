import { describe, expect, it } from 'vitest'
import { fleetUpdateState, knownServerVersion } from '../../src/shared/fleet-installer'

describe('the bot server version as best known', () => {
  it('prefers the release version the gateway reports over the one this computer recorded', () => {
    expect(knownServerVersion('0.9.3', '0.9.9')).toBe('0.9.9')
    expect(knownServerVersion('0.9.3', '0.9.1')).toBe('0.9.1')
    expect(knownServerVersion(null, '1.0.0')).toBe('1.0.0')
  })

  it('falls back to the recorded version without a reported release version', () => {
    expect(knownServerVersion('0.9.3', null)).toBe('0.9.3')
    // Development gateways report their package version or a test label, not a release.
    expect(knownServerVersion('0.9.3', 'test')).toBe('0.9.3')
    expect(knownServerVersion(null, 'local')).toBeNull()
  })

  it('offers an update only toward a newer app, never a downgrade', () => {
    expect(fleetUpdateState(knownServerVersion('0.9.3', '0.9.9'), '0.9.4')).toBe('server-newer')
    expect(fleetUpdateState(knownServerVersion('0.9.3', '0.9.4'), '0.9.4')).toBe('none')
    expect(fleetUpdateState(knownServerVersion('0.9.3', null), '0.9.4')).toBe('available')
  })
})
