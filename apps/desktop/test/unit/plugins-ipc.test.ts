import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveSkills } from '../../src/main/chat/skill-state'
import { listRuntimeMcpServers } from '../../src/main/chat/mcp'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { PLUGIN_MUTATION_CHANNELS, PLUGIN_READ_CHANNELS, registerPluginIpc } from '../../src/main/plugins/ipc'
import { pluginLayout } from '../../src/main/plugins/layout'
import { resetPluginServiceCachesForTests, setPluginGitSourceForTests } from '../../src/main/plugins/service'
import { listInstalled, onInstalledChanged } from '../../src/main/plugins/store'
import { remoteChannelRefusal } from '../../src/shared/host-channels'
import type {
  InstalledPluginDto,
  PluginCatalogEntryDto,
  PluginInspectionDto,
  PluginMarketplaceDto,
  PluginOpResult,
  PluginsStateDto,
} from '../../src/shared/plugins'
import { closeDb, freshDb } from '../helpers/db'
import { makeStandaloneConversation } from '../helpers/factories'
import { commitFiles, type FixtureFiles, makeGitRepo } from '../helpers/plugin-fixtures'

vi.mock('../../src/main/secure-store', () => {
  const values = new Map<string, string>()
  return {
    isSecureStorageAvailable: () => true,
    secureGet: (key: string) => values.get(key) ?? null,
    secureSet: (key: string, value: string) => {
      values.set(key, value)
      return true
    },
    secureRemove: (key: string) => values.delete(key),
  }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, { kind: 'read' | 'mutation'; fn: Handler }>()
const reg: IpcRegistrar = {
  handle: (channel, fn) => handlers.set(channel, { kind: 'read', fn: fn as Handler }),
  mhandle: (channel, fn) => handlers.set(channel, { kind: 'mutation', fn: fn as Handler }),
  on: () => {},
  mon: () => {},
}
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve(handlers.get(channel)!.fn({}, ...args) as T)

const marketplaceFiles = (skillText = 'Hello.'): FixtureFiles => ({
  '.agents/plugins/marketplace.json': JSON.stringify({
    name: 'fixture-market',
    interface: { displayName: 'Fixture market' },
    plugins: [
      { name: 'demo', source: { source: 'local', path: './plugins/demo' }, category: 'Coding' },
      { name: 'connector', source: { source: 'local', path: './plugins/connector' } },
      { name: 'npmish', source: { source: 'npm', package: '@x/y' } },
    ],
  }),
  'plugins/demo/.codex-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', license: 'MIT' }),
  'plugins/demo/LICENSE': 'MIT License (synthetic fixture)\n',
  'plugins/demo/skills/hello/SKILL.md': `---\ndescription: Say hello\n---\n${skillText}`,
  'plugins/demo/commands/review.md': '---\ndescription: Review a file\n---\nReview $ARGUMENTS',
  'plugins/demo/.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'node', args: ['./mcp/server.mjs'] } } }),
  'plugins/demo/mcp/server.mjs': 'process.exit(0)\n',
  'plugins/connector/.codex-plugin/plugin.json': JSON.stringify({ name: 'connector' }),
  'plugins/connector/.app.json': JSON.stringify({ apps: { c: { id: 'connector_fixture' } } }),
})

let repo: { dir: string; commit: string }

beforeEach(async () => {
  freshDb()
  handlers.clear()
  registerPluginIpc(reg)
  setAppPluginLayoutForTests(pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-ipc-layout-'))))
  repo = await makeGitRepo(marketplaceFiles(), { name: 'market' })
  process.env.MAESTRLY_E2E_PLUGIN_GIT_ROOT = path.dirname(repo.dir)
  setPluginGitSourceForTests(null)
  resetPluginServiceCachesForTests()
})
afterEach(() => {
  delete process.env.MAESTRLY_E2E_PLUGIN_GIT_ROOT
  setPluginGitSourceForTests(null)
  setAppPluginLayoutForTests(null)
  closeDb()
})

describe('plugin IPC', () => {
  it('registers reads and mutations that a remote host serves for its own plugins', () => {
    for (const channel of PLUGIN_READ_CHANNELS) expect(handlers.get(channel)?.kind).toBe('read')
    for (const channel of PLUGIN_MUTATION_CHANNELS) expect(handlers.get(channel)?.kind).toBe('mutation')
    for (const channel of [...PLUGIN_READ_CHANNELS, ...PLUGIN_MUTATION_CHANNELS])
      expect(remoteChannelRefusal(channel)).toBeNull()
  })

  it('rejects malformed input before reaching the service', async () => {
    const consent = { consentFingerprint: 'a'.repeat(64), stdio: [], executables: false }
    expect(
      await call('chat:plugins:install', {
        marketplaceId: 'mkt_0123456789abcdef',
        name: 'demo',
        consent,
        scope: { kind: 'global' },
        extra: true,
      })
    ).toEqual({ ok: false, error: 'invalid-input' })
    expect(await call('chat:plugins:set-scope', { key: 'Bad Key', scope: { kind: 'global' } })).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(
      await call('chat:plugins:set-scope', { key: 'demo@m', scope: { kind: 'projects', workspaceIds: ['../x'] } })
    ).toEqual({ ok: false, error: 'invalid-input' })
    expect(
      await call('chat:plugins:marketplace-add', { url: 'https://example.com/r.git', sparsePaths: ['../escape'] })
    ).toEqual({ ok: false, error: 'invalid-input' })
    expect(await call('chat:plugins:logo', { marketplaceId: 'nope', name: 'demo' })).toBeNull()
    expect(await call('chat:plugins:marketplace-add', { url: 'http://example.com/r.git' })).toEqual({
      ok: false,
      error: 'invalid-url',
    })
  })

  it('adds a source, lists, inspects, installs, updates and uninstalls a plugin', async () => {
    const added = await call<PluginOpResult<PluginMarketplaceDto>>('chat:plugins:marketplace-add', {
      url: pathToFileURL(repo.dir).href,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.value).toMatchObject({
      name: 'fixture-market',
      displayName: 'Fixture market',
      commit: repo.commit,
      pluginCount: 3,
    })
    const marketplaceId = added.value.id

    const catalog = await call<PluginOpResult<PluginCatalogEntryDto[]>>('chat:plugins:catalog', marketplaceId)
    if (!catalog.ok) throw new Error(catalog.error)
    const byName = Object.fromEntries(catalog.value.map((entry) => [entry.name, entry]))
    expect(byName.demo.compatibility?.level).toBe('portable')
    expect(byName.demo.category).toBe('Coding')
    expect(byName.connector.compatibility).toMatchObject({ level: 'unavailable' })
    expect(byName.connector.compatibility?.reasons.map((r) => r.code)).toContain('app-connector')
    expect(byName.npmish.compatibility?.reasons[0].code).toBe('source-unsupported')

    const inspection = await call<PluginOpResult<PluginInspectionDto>>('chat:plugins:inspect', {
      marketplaceId,
      name: 'demo',
    })
    if (!inspection.ok) throw new Error(inspection.error)
    expect(inspection.value).toMatchObject({
      license: { spdx: 'MIT', text: expect.stringContaining('MIT License') },
      source: { url: pathToFileURL(repo.dir).href, path: 'plugins/demo', commit: repo.commit },
    })
    expect(inspection.value.mcpServers).toEqual([
      expect.objectContaining({ key: 'local', transport: 'stdio', launch: 'node ./mcp/server.mjs' }),
    ])

    const installed = await call<PluginOpResult<InstalledPluginDto>>('chat:plugins:install', {
      marketplaceId,
      name: 'demo',
      consent: { consentFingerprint: inspection.value.consentFingerprint, stdio: ['local'], executables: false },
      scope: { kind: 'global' },
    })
    if (!installed.ok) throw new Error(`${installed.error} ${installed.detail ?? ''}`)
    expect(installed.value).toMatchObject({ key: 'demo@fixture-market', enabled: true, commit: repo.commit })
    const conversation = makeStandaloneConversation()
    expect((await effectiveSkills('', conversation.id)).map((s) => s.name)).toEqual(
      expect.arrayContaining(['demo:hello', 'demo:review'])
    )
    expect(listRuntimeMcpServers({ conversationId: conversation.id })).toEqual([
      expect.objectContaining({ name: 'demo-local', enabled: true }),
    ])

    // A new commit upstream becomes an update after a refresh.
    const second = await commitFiles(repo.dir, marketplaceFiles('Hello, again.'))
    expect(
      (await call<PluginOpResult<PluginMarketplaceDto>>('chat:plugins:marketplace-refresh', marketplaceId)).ok
    ).toBe(true)
    const state = await call<PluginsStateDto>('chat:plugins:state')
    expect(state.git.available).toBe(true)
    expect(state.installed[0]).toMatchObject({ key: 'demo@fixture-market', updateAvailable: true })
    const updated = await call<PluginOpResult<InstalledPluginDto>>('chat:plugins:update', {
      key: 'demo@fixture-market',
    })
    if (!updated.ok) throw new Error(updated.error)
    expect(updated.value).toMatchObject({ commit: second, updateAvailable: false })
    const skill = (await effectiveSkills('', conversation.id)).find((s) => s.name === 'demo:hello')
    expect(skill?.body).toBe('Hello, again.')

    // Settings of the installed plugin.
    expect(await call('chat:plugins:set-enabled', { key: 'demo@fixture-market', enabled: false })).toEqual({
      ok: true,
      value: undefined,
    })
    expect((await effectiveSkills('', conversation.id)).map((s) => s.name)).not.toContain('demo:hello')
    await call('chat:plugins:set-enabled', { key: 'demo@fixture-market', enabled: true })
    expect(
      await call('chat:plugins:set-server', { key: 'demo@fixture-market', serverKey: 'local', enabled: false })
    ).toEqual({ ok: true, value: undefined })
    expect(listRuntimeMcpServers({ conversationId: conversation.id })[0].enabled).toBe(false)
    expect(
      await call('chat:plugins:set-inputs', { key: 'demo@fixture-market', values: { unknown: 'x' } })
    ).toMatchObject({
      ok: false,
      error: 'invalid-input',
    })

    // Removing the source needs the plugins gone.
    expect(await call('chat:plugins:marketplace-remove', { id: marketplaceId, uninstall: false })).toMatchObject({
      ok: false,
      error: 'busy',
    })
    expect(await call('chat:plugins:uninstall', { key: 'demo@fixture-market', deleteData: true })).toEqual({
      ok: true,
      value: undefined,
    })
    expect((await effectiveSkills('', conversation.id)).map((s) => s.name)).not.toContain('demo:hello')
    expect(listRuntimeMcpServers({ conversationId: conversation.id })).toEqual([])
    expect(
      (await call<PluginOpResult>('chat:plugins:marketplace-remove', { id: marketplaceId, uninstall: false })).ok
    ).toBe(true)
  })

  it('refuses an install whose consent no longer matches the source', async () => {
    const added = await call<PluginOpResult<PluginMarketplaceDto>>('chat:plugins:marketplace-add', {
      url: pathToFileURL(repo.dir).href,
    })
    if (!added.ok) throw new Error(added.error)
    const result = await call<PluginOpResult>('chat:plugins:install', {
      marketplaceId: added.value.id,
      name: 'demo',
      consent: { consentFingerprint: 'b'.repeat(64), stdio: ['local'], executables: false },
      scope: { kind: 'global' },
    })
    expect(result).toMatchObject({ ok: false, error: 'consent-required' })
  })

  it('runs concurrent installs one at a time', async () => {
    const added = await call<PluginOpResult<PluginMarketplaceDto>>('chat:plugins:marketplace-add', {
      url: pathToFileURL(repo.dir).href,
    })
    if (!added.ok) throw new Error(added.error)
    const inspection = await call<PluginOpResult<PluginInspectionDto>>('chat:plugins:inspect', {
      marketplaceId: added.value.id,
      name: 'demo',
    })
    if (!inspection.ok) throw new Error(inspection.error)
    let maxInstalling = 0
    const stop = onInstalledChanged(() => {
      const installing = Object.values(listInstalled()).filter((r) => r.status === 'installing').length
      maxInstalling = Math.max(maxInstalling, installing)
    })
    const request = {
      marketplaceId: added.value.id,
      name: 'demo',
      consent: { consentFingerprint: inspection.value.consentFingerprint, stdio: [], executables: false },
      scope: { kind: 'global' },
    }
    const results = await Promise.all([
      call<PluginOpResult>('chat:plugins:install', request),
      call<PluginOpResult>('chat:plugins:install', request),
    ])
    stop()
    expect(maxInstalling).toBe(1)
    expect(results.map((r) => (r.ok ? 'ok' : r.error)).sort()).toEqual(['already-installed', 'ok'])
  })
})
