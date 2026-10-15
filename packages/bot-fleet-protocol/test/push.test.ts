import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  fleetInstanceEventSchema,
  fleetPushDataSchema,
  fleetPushRegistrationRequestSchema,
  fleetReaderWantsChatAttention,
} from '../src/index.js'

const registration = {
  provider: 'expo',
  token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  platform: 'ios',
  locale: 'pt-BR',
  preferences: { waiting: true, replies: false, routines: true, errors: true },
}

describe('push notifications', () => {
  it('accepts an Expo token with its preferences, and nothing else', () => {
    expect(fleetPushRegistrationRequestSchema.parse(registration)).toEqual(registration)
    expect(FLEET_GATEWAY_ROUTES.devicePushSet.body.parse(registration)).toEqual(registration)
    for (const token of ['ExpoPushToken[short]', 'apns:abc', 'ExponentPushToken[has space here]'])
      expect(() => fleetPushRegistrationRequestSchema.parse({ ...registration, token })).toThrow()
    expect(() => fleetPushRegistrationRequestSchema.parse({ ...registration, provider: 'fcm' })).toThrow()
    expect(() => fleetPushRegistrationRequestSchema.parse({ ...registration, extra: 1 })).toThrow()
    expect(() =>
      fleetPushRegistrationRequestSchema.parse({ ...registration, preferences: { waiting: true } })
    ).toThrow()
  })

  it('tells the phone what to open, by the device id it has on that server', () => {
    expect(
      fleetPushDataSchema.parse({ v: 1, device: 'd1', kind: 'chat', id: 'c1', category: 'waiting' })
    ).toMatchObject({
      kind: 'chat',
    })
    expect(fleetPushDataSchema.parse({ v: 1, device: 'd1', kind: 'test', id: null, category: null }).kind).toBe('test')
    expect(() => fleetPushDataSchema.parse({ v: 2, device: 'd1', kind: 'bot', id: 'b', category: null })).toThrow()
    // A chat names its workspaces environment; data from gateways that predate it still parses.
    expect(
      fleetPushDataSchema.parse({ v: 1, device: 'd1', kind: 'chat', id: 'c1', category: 'waiting', env: 'zello' }).env
    ).toBe('zello')
    expect(
      fleetPushDataSchema.parse({ v: 1, device: 'd1', kind: 'chat', id: 'c1', category: 'waiting' }).env
    ).toBeUndefined()
    expect(() =>
      fleetPushDataSchema.parse({ v: 1, device: 'd1', kind: 'chat', id: 'c1', category: null, env: '' })
    ).toThrow()
  })

  it('carries a chat that needs the owner on the instance stream, for readers that ask', () => {
    expect(
      fleetInstanceEventSchema.parse({
        seq: 3,
        at: '2026-10-13T12:00:00.000Z',
        type: 'chat.attention',
        conversationId: 'c1',
        name: 'Fix the flaky test',
        kind: 'question',
      })
    ).toMatchObject({ botId: null, kind: 'question' })
    expect(fleetReaderWantsChatAttention(new URLSearchParams('since=0&chatAttention=1'))).toBe(true)
    expect(fleetReaderWantsChatAttention(new URLSearchParams('since=0'))).toBe(false)
  })
})
