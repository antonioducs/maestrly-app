import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLEET_ENVIRONMENT_PLUGINS_FEATURE,
  FLEET_PLUGIN_SETTINGS_OPERATIONS,
  FLEET_SETTINGS_OPERATIONS,
  type FleetSettingsOperation,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import { effectiveSkills } from '../../src/main/chat/skill-state'
import { pluginBringPayload } from '../../src/main/fleet/client/environment-plugins'
import { registerFleetEnvironmentSettingsIpc } from '../../src/main/fleet/client/environment-settings-ipc'
import { addMcpServer } from '../../src/main/chat/mcp'
import { createPluginSettingsService } from '../../src/main/fleet/instance/settings/plugins'
import { createSkillSettingsService } from '../../src/main/fleet/instance/settings/skills'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { pluginLayout } from '../../src/main/plugins/layout'
import * as engine from '../../src/main/plugins/service'
import { listInstalled, writeInstalled } from '../../src/main/plugins/store'
import { closeDb, freshDb } from '../helpers/db'
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

/** A synthetic Codex marketplace with one plugin: a skill, and an HTTP server that takes a token setting. */
/** A PNG signature followed by one marker byte: enough for the logo's magic-byte check, and different per version. */
const logo = (marker: number) => ({ content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]) })
const market = (skillText: string, url = 'https://mcp.example.test/mcp', logoMarker = 1): FixtureFiles => ({
  '.agents/plugins/marketplace.json': JSON.stringify({
    name: 'fixture-market',
    plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' } }],
  }),
  'plugins/demo/.codex-plugin/plugin.json': JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    license: 'MIT',
    interface: { logo: './assets/logo.png' },
  }),
  'plugins/demo/assets/logo.png': logo(logoMarker),
  'plugins/demo/skills/hello/SKILL.md': `---\ndescription: Say hello\n---\n${skillText}`,
  'plugins/demo/.mcp.json': JSON.stringify({
    mcpServers: { remote: { url, bearer_token_env_var: 'DEMO_TOKEN' } },
  }),
})

/** Parses an instance answer the way the gateway and this computer do: strictly, with the protocol schema. */
const strict = <K extends FleetSettingsOperation>(operation: K, value: unknown): FleetSettingsOutput<K> =>
  FLEET_SETTINGS_OPERATIONS[operation].response.parse(value) as FleetSettingsOutput<K>

let repo: { dir: string; commit: string }
let home: string
let pluginSettingsService: ReturnType<typeof createPluginSettingsService>
beforeEach(async () => {
  freshDb()
  home = mkdtempSync(path.join(os.tmpdir(), 'env-plugins-home-'))
  pluginSettingsService = createPluginSettingsService(home)
  setAppPluginLayoutForTests(pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'env-plugins-'))))
  repo = await makeGitRepo(market('Hello v1.'), { name: 'market' })
  vi.stubEnv('AGENTS_E2E', '1')
  vi.stubEnv('MAESTRLY_E2E_PLUGIN_GIT_ROOT', path.dirname(repo.dir))
  engine.setPluginGitSourceForTests(null)
  engine.resetPluginServiceCachesForTests()
})
afterEach(() => {
  vi.unstubAllEnvs()
  engine.setPluginGitSourceForTests(null)
  setAppPluginLayoutForTests(null)
  closeDb()
})

describe("a bot environment's plugins, served by its own engine", () => {
  it('answers every operation in the protocol’s strict shape', async () => {
    const url = pathToFileURL(repo.dir).href
    const added = strict('addPluginSource', await pluginSettingsService.addPluginSource({ url }))
    if (!added.ok) throw new Error(added.error)
    const marketplaceId = added.value.id
    const catalog = strict('pluginCatalog', await pluginSettingsService.pluginCatalog({ marketplaceId }))
    expect(catalog.ok && catalog.value.map((entry) => entry.name)).toEqual(['demo'])
    const inspected = strict(
      'pluginInspect',
      await pluginSettingsService.pluginInspect({ marketplaceId, name: 'demo' })
    )
    if (!inspected.ok) throw new Error(inspected.error)
    expect(strict('pluginLogo', await pluginSettingsService.pluginLogo({ marketplaceId, name: 'demo' }))).toEqual({
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    })

    const installed = strict(
      'installPlugin',
      await pluginSettingsService.installPlugin({
        marketplaceId,
        name: 'demo',
        consent: {
          consentFingerprint: inspected.value.consentFingerprint,
          stdio: [],
          executables: false,
          hooks: false,
        },
        scope: { kind: 'global' },
        inputs: { [inspected.value.inputs[0].id]: 'synthetic-token' },
      })
    )
    if (!installed.ok) throw new Error(installed.error)
    const state = strict('plugins', await pluginSettingsService.plugins({}))
    expect(state.installed.map((plugin) => plugin.key)).toEqual([installed.value.key])
    expect(JSON.stringify(state)).not.toContain('synthetic-token')

    const key = installed.value.key
    // Its skill is listed with the plugin, switched like any skill, and can join a skill group.
    const listed = strict('pluginSkills', await pluginSettingsService.pluginSkills({}))
    expect(listed.skills).toEqual([
      expect.objectContaining({
        name: 'demo:hello',
        kind: 'skill',
        plugin: { key, displayName: 'demo' },
        enabled: true,
      }),
    ])
    expect(
      strict(
        'setPluginSkillEnabled',
        await pluginSettingsService.setPluginSkillEnabled({ name: 'demo:hello', enabled: false })
      )
    ).toEqual({ ok: true })
    expect(strict('pluginSkills', await pluginSettingsService.pluginSkills({})).skills[0].enabled).toBe(false)
    expect(
      strict(
        'setPluginSkillEnabled',
        await pluginSettingsService.setPluginSkillEnabled({ name: 'demo:other', enabled: false })
      )
    ).toEqual({ ok: false, error: 'unknown-plugin' })
    const skillSettings = createSkillSettingsService(home)
    const groupInput = FLEET_SETTINGS_OPERATIONS.createSkillGroup.input.parse({
      expectedRevision: (await skillSettings.skillGroups({})).revision,
      name: 'Release',
      skills: ['demo:hello'],
    })
    const grouped = strict('createSkillGroup', await skillSettings.createSkillGroup(groupInput))
    expect(grouped.groups.find((group) => group.name === 'Release')?.skills).toEqual(['demo:hello'])
    expect(strict('patchPlugin', await pluginSettingsService.patchPlugin({ key, enabled: false }))).toEqual({
      ok: true,
    })
    expect(listInstalled()[key].enabled).toBe(false)
    expect(
      strict(
        'patchPlugin',
        await pluginSettingsService.patchPlugin({ key, inputs: { [inspected.value.inputs[0].id]: null } })
      )
    ).toEqual({ ok: true })
    expect(strict('mcpOAuthStatuses', await pluginSettingsService.mcpOAuthStatuses({}))).toEqual({ servers: [] })
    expect(strict('uninstallPlugin', await pluginSettingsService.uninstallPlugin({ key, deleteData: true }))).toEqual({
      ok: true,
    })
    expect(
      strict('removePluginSource', await pluginSettingsService.removePluginSource({ marketplaceId, uninstall: false }))
    ).toEqual({ ok: true })
  })

  it('keeps several sign-in accounts and an own client per server, and never answers with a secret', async () => {
    const server = addMcpServer({ name: 'Mail', transport: 'http', url: 'https://mail.example.test/mcp' })
    const bundle = (token: string, email: string) => ({
      url: 'https://mail.example.test/mcp',
      redirectUri: 'http://127.0.0.1:4567/callback',
      clientInformation: { client_id: 'own', client_secret: 'synthetic-secret' },
      tokens: { access_token: token, token_type: 'Bearer' },
      email,
    })
    const first = strict(
      'setMcpOAuth',
      await pluginSettingsService.setMcpOAuth({ id: server.id, bundle: bundle('a', 'alice@example.test'), target: {} })
    )
    const second = strict(
      'setMcpOAuth',
      await pluginSettingsService.setMcpOAuth({ id: server.id, bundle: bundle('b', 'bob@example.test'), target: {} })
    )
    if (!first.ok || !second.ok) throw new Error('sign-in not stored')
    expect(
      strict(
        'patchMcpOAuthAccount',
        await pluginSettingsService.patchMcpOAuthAccount({ id: server.id, accountId: second.accountId, label: 'Work' })
      )
    ).toEqual({ ok: true })
    expect(
      strict(
        'setMcpOAuthClient',
        await pluginSettingsService.setMcpOAuthClient({
          id: server.id,
          client: { clientId: 'own', clientSecret: 'synthetic-secret' },
        })
      )
    ).toEqual({ ok: true })
    const statuses = strict('mcpOAuthStatuses', await pluginSettingsService.mcpOAuthStatuses({}))
    expect(statuses.servers).toEqual([
      {
        id: server.id,
        needsAuth: false,
        client: { clientId: 'own' },
        accounts: [
          expect.objectContaining({ id: first.accountId, label: 'alice@example.test', scope: { kind: 'global' } }),
          expect.objectContaining({ id: second.accountId, label: 'Work', email: 'bob@example.test' }),
        ],
      },
    ])
    expect(JSON.stringify(statuses)).not.toContain('synthetic-secret')
    // Signing an account in again names it to the provider.
    const descriptor = strict(
      'mcpOAuthDescriptor',
      await pluginSettingsService.mcpOAuthDescriptor({ id: server.id, accountId: first.accountId })
    ).descriptor
    expect(descriptor).toMatchObject({ loginHint: 'alice@example.test', client: { clientId: 'own' } })
    expect(
      strict(
        'removeMcpOAuth',
        await pluginSettingsService.removeMcpOAuth({ id: server.id, accountId: first.accountId })
      )
    ).toEqual({ removed: true })
    expect(
      strict('mcpOAuthStatuses', await pluginSettingsService.mcpOAuthStatuses({})).servers[0].accounts.map(
        (account) => account.label
      )
    ).toEqual(['Work'])
  })

  it('brings a plugin at the exact commit it was approved at, even after its source moved on', async () => {
    const url = pathToFileURL(repo.dir).href
    // The owner's computer approved version 1: its fingerprint travels with the bring.
    const added = await engine.addMarketplace({ url })
    if (!added.ok) throw new Error(added.error)
    const v1 = await engine.inspect({ marketplaceId: added.value.id, name: 'demo' })
    if (!v1.ok) throw new Error(v1.error)
    await engine.removeMarketplace({ id: added.value.id, uninstall: false })
    // Version 2 reaches another endpoint: a change the approval covers.
    const v2 = await commitFiles(repo.dir, market('Hello v2.', 'https://elsewhere.example.test/mcp', 2))

    const consent = { consentFingerprint: v1.value.consentFingerprint, stdio: [], executables: false, hooks: false }
    const brought = strict(
      'bringPlugin',
      await pluginSettingsService.bringPlugin({
        source: { url, ref: null },
        name: 'demo',
        commit: repo.commit,
        consent,
        enabled: false,
        inputs: { [v1.value.inputs[0].id]: 'synthetic-token' },
      })
    )
    if (!brought.ok) throw new Error(`${brought.error} ${brought.detail ?? ''}`)
    expect(brought.value).toMatchObject({ commit: repo.commit, enabled: false, scope: { kind: 'global' } })
    // The source still lists its current version: its logo is version 2's, not the older commit just installed.
    const current = await engine.logo({ marketplaceId: brought.value.marketplaceId, name: 'demo' })
    expect(Buffer.from(current!.split(',')[1], 'base64').at(-1)).toBe(2)
    expect(brought.value.setup.missingInputs).toEqual([])
    engine.resetPluginServiceCachesForTests()
    await engine.setEnabled({ key: brought.value.key, enabled: true })
    const skill = (await effectiveSkills(home, undefined, home)).find((item) => item.name === 'demo:hello')
    expect(skill).toBeDefined()

    // The same approval does not cover another version.
    await engine.uninstall({ key: brought.value.key, deleteData: true })
    const refused = strict(
      'bringPlugin',
      await pluginSettingsService.bringPlugin({
        source: { url, ref: null },
        name: 'demo',
        commit: v2,
        consent,
        enabled: true,
      })
    )
    expect(refused).toMatchObject({ ok: false, error: 'consent-required' })
  })

  it('builds the bring payload on this computer from its own record, values included', async () => {
    const url = pathToFileURL(repo.dir).href
    const added = await engine.addMarketplace({ url })
    if (!added.ok) throw new Error(added.error)
    const inspected = await engine.inspect({ marketplaceId: added.value.id, name: 'demo' })
    if (!inspected.ok) throw new Error(inspected.error)
    const inputId = inspected.value.inputs[0].id
    const installed = await engine.install({
      marketplaceId: added.value.id,
      name: 'demo',
      consent: { consentFingerprint: inspected.value.consentFingerprint, stdio: [], executables: false, hooks: false },
      scope: { kind: 'global' },
      inputs: { [inputId]: 'synthetic-token' },
    })
    if (!installed.ok) throw new Error(installed.error)
    const payload = pluginBringPayload(installed.value.key)
    expect(payload).toEqual({
      ok: true,
      value: {
        source: { url, ref: null },
        name: 'demo',
        commit: repo.commit,
        consent: {
          consentFingerprint: inspected.value.consentFingerprint,
          stdio: [],
          executables: false,
          hooks: false,
        },
        enabled: true,
        inputs: { [inputId]: 'synthetic-token' },
      },
    })
    if (payload.ok) expect(FLEET_SETTINGS_OPERATIONS.bringPlugin.input.parse(payload.value)).toEqual(payload.value)
    expect(pluginBringPayload('missing@market')).toEqual({ ok: false, error: 'unknown-plugin' })
    // A plugin that is not compatible any more is never brought anywhere.
    writeInstalled((all) => {
      all[installed.value.key].blocked = [{ code: 'requires-app-connector' }]
    })
    expect(pluginBringPayload(installed.value.key)).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('environment plugin IPC on this computer', () => {
  function setup(capabilities = ['environment-settings-v1', FLEET_ENVIRONMENT_PLUGINS_FEATURE]) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const mutations = new Set<string>()
    const reg: IpcRegistrar = {
      handle: (key, fn) => {
        handlers.set(key, (...args) => fn({} as never, ...args))
      },
      mhandle: (key, fn) => {
        mutations.add(key)
        handlers.set(key, (...args) => fn({} as never, ...args))
      },
      on: () => {},
      mon: () => {},
    }
    const environment = { id: 'env-1', capabilities }
    const fleet = {
      hasFeature: vi.fn((_feature: string) => true),
      getSnapshot: () => ({ environments: [environment] }),
      call: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    }
    registerFleetEnvironmentSettingsIpc(reg, fleet)
    return { handlers, mutations, fleet }
  }

  it('keeps plugin values and sign-in tokens out of the renderer channels', () => {
    const { handlers, mutations } = setup()
    for (const operation of FLEET_PLUGIN_SETTINGS_OPERATIONS) {
      const channel = `fleet:settings:${operation}`
      // Main-only: plugin values, tokens, and the descriptor that carries the own OAuth client's secret.
      if (operation === 'bringPlugin' || operation === 'setMcpOAuth' || operation === 'mcpOAuthDescriptor')
        expect(handlers.has(channel)).toBe(false)
      else expect(mutations.has(channel)).toBe(FLEET_SETTINGS_OPERATIONS[operation].method !== 'GET')
    }
    expect(mutations.has('fleet:plugins:bring')).toBe(true)
    expect(mutations.has('fleet:mcp-oauth:connect')).toBe(true)
  })

  it('asks for an update before calling an older gateway or environment', async () => {
    const older = setup(['environment-settings-v1'])
    await expect(older.handlers.get('fleet:settings:plugins')!('env-1', {})).rejects.toMatchObject({ code: 'CONFLICT' })
    const gateway = setup()
    gateway.fleet.hasFeature.mockImplementation((feature: string) => feature !== FLEET_ENVIRONMENT_PLUGINS_FEATURE)
    await expect(gateway.handlers.get('fleet:settings:plugins')!('env-1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(older.fleet.call).not.toHaveBeenCalled()
    expect(gateway.fleet.call).not.toHaveBeenCalled()
  })

  it('sends a change with its identifiers in the path and validates the answer', async () => {
    const { handlers, fleet } = setup()
    await expect(
      handlers.get('fleet:settings:patchPlugin')!('env-1', { key: 'demo@market', enabled: false })
    ).resolves.toEqual({
      ok: true,
    })
    expect(fleet.call).toHaveBeenLastCalledWith('settingsPatchPlugin', {
      params: { eid: 'env-1', key: 'demo@market' },
      body: { key: 'demo@market', enabled: false },
    })
    fleet.call.mockResolvedValue({ ok: true, value: 'should-not-cross' })
    await expect(
      handlers.get('fleet:settings:uninstallPlugin')!('env-1', { key: 'demo@market', deleteData: false })
    ).rejects.toThrow()
  })
})
