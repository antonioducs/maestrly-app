import { describe, expect, it } from 'vitest'
import type { FleetBot, FleetHostInfo, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { activityLabel, formatPairingCode, memorySegments } from '../../src/renderer/lib/fleet/format'
import { fleetReducer, initialFleetState, mergeTranscriptItems } from '../../src/renderer/lib/fleet/state'

const user = (id: string, at: string, text = id): FleetTranscriptItem => ({
  kind: 'user',
  id,
  at,
  text,
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})
const bot = (id: string): FleetBot =>
  ({
    id,
    name: id,
    tint: '#123456',
    resources: { memoryBytes: 2 * 1024 ** 3 },
  }) as FleetBot
const host = {
  memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, botsBytes: 2 * 1024 ** 3 },
} as FleetHostInfo

describe('fleet pure state', () => {
  it('keeps the parts of one message in their order when they share its time', () => {
    const at = '2026-09-24T21:29:45.794Z'
    const merged = mergeTranscriptItems(
      [user('m:1', at), user('m:10', at), user('m:4', at)],
      [user('m:2', at), user('m:11', at)]
    )
    expect(merged.map((item) => item.id)).toEqual(['m:1', 'm:2', 'm:4', 'm:10', 'm:11'])
  })
  it('merges transcript updates by id in ascending time order', () => {
    expect(
      mergeTranscriptItems(
        [user('b', '2026-01-01T00:02:00Z'), user('a', '2026-01-01T00:01:00Z')],
        [user('a', '2026-01-01T00:01:00Z', 'updated')]
      ).map((item) => [item.id, item.kind === 'user' ? item.text : ''])
    ).toEqual([
      ['a', 'updated'],
      ['b', 'b'],
    ])
  })
  it('keeps older pages and removes stale items when the latest page is refreshed', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'transcript.page',
      botId: 'b',
      page: {
        items: [
          user('old', '2026-01-01T00:00:00Z'),
          user('new', '2026-01-01T00:01:00Z'),
          user('stale', '2026-01-01T00:02:00Z'),
        ],
        before: null,
      },
      older: false,
    })
    state = fleetReducer(state, {
      type: 'transcript.page',
      botId: 'b',
      page: { items: [user('new', '2026-01-01T00:01:00Z')], before: null },
      older: false,
    })
    expect(state.transcripts.b.items.map((item) => item.id)).toEqual(['old', 'new'])
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'transcript.reset', botId: 'b', at: '2026-01-01T00:02:00Z' },
    })
    expect(state.transcripts.b.loaded).toBe(false)
  })
  it('applies bot, inbox and peer events without duplicating records', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:00:00Z' },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:01:00Z' },
    })
    expect(state.snapshot.bots).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: {
        type: 'inbox.updated',
        items: [
          {
            botId: 'scout',
            interaction: {
              kind: 'help',
              id: 'help-1',
              at: '2026-01-01T00:01:00Z',
              reason: 'Sign in',
              itemId: 'item-1',
            },
          },
        ],
        at: '2026-01-01T00:01:00Z',
      },
    })
    expect(state.snapshot.inbox).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: {
        type: 'peer.message',
        message: { id: 'peer-1', at: '2026-01-01T00:01:00Z', from: 'scout', to: 'dev', text: 'Hello', delivered: true },
        at: '2026-01-01T00:01:00Z',
      },
    })
    expect(state.snapshot.peerMessages).toHaveLength(1)
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.removed', botId: 'scout', at: '2026-01-01T00:02:00Z' },
    })
    expect(state.snapshot.bots).toHaveLength(0)
    expect(state.snapshot.inbox).toHaveLength(0)
  })
  it('never lists an archived bot, even when its archive reply arrives after the removal event', () => {
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'bot.updated', bot: bot('scout'), at: '2026-01-01T00:00:00Z' },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.removed', botId: 'scout', at: '2026-01-01T00:01:00Z' },
    })
    // The archive request's reply (the bot, now archived) is dispatched once the IPC call returns.
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: { ...bot('scout'), lifecycle: 'archived' }, at: '2026-01-01T00:01:00Z' },
    })
    expect(state.snapshot.bots).toEqual([])
    // Restored, it is listed again.
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'bot.updated', bot: { ...bot('scout'), lifecycle: 'creating' }, at: '2026-01-01T00:02:00Z' },
    })
    expect(state.snapshot.bots.map((item) => item.id)).toEqual(['scout'])
  })
  it('keeps activity entries in sequence order without duplicates', () => {
    const entry = (seq: number) => ({
      seq,
      at: '2026-01-01T00:00:00Z',
      botId: null,
      kind: 'bot_started' as const,
      summary: null,
      data: {},
    })
    let state = fleetReducer(initialFleetState, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(2) },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(1) },
    })
    state = fleetReducer(state, {
      type: 'event',
      value: { type: 'activity', at: '2026-01-01T00:00:00Z', entry: entry(2) },
    })
    expect(state.activity.map((item) => item.seq)).toEqual([1, 2])
  })
  it('formats pairing codes without punctuation or excess characters', () => {
    expect(formatPairingCode('ab 12--cD34!x')).toBe('AB12-CD34')
    expect(formatPairingCode('a')).toBe('A')
  })
  it('splits host memory into bot and system shares', () => {
    expect(memorySegments(host, [bot('scout')]).map((segment) => [segment.id, segment.fraction])).toEqual([
      ['scout', 0.25],
      ['system', 0.375],
    ])
    expect(memorySegments(null, [bot('scout')])).toEqual([])
  })
  it('maps activity variants to localization keys', () => {
    expect(activityLabel({ kind: 'tool', tool: 'bash', target: 'npm test' }, 'working')).toEqual({
      key: 'activity.tool',
      values: { tool: 'bash', target: 'npm test' },
    })
    expect(activityLabel({ kind: 'queued', count: 2 }, 'paused').key).toBe('activity.queued')
    expect(activityLabel(null, 'setup').key).toBe('status.setup')
  })
})
