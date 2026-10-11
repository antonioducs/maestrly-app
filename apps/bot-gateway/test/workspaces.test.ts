import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
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
    // A bots environment keeps bot mode and carries no workspaces label.
    const bots = containerOf(h, h.bot.environmentId!)!.spec
    expect(bots.env).toContain('MAESTRLY_BOT_MODE=1')
    expect(bots.env.some((entry) => entry.startsWith('MAESTRLY_SERVER_MODE='))).toBe(false)
    expect('org.maestrly.fleet.workspaces-root' in bots.labels).toBe(false)
  })

  it('mounts the configured host directory at the same path, and nothing else', async () => {
    const h = await setup({ root: '/srv/maestrly' })
    const id = await workspaces(h)
    const spec = containerOf(h, id)!.spec
    expect(spec.binds).toEqual([{ source: '/srv/maestrly', target: '/srv/maestrly' }])
    expect(spec.env).toContain('MAESTRLY_WORKSPACES_ROOT=/srv/maestrly')
    expect(spec.labels['org.maestrly.fleet.workspaces-root']).toBe('/srv/maestrly')
    // The directory belongs to the workspaces environment: a bots environment never gets it.
    expect(containerOf(h, h.bot.environmentId!)!.spec.binds).toBeUndefined()
  })

  it('replaces the container when the server gained a host directory since it was created', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const before = containerOf(h, id)!
    ;(h.lifecycle.config as { workspacesRoot: string | null }).workspacesRoot = '/srv/maestrly'
    await h.lifecycle.restartEnvironment(id)
    const after = containerOf(h, id)!
    expect(after).not.toBe(before)
    expect(after.spec.binds).toEqual([{ source: '/srv/maestrly', target: '/srv/maestrly' }])
    expect(h.lifecycle.environment(id)?.lifecycle).toBe('running')
  })

  it('hosts workspaces in one environment per server', async () => {
    const h = await setup()
    const id = await workspaces(h)
    const again = () => h.lifecycle.createEnvironment({ name: 'Second', memoryLimitBytes: null, kind: 'workspaces' })
    expect(codeOf(again)).toBe('CONFLICT')
    expect(h.store.listEnvironments().filter((environment) => environment.kind === 'workspaces')).toHaveLength(1)
    // Bots environments are not limited by it.
    expect(h.lifecycle.createEnvironment({ name: 'More bots', memoryLimitBytes: null }).kind).toBe('bots')

    // An archived one does not count, but it cannot come back while another is active.
    await h.lifecycle.archiveEnvironment(id)
    const second = again()
    await settled(h, second.id, 'running')
    expect(codeOf(() => h.lifecycle.restoreEnvironment(id))).toBe('CONFLICT')
    expect(h.store.getEnvironment(id)?.archivedAt).not.toBeNull()
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

describe('workspaces environment routes', () => {
  it('moves host files only for a paired device, and only to a running workspaces environment', async () => {
    const h = await setup()
    const stat = '/v1/environments/' + h.bot.environmentId + '/host-files/stat'
    const anonymous = await h.request('POST', stat, { path: '/a' }, false, { 'X-Maestrly-Fleet-Protocol': '1' })
    expect(anonymous.status).toBe(401)
    const bots = await h.request('POST', stat, { path: '/a' })
    expect(bots.status).toBe(409)
    expect((await json(bots)).message).toBe('The workspaces environment is not running.')
    expect((await json(await h.request('GET', '/v1/meta'))).features).toContain('host-files')
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
    const second = await h.request('POST', '/v1/environments', {
      name: 'Another',
      kind: 'workspaces',
      idempotencyKey: randomUUID(),
    })
    expect(second.status).toBe(409)
    expect((await json(second)).message).toBe('This server already hosts workspaces.')
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
    // Revoking the device spends its tickets.
    const path = await ticket()
    await h.request('DELETE', '/v1/devices/self')
    expect(await upgrade(path)).toBe(403)
  })
})
