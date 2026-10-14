import { expect, it } from 'vitest'
import { FLEET_PHONES_FEATURE, fleetMetaFeatures } from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { harness } from './harness.js'

it('lets a paired device create a one-use code that pairs another device', async () => {
  const h = await harness()
  const meta = await (await h.request('GET', '/v1/meta')).json()
  // Past the 20 features installed desktops read, in the list they drop.
  expect(meta.features).not.toContain(FLEET_PHONES_FEATURE)
  expect(meta.moreFeatures).toContain(FLEET_PHONES_FEATURE)
  expect(fleetMetaFeatures(meta)).toContain(FLEET_PHONES_FEATURE)

  const created = await h.request('POST', '/v1/pairings', {})
  expect(created.status).toBe(201)
  const { code, expiresAt } = await created.json()
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(590_000)

  const paired = await fetch(h.origin + '/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.replace('-', ''), deviceName: 'iPhone' }),
  })
  expect(paired.status).toBe(200)
  expect(h.store.listDevices().map((device) => device.name)).toContain('iPhone')
})

it('refuses unauthenticated and extra-body requests and limits unused codes', async () => {
  const h = await harness()
  expect((await h.request('POST', '/v1/pairings', {}, false, { 'X-Maestrly-Fleet-Protocol': '1' })).status).toBe(401)
  expect((await h.request('POST', '/v1/pairings', { deviceName: 'x' })).status).toBe(400)
  for (let i = 0; i < 5; i++) expect((await h.request('POST', '/v1/pairings', {})).status).toBe(201)
  const limited = await h.request('POST', '/v1/pairings', {})
  expect(limited.status).toBe(429)
  expect((await limited.json()).code).toBe('RATE_LIMITED')
  // The CLI keeps working when the limit is reached.
  expect(new Auth(h.store).createPairing().code).toMatch(/-/)
  h.store.db.prepare('UPDATE pairing_codes SET expires_at=?').run('2000-01-01T00:00:00.000Z')
  expect((await h.request('POST', '/v1/pairings', {})).status).toBe(201)
})
