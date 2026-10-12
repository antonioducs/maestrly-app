import { describe, expect, it } from 'vitest'
import { isBlockingReason, type PluginComponentDto } from '../../src/shared/plugins'
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
  agents: [],
  hooks: [],
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
  const connector = comp('app-connector', 'unavailable', 'app-connector')
  it.each([
    ['skills only', pkg({ skills: [skill('a')] }), 'portable', []],
    ['oauth http only', pkg({ mcpServers: [http('linear', { kind: 'oauth' })] }), 'portable', []],
    [
      'apps + MCP for the same service',
      pkg({ skills: [skill('a')], mcpServers: [http('svc', { kind: 'oauth' })], components: [connector] }),
      'portable',
      ['app-connector'],
    ],
    [
      'apps + skills, no MCP',
      pkg({ skills: [skill('a')], components: [connector] }),
      'unavailable',
      ['requires-app-connector', 'app-connector'],
    ],
    ['apps only', pkg({ components: [connector] }), 'unavailable', ['requires-app-connector', 'app-connector']],
    [
      'placeholder oauth only',
      pkg({ mcpServers: [http('gm', { kind: 'oauth', placeholderClient: true })] }),
      'portable',
      ['auth-placeholder-client'],
    ],
    [
      'apps + placeholder oauth for the same service',
      pkg({ mcpServers: [http('gm', { kind: 'oauth', placeholderClient: true })], components: [connector] }),
      'portable',
      ['app-connector', 'auth-placeholder-client'],
    ],
    [
      'publisher client',
      pkg({ mcpServers: [http('gh', { kind: 'manual', reason: 'publisher-client' })] }),
      'portable',
      ['auth-publisher-client'],
    ],
    [
      'hooks of events Maestrly does not run',
      pkg({ skills: [skill('a')], components: [comp('hooks', 'not-run', 'hook-unsupported')] }),
      'portable',
      ['hook-unsupported'],
    ],
    [
      'hooks only',
      pkg({
        hooks: [{ event: 'Stop', matcher: null, command: 'echo done', timeoutSec: 60, source: 'hooks/hooks.json' }],
        components: [comp('hooks', 'adapted')],
      }),
      'portable',
      [],
    ],
    ['commands adapted', pkg({ skills: [command('review')] }), 'portable', []],
    [
      'agents only',
      pkg({
        agents: [{ name: 'reviewer', filePath: 'agents/reviewer.md', description: 'x', tools: null, droppedTools: [] }],
        components: [comp('agent', 'adapted')],
      }),
      'portable',
      [],
    ],
    [
      'invalid MCP entry',
      pkg({ skills: [skill('a')], components: [comp('mcp-server', 'invalid', 'entry-invalid')] }),
      'portable',
      ['entry-invalid'],
    ],
    [
      'symlinks',
      pkg({ skills: [skill('a')], components: [comp('symlink', 'not-run', 'symlink-skipped')] }),
      'portable',
      ['symlink-skipped'],
    ],
    [
      'language server',
      pkg({ skills: [skill('a')], components: [comp('lsp', 'not-run', 'component-unsupported')] }),
      'portable',
      ['component-unsupported'],
    ],
  ])('%s', (_, result, level, codes) => {
    const c = classifyPlugin(result, { sourceSupported: true })
    expect(c.level).toBe(level)
    expect(c.reasons.map((r) => r.code)).toEqual(codes)
  })

  it('offers a connector plugin that also ships an MCP server, noting the connector', () => {
    const named = { ...connector, name: 'svc_app' }
    expect(
      classifyPlugin(pkg({ skills: [skill('a')], mcpServers: [http('svc', { kind: 'oauth' })], components: [named] }), {
        sourceSupported: true,
      })
    ).toEqual({
      level: 'portable',
      reasons: [{ code: 'app-connector', component: 'app-connector', subject: 'svc_app' }],
    })
  })

  it('blocks a plugin whose only integration is an app connector, even with skills', () => {
    const result = classifyPlugin(pkg({ skills: [skill('a')], components: [connector] }), { sourceSupported: true })
    expect(result.level).toBe('unavailable')
    expect(result.reasons[0]).toEqual({ code: 'requires-app-connector' })
  })

  it('knows which reasons block', () => {
    expect(isBlockingReason('requires-app-connector')).toBe(true)
    expect(isBlockingReason('no-usable-components')).toBe(true)
    expect(isBlockingReason('app-connector')).toBe(false)
    expect(isBlockingReason('hook-unsupported')).toBe(false)
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
        mcpServers: [http('svc', { kind: 'oauth' })],
        components: [
          comp('app-connector', 'unavailable', 'app-connector'),
          comp('app-connector', 'unavailable', 'app-connector'),
        ],
      }),
      { sourceSupported: true }
    )
    expect(c.reasons).toHaveLength(1)
  })

  it('counts a server with a placeholder OAuth client as usable, noting it', () => {
    const p = {
      ...basePackage,
      mcpServers: [http('a', { kind: 'oauth', placeholderClient: true }), http('b', { kind: 'none' })],
    }
    expect(usableMcpServers(p).map((s) => s.key)).toEqual(['a', 'b'])
    expect(classifyPlugin({ ok: true, pkg: p }, { sourceSupported: true }).reasons).toEqual([
      { code: 'auth-placeholder-client', component: 'mcp-server', subject: 'a' },
    ])
  })
})
