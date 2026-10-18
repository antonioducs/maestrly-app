import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_SIDE_TURNS_MAX,
  FLEET_CANCEL_CONVERSATION_QUERY,
  FLEET_PARALLEL_TURNS_FEATURE,
  type FleetBotTurn,
  type FleetInstanceStatus,
  fleetBotSchema,
  fleetInstanceStatusSchema,
  fleetInstanceTurnSchema,
  fleetInstanceTurns,
  fleetLaneTurn,
  fleetPrimaryWorking,
} from '../src/index.js'

const at = '2026-10-18T10:15:00.000Z'
const turnOf = (status: Pick<FleetInstanceStatus, 'turn' | 'turns'>) =>
  fleetInstanceTurns(status as FleetInstanceStatus)
const primaryTurn = { state: 'running' as const, startedAt: at, inputId: 'in-1', runId: null, tool: null }
const runTurn = {
  state: 'running' as const,
  startedAt: at,
  inputId: 'in-2',
  runId: 'run-1',
  tool: { tool: 'browser_navigate', target: 'example.com' },
}
const botTurn = (kind: FleetBotTurn['kind'], id: string | null): FleetBotTurn => ({
  kind,
  id,
  title: kind === 'primary' ? '' : 'Post da semana',
  startedAt: at,
  tool: null,
  cancelling: false,
})

describe('turns of each bot conversation', () => {
  it('names the feature, the side turns a bot runs at once and the cancel query', () => {
    expect(FLEET_PARALLEL_TURNS_FEATURE).toBe('parallel-turns')
    expect(FLEET_BOT_SIDE_TURNS_MAX).toBe(4)
    expect(FLEET_CANCEL_CONVERSATION_QUERY).toBe('conversation')
  })

  it("reads an older instance's single turn as its only turn", () => {
    expect(fleetInstanceStatusSchema.shape.turns.parse(undefined)).toEqual([])
    const turn = { state: 'running' as const, startedAt: at, inputId: 'in-1', runId: 'run-1' }
    expect(turnOf({ turn, turns: [] })).toEqual([
      { state: 'running', startedAt: at, inputId: 'in-1', runId: 'run-1', tool: null },
    ])
    expect(turnOf({ turn: { state: 'idle', startedAt: null, inputId: null, runId: null }, turns: [] })).toEqual([])
    // A turn without its input (an instance from before inputs were reported) cannot be told apart.
    expect(turnOf({ turn: { state: 'running', startedAt: at, inputId: null, runId: null }, turns: [] })).toEqual([])
  })

  it('reads every turn of a newer instance, up to the bot conversation and its side turns', () => {
    const turns = fleetInstanceStatusSchema.shape.turns.parse([primaryTurn, runTurn])
    expect(turnOf({ turn: { state: 'running', startedAt: at, inputId: 'in-1', runId: null }, turns })).toEqual([
      primaryTurn,
      runTurn,
    ])
    expect(fleetInstanceTurnSchema.safeParse({ ...runTurn, state: 'idle' }).success).toBe(false)
    const tooMany = Array.from({ length: FLEET_BOT_SIDE_TURNS_MAX + 2 }, (_, index) => ({
      ...runTurn,
      inputId: `in-${index}`,
      runId: `run-${index}`,
    }))
    expect(fleetInstanceStatusSchema.shape.turns.safeParse(tooMany).success).toBe(false)
  })

  it("tells whether the bot's own conversation works, from a gateway with turns or from an older one", () => {
    expect(fleetBotSchema.shape.turns.parse(undefined)).toBeNull()
    const run = { id: 'run-1', routineId: 'post', title: 'Post da semana', startedAt: at }
    // An older gateway: working without a run means the bot's own conversation works.
    expect(fleetPrimaryWorking({ turns: null, status: 'working', runningRun: run })).toBe(false)
    expect(fleetPrimaryWorking({ turns: null, status: 'working', runningRun: null })).toBe(true)
    expect(fleetPrimaryWorking({ turns: null, status: 'idle', runningRun: null })).toBe(false)
    const routineOnly = { turns: [botTurn('routine', 'run-1')], status: 'working' as const, runningRun: run }
    expect(fleetPrimaryWorking(routineOnly)).toBe(false)
    expect(fleetLaneTurn(routineOnly, 'run-1')).toEqual(botTurn('routine', 'run-1'))
    expect(fleetLaneTurn(routineOnly, 'run-2')).toBeNull()
    const both = { turns: [botTurn('primary', null), botTurn('peer', 'thread-1')], status: 'working' as const }
    expect(fleetPrimaryWorking({ ...both, runningRun: null })).toBe(true)
    expect(fleetLaneTurn({ ...both, runningRun: null }, 'thread-1')?.kind).toBe('peer')
    // From an older gateway, the run it reports working is the only side turn known.
    expect(fleetLaneTurn({ turns: null, runningRun: run }, 'run-1')).toEqual({
      kind: 'routine',
      id: 'run-1',
      title: 'Post da semana',
      startedAt: at,
      tool: null,
      cancelling: false,
    })
  })
})
