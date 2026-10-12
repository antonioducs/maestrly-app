import { describe, expect, it } from 'vitest'
import type { PluginComponentDto } from '../../src/shared/plugins'
import { classifyPlugin, usableMcpServers } from '../../src/main/plugins/compatibility'
import type { PluginMcpAuth, PluginMcpServerSpec } from '../../src/main/plugins/mcp-normalize'
import type { LoadResult, PluginPackage, PluginSkillSpec } from '../../src/main/plugins/types'

const basePackage: PluginPackage = {
  name: 'demo',
  format: 'codex',
  version: '1.0.0',
  description: null,
  displayName: null,
  publisher: null,
  license: { spdx: null, file: null },
  homepage: null,
  links: {},
  capabilities: [],
  category: null,
  logoPath: null,
  skills: [],
  mcpServers: [],
  inputs: [],
  components: [],
  issues: [],
}
const pkg = (over: Partial<PluginPackage>): LoadResult => ({ ok: true, pkg: { ...basePackage, ...over } })
const skill = (name: string): PluginSkillSpec => ({
  name,
  dirPath: `skills/${name}`,
  description: name,
  kind: 'skill',
  hasScripts: false,
})
const command = (name: string): PluginSkillSpec => ({
  name,
  dirPath: `commands/${name}.md`,
  description: name,
  kind: 'command',
  hasScripts: false,
})
const http = (key: string, auth: PluginMcpAuth): PluginMcpServerSpec => ({
  key,
  transport: 'http',
  url: 'https://x.example.com/mcp',
  headers: {},
  enabledByDefault: true,
  auth,
})
const comp = (
  kind: PluginComponentDto['kind'],
  status: PluginComponentDto['status'],
  reason?: PluginComponentDto['reason']
): PluginComponentDto => ({ kind, name: kind, status, ...(reason ? { reason } : {}) })

describe('plugin compatibility', () => {
  it.each([
    ['skills only', pkg({ skills: [skill('a')] }), 'portable', []],
    ['oauth http only', pkg({ mcpServers: [http('linear', { kind: 'oauth' })] }), 'portable', []],
    [
      'apps + skills',
      pkg({ skills: [skill('a')], components: [comp('app-connector', 'unavailable', 'app-connector')] }),
      'partial',
      ['app-connector'],
    ],
    [
      'apps only',
      pkg({ components: [comp('app-connector', 'unavailable', 'app-connector')] }),
      'unavailable',
      ['no-usable-components', 'app-connector'],
    ],
    [
      'placeholder oauth only',
      pkg({ mcpServers: [http('gm', { kind: 'unusable', reason: 'placeholder-client' })] }),
      'unavailable',
      ['no-usable-components', 'auth-placeholder-client'],
    ],
    [
      'publisher client',
      pkg({ mcpServers: [http('gh', { kind: 'manual', reason: 'publisher-client' })] }),
      'partial',
      ['auth-publisher-client'],
    ],
    [
      'hooks',
      pkg({ skills: [skill('a')], components: [comp('hooks', 'not-run', 'hooks-not-run')] }),
      'partial',
      ['hooks-not-run'],
    ],
    ['commands adapted', pkg({ skills: [command('review')] }), 'portable', []],
    [
      'agents',
      pkg({ skills: [skill('a')], components: [comp('agent', 'not-run', 'agent-not-adapted')] }),
      'partial',
      ['agent-not-adapted'],
    ],
    [
      'invalid MCP entry',
      pkg({ skills: [skill('a')], components: [comp('mcp-server', 'invalid', 'entry-invalid')] }),
      'partial',
      ['entry-invalid'],
    ],
    [
      'symlinks',
      pkg({ skills: [skill('a')], components: [comp('symlink', 'not-run', 'symlink-skipped')] }),
      'partial',
      ['symlink-skipped'],
    ],
  ])('%s', (_, result, level, codes) => {
    const c = classifyPlugin(result, { sourceSupported: true })
    expect(c.level).toBe(level)
    expect(c.reasons.map((r) => r.code)).toEqual(codes)
  })

  it('marks unsupported sources and NOT_AVAILABLE policy unavailable', () => {
    expect(classifyPlugin(pkg({ skills: [skill('a')] }), { sourceSupported: false }).reasons[0].code).toBe(
      'source-unsupported'
    )
    const notAvailable = classifyPlugin(pkg({ skills: [skill('a')] }), {
      sourceSupported: true,
      installation: 'NOT_AVAILABLE',
    })
    expect(notAvailable).toEqual({ level: 'unavailable', reasons: [{ code: 'install-not-available' }] })
  })

  it('marks failed manifests unavailable with their reason', () => {
    expect(
      classifyPlugin({ ok: false, code: 'schema-unsupported', detail: 'x' }, { sourceSupported: true }).reasons[0].code
    ).toBe('schema-unsupported')
    expect(classifyPlugin({ ok: false, code: 'no-manifest', detail: 'x' }, { sourceSupported: true })).toEqual({
      level: 'unavailable',
      reasons: [{ code: 'manifest-invalid', detail: 'x' }],
    })
  })

  it('does not repeat reasons for the same component', () => {
    const c = classifyPlugin(
      pkg({
        skills: [skill('a')],
        components: [
          comp('app-connector', 'unavailable', 'app-connector'),
          comp('app-connector', 'unavailable', 'app-connector'),
        ],
      }),
      { sourceSupported: true }
    )
    expect(c.reasons).toHaveLength(1)
  })

  it('treats servers with unusable credentials as not usable', () => {
    const p = {
      ...basePackage,
      mcpServers: [http('a', { kind: 'unusable', reason: 'placeholder-client' }), http('b', { kind: 'none' })],
    }
    expect(usableMcpServers(p).map((s) => s.key)).toEqual(['b'])
  })
})
