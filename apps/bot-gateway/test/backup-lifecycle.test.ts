import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackupSlice, type BackupSlice } from '../src/backups/slice.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle, environmentVolumeName } from '../src/lifecycle.js'
import { Store } from '../src/store.js'
import { environmentRecord, environmentSecrets, memoryRecord, routineRecord } from './backup-fixtures.js'
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
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out')
}
const join = (name: string, environmentId: string, talksTo: string[] = []) => ({
  name,
  instructions: '',
  ceiling: 'ask' as const,
  talksTo,
  environmentId,
  idempotencyKey: randomUUID(),
})
const database = {
  snapshot: '.config/maestrly-app/.maestrly-backup-staging/maestrly-agents.db',
  live: '.config/maestrly-app/maestrly-agents.db',
}
function sliceOf(store: Store, environmentId: string): BackupSlice {
  return buildBackupSlice({
    store,
    environmentId,
    server: { id: store.serverId(), name: 'Server' },
    gatewayVersion: '1.0.0',
    now: new Date().toISOString(),
    database,
    projects: null,
  })
}
/** A gateway's records alone, for what needs no running instance; `workspacesRoot` is the server folder it mounts. */
function records(workspacesRoot: string | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-lifecycle-'))
  dirs.push(dir)
  const config = loadConfig({
    MAESTRLY_GATEWAY_DATA_DIR: dir,
    MAESTRLY_GATEWAY_PUBLIC_PORT: '1',
    MAESTRLY_GATEWAY_INTERNAL_PORT: '2',
    ...(workspacesRoot ? { MAESTRLY_GATEWAY_WORKSPACES_ROOT: workspacesRoot } : {}),
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
  return { store, docker, lifecycle, config }
}

describe('what a backup reads', () => {
  it('backs up a running environment only once it can copy its database', async () => {
    const older = await harness(Date.now, { environments: true })
    expect(older.lifecycle.backupSource('test')).toMatchObject({ running: true, eligibility: 'update-environment' })
    const current = await harness(Date.now, { environments: true, instanceCapabilities: ['environment-backup'] })
    expect(current.lifecycle.backupSource('test')).toMatchObject({
      running: true,
      eligibility: 'ok',
      projects: null,
    })
    expect(current.lifecycle.backupSource('missing')).toBeNull()
    await current.lifecycle.archiveEnvironment('test')
    expect(current.lifecycle.backupSource('test')?.eligibility).toBe('archived')
  })

  it("leaves out an environment that mounts the server's shared folder", () => {
    const { store, lifecycle } = records('/srv/maestrly')
    store.insertEnvironment(
      environmentRecord('legacy', { kind: 'workspaces', hostFolder: 'shared', lifecycle: 'stopped' }),
      environmentSecrets('legacy')
    )
    store.insertEnvironment(
      environmentRecord('own', { kind: 'workspaces', hostFolder: 'own', lifecycle: 'stopped' }),
      environmentSecrets('own')
    )
    store.insertEnvironment(environmentRecord('busy', { lifecycle: 'starting' }), environmentSecrets('busy'))
    expect(lifecycle.backupSource('legacy')?.eligibility).toBe('shared-folder')
    expect(lifecycle.backupSource('own')).toMatchObject({
      eligibility: 'ok',
      running: false,
      projects: '/srv/maestrly/own',
    })
    expect(lifecycle.backupSource('busy')?.eligibility).toBe('not-ready')
  })

  it('makes a due backup wait for an update', () => {
    const { store, lifecycle } = records(null)
    store.insertEnvironment(environmentRecord('work', { lifecycle: 'stopped' }), environmentSecrets('work'))
    expect(lifecycle.backupDeferred('work')).toBe(false)
    store.updateEnvironment('work', { updateRequestedAt: new Date().toISOString() })
    expect(lifecycle.backupDeferred('work')).toBe(true)
  })

  it('lets a backup end before deleting the environment files', async () => {
    const h = await harness(Date.now, { environments: true, instanceCapabilities: ['environment-backup'] })
    const order: string[] = []
    h.lifecycle.beforeEnvironmentPurge = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('backup ended ' + id)
    }
    const remove = h.docker.volumeRemove.bind(h.docker)
    h.docker.volumeRemove = async (name) => {
      order.push('volume removed')
      await remove(name)
    }
    await h.lifecycle.archiveEnvironment('test')
    await h.lifecycle.purgeEnvironment('test')
    expect(order).toEqual(['backup ended test', 'volume removed'])
  })
})

describe('restoring an environment', () => {
  it('names what keeps a backup from coming back', async () => {
    const h = await harness(Date.now, { environments: true, instanceCapabilities: ['environment-backup'] })
    const slice = sliceOf(h.store, 'test')
    expect(h.lifecycle.restoreProblems(slice)).toEqual({
      problems: ['environment-taken', 'bot-taken'],
      takenBots: ['test'],
      projectsPath: null,
    })
    await h.lifecycle.archiveEnvironment('test')
    await h.lifecycle.purgeEnvironment('test')
    expect(h.lifecycle.restoreProblems(slice).problems).toEqual([])
    // A bot of the same id, archived on its own in another environment, still takes the id.
    const other = h.lifecycle.createEnvironment({ name: 'Other', memoryLimitBytes: null })
    await until(() => h.lifecycle.environment(other.id)?.lifecycle === 'running')
    const again = h.lifecycle.create(join('Test', other.id))
    expect(again.id).toBe('test')
    await until(() => h.lifecycle.get('test')?.lifecycle === 'running')
    await h.lifecycle.archive('test')
    expect(h.lifecycle.restoreProblems(slice)).toEqual({
      problems: ['bot-taken'],
      takenBots: ['test'],
      projectsPath: null,
    })
  })

  it('needs the workspaces folder the projects were in', () => {
    const { store, lifecycle } = records(null)
    store.insertEnvironment(
      environmentRecord('host', { kind: 'workspaces', hostFolder: 'own', lifecycle: 'stopped' }),
      environmentSecrets('host')
    )
    const slice = { ...sliceOf(store, 'host'), files: { database: null, projects: '/srv/maestrly/host' } }
    store.archiveEnvironment('host')
    store.purgeEnvironment('host')
    expect(lifecycle.restoreProblems(slice).problems).toEqual(['workspaces-root-missing'])
    const elsewhere = records('/data/projects')
    expect(elsewhere.lifecycle.restoreProblems(slice).problems).toEqual(['workspaces-root-different'])
    const same = records('/srv/maestrly/')
    expect(same.lifecycle.restoreProblems(slice)).toEqual({
      problems: [],
      takenBots: [],
      projectsPath: '/srv/maestrly/host',
    })
  })

  it('brings the environment back with its ids, slots, routines, peers and memories', async () => {
    const h = await harness(Date.now, { environments: true, instanceCapabilities: ['environment-backup'] })
    h.lifecycle.create(join('Ana', 'test', ['test']))
    await until(() => h.lifecycle.get('ana')?.lifecycle === 'running')
    h.store.saveRoutine(routineRecord('daily', 'ana', { nextRunAt: '2026-01-01T09:00:00.000Z' }))
    h.store.saveOwnerMemory(memoryRecord('own', 'test'))
    h.store.saveOwnerMemory(memoryRecord('global', null))
    const before = {
      secrets: h.store.environmentSecrets('test')!,
      slots: [h.store.botSlot('test'), h.store.botSlot('ana')],
    }
    const slice = sliceOf(h.store, 'test')
    // A peer that is not on the server the backup comes back to.
    slice.bots[1].bot.talksTo = [...slice.bots[1].bot.talksTo, 'ghost']
    await h.lifecycle.archiveEnvironment('test')
    await h.lifecycle.purgeEnvironment('test')
    expect(h.store.ownerMemoryById('own')).toBeNull()
    expect(h.store.ownerMemoryById('global')).not.toBeNull()

    const target = await h.lifecycle.createRestoreTarget(slice, false)
    expect(target).toEqual({ volumeName: environmentVolumeName('test'), projects: null })
    await expect(h.lifecycle.createRestoreTarget(slice, false)).rejects.toMatchObject({ code: 'CONFLICT' })
    const environment = h.lifecycle.adoptRestoredEnvironment(slice)
    expect(environment).toMatchObject({ id: 'test', lifecycle: 'creating' })
    expect([h.store.botSlot('test'), h.store.botSlot('ana')]).toEqual(before.slots)
    const secrets = h.store.environmentSecrets('test')!
    expect(secrets.controlToken).not.toBe(before.secrets.controlToken)
    expect(secrets.keyringPassword).toBe(before.secrets.keyringPassword)
    expect(h.store.getBot('ana')!.talksTo).toEqual(['test'])
    expect(h.store.getBot('test')!.talksTo).toEqual(['ana'])
    const routine = h.store.routineById('daily')!
    expect(Date.parse(routine.nextRunAt!)).toBeGreaterThan(Date.now())
    expect(h.store.ownerMemoryById('own')).toMatchObject({ environmentId: 'test' })
    expect(h.store.ownerMemories().filter((entry) => entry.id === 'global')).toHaveLength(1)
    await until(() =>
      [...h.docker.containers.values()].some((item) => item.spec.volume === environmentVolumeName('test'))
    )
    await until(() => h.lifecycle.environment('test')?.lifecycle === 'running')
  })

  it('removes only the volume it created when a restore fails', async () => {
    const { lifecycle, docker } = records('/srv/maestrly')
    const slice = { ...sliceOf(seeded(lifecycle), 'host'), files: { database: null, projects: '/srv/maestrly/host' } }
    lifecycle.store.archiveEnvironment('host')
    lifecycle.store.purgeEnvironment('host')
    const target = await lifecycle.createRestoreTarget(slice, true)
    expect(target).toEqual({ volumeName: environmentVolumeName('host'), projects: '/srv/maestrly/host' })
    expect(docker.oneShots.at(-1)?.command).toEqual([
      'install',
      '-d',
      '-o',
      '1000',
      '-g',
      '1000',
      '-m',
      '0750',
      '--',
      '/mnt/root/host',
    ])
    await lifecycle.discardRestoreTarget(target.volumeName)
    expect(await docker.volumeExists(target.volumeName)).toBe(false)
    // A failed folder leaves no volume behind.
    docker.oneShotExitCode = 1
    await expect(lifecycle.createRestoreTarget(slice, true)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' })
    expect(await docker.volumeExists(target.volumeName)).toBe(false)
  })
})

function seeded(lifecycle: Lifecycle): Store {
  lifecycle.store.insertEnvironment(
    environmentRecord('host', { kind: 'workspaces', hostFolder: 'own', lifecycle: 'stopped' }),
    environmentSecrets('host')
  )
  return lifecycle.store
}
