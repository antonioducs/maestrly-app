import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
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
  listSkills: async () => [{ name: 'review', description: 'Review', dir: '/synthetic/review', scope: 'global' }],
}))
vi.mock('../../src/main/chat/skill-package', () => ({
  packageSkillDirectory: mocks.package,
  measureSkillDirectory: async () => ({ files: 1, bytes: 5, scripts: false, problem: null }),
}))
vi.mock('../../src/main/chat/mcp', () => ({
  listMcpServers: () => [
    {
      id: 'm1',
      name: 'Tools',
      transport: 'stdio',
      enabled: true,
      command: '/opt/homebrew/bin/npx',
      env: { TOKEN: 'synthetic-mcp-secret' },
    },
  ],
}))
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
