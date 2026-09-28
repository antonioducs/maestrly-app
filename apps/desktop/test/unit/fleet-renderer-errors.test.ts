import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FLEET_ENVIRONMENT_LIMITS } from '@maestrly/bot-fleet-protocol'
import {
  IMAGE_NOT_FOUND_MARKER,
  TAKEOVER_CONFLICT_MARKER,
  fleetErrorMessage,
  fleetErrorText,
  isImageNotFound,
  isOwnerMemoryFull,
  isScreenOffline,
  isScreenRestartRequired,
  isTakeoverConflict,
} from '../../src/renderer/lib/fleet/errors'
import {
  FLEET_ENVIRONMENTS_UNSUPPORTED,
  FLEET_SCREEN_CONFLICT,
  FLEET_SCREEN_OFFLINE,
  FLEET_SCREEN_RESTART_REQUIRED,
} from '../../src/shared/fleet-targets'
import en from '../../src/shared/i18n/en/fleet'
import pt from '../../src/shared/i18n/pt-BR/fleet'

/** A message the gateway exports as a constant, read from its source so a reworded refusal fails here. */
function gatewayMessage(file: string, name: string): string {
  const source = readFileSync(new URL(`../../../bot-gateway/src/${file}`, import.meta.url), 'utf8')
  const found = source.match(new RegExp(`export const ${name} =\\s*'([^']+)'`))
  if (!found) throw new Error(`${name} is not a string constant of ${file}`)
  return found[1]
}
function translator(catalog: object) {
  return (key: string, values: Record<string, unknown> = {}) => {
    const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog)
    if (typeof text !== 'string') throw new Error('Missing translation ' + key)
    return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]))
  }
}
/** A gateway failure as the renderer receives it through IPC. */
const overIpc = (message: string) => new Error(`Error invoking remote method 'fleet:x': FleetClientError: ${message}`)

describe('fleet renderer errors', () => {
  it('drops the Electron IPC transport prefix', () => {
    const cause = new Error("Error invoking remote method 'fleet:bot-action': Error: The bot is not running.")
    expect(fleetErrorMessage(cause)).toBe('The bot is not running.')
    expect(fleetErrorMessage("Error: Error invoking remote method 'fleet:connect': Pairing code expired")).toBe(
      'Pairing code expired'
    )
    expect(fleetErrorMessage(new Error('Plain failure'))).toBe('Plain failure')
    expect(
      fleetErrorMessage(new Error("Error invoking remote method 'fleet:bot-action': FleetClientError: Bot not found"))
    ).toBe('Bot not found')
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

  it('tells a screen that needs its environment restarted from one whose bot stopped', () => {
    const wrapped = (marker: string) => new Error(`Error invoking remote method 'fleet:screenOpen': Error: ${marker}`)
    expect(isScreenRestartRequired(wrapped(FLEET_SCREEN_RESTART_REQUIRED))).toBe(true)
    expect(isScreenRestartRequired(wrapped(FLEET_SCREEN_CONFLICT))).toBe(false)
    expect(isScreenOffline(wrapped(FLEET_SCREEN_OFFLINE))).toBe(true)
    expect(isScreenOffline(wrapped(FLEET_SCREEN_RESTART_REQUIRED))).toBe(false)
  })

  it('shows the environment refusals the gateway sends as localized, actionable hints', () => {
    const botsMax = FLEET_ENVIRONMENT_LIMITS.botsMax
    const cases: Array<[string, string]> = [
      [gatewayMessage('lifecycle.ts', 'RESTART_TO_ADD_BOTS'), 'environment.restartToJoin'],
      [gatewayMessage('lifecycle.ts', 'SHARED_ENVIRONMENT'), 'errors.sharedEnvironment'],
      [gatewayMessage('lifecycle.ts', 'RESTORE_ENVIRONMENT_FIRST'), 'errors.restoreEnvironmentFirst'],
      [gatewayMessage('lifecycle.ts', 'START_ENVIRONMENT_FIRST'), 'errors.startEnvironmentFirst'],
      [gatewayMessage('lifecycle.ts', 'SLOT_IN_USE'), 'errors.slotInUse'],
      [gatewayMessage('lifecycle.ts', 'RESTART_TO_CHOOSE_COMPACTION'), 'environment.compaction.restart'],
      [gatewayMessage('screen.ts', 'RESTART_TO_OPEN_SCREEN'), 'screen.restartEnvironment'],
      // The gateway store and the environment's own Maestrly refuse a ninth bot in their own words.
      [`This environment already has ${botsMax} bots.`, 'errors.environmentFull'],
      ['This environment already has the most bots it can hold.', 'errors.environmentFull'],
      ['Environment not running', 'errors.environmentNotRunning'],
      ['Bot not running', 'errors.botNotRunning'],
      ['Restart this environment to update it before configuring it from the Mac.', 'provisioning.restartEnvironment'],
      ['Restart this bot to update it before configuring it from the Mac.', 'provisioning.restartBot'],
      // Markers of the main process, never shown raw.
      [FLEET_ENVIRONMENTS_UNSUPPORTED, 'provisioning.updateServer'],
      [FLEET_SCREEN_CONFLICT, 'screen.conflict'],
      [FLEET_SCREEN_RESTART_REQUIRED, 'screen.restartEnvironment'],
      [FLEET_SCREEN_OFFLINE, 'errors.screenOffline'],
    ]
    for (const catalog of [en, pt]) {
      const t = translator(catalog)
      for (const [message, key] of cases) {
        const text = fleetErrorText(overIpc(message), t)
        expect(text, message).toBe(t(key, { max: botsMax }))
        expect(text, message).not.toMatch(/FLEET_|\{\{/)
      }
    }
    const store = readFileSync(new URL('../../../bot-gateway/src/store.ts', import.meta.url), 'utf8')
    expect(store).toMatch(/`This environment already has \$\{SLOTS\} bots\.`/)
    expect(store).toContain('const SLOTS = FLEET_ENVIRONMENT_LIMITS.botsMax')
    expect(fleetErrorText('Invalid memory limit', translator(pt))).toBe('Invalid memory limit')
  })

  it('keeps any other failure as it came, so unexpected errors stay useful', () => {
    const t = translator(pt)
    expect(fleetErrorText(overIpc('Docker could not remove the bot files'), t)).toBe(
      'Docker could not remove the bot files'
    )
    expect(fleetErrorText(new Error('Gateway unavailable'), t)).toBe('Gateway unavailable')
    // A known refusal inside a longer message is someone else's text, left as it is.
    expect(fleetErrorText(overIpc('Start its environment first, then retry'), t)).toBe(
      'Start its environment first, then retry'
    )
  })
})

it('recognizes owner memory capacity errors through IPC without masking other failures', () => {
  expect(isOwnerMemoryFull('Owner memory is full (4000 characters).')).toBe(true)
  expect(
    isOwnerMemoryFull(
      new Error(
        "Error invoking remote method 'fleet:ownerMemoryCreate': Error: Owner memory is full (4000 characters)."
      )
    )
  ).toBe(true)
  // The real shape: gateway failures are FleetClientError instances serialized by Electron IPC.
  expect(
    isOwnerMemoryFull(
      new Error(
        "Error invoking remote method 'fleet:ownerMemoryCreate': FleetClientError: Owner memory is full (4000 characters)."
      )
    )
  ).toBe(true)
  expect(isOwnerMemoryFull(new Error('Gateway unavailable'))).toBe(false)
  expect(isOwnerMemoryFull('Owner memory is fullish')).toBe(false)
})
