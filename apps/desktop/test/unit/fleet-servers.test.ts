import { describe, expect, it } from 'vitest'
import {
  FLEET_SERVER_UNKNOWN,
  type FleetServerId,
  defaultFleetServer,
  fleetKey,
  isFleetServerId,
  parseFleetServerId,
} from '../../src/shared/fleet-servers'

const A = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const B = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId

describe('fleet server ids', () => {
  it('accepts UUIDs and host-id-safe slugs only', () => {
    expect(isFleetServerId(A)).toBe(true)
    expect(isFleetServerId('srv-1')).toBe(true)
    for (const bad of ['', 'A', 'a/b', 'a#b', '-a', 'a'.repeat(65), 7]) expect(isFleetServerId(bad)).toBe(false)
  })
  it('refuses a missing server with FLEET_SERVER_UNKNOWN', () => {
    expect(() => parseFleetServerId('')).toThrow(FLEET_SERVER_UNKNOWN)
    expect(parseFleetServerId(A)).toBe(A)
  })
  it('keys a bot with its server', () => {
    expect(fleetKey(A, 'alex')).toBe(`${A}/alex`)
  })
  it('defaults to the installed server, else the first', () => {
    expect(
      defaultFleetServer([
        { id: A, installed: false },
        { id: B, installed: true },
      ])?.id
    ).toBe(B)
    expect(
      defaultFleetServer([
        { id: A, installed: false },
        { id: B, installed: false },
      ])?.id
    ).toBe(A)
    expect(defaultFleetServer([])).toBeNull()
  })
})
