import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  fleetPairingCodeResponseSchema,
  formatPairingLink,
  isAllowedPhoneServerUrl,
  parsePairingLink,
} from '../src/index.js'

describe('pairing links', () => {
  it('round-trips a server and a normalized code', () => {
    const link = formatPairingLink('https://bots.example.dev', 'k7q2-m9xd')
    expect(link).toBe('maestrly://pair?server=https%3A%2F%2Fbots.example.dev&code=K7Q2M9XD')
    expect(parsePairingLink(link)).toEqual({ origin: 'https://bots.example.dev', code: 'K7Q2M9XD' })
    expect(parsePairingLink(`  ${link}\n`)).toEqual({ origin: 'https://bots.example.dev', code: 'K7Q2M9XD' })
  })
  it('refuses anything that is not a complete, valid pairing link', () => {
    expect(parsePairingLink('https://bots.example.dev')).toBeNull()
    expect(parsePairingLink('maestrly://bot/atlas')).toBeNull()
    expect(parsePairingLink('maestrly://pair?server=https%3A%2F%2Fx.dev')).toBeNull()
    expect(parsePairingLink('maestrly://pair?server=ftp%3A%2F%2Fx.dev&code=K7Q2M9XD')).toBeNull()
    expect(parsePairingLink('maestrly://pair?server=https%3A%2F%2Fx.dev%2Fpath&code=K7Q2M9XD')).toBeNull()
    expect(parsePairingLink('maestrly://pair?server=%E0%A4%A&code=K7Q2M9XD')).toBeNull()
    expect(parsePairingLink('maestrly://pair?server=https%3A%2F%2Fx.dev&code=NOPE')).toBeNull()
  })
  it('refuses to format a link with an invalid code or server', () => {
    expect(() => formatPairingLink('https://x.dev', 'nope')).toThrow('Invalid pairing code')
    expect(() => formatPairingLink('https://x.dev/path', 'K7Q2M9XD')).toThrow('URL must have no path')
  })
})

describe('phone server addresses', () => {
  it('accepts HTTPS, and loopback HTTP only when asked (simulators)', () => {
    expect(isAllowedPhoneServerUrl('https://bots.example.dev')).toEqual({
      ok: true,
      origin: 'https://bots.example.dev',
    })
    expect(isAllowedPhoneServerUrl('http://127.0.0.1:7443')).toEqual({
      ok: false,
      reason: 'Phones connect to the bot server over HTTPS',
    })
    expect(isAllowedPhoneServerUrl('http://127.0.0.1:7443', { allowLoopback: true })).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:7443',
    })
    expect(isAllowedPhoneServerUrl('http://100.101.102.103:7443', { allowLoopback: true }).ok).toBe(false)
    expect(isAllowedPhoneServerUrl('http://box.tail1234.ts.net').ok).toBe(false)
    expect(isAllowedPhoneServerUrl('https://x.dev/path')).toEqual({ ok: false, reason: 'URL must have no path' })
  })
})

describe('pairing route', () => {
  it('creates codes for paired devices with an empty body', () => {
    expect(FLEET_GATEWAY_ROUTES.pairingsCreate).toMatchObject({ method: 'POST', path: '/v1/pairings' })
    expect(FLEET_GATEWAY_ROUTES.pairingsCreate.body.parse({})).toEqual({})
    expect(() => FLEET_GATEWAY_ROUTES.pairingsCreate.body.parse({ extra: 1 })).toThrow()
    expect(
      fleetPairingCodeResponseSchema.parse({ code: 'K7Q2-M9XD', expiresAt: '2026-10-12T12:00:00.000Z' }).code
    ).toBe('K7Q2-M9XD')
    expect(() =>
      fleetPairingCodeResponseSchema.parse({ code: 'K7Q2M9XD', expiresAt: '2026-10-12T12:00:00.000Z' })
    ).toThrow()
  })
})
