import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { compileFunction } from 'node:vm'
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

/** The store listing of the app at another version. */
function listingAt(version: string) {
  const module = { exports: {} as { apple: { info: Record<string, Listing> } } }
  const load = compileFunction(readFileSync(STORE_CONFIG, 'utf8'), ['require', 'module', '__dirname'])
  load((id: string) => (id === './package.json' ? { version } : require(id)), module, app)
  return module.exports.apple
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

  it("says what's new in every version after the first, in each language", () => {
    for (const locale of Object.values(listing().info as Record<string, Listing>)) {
      if (locale.releaseNotes !== undefined) expect(String(locale.releaseNotes).length).toBeLessThanOrEqual(4000)
    }
    for (const locale of Object.values(listingAt('0.1.0').info)) expect(locale.releaseNotes).toBeUndefined()
    expect(() => listingAt('9.9.9')).toThrow("Write the What's New of 9.9.9")
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
  })

  it('answers what App Review asks about the app, within the notes limit', () => {
    const notes: string = listing(CONTACT).review.notes
    expect(notes.length).toBeLessThanOrEqual(4000)
    for (const label of ['welcome.demo', 'welcome.scan', 'welcome.manual'] as const) expect(notes).toContain(en[label])
    expect(notes).toContain(en['settings.unpair'].replace('{server}', '<server>'))
    for (const section of [
      'PURPOSE AND AUDIENCE',
      'SETUP AND ACCESS',
      'EXTERNAL SERVICES',
      'REGIONAL DIFFERENCES',
      'REGULATED INDUSTRY OR THIRD-PARTY MATERIAL',
    ]) {
      expect(notes).toContain(section)
    }
  })
})
