import { describe, expect, it } from 'vitest'
import {
  FLEET_BACKUPS_FEATURE,
  FLEET_BACKUPS_QUERY,
  FLEET_ENVIRONMENT_BACKUP_FEATURE,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  fleetBackupDestinationLabel,
  fleetBackupDestinationSchema,
  fleetBackupRetentionSchema,
  fleetBackupScheduleSchema,
  fleetGatewayEventSchema,
  fleetReaderWantsBackups,
  isFleetBackupEvent,
} from '../src/index.js'

const s3 = {
  provider: 's3',
  endpoint: null,
  region: 'us-east-1',
  bucket: 'my-bucket',
  prefix: 'maestrly-backups',
  accessKeyId: 'AKIAEXAMPLE1234',
  secretAccessKey: 'secret-example',
}

describe('backups protocol', () => {
  it('declares the routes', () => {
    expect(FLEET_GATEWAY_ROUTES.backupStatus).toMatchObject({ method: 'GET', path: '/v1/backup' })
    expect(FLEET_GATEWAY_ROUTES.backupConnect).toMatchObject({ method: 'PUT', path: '/v1/backup/destination' })
    expect(FLEET_GATEWAY_ROUTES.backupRunCancel).toMatchObject({ method: 'POST', path: '/v1/backup/runs/:id/cancel' })
    expect(FLEET_GATEWAY_ROUTES.backupRestore).toMatchObject({ method: 'POST', path: '/v1/backup/restore' })
    expect(FLEET_INSTANCE_ROUTES.environmentBackupPrepare).toMatchObject({
      method: 'POST',
      path: '/v1/environment/backup',
    })
    expect(FLEET_INSTANCE_ROUTES.environmentBackupRelease).toMatchObject({
      method: 'DELETE',
      path: '/v1/environment/backup',
    })
  })
  it('names features within the limits', () => {
    for (const value of [FLEET_BACKUPS_FEATURE, FLEET_ENVIRONMENT_BACKUP_FEATURE])
      expect(value.length).toBeLessThanOrEqual(40)
    expect(FLEET_BACKUPS_QUERY).toBe('backups')
  })
  it('validates destinations', () => {
    expect(fleetBackupDestinationSchema.parse(s3)).toEqual(s3)
    expect(() => fleetBackupDestinationSchema.parse({ ...s3, bucket: 'Bad_Bucket' })).toThrow()
    expect(() => fleetBackupDestinationSchema.parse({ ...s3, prefix: '../up' })).toThrow()
    expect(() => fleetBackupDestinationSchema.parse({ ...s3, endpoint: 'ftp://host' })).toThrow()
    expect(fleetBackupDestinationSchema.parse({ ...s3, endpoint: 'http://minio.lan:9000' }).provider).toBe('s3')
    expect(() => fleetBackupDestinationSchema.parse({ ...s3, extra: 1 })).toThrow()
  })
  it('labels destinations without secrets', () => {
    expect(fleetBackupDestinationLabel(fleetBackupDestinationSchema.parse(s3))).toBe('s3://my-bucket/maestrly-backups')
    expect(
      fleetBackupDestinationLabel(
        fleetBackupDestinationSchema.parse({ ...s3, endpoint: 'https://acc.r2.cloudflarestorage.com' })
      )
    ).toBe('s3://my-bucket/maestrly-backups (acc.r2.cloudflarestorage.com)')
  })
  it('bounds schedules and retention', () => {
    expect(() => fleetBackupScheduleSchema.parse({ kind: 'interval', everyMinutes: 30 })).toThrow()
    expect(fleetBackupScheduleSchema.parse({ kind: 'interval', everyMinutes: 60 }).kind).toBe('interval')
    expect(() => fleetBackupRetentionSchema.parse({ daily: 0, weekly: 0, monthly: 0 })).toThrow()
  })
  it('sends backup events only to readers that ask', () => {
    expect(isFleetBackupEvent({ type: 'backup_run.updated' })).toBe(true)
    expect(isFleetBackupEvent({ type: 'backup.updated' })).toBe(true)
    expect(isFleetBackupEvent({ type: 'environment.updated' })).toBe(false)
    expect(fleetReaderWantsBackups(new URLSearchParams('backups=1'))).toBe(true)
    expect(
      fleetGatewayEventSchema.parse({
        type: 'backup.updated',
        at: '2026-11-07T03:00:00.000Z',
        status: {
          destination: null,
          enabled: false,
          schedule: null,
          retention: { daily: 7, weekly: 4, monthly: 6 },
          selection: { mode: 'all' },
          environments: [],
          active: [],
        },
      }).type
    ).toBe('backup.updated')
  })
})
