import { describe, expect, it } from 'vitest'
import {
  FLEET_ENVIRONMENT_PLUGINS_FEATURE,
  FLEET_PLUGIN_SETTINGS_OPERATIONS,
  FLEET_SETTINGS_OPERATIONS,
  fleetInstalledPluginSchema,
  fleetMcpOAuthBundleSchema,
  fleetPluginSettingsTimeoutMs,
  fleetSettingsRouteKey,
  isFleetPluginSettingsOperation,
} from '../src/index.js'

const consent = { consentFingerprint: 'a'.repeat(64), stdio: ['local'], executables: false }
const bring = {
  source: { url: 'https://github.com/example/plugins.git', ref: 'main' },
  name: 'release-notes',
  commit: 'b'.repeat(40),
  consent,
  enabled: true,
}

describe('environment plugins contract', () => {
  it('names one feature and routes every plugin operation through the settings tables', () => {
    expect(FLEET_ENVIRONMENT_PLUGINS_FEATURE).toBe('environment-plugins-v1')
    expect(FLEET_ENVIRONMENT_PLUGINS_FEATURE.length).toBeLessThanOrEqual(40)
    for (const operation of FLEET_PLUGIN_SETTINGS_OPERATIONS) {
      expect(FLEET_SETTINGS_OPERATIONS[operation]).toBeDefined()
      expect(isFleetPluginSettingsOperation(operation)).toBe(true)
    }
    expect(isFleetPluginSettingsOperation('skills')).toBe(false)
    expect(fleetSettingsRouteKey('installPlugin')).toBe('settingsInstallPlugin')
    expect(fleetPluginSettingsTimeoutMs('installPlugin')).toBeGreaterThan(fleetPluginSettingsTimeoutMs('plugins'))
  })

  it('changes one thing at a time on an installed plugin', () => {
    const patch = FLEET_SETTINGS_OPERATIONS.patchPlugin.input
    expect(patch.safeParse({ key: 'demo@market', enabled: false }).success).toBe(true)
    expect(patch.safeParse({ key: 'demo@market', inputs: { 'env:local:TOKEN': null } }).success).toBe(true)
    expect(patch.safeParse({ key: 'demo@market' }).success).toBe(false)
    expect(patch.safeParse({ key: 'demo@market', enabled: true, scope: { kind: 'global' } }).success).toBe(false)
    expect(patch.safeParse({ key: '../demo', enabled: true }).success).toBe(false)
  })

  it('brings a plugin at an exact commit and refuses anything else', () => {
    const input = FLEET_SETTINGS_OPERATIONS.bringPlugin.input
    expect(input.safeParse(bring).success).toBe(true)
    expect(input.safeParse({ ...bring, commit: 'main' }).success).toBe(false)
    expect(input.safeParse({ ...bring, scope: { kind: 'global' } }).success).toBe(false)
    expect(input.safeParse({ ...bring, source: { ...bring.source, sparsePaths: ['plugins/../..'] } }).success).toBe(
      false
    )
    expect(input.safeParse({ ...bring, source: { ...bring.source, sparsePaths: ['/etc'] } }).success).toBe(false)
  })

  it('answers with the plugin center results, and only known errors', () => {
    const removed = FLEET_SETTINGS_OPERATIONS.uninstallPlugin.response
    expect(removed.safeParse({ ok: true }).success).toBe(true)
    expect(removed.safeParse({ ok: false, error: 'busy' }).success).toBe(true)
    expect(removed.safeParse({ ok: false, error: 'exec-anything' }).success).toBe(false)
    expect(removed.safeParse({ ok: true, value: 'extra' }).success).toBe(false)
    const logo = FLEET_SETTINGS_OPERATIONS.pluginLogo.response
    expect(logo.safeParse({ dataUrl: 'data:image/png;base64,AAAA' }).success).toBe(true)
    expect(logo.safeParse({ dataUrl: 'data:image/svg+xml;base64,AAAA' }).success).toBe(false)
  })

  it('names plugin skills by their plugin, and lets skill groups hold them', () => {
    const toggle = FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.input
    expect(toggle.safeParse({ name: 'release-notes:draft', enabled: false }).success).toBe(true)
    for (const name of ['draft', 'release-notes:', ':draft', 'Release:Draft', 'a:b:c', '../x:y'])
      expect(toggle.safeParse({ name, enabled: false }).success).toBe(false)
    const revision = '550e8400-e29b-41d4-a716-446655440000'
    const group = FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input
    expect(
      group.safeParse({
        id: 'g',
        expectedRevision: revision,
        name: 'Docs',
        skills: ['local-skill', 'release-notes:draft'],
      }).success
    ).toBe(true)
    expect(group.safeParse({ id: 'g', expectedRevision: revision, name: 'Docs', skills: ['a:b:c'] }).success).toBe(
      false
    )
    const listed = FLEET_SETTINGS_OPERATIONS.pluginSkills.response
    const skill = {
      name: 'release-notes:draft',
      description: 'Draft release notes',
      kind: 'skill',
      plugin: { key: 'release-notes@e2e-market', displayName: 'Release notes' },
      enabled: true,
      modelInvocable: true,
      userInvocable: true,
      resources: { scripts: 0, references: 0, assets: 0 },
    }
    expect(listed.safeParse({ skills: [skill] }).success).toBe(true)
    expect(listed.safeParse({ skills: [{ ...skill, dir: '/home/bot/.agents' }] }).success).toBe(false)
  })

  it('lists a group holding the longest plugin skill name the engine produces', () => {
    const longest = `${'p'.repeat(64)}:${'s'.repeat(64)}`
    expect(
      FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.input.safeParse({ name: longest, enabled: true }).success
    ).toBe(true)
    expect(
      FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.input.safeParse({ name: `${longest}s`, enabled: true }).success
    ).toBe(false)
    const groups = FLEET_SETTINGS_OPERATIONS.skillGroups.response
    const group = { id: 'g', name: 'Docs', skills: ['local-skill', longest] }
    expect(groups.safeParse({ revision: '550e8400-e29b-41d4-a716-446655440000', groups: [group] }).success).toBe(true)
  })

  it('takes a sign-in only with a loopback redirect, and never returns tokens', () => {
    const bundle = {
      url: 'https://mcp.example.test/mcp',
      redirectUri: 'http://127.0.0.1:4567/callback',
      clientInformation: { client_id: 'c' },
      tokens: { access_token: 'a', token_type: 'Bearer' },
    }
    expect(fleetMcpOAuthBundleSchema.safeParse(bundle).success).toBe(true)
    expect(
      fleetMcpOAuthBundleSchema.safeParse({ ...bundle, redirectUri: 'https://evil.example/callback' }).success
    ).toBe(false)
    const server = { id: 'plg_' + '0'.repeat(20), needsAuth: false, accounts: [], client: null }
    expect(FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response.safeParse({ servers: [server] }).success).toBe(true)
    expect(
      FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response.safeParse({
        servers: [{ ...server, tokens: bundle.tokens }],
      }).success
    ).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response.safeParse({
        servers: [{ ...server, client: { clientId: 'own', clientSecret: 'synthetic' } }],
      }).success
    ).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.response.safeParse({
        descriptor: { serverId: 'plg_' + '0'.repeat(20), name: 'x', url: bundle.url, headers: { Authorization: 'x' } },
      }).success
    ).toBe(false)
  })

  it('has two compatibility levels and the app-connector blocking reason', () => {
    const level = fleetInstalledPluginSchema.shape.compatibility
    expect(level.safeParse({ level: 'partial', reasons: [] }).success).toBe(false)
    expect(level.safeParse({ level: 'unavailable', reasons: [{ code: 'requires-app-connector' }] }).success).toBe(true)
    expect(level.safeParse({ level: 'portable', reasons: [{ code: 'app-connector', subject: 'x' }] }).success).toBe(
      true
    )
  })

  it('keeps several accounts per server and an own client, whose secret goes only one way', () => {
    const id = 'plg_' + '0'.repeat(20)
    const accountId = 'acc_0123456789ab'
    const ops = FLEET_SETTINGS_OPERATIONS
    expect(ops.setMcpOAuthClient.input.safeParse({ id, client: null }).success).toBe(true)
    expect(ops.setMcpOAuthClient.input.safeParse({ id, client: { clientId: 'own', clientSecret: 's' } }).success).toBe(
      true
    )
    expect(ops.setMcpOAuthClient.input.safeParse({ id, client: { clientId: 'x'.repeat(4097) } }).success).toBe(false)
    expect(ops.patchMcpOAuthAccount.input.safeParse({ id, accountId, label: 'Work' }).success).toBe(true)
    expect(ops.patchMcpOAuthAccount.input.safeParse({ id, accountId, label: 'bad/label' }).success).toBe(false)
    expect(ops.patchMcpOAuthAccount.input.safeParse({ id, accountId, label: 'x'.repeat(41) }).success).toBe(false)
    expect(ops.removeMcpOAuth.input.safeParse({ id, accountId }).success).toBe(true)
    expect(ops.mcpOAuthDescriptor.input.safeParse({ id, accountId }).success).toBe(true)
    expect(
      ops.setMcpOAuth.input.safeParse({
        id,
        bundle: {
          url: 'https://mcp.example.test/mcp',
          redirectUri: 'http://127.0.0.1:4567/callback',
          clientInformation: { client_id: 'c' },
          tokens: { access_token: 'a', token_type: 'Bearer' },
          email: 'alice@example.test',
        },
        target: { accountId },
      }).success
    ).toBe(true)
    expect(ops.setMcpOAuth.response.safeParse({ ok: true, accountId }).success).toBe(true)
    expect(ops.setMcpOAuth.response.safeParse({ ok: false, error: 'label-taken' }).success).toBe(true)
    // The descriptor carries the own client to the owner's computer only: no renderer reaches it.
    expect(
      ops.mcpOAuthDescriptor.response.safeParse({
        descriptor: { serverId: id, name: 'x', url: 'https://mcp.example.test/mcp', client: { clientId: 'own' } },
      }).success
    ).toBe(true)
    expect(FLEET_PLUGIN_SETTINGS_OPERATIONS).toEqual(
      expect.arrayContaining(['patchMcpOAuthAccount', 'setMcpOAuthClient'])
    )
  })
})
