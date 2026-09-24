import { describe, expect, it } from 'vitest'
import {
  TAKEOVER_CONFLICT_MARKER,
  fleetErrorMessage,
  isTakeoverConflict,
} from '../../src/renderer/lib/fleet/errors'

describe('fleet renderer errors', () => {
  it('drops the Electron IPC transport prefix', () => {
    const cause = new Error("Error invoking remote method 'fleet:bot-action': Error: The bot is not running.")
    expect(fleetErrorMessage(cause)).toBe('The bot is not running.')
    expect(fleetErrorMessage("Error: Error invoking remote method 'fleet:connect': Pairing code expired")).toBe(
      'Pairing code expired'
    )
    expect(fleetErrorMessage(new Error('Plain failure'))).toBe('Plain failure')
  })

  it('recognizes a refused takeover through the IPC marker or a 409 status', () => {
    // The marker is embedded in an underscore-joined token, so a word-boundary match on CONFLICT would miss it.
    const wrapped = new Error(`Error invoking remote method 'fleet:takeover': Error: ${TAKEOVER_CONFLICT_MARKER}`)
    expect(isTakeoverConflict(wrapped)).toBe(true)
    expect(isTakeoverConflict({ status: 409 })).toBe(true)
    expect(isTakeoverConflict(new Error("Error invoking remote method 'fleet:takeover': Error: Bot offline"))).toBe(
      false
    )
  })
})
