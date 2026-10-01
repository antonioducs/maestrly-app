import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ArtifactHost, ArtifactHostError, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactsService } from '../../src/main/artifacts/service'
import { InviteVault } from '../../src/main/artifacts/invite-vault'
import { createDesktopSources, localSource, type ArtifactSource } from '../../src/main/artifacts/sources'
import { DEFAULT_ARTIFACT_SETTINGS } from '../../src/shared/artifacts'
import { getConversation } from '../../src/main/store'
import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

let root: string
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
  const settings = { ...DEFAULT_ARTIFACT_SETTINGS, publishTo: 'server' as 'local' | 'server' }
  let offline = false
  let viewer: string | null = 'http://127.0.0.1:4011'
  const server: ArtifactSource = {
    key: 'server',
    owner: { kind: 'device', id: 'dev-1' },
    ready: () => !offline,
    admin: async () => {
      if (offline) throw new ArtifactHostError('host_unavailable', 'Offline', { reason: 'server_unreachable' })
      return hosts[1].admin
    },
    viewerBase: () => viewer,
    publicBase: () => 'https://server.example',
    linkExpiryDays: () => 7,
  }
  const host = {
    ensureStarted: async () => {
      if (!settings.hostEnabled) throw new ArtifactHostError('host_unavailable', 'Disabled', { reason: 'disabled' })
      return hosts[0].admin
    },
    status: () => ({ state: 'running' as const, port: 4010 }),
    stop: vi.fn(),
    restart: vi.fn(),
  }
  const local = localSource({ host, settings: () => settings })
  const sources = createDesktopSources({ local, server: () => server, settings: () => settings })
  const vault = new InviteVault({ get: () => null, set: () => true, remove: () => {} })
  const openExternal = vi.fn(async () => {})
  const service = new ArtifactsService({
    host,
    sources,
    vault,
    settings: () => settings,
    saveSettings: () => settings,
    getConversation,
    workspaceName: () => 'Project',
    botName: () => 'Scout',
    resolveDirectory: async () => root,
    openExternal,
    openInDrawer: vi.fn(),
    emitStatus: vi.fn(),
  })
  const conversation = makeConversation(makeWorkspace().id)
  return {
    service,
    conversation,
    settings,
    openExternal,
    offline: () => {
      offline = true
    },
    noViewer: () => {
      viewer = null
    },
  }
}
it('publishes on the chosen server and never falls back when it goes offline', async () => {
  const h = harness()
  const { detail } = await h.service.create(h.conversation.id, { title: 'Remote', files })
  expect(detail).toMatchObject({ ownerKind: 'device', ownerId: 'dev-1' })
  expect(await hosts[0].admin.list()).toEqual([])
  h.offline()
  await expect(h.service.create(h.conversation.id, { title: 'Offline', files })).rejects.toMatchObject({
    details: { reason: 'server_unreachable' },
  })
  expect(await hosts[0].admin.list()).toEqual([])
  await expect(h.service.getForConversation(h.conversation.id, 'AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
    code: 'host_unavailable',
  })
})
it('enforces device and workspace scope while merging owner views', async () => {
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
  for (const id of [other.id, bot.id])
    await expect(h.service.getForConversation(h.conversation.id, id)).rejects.toMatchObject({ code: 'not_found' })
  const sibling = makeConversation(h.conversation.workspaceId!)
  expect((await h.service.getForConversation(sibling.id, own.detail.id)).id).toBe(own.detail.id)
  expect((await h.service.listForConversation(sibling.id, 'project')).map((a) => a.id)).toEqual([own.detail.id])
  h.settings.publishTo = 'local'
  await h.service.create(h.conversation.id, { title: 'Local', files })
  const items = await h.service.listAll()
  expect(items).toHaveLength(4)
  expect(items.find((a) => a.id === other.id)).toMatchObject({
    host: 'server',
    elsewhere: true,
    conversation: null,
    project: null,
  })
  expect(items.find((a) => a.id === bot.id)).toMatchObject({ bot: { id: 'scout', name: 'Scout' }, conversation: null })
  h.offline()
  expect((await h.service.listAll()).map((a) => a.title)).toEqual(['Local'])
})
it('uses the server viewer and sharing defaults, without minting unusable tickets', async () => {
  const h = harness()
  const { detail } = await h.service.create(h.conversation.id, { title: 'Remote', files })
  await h.service.openExternal(detail.id)
  expect(h.openExternal).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:4011\/a\/.+#o=/))
  const invite = await h.service.createInvite(detail.id, 'Reviewer')
  expect(invite.link).toMatch(/^https:\/\/server\.example\/a\/.+#i=/)
  expect(await h.service.sharing(detail.id)).toMatchObject({
    defaultLinkExpiryDays: 7,
    publicBase: 'https://server.example',
  })
  h.noViewer()
  await expect(h.service.openExternal(detail.id)).rejects.toMatchObject({ details: { reason: 'no_viewer' } })
})

it('can list server artifacts with local hosting disabled', async () => {
  const h = harness()
  const { detail } = await h.service.create(h.conversation.id, { title: 'Remote', files })
  h.settings.hostEnabled = false
  expect((await h.service.getForConversation(h.conversation.id, detail.id)).id).toBe(detail.id)
  expect((await h.service.listForConversation(h.conversation.id, 'project')).map((a) => a.id)).toEqual([detail.id])
})
