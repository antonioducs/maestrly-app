import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FleetBackupDestination, FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupHelper } from '../src/backups/helper.js'
import { Backups } from '../src/backups/service.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver, type HelperSpec } from '../src/docker.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { Store } from '../src/store.js'
import { environmentRecord, environmentSecrets, s3Destination } from './backup-fixtures.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close()
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
type Answer = { exitCode: number; stdout?: string; stderr?: string }
function setup(answers: Record<string, Answer | ((spec: HelperSpec) => Answer)> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-service-'))
  dirs.push(dir)
  const config = loadConfig({
    MAESTRLY_GATEWAY_DATA_DIR: dir,
    MAESTRLY_GATEWAY_PUBLIC_PORT: '1',
    MAESTRLY_GATEWAY_INTERNAL_PORT: '2',
  })
  const store = new Store(dir)
  stores.push(store)
  const docker = new FakeDockerDriver()
  docker.images.add(config.botImage)
  docker.helperHandler = async (spec) => {
    if (spec.command[0] !== 'restic') return { exitCode: 0 }
    const answer = answers[spec.command[1]] ?? { exitCode: 0 }
    return typeof answer === 'function' ? answer(spec) : answer
  }
  const lifecycle = new Lifecycle(
    store,
    docker,
    config,
    (id) => new InstanceClient(id, 'control', 'http://127.0.0.1:9')
  )
  const events: FleetGatewayEvent[] = []
  const clock = { now: Date.parse('2026-11-07T02:00:00.000Z') }
  const backups = new Backups({
    store,
    lifecycle,
    helper: new BackupHelper(docker, config),
    config,
    emit: (event) => events.push(event),
    gatewayVersion: '1.0.0',
    serverName: () => 'Home server',
    now: () => clock.now,
  })
  const restic = (command: string) => docker.helperRuns.filter((spec) => spec.command[1] === command)
  return { store, docker, config, backups, events, clock, restic }
}
const env = (spec: HelperSpec, name: string) =>
  spec.env.find((value) => value.startsWith(name + '='))?.slice(name.length + 1)
const create = (destination: FleetBackupDestination = s3Destination, idempotencyKey = randomUUID()) => ({
  mode: 'create' as const,
  destination,
  idempotencyKey,
})
const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'backups@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----\n',
})

describe('backup destinations', () => {
  it('tells an empty destination from one with a backup, and names failures', async () => {
    const f = setup({ cat: { exitCode: 10 } })
    expect(await f.backups.probe(s3Destination)).toEqual({ state: 'empty' })
    const existing = setup({ cat: { exitCode: 12 } })
    expect(await existing.backups.probe(s3Destination)).toEqual({ state: 'existing' })
    const denied = setup({ cat: { exitCode: 1, stderr: 'Fatal: AccessDenied: Access Denied' } })
    expect(await denied.backups.probe(s3Destination)).toMatchObject({ state: 'error', error: { code: 'denied' } })
  })

  it('runs restic as the bot user in a helper with the cache and the credentials', async () => {
    const f = setup({ cat: { exitCode: 10 } })
    await f.backups.probe(s3Destination)
    await f.backups.probe(s3Destination)
    const [spec] = f.restic('cat')
    expect(spec).toMatchObject({
      image: f.config.botImage,
      user: '1000',
      network: f.config.network,
      labels: { 'org.maestrly.fleet.helper': 'backup' },
      command: ['restic', 'cat', 'config'],
    })
    expect(env(spec, 'RESTIC_REPOSITORY')).toBe('s3:https://s3.us-east-1.amazonaws.com/my-bucket/maestrly-backups')
    expect(env(spec, 'RESTIC_PASSWORD')).toMatch(/^[A-Z2-7]{32}$/)
    expect(spec.mounts).toContainEqual({
      type: 'volume',
      source: f.config.network + '-backup-cache',
      target: '/cache',
      readOnly: false,
    })
    // The cache folder is made once per process.
    const installs = f.docker.helperRuns.filter((item) => item.command[0] === 'install')
    expect(installs).toHaveLength(1)
    expect(installs[0]).toMatchObject({ user: '0', network: 'none', capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] })
    expect(await f.docker.volumeExists(f.config.network + '-backup-cache')).toBe(true)
  })

  it('creates a repository with a new recovery key, once per request', async () => {
    const f = setup({ cat: { exitCode: 10 }, init: { exitCode: 0 } })
    const request = create()
    const created = await f.backups.connect(request, 'Synthetic computer')
    expect(created).toMatchObject({ ok: true })
    if (!created.ok) throw new Error('not connected')
    expect(created.recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    const settings = f.store.backupSettings()!
    expect(settings).toMatchObject({
      enabled: false,
      schedule: null,
      selection: { mode: 'all' },
      updatedBy: 'Synthetic computer',
    })
    expect(settings.recoveryKey).toBe(created.recoveryKey!.replaceAll('-', ''))
    expect(env(f.restic('init')[0], 'RESTIC_PASSWORD')).toBe(settings.recoveryKey)
    expect(created.status.destination).toMatchObject({
      provider: 's3',
      label: 's3://my-bucket/maestrly-backups',
      account: '…1234',
    })
    const again = await f.backups.connect(request, 'Synthetic computer')
    expect(again).toEqual(created)
    expect(f.restic('init')).toHaveLength(1)
    expect(f.events.map((event) => event.type)).toEqual(['backup.updated'])
  })

  it('refuses to create a repository over a backup', async () => {
    const f = setup({ cat: { exitCode: 12 } })
    await expect(f.backups.connect(create(), 'Mac')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.restic('init')).toHaveLength(0)
  })

  it('connects to a backup with its recovery key', async () => {
    const short = setup()
    expect(
      await short.backups.connect(
        { mode: 'connect', destination: s3Destination, recoveryKey: 'ABCD-EFGH', idempotencyKey: randomUUID() },
        'Mac'
      )
    ).toMatchObject({ ok: false, error: { code: 'wrong-key' } })
    expect(short.docker.helperRuns).toHaveLength(0)
    const key = 'abcd efgh ijkl mnop qrst uvwx yz23 4567'
    const wrong = setup({ cat: { exitCode: 12 } })
    expect(
      await wrong.backups.connect(
        { mode: 'connect', destination: s3Destination, recoveryKey: key, idempotencyKey: randomUUID() },
        'Mac'
      )
    ).toMatchObject({ ok: false, error: { code: 'wrong-key' } })
    expect(wrong.store.backupSettings()).toBeNull()
    const right = setup({ cat: { exitCode: 0 } })
    expect(
      await right.backups.connect(
        { mode: 'connect', destination: s3Destination, recoveryKey: key, idempotencyKey: randomUUID() },
        'Mac'
      )
    ).toMatchObject({ ok: true, recoveryKey: null })
    expect(right.store.backupSettings()?.recoveryKey).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')
    expect(right.backups.recoveryKey()).toBe('ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567')
  })

  it('takes only service account keys for Cloud Storage', async () => {
    const f = setup({ cat: { exitCode: 10 }, init: { exitCode: 0 } })
    const gcs = {
      provider: 'gcs' as const,
      bucket: 'my-bucket',
      prefix: 'maestrly',
      serviceAccountJson: '{"type":"user"}',
    }
    await expect(f.backups.probe(gcs)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const connected = await f.backups.connect(create({ ...gcs, serviceAccountJson: serviceAccount }), 'Mac')
    expect(connected).toMatchObject({
      ok: true,
      status: { destination: { provider: 'gcs', account: 'backups@example.iam.gserviceaccount.com' } },
    })
  })
})

describe('backup settings', () => {
  it('schedules the environments it backs up', async () => {
    const f = setup({ cat: { exitCode: 10 } })
    f.store.insertEnvironment(environmentRecord('work', { lifecycle: 'stopped' }), environmentSecrets('work'))
    expect(() => f.backups.update({ enabled: true })).toThrow('Set up a backup destination first')
    await f.backups.connect(create(), 'Mac')
    expect(() => f.backups.update({ selection: { mode: 'selected', environments: ['ghost'] } })).toThrow(
      'Unknown environment'
    )
    expect(() => f.backups.update({ enabled: true })).toThrow('Choose when to back up first')
    expect(() =>
      f.backups.update({ schedule: { kind: 'weekly', days: [], time: '03:00', timezone: 'Mars/Olympus' } })
    ).toThrow()
    f.events.splice(0)
    const status = f.backups.update({
      enabled: true,
      schedule: { kind: 'weekly', days: [], time: '03:00', timezone: 'UTC' },
    })
    expect(status.environments).toEqual([
      expect.objectContaining({
        environmentId: 'work',
        included: true,
        eligibility: 'ok',
        nextRunAt: '2026-11-07T03:00:00.000Z',
      }),
    ])
    expect(f.events.map((event) => event.type)).toEqual(['backup.updated'])
    const paused = f.backups.update({ enabled: false })
    expect(paused.environments[0].nextRunAt).toBeNull()
    const none = f.backups.update({ enabled: true, selection: { mode: 'selected', environments: [] } })
    expect(none.environments[0]).toMatchObject({ included: false, nextRunAt: null })
    expect(f.store.backupEnvironments()).toEqual([])
  })

  it('forgets the destination and never shows its secrets', async () => {
    const f = setup({ cat: { exitCode: 10 } })
    const created = await f.backups.connect(create(), 'Mac')
    const text = JSON.stringify(f.backups.status())
    expect(text).not.toContain(s3Destination.secretAccessKey)
    expect(text).not.toContain(f.store.backupSettings()!.recoveryKey)
    expect(text).not.toContain(created.ok ? created.recoveryKey : 'none')
    const drive = setup({ cat: { exitCode: 10 } })
    await drive.backups.connect(
      create({
        provider: 'drive',
        folder: 'Maestrly backups',
        account: 'owner@example.com',
        clientId: 'client-id',
        clientSecret: 'synthetic-client-secret',
        token: {
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-refresh',
          expiry: '2026-11-07T04:00:00.000Z',
        },
      }),
      'Mac'
    )
    const driveText = JSON.stringify(drive.backups.status())
    for (const secret of ['synthetic-refresh', 'synthetic-access', 'synthetic-client-secret'])
      expect(driveText).not.toContain(secret)
    expect(drive.backups.status().destination).toMatchObject({
      account: 'owner@example.com',
      label: 'drive://Maestrly backups',
    })
    const status = await f.backups.disconnect()
    expect(status.destination).toBeNull()
    expect(f.store.backupSettings()).toBeNull()
    expect(() => f.backups.recoveryKey()).toThrow('No backup destination')
  })
})
