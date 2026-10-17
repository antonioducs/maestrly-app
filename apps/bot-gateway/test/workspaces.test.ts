import { randomUUID } from 'node:crypto'
import { toWire } from '@maestrly/artifact-host'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DockerError } from '../src/docker.js'
import { InstanceClient } from '../src/instance.js'
import { GatewayError } from '../src/errors.js'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>
const NEW_IMAGE = 'sha256:' + 'c'.repeat(64)

/** A gateway whose instances are environment instances that can also host workspaces. */
async function setup(options: { root?: string | null; hostCapable?: boolean } = {}) {
  const h = await harness(Date.now, { environments: true })
  if (options.hostCapable !== false) h.instance.provisioning.capabilities.push('workspaces-host')
  ;(h.lifecycle.config as { workspacesRoot: string | null }).workspacesRoot = options.root ?? null
  return h
}
async function settled(h: Harness, id: string, lifecycle: string) {
  for (let i = 0; i < 200 && h.lifecycle.environment(id)?.lifecycle !== lifecycle; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(h.lifecycle.environment(id)?.lifecycle).toBe(lifecycle)
}
async function workspaces(h: Harness) {
  const created = h.lifecycle.createEnvironment({ name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces' })
  await settled(h, created.id, 'running')
  return created.id
}
const containerOf = (h: Harness, environmentId: string) => {
  const name = h.store.getEnvironment(environmentId)!.containerName
  return [...h.docker.containers.values()].find((item) => item.name === name)
}
function codeOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof GatewayError ? error.code : 'NOT_A_GATEWAY_ERROR'
  }
}
const json = (response: Response) => response.json() as Promise<Record<string, any>>

describe('workspaces environments', () => {
  it('starts Maestrly in server mode, with no bot mode, no bot and no host directory by default', async () => {
    const h = await setup()
    const installsBefore = h.instance.installs.length
    const id = await workspaces(h)
    expect(id).toBe('workspaces')
    const spec = containerOf(h, id)!.spec
    expect(spec.env).toContain('MAESTRLY_SERVER_MODE=1')
    expect(spec.env).toContain('MAESTRLY_ENVIRONMENT_ID=workspaces')
    expect(spec.env.some((entry) => entry.startsWith('MAESTRLY_BOT_MODE='))).toBe(false)
    expect(spec.env.some((entry) => entry.startsWith('MAESTRLY_WORKSPACES_ROOT='))).toBe(false)
    expect(spec.env.some((entry) => entry.startsWith('MAESTRLY_BOT_GATEWAY_TOKEN='))).toBe(false)
    expect(spec.binds).toBeUndefined()
    expect(spec.volume).toBe('maestrly-env-workspaces-home')
    expect(spec.labels['org.maestrly.fleet.workspaces-root']).toBe('')
    expect(h.lifecycle.environment(id)).toMatchObject({ kind: 'workspaces', botIds: [], lifecycle: 'running' })
    expect(h.instance.installs).toHaveLength(installsBefore)
    // Its chats publish artifacts with a token of its own.
    const hostToken = h.store.hostGatewaySecrets(id)!.gatewayToken
    expect(spec.env).toContain('MAESTRLY_HOST_GATEWAY_TOKEN=' + hostToken)
    expect(spec.labels['org.maestrly.fleet.host-token']).toBe('1')
    // A bots environment keeps bot mode and carries no workspaces label.
    const bots = containerOf(h, h.bot.environmentId!)!.spec
    expect(bots.env).toContain('MAESTRLY_BOT_MODE=1')
    expect(bots.env.some((entry) => entry.startsWith('MAESTRLY_SERVER_MODE='))).toBe(false)
    expect(bots.env.some((entry) => entry.startsWith('MAESTRLY_HOST_GATEWAY_TOKEN='))).toBe(false)
    expect('org.maestrly.fleet.workspaces-root' in bots.labels).toBe(false)
    expect('org.maestrly.fleet.host-token' in bots.labels).toBe(false)
    expect(h.store.hostGatewaySecrets(h.bot.environmentId!)).toBeNull()
  })

  it('gives a container from before host tokens its token when it restarts, and keeps it afterwards', async () => {
    const h = await setup()
    const id = await workspaces(h)
    // As the gateway that created it left it: no token issued, no label.
    h.store.db.exec('DELETE FROM host_secrets')
    const before = containerOf(h, id)!
    delete before.labels['org.maestrly.fleet.host-token']
    await h.lifecycle.restartEnvironment(id)
    const after = containerOf(h, id)!
    expect(after).not.toBe(before)
    const hostToken = h.store.hostGatewaySecrets(id)!.gatewayToken
    expect(after.spec.env).toContain('MAESTRLY_HOST_GATEWAY_TOKEN=' + hostToken)
    expect(h.lifecycle.environment(id)?.lifecycle).toBe('running')
    // Restarting a container that has its token keeps both.
    await h.lifecycle.restartEnvironment(id)
    expect(containerOf(h, id)).toBe(after)
    expect(h.store.hostGatewaySecrets(id)!.gatewayToken).toBe(hostToken)
  })

  it('mounts a server folder of its own at the same path, created for the user it runs as', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    const id = await workspaces(h)
    const spec = containerOf(h, id)!.spec
    expect(spec.binds).toEqual([{ source: '/srv/maestrly/workspaces', target: '/srv/maestrly/workspaces' }])
    expect(spec.env).toContain('MAESTRLY_WORKSPACES_ROOT=/srv/maestrly/workspaces')
    expect(spec.labels['org.maestrly.fleet.workspaces-root']).toBe('/srv/maestrly/workspaces')
    // The gateway does not mount the server folder: a short-lived container with no network creates the subfolder.
    expect(h.docker.oneShots).toEqual([
      {
        image: h.lifecycle.config.botImage,
        command: ['install', '-d', '-o', '1000', '-g', '1000', '-m', '0750', '--', '/mnt/root/workspaces'],
        user: '0',
        binds: [{ source: '/srv/maestrly', target: '/mnt/root' }],
        securityOpt: h.lifecycle.config.botSecurityOpt,
        capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
        labels: { 'org.maestrly.fleet.helper': 'host-folder' },
      },
    ])
    expect(h.lifecycle.environment(id)?.isolation).toEqual({
      network: 'own',
      folder: { mode: 'own', path: '/srv/maestrly/workspaces' },
      restartRequired: false,
    })
    // The folder belongs to the workspaces environment: a bots environment never gets one.
    expect(containerOf(h, h.bot.environmentId!)!.spec.binds).toBeUndefined()
    expect(h.lifecycle.environment(h.bot.environmentId!)?.isolation).toBeNull()
  })

  it('fails with a fixed message when its folder cannot be created', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    h.docker.oneShotExitCode = 1
    const created = h.lifecycle.createEnvironment({ name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, created.id, 'failed')
    expect(h.lifecycle.environment(created.id)?.setup).toEqual({
      step: 'failed',
      error: 'DOCKER_UNAVAILABLE',
      errorMessage: 'The folder of this environment could not be created on the server.',
    })
    expect(containerOf(h, created.id)).toBeUndefined()
  })

  it('replaces the container when the server gained a workspaces folder since it was created', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const before = containerOf(h, id)!
    expect(h.lifecycle.environment(id)?.isolation?.folder).toEqual({ mode: 'none', path: null })
    ;(h.lifecycle.config as { workspacesRoot: string | null }).workspacesRoot = '/srv/maestrly'
    expect(h.lifecycle.environment(id)?.isolation?.restartRequired).toBe(true)
    await h.lifecycle.restartEnvironment(id)
    const after = containerOf(h, id)!
    expect(after).not.toBe(before)
    expect(after.spec.binds).toEqual([{ source: '/srv/maestrly/workspaces', target: '/srv/maestrly/workspaces' }])
    expect(h.lifecycle.environment(id)).toMatchObject({ lifecycle: 'running', isolation: { restartRequired: false } })
  })

  it('hosts several workspaces environments, each on a network of its own, up to the limit', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    const personal = h.lifecycle.createEnvironment({
      name: 'Personal',
      memoryLimitBytes: null,
      kind: 'workspaces',
      tint: '#4c9a87',
    })
    const company = h.lifecycle.createEnvironment({ name: 'Company A', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, personal.id, 'running')
    await settled(h, company.id, 'running')
    expect(h.lifecycle.environment(personal.id)?.tint).toBe('#4c9a87')
    const fleet = h.lifecycle.config.network
    for (const id of [personal.id, company.id]) {
      const spec = containerOf(h, id)!.spec
      const network = fleet + '-env-' + id
      expect(spec.network).toBe(network)
      expect(spec.labels['org.maestrly.fleet.network']).toBe(network)
      expect(spec.binds).toEqual([{ source: '/srv/maestrly/' + id, target: '/srv/maestrly/' + id }])
      expect(h.docker.networkLabels.get(network)).toEqual({
        'org.maestrly.fleet.managed': 'true',
        'org.maestrly.fleet.environment-id': id,
      })
      // Only the gateway joins it, under the host name the environment calls it by.
      expect([...h.docker.networkAttachments.get(network)!]).toEqual(['maestrly-bot-gateway'])
      expect(h.lifecycle.environment(id)?.isolation?.network).toBe('own')
    }
    expect(h.lifecycle.isolatedNetworks().sort()).toEqual([fleet + '-env-' + company.id, fleet + '-env-' + personal.id])
    // Bots environments stay on the fleet network.
    expect(containerOf(h, h.bot.environmentId!)!.spec.network).toBe(fleet)

    for (let index = 2; index < 8; index++)
      h.lifecycle.createEnvironment({ name: 'Scope ' + index, memoryLimitBytes: null, kind: 'workspaces' })
    const ninth = () => h.lifecycle.createEnvironment({ name: 'Ninth', memoryLimitBytes: null, kind: 'workspaces' })
    expect(codeOf(ninth)).toBe('CONFLICT')
    // Bots environments are not limited by it.
    expect(h.lifecycle.createEnvironment({ name: 'More bots', memoryLimitBytes: null }).kind).toBe('bots')
    // An archived one does not count, but it cannot come back while the server is full.
    await h.lifecycle.archiveEnvironment(company.id)
    await settled(h, ninth().id, 'running')
    expect(codeOf(() => h.lifecycle.restoreEnvironment(company.id))).toBe('CONFLICT')
    expect(h.store.getEnvironment(company.id)?.archivedAt).not.toBeNull()
  })

  it('takes the network away when archived and brings it back when restored, keeping the folder', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    const id = await workspaces(h)
    const network = h.lifecycle.config.network + '-env-' + id
    await h.lifecycle.archiveEnvironment(id)
    expect(h.docker.networks.has(network)).toBe(false)
    expect(h.lifecycle.isolatedNetworks()).toEqual([])
    h.lifecycle.restoreEnvironment(id)
    await settled(h, id, 'running')
    expect(h.docker.networks.has(network)).toBe(true)
    expect(containerOf(h, id)!.spec.network).toBe(network)
    await h.lifecycle.archiveEnvironment(id)
    const helpers = h.docker.oneShots.length
    await h.lifecycle.purgeEnvironment(id)
    expect(h.docker.networks.has(network)).toBe(false)
    expect(h.docker.volumes.has('maestrly-env-' + id + '-home')).toBe(false)
    // Its folder holds the owner's files: nothing runs to remove it.
    expect(h.docker.oneShots).toHaveLength(helpers)
  })

  it('rejoins the network of its environments after the gateway was recreated', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const network = h.lifecycle.config.network + '-env-' + id
    // A new gateway container starts on the fleet network only.
    h.docker.networkAttachments.get(network)!.clear()
    await h.lifecycle.stopEnvironment(id)
    await h.lifecycle.startEnvironment(id)
    expect([...h.docker.networkAttachments.get(network)!]).toEqual(['maestrly-bot-gateway'])

    h.docker.networkAttachments.get(network)!.clear()
    await h.lifecycle.reconcile()
    expect([...h.docker.networkAttachments.get(network)!]).toEqual(['maestrly-bot-gateway'])
    expect(h.lifecycle.environment(id)?.lifecycle).toBe('running')
  })

  it("fails with a fixed message when it cannot find the gateway's container", async () => {
    const h = await setup()
    h.lifecycle.locateGateway = async () => null
    const created = h.lifecycle.createEnvironment({ name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, created.id, 'failed')
    expect(h.lifecycle.environment(created.id)?.setup.errorMessage).toBe(
      'The gateway could not join the network of this environment.'
    )
  })

  it('fails with a fixed message when Docker cannot create its network', async () => {
    const h = await setup()
    h.docker.networkCreateFailure = new DockerError(400, 'could not find an available address pool')
    const created = h.lifecycle.createEnvironment({ name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, created.id, 'failed')
    expect(h.lifecycle.environment(created.id)?.setup).toMatchObject({
      error: 'DOCKER_UNAVAILABLE',
      errorMessage: 'Docker could not create the network of this environment.',
    })
  })

  it('moves an environment from before scopes to its own network on restart, and to its own folder once asked', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    const id = await workspaces(h)
    const fleet = h.lifecycle.config.network
    // As the gateway before scopes left it: on the fleet network with the whole server folder, which schema 13 keeps.
    h.store.updateEnvironment(id, { hostFolder: 'shared' })
    await h.lifecycle.stopEnvironment(id)
    const legacy = containerOf(h, id)!
    h.docker.containers.delete(legacy.id)
    const legacyId = await h.docker.containerCreate({
      ...legacy.spec,
      network: fleet,
      binds: [{ source: '/srv/maestrly', target: '/srv/maestrly' }],
      labels: { ...legacy.spec.labels, 'org.maestrly.fleet.workspaces-root': '/srv/maestrly' },
    })
    delete h.docker.containers.get(legacyId)!.labels['org.maestrly.fleet.network']
    await h.docker.start(legacyId)
    await h.lifecycle.reconcile()
    expect(h.lifecycle.environment(id)?.isolation).toEqual({
      network: 'own',
      folder: { mode: 'shared', path: '/srv/maestrly' },
      restartRequired: true,
    })

    await h.lifecycle.restartEnvironment(id)
    const moved = containerOf(h, id)!
    expect(moved.spec.network).toBe(fleet + '-env-' + id)
    // Its workspaces keep their paths: the folder moves only when the owner asks.
    expect(moved.spec.binds).toEqual([{ source: '/srv/maestrly', target: '/srv/maestrly' }])
    expect(h.lifecycle.environment(id)?.isolation?.restartRequired).toBe(false)

    const patched = await h.lifecycle.patchEnvironment(id, { hostFolder: 'own' })
    expect(patched.isolation).toEqual({
      network: 'own',
      folder: { mode: 'own', path: '/srv/maestrly/' + id },
      restartRequired: true,
    })
    expect(containerOf(h, id)).toBe(moved)
    await h.lifecycle.restartEnvironment(id)
    expect(containerOf(h, id)!.spec.binds).toEqual([{ source: '/srv/maestrly/' + id, target: '/srv/maestrly/' + id }])
    expect(h.lifecycle.environment(id)?.isolation?.restartRequired).toBe(false)
  })

  it('refuses the settings of workspaces environments on a bots environment', async () => {
    const h = await setup()
    const bots = h.bot.environmentId!
    for (const input of [{ idleStopMinutes: 60 }, { hostFolder: 'own' as const }])
      await expect(h.lifecycle.patchEnvironment(bots, input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(
      codeOf(() => h.lifecycle.createEnvironment({ name: 'Team', memoryLimitBytes: null, idleStopMinutes: 60 }))
    ).toBe('INVALID_REQUEST')
    // A null idle stop is no setting at all, and the tint and CPU limit apply to any environment.
    expect(
      await h.lifecycle.patchEnvironment(bots, { idleStopMinutes: null, tint: '#c29a43', cpuLimit: 2 })
    ).toMatchObject({ tint: '#c29a43', cpuLimit: 2, idleStopMinutes: null })
  })

  it('holds no bots', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const create = () =>
      h.lifecycle.create({
        name: 'Dev',
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        environmentId: id,
        idempotencyKey: randomUUID(),
      })
    expect(codeOf(create)).toBe('CONFLICT')
    expect(h.lifecycle.list().map((bot) => bot.id)).toEqual([h.bot.id])
    expect(h.lifecycle.environment(id)?.botIds).toEqual([])
    const response = await h.request('POST', '/v1/bots', {
      name: 'Dev',
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId: id,
      idempotencyKey: randomUUID(),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).message).toBe('Workspaces environments hold no bots.')
  })

  it('fails on an image that cannot host workspaces, naming what to do', async () => {
    const h = await setup({ hostCapable: false })
    const created = h.lifecycle.createEnvironment({ name: 'Workspaces', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, created.id, 'failed')
    expect(h.lifecycle.environment(created.id)?.setup).toMatchObject({
      step: 'failed',
      error: 'INSTANCE_UNAVAILABLE',
      errorMessage: 'This bot image cannot host workspaces. Update the server.',
    })
  })

  it('applies a scheduled update only once no chat is running', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const before = containerOf(h, id)!
    h.docker.setImage(h.lifecycle.config.botImage, NEW_IMAGE)
    h.instance.provisioning.busy = true
    const view = await h.lifecycle.scheduleUpdate(id)
    expect(view.update).toMatchObject({ available: true, pendingSince: expect.any(String) })
    await h.lifecycle.checkUpdates()
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, id)).toBe(before)
    expect(h.store.getEnvironment(id)?.updateRequestedAt).not.toBeNull()

    h.instance.provisioning.busy = false
    await h.lifecycle.checkUpdates()
    const after = containerOf(h, id)!
    expect(after).not.toBe(before)
    expect(after.imageId).toBe(NEW_IMAGE)
    expect(h.store.getEnvironment(id)).toMatchObject({ lifecycle: 'running', updateRequestedAt: null })
    expect(after.spec.env).toContain('MAESTRLY_SERVER_MODE=1')
  })

  it('updates at once when its Maestrly does not say whether it is busy', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const before = containerOf(h, id)!
    h.docker.setImage(h.lifecycle.config.botImage, NEW_IMAGE)
    h.instance.provisioning.busy = null
    await h.lifecycle.scheduleUpdate(id)
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, id)).not.toBe(before)
  })
})

describe('environment resources and idle stop', () => {
  it('limits CPUs from creation and changes the limit live, keeping the old one when Docker refuses', async () => {
    const h = await setup()
    const created = h.lifecycle.createEnvironment({
      name: 'Workspaces',
      memoryLimitBytes: null,
      kind: 'workspaces',
      cpuLimit: 2,
    })
    await settled(h, created.id, 'running')
    const container = containerOf(h, created.id)!
    expect(container.spec.nanoCpus).toBe(2_000_000_000)
    expect((await h.lifecycle.patchEnvironment(created.id, { cpuLimit: 3.5 })).cpuLimit).toBe(3.5)
    expect(h.docker.cpuUpdates).toEqual([{ id: container.id, nanoCpus: 3_500_000_000 }])
    // Null lifts the limit, which Docker reads from 0.
    expect((await h.lifecycle.patchEnvironment(created.id, { cpuLimit: null })).cpuLimit).toBeNull()
    expect(h.docker.cpuUpdates.at(-1)).toEqual({ id: container.id, nanoCpus: 0 })
    h.docker.cpuUpdateFailure = new DockerError(400, 'Range of CPUs is from 0.01 to 2.00')
    await expect(h.lifecycle.patchEnvironment(created.id, { cpuLimit: 8 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Docker could not change the CPU limit',
    })
    expect(h.lifecycle.environment(created.id)?.cpuLimit).toBeNull()
    // A recreated container keeps the limit.
    h.docker.cpuUpdateFailure = null
    await h.lifecycle.patchEnvironment(created.id, { cpuLimit: 1 })
    h.docker.setImage(h.lifecycle.config.botImage, NEW_IMAGE)
    await h.lifecycle.restartEnvironment(created.id)
    expect(containerOf(h, created.id)!.spec.nanoCpus).toBe(1_000_000_000)
  })

  it('stops a workspaces environment once nobody used it for its idle stop, and only then', async () => {
    const h = await setup()
    const created = h.lifecycle.createEnvironment({
      name: 'Workspaces',
      memoryLimitBytes: null,
      kind: 'workspaces',
      idleStopMinutes: 30,
    })
    await settled(h, created.id, 'running')
    let connections = 1
    h.lifecycle.hostConnections = () => connections
    h.instance.provisioning.busy = false
    const minute = 60_000
    const start = Date.now()
    await h.lifecycle.checkIdle(start)
    await h.lifecycle.checkIdle(start + 60 * minute)
    expect(h.lifecycle.environment(created.id)?.lifecycle).toBe('running')
    // Once the last computer disconnects, the idle time counts from when it was last seen.
    connections = 0
    await h.lifecycle.checkIdle(start + 89 * minute)
    expect(h.lifecycle.environment(created.id)?.lifecycle).toBe('running')
    // A running chat is use too.
    h.instance.provisioning.busy = true
    await h.lifecycle.checkIdle(start + 95 * minute)
    h.instance.provisioning.busy = false
    await h.lifecycle.checkIdle(start + 124 * minute)
    expect(h.lifecycle.environment(created.id)?.lifecycle).toBe('running')
    await h.lifecycle.checkIdle(start + 125 * minute)
    expect(h.lifecycle.environment(created.id)?.lifecycle).toBe('stopped')
    const stopped = h.store.activity().filter((entry) => entry.kind === 'environment_stopped')
    expect(stopped.map((entry) => [entry.environmentId, entry.data])).toEqual([[created.id, { idle: true }]])
  })

  it('never stops an environment without an idle stop, one that does not answer, or a stopped one', async () => {
    const h = await setup()
    const plain = await workspaces(h)
    const silent = h.lifecycle.createEnvironment({
      name: 'Silent',
      memoryLimitBytes: null,
      kind: 'workspaces',
      idleStopMinutes: 15,
    })
    await settled(h, silent.id, 'running')
    h.lifecycle.hostConnections = () => 0
    h.instance.provisioning.busy = false
    const minute = 60_000
    const start = Date.now()
    await h.lifecycle.checkIdle(start)
    // An idle stop set later counts from when it was set.
    await h.lifecycle.patchEnvironment(plain, { idleStopMinutes: 15 })
    await h.lifecycle.patchEnvironment(plain, { idleStopMinutes: null })
    // Its Maestrly no longer answers: it may be busy, so it is left running.
    ;(h.lifecycle as { instance: unknown }).instance = (id: string, secret: string) =>
      new InstanceClient(id, secret, 'http://127.0.0.1:1')
    await h.lifecycle.checkIdle(start + 60 * minute)
    expect(h.lifecycle.environment(plain)?.lifecycle).toBe('running')
    expect(h.lifecycle.environment(silent.id)?.lifecycle).toBe('running')
  })
})

describe('workspaces environment routes', () => {
  it('moves host files only for a paired device, and only to a running workspaces environment', async () => {
    const h = await setup()
    const stat = '/v1/environments/' + h.bot.environmentId + '/host-files/stat'
    const anonymous = await h.request('POST', stat, { path: '/a' }, false, { 'X-Maestrly-Fleet-Protocol': '1' })
    expect(anonymous.status).toBe(401)
    const bots = await h.request('POST', stat, { path: '/a' })
    expect(bots.status).toBe(409)
    expect((await json(bots)).message).toBe('The workspaces environment is not running.')
    const meta = await json(await h.request('GET', '/v1/meta'))
    expect(meta.features).toContain('host-files')
    expect(meta.moreFeatures).toContain('host-files-folders')
  })

  it("passes a workspaces environment's editor only to a paired device", async () => {
    const h = await setup()
    const editor = '/v1/environments/' + h.bot.environmentId + '/editor/'
    expect((await fetch(h.origin + editor, { headers: { 'X-Maestrly-Fleet-Protocol': '1' } })).status).toBe(401)
    expect((await fetch(h.origin + editor, { headers: { Authorization: h.publicHeaders.Authorization } })).status).toBe(
      426
    )
    expect(
      (await fetch(h.origin + editor, { headers: { ...h.publicHeaders, Origin: 'http://127.0.0.1:41234' } })).status
    ).toBe(403)
    const bots = await fetch(h.origin + editor, { headers: h.publicHeaders })
    expect(bots.status).toBe(409)
    expect((await json(bots)).message).toBe('The workspaces environment is not running.')
    const upgrade = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(h.origin.replace('http', 'ws') + editor + 'stable-x', { headers })
        socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
        socket.on('error', () => undefined)
      })
    expect(await upgrade({ 'X-Maestrly-Fleet-Protocol': '1' })).toBe(401)
    expect(await upgrade(h.publicHeaders)).toBe(409)
    expect((await json(await h.request('GET', '/v1/meta'))).features).toContain('host-editor')
  })

  it('advertises the feature and creates and lists a workspaces environment', async () => {
    const h = await setup()
    expect((await json(await h.request('GET', '/v1/meta'))).features).toContain('workspaces-host')
    const created = await h.request('POST', '/v1/environments', {
      name: 'Workspaces',
      kind: 'workspaces',
      idempotencyKey: randomUUID(),
    })
    expect(created.status).toBe(201)
    const environment = await json(created)
    expect(environment).toMatchObject({ id: 'workspaces', kind: 'workspaces', botIds: [] })
    await settled(h, environment.id, 'running')
    const listed = (await json(await h.request('GET', '/v1/environments'))).environments as Array<Record<string, any>>
    expect(listed.map((item) => [item.id, item.kind])).toEqual([
      [h.bot.environmentId, 'bots'],
      ['workspaces', 'workspaces'],
    ])
    expect((await json(await h.request('GET', '/v1/meta'))).features).toContain('workspaces-environments')
    const second = await h.request('POST', '/v1/environments', {
      name: 'Company',
      kind: 'workspaces',
      cpuLimit: 1.5,
      idleStopMinutes: 120,
      tint: '#9b65b6',
      idempotencyKey: randomUUID(),
    })
    expect(second.status).toBe(201)
    expect(await json(second)).toMatchObject({
      id: 'company',
      kind: 'workspaces',
      cpuLimit: 1.5,
      idleStopMinutes: 120,
      tint: '#9b65b6',
      isolation: { network: 'own', folder: { mode: 'none', path: null } },
    })
    await settled(h, 'company', 'running')
    expect(containerOf(h, 'company')!.spec.nanoCpus).toBe(1_500_000_000)
    const patched = await h.request('PATCH', '/v1/environments/company', { idleStopMinutes: null, hostFolder: 'own' })
    expect(await json(patched)).toMatchObject({ idleStopMinutes: null })
    for (const body of [{ cpuLimit: 0.3 }, { idleStopMinutes: 5 }, { tint: 'blue' }, { hostFolder: 'elsewhere' }])
      expect((await h.request('PATCH', '/v1/environments/company', body)).status).toBe(400)
    // A request without a kind still creates a bots environment, as older desktop apps send it.
    const bots = await json(await h.request('POST', '/v1/environments', { name: 'Team', idempotencyKey: randomUUID() }))
    expect(bots.kind).toBe('bots')
  })

  it('gives a bridge ticket only for a running workspaces environment', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const ticket = await h.request('POST', `/v1/environments/${id}/bridge-tickets`, {})
    expect(ticket.status).toBe(201)
    const body = await json(ticket)
    expect(body.path).toBe('/v1/bridge?ticket=' + body.ticket)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const bots = await h.request('POST', `/v1/environments/${h.bot.environmentId}/bridge-tickets`, {})
    expect(bots.status).toBe(409)
    expect((await h.request('POST', '/v1/environments/nope/bridge-tickets', {})).status).toBe(404)
    await h.lifecycle.stopEnvironment(id)
    const stopped = await h.request('POST', `/v1/environments/${id}/bridge-tickets`, {})
    expect((await json(stopped)).code).toBe('BOT_NOT_RUNNING')
    // The bridge itself is a WebSocket upgrade; a plain request is refused, and a device token is required.
    expect((await h.request('GET', '/v1/bridge')).status).toBe(400)
    const unauthenticated = await fetch(h.origin + `/v1/environments/${id}/bridge-tickets`, {
      method: 'POST',
      headers: { 'X-Maestrly-Fleet-Protocol': '1', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(unauthenticated.status).toBe(401)
  })

  it('routes the bridge upgrade to the environment, by ticket alone', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const upgrade = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number | 'open'>((resolve, reject) => {
        const socket = new WebSocket(h.origin.replace('http', 'ws') + path, { headers })
        socket.once('open', () => {
          socket.terminate()
          resolve('open')
        })
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
        socket.once('error', reject)
      })
    const ticket = async () => (await json(await h.request('POST', `/v1/environments/${id}/bridge-tickets`, {}))).path
    // The test's environment has no container to reach: the gateway tried it, which a wrong route would not.
    expect(await upgrade(await ticket())).toBe(502)
    expect(await upgrade('/v1/bridge?ticket=forged')).toBe(403)
    expect(await upgrade(await ticket(), { Origin: 'https://example.com' })).toBe(403)
    // A phone names the Origin its WebSocket sends; the upgrade may carry that one only.
    const phoneTicket = async (origin: string) =>
      (await json(await h.request('POST', `/v1/environments/${id}/bridge-tickets`, { origin }))).path
    expect(await upgrade(await phoneTicket('https://bots.example.dev'), { Origin: 'https://bots.example.dev' })).toBe(
      502
    )
    expect(await upgrade(await phoneTicket('https://bots.example.dev'), { Origin: 'https://evil.example' })).toBe(403)
    expect(
      (await h.request('POST', `/v1/environments/${id}/bridge-tickets`, { origin: 'https://bots.example.dev/path' }))
        .status
    ).toBe(400)
    // Revoking the device spends its tickets.
    const path = await ticket()
    await h.request('DELETE', '/v1/devices/self')
    expect(await upgrade(path)).toBe(403)
  })
})

describe('workspaces environment artifacts', () => {
  const call = (method: string, args: unknown[]) => ({ method, args: toWire(args) })
  const bundle = (workspaceId: string | null) => ({
    title: 'Synthetic page',
    owner: { kind: 'local', id: 'spoof' },
    origin: { workspaceId, conversationId: 'conversation', conversationTitle: 'Chat' },
    files: [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Synthetic</h1>') }],
  })
  const hostHeaders = (h: Harness, id: string) => ({
    'X-Maestrly-Fleet-Protocol': '1',
    Authorization: 'Bearer ' + h.store.hostGatewaySecrets(id)!.gatewayToken,
    'Content-Type': 'application/json',
  })

  it('publishes as the device its environment is, with only the agent methods on its own artifacts', async () => {
    const h = await setup()
    const id = await workspaces(h)
    await h.artifacts.update({ enabled: true })
    await h.lifecycle.patch(h.bot.id, { publishArtifacts: true })
    const host = (route: 'admin' | 'upload', method: string, args: unknown[]) =>
      h.request('POST', '/internal/v1/artifacts/' + route, call(method, args), true, hostHeaders(h, id)).then(json)

    const own = await host('upload', 'create', [bundle('ws-1')])
    expect(own).toMatchObject({ ok: true, value: { ownerKind: 'device', ownerId: id, workspaceId: 'ws-1' } })
    const device = await json(await h.request('POST', '/v1/artifacts/upload', call('create', [bundle(null)])))
    const bot = await json(
      await h.request('POST', '/internal/v1/artifacts/upload', call('create', [bundle(null)]), true)
    )
    expect([device.ok, bot.ok]).toEqual([true, true])

    const ids = (result: Record<string, any>) => result.value.map((item: { id: string }) => item.id)
    expect(ids(await host('admin', 'list', [{ ownerKind: 'bot', ownerId: h.bot.id }]))).toEqual([own.value.id])
    expect(ids(await host('admin', 'list', [{ workspaceId: 'ws-1' }]))).toEqual([own.value.id])
    expect(ids(await host('admin', 'list', [{ workspaceId: 'ws-2' }]))).toEqual([])
    expect(await host('admin', 'get', [own.value.id])).toMatchObject({ ok: true, value: { id: own.value.id } })
    for (const other of [device.value.id, bot.value.id])
      expect(await host('admin', 'get', [other])).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const update = await host('upload', 'update', [
      { id: device.value.id, baseVersion: 1, change: { kind: 'replace', files: bundle(null).files } },
    ])
    expect(update).toMatchObject({ ok: false, error: { code: 'not_found' } })
    // The owner's controls stay with the owner's computers.
    for (const method of ['delete', 'mintOwnerTicket', 'setSharing', 'listEvents', 'exportArtifact'])
      expect(await host('admin', method, [own.value.id]), method).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
    // The owner's computers see it with the rest.
    const listed = await json(await h.request('POST', '/v1/artifacts/admin', call('list', [])))
    expect(ids(listed)).toContain(own.value.id)
  })

  it('reaches nothing else, follows the server setting and stops working once its environment is archived', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const headers = hostHeaders(h, id)
    const list = () => h.request('POST', '/internal/v1/artifacts/admin', call('list', []), true, headers)
    expect(await json(await list())).toMatchObject({ ok: false, error: { details: { reason: 'server_off' } } })
    await h.artifacts.update({ enabled: true })
    expect(await json(await list())).toMatchObject({ ok: true, value: [] })

    for (const route of ['/internal/v1/peers', '/internal/v1/owner-memory'])
      expect((await h.request('GET', route, undefined, true, headers)).status, route).toBe(403)
    expect((await h.request('POST', '/v1/artifacts/admin', call('list', []), false, headers)).status).toBe(401)
    expect(
      (
        await h.request('POST', '/internal/v1/artifacts/admin', call('list', []), true, {
          ...headers,
          Authorization: 'Bearer forged',
        })
      ).status
    ).toBe(401)

    await h.lifecycle.archiveEnvironment(id)
    expect((await list()).status).toBe(401)
  })
})
