import { describe, it, expect } from 'vitest'
import { resources, namespaces } from '../../src/shared/i18n/resources'
import type { PlatformOs } from '../../src/preload/api-app'

/**
 * Key parity between English (source) and pt-BR (translation) in every namespace (#114).
 * English fallback tolerates missing pt-BR keys, but strict parity catches forgotten translations
 * and orphaned pt-BR keys that no longer exist in English.
 */
function leafKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    out.push(...leafKeys(v, path))
  }
  return out.sort()
}

describe('i18n — catalog parity (English is the source)', () => {
  const en = resources.en as Record<string, unknown>
  const pt = resources['pt-BR'] as Record<string, unknown>

  for (const ns of namespaces) {
    it(`namespace "${ns}" has matching en↔pt-BR keys`, () => {
      expect(leafKeys(pt[ns])).toEqual(leafKeys(en[ns]))
    })
  }
})

describe('i18n — the computer the app runs on', () => {
  const lookup = (catalog: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)

  it('calls it "this computer", since Maestrly also runs on Windows and Linux', () => {
    const mentions = (['en', 'pt-BR'] as const).flatMap((language) =>
      namespaces.flatMap((ns) =>
        leafKeys(resources[language][ns])
          .map((key) => `${ns}.${key}`)
          // The default device name on a Mac is the one place that names it.
          .filter((key) => key !== 'fleet.settings.deviceNameDefault.mac')
          .filter((key) => /\bMacs?\b/.test(String(lookup(resources[language], key))))
          .map((key) => `${language} ${key}`)
      )
    )
    expect(mentions).toEqual([])
  })

  it('suggests a device name for every system when pairing with a bot server', () => {
    const systems: Record<PlatformOs, true> = { mac: true, win: true, linux: true }
    for (const language of ['en', 'pt-BR'] as const)
      for (const os of Object.keys(systems))
        expect(lookup(resources[language].fleet, `settings.deviceNameDefault.${os}`), `${language} ${os}`).toEqual(
          expect.any(String)
        )
  })
})
