import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_METHODS, type ArtifactHost, callAdmin, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InviteVault } from '../../src/main/artifacts/invite-vault'
import { ArtifactServers } from '../../src/main/artifacts/servers'
import { ArtifactsService } from '../../src/main/artifacts/service'
import { createDesktopSources } from '../../src/main/artifacts/sources'
import type { FleetClientService, FleetConnectionView } from '../../src/main/fleet/client/service'
import { getConversation } from '../../src/main/store'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const A = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const B = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
const page = [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Hi</h1>') }]

let root: string
let hosts: ArtifactHost[]
beforeEach(async () => {
  freshDb()
  root = mkdtempSync(path.join(os.tmpdir(), 'artifact-servers-'))
  hosts = await Promise.all(
    ['a', 'b'].map((name) => openArtifactHost({ dataDir: path.join(root, name), port: 0, quotaBytes: 1e6 }))
  )
})
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.close()))
  rmSync(root, { recursive: true, force: true })
  closeDb()
})

/** A paired server whose artifact host runs in this process, reached as the gateway would reach it. */
function fakeServer(host: ArtifactHost, hostname: string, deviceId: string) {
  const connection: FleetConnectionView = {
    state: 'connected',
    features: ['artifacts'],
    deviceId,
    url: `https://${hostname}.example`,
    hostname,
    error: null,
    tokenPersistence: 'secure',
  }
  const settings = { enabled: true, publicAddress: '', ownerName: 'Owner', linkExpiryDays: 7, quotaGb: 2 }
  const client = {
    getConnection: () => connection,
    hasFeature: (feature: string) => connection.features.includes(feature),
    call: async (key: string, options?: { body: { method: string; args: unknown[] } }) => {
      if (key === 'artifactHost')
        return {
          settings,
          status: { state: 'running', problem: null, artifactCount: 0, storageBytes: 0, quotaBytes: 2 ** 31 },
        }
      const body = JSON.parse(JSON.stringify(options?.body))
      return JSON.parse(JSON.stringify(await callAdmin(host.admin, body.method, body.args, { allowed: ADMIN_METHODS })))
    },
  } as unknown as Pick<FleetClientService, 'call' | 'hasFeature' | 'getConnection'>
  return { connection, client }
}

function setup(options: { paired?: FleetServerId[] } = {}) {
  const fleet = { [A]: fakeServer(hosts[0], 'mac-mini', 'device-a'), [B]: fakeServer(hosts[1], 'vps', 'device-b') }
  let chosen: FleetServerId | null = null
  const paired = options.paired ?? [A, B]
  const servers = new ArtifactServers({
    servers: () => paired.map((id) => ({ id, installed: id === A })),
    client: (id) => (paired.includes(id) ? fleet[id as typeof A].client : null),
    viewerPort: () => 4011,
    chosen: () => chosen,
    name: (id) => fleet[id as typeof A].connection.hostname ?? '',
  })
  const service = new ArtifactsService({
    sources: createDesktopSources({ servers: () => servers.entries(), publishing: () => servers.publishingId() }),
    servers,
    choosePublishing: (id) => {
      chosen = id
    },
    vault: new InviteVault({ get: () => null, set: () => true, remove: () => {} }),
    getConversation,
    workspaceName: () => 'Project',
    resolveDirectory: async () => root,
    openExternal: vi.fn(async () => {}),
    openInDrawer: vi.fn(),
  })
  return { fleet, servers, service, conversation: makeConversation(makeWorkspace().id) }
}

describe('artifacts on several servers', () => {
  it('publishes on the server chosen, finds artifacts on every server, and names the server of each', async () => {
    const h = setup()
    // The installed server, until another is chosen.
    expect(h.servers.publishingId()).toBe(A)
    const first = await h.service.create(h.conversation.id, { title: 'On the Mac mini', files: page })
    expect(await hosts[0].admin.get(first.detail.id)).not.toBeNull()

    expect((await h.service.setPublishing(B)).map((view) => [view.serverId, view.publishing])).toEqual([
      [A, false],
      [B, true],
    ])
    const second = await h.service.create(h.conversation.id, { title: 'On the VPS', files: page })
    expect(await hosts[1].admin.get(second.detail.id)).not.toBeNull()
    expect(await hosts[0].admin.get(second.detail.id)).toBeNull()

    const items = await h.service.listAll()
    expect(items.map((item) => [item.title, item.server])).toEqual(
      expect.arrayContaining([
        ['On the Mac mini', { id: A, name: 'mac-mini' }],
        ['On the VPS', { id: B, name: 'vps' }],
      ])
    )
    // An agent of this computer still reaches what it published on the server it used before.
    await expect(h.service.getForConversation(h.conversation.id, first.detail.id)).resolves.toMatchObject({
      title: 'On the Mac mini',
    })
    expect(await h.service.detail(second.detail.id)).toMatchObject({ server: { id: B, name: 'vps' } })
  })

  it('opens the installer viewer port for the installed server only', async () => {
    const h = setup()
    await h.servers.refresh()
    expect(h.servers.get(A)?.source()?.viewerBase()).toBe('http://127.0.0.1:4011')
    expect(h.servers.get(B)?.source()?.viewerBase()).toBeNull()
  })

  it('says which server cannot host, when there are several', async () => {
    const h = setup()
    await h.service.setPublishing(B)
    h.fleet[B].connection.state = 'reconnecting'
    await expect(h.service.create(h.conversation.id, { title: 'Late', files: page })).rejects.toMatchObject({
      code: 'host_unavailable',
      details: { reason: 'server_unreachable', server: 'vps' },
    })
    // What the other server holds still lists.
    await h.service.setPublishing(A)
    await h.service.create(h.conversation.id, { title: 'Still here', files: page })
    expect((await h.service.listAll()).map((item) => item.title)).toEqual(['Still here'])

    const one = setup({ paired: [B] })
    one.fleet[B].connection.state = 'reconnecting'
    const error = await one.service.create(one.conversation.id, { title: 'Late', files: page }).catch((e) => e)
    expect(error.details).toEqual({ reason: 'server_unreachable' })
  })

  it('publishes on the default server once the chosen one is no longer paired', async () => {
    const paired = [A, B]
    const h = setup({ paired })
    await h.service.setPublishing(B)
    expect(h.servers.publishingId()).toBe(B)
    paired.splice(1, 1)
    expect(h.servers.publishingId()).toBe(A)
    expect(h.servers.get(B)).toBeNull()
    expect(h.servers.views().map((view) => view.serverId)).toEqual([A])
    await expect(h.service.setPublishing(B)).rejects.toMatchObject({ details: { reason: 'server_absent' } })
  })
})
