import { describe, expect, it } from 'vitest'
import { partitionCatalog } from '../../src/renderer/components/plugins/catalog-partition'
import type { PluginCatalogEntryDto, PluginCompatibility, PluginPolicyDto } from '../../src/shared/plugins'

const portable: PluginCompatibility = { level: 'portable', reasons: [] }
const entry = (
  name: string,
  compatibility: PluginCompatibility | null,
  installation: PluginPolicyDto['installation'] = 'AVAILABLE'
): PluginCatalogEntryDto => ({
  marketplaceId: 'mkt_0123456789abcdef',
  name,
  displayName: name,
  description: null,
  publisher: null,
  category: null,
  version: null,
  format: 'codex',
  compatibility,
  installed: false,
  updateAvailable: false,
  hasLogo: false,
  policy: { installation, authentication: null, products: [] },
})

describe('plugin catalog partition', () => {
  it('offers portable and not-yet-inspected plugins and sets aside the rest with their first blocking reason', () => {
    const result = partitionCatalog([
      entry('a', portable),
      entry('b', null),
      entry('c', {
        level: 'unavailable',
        reasons: [{ code: 'app-connector', subject: 'x' }, { code: 'requires-app-connector' }],
      }),
      entry('d', portable, 'NOT_AVAILABLE'),
    ])
    expect(result.offered.map((e) => e.name)).toEqual(['a', 'b'])
    expect(result.incompatible).toEqual([
      { entry: expect.objectContaining({ name: 'c' }), reason: { code: 'requires-app-connector' } },
      { entry: expect.objectContaining({ name: 'd' }), reason: { code: 'install-not-available' } },
    ])
  })

  it('falls back to the first reason when none blocks', () => {
    const result = partitionCatalog([
      entry('e', { level: 'unavailable', reasons: [{ code: 'hook-unsupported', subject: 'h' }] }),
    ])
    expect(result.incompatible).toEqual([
      { entry: expect.objectContaining({ name: 'e' }), reason: { code: 'hook-unsupported', subject: 'h' } },
    ])
  })
})
