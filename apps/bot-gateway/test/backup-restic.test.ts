import type { FleetBackupDestination } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import {
  backupArgs,
  backupExcludes,
  forgetArgs,
  formatRecoveryKey,
  newRecoveryKey,
  normalizeRecoveryKey,
  parseSnapshots,
  redact,
  resticBackupSummary,
  resticEnvironment,
  resticFailure,
  resticProgress,
  resticStatsBytes,
  resticTarget,
  restoreArgs,
  snapshotTags,
} from '../src/backups/restic.js'
import type { HelperResult } from '../src/docker.js'
import { s3Destination } from './backup-fixtures.js'

const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'backups@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
})
const gcs: FleetBackupDestination = {
  provider: 'gcs',
  bucket: 'my-bucket',
  prefix: 'maestrly-backups',
  serviceAccountJson: serviceAccount,
}
const drive: FleetBackupDestination = {
  provider: 'drive',
  folder: 'Maestrly backups',
  account: 'owner@example.com',
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'synthetic-client-secret',
  token: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiry: '2026-11-07T04:00:00.000Z' },
}
const result = (overrides: Partial<HelperResult>): HelperResult => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  ending: 'exited',
  ...overrides,
})
const id = (char: string) => char.repeat(64)
const b64 = (text: string) => Buffer.from(text).toString('base64url')

describe('restic destinations', () => {
  it('opens Amazon S3 and compatible services', () => {
    expect(resticTarget(s3Destination)).toEqual({
      repository: 's3:https://s3.us-east-1.amazonaws.com/my-bucket/maestrly-backups',
      env: {
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE1234',
        AWS_SECRET_ACCESS_KEY: 'secret-example-value',
        AWS_DEFAULT_REGION: 'us-east-1',
      },
    })
    expect(resticTarget({ ...s3Destination, endpoint: 'https://acc.r2.cloudflarestorage.com/' }).repository).toBe(
      's3:https://acc.r2.cloudflarestorage.com/my-bucket/maestrly-backups'
    )
  })

  it('opens Google Cloud Storage through rclone', () => {
    expect(resticTarget(gcs)).toEqual({
      repository: 'rclone:dest:my-bucket/maestrly-backups',
      env: {
        RCLONE_CONFIG_DEST_TYPE: 'google cloud storage',
        RCLONE_CONFIG_DEST_SERVICE_ACCOUNT_CREDENTIALS: serviceAccount,
        RCLONE_CONFIG_DEST_BUCKET_POLICY_ONLY: 'true',
      },
    })
  })

  it('opens Google Drive through rclone with only its own files', () => {
    const target = resticTarget(drive)
    expect(target.repository).toBe('rclone:dest:Maestrly backups')
    expect(target.env).toMatchObject({
      RCLONE_CONFIG_DEST_TYPE: 'drive',
      RCLONE_CONFIG_DEST_SCOPE: 'drive.file',
      RCLONE_CONFIG_DEST_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      RCLONE_CONFIG_DEST_CLIENT_SECRET: 'synthetic-client-secret',
    })
    expect(JSON.parse(target.env.RCLONE_CONFIG_DEST_TOKEN)).toEqual({
      access_token: 'synthetic-access',
      token_type: 'Bearer',
      refresh_token: 'synthetic-refresh',
      expiry: '2026-11-07T04:00:00.000Z',
    })
  })

  it('passes the repository, the password and the cache in the environment', () => {
    const env = resticEnvironment(s3Destination, 'PASSWORD')
    expect(env).toEqual(
      expect.arrayContaining([
        'RESTIC_REPOSITORY=s3:https://s3.us-east-1.amazonaws.com/my-bucket/maestrly-backups',
        'RESTIC_PASSWORD=PASSWORD',
        'RESTIC_CACHE_DIR=/cache/restic',
        'RESTIC_PROGRESS_FPS=0.5',
        'HOME=/tmp',
        'RCLONE_CONFIG=/tmp/rclone.conf',
        'AWS_SECRET_ACCESS_KEY=secret-example-value',
      ])
    )
  })
})

describe('restic snapshots', () => {
  it('tags snapshots and reads them back', () => {
    const name = 'Ana, a Bot é'
    const tags = snapshotTags({ environment: { id: 'ana', name, kind: 'bots' }, serverName: 'Home server' })
    expect(tags).toEqual([
      'maestrly',
      'format:1',
      'env:ana',
      'kind:bots',
      'name:' + b64(name),
      'server-name:' + b64('Home server'),
    ])
    const stdout = JSON.stringify([
      { id: id('a'), time: '2026-11-07T03:00:01.123456789-03:00', hostname: 'server-1', tags },
      { id: id('b'), time: '2026-11-07T03:00:00Z', hostname: 'server-1', tags: ['other'] },
      { id: id('c'), time: '2026-11-07T03:00:00Z', hostname: 'server-1', tags: ['maestrly', 'kind:bots'] },
      { id: 'short', time: '2026-11-07T03:00:00Z', hostname: 'server-1', tags },
    ])
    expect(parseSnapshots(stdout)).toEqual([
      {
        id: id('a'),
        at: '2026-11-07T06:00:01.123Z',
        host: 'server-1',
        environmentId: 'ana',
        kind: 'bots',
        name,
        serverName: 'Home server',
        format: 1,
      },
    ])
    expect(parseSnapshots('not json')).toEqual([])
    expect(parseSnapshots('null')).toEqual([])
  })
})

describe('restic backups', () => {
  it('leaves out the live database of a running environment and what is rebuilt', () => {
    const excludes = backupExcludes({
      running: true,
      database: { live: '.config/maestrly-app-dev/maestrly-agents.db' },
      projects: null,
    })
    expect(excludes).toEqual(
      expect.arrayContaining([
        '/home/bot/.config/maestrly-app-dev/maestrly-agents.db',
        '/home/bot/.config/maestrly-app-dev/maestrly-agents.db-wal',
        '/home/bot/.config/maestrly-app-dev/maestrly-agents.db-shm',
        '/home/bot/.cache',
        '/home/bot/.config/**/Cache',
        '/home/bot/.config/**/Singleton*',
        '/home/bot/.config/maestrly-app*/runtime-assets',
        '/home/bot/.config/maestrly-app*/worktrees/**/node_modules',
      ])
    )
    expect(excludes.some((pattern) => pattern.includes('.maestrly-backup-staging'))).toBe(false)
    expect(excludes.some((pattern) => pattern.startsWith('/home/bot/.local'))).toBe(false)
  })

  it('copies a stopped environment as it is, without a copy left behind', () => {
    const excludes = backupExcludes({ running: false, database: null, projects: '/srv/maestrly/ana' })
    expect(excludes).toContain('/home/bot/.config/**/.maestrly-backup-staging')
    expect(excludes.some((pattern) => pattern.endsWith('maestrly-agents.db'))).toBe(false)
    expect(excludes).toContain('/srv/maestrly/ana/**/node_modules')
  })

  it('builds the arguments of each command', () => {
    expect(
      backupArgs({ host: 'server-1', tags: ['maestrly', 'env:ana'], paths: ['/home/bot', '/x'], excludes: ['/a'] })
    ).toEqual([
      'backup',
      '--json',
      '--host',
      'server-1',
      '--exclude-caches',
      '--tag',
      'maestrly',
      '--tag',
      'env:ana',
      '--exclude',
      '/a',
      '--',
      '/home/bot',
      '/x',
    ])
    expect(
      forgetArgs({ host: 'server-1', environmentId: 'ana', retention: { daily: 7, weekly: 0, monthly: 6 } })
    ).toEqual([
      'forget',
      '--host',
      'server-1',
      '--tag',
      'env:ana',
      '--group-by',
      'host',
      '--keep-daily',
      '7',
      '--keep-monthly',
      '6',
    ])
    expect(restoreArgs(id('a'), '/home/bot')).toEqual([
      'restore',
      '--json',
      `${id('a')}:/home/bot`,
      '--target',
      '/home/bot',
    ])
  })

  it('reads progress, summaries and sizes', () => {
    expect(resticProgress('{"message_type":"status","percent_done":0.25,"total_bytes":400}')).toEqual({
      percent: 0.25,
      totalBytes: 400,
    })
    expect(resticProgress('{"message_type":"status","percent_done":1.5}')).toEqual({ percent: 1, totalBytes: null })
    expect(resticProgress('scanning…')).toBeNull()
    expect(resticProgress('{"message_type":"summary"}')).toBeNull()
    const stdout = [
      '{"message_type":"status","percent_done":0.5}',
      `{"message_type":"summary","snapshot_id":"${id('b')}","data_added":10,"total_bytes_processed":100}`,
      '',
    ].join('\n')
    expect(resticBackupSummary(stdout)).toEqual({ snapshotId: id('b'), bytesAdded: 10, bytesTotal: 100 })
    expect(resticBackupSummary('{"message_type":"status"}')).toBeNull()
    expect(resticStatsBytes('{"total_size":1234}')).toBe(1234)
    expect(resticStatsBytes('oops')).toBeNull()
  })
})

describe('restic failures', () => {
  it('names the failure by exit code and output', () => {
    expect(resticFailure(result({ exitCode: 12 }), []).code).toBe('wrong-key')
    expect(resticFailure(result({ exitCode: 11 }), []).code).toBe('locked')
    expect(resticFailure(result({ exitCode: 10 }), []).code).toBe('not-found')
    expect(resticFailure(result({ stderr: 'Fatal: AccessDenied: Access Denied' }), []).code).toBe('denied')
    expect(resticFailure(result({ stderr: 'googleapi: Error 403: storageQuotaExceeded' }), []).code).toBe(
      'storage-full'
    )
    expect(resticFailure(result({ stderr: 'dial tcp: lookup x: no such host' }), []).code).toBe('unreachable')
    expect(resticFailure(result({ stderr: 'something odd' }), []).code).toBe('failed')
    expect(resticFailure(result({ ending: 'timeout', exitCode: 137 }), []).code).toBe('timeout')
    expect(resticFailure(result({ ending: 'cancelled', exitCode: 137 }), []).code).toBe('cancelled')
  })

  it('reads restic exit errors and never shows a secret', () => {
    const failure = resticFailure(
      result({
        stderr:
          '{"message_type":"exit_error","code":1,"message":"Fatal: key secret-example-value refused: AccessDenied"}\n',
      }),
      ['secret-example-value']
    )
    expect(failure).toEqual({ code: 'denied', message: 'Fatal: key [redacted] refused: AccessDenied' })
    expect(resticFailure(result({ stderr: 'x'.repeat(2000) }), []).message.length).toBe(500)
    expect(resticFailure(result({ exitCode: 2 }), []).message).toBe('restic exited with code 2')
    expect(redact('abcdefgh abcd ab', ['abcd', 'abcdefgh', 'ab', ''])).toBe('[redacted] [redacted] ab')
  })
})

describe('recovery keys', () => {
  it('makes keys of 32 base32 characters in groups of four', () => {
    expect(newRecoveryKey(() => Buffer.alloc(20, 0))).toBe('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA')
    expect(newRecoveryKey(() => Buffer.alloc(20, 0xff))).toBe('7777-7777-7777-7777-7777-7777-7777-7777')
    expect(newRecoveryKey()).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
  })

  it('reads keys as people type them', () => {
    expect(normalizeRecoveryKey('aaaa aaaa-aaaa-AAAA bbbb-cccc-dddd-2345')).toBe('AAAAAAAAAAAAAAAABBBBCCCCDDDD2345')
    expect(normalizeRecoveryKey('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA0')).toBeNull()
    expect(normalizeRecoveryKey('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA1')).toBeNull()
    expect(normalizeRecoveryKey('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA8')).toBeNull()
    expect(normalizeRecoveryKey('AAAA-AAAA')).toBeNull()
    expect(formatRecoveryKey('AAAAAAAAAAAAAAAABBBBCCCCDDDD2345')).toBe('AAAA-AAAA-AAAA-AAAA-BBBB-CCCC-DDDD-2345')
  })
})
