import { describe, expect, it } from 'vitest'
import {
  FLEET_ENVIRONMENT_PLUGINS_FEATURE,
  FLEET_PLUGIN_SETTINGS_OPERATIONS,
  FLEET_SETTINGS_OPERATIONS,
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
    expect(
      FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response.safeParse({
        servers: [{ id: 'plg_' + '0'.repeat(20), status: 'connected', tokens: bundle.tokens }],
      }).success
    ).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.response.safeParse({
        descriptor: { serverId: 'plg_' + '0'.repeat(20), name: 'x', url: bundle.url, headers: { Authorization: 'x' } },
      }).success
    ).toBe(false)
  })
})
