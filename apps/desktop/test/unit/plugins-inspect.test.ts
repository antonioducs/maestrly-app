import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PATTERNS,
  PLUGIN_DETAIL_PATTERNS,
  PLUGIN_METADATA_PATTERNS,
  inspectTree,
  manifestReferencedPatterns,
  toInspectionDto,
} from '../../src/main/plugins/inspect'
import type { MarketplaceEntry } from '../../src/main/plugins/marketplace'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import { writeTree } from '../helpers/plugin-fixtures'

const fixtures = fileURLToPath(new URL('../fixtures/plugins/', import.meta.url))
const entry = (name: string, over: Partial<MarketplaceEntry> = {}): MarketplaceEntry => ({
  name,
  source: { kind: 'path', path: '' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: [] },
  category: null,
  display: {},
  ...over,
})
const codexPlugin = (args: string[], description = 'One') => ({
  '.codex-plugin/plugin.json': JSON.stringify({ name: 'fp', description }),
  '.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'node', args } } }),
  'skills/a/SKILL.md': '---\ndescription: A\n---\nA',
})

describe('plugin inspection', () => {
  it('collects endpoints, executables, requirements and the license', async () => {
    const inspection = await inspectTree(await fsPackageTree(path.join(fixtures, 'codex-full')), entry('codex-full'))
    expect(inspection.compatibility.level).toBe('portable')
    expect(inspection.endpoints).toEqual(
      expect.arrayContaining(['https://mcp.example.com/mcp', 'https://example.com/codex-full'])
    )
    expect(inspection.executables).toContain('scripts/check.sh')
    expect(inspection.requirements).toEqual(['node'])
    expect(inspection.licenseText).toEqual({ text: expect.stringContaining('MIT'), truncated: false })
    expect(Object.keys(inspection.launchDigests)).toEqual(['local'])
    const dto = toInspectionDto({
      marketplaceId: 'mkt_1',
      entry: entry('codex-full'),
      inspection,
      source: { url: 'https://example.com/r.git', path: null, commit: 'a'.repeat(40) },
    })
    expect(dto.mcpServers.find((s) => s.key === 'local')).toMatchObject({
      transport: 'stdio',
      launch: 'node ./mcp/server.mjs',
    })
    expect(dto.mcpServers.find((s) => s.key === 'remote')).toMatchObject({ endpoint: 'mcp.example.com', auth: 'oauth' })
    expect(dto.license.spdx).toBe('MIT')
  })

  it('changes the consent fingerprint with the launch line, not with the description', async () => {
    const a = await inspectTree(await fsPackageTree(await writeTree(codexPlugin(['a.js']))), entry('fp'))
    const b = await inspectTree(await fsPackageTree(await writeTree(codexPlugin(['b.js']))), entry('fp'))
    const c = await inspectTree(await fsPackageTree(await writeTree(codexPlugin(['a.js'], 'Two'))), entry('fp'))
    expect(a.consentFingerprint).not.toBe(b.consentFingerprint)
    expect(a.consentFingerprint).toBe(c.consentFingerprint)
  })

  it('truncates long license texts', async () => {
    const root = await writeTree({
      ...codexPlugin(['a.js']),
      LICENSE: 'x'.repeat(70 * 1024),
    })
    const inspection = await inspectTree(await fsPackageTree(root), entry('fp'))
    expect(inspection.licenseText.truncated).toBe(true)
    expect(inspection.licenseText.text).toHaveLength(64 * 1024)
  })

  it('marks unsupported sources and NOT_AVAILABLE entries', async () => {
    const tree = await fsPackageTree(await writeTree(codexPlugin(['a.js'])))
    const npm = await inspectTree(tree, entry('fp', { source: { kind: 'unsupported', type: 'npm' } }))
    expect(npm.compatibility.reasons[0].code).toBe('source-unsupported')
    const blocked = await inspectTree(
      tree,
      entry('fp', { policy: { installation: 'NOT_AVAILABLE', authentication: null, products: [] } })
    )
    expect(blocked.compatibility.level).toBe('unavailable')
  })

  it('builds sparse patterns for catalogs, metadata, documents and declared paths', async () => {
    expect(CATALOG_PATTERNS('')).toContain('/.agents/plugins/marketplace.json')
    expect(PLUGIN_METADATA_PATTERNS('plugins/a')).toEqual(
      expect.arrayContaining(['/plugins/a/.codex-plugin/plugin.json', '/plugins/a/LICENSE*'])
    )
    expect(PLUGIN_DETAIL_PATTERNS('plugins/a')).toEqual([
      '/plugins/a/**/SKILL.md',
      '/plugins/a/commands/*.md',
      '/plugins/a/agents/*.md',
    ])
    const root = await writeTree({
      'p/.claude-plugin/plugin.json': JSON.stringify({ name: 'p', mcpServers: './cfg/mcp.json', skills: ['./extra'] }),
    })
    expect(await manifestReferencedPatterns(await fsPackageTree(root), 'p')).toEqual(
      expect.arrayContaining(['/p/cfg/mcp.json', '/p/extra/**/SKILL.md'])
    )
  })
})
