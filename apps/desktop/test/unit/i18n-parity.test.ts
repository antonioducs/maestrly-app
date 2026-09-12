import { describe, it, expect } from 'vitest'
import { resources, namespaces } from '../../src/shared/i18n/resources'

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
