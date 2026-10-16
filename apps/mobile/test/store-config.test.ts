import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import appConfig from '../app.config'
import { en } from '../src/i18n/catalogs'

const require = createRequire(import.meta.url)
const app = path.resolve(import.meta.dirname, '..')
const STORE_CONFIG = path.join(app, 'store.config.cjs')
const CONTACT = {
  MAESTRLY_APP_REVIEW_FIRST_NAME: 'Ada',
  MAESTRLY_APP_REVIEW_LAST_NAME: 'Lovelace',
  MAESTRLY_APP_REVIEW_EMAIL: 'review@example.com',
  MAESTRLY_APP_REVIEW_PHONE: '+1 555 0100',
}

type Listing = { title: string; subtitle: string; promoText: string; description: string; keywords: string[] } & Record<
  string,
  unknown
>

/** The store listing as `eas metadata:push` reads it, with the given environment. */
function listing(env: Record<string, string> = {}) {
  for (const name of Object.keys(CONTACT)) vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  delete require.cache[STORE_CONFIG]
  return require(STORE_CONFIG).apple
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the App Store listing', () => {
  it('describes the version the app builds', () => {
    const manifest = require(path.join(app, 'package.json'))
    expect(listing().version).toBe(manifest.version)
    expect(appConfig.version).toBe(manifest.version)
  })

  it('fits the store limits in English and Portuguese', () => {
    const info: Record<string, Listing> = listing().info
    expect(Object.keys(info)).toEqual(['en-US', 'pt-BR'])
    for (const locale of Object.values(info)) {
      expect(locale.title).toBe(appConfig.name)
      expect(locale.subtitle.length).toBeLessThanOrEqual(30)
      expect(locale.promoText.length).toBeLessThanOrEqual(170)
      expect(locale.description.length).toBeLessThanOrEqual(4000)
      expect(locale.keywords.join(',').length).toBeLessThanOrEqual(100)
      for (const url of ['marketingUrl', 'supportUrl', 'privacyPolicyUrl']) expect(locale[url]).toMatch(/^https:\/\//)
    }
    expect(info['en-US'].description).toContain(en['welcome.demo'])
  })

  it('shows 6.9-inch iPhone screenshots', () => {
    const shots: string[] = listing().info['en-US'].screenshots.APP_IPHONE_67
    expect(shots.length).toBeGreaterThan(0)
    expect(shots.length).toBeLessThanOrEqual(10)
    for (const shot of shots) {
      const png = readFileSync(path.join(app, shot))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1290, 2796])
    }
  })

  it('names the contact for App Review only from the environment', () => {
    expect(listing().review).toBeUndefined()
    expect(listing({ ...CONTACT, MAESTRLY_APP_REVIEW_PHONE: '' }).review).toBeUndefined()
    const review = listing(CONTACT).review
    expect(review).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'review@example.com',
      phone: '+1 555 0100',
    })
    expect(review.demoRequired).toBe(false)
    expect(review.notes).toContain(en['welcome.demo'])
  })
})
