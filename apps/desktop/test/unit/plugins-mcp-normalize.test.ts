import { describe, expect, it } from 'vitest'
import { normalizeAgentPluginsMcp, normalizeClaudeMcp, normalizeCodexMcp } from '../../src/main/plugins/mcp-normalize'

const AP_PLUGIN_1_0 = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const AP_MCP_1_0 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const AP_MCP_1_1 = 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json'

describe('Codex MCP normalization', () => {
  it('maps Codex env_vars, bearer token and OAuth hints', () => {
    const r = normalizeCodexMcp({
      mcpServers: {
        local: {
          command: 'node',
          args: ['./mcp/server.mjs'],
          cwd: '.',
          env_vars: ['API_TOKEN'],
          tool_timeout_sec: 999999,
        },
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp', oauth_resource: 'https://mcp.linear.app/mcp' },
        gh: {
          type: 'http',
          url: 'https://api.example.com/mcp/',
          oauth: { client_id: 'Iv23synthetic', client_secret: 'synthetic' },
        },
        gm: { type: 'http', url: 'https://mail.example.com/mcp', oauth: { client_id: '<GMAIL_PUBLIC_CLIENT_ID>' } },
        tok: { type: 'http', url: 'https://api.example.com/mcp', bearer_token_env_var: 'EXAMPLE_TOKEN' },
      },
    })
    expect(r.servers.find((s) => s.key === 'local')).toMatchObject({
      transport: 'stdio',
      command: 'node',
      commandKind: 'bare',
      cwd: './',
      toolTimeoutMs: 3_600_000,
    })
    expect(r.servers.find((s) => s.key === 'linear')?.auth).toEqual({
      kind: 'oauth',
      resource: 'https://mcp.linear.app/mcp',
    })
    expect(r.servers.find((s) => s.key === 'gh')?.auth).toEqual({ kind: 'manual', reason: 'publisher-client' })
    expect(r.servers.find((s) => s.key === 'gm')?.auth).toEqual({ kind: 'unusable', reason: 'placeholder-client' })
    expect(r.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'env:local:API_TOKEN', required: false, sensitive: true }),
        expect.objectContaining({
          id: 'header:tok:Authorization',
          required: true,
          sensitive: true,
          target: { kind: 'header', serverKey: 'tok', name: 'Authorization', prefix: 'Bearer ' },
        }),
      ])
    )
    expect(r.issues).toEqual([])
  })

  it('accepts a bare map, keeps headers, filters and timeouts, and ignores informational keys', () => {
    const r = normalizeCodexMcp({
      api: {
        url: 'https://api.example.com/mcp',
        http_headers: { 'X-Tenant': 'public' },
        env_http_headers: { 'X-Api-Key': 'EXAMPLE_KEY' },
        startup_timeout_sec: 500,
        enabled: false,
        enabled_tools: ['a'],
        disabled_tools: ['b'],
        note: 'informational',
        title: 'API',
      },
    })
    expect(r.servers).toEqual([
      {
        key: 'api',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { 'X-Tenant': 'public' },
        startupTimeoutMs: 120_000,
        enabledByDefault: false,
        toolFilter: { allow: ['a'], deny: ['b'] },
        auth: { kind: 'none' },
      },
    ])
    expect(r.inputs).toEqual([
      expect.objectContaining({
        id: 'header:api:X-Api-Key',
        target: { kind: 'header', serverKey: 'api', name: 'X-Api-Key', prefix: '' },
      }),
    ])
    expect(r.issues).toEqual([])
  })

  it.each([
    ['plain http to a public host', { url: 'http://example.com/mcp' }],
    ['user information', { url: 'https://u:p@example.com/mcp' }],
    ['a fragment', { url: 'https://example.com/mcp#x' }],
    ['a command with spaces', { command: 'node server.js' }],
    ['an absolute command', { command: '/usr/bin/node' }],
    ['a parent-relative command', { command: '../bin/x' }],
    ['a cwd outside the plugin', { command: 'node', cwd: '../x' }],
    ['an injected input token', { command: 'node', args: ['${input:config:x}'] }],
    ['neither url nor command', { args: ['x'] }],
  ])('rejects an entry with %s', (_, entry) => {
    const r = normalizeCodexMcp({ mcpServers: { bad: entry, ok: { url: 'http://127.0.0.1:9/mcp' } } })
    expect(r.servers.map((s) => s.key)).toEqual(['ok'])
    expect(r.issues).toEqual([expect.objectContaining({ code: 'entry-invalid', subject: 'bad' })])
  })

  it('reports unknown transports', () => {
    const r = normalizeCodexMcp({ mcpServers: { w: { type: 'websocket', url: 'wss://x.example.com' } } })
    expect(r.issues).toEqual([expect.objectContaining({ code: 'transport-unsupported', subject: 'w' })])
  })
})

describe('Agent Plugins MCP normalization', () => {
  it('enforces the Agent Plugins closed variants and version match', () => {
    const ok = normalizeAgentPluginsMcp(
      {
        $schema: AP_MCP_1_0,
        mcpServers: {
          a: { type: 'stdio', command: './bin/a', cwd: '${PLUGIN_DATA}/w' },
          b: { type: 'streamable-http', url: 'https://x.example.com/mcp', command: 'oops' },
          c: { type: 'stdio', command: 'npx', env: { PLUGIN_ROOT: 'x' } },
          d: { type: 'sse', url: 'http://10.0.0.5/sse' },
        },
      },
      AP_PLUGIN_1_0
    )
    expect(ok.servers.map((s) => s.key)).toEqual(['a'])
    expect(ok.servers[0]).toMatchObject({ command: './bin/a', commandKind: 'plugin-relative', cwd: '${PLUGIN_DATA}/w' })
    expect(ok.issues.map((i) => i.subject).sort()).toEqual(['b', 'c', 'd'])
    expect(normalizeAgentPluginsMcp({ $schema: AP_MCP_1_1, mcpServers: {} }, AP_PLUGIN_1_0).issues[0].code).toBe(
      'mcp-config-invalid'
    )
  })

  it('normalizes streamable-http to http and rejects extra top-level fields', () => {
    const r = normalizeAgentPluginsMcp(
      { $schema: AP_MCP_1_0, mcpServers: { s: { type: 'streamable-http', url: 'https://x.example.com/mcp' } } },
      AP_PLUGIN_1_0
    )
    expect(r.servers[0]).toMatchObject({ transport: 'http', auth: { kind: 'none' } })
    const extra = normalizeAgentPluginsMcp({ $schema: AP_MCP_1_0, mcpServers: {}, other: 1 }, AP_PLUGIN_1_0)
    expect(extra.issues[0].code).toBe('mcp-config-invalid')
  })

  it('rejects duplicate header names that differ only in case', () => {
    const r = normalizeAgentPluginsMcp(
      {
        $schema: AP_MCP_1_0,
        mcpServers: { s: { type: 'sse', url: 'https://x.example.com/sse', headers: { 'X-A': '1', 'x-a': '2' } } },
      },
      AP_PLUGIN_1_0
    )
    expect(r.servers).toEqual([])
    expect(r.issues[0]).toMatchObject({ code: 'entry-invalid', subject: 's' })
  })
})

describe('Claude MCP normalization', () => {
  it('rewrites Claude plugin variables and user_config references', () => {
    const r = normalizeClaudeMcp(
      {
        mcpServers: {
          api: {
            command: '${CLAUDE_PLUGIN_ROOT}/server',
            args: ['--cfg', '${CLAUDE_PLUGIN_ROOT}/c.json'],
            env: { TOKEN: '${user_config.api_token}', HOME_DIR: '${MY_HOME:-/tmp}' },
          },
          w: { type: 'ws', url: 'wss://x.example.com' },
        },
      },
      { api_token: { type: 'string', title: 'API token', description: 'Token', sensitive: true, required: true } }
    )
    expect(r.servers[0]).toMatchObject({
      command: './server',
      commandKind: 'plugin-relative',
      args: ['--cfg', '${PLUGIN_ROOT}/c.json'],
      env: { TOKEN: '${input:config:api_token}', HOME_DIR: '${input:env:api:MY_HOME}' },
    })
    expect(r.inputs.map((i) => i.id).sort()).toEqual(['config:api_token', 'env:api:MY_HOME'])
    expect(r.inputs.find((i) => i.id === 'env:api:MY_HOME')?.defaultValue).toBe('/tmp')
    expect(r.inputs.find((i) => i.id === 'config:api_token')).toMatchObject({
      label: 'API token',
      sensitive: true,
      required: true,
    })
    expect(r.issues).toEqual([expect.objectContaining({ code: 'transport-unsupported', subject: 'w' })])
  })

  it('refuses headersHelper, undeclared user_config keys and bundles', () => {
    const r = normalizeClaudeMcp(
      {
        helper: { type: 'http', url: 'https://x.example.com/mcp', headersHelper: './h.sh' },
        undeclared: { command: 'node', env: { A: '${user_config.missing}' } },
      },
      {}
    )
    expect(r.servers).toEqual([])
    expect(r.issues.map((i) => [i.code, i.subject])).toEqual([
      ['entry-invalid', 'helper'],
      ['entry-invalid', 'undeclared'],
    ])
    expect(r.issues[0].detail).toContain('runs a shell command')
    expect(normalizeClaudeMcp('./bundle.mcpb', {}).issues[0].code).toBe('mcp-bundle')
  })

  it('expands variables in remote URLs and headers into inputs', () => {
    const r = normalizeClaudeMcp(
      {
        api: {
          type: 'http',
          url: 'https://${HOST:-api.example.com}/mcp',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
      },
      {}
    )
    expect(r.servers[0]).toMatchObject({
      url: 'https://${input:env:api:HOST}/mcp',
      headers: { Authorization: 'Bearer ${input:env:api:TOKEN}' },
    })
    expect(r.inputs.map((i) => i.id).sort()).toEqual(['env:api:HOST', 'env:api:TOKEN'])
  })
})
