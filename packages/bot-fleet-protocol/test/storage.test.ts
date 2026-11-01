import { describe, expect, it } from 'vitest'
import {
  FLEET_ENVIRONMENT_STORAGE_FEATURE,
  FLEET_INSTANCE_ROUTES,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetInstanceStorageSchema,
} from '../src/index.js'

const at = '2026-11-01T10:00:00.000Z'

describe('environment storage contracts', () => {
  it('names the capability and the route', () => {
    expect(FLEET_ENVIRONMENT_STORAGE_FEATURE).toBe('environment-storage')
    expect(FLEET_INSTANCE_ROUTES.environmentStorage).toMatchObject({
      method: 'GET',
      path: '/v1/environment/storage',
      body: null,
    })
    expect(FLEET_INSTANCE_ROUTES.environmentStorage.response).toBe(fleetInstanceStorageSchema)
  })

  it('reads figures, and none before the first measurement', () => {
    expect(fleetInstanceStorageSchema.parse({ environment: null, bots: [] })).toEqual({ environment: null, bots: [] })
    const value = {
      environment: { homeBytes: 9000, downloadsBytes: 1000, folderBytes: null, measuredAt: at },
      bots: [{ botId: 'ads', usedBytes: 3000, browserBytes: 2000, measuredAt: at }],
    }
    expect(fleetInstanceStorageSchema.parse(value)).toEqual(value)
    expect(() =>
      fleetInstanceStorageSchema.parse({ ...value, environment: { ...value.environment, homeBytes: -1 } })
    ).toThrow()
    expect(() =>
      fleetInstanceStorageSchema.parse({ environment: null, bots: Array.from({ length: 9 }, () => value.bots[0]) })
    ).toThrow()
  })

  it('defaults storage to null on bots and environments from older servers', () => {
    const bot = fleetBotSchema.shape.storage.parse(undefined)
    const environment = fleetEnvironmentSchema.shape.storage.parse(undefined)
    expect(bot).toBeNull()
    expect(environment).toBeNull()
  })
})
