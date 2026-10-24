import { describe, expect, it } from 'vitest'
import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import { fleetAlertFor, fleetBotEventFor } from '../../src/main/fleet/client/alerts'

const entry = (
  kind: FleetActivityEntry['kind'],
  data: FleetActivityEntry['data'] = {},
  summary: string | null = null,
  botId: string | null = 'scout'
): FleetActivityEntry => ({ seq: 1, at: '2026-01-01T00:00:00Z', botId, environmentId: null, kind, summary, data })

describe('fleetBotEventFor', () => {
  it('tells, sounds and marks a turn the owner asked for, in the conversation it happened in', () => {
    expect(fleetBotEventFor(entry('turn_completed', { source: 'owner' }, 'Done.'))).toEqual({
      botId: 'scout',
      alert: 'ready',
      notice: 'finished',
      mark: true,
      summary: 'Done.',
    })
    expect(fleetBotEventFor(entry('turn_failed', { source: 'continuation', runId: 't-1', threadId: 't-1' }))).toEqual({
      botId: 'scout',
      alert: 'error',
      notice: 'failed',
      mark: true,
      threadId: 't-1',
      summary: null,
    })
    // A gateway that does not say who started a turn: the owner did.
    expect(fleetBotEventFor(entry('turn_completed', { runId: 'run-1' }))).toMatchObject({
      notice: 'finished',
      runId: 'run-1',
    })
  })

  it('tells about a finished routine run as the bot settings say', () => {
    expect(fleetBotEventFor(entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))).toEqual({
      botId: 'scout',
      alert: 'ready',
      notice: 'routineFinished',
      mark: true,
      runId: 'run-1',
      summary: null,
    })
    expect(fleetBotEventFor(entry('turn_failed', { source: 'routine', runId: 'run-1' }))).toMatchObject({
      alert: 'error',
      notice: 'routineFailed',
    })
    expect(fleetBotEventFor(entry('turn_completed', { source: 'routine', runId: 'run-1', alert: false }))).toBeNull()
  })

  it('only marks a bot that answered another bot', () => {
    expect(fleetBotEventFor(entry('turn_completed', { source: 'peer', runId: 't-1', threadId: 't-1' }))).toEqual({
      botId: 'scout',
      alert: null,
      notice: null,
      mark: true,
      threadId: 't-1',
      summary: null,
    })
  })

  it('tells what waits for the owner, and marks only a paused conversation between bots', () => {
    expect(fleetBotEventFor(entry('needs_you', {}, 'Bash'))).toEqual({
      botId: 'scout',
      alert: 'permission',
      notice: 'needsYou',
      mark: false,
      summary: 'Bash',
    })
    expect(fleetBotEventFor(entry('needs_you', { threadId: 't-1' }))).toMatchObject({
      notice: 'threadPaused',
      mark: true,
      threadId: 't-1',
    })
  })

  it('ignores the rest, and entries of no bot', () => {
    expect(fleetBotEventFor(entry('bot_started'))).toBeNull()
    expect(fleetBotEventFor(entry('routine_ran', { routineId: 'r-1' }))).toBeNull()
    expect(fleetBotEventFor(entry('turn_completed', { source: 'owner' }, null, null))).toBeNull()
    expect(fleetAlertFor(entry('turn_completed', { source: 'peer' }))).toBeNull()
    expect(fleetAlertFor(entry('turn_completed', { source: 'routine' }))).toBe('ready')
  })
})
