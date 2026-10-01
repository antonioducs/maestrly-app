import { describe, expect, it } from 'vitest'
import * as fleet from '../src/index.js'

const settings = { enabled: false, publicAddress: '', ownerName: '', linkExpiryDays: null, quotaGb: 1 }
const at = '2026-09-30T12:00:00Z'
const artifactId = 'A'.repeat(18) + '_-12'

describe('artifact contracts', () => {
  it('exports the feature, body limit, port and environment keys', () => {
    expect(fleet.FLEET_ARTIFACTS_FEATURE).toBe('artifacts')
    expect(fleet.FLEET_ARTIFACT_BODY_MAX).toBe(72 * 1024 * 1024)
    expect(fleet.FLEET_PORTS.artifacts).toBe(4010)
    expect(fleet.FLEET_GATEWAY_ENV.artifactsPort).toBe('MAESTRLY_GATEWAY_ARTIFACTS_PORT')
    expect(fleet.FLEET_GATEWAY_ENV.artifactsHost).toBe('MAESTRLY_GATEWAY_ARTIFACTS_HOST')
  })

  it('accepts only exact normalized HTTP origins', () => {
    for (const origin of [
      'http://localhost:4010',
      'https://example.com',
      'http://127.0.0.1',
      'http://[::1]:4010',
    ])
      expect(fleet.fleetHttpOriginSchema.parse(origin)).toBe(origin)
    for (const origin of [
      '',
      'example.com',
      'ftp://example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://user:pass@example.com',
      'https://@example.com',
      'https://example.com?',
      'https://example.com#',
      'https://EXAMPLE.com',
      'HTTPS://example.com',
      'https://example.com:443',
      ' https://example.com',
      'https://example.com\n',
      'https://éxample.com',
      'https://' + 'a'.repeat(290) + '.com',
    ])
      expect(fleet.fleetHttpOriginSchema.safeParse(origin).success, origin).toBe(false)
  })

  it('bounds settings and allows independent partial updates', () => {
    expect(fleet.fleetArtifactSettingsSchema.parse(settings)).toEqual(settings)
    expect(fleet.fleetArtifactSettingsSchema.parse({ ...settings, ownerName: '  Owner  ' }).ownerName).toBe(
      'Owner'
    )
    expect(fleet.fleetArtifactSettingsPatchSchema.parse({})).toEqual({})
    for (const patch of [
      { enabled: true },
      { publicAddress: 'https://example.com' },
      { ownerName: 'x'.repeat(60) },
      { linkExpiryDays: 1 },
      { linkExpiryDays: 365 },
      { linkExpiryDays: null },
      { quotaGb: 100 },
    ]) {
      expect(fleet.fleetArtifactSettingsSchema.parse({ ...settings, ...patch })).toEqual({
        ...settings,
        ...patch,
      })
      expect(fleet.fleetArtifactSettingsPatchSchema.parse(patch)).toEqual(patch)
    }
    for (const patch of [
      { enabled: 'yes' },
      { publicAddress: 'https://example.com/' },
      { ownerName: 'x'.repeat(61) },
      { linkExpiryDays: 0 },
      { linkExpiryDays: 366 },
      { linkExpiryDays: 1.5 },
      { quotaGb: 0 },
      { quotaGb: 101 },
      { quotaGb: 1.5 },
      { quotaGb: null },
    ]) {
      expect(fleet.fleetArtifactSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false)
      expect(fleet.fleetArtifactSettingsPatchSchema.safeParse(patch).success).toBe(false)
    }
    expect(fleet.fleetArtifactSettingsSchema.safeParse({}).success).toBe(false)
  })

  it('validates host states, problems and nonnegative whole-byte counters', () => {
    const status = { state: 'off', problem: null, artifactCount: 0, storageBytes: 0, quotaBytes: 1024 }
    expect(fleet.fleetArtifactHostSchema.parse({ settings, status })).toEqual({ settings, status })
    for (const state of ['off', 'running', 'error'])
      for (const problem of [null, 'port_in_use', 'storage', 'internal'])
        expect(
          fleet.fleetArtifactHostSchema.safeParse({ settings, status: { ...status, state, problem } }).success
        ).toBe(true)
    for (const change of [
      { state: 'starting' },
      { problem: 'unknown' },
      { artifactCount: -1 },
      { artifactCount: 0.5 },
      { storageBytes: -1 },
      { storageBytes: 1.5 },
      { quotaBytes: -1 },
      { quotaBytes: 1.5 },
    ])
      expect(
        fleet.fleetArtifactHostSchema.safeParse({ settings, status: { ...status, ...change } }).success
      ).toBe(false)
  })

  it('bounds calls and structured errors without restricting successful values', () => {
    for (const call of [
      { method: 'list', args: [] },
      { method: 'x'.repeat(40), args: [null, { a: [] }, 42] },
    ])
      expect(fleet.fleetArtifactCallSchema.parse(call)).toEqual(call)
    for (const call of [
      { method: '', args: [] },
      { method: 'x'.repeat(41), args: [] },
      { method: 'list', args: [1, 2, 3, 4] },
      { method: 'list' },
    ])
      expect(fleet.fleetArtifactCallSchema.safeParse(call).success).toBe(false)
    for (const value of [null, false, 0, 'text', [1], { nested: { a: true } }])
      expect(fleet.fleetArtifactResultSchema.parse({ ok: true, value })).toEqual({ ok: true, value })
    for (const error of [
      { code: 'NOT_FOUND', message: 'Missing artifact' },
      {
        code: 'x'.repeat(40),
        message: 'x'.repeat(500),
        details: { retry: true, count: 2, resource: 'artifact' },
      },
    ])
      expect(fleet.fleetArtifactResultSchema.parse({ ok: false, error })).toEqual({ ok: false, error })
    for (const error of [
      { code: 'x'.repeat(41), message: '' },
      { code: 'ERROR', message: 'x'.repeat(501) },
      { code: 'ERROR', message: '', details: { nested: {} } },
      { code: 'ERROR', message: '', details: { value: null } },
      { code: 'ERROR' },
    ])
      expect(fleet.fleetArtifactResultSchema.safeParse({ ok: false, error }).success).toBe(false)
    expect(fleet.fleetArtifactResultSchema.safeParse({ ok: false }).success).toBe(false)
    expect(fleet.fleetArtifactResultSchema.safeParse({ ok: 'true', value: null }).success).toBe(false)
  })

  it('declares owner and bot artifact routes with shared schemas', () => {
    expect(fleet.FLEET_GATEWAY_ROUTES.artifactHost).toEqual({
      method: 'GET',
      path: '/v1/artifacts/host',
      body: null,
      response: fleet.fleetArtifactHostSchema,
    })
    expect(fleet.FLEET_GATEWAY_ROUTES.artifactHostPatch).toEqual({
      method: 'PATCH',
      path: '/v1/artifacts/host',
      body: fleet.fleetArtifactSettingsPatchSchema,
      response: fleet.fleetArtifactHostSchema,
    })
    for (const [route, path] of [
      [fleet.FLEET_GATEWAY_ROUTES.artifactAdmin, '/v1/artifacts/admin'],
      [fleet.FLEET_GATEWAY_ROUTES.artifactUpload, '/v1/artifacts/upload'],
      [fleet.FLEET_INTERNAL_ROUTES.artifactBotAdmin, '/internal/v1/artifacts/admin'],
      [fleet.FLEET_INTERNAL_ROUTES.artifactBotUpload, '/internal/v1/artifacts/upload'],
    ] as const)
      expect(route).toEqual({
        method: 'POST',
        path,
        body: fleet.fleetArtifactCallSchema,
        response: fleet.fleetArtifactResultSchema,
      })
  })

  it('validates artifact notifications and their IDs', () => {
    const events = [
      { type: 'artifact.changed', at, artifactId },
      ...['device_added', 'access_requested', 'invite_declined', 'comment_added'].map((kind) => ({
        type: 'artifact.activity',
        at,
        artifactId,
        kind,
      })),
    ]
    for (const event of events) {
      expect(fleet.fleetGatewayEventSchema.parse(event)).toEqual(event)
      for (const invalidId of [
        '',
        'a'.repeat(21),
        'a'.repeat(23),
        'a'.repeat(21) + '=',
        'a'.repeat(21) + '/',
        'a'.repeat(21) + '+',
      ])
        expect(fleet.fleetGatewayEventSchema.safeParse({ ...event, artifactId: invalidId }).success).toBe(
          false
        )
      expect(fleet.fleetGatewayEventSchema.safeParse({ ...event, at: 'yesterday' }).success).toBe(false)
    }
    expect(
      fleet.fleetGatewayEventSchema.safeParse({ type: 'artifact.activity', at, artifactId, kind: 'unknown' })
        .success
    ).toBe(false)
    expect(
      fleet.fleetGatewayEventSchema.safeParse({ type: 'artifact.activity', at, artifactId }).success
    ).toBe(false)
  })
})
