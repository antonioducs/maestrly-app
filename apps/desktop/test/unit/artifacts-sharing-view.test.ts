import { describe, expect, it } from 'vitest'
import {
  deviceLabel,
  EXPIRY_CHOICES,
  eventText,
  expiryChoice,
  expiryFromDays,
  sharingSummary,
  validateAccessCode,
  validatePersonName,
} from '../../src/renderer/components/artifacts/sharing-view'
import type { TFn } from '../../src/renderer/components/settings/shared'
import type { ArtifactEventView, ArtifactPersonView } from '../../src/shared/artifacts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

/** Shows the key and its values, so the tests check what is said without depending on a language. */
const t = ((key: string, values: Record<string, unknown> = {}) =>
  `${key}${Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`) as unknown as TFn

const event = (kind: ArtifactEventView['kind'], data: ArtifactEventView['data']): ArtifactEventView => ({
  id: 'e1',
  artifactId: 'A'.repeat(22),
  kind,
  data,
  createdAt: NOW,
  seen: false,
})

const person = (overrides: Partial<ArtifactPersonView>): ArtifactPersonView => ({
  id: 'p1',
  kind: 'invited',
  name: 'Maria',
  createdAt: NOW,
  inviteExpiresAt: null,
  linkAvailable: true,
  devices: [],
  ...overrides,
})

describe('link expiry', () => {
  it('offers a week, a month, three months and never', () => {
    expect(EXPIRY_CHOICES).toEqual([7, 30, 90, null])
  })

  it('turns days into a date', () => {
    expect(expiryFromDays(30, NOW)).toBe(NOW + 30 * DAY)
    expect(expiryFromDays(7, NOW)).toBe(NOW + 7 * DAY)
    expect(expiryFromDays(null, NOW)).toBeNull()
  })

  it('recognizes a date as one of the choices, within a day', () => {
    expect(expiryChoice(null, NOW)).toBeNull()
    for (const days of [7, 30, 90]) {
      expect(expiryChoice(NOW + days * DAY, NOW)).toBe(days)
      expect(expiryChoice(NOW + days * DAY - DAY, NOW)).toBe(days)
      expect(expiryChoice(NOW + days * DAY + DAY, NOW)).toBe(days)
    }
    expect(expiryChoice(NOW + 28 * DAY, NOW)).toBe('custom')
    expect(expiryChoice(NOW + 45 * DAY, NOW)).toBe('custom')
    expect(expiryChoice(NOW - DAY, NOW)).toBe('custom')
  })
})

describe('validation', () => {
  it('accepts access codes of 6 to 64 characters', () => {
    expect(validateAccessCode('12345')).toBe('too_short')
    expect(validateAccessCode('')).toBe('too_short')
    expect(validateAccessCode('123456')).toBe('ok')
    expect(validateAccessCode('x'.repeat(64))).toBe('ok')
    expect(validateAccessCode('x'.repeat(65))).toBe('too_long')
  })

  it('accepts names of 1 to 60 characters, ignoring surrounding spaces', () => {
    expect(validatePersonName('')).toBe('empty')
    expect(validatePersonName('   ')).toBe('empty')
    expect(validatePersonName(' Maria ')).toBe('ok')
    expect(validatePersonName('x'.repeat(60))).toBe('ok')
    expect(validatePersonName('x'.repeat(61))).toBe('too_long')
  })
})

describe('eventText', () => {
  it('says what happened for each kind of event', () => {
    expect(eventText(t, event('device_added', { name: 'Maria', device: 'Safari/iPhone' }))).toBe(
      'artifacts.events.device_added {"name":"Maria","device":"artifacts.share.device {\\"browser\\":\\"Safari\\",\\"os\\":\\"iPhone\\"}"}'
    )
    expect(eventText(t, event('access_requested', { name: 'João' }))).toBe(
      'artifacts.events.access_requested {"name":"João"}'
    )
    expect(eventText(t, event('invite_declined', { name: 'Maria' }))).toBe(
      'artifacts.events.invite_declined {"name":"Maria"}'
    )
    expect(eventText(t, event('comment_added', { name: 'Ana' }))).toBe('artifacts.events.comment_added {"name":"Ana"}')
  })

  it('falls back to “Someone” when the event has no name', () => {
    expect(eventText(t, event('comment_added', {}))).toBe(
      'artifacts.events.comment_added {"name":"artifacts.events.someone"}'
    )
    expect(eventText(t, event('access_requested', { name: '' }))).toBe(
      'artifacts.events.access_requested {"name":"artifacts.events.someone"}'
    )
  })
})

describe('deviceLabel', () => {
  it('reads a stored label as browser and system, and copes with anything else', () => {
    expect(deviceLabel(t, 'Chrome/macOS')).toBe('artifacts.share.device {"browser":"Chrome","os":"macOS"}')
    expect(deviceLabel(t, 'Browser/Unknown')).toBe('artifacts.share.deviceUnknown')
    expect(deviceLabel(t, 'Firefox/Unknown')).toBe('Firefox')
    expect(deviceLabel(t, '')).toBe('artifacts.share.deviceUnknown')
    expect(deviceLabel(t, 'Something else')).toBe('Something else')
  })
})

describe('sharingSummary', () => {
  it('counts the people an artifact is shared with and their devices', () => {
    expect(sharingSummary([])).toEqual({ people: 0, devices: 0 })
    expect(
      sharingSummary([
        person({ devices: [{ id: 'd1', label: '', createdAt: NOW, lastSeenAt: NOW }] }),
        person({ id: 'p2', kind: 'approved', devices: [] }),
        person({
          id: 'p4',
          kind: 'guest',
          devices: [{ id: 'd2', label: '', createdAt: NOW, lastSeenAt: NOW }],
        }),
      ])
    ).toEqual({ people: 3, devices: 2 })
  })
})
