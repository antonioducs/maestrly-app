import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { FLEET_INSTANCE_ROUTES, type FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import { closeDb, freshDb, restartDb } from '../helpers/db'

// Status reads must never start a runtime or inspect a developer's provider accounts.
const signedOut = vi.hoisted(() => ({
  peekStatus: () => ({ authenticated: false }),
  getStatusSnapshot: () => ({ authenticated: false }),
  getStatus: () => ({ authenticated: false }),
  status: async () => ({ authenticated: false }),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/codex-subscription/manager')>()),
  getCodexSubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/claude-agent-sdk/manager')>()),
  getClaudeSubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/chat/grok-subscription/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/grok-subscription/manager')>()),
  getGrokSubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/chat/github-copilot/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/github-copilot/manager')>()),
  getGitHubCopilotSubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/chat/cursor-subscription/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/cursor-subscription/manager')>()),
  getCursorSubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/chat/antigravity-subscription/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/antigravity-subscription/manager')>()),
  getAntigravitySubscriptionManager: () => signedOut,
}))
vi.mock('../../src/main/runtime-assets/app-service', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime-assets/app-service')>()),
  runtimeAssetProgressInfo: vi.fn(async () => ({ status: { state: 'missing' } })),
}))

import * as chatService from '../../src/main/chat/service'
import { addProvider, getProvider } from '../../src/main/chat/catalog'
import { getApiKey, setApiKey } from '../../src/main/chat/credentials'
import { getDb } from '../../src/main/store/db'
import { listMcpServers } from '../../src/main/chat/mcp'
import { skillInstallRoot } from '../../src/main/chat/skills'
import { EnvironmentRuntime } from '../../src/main/fleet/instance/environment'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { createInstanceControlServer } from '../../src/main/fleet/instance/server'

let dir: string
let home: string
let runtime: EnvironmentRuntime
let server: ReturnType<typeof createInstanceControlServer>
let base: string
let token: string

type RouteKey = keyof typeof FLEET_INSTANCE_ROUTES
async function request(
  key: RouteKey,
  body?: unknown,
  params: Record<string, string> = {},
  credential: string | null = token
) {
  const route = FLEET_INSTANCE_ROUTES[key]
  const routePath = route.path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name]))
  return fetch(base + routePath, {
    method: route.method,
    headers: {
      'X-Maestrly-Fleet-Protocol': '1',
      ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function result<K extends RouteKey>(key: K, body?: unknown, params?: Record<string, string>) {
  const response = await request(key, body, params)
  const data: unknown = await response.json()
  expect(response.status, JSON.stringify(data)).toBe(200)
  const schema = FLEET_INSTANCE_ROUTES[key].response
  if (!schema) throw new Error('Expected a JSON response schema')
  const parsed = schema.parse(data)
  // Zod strips unknown keys: compare the wire payload too, so leaked secrets cannot disappear in parsing.
  expect(parsed).toEqual(data)
  // Preserve the selected route's inferred output at call sites.
  return parsed as ReturnType<NonNullable<(typeof FLEET_INSTANCE_ROUTES)[K]['response']>['parse']>
}

beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-settings-'))
  home = path.join(dir, 'home')
  await mkdir(home, { recursive: true })
  const userData = path.join(dir, 'user-data')
  await mkdir(userData)
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.spyOn(chatService, 'listChatRunnerCapabilities').mockResolvedValue([])
  vi.spyOn(chatService, 'listChatProviderModels').mockResolvedValue([])
  vi.spyOn(chatService, 'effectiveModelMeta').mockResolvedValue({ meta: null })
  vi.spyOn(chatService, 'setConversationCompactionOverride').mockImplementation(() => {})
  vi.spyOn(chatService, 'primeChatTurnSelection').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'publishConvChatSettings').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'backgroundCompactionStatus').mockReturnValue({ revision: 0, status: 'idle' })
  vi.spyOn(chatService, 'stopChatAndWait').mockImplementation(async () => undefined as never)
  token = randomBytes(32).toString('base64url')
  const config = parseBotInstanceConfig({
    MAESTRLY_BOT_MODE: '1',
    MAESTRLY_BOT_CONTROL_TOKEN: token,
    MAESTRLY_BOT_GATEWAY_URL: 'http://gateway.test',
    MAESTRLY_ENVIRONMENT_ID: 'settings-test',
  })!
  runtime = new EnvironmentRuntime({
    config,
    userData,
    home,
    displays: null,
    floatBrowser: vi.fn(),
    closeConversation: vi.fn(),
    purgeConversation: vi.fn(),
    openSettings: vi.fn(),
    holdScreenFocus: () => () => {},
  })
  await runtime.start()
  server = createInstanceControlServer(config, runtime)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await runtime?.dispose()
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

describe('environment settings through the authenticated instance control server', () => {
  it('exposes all three runtimes before any bot is installed', async () => {
    const snapshot = await result('settingsRuntimes')
    expect(runtime.bots()).toEqual([])
    expect(snapshot.runtimes.map(({ id }) => id)).toEqual(['claude-code', 'codex', 'antigravity-acp'])
    for (const item of snapshot.runtimes) {
      expect(item).toMatchObject({ state: 'idle', currentVersion: null, allowedActions: ['check', 'install'] })
    }
  })

  it('persists preferences and their CAS revision across a file database restart', async () => {
    const before = await result('settingsPreferences')
    const saved = await result('settingsSetPreferences', { expectedRevision: before.revision, imageGenEnabled: false })
    expect(saved.imageGenEnabled).toBe(false)
    expect(saved.revision).not.toBe(before.revision)
    restartDb()
    expect(await result('settingsPreferences')).toEqual(saved)
    expect(
      (await request('settingsSetPreferences', { expectedRevision: before.revision, imageGenEnabled: true })).status
    ).toBe(409)
    expect(await result('settingsPreferences')).toEqual(saved)
  })

  it('preserves raw skill frontmatter and references and rejects stale or externally changed documents', async () => {
    const name = 'synthetic-guide'
    const frontmatter = '---\nname: synthetic-guide\ndescription: "Keep this quote"\nmetadata:\n  custom: yes\n---\n'
    const created = await result('settingsCreateSkill', { name, markdown: frontmatter + '\nOriginal body.\n' })
    const folder = path.join(skillInstallRoot('global', '', home), name)
    await mkdir(path.join(folder, 'references'))
    const reference = path.join(folder, 'references', 'details.txt')
    await writeFile(reference, 'Keep this reference byte for byte.\n')
    const markdown = frontmatter + '\nEdited body.\n'
    const saved = await result('settingsWriteSkill', { name, expectedRevision: created.revision, markdown }, { name })
    expect(saved.markdown).toBe(markdown)
    expect(await readFile(path.join(folder, 'SKILL.md'), 'utf8')).toBe(markdown)
    expect(await readFile(reference, 'utf8')).toBe('Keep this reference byte for byte.\n')
    expect(
      (
        await request(
          'settingsWriteSkill',
          { name, expectedRevision: created.revision, markdown: created.markdown },
          { name }
        )
      ).status
    ).toBe(409)
    const external = frontmatter + '\nExternal edit.\n'
    await writeFile(path.join(folder, 'SKILL.md'), external)
    expect(
      (await request('settingsWriteSkill', { name, expectedRevision: saved.revision, markdown }, { name })).status
    ).toBe(409)
    expect((await result('settingsSkill', undefined, { name })).markdown).toBe(external)
    expect(await readFile(reference, 'utf8')).toBe('Keep this reference byte for byte.\n')
    expect(
      (
        await request(
          'settingsWriteSkill',
          { name, expectedRevision: saved.revision, markdown },
          { name: 'another-guide' }
        )
      ).status
    ).toBe(400)
  })

  it('preserves an account and its key when credential deletion cannot be persisted', async () => {
    const provider = addProvider({ name: 'Retained account', baseURL: 'https://example.test/v1' })
    setApiKey(provider.id, 'synthetic-retained-key')
    const before = await result('settingsAccounts')
    getDb().exec(
      "CREATE TRIGGER refuse_credential_removal BEFORE UPDATE ON app_settings WHEN NEW.key LIKE 'chat.apiKey.%' AND NEW.value = '' BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END"
    )
    const response = await request(
      'settingsRemoveAccount',
      { providerId: provider.id, expectedRevision: before.revision },
      { providerId: provider.id }
    )
    expect(response.status).toBe(409)
    expect(getProvider(provider.id)?.name).toBe('Retained account')
    expect(getApiKey(provider.id)).toBe('synthetic-retained-key')
    expect((await result('settingsAccounts')).revision).toBe(before.revision)
  })

  it('redacts MCP connection details and preserves omitted values during patches', async () => {
    const inputs = [
      {
        name: 'Synthetic HTTP',
        transport: 'http',
        enabled: false,
        url: 'https://synthetic-user:synthetic-password@example.test/mcp?key=synthetic-query',
        headers: { Authorization: 'synthetic-header' },
      },
      {
        name: 'Synthetic stdio',
        transport: 'stdio',
        enabled: false,
        command: '/synthetic/private-command',
        args: ['synthetic-argument'],
        env: { TOKEN: 'synthetic-env' },
      },
    ] as const
    for (const input of inputs) {
      const created = await result('settingsCreateMcpServer', input)
      const stored = listMcpServers().find(({ id }) => id === created.id)!
      const read = await result('settingsMcpServer', undefined, { id: created.id })
      const patched = await result(
        'settingsPatchMcpServer',
        { id: created.id, expectedRevision: read.revision, name: input.name + ' renamed' },
        { id: created.id }
      )
      expect(listMcpServers().find(({ id }) => id === created.id)).toEqual({ ...stored, name: input.name + ' renamed' })
      for (const snapshot of [created, read, patched, await result('settingsMcpServers')]) {
        const raw = JSON.stringify(snapshot)
        for (const secret of [
          'synthetic-user',
          'synthetic-password',
          'synthetic-query',
          'synthetic-header',
          '/synthetic/private-command',
          'synthetic-argument',
          'synthetic-env',
        ])
          expect(raw).not.toContain(secret)
      }
      expect(
        (
          await request(
            'settingsPatchMcpServer',
            { id: created.id, expectedRevision: patched.revision, name: 'Denied' },
            { id: 'another-server' }
          )
        ).status
      ).toBe(400)
    }
  })

  it('omits account secrets and restores the previous credential after secure storage fails', async () => {
    const provider = addProvider({ name: 'Synthetic account', baseURL: 'https://example.test/v1' })
    const secret = 'synthetic-original-api-key'
    expect(setApiKey(provider.id, secret)).toBe('secure')
    const before = await result('settingsAccounts')
    expect(JSON.stringify(before)).not.toContain(secret)
    const saved = await result(
      'settingsPatchAccount',
      { providerId: provider.id, expectedRevision: before.revision, name: 'Renamed' },
      { providerId: provider.id }
    )
    expect(getApiKey(provider.id)).toBe(secret)
    vi.spyOn(safeStorage, 'encryptString').mockImplementationOnce(() => {
      throw new Error('Synthetic keyring failure')
    })
    const failed = await request(
      'settingsPatchAccount',
      {
        providerId: provider.id,
        expectedRevision: saved.revision,
        name: 'Must roll back',
        apiKey: 'synthetic-replacement-api-key',
      },
      { providerId: provider.id }
    )
    expect(failed.status).toBe(409)
    expect(JSON.stringify(await failed.json())).not.toContain('synthetic-replacement-api-key')
    expect(getApiKey(provider.id)).toBe(secret)
    expect(getProvider(provider.id)?.name).toBe('Renamed')
    restartDb()
    expect(getApiKey(provider.id)).toBe(secret)
    expect(JSON.stringify(await result('settingsAccounts'))).not.toContain(secret)
  })

  it('rejects missing and unpaired control credentials before returning settings', async () => {
    for (const credential of [null, randomBytes(32).toString('base64url')]) {
      const response = await request('settingsPreferences', undefined, {}, credential)
      expect(response.status).toBe(401)
      expect(await response.json()).not.toHaveProperty('imageGenEnabled')
    }
  })

  it('hides a model from new choices while retaining two bots selection and compaction', async () => {
    const provider = addProvider({ name: 'Synthetic', baseURL: 'https://example.test/v1' })
    setApiKey(provider.id, 'synthetic-model-api-key')
    vi.mocked(chatService.listChatRunnerCapabilities).mockResolvedValue([
      {
        providerId: provider.id,
        providerLabel: provider.name,
        modelId: 'model-a',
        reasoningEfforts: [],
        fastMode: false,
      },
    ])
    vi.mocked(chatService.listChatProviderModels).mockImplementation(async (id) =>
      id === provider.id ? ['model-a'] : []
    )
    const selection = { providerId: provider.id, modelId: 'model-a', reasoning: null, fastMode: false }
    const compaction = { ...selection, intervalTokens: 100_000 }
    for (const [index, botId] of ['alpha', 'beta'].entries()) {
      const profile: FleetInstanceProfile = {
        botId,
        name: botId,
        instructions: 'Synthetic instructions',
        ceiling: 'ask',
        selection,
        compaction,
        gateway: { peersEnabled: false, artifactsEnabled: false, desktopBridgeEnabled: false },
      }
      await runtime.installBot({ profile, slot: index + 1, gatewayToken: `synthetic-token-${botId}` })
    }
    const before = await result('settingsModels')
    const modelProvider = before.providers.find(({ providerId }) => providerId === provider.id)!
    expect(modelProvider.models[0].bots.map(({ id }) => id)).toEqual(['alpha', 'beta'])
    await result(
      'settingsSetModelFilter',
      { providerId: provider.id, expectedRevision: modelProvider.revision, hiddenModelIds: ['model-a'] },
      { providerId: provider.id }
    )
    expect((await result('environmentSelections')).options).toEqual([])
    for (const botId of ['alpha', 'beta']) {
      const status = await result('botStatus', undefined, { botId })
      expect(status.selection).toEqual(selection)
      expect(runtime.bot(botId).settingsUsage().compaction).toEqual(compaction)
      expect(status.compaction).toMatchObject({ configured: true, problem: null })
      const choices = await result('botSelections', undefined, { botId })
      expect(choices.current).toEqual(selection)
    }
    const after = await result('settingsModels')
    expect(
      after.providers.find(({ providerId }) => providerId === provider.id)?.models[0].bots.map(({ id }) => id)
    ).toEqual(['alpha', 'beta'])
  })
})
