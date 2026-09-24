import { describe, expect, it } from 'vitest'
import {
  IMAGE_NOT_FOUND_MARKER,
  TAKEOVER_CONFLICT_MARKER,
  fleetErrorMessage,
  isImageNotFound,
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

  it('tells a missing image apart from a failed load, which stays retryable', () => {
    expect(
      isImageNotFound(new Error(`Error invoking remote method 'fleet:getImage': Error: ${IMAGE_NOT_FOUND_MARKER}`))
    ).toBe(true)
    expect(
      isImageNotFound(new Error("Error invoking remote method 'fleet:getImage': Error: Gateway unavailable"))
    ).toBe(false)
    // A disposed cache is a renderer lifecycle bug, never a missing image.
    expect(isImageNotFound(new Error('Image cache disposed'))).toBe(false)
  })
})
