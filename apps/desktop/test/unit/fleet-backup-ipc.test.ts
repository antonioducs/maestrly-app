import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLEET_BACKUPS_FEATURE } from '@maestrly/bot-fleet-protocol'

const mocks = vi.hoisted(() => ({ vault: new Map<string, string>(), available: true }))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => mocks.available,
  secureGet: (key: string) => mocks.vault.get(key) ?? null,
  secureSet: (key: string, value: string) => {
    if (!mocks.available) return false
    mocks.vault.set(key, value)
    return true
  },
  secureRemove: (key: string) => mocks.vault.delete(key) || true,
}))
vi.mock('../../src/main/store', () => ({ getAppSetting: () => null, setAppSetting: () => {} }))

import {
  type FleetBackupDriveAuthorization,
  type FleetBackupIpcDeps,
  registerFleetBackupIpc,
} from '../../src/main/fleet/client/backup-ipc'
import type { FleetIpcRegistrar } from '../../src/main/fleet/client/scoped-ipc'
import type { FleetClientService } from '../../src/main/fleet/client/service'
import { fleetBackupRecoveryKeyFor, saveFleetBackupRecoveryKey } from '../../src/main/fleet/client/settings'

const KEY = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567'
const s3 = {
  provider: 's3' as const,
  endpoint: null,
  region: 'us-east-1',
  bucket: 'my-bucket',
  prefix: 'maestrly-backups',
  accessKeyId: 'AKIAEXAMPLE1234',
  secretAccessKey: 'secret-example',
}
const LABEL = 's3://my-bucket/maestrly-backups'
const status = (label: string | null = LABEL) => ({
  destination: label ? { provider: 's3', label, account: '…1234', repositoryBytes: null } : null,
  enabled: false,
  schedule: null,
  retention: { daily: 7, weekly: 4, monthly: 6 },
  selection: { mode: 'all' },
  environments: [],
  active: [],
})

afterEach(() => {
  mocks.vault.clear()
  mocks.available = true
})

function setup(options: { feature?: boolean; answers?: Record<string, unknown>; driveSignIn?: boolean } = {}) {
  const calls: Array<{ route: string; options: Record<string, any> | undefined }> = []
  const answers: Record<string, unknown> = {
    backupStatus: status(),
    backupConnect: { ok: true, status: status(), recoveryKey: KEY },
    backupRecoveryKey: { recoveryKey: KEY },
    ...options.answers,
  }
  const fleet = {
    serverId: 'aaaaaaaa-0000-4000-8000-000000000001',
    hasFeature: (feature: string) => feature === FLEET_BACKUPS_FEATURE && options.feature !== false,
    call: vi.fn(async (route: string, callOptions?: Record<string, any>) => {
      calls.push({ route, options: callOptions })
      return answers[route]
    }),
    getConnection: () => ({ hostname: 'home-server', url: 'https://home.example' }),
  } as unknown as FleetClientService
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const scoped: FleetIpcRegistrar = {
    handle: (channel, fn) => handlers.set(channel, (...args) => fn(fleet, { sender: {} } as never, ...args)),
    mhandle: (channel, fn) => handlers.set(channel, (...args) => fn(fleet, { sender: {} } as never, ...args)),
  }
  const clock = { now: 1_000_000 }
  const written: Array<{ path: string; text: string }> = []
  const deps: FleetBackupIpcDeps = {
    grants: new Map(),
    chooseKeyFile: async () => '/tmp/key.txt',
    writeKeyFile: async (path, text) => void written.push({ path, text }),
    savedKey: fleetBackupRecoveryKeyFor,
    saveKey: saveFleetBackupRecoveryKey,
    now: () => clock.now,
    ...(options.driveSignIn
      ? {
          driveSignIn: async (): Promise<FleetBackupDriveAuthorization> => ({
            client: { clientId: 'client-id', clientSecret: 'client-secret' },
            token: { accessToken: 'access', refreshToken: 'refresh', expiry: '2026-11-07T04:00:00.000Z' },
            account: 'owner@example.com',
          }),
        }
      : {}),
  }
  registerFleetBackupIpc(scoped, deps)
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get('fleet:backup:' + channel)!(...args) as Promise<any>
  return { calls, invoke, deps, clock, written }
}

describe('fleet backup IPC', () => {
  it('answers null from a server without backups and asks one that has them', async () => {
    const old = setup({ feature: false })
    expect(await old.invoke('status')).toBeNull()
    expect(old.calls).toEqual([])
    await expect(old.invoke('update', { enabled: true })).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    const current = setup()
    expect(await current.invoke('status')).toEqual(status())
    expect(current.calls.map((call) => call.route)).toEqual(['backupStatus'])
  })

  it('keeps the key of a new backup on this computer, under its destination', async () => {
    const f = setup()
    const result = await f.invoke('connect', { mode: 'create', destination: s3 })
    expect(result).toEqual({ ok: true, status: status(), recoveryKey: KEY, savedOnThisComputer: true })
    expect(fleetBackupRecoveryKeyFor(LABEL)).toBe(KEY)
    expect(f.calls[0].options?.body).toMatchObject({ mode: 'create', destination: s3 })
    expect(f.calls[0].options?.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(await f.invoke('hasSavedKey', s3)).toBe(true)
    mocks.available = false
    mocks.vault.clear()
    const unsaved = await f.invoke('connect', { mode: 'create', destination: { ...s3, prefix: 'other' } })
    expect(unsaved).toMatchObject({ ok: true, savedOnThisComputer: false })
  })

  it('connects with the saved key, and asks for one when there is none', async () => {
    const none = setup()
    expect(await none.invoke('connect', { mode: 'connect', destination: s3, recoveryKey: null })).toEqual({
      ok: false,
      error: { code: 'wrong-key', message: '' },
    })
    expect(none.calls).toEqual([])
    saveFleetBackupRecoveryKey(LABEL, KEY)
    const saved = setup({ answers: { backupConnect: { ok: true, status: status(), recoveryKey: null } } })
    expect(await saved.invoke('connect', { mode: 'connect', destination: s3, recoveryKey: null })).toMatchObject({
      ok: true,
      recoveryKey: null,
      savedOnThisComputer: true,
    })
    expect(saved.calls[0].options?.body).toMatchObject({ mode: 'connect', recoveryKey: KEY })
  })

  it('keeps a key the owner typed once it opens the backup', async () => {
    const f = setup({ answers: { backupConnect: { ok: true, status: status(), recoveryKey: null } } })
    const typed = 'abcd efgh ijkl mnop qrst uvwx yz23 4567'
    await f.invoke('connect', { mode: 'connect', destination: s3, recoveryKey: typed })
    expect(f.calls[0].options?.body.recoveryKey).toBe(typed)
    expect(fleetBackupRecoveryKeyFor(LABEL)).toBe(KEY)
    const wrong = setup({ answers: { backupConnect: { ok: false, error: { code: 'wrong-key', message: 'x' } } } })
    mocks.vault.clear()
    expect(await wrong.invoke('connect', { mode: 'connect', destination: s3, recoveryKey: typed })).toEqual({
      ok: false,
      error: { code: 'wrong-key', message: 'x' },
    })
    expect(fleetBackupRecoveryKeyFor(LABEL)).toBeNull()
  })

  it('sends a Drive destination with the sign-in this process kept', async () => {
    const f = setup({ driveSignIn: true })
    const grant = await f.invoke('driveSignIn')
    expect(grant).toEqual({ grantId: expect.stringMatching(/^[0-9a-f-]{36}$/), account: 'owner@example.com' })
    await f.invoke('probe', { provider: 'drive', folder: 'Maestrly backups', grantId: grant.grantId })
    expect(f.calls[0].options?.body.destination).toEqual({
      provider: 'drive',
      folder: 'Maestrly backups',
      account: 'owner@example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      token: { accessToken: 'access', refreshToken: 'refresh', expiry: '2026-11-07T04:00:00.000Z' },
    })
    await expect(
      f.invoke('probe', { provider: 'drive', folder: 'x', grantId: '00000000-0000-4000-8000-000000000000' })
    ).rejects.toThrow('Sign in to Google Drive again')
    f.clock.now += 16 * 60_000
    await expect(
      f.invoke('probe', { provider: 'drive', folder: 'Maestrly backups', grantId: grant.grantId })
    ).rejects.toThrow('Sign in to Google Drive again')
    expect(f.calls).toHaveLength(1)
    await expect(setup().invoke('driveSignIn')).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('checks ids before asking the server', async () => {
    const f = setup()
    await expect(f.invoke('runNow', 'Bad Id')).rejects.toThrow()
    await expect(f.invoke('cancel', '')).rejects.toThrow()
    await expect(f.invoke('cancel', 42)).rejects.toThrow()
    await expect(f.invoke('runs', 'Bad Id')).rejects.toThrow()
    await expect(f.invoke('restorePreview', 'abc')).rejects.toThrow()
    await expect(f.invoke('restore', { snapshotId: 'a'.repeat(64) })).rejects.toThrow()
    await expect(f.invoke('probe', { ...s3, extra: true })).rejects.toThrow()
    expect(f.calls).toEqual([])
    await f.invoke('runNow', 'work')
    expect(f.calls[0]).toMatchObject({ route: 'backupRunsCreate', options: { body: { environmentId: 'work' } } })
  })

  it('shows the key this computer kept before asking the server for it', async () => {
    saveFleetBackupRecoveryKey(LABEL, KEY)
    const saved = setup()
    expect(await saved.invoke('recoveryKey')).toBe(KEY)
    expect(saved.calls.map((call) => call.route)).toEqual(['backupStatus'])
    mocks.vault.clear()
    const asked = setup()
    expect(await asked.invoke('recoveryKey')).toBe(KEY)
    expect(asked.calls.map((call) => call.route)).toEqual(['backupStatus', 'backupRecoveryKey'])
    expect(fleetBackupRecoveryKeyFor(LABEL)).toBe(KEY)
  })

  it('saves the key in a file with the server and the destination', async () => {
    const f = setup()
    expect(await f.invoke('exportRecoveryKey')).toBe('saved')
    expect(f.written).toHaveLength(1)
    expect(f.written[0].text).toContain(KEY)
    expect(f.written[0].text).toContain('home-server')
    expect(f.written[0].text).toContain(LABEL)
    f.deps.chooseKeyFile = async () => null
    expect(await f.invoke('exportRecoveryKey')).toBe('cancelled')
  })

  it('never removes a kept key when the server disconnects', async () => {
    const f = setup({ answers: { backupDisconnect: status(null) } })
    saveFleetBackupRecoveryKey(LABEL, KEY)
    await f.invoke('disconnect')
    expect(fleetBackupRecoveryKeyFor(LABEL)).toBe(KEY)
  })
})
