import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_HOST_FILE_ERRORS,
  FLEET_HOST_FILE_FOLDER_ROUTE_KEYS,
  FLEET_HOST_FILE_ROUTE_KEYS,
  FLEET_INSTANCE_ROUTES,
  fleetHostFileArchiveSchema,
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

  it('moves a folder as an archive: packed on the host, or extracted there and never over another', () => {
    for (const key of FLEET_HOST_FILE_FOLDER_ROUTE_KEYS) expect(FLEET_HOST_FILE_ROUTE_KEYS).toContain(key)
    const begin = { directory: '/srv/maestrly', name: 'site', size: 3, overwrite: false }
    expect(fleetHostFileUploadBeginSchema.parse({ ...begin, kind: 'folder' })).toMatchObject({ kind: 'folder' })
    expect(fleetHostFileUploadBeginSchema.safeParse({ ...begin, kind: 'folder', overwrite: true }).success).toBe(false)
    expect(fleetHostFileUploadBeginSchema.safeParse({ ...begin, kind: 'zip' }).success).toBe(false)
    expect(fleetHostFileUploadBeginSchema.parse({ ...begin, overwrite: true })).not.toHaveProperty('kind')
    const archiveId = 'a'.repeat(32)
    const packing = { state: 'packing', archiveId, bytes: 10, totalBytes: 0 }
    expect(fleetHostFileArchiveSchema.parse(packing)).toEqual(packing)
    const ready = {
      state: 'ready',
      archiveId,
      name: 'site',
      path: '/home/maestrly/.config/Maestrly/host-file-archives/a.tar.zst',
      size: 512,
      identity: '512:1:2',
      entries: 3,
    }
    expect(fleetHostFileArchiveSchema.parse(ready)).toEqual(ready)
    expect(fleetHostFileArchiveSchema.safeParse({ ...ready, state: 'packing' }).success).toBe(false)
    expect(fleetHostFileArchiveSchema.safeParse({ ...ready, archiveId: '../x' }).success).toBe(false)
  })

  it('tells refusals apart by their message', () => {
    for (const [reason, message] of Object.entries(FLEET_HOST_FILE_ERRORS))
      expect(fleetHostFileErrorReason(message)).toBe(reason)
    expect(fleetHostFileErrorReason('Route not found.')).toBeNull()
  })
})
