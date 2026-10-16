import { describe, expect, it } from 'vitest'
import { initialPhoneAddress, phoneAddressError, secondsLeft } from '../../src/renderer/lib/fleet/pair-phone'

describe('pair a phone', () => {
  it('prefills only an address a phone can reach', () => {
    expect(initialPhoneAddress('https://bots.example.dev')).toBe('https://bots.example.dev')
    expect(initialPhoneAddress('http://127.0.0.1:7443')).toBe('')
    expect(initialPhoneAddress(null)).toBe('')
  })
  it('explains why an address does not work for a phone', () => {
    expect(phoneAddressError('https://bots.example.dev')).toBeNull()
    expect(phoneAddressError('http://box.tail1234.ts.net')).toBe('Phones connect to the bot server over HTTPS')
    expect(phoneAddressError('')).toBe('Invalid URL')
  })
  it('counts down to the expiry and never below zero', () => {
    expect(secondsLeft('2026-10-12T12:10:00.000Z', Date.parse('2026-10-12T12:00:00.500Z'))).toBe(600)
    expect(secondsLeft('2026-10-12T12:10:00.000Z', Date.parse('2026-10-12T12:11:00.000Z'))).toBe(0)
  })
})
