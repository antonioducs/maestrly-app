import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_SETTINGS_OPERATIONS,
  fleetSettingsMcpServerSchema,
} from '../src/index.js'
const revision = '550e8400-e29b-41d4-a716-446655440000'
describe('environment settings contract', () => {
  it('requires revisions, bounds input, and rejects arbitrary fields', () => {
    expect(FLEET_SETTINGS_OPERATIONS.writeSkill.input.safeParse({ name: 'example', markdown: '' }).success).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.writeSkill.input.safeParse({
        name: 'example',
        markdown: 'x'.repeat(262145),
        expectedRevision: revision,
      }).success
    ).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.setPreferences.input.safeParse({
        expectedRevision: revision,
        imageGenEnabled: true,
        arbitraryIpc: 'exec',
      }).success
    ).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.removeAccount.input.safeParse({
        providerId: 'p',
        expectedRevision: 'secret-derived-hash',
      }).success
    ).toBe(false)
  })
  it('never accepts transport secrets in a sanitized MCP response', () => {
    const server = {
      id: 'm',
      name: 'Example',
      revision,
      transport: 'stdio',
      enabled: true,
      hasCommand: true,
      hasArgs: true,
      hasUrl: false,
      envKeys: ['TOKEN'],
      headerKeys: [],
      unavailable: false,
    }
    expect(fleetSettingsMcpServerSchema.safeParse(server).success).toBe(true)
    for (const field of ['command', 'args', 'url', 'env', 'headers'])
      expect(fleetSettingsMcpServerSchema.safeParse({ ...server, [field]: 'secret' }).success).toBe(false)
    expect(
      FLEET_SETTINGS_OPERATIONS.testMcpServer.response.safeParse({
        code: 'connection-failed',
        toolCount: 0,
        error: 'raw secret',
      }).success
    ).toBe(false)
  })
  it('preserves omitted MCP values and uses explicit replacements', () => {
    expect(
      FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.parse({ id: 'm', expectedRevision: revision, enabled: false })
    ).toEqual({ id: 'm', expectedRevision: revision, enabled: false })
    expect(
      FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.safeParse({ id: 'm', expectedRevision: revision, command: 'oops' })
        .success
    ).toBe(false)
  })
  it('has matching explicit environment and instance endpoints for every method', () => {
    for (const [name, operation] of Object.entries(FLEET_SETTINGS_OPERATIONS)) {
      const key = 'settings' + name[0].toUpperCase() + name.slice(1)
      expect(Reflect.get(FLEET_GATEWAY_ROUTES, key)).toMatchObject({
        method: operation.method,
        path: '/v1/environments/:eid/settings' + operation.path,
        response: operation.response,
      })
      expect(Reflect.get(FLEET_INSTANCE_ROUTES, key)).toMatchObject({
        method: operation.method,
        path: '/v1/settings' + operation.path,
        response: operation.response,
      })
    }
  })
})
