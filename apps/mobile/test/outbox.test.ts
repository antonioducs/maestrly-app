import { describe, expect, it } from 'vitest'
import { GatewayError } from '../src/gateway/client'
import { afterSendFailure, MissingFileError, nextToSend, type OutboxEntry } from '../src/fleet/outbox'

const entry = (id: string, botId: string, second: number, state: OutboxEntry['state'] = 'waiting'): OutboxEntry => ({
  id,
  serverId: 's1',
  botId,
  text: id,
  attachments: [],
  createdAt: `2026-10-12T12:00:${String(second).padStart(2, '0')}.000Z`,
  state,
  error: null,
  attempts: 0,
})

describe('outbox', () => {
  it('sends one message per bot at a time, oldest first', () => {
    const entries = [
      entry('j2', 'juno', 2),
      entry('j1', 'juno', 1),
      entry('a1', 'atlas', 3),
      entry('p1', 'pixel', 1, 'sending'),
      entry('p2', 'pixel', 2),
      { ...entry('x1', 'juno', 0), serverId: 'other' },
    ]
    expect(nextToSend(entries, 's1').map((item) => item.id)).toEqual(['j1', 'a1'])
  })

  it('waits on network errors and gives up on refusals', () => {
    const base = { ...entry('o', 'juno', 1), state: 'sending' as const }
    expect(afterSendFailure(base, new GatewayError('NETWORK', 0, 'offline'))).toMatchObject({
      state: 'waiting',
      attempts: 1,
      error: null,
    })
    expect(afterSendFailure({ ...base, attempts: 40 }, new GatewayError('TIMEOUT', 0, 'slow'))).toMatchObject({
      state: 'waiting',
      attempts: 41,
    })
    expect(afterSendFailure(base, new GatewayError('INTERNAL', 500, 'x'))).toMatchObject({
      state: 'waiting',
      attempts: 1,
    })
    expect(afterSendFailure({ ...base, attempts: 2 }, new GatewayError('INTERNAL', 503, 'x'))).toMatchObject({
      state: 'failed',
      error: 'server',
    })
    const refusals = [
      [new GatewayError('BOT_NOT_RUNNING', 409, 'x'), 'botStopped'],
      [new GatewayError('PROTOCOL_INCOMPATIBLE', 426, 'x'), 'filesUnsupported'],
      [new GatewayError('INVALID_REQUEST', 400, 'x'), 'invalid'],
      [new GatewayError('INTERNAL', 413, 'x'), 'invalid'],
      [new GatewayError('NOT_FOUND', 404, 'x'), 'botGone'],
      [new GatewayError('CONFLICT', 409, 'x'), 'conflict'],
      [new MissingFileError('photo.jpg'), 'missingFile'],
      [new Error('boom'), 'generic'],
    ] as const
    for (const [error, key] of refusals)
      expect(afterSendFailure(base, error)).toMatchObject({ state: 'failed', error: key })
  })
})
