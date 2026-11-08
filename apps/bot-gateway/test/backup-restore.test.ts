import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupHelper } from '../src/backups/helper.js'
import { snapshotTags } from '../src/backups/restic.js'
import { Backups } from '../src/backups/service.js'
import { type BackupSlice, buildBackupSlice } from '../src/backups/slice.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver, type HelperSpec } from '../src/docker.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle, environmentVolumeName } from '../src/lifecycle.js'
import { Store } from '../src/store.js'
import { backupRun, backupSettings, environmentRecord, environmentSecrets } from './backup-fixtures.js'
import { harness } from './harness.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close()
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const SNAPSHOT = 'd'.repeat(64)
const database = {
  snapshot: '.config/maestrly-app/.maestrly-backup-staging/maestrly-agents.db',
  live: '.config/maestrly-app/maestrly-agents.db',
}
type Answer = { exitCode: number; stdout?: string; stderr?: string }
type Answers = Record<string, Answer | ((spec: HelperSpec) => Answer)>

function listing(
  entries: Array<{
    id: string
    environmentId: string
    host: string
    time: string
    name?: string
    kind?: 'bots' | 'workspaces'
  }>
) {
  return JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      time: entry.time,
      hostname: entry.host,
      tags: snapshotTags({
        environment: { id: entry.environmentId, name: entry.name ?? entry.environmentId, kind: entry.kind ?? 'bots' },
        serverName: entry.host + ' name',
      }),
    }))
  )
}
function wire(store: Store, lifecycle: Lifecycle, docker: FakeDockerDriver, answers: () => Answers) {
  docker.helperHandler = async (spec) => {
    const answer = answers()[spec.command[0] === 'restic' ? spec.command[1] : spec.command[0]] ?? { exitCode: 0 }
    return typeof answer === 'function' ? answer(spec) : answer
  }
  const events: FleetGatewayEvent[] = []
  const backups = new Backups({
    store,
    lifecycle,
    helper: new BackupHelper(docker, lifecycle.config),
    config: lifecycle.config,
    emit: (event) => events.push(event),
    gatewayVersion: '1.0.0',
    serverName: () => 'Home server',
  })
  store.saveBackupSettings(backupSettings({ enabled: false }))
  const restic = (command: string) => docker.helperRuns.filter((spec) => spec.command[1] === command)
  const restore = (keepExistingProjects = false) =>
    backups.restore({ snapshotId: SNAPSHOT, keepExistingProjects, idempotencyKey: randomUUID() })
  return { backups, events, restic, restore }
}
/** The harness's environment `test`, backed up and then deleted: its backup restores into a free id. */
async function bots(answers: Answers = {}, keep = false) {
  const h = await harness(Date.now, { environments: true, instanceCapabilities: ['environment-backup'] })
  const slice = buildBackupSlice({
    store: h.store,
    environmentId: 'test',
    server: { id: h.store.serverId(), name: 'Home server' },
    gatewayVersion: '1.0.0',
    now: new Date().toISOString(),
    database,
    projects: null,
  })
  if (!keep) {
    await h.lifecycle.archiveEnvironment('test')
    await h.lifecycle.purgeEnvironment('test')
  }
  const state = { slice: JSON.stringify(slice) }
  const wired = wire(h.store, h.lifecycle, h.docker, () => ({
    snapshots: {
      exitCode: 0,
      stdout: listing([
        { id: SNAPSHOT, environmentId: 'test', host: h.store.serverId(), time: '2026-11-07T03:00:00Z' },
      ]),
    },
    dump: { exitCode: 0, stdout: state.slice },
    ...answers,
  }))
  return { ...h, ...wired, slice, state }
}
/** A gateway with a workspaces folder, and the backup of a workspaces environment `host` that is not on it. */
function workspaces(answers: Answers = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'))
  dirs.push(dir)
  const config = loadConfig({
    MAESTRLY_GATEWAY_DATA_DIR: dir,
    MAESTRLY_GATEWAY_PUBLIC_PORT: '1',
    MAESTRLY_GATEWAY_INTERNAL_PORT: '2',
    MAESTRLY_GATEWAY_WORKSPACES_ROOT: '/srv/maestrly',
  })
  const store = new Store(dir)
  stores.push(store)
  const docker = new FakeDockerDriver()
  docker.images.add(config.botImage)
  const lifecycle = new Lifecycle(
    store,
    docker,
    config,
    (id) => new InstanceClient(id, 'control', 'http://127.0.0.1:9')
  )
  lifecycle.locateGateway = async () => 'maestrly-bot-gateway'
  store.insertEnvironment(
    environmentRecord('host', { kind: 'workspaces', hostFolder: 'own', lifecycle: 'stopped' }),
    environmentSecrets('host')
  )
  const slice: BackupSlice = buildBackupSlice({
    store,
    environmentId: 'host',
    server: { id: 'other-server', name: 'Other' },
    gatewayVersion: '1.0.0',
    now: new Date().toISOString(),
    database: null,
    projects: '/srv/maestrly/host',
  })
  store.archiveEnvironment('host')
  store.purgeEnvironment('host')
  const wired = wire(store, lifecycle, docker, () => ({
    snapshots: {
      exitCode: 0,
      stdout: listing([
        { id: SNAPSHOT, environmentId: 'host', host: 'other-server', time: '2026-11-07T03:00:00Z', kind: 'workspaces' },
      ]),
    },
    dump: { exitCode: 0, stdout: JSON.stringify(slice) },
    find: { exitCode: 1, stderr: "find: '/mnt/root/host': No such file or directory" },
    ...answers,
  }))
  return { store, docker, lifecycle, slice, ...wired }
}
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}

describe('backups at the destination', () => {
  it('groups snapshots by environment and server, newest first', async () => {
    const f = await bots({}, true)
    const serverId = f.store.serverId()
    f.docker.helperHandler = async (spec) => {
      if (spec.command[1] !== 'snapshots') return { exitCode: 0 }
      const stdout = JSON.parse(
        listing([
          { id: 'a'.repeat(64), environmentId: 'test', host: serverId, time: '2026-11-06T03:00:00Z', name: 'Old name' },
          { id: 'b'.repeat(64), environmentId: 'test', host: serverId, time: '2026-11-07T03:00:00Z', name: 'Test' },
          { id: 'c'.repeat(64), environmentId: 'ana', host: 'other-server', time: '2026-11-05T03:00:00Z' },
          { id: 'e'.repeat(64), environmentId: 'test', host: 'other-server', time: '2026-11-04T03:00:00Z' },
        ])
      )
      stdout.push({ id: 'f'.repeat(64), time: '2026-11-07T04:00:00Z', hostname: serverId, tags: ['other'] })
      return { exitCode: 0, stdout: JSON.stringify(stdout) }
    }
    const { environments } = await f.backups.snapshots()
    expect(
      environments.map((group) => [
        group.environmentId,
        group.thisServer,
        group.taken,
        group.name,
        group.snapshots.map((item) => item.id[0]),
      ])
    ).toEqual([
      ['test', true, true, 'Test', ['b', 'a']],
      ['ana', false, false, 'ana', ['c']],
      ['test', false, true, 'test', ['e']],
    ])
    expect(environments[1]).toMatchObject({ serverId: 'other-server', serverName: 'other-server name' })
  })
})

describe('restore previews', () => {
  it('shows what comes back and what keeps it from coming back', async () => {
    const free = await bots()
    expect(await free.backups.restorePreview(SNAPSHOT)).toMatchObject({
      snapshotId: SNAPSHOT,
      at: '2026-11-07T03:00:00.000Z',
      environment: { id: 'test', kind: 'bots' },
      bots: [{ id: 'test', taken: false }],
      projects: null,
      problems: [],
    })
    const taken = await bots({}, true)
    expect((await taken.backups.restorePreview(SNAPSHOT)).problems).toEqual(['environment-taken', 'bot-taken'])
    // A bot of the same id in another environment.
    const other = free.lifecycle.createEnvironment({ name: 'Other', memoryLimitBytes: null })
    await until(() => free.lifecycle.environment(other.id)?.lifecycle === 'running')
    free.lifecycle.create({
      name: 'Test',
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId: other.id,
      idempotencyKey: randomUUID(),
    })
    expect(await free.backups.restorePreview(SNAPSHOT)).toMatchObject({
      bots: [{ id: 'test', taken: true }],
      problems: ['bot-taken'],
    })
    free.state.slice = JSON.stringify({ ...free.slice, format: 2 })
    expect(await free.backups.restorePreview(SNAPSHOT)).toMatchObject({
      problems: ['format-newer'],
      environment: { id: 'test' },
      bots: [],
    })
    await expect(free.backups.restorePreview('9'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('needs the workspaces folder the projects were in', async () => {
    const f = await bots()
    f.state.slice = JSON.stringify({
      ...f.slice,
      environment: { ...f.slice.environment, kind: 'workspaces' },
      bots: [],
      files: { database: null, projects: '/srv/maestrly/test' },
    })
    expect((await f.backups.restorePreview(SNAPSHOT)).problems).toEqual(['workspaces-root-missing'])
  })

  it("tells whether the environment's server folder has files", async () => {
    expect((await workspaces().backups.restorePreview(SNAPSHOT)).projects).toEqual({
      path: '/srv/maestrly/host',
      state: 'absent',
    })
    expect((await workspaces({ find: { exitCode: 0 } }).backups.restorePreview(SNAPSHOT)).projects?.state).toBe('empty')
    const full = workspaces({ find: { exitCode: 0, stdout: '/mnt/root/host/notes.md\n' } })
    expect((await full.backups.restorePreview(SNAPSHOT)).projects?.state).toBe('not-empty')
    const find = full.docker.helperRuns.find((spec) => spec.command[0] === 'find')!
    expect(find).toMatchObject({ network: 'none', user: '1000', env: [] })
    expect(find.mounts).toEqual([{ type: 'bind', source: '/srv/maestrly', target: '/mnt/root', readOnly: true }])
  })
})

describe('restores', () => {
  it('restores an environment of bots with its database copy in place', async () => {
    const f = await bots()
    const run = await f.restore()
    expect(run).toMatchObject({ kind: 'restore', state: 'queued', environmentId: 'test', snapshotId: SNAPSHOT })
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ id: run.id, state: 'succeeded' })
    const volume = environmentVolumeName('test')
    const [restore] = f.restic('restore')
    expect(restore.command).toEqual(['restic', 'restore', '--json', `${SNAPSHOT}:/home/bot`, '--target', '/home/bot'])
    expect(restore.mounts).toContainEqual({ type: 'volume', source: volume, target: '/home/bot', readOnly: false })
    const placed = f.docker.helperRuns.find((spec) => spec.command[0] === 'sh')!
    expect(placed.command.slice(4)).toEqual([
      '/home/bot/' + database.snapshot,
      '/home/bot/' + database.live,
      '/home/bot/.config/maestrly-app/.maestrly-backup-staging',
    ])
    expect(placed).toMatchObject({ user: '1000', network: 'none' })
    expect(f.store.getEnvironment('test')).not.toBeNull()
    await until(() => [...f.docker.containers.values()].some((item) => item.spec.volume === volume))
    await until(() => f.lifecycle.environment('test')?.lifecycle === 'running')
    expect(f.backups.status().environments.find((item) => item.environmentId === 'test')?.lastRun).toMatchObject({
      kind: 'restore',
      state: 'succeeded',
    })
  })

  it('removes the volume it made when restic fails, and no environment appears', async () => {
    const f = await bots({ restore: { exitCode: 1, stderr: 'Fatal: unable to open repository' } })
    const run = await f.restore()
    await f.backups.idle()
    expect(f.store.backupRun(run.id)).toMatchObject({ state: 'failed', error: { code: 'failed' } })
    expect(await f.docker.volumeExists(environmentVolumeName('test'))).toBe(false)
    expect(f.store.getEnvironment('test')).toBeNull()
  })

  it('refuses a backup that cannot come back here', async () => {
    const taken = await bots({}, true)
    await expect(taken.restore()).rejects.toMatchObject({ code: 'CONFLICT' })
    const full = workspaces({ find: { exitCode: 0, stdout: '/mnt/root/host/notes.md\n' } })
    await expect(full.restore()).rejects.toThrow('not empty')
    expect(full.restic('restore')).toHaveLength(0)
  })

  it("restores a workspaces environment's projects into its own folder", async () => {
    const f = workspaces()
    await f.restore()
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ state: 'succeeded' })
    expect(f.docker.oneShots[0].command.at(-1)).toBe('/mnt/root/host')
    const restores = f.restic('restore')
    expect(restores.map((spec) => spec.command.slice(2))).toEqual([
      ['--json', `${SNAPSHOT}:/home/bot`, '--target', '/home/bot'],
      ['--json', `${SNAPSHOT}:/srv/maestrly/host`, '--target', '/srv/maestrly/host'],
    ])
    expect(restores[1].mounts).toContainEqual({
      type: 'bind',
      source: '/srv/maestrly/host',
      target: '/srv/maestrly/host',
      readOnly: false,
    })
    expect(f.store.getEnvironment('host')).toMatchObject({ kind: 'workspaces', hostFolder: 'own' })
  })

  it('keeps the files already in the folder when the owner chose to', async () => {
    const f = workspaces({ find: { exitCode: 0, stdout: '/mnt/root/host/notes.md\n' } })
    await f.restore(true)
    await f.backups.idle()
    expect(f.backups.runs()[0]).toMatchObject({ state: 'succeeded' })
    expect(f.restic('restore')).toHaveLength(1)
  })

  it('removes the volume of a restore a restart interrupted', async () => {
    const f = workspaces()
    const volume = environmentVolumeName('ghost')
    await f.docker.volumeCreate(volume)
    f.store.saveBackupRun(
      backupRun('interrupted', {
        kind: 'restore',
        environmentId: 'ghost',
        state: 'running',
        phase: 'download',
        finishedAt: null,
        volumeName: volume,
      })
    )
    await f.backups.start()
    f.backups.stop()
    expect(await f.docker.volumeExists(volume)).toBe(false)
    expect(f.store.backupRun('interrupted')).toMatchObject({ state: 'failed', error: { code: 'interrupted' } })
  })
})
