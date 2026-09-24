import { describe, expect, it } from 'vitest'
import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import {
  digestKey,
  formatDuration,
  formatTimer,
  nextRadioIndex,
  routineSchedule,
  validateRoutine,
} from '../../src/renderer/lib/fleet/forms'

const valid = {
  title: 'Daily report',
  prompt: 'Check orders',
  time: '09:30',
  days: [] as number[],
  timezone: 'America/Sao_Paulo',
  enabled: true,
}
describe('fleet forms', () => {
  it('validates routine fields and treats no days as every day', () => {
    expect(validateRoutine(valid)).toBeNull()
    expect(validateRoutine({ ...valid, title: '' })).toBe('title')
    expect(validateRoutine({ ...valid, prompt: '' })).toBe('prompt')
    expect(validateRoutine({ ...valid, time: '24:01' })).toBe('time')
    expect(validateRoutine({ ...valid, timezone: '' })).toBe('timezone')
    expect(routineSchedule(valid)).toEqual({ kind: 'weekly', time: '09:30', days: [], timezone: 'America/Sao_Paulo' })
  })
  it('formats control time and away duration', () => {
    expect(formatTimer(61_900)).toBe('01:01')
    expect(formatTimer(-100)).toBe('00:00')
    expect(formatDuration(3_700_000)).toEqual({ hours: 1, minutes: 1 })
  })
  it('wraps ceiling radio keyboard navigation', () => {
    expect(nextRadioIndex(2, 'ArrowRight', 3)).toBe(0)
    expect(nextRadioIndex(0, 'ArrowLeft', 3)).toBe(2)
    expect(nextRadioIndex(1, 'Home', 3)).toBe(0)
    expect(nextRadioIndex(1, 'End', 3)).toBe(2)
    expect(nextRadioIndex(1, 'Escape', 3)).toBeNull()
  })
  it('maps all activity kinds to localized digest keys', () => {
    const kinds: FleetActivityEntry['kind'][] = [
      'bot_created',
      'bot_started',
      'bot_stopped',
      'bot_restarted',
      'bot_failed',
      'bot_archived',
      'turn_completed',
      'turn_failed',
      'needs_you',
      'routine_ran',
      'routine_skipped',
      'peer_message',
      'takeover_started',
      'takeover_ended',
      'paused',
      'resumed',
    ]
    expect(kinds.map((kind) => digestKey({ kind } as FleetActivityEntry))).toEqual(
      kinds.map((kind) => `digest.kind.${kind}`)
    )
  })
})
