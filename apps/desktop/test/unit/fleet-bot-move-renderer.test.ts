import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fleetBotSchema,
  fleetEnvironmentSchema,
  type FleetBot,
  type FleetBotMove,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { fleetErrorText } from '../../src/renderer/lib/fleet/errors'
import {
  MOVE_STEPS,
  botMoveAvailability,
  moveRequest,
  moveStepIndex,
  moveTargetAvailability,
  moveTargetHint,
} from '../../src/renderer/lib/fleet/move'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import { resources } from '../../src/shared/i18n/resources'

const at = '2026-10-17T12:00:00.000Z'
const capable = ['provisioning', 'environments', 'bot-move']
function bot(id: string, environmentId: string, patch: Partial<FleetBot> = {}): FleetBot {
  return fleetBotSchema.parse({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    role: '',
    instructions: '',
    tint: '#336699',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: true, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.21.0',
    environmentId,
    createdAt: at,
    updatedAt: at,
    ...patch,
  })
}
function environment(id: string, botIds: string[], patch: Partial<FleetEnvironment> = {}): FleetEnvironment {
  return fleetEnvironmentSchema.parse({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    memoryLimitBytes: null,
    appVersion: '0.21.0',
    capabilities: capable,
    botIds,
    createdAt: at,
    updatedAt: at,
    ...patch,
  })
}
const move = (phase: FleetBotMove['phase']): FleetBotMove => ({
  id: 'move-1',
  botId: 'scout',
  fromEnvironmentId: 'work',
  toEnvironmentId: 'home',
  newEnvironment: false,
  phase,
  state: 'running',
  error: null,
  startedAt: at,
  updatedAt: at,
})
function controller(bots: FleetBot[], environments: FleetEnvironment[], features = capable): FleetController {
  return {
    state: {
      connection: { state: 'connected', features, hostname: 'fleet', url: 'https://fleet' },
      snapshot: { bots, environments, host: null, inbox: [] },
    },
  } as unknown as FleetController
}

describe('moving a bot, in the renderer', () => {
  it('offers the move only for a running bot whose server and environment move bots', () => {
    const work = environment('work', ['scout'])
    const scout = bot('scout', 'work')
    expect(botMoveAvailability(controller([scout], [work]), scout)).toBe('ready')
    expect(botMoveAvailability(controller([scout], [work], ['provisioning', 'environments']), scout)).toBe(
      'update-server'
    )
    expect(botMoveAvailability(controller([scout], [work]), { ...scout, move: move('freezing') })).toBe('moving')
    expect(botMoveAvailability(controller([scout], [work]), { ...scout, lifecycle: 'stopped' })).toBe('not-running')
    expect(
      botMoveAvailability(controller([scout], [work]), {
        ...scout,
        takeover: { state: 'human', deviceId: 'mac', deviceName: 'Mac', since: at },
      })
    ).toBe('screen')
    const older = environment('work', ['scout'], { capabilities: ['provisioning', 'environments'] })
    expect(botMoveAvailability(controller([scout], [older]), scout)).toBe('restart-environment')
  })

  it('takes a bot only into another running environment with room, the same version and the capability', () => {
    const scout = bot('scout', 'work')
    const work = environment('work', ['scout'])
    const fleet = (target: FleetEnvironment) => controller([scout], [work, target])
    const home = environment('home', [])
    expect(moveTargetAvailability(fleet(home), scout, home)).toBe('ready')
    expect(moveTargetAvailability(fleet(home), scout, work)).toBe('current')
    const full = environment('full', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(moveTargetAvailability(fleet(full), scout, full)).toBe('full')
    const stopped = environment('home', [], { lifecycle: 'stopped' })
    expect(moveTargetAvailability(fleet(stopped), scout, stopped)).toBe('start-environment')
    const older = environment('home', [], { capabilities: ['provisioning', 'environments'] })
    expect(moveTargetAvailability(fleet(older), scout, older)).toBe('restart-environment')
    const newer = environment('home', [], { appVersion: '0.22.0' })
    expect(moveTargetAvailability(fleet(newer), scout, newer)).toBe('version')
    for (const state of [
      'current',
      'version',
      'restart-environment',
      'full',
      'start-environment',
      'not-running',
    ] as const)
      expect(moveTargetHint(state).key, state).toMatch(/^(move|environment)\./)
  })

  it('asks for an existing environment or a named new one, and follows its phases as five steps', () => {
    expect(moveRequest({ kind: 'existing', environmentId: 'home' })).toEqual({ environmentId: 'home' })
    expect(moveRequest({ kind: 'existing', environmentId: null })).toBeNull()
    expect(moveRequest({ kind: 'new', name: '  Lab  ' })).toEqual({ newEnvironment: { name: 'Lab' } })
    expect(moveRequest({ kind: 'new', name: ' ' })).toBeNull()
    expect(MOVE_STEPS).toEqual(['pause', 'pack', 'transfer', 'check', 'finish'])
    expect(
      (
        [
          'prepared',
          'freezing',
          'exporting',
          'importing',
          'verifying',
          'committing',
          'releasing-source',
          'completed',
        ] as const
      ).map(moveStepIndex)
    ).toEqual([0, 0, 1, 2, 3, 4, 4, 5])
  })

  it("says why a move failed in the owner's language, never with the gateway's words", () => {
    const t = (key: string) => key
    for (const [message, key] of [
      ['The bot arrived different from how it left. It stays where it was.', 'move.error.differs'],
      ['The server restarted during the move. The bot stays where it was.', 'move.error.interrupted'],
      ['Update both environments to the same version before moving the bot.', 'move.error.version'],
      ['Restart both environments to update them before moving bots between them.', 'move.error.update'],
      ['This bot is moving to another environment.', 'move.error.moving'],
      ['This bot has too many files to move.', 'move.error.tooLarge'],
      ['FLEET_BOT_MOVE_UNSUPPORTED', 'move.error.unsupported'],
    ])
      expect(fleetErrorText(new Error(message), t)).toBe(key)
    const read = (tree: unknown, key: string) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)
    for (const locale of ['en', 'pt-BR'] as const)
      for (const key of ['move.error.differs', 'move.takes', 'move.step.transfer', 'composer.moving', 'move.dropHint'])
        expect(typeof read(resources[locale].fleet, key), `${locale} ${key}`).toBe('string')
  })

  it('drags a bot only when it can move, and drops it only where it can go', () => {
    const scout = bot('scout', 'work')
    const work = environment('work', ['scout', 'ghost'])
    const home = environment('home', ['cleo'])
    const fleet = controller([scout], [work, home])
    // The sidebar's own tests: a row is draggable when the bot can move, a group accepts it when it can go there.
    expect(botMoveAvailability(fleet, scout) === 'ready').toBe(true)
    expect(botMoveAvailability(fleet, { ...scout, move: move('exporting') }) === 'ready').toBe(false)
    expect(botMoveAvailability(controller([scout], [work, home], ['provisioning', 'environments']), scout)).not.toBe(
      'ready'
    )
    expect(moveTargetAvailability(fleet, scout, home)).toBe('ready')
    expect(moveTargetAvailability(fleet, scout, work)).not.toBe('ready')
  })

  it('wires the drop to the dialog and keeps the conversation read-only while the bot moves', () => {
    const source = (file: string) => readFileSync(new URL(`../../src/renderer/${file}`, import.meta.url), 'utf8')
    const sidebar = source('components/fleet/FleetSidebarPanel.tsx')
    expect(sidebar).toContain("const BOT_DRAG_TYPE = 'application/x-maestrly-bot'")
    expect(sidebar).toContain('moveTargetAvailability(fleet, dragging, environment)')
    expect(sidebar).toContain('initialEnvironmentId={moveTo.environmentId}')
    const settings = source('components/fleet/BotSettings.tsx')
    expect(settings).toContain('<MoveBotDialog')
    expect(settings).toContain("t('move.action')")
    expect(source('components/fleet/BotComposer.tsx')).toContain("t('composer.moving')")
    const dialog = source('components/fleet/MoveBotDialog.tsx')
    expect(dialog).toMatch(/window\.api\s*\.fleetMoveBot\(/)
    expect(dialog).toMatch(/window\.api\s*\.fleetGetBotMove\(/)
    expect(dialog).toContain('<SearchSelect')
    expect(dialog).toContain('<ChoiceMark')
  })
})
