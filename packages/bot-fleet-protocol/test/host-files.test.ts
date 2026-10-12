import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_HOST_FILE_ERRORS,
  FLEET_HOST_FILE_ROUTE_KEYS,
  FLEET_INSTANCE_ROUTES,
  fleetHostFileErrorReason,
  fleetHostFileStatSchema,
  fleetHostFileUploadBeginSchema,
} from '../src/index.js'

describe('host file routes', () => {
  it('pass every gateway route through to the instance route of the same key', () => {
    for (const key of FLEET_HOST_FILE_ROUTE_KEYS) {
      expect(FLEET_GATEWAY_ROUTES[key].method).toBe(FLEET_INSTANCE_ROUTES[key].method)
      // As for settings routes: the instance path, with the environment after `/v1`.
      expect(FLEET_GATEWAY_ROUTES[key].path).toBe(
        FLEET_INSTANCE_ROUTES[key].path.replace(/^\/v1\//, '/v1/environments/:eid/')
      )
      expect(FLEET_GATEWAY_ROUTES[key].body).toBeNull()
      expect(FLEET_GATEWAY_ROUTES[key].response).toBeNull()
    }
    expect(
      Object.keys(FLEET_INSTANCE_ROUTES)
        .filter((key) => key.startsWith('hostFile'))
        .sort()
    ).toEqual([...FLEET_HOST_FILE_ROUTE_KEYS].sort())
  })

  it('accept only absolute paths, plain names and bounded sizes', () => {
    const stat = { path: '/srv/maestrly/a.csv', name: 'a.csv', size: 3, modifiedAt: 1, identity: '3:1:42' }
    expect(fleetHostFileStatSchema.parse(stat)).toEqual(stat)
    expect(fleetHostFileStatSchema.safeParse({ ...stat, path: 'relative/a.csv' }).success).toBe(false)
    expect(fleetHostFileStatSchema.safeParse({ ...stat, path: '/srv/a\0b' }).success).toBe(false)
    const begin = { directory: '/srv/maestrly', name: 'a.csv', size: 3, overwrite: false }
    for (const name of ['', '.', '..', 'a/b', 'a\\b'])
      expect(fleetHostFileUploadBeginSchema.safeParse({ ...begin, name }).success).toBe(false)
    expect(fleetHostFileUploadBeginSchema.safeParse({ ...begin, size: 2 ** 40 + 1 }).success).toBe(false)
  })

  it('tells refusals apart by their message', () => {
    for (const [reason, message] of Object.entries(FLEET_HOST_FILE_ERRORS))
      expect(fleetHostFileErrorReason(message)).toBe(reason)
    expect(fleetHostFileErrorReason('Route not found.')).toBeNull()
  })
})
