import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ArtifactHost, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactsService } from '../../src/main/artifacts/service'
import { InviteVault } from '../../src/main/artifacts/invite-vault'
import { LegacyArtifacts } from '../../src/main/artifacts/legacy'
import type { ServerArtifacts } from '../../src/main/artifacts/server-artifacts'
import { createDesktopSources, serverUnavailable, type ArtifactSource } from '../../src/main/artifacts/sources'
import type { ArtifactServerStatus } from '../../src/shared/artifacts'
import { getConversation } from '../../src/main/store'
import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

let root: string
/** This computer's store of earlier artifacts, and the bot server's host. */
let hosts: ArtifactHost[]
const files = [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Published</h1>') }]
beforeEach(async () => {
  freshDb()
  root = mkdtempSync(path.join(os.tmpdir(), 'artifact-sources-'))
  hosts = await Promise.all(
    ['local', 'server'].map((name) => openArtifactHost({ dataDir: path.join(root, name), port: 0, quotaBytes: 1e6 }))
  )
})
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.close()))
  rmSync(root, { recursive: true, force: true })
  closeDb()
})
function harness() {
  let state: 'ready' | 'absent' | 'unreachable' = 'ready'
  let canMove = true
  let viewer: string | null = 'http://127.0.0.1:7443'
  const source: ArtifactSource = {
    key: 'server',
    owner: { kind: 'device', id: 'dev-1' },
    ready: () => state === 'ready',
    admin: async () => {
      if (state !== 'ready') throw serverUnavailable('server_unreachable')
      return hosts[1].admin
    },
    viewerBase: () => viewer,
    publicBase: () => 'https://server.example',
    linkExpiryDays: () => 7,
  }
  const reason = () => serverUnavailable(state === 'absent' ? 'server_absent' : 'server_unreachable')
  const server = {
    refresh: async () => server.status(),
    source: () => (state === 'ready' ? source : null),
    unavailable: () => (state === 'ready' ? null : reason()),
    status: (): ArtifactServerStatus =>
      state === 'ready'
        ? { state, canOpen: true, canMove, artifactCount: 0, storageBytes: 0, quotaBytes: 1e6, problem: null }
        : { state },
  } as unknown as ServerArtifacts
  const legacy = new LegacyArtifacts({
    dataDir: () => path.join(root, 'local'),
    host: { ensureStarted: async () => hosts[0].admin, stop: vi.fn(async () => {}) },
    idleStopMs: 5,
    // As in the app, the host lets go of its files first: Windows cannot delete a database that is still open.
    removeDir: async (dir) => {
      await hosts[0].close()
      rmSync(dir, { recursive: true, force: true })
    },
  })
  const vault = new InviteVault({ get: () => null, set: () => true, remove: () => {} })
  const openExternal = vi.fn(async () => {})
  const service = new ArtifactsService({
    sources: createDesktopSources({ server: () => server.source(), unavailable: reason }),
    server,
    legacy,
    vault,
    getConversation,
    workspaceName: () => 'Project',
    botName: () => 'Scout',
    resolveDirectory: async () => root,
    openExternal,
    openInDrawer: vi.fn(),
  })
  const conversation = makeConversation(makeWorkspace().id)
  return {
    service,
    conversation,
    openExternal,
    set: (next: typeof state) => {
      state = next
    },
    oldServer: () => {
      canMove = false
    },
    noViewer: () => {
      viewer = null
    },
  }
}

/** An artifact an earlier version published on this computer. */
const earlier = (conversationId: string, workspaceId: string | null) =>
  hosts[0].admin.create({
    title: 'Earlier',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId, conversationId, conversationTitle: 'Chat' },
    files,
  })

it('publishes only on the bot server, and nowhere without one', async () => {
  const h = harness()
  const { detail } = await h.service.create(h.conversation.id, { title: 'Remote', files })
  expect(detail).toMatchObject({ ownerKind: 'device', ownerId: 'dev-1' })
  expect(await hosts[0].admin.list()).toEqual([])
  h.set('unreachable')
  await expect(h.service.create(h.conversation.id, { title: 'Offline', files })).rejects.toMatchObject({
    details: { reason: 'server_unreachable' },
  })
  await expect(h.service.getForConversation(h.conversation.id, 'AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
    code: 'host_unavailable',
  })
  h.set('absent')
  await expect(h.service.create(h.conversation.id, { title: 'Nowhere', files })).rejects.toMatchObject({
    code: 'host_unavailable',
    details: { reason: 'server_absent' },
  })
  await expect(h.service.listForConversation(h.conversation.id, 'project')).rejects.toMatchObject({
    details: { reason: 'server_absent' },
  })
  expect(await hosts[0].admin.list()).toEqual([])
  expect(await h.service.listAll()).toEqual([])
})

it('enforces device and workspace scope, and lists only the server', async () => {
  const h = harness()
  const own = await h.service.create(h.conversation.id, { title: 'Own', files })
  const input = {
    title: 'Other',
    files,
    origin: {
      workspaceId: h.conversation.workspaceId,
      conversationId: h.conversation.id,
      conversationTitle: 'Other chat',
    },
  }
  const other = await hosts[1].admin.create({ ...input, owner: { kind: 'device', id: 'dev-2' } })
  const bot = await hosts[1].admin.create({ ...input, owner: { kind: 'bot', id: 'scout' } })
  await earlier(h.conversation.id, h.conversation.workspaceId)
  for (const id of [other.id, bot.id])
    await expect(h.service.getForConversation(h.conversation.id, id)).rejects.toMatchObject({ code: 'not_found' })
  const sibling = makeConversation(h.conversation.workspaceId!)
  expect((await h.service.getForConversation(sibling.id, own.detail.id)).id).toBe(own.detail.id)
  expect((await h.service.listForConversation(sibling.id, 'project')).map((a) => a.id)).toEqual([own.detail.id])
  const items = await h.service.listAll()
  expect(items).toHaveLength(3)
  expect(items.find((a) => a.id === other.id)).toMatchObject({ elsewhere: true, conversation: null, project: null })
  expect(items.find((a) => a.id === bot.id)).toMatchObject({ bot: { id: 'scout', name: 'Scout' }, conversation: null })
  expect(items[0]).not.toHaveProperty('host')
  h.set('unreachable')
  expect(await h.service.listAll()).toEqual([])
})

it('says an artifact is on this computer instead of missing', async () => {
  const h = harness()
  const old = await earlier(h.conversation.id, h.conversation.workspaceId)
  const reason = { code: 'host_unavailable', details: { reason: 'on_this_computer' } }
  await expect(h.service.getForConversation(h.conversation.id, old.id)).rejects.toMatchObject(reason)
  await expect(
    h.service.update(h.conversation.id, {
      id: old.id,
      baseVersion: 1,
      change: { kind: 'files', files, delete: [] },
    })
  ).rejects.toMatchObject(reason)
  await expect(h.service.openExternal(old.id)).rejects.toMatchObject(reason)
  await expect(h.service.getForConversation(h.conversation.id, 'AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
    code: 'not_found',
  })
  expect(await h.service.listForConversation(h.conversation.id, 'project')).toEqual([])
  expect((await h.service.legacyList()).map((item) => item.id)).toEqual([old.id])
})

it('moves earlier artifacts only to a server that accepts them', async () => {
  const h = harness()
  const old = await earlier(h.conversation.id, h.conversation.workspaceId)
  h.oldServer()
  await expect(h.service.legacyMove()).rejects.toMatchObject({ details: { reason: 'server_unsupported' } })
  h.set('absent')
  await expect(h.service.legacyMove()).rejects.toMatchObject({ details: { reason: 'server_absent' } })
  expect(await hosts[0].admin.get(old.id)).not.toBeNull()
  expect(h.service.legacyState().phase).toBe('idle')
})

it('moves earlier artifacts to the server, where agents find them again', async () => {
  const h = harness()
  const old = await earlier(h.conversation.id, h.conversation.workspaceId)
  expect((await h.service.legacyMove()).phase).toBe('running')
  for (let i = 0; i < 200 && h.service.legacyState().phase === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(h.service.legacyState()).toMatchObject({ phase: 'done', moved: [old.id] })
  expect(await hosts[1].admin.get(old.id)).toMatchObject({ id: old.id, title: 'Earlier' })
  expect(await h.service.legacyList()).toEqual([])
})

it('uses the server viewer and sharing defaults, without minting unusable tickets', async () => {
  const h = harness()
  const { detail } = await h.service.create(h.conversation.id, { title: 'Remote', files })
  await h.service.openExternal(detail.id)
  expect(h.openExternal).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:7443\/a\/.+#o=/))
  const invite = await h.service.createInvite(detail.id, 'Reviewer')
  expect(invite.link).toMatch(/^https:\/\/server\.example\/a\/.+#i=/)
  expect(await h.service.sharing(detail.id)).toMatchObject({
    defaultLinkExpiryDays: 7,
    publicBase: 'https://server.example',
  })
  h.noViewer()
  await expect(h.service.openExternal(detail.id)).rejects.toMatchObject({ details: { reason: 'no_viewer' } })
})
