import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { BotCommandJournal } from '../../src/main/bot/command-journal'

beforeEach(freshDb)
afterEach(closeDb)

it('records admission once and preserves unacknowledged results across restart', () => {
  let journal = new BotCommandJournal('instance')
  expect(journal.admit('command', 'conversation', 'send', { prompt: 'Hello' })).toBe(true)
  journal.enqueue('command', 'event', { type: 'message', text: 'Hello back' })
  journal.complete('command', { status: 'completed' })
  restartDb()
  journal = new BotCommandJournal('instance')
  expect(journal.admit('command', 'conversation', 'send', { prompt: 'Hello' })).toBe(false)
  expect(journal.receipt('command')?.result).toEqual({ status: 'completed' })
  expect(journal.outbox('command')).toEqual([{ eventId: 'event', payload: { type: 'message', text: 'Hello back' } }])
  journal.acknowledge('command', ['event'])
  expect(journal.outbox('command')).toEqual([])
})

it('does not alias another bridge or reuse an idempotency key with another payload', () => {
  const first = new BotCommandJournal('instance-a')
  first.admit('command', 'conversation', 'send', { prompt: 'first' })
  expect(() => first.admit('command', 'conversation', 'send', { prompt: 'changed' })).toThrow(/different/)
  expect(() => first.admit('command', 'another-conversation', 'send', { prompt: 'first' })).toThrow(/different/)
  expect(new BotCommandJournal('instance-b').admit('command', 'conversation', 'send', { prompt: 'first' })).toBe(true)
})

it('never retries a prompt with an interrupted admission and scopes acknowledgements to the command', () => {
  const journal = new BotCommandJournal('instance')
  journal.admit('first', 'conversation', 'send', { prompt: 'once' })
  journal.admit('second', 'conversation', 'send', { prompt: 'twice' })
  journal.enqueue('second', 'second-event', { type: 'status' })
  restartDb()
  const restored = new BotCommandJournal('instance')
  expect(restored.receipt('first')?.state).toBe('admitted')
  expect(restored.admit('first', 'conversation', 'send', { prompt: 'once' })).toBe(false)
  restored.acknowledge('first', ['second-event'])
  expect(restored.outbox('second')).toHaveLength(1)
})
