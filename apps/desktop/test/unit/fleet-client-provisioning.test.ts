import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  skillDir: '/synthetic/review',
  mcp: vi.fn(() => [
    {
      id: 'm1',
      name: 'Tools',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      env: { TOKEN: 'synthetic-mcp-secret' },
    },
  ]),
  providers: [{ id: 'p1', name: 'Local', kind: 'openai', baseURL: 'http://localhost:11434/v1' }],
  available: [
    { id: 'copilot', name: 'Copilot', builtin: 'github-copilot-subscription' },
    { id: 'cursor', name: 'Cursor', builtin: 'cursor-subscription' },
    { id: 'codex', name: 'Codex', builtin: 'codex-subscription' },
  ],
  key: vi.fn((): string | null => 'synthetic-api-secret'),
  package: vi.fn(async () => [{ path: 'SKILL.md', data: Buffer.from('skill'), executable: false }]),
  status: vi.fn(() => ({ authenticated: true, account: { type: 'chatgpt', email: 'owner@example.test' } })),
}))
vi.mock('../../src/main/chat/catalog', () => ({
  listProviders: () => mocks.providers,
  listAvailableChatProviders: () => mocks.available,
  getProviderKind: (p: { kind: string }) => p.kind,
}))
vi.mock('../../src/main/chat/credentials', () => ({ getApiKey: mocks.key }))
vi.mock('../../src/main/chat/github-copilot', () => ({
  getGitHubCopilotSubscriptionManager: () => ({ exportToken: () => 'synthetic-copilot-secret' }),
}))
vi.mock('../../src/main/chat/cursor-subscription', () => ({
  getCursorSubscriptionManager: () => ({
    exportCredential: () => ({ apiKey: 'synthetic-cursor-secret', expiresAtMs: null }),
  }),
}))
vi.mock('../../src/main/chat/codex-subscription', () => ({
  getCodexSubscriptionManager: () => ({ peekStatus: mocks.status }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk', () => ({
  getClaudeSubscriptionManager: () => ({ peekStatus: () => null }),
}))
vi.mock('../../src/main/chat/grok-subscription', () => ({
  getGrokSubscriptionManager: () => ({ getStatusSnapshot: () => null }),
}))
vi.mock('../../src/main/chat/skills', () => ({
  listSkills: async () => [{ name: 'review', description: 'Review', dir: mocks.skillDir, scope: 'global' }],
}))
vi.mock('../../src/main/chat/skill-package', () => ({
  packageSkillDirectory: mocks.package,
  measureSkillDirectory: async (dir: string) =>
    dir === '/synthetic/review'
      ? { files: 1, bytes: 5, scripts: false, problem: null }
      : (
          await vi.importActual<typeof import('../../src/main/chat/skill-package')>('../../src/main/chat/skill-package')
        ).measureSkillDirectory(dir),
}))
vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: mocks.mcp }))
import { buildMacInventory } from '../../src/main/fleet/client/provisioning/inventory'
import { importFromMac } from '../../src/main/fleet/client/provisioning/export'
import { registerFleetProvisioningIpc } from '../../src/main/fleet/client/provisioning/ipc'
import type { FleetClientService } from '../../src/main/fleet/client/service'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
const selection = {
  apiKeyIds: ['p1'],
  copyIds: ['github-copilot:default', 'cursor:default'],
  skillNames: ['review'],
  mcpServerIds: ['m1'],
}
beforeEach(() => vi.clearAllMocks())
describe('Mac provisioning', () => {
  it('returns inventory without stored secrets or starting runtimes', async () => {
    const inventory = await buildMacInventory()
    expect(inventory.apiKeys[0].localOnly).toBe(true)
    expect(inventory.logins[0]).toMatchObject({ email: 'owner@example.test' })
    for (const secret of [
      'synthetic-api-secret',
      'synthetic-copilot-secret',
      'synthetic-cursor-secret',
      'synthetic-mcp-secret',
    ])
      expect(JSON.stringify(inventory)).not.toContain(secret)
  })
  it('exports selected credentials, skill bytes and transformed MCP in order', async () => {
    const call = vi.fn(async (key: string) =>
      key === 'botSkillInstall'
        ? { name: 'review', outcome: 'added' }
        : {
            results: Array.from({ length: key === 'botAccountsImport' ? 3 : 1 }, (_, index) => ({
              index,
              target: 'remote',
              outcome: 'added',
              error: null,
            })),
          }
    )
    const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', selection)
    expect(call.mock.calls.map(([key]) => key)).toEqual(['botAccountsImport', 'botSkillInstall', 'botMcpServersImport'])
    expect(call).toHaveBeenNthCalledWith(
      1,
      'botAccountsImport',
      expect.objectContaining({
        body: {
          items: [
            {
              type: 'api-key',
              name: 'Local',
              kind: 'openai',
              baseURL: 'http://localhost:11434/v1',
              key: 'synthetic-api-secret',
            },
            { type: 'github-copilot', label: 'Copilot', token: 'synthetic-copilot-secret' },
            { type: 'cursor', label: 'Cursor', apiKey: 'synthetic-cursor-secret', expiresAt: null },
          ],
        },
      })
    )
    expect(call).toHaveBeenNthCalledWith(
      2,
      'botSkillInstall',
      expect.objectContaining({
        body: {
          name: 'review',
          files: [{ path: 'SKILL.md', data: Buffer.from('skill').toString('base64'), executable: false }],
        },
      })
    )
    expect(report.accounts.map((r) => r.id)).toEqual([...selection.apiKeyIds, ...selection.copyIds])
    expect(JSON.stringify(report)).not.toContain('secret')
  })
  it('fails oversized skills locally and does not dispatch them', async () => {
    mocks.package.mockRejectedValueOnce(new Error('too-large'))
    const call = vi.fn()
    const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
      apiKeyIds: [],
      copyIds: [],
      skillNames: ['review'],
      mcpServerIds: [],
    })
    expect(report.skills[0]).toMatchObject({ outcome: 'failed', error: 'too-large' })
    expect(call).not.toHaveBeenCalled()
  })
  it('validates mutation input before dispatch', () => {
    const mutations = new Map<string, (...args: unknown[]) => unknown>()
    const call = vi.fn()
    registerFleetProvisioningIpc(
      {
        handle: vi.fn(),
        mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
      } as unknown as IpcRegistrar,
      { call } as unknown as FleetClientService
    )
    expect(() => mutations.get('fleet:bot:subscription-remove')?.({}, 'bot', 'bogus', 'default')).toThrow()
    expect(() => mutations.get('fleet:bot:subscription-remove')?.({}, 'bot', 'codex', '../x')).toThrow()
    expect(() => mutations.get('fleet:provisioning:import')?.({}, 'bot', { ...selection, apiKeyIds: 'p1' })).toThrow()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('Mac import error privacy', () => {
  it.each(['arg-token-12345678', 'header-token-12345678', 'query-token-12345678', 'env-token-12345678'])(
    'hides partial echoes of %s',
    async (echo) => {
      mocks.mcp.mockReturnValueOnce([
        {
          id: 'm1',
          name: 'Tools',
          transport: 'http',
          enabled: true,
          url: 'https://example.test/?key=query-token-12345678',
          headers: { Authorization: 'Bearer header-token-12345678' },
          args: ['--token=arg-token-12345678'],
          env: { TOKEN: 'env-token-12345678' },
        },
      ] as unknown as ReturnType<typeof mocks.mcp>)
      const call = vi.fn(async () => ({
        results: [{ index: 0, target: 'Tools', outcome: 'failed', error: 'Rejected ' + echo }],
      }))
      const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
        apiKeyIds: [],
        copyIds: [],
        skillNames: [],
        mcpServerIds: ['m1'],
      })
      expect(report.mcpServers[0].error).toBe('The bot import failed. Please try again.')
      expect(JSON.stringify(report)).not.toContain(echo)
    }
  )
  it.each([false, true])('hides account echoes for request failure %s', async (wholeRequest) => {
    const call = vi.fn(async () => {
      if (wholeRequest) throw new Error('Rejected synthetic-api-secret')
      return { results: [{ index: 0, target: 'account', outcome: 'failed', error: 'Rejected synthetic-api' }] }
    })
    const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
      apiKeyIds: ['p1'],
      copyIds: [],
      skillNames: [],
      mcpServerIds: [],
    })
    expect(report.accounts[0].error).toBe('The bot import failed. Please try again.')
    expect(JSON.stringify(report)).not.toContain('synthetic-api')
  })
  it('preserves harmless remote errors', async () => {
    const error = 'GitHub Copilot did not accept this token.'
    const call = vi.fn(async () => ({ results: [{ index: 0, target: 'account', outcome: 'failed', error }] }))
    const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
      apiKeyIds: [],
      copyIds: ['github-copilot:default'],
      skillNames: [],
      mcpServerIds: [],
    })
    expect(report.accounts[0].error).toBe(error)
  })
})

describe('unreadable Mac skills', () => {
  it('keeps accounts and MCP available when a nested skill directory cannot be read', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-unreadable-'))
    const nested = path.join(dir, 'nested')
    await fsp.writeFile(path.join(dir, 'SKILL.md'), 'skill')
    await fsp.mkdir(nested)
    await fsp.chmod(nested, 0)
    mocks.skillDir = dir
    try {
      const inventory = await buildMacInventory()
      expect(inventory.skills[0]).toMatchObject({ name: 'review', problem: 'unreadable' })
      expect(inventory.apiKeys).toHaveLength(1)
      expect(inventory.mcpServers).toHaveLength(1)
    } finally {
      mocks.skillDir = '/synthetic/review'
      await fsp.chmod(nested, 0o700)
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
  it('fails only the unreadable skill during import', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-unreadable-'))
    const nested = path.join(dir, 'nested')
    await fsp.writeFile(path.join(dir, 'SKILL.md'), 'skill')
    await fsp.mkdir(nested)
    await fsp.chmod(nested, 0)
    mocks.skillDir = dir
    mocks.package.mockImplementationOnce(async () => {
      const actual = await vi.importActual<typeof import('../../src/main/chat/skill-package')>(
        '../../src/main/chat/skill-package'
      )
      return actual.packageSkillDirectory(dir)
    })
    try {
      const call = vi.fn(async (_key: string) => ({
        results: [{ index: 0, target: 'Tools', outcome: 'added', error: null }],
      }))
      const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
        apiKeyIds: [],
        copyIds: [],
        skillNames: ['review'],
        mcpServerIds: ['m1'],
      })
      expect(report.skills[0].outcome).toBe('failed')
      expect(report.skills[0].error).toContain('EACCES')
      expect(report.mcpServers[0].outcome).toBe('added')
      expect(call).toHaveBeenCalledOnce()
      expect(call.mock.calls[0][0]).toBe('botMcpServersImport')
    } finally {
      mocks.skillDir = '/synthetic/review'
      await fsp.chmod(nested, 0o700)
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('large Mac imports', () => {
  it.each(['accounts', 'mcpServers'] as const)(
    'batches 60 %s and maps batch-local indexes to selection ids',
    async (group) => {
      const providers = mocks.providers.slice()
      const ids = Array.from({ length: 60 }, (_, index) => 'item-' + index)
      if (group === 'accounts')
        mocks.providers.splice(
          0,
          mocks.providers.length,
          ...ids.map((id) => ({ id, name: id, kind: 'openai', baseURL: 'https://example.test/v1' }))
        )
      else
        mocks.mcp.mockReturnValueOnce(
          ids.map((id) => ({
            id,
            name: id,
            transport: 'stdio',
            enabled: true,
            command: 'npx',
            env: { TOKEN: 'synthetic-mcp-secret' },
          }))
        )
      const batches: number[] = []
      const call = vi.fn(
        async (_key: string, request: { body: { items?: { name: string }[]; servers?: { name: string }[] } }) => {
          const entries = request.body.items ?? request.body.servers!
          batches.push(entries.length)
          return {
            results: entries
              .map((entry, index) => ({
                index,
                target: entry.name,
                outcome: Number(entry.name.slice(5)) % 2 ? 'updated' : 'added',
                error: null,
              }))
              .reverse(),
          }
        }
      )
      try {
        const report = await importFromMac({ call } as unknown as FleetClientService, 'bot', {
          apiKeyIds: group === 'accounts' ? ids : [],
          copyIds: [],
          skillNames: [],
          mcpServerIds: group === 'mcpServers' ? ids : [],
        })
        expect(batches).toEqual([50, 10])
        expect(report[group]).toEqual(
          ids.map((id, index) => ({ id, name: id, outcome: index % 2 ? 'updated' : 'added', error: null }))
        )
      } finally {
        mocks.providers.splice(0, mocks.providers.length, ...providers)
      }
    }
  )
})
