import { expect, it } from 'vitest'
import type { BotInteraction } from '@maestrly/host-protocol'
import { workedMs } from '../src/bots/context.js'

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString()
const now = new Date(Date.UTC(2026, 0, 1, 13, 0)).getTime()
const turn = { startedAt: at(0) }
/** A request made to the person, answered or still open. */
const request = (from: number, to?: number): BotInteraction =>
  ({
    id: `i-${from}`,
    botId: 'bot',
    turnId: 'turn',
    actionId: `a-${from}`,
    kind: 'approval',
    title: 'Executar um comando',
    reason: '',
    consequence: '',
    parameters: {},
    fingerprint: 'a'.repeat(64),
    policyRevision: 0,
    generation: 1,
    expiresAt: at(120),
    status: to === undefined ? 'pending' : 'approved',
    createdAt: at(from),
    updatedAt: at(to ?? from),
  }) as BotInteraction

it('counts the whole hour as work when the bot never stopped to ask', () => {
  expect(workedMs(turn, [], now)).toBe(60 * 60_000)
})

it('does not charge the agent for the time a person took to decide', () => {
  // Asked at minute 10, answered at minute 50: forty minutes belong to the person.
  expect(workedMs(turn, [request(10, 50)], now)).toBe(20 * 60_000)
})

it('counts a request still waiting up to now, so an unanswered turn never expires for time', () => {
  expect(workedMs(turn, [request(10)], now)).toBe(10 * 60_000)
})

it('counts overlapping requests once instead of subtracting the same wait twice', () => {
  // Two questions open together from minute 10 to minute 40 are one single wait.
  expect(workedMs(turn, [request(10, 40), request(20, 30)], now)).toBe(30 * 60_000)
  // Separate waits add up: 10→20 and 30→40 are twenty minutes in total.
  expect(workedMs(turn, [request(10, 20), request(30, 40)], now)).toBe(40 * 60_000)
})

it('ignores a request recorded before the turn started and never returns a negative time', () => {
  expect(workedMs(turn, [request(-30 + 0, 10)], now)).toBe(50 * 60_000)
  expect(workedMs({ startedAt: undefined }, [], now)).toBe(0)
  // A clock that moved backwards must not produce a negative budget.
  expect(workedMs({ startedAt: at(90) }, [], now)).toBe(0)
})
