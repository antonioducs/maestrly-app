import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ArtifactHost, ArtifactHostError, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InviteVault } from '../../src/main/artifacts/invite-vault'
import { ArtifactsService } from '../../src/main/artifacts/service'
import { deleteConversation, getConversation, insertConversation } from '../../src/main/store'
import { type ArtifactHostStatus, type ArtifactSettings, DEFAULT_ARTIFACT_SETTINGS } from '../../src/shared/artifacts'
import type { Conversation, StandaloneConversation } from '../../src/shared/conversation'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const encode = (text: string) => new TextEncoder().encode(text)
const page = [{ path: 'index.html', bytes: encode('<h1>Hello</h1>') }]

let root: string
let host: ArtifactHost
let settings: ArtifactSettings
let hostState: ArtifactHostStatus['state']
function makeDeps() {
  return {
    host: {
      ensureStarted: vi.fn(async () => host.admin),
      status: (): ArtifactHostStatus => ({ state: hostState, port: 4010 }),
      stop: vi.fn(async () => {
        hostState = 'stopped'
      }),
      restart: vi.fn(async () => {}),
    },
    openExternal: vi.fn(async (_url: string) => {}),
    openInDrawer: vi.fn((_convId: string, _url: string, _activate: boolean) => {}),
    resolveDirectory: vi.fn(async (_conversation: Conversation, relative: string) => path.join(root, relative)),
    emitStatus: vi.fn((_status: ArtifactHostStatus) => {}),
    requestThumbnail: vi.fn((_id: string, _version: number) => {}),
  }
}
let deps: ReturnType<typeof makeDeps>
let service: ArtifactsService
let vault: InviteVault

/** Joins an artifact the way the viewer does after "Continue as …", and returns what the host answered. */
async function join(link: string): Promise<number> {
  const url = new URL(link)
  const origin = `http://127.0.0.1:${host.port}`
  const response = await fetch(`${origin}${url.pathname}/api/session/invite`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-maestrly-artifact': '1' },
    body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('i') }),
  })
  return response.status
}

function standalone(name = 'Standalone chat'): StandaloneConversation {
  const conversation: StandaloneConversation = {
    id: crypto.randomUUID(),
    scope: 'standalone',
    cwd: path.join(root, 'chat'),
    isMulti: 0,
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    name,
    status: 'idle',
    archived: 0,
    pinnedAt: null,
    createdAt: 1,
    lastActivityAt: 1,
  }
  insertConversation(conversation)
  return conversation
}

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

beforeEach(async () => {
  freshDb()
  root = mkdtempSync(path.join(os.tmpdir(), 'artifacts-service-'))
  host = await openArtifactHost({ dataDir: path.join(root, 'artifacts'), port: 0, quotaBytes: 1024 * 1024 })
  settings = { ...DEFAULT_ARTIFACT_SETTINGS }
  hostState = 'running'
  deps = makeDeps()
  const stored = new Map<string, string>()
  vault = new InviteVault({
    get: (key) => stored.get(key) ?? null,
    set: (key, value) => {
      stored.set(key, value)
      return true
    },
    remove: (key) => stored.delete(key),
  })
  service = new ArtifactsService({
    vault,
    host: deps.host,
    settings: () => settings,
    saveSettings: (input) => {
      settings = input as ArtifactSettings
      return settings
    },
    getConversation,
    workspaceName: (id) => (id === 'gone' ? undefined : `Project ${id.slice(0, 4)}`),
    requestThumbnail: deps.requestThumbnail,
    resolveDirectory: deps.resolveDirectory,
    openExternal: deps.openExternal,
    openInDrawer: deps.openInDrawer,
    emitStatus: deps.emitStatus,
  })
})

afterEach(async () => {
  await host.close()
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('ArtifactsService', () => {
  it('records the origin of what an agent publishes', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { name: 'Landing page chat' })
    const { detail, skipped } = await service.create(conversation.id, { title: 'Landing', files: page })
    expect(skipped).toEqual([])
    expect(detail).toMatchObject({
      ownerKind: 'local',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      conversationTitle: 'Landing page chat',
    })
    const chat = standalone()
    const own = await service.create(chat.id, { title: 'Mine', files: page })
    expect(own.detail).toMatchObject({ workspaceId: null, conversationId: chat.id })
  })

  it('keeps agents within their project or standalone conversation', async () => {
    const first = makeConversation(makeWorkspace().id)
    const other = makeConversation(makeWorkspace().id)
    const sibling = makeConversation(first.workspaceId)
    const { detail } = await service.create(first.id, { title: 'Scoped', files: page })
    expect((await service.getForConversation(sibling.id, detail.id)).id).toBe(detail.id)
    expect((await errorOf(service.getForConversation(other.id, detail.id))).code).toBe('not_found')

    const chat = standalone()
    const otherChat = standalone()
    const own = await service.create(chat.id, { title: 'Own', files: page })
    expect((await errorOf(service.getForConversation(otherChat.id, own.detail.id))).code).toBe('not_found')
    expect((await errorOf(service.getForConversation(chat.id, detail.id))).code).toBe('not_found')
    expect((await service.listForConversation(chat.id, 'project')).map((item) => item.id)).toEqual([own.detail.id])
    expect((await service.listForConversation(sibling.id, 'project')).map((item) => item.id)).toEqual([detail.id])
    expect(await service.listForConversation(sibling.id, 'conversation')).toEqual([])
  })

  it('lists artifacts whose conversation was deleted', async () => {
    const conversation = makeConversation(makeWorkspace().id, { name: 'Gone soon' })
    const { detail } = await service.create(conversation.id, { title: 'Survivor', files: page })
    deleteConversation(conversation.id)
    const [item] = await service.listAll()
    expect(item).toMatchObject({
      id: detail.id,
      host: 'local',
      visibility: 'private',
      versionCount: 1,
      conversation: { id: conversation.id, title: 'Gone soon', exists: false },
    })
  })

  it('opens the owner view with a single-use ticket', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Open me', files: page })
    await service.update(conversation.id, {
      id: detail.id,
      baseVersion: 1,
      change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'Hello', newText: 'Hi' }] },
    })
    await service.openInConversation(conversation.id, detail.id, 2, { checkScope: true, activate: true })
    expect(deps.openInDrawer).toHaveBeenCalledWith(
      conversation.id,
      expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:4010/a/${detail.id}#o=[A-Za-z0-9_-]{43}&v=2$`)),
      true
    )
    await service.openExternal(detail.id)
    expect(deps.openExternal).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:4010/a/${detail.id}#o=[A-Za-z0-9_-]{43}$`))
    )
    const outsider = makeConversation(makeWorkspace().id)
    expect(
      (await errorOf(service.openInConversation(outsider.id, detail.id, undefined, { checkScope: true }))).code
    ).toBe('not_found')
  })

  it('publishes a folder as a full replacement', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Build', files: page })
    mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true })
    writeFileSync(path.join(root, 'dist', 'index.html'), '<p>built</p>')
    writeFileSync(path.join(root, 'dist', 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(path.join(root, 'dist', 'app.js.map'), '{}')
    const result = await service.update(conversation.id, {
      id: detail.id,
      baseVersion: 1,
      change: { kind: 'directory', directory: 'dist' },
    })
    expect(deps.resolveDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: conversation.id }), 'dist')
    expect(result.skipped).toEqual(['app.js.map'])
    expect(result.detail.currentVersion).toBe(2)
    expect((await service.listFilesForConversation(conversation.id, detail.id)).map((file) => file.path)).toEqual([
      'assets/app.js',
      'index.html',
    ])
  })

  it('reads text files within limits', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const big = 'x'.repeat(300 * 1024)
    const { detail } = await service.create(conversation.id, {
      title: 'Big',
      files: [...page, { path: 'data.txt', bytes: encode(big) }, { path: 'logo.png', bytes: new Uint8Array(4) }],
    })
    const small = await service.readTextForConversation(conversation.id, detail.id, 1, 'index.html')
    expect(small).toEqual({ text: '<h1>Hello</h1>', truncated: false })
    const long = await service.readTextForConversation(conversation.id, detail.id, 1, 'data.txt')
    expect(long.truncated).toBe(true)
    expect(long.text).toHaveLength(200 * 1024)
    expect((await errorOf(service.readTextForConversation(conversation.id, detail.id, 1, 'logo.png'))).code).toBe(
      'edit_binary'
    )
    expect((await errorOf(service.readTextForConversation(conversation.id, detail.id, 1, 'missing.txt'))).code).toBe(
      'not_found'
    )
  })

  it('applies settings to the running host', async () => {
    await service.setSettings({ ...settings, port: 5000 })
    expect(deps.host.restart).toHaveBeenCalledTimes(1)
    await service.setSettings({ ...settings, ownerName: 'Antonio' })
    expect(deps.host.restart).toHaveBeenCalledTimes(2)
    await service.setSettings({ ...settings, publicAddress: 'https://mac.example' })
    expect(deps.host.restart).toHaveBeenCalledTimes(3)
    // The default link expiry only matters to the desktop.
    await service.setSettings({ ...settings, linkExpiryDays: 7 })
    expect(deps.host.restart).toHaveBeenCalledTimes(3)
    await service.setSettings({ ...settings, hostEnabled: false })
    expect(deps.host.stop).toHaveBeenCalledTimes(1)
    expect(deps.emitStatus).toHaveBeenCalled()
  })

  it('invites a person with a link it can show again', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Shared', files: page })
    const id = detail.id
    await service.setSharing(id, { visibility: 'people' })
    const invite = await service.createInvite(id, 'Maria')
    expect(invite.link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:4010/a/${id}#i=[A-Za-z0-9_-]{43}$`))
    expect(await service.inviteLink(id, invite.principalId)).toBe(invite.link)

    const view = await service.sharing(id)
    expect(view).toMatchObject({
      visibility: 'people',
      hasAccessCode: false,
      commentsEnabled: true,
      requests: [],
      publicBase: null,
      localBase: 'http://127.0.0.1:4010',
    })
    expect(view.people).toEqual([
      expect.objectContaining({
        id: invite.principalId,
        kind: 'invited',
        name: 'Maria',
        linkAvailable: true,
        devices: [],
      }),
    ])
    expect(JSON.stringify(view)).not.toContain(invite.link.split('#i=')[1])

    // Without the stored token the link cannot be shown again, only reset.
    vault.remove(invite.principalId)
    expect(await service.inviteLink(id, invite.principalId)).toBeNull()
    expect((await service.sharing(id)).people[0]?.linkAvailable).toBe(false)
    const fresh = await service.resetInvite(id, invite.principalId)
    expect(fresh).not.toBe(invite.link)
    expect(await service.inviteLink(id, invite.principalId)).toBe(fresh)
    expect(await join(invite.link)).toBe(404)
    expect(await join(fresh)).toBe(204)
  })

  it('builds links on the public address when there is one', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Public', files: page })
    settings = { ...settings, publicAddress: 'https://mac.tail1234.ts.net' }
    const invite = await service.createInvite(detail.id, 'Maria')
    expect(invite.link.startsWith(`https://mac.tail1234.ts.net/a/${detail.id}#i=`)).toBe(true)
    expect(await service.sharing(detail.id)).toMatchObject({
      publicBase: 'https://mac.tail1234.ts.net',
      localBase: 'http://127.0.0.1:4010',
    })
  })

  it('never hands out a link through another artifact', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const first = await service.create(conversation.id, { title: 'First', files: page })
    const second = await service.create(conversation.id, { title: 'Second', files: page })
    const invite = await service.createInvite(first.detail.id, 'Maria')
    expect(await service.inviteLink(second.detail.id, invite.principalId)).toBeNull()
    expect((await errorOf(service.resetInvite(second.detail.id, invite.principalId))).code).toBe('not_found')
    expect(await service.inviteLink(first.detail.id, invite.principalId)).toBe(invite.link)
  })

  it('shows devices and events, and forgets links with the person or the artifact', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Watched', files: page })
    const id = detail.id
    await service.setSharing(id, { visibility: 'people' })
    const maria = await service.createInvite(id, 'Maria')
    const ana = await service.createInvite(id, 'Ana')
    expect(await join(maria.link)).toBe(204)

    const mariaOf = async () => (await service.sharing(id)).people.find((item) => item.id === maria.principalId)
    const person = await mariaOf()
    expect(person?.devices).toEqual([expect.objectContaining({ label: expect.any(String) })])
    expect(await service.unseenCount()).toBe(1)
    expect((await service.listAll())[0]).toMatchObject({ unseenEvents: 1, pendingRequests: 0 })
    expect(await service.events(id)).toEqual([
      expect.objectContaining({ artifactId: id, kind: 'device_added', seen: false }),
    ])
    await service.markSeen(id)
    expect(await service.unseenCount()).toBe(0)
    expect((await service.events())[0]?.seen).toBe(true)

    await service.revokeDevice(id, person!.devices[0]!.id)
    expect((await mariaOf())?.devices).toEqual([])
    await service.revokePerson(id, maria.principalId)
    expect(vault.get(maria.principalId)).toBeNull()
    expect((await service.sharing(id)).people.map((item) => item.id)).toEqual([ana.principalId])
    expect(await service.inviteLink(id, maria.principalId)).toBeNull()
    expect(await join(maria.link)).toBe(404)
    await service.revokeAllSessions(id)

    expect(vault.get(ana.principalId)).not.toBeNull()
    await service.remove(id)
    expect(vault.get(ana.principalId)).toBeNull()
  })

  it('decides access requests', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Asked', files: page })
    const id = detail.id
    await service.setSharing(id, { visibility: 'people' })
    const origin = `http://127.0.0.1:${host.port}`
    const asked = await fetch(`${origin}/a/${id}/api/access-requests`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-maestrly-artifact': '1' },
      body: JSON.stringify({ name: 'João', message: 'Please' }),
    })
    expect(asked.status).toBe(202)
    const [request] = (await service.sharing(id)).requests
    expect(request).toMatchObject({ name: 'João', message: 'Please' })
    expect((await service.listAll())[0]).toMatchObject({ pendingRequests: 1, unseenEvents: 1 })
    await service.decideRequest(id, request!.id, { approve: true, name: 'João Silva' })
    const view = await service.sharing(id)
    expect(view.requests).toEqual([])
    expect(view.people).toEqual([
      expect.objectContaining({ kind: 'approved', name: 'João Silva', linkAvailable: false }),
    ])
  })

  it('lets agents read, answer and resolve comments within their scope', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const outsider = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Discussed', files: page })
    const id = detail.id
    const thread = await host.admin.addComment(id, { author: 'owner', version: 1, body: 'Is this right?' })
    const resolved = await host.admin.addComment(id, { author: 'owner', version: 1, body: 'Done already' })
    await host.admin.setCommentResolved(id, resolved.id, true)

    const open = await service.commentsForConversation(conversation.id, id, { status: 'open' })
    expect(open).toMatchObject({ currentVersion: 1, nextCursor: null })
    expect(open.comments.map((comment) => comment.body)).toEqual(['Is this right?'])
    expect((await service.commentsForConversation(conversation.id, id, { status: 'all' })).comments).toHaveLength(2)
    expect((await service.commentsForConversation(conversation.id, id, { version: 2 })).comments).toEqual([])

    const reply = await service.replyForConversation(conversation.id, id, thread.id, 'Yes, checked.')
    expect(reply).toMatchObject({ parentId: thread.id, body: 'Yes, checked.', author: { kind: 'agent' } })
    await service.resolveForConversation(conversation.id, id, thread.id)
    expect((await service.commentsForConversation(conversation.id, id, { status: 'open' })).comments).toEqual([])
    expect((await service.listAll())[0]).toMatchObject({ openComments: 0 })

    // Out of scope, the artifact and its comments do not exist.
    for (const attempt of [
      service.commentsForConversation(outsider.id, id, {}),
      service.replyForConversation(outsider.id, id, thread.id, 'Intruding'),
      service.resolveForConversation(outsider.id, id, thread.id),
    ])
      expect((await errorOf(attempt)).code).toBe('not_found')
    expect((await service.commentsForConversation(conversation.id, id, { status: 'all' })).comments).toHaveLength(3)
  })

  it('lets the owner read, answer, resolve and delete comments from the app', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Discussed', files: page })
    const id = detail.id
    const thread = await host.admin.addComment(id, {
      author: 'agent',
      version: 1,
      body: 'Should the heading change?',
      anchor: { quote: { exact: 'Hello', prefix: '', suffix: '' } },
    })
    expect((await service.listAll())[0]).toMatchObject({ openComments: 1 })
    expect(await service.comments(id)).toEqual([
      {
        id: thread.id,
        version: 1,
        parentId: null,
        author: { kind: 'agent', name: '', verified: true },
        body: 'Should the heading change?',
        quote: 'Hello',
        status: 'open',
        createdAt: expect.any(Number),
      },
    ])

    const reply = await service.replyComment(id, thread.id, 'Keep it.')
    expect(reply).toMatchObject({ parentId: thread.id, author: { kind: 'owner' }, body: 'Keep it.', quote: null })
    expect(JSON.stringify(await service.comments(id))).not.toContain('principalId')
    await service.resolveComment(id, thread.id, true)
    expect((await service.comments(id))[0]?.status).toBe('resolved')
    expect((await service.listAll())[0]).toMatchObject({ openComments: 0 })
    await service.resolveComment(id, thread.id, false)
    await service.deleteComment(id, reply.id)
    expect((await service.comments(id)).map((comment) => comment.id)).toEqual([thread.id])
    await service.deleteComment(id, thread.id)
    expect(await service.comments(id)).toEqual([])
    expect((await errorOf(service.replyComment(id, thread.id, 'Too late'))).code).toBe('not_found')
  })

  it('reads every page of a long list of comments', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Busy', files: page })
    for (let n = 0; n < 205; n++) await host.admin.addComment(detail.id, { author: 'owner', version: 1, body: `#${n}` })
    const all = await service.comments(detail.id)
    expect(all).toHaveLength(205)
    expect(all[204]?.body).toBe('#204')
  })

  it('counts nothing, and starts nothing, while the host is not running', async () => {
    hostState = 'stopped'
    expect(await service.unseenCount()).toBe(0)
    expect(deps.host.ensureStarted).not.toHaveBeenCalled()
  })

  it('asks for a thumbnail of every version it publishes, and of listed artifacts that lack one', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Pictured', files: page })
    expect(deps.requestThumbnail).toHaveBeenLastCalledWith(detail.id, 1)
    await service.update(conversation.id, {
      id: detail.id,
      baseVersion: 1,
      change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'Hello', newText: 'Hi' }] },
    })
    expect(deps.requestThumbnail).toHaveBeenLastCalledWith(detail.id, 2)

    deps.requestThumbnail.mockClear()
    await service.listAll()
    expect(deps.requestThumbnail).toHaveBeenCalledWith(detail.id, 2)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
    await service.saveThumbnail(detail.id, 2, jpeg)
    deps.requestThumbnail.mockClear()
    const [item] = await service.listAll()
    expect(item.thumbnailVersion).toBe(2)
    expect(deps.requestThumbnail).not.toHaveBeenCalled()
    expect(await service.thumbnail(detail.id)).toEqual({
      version: 2,
      dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`,
    })
    expect(await service.thumbnail(detail.id, 1)).toBeNull()
  })

  it('gives the thumbnail capture a single-use owner link to one version', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const { detail } = await service.create(conversation.id, { title: 'Source', files: page })
    expect(await service.thumbnailSourceUrl(detail.id, 1)).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:4010/a/${detail.id}#o=[A-Za-z0-9_-]{43}&v=1$`)
    )
  })

  it('lists the project, size and preview of each artifact', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    await service.create(conversation.id, { title: 'In a project', files: page })
    await service.create(standalone().id, { title: 'Standalone', files: page })
    const items = await service.listAll()
    expect(items.find((item) => item.title === 'In a project')).toMatchObject({
      project: { id: workspace.id, name: `Project ${workspace.id.slice(0, 4)}` },
      storageBytes: 14,
      thumbnailVersion: null,
    })
    expect(items.find((item) => item.title === 'Standalone')!.project).toBeNull()
  })

  it('reports the storage a deletion frees', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const shared = await service.create(conversation.id, { title: 'Shared', files: page })
    const alone = await service.create(conversation.id, {
      title: 'Alone',
      files: [{ path: 'index.html', bytes: encode('<p>own</p>') }],
    })
    const twin = await service.create(conversation.id, { title: 'Twin', files: page })
    expect(await service.remove(alone.detail.id)).toEqual({ removed: true, freedBytes: 10 })
    // Identical content stays stored while another artifact uses it.
    expect(await service.remove(shared.detail.id)).toEqual({ removed: true, freedBytes: 0 })
    expect(await service.remove(twin.detail.id)).toEqual({ removed: true, freedBytes: 14 })
    expect(await service.remove(twin.detail.id)).toEqual({ removed: false, freedBytes: 0 })
  })

  it('reports storage use while the host runs', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    await service.create(conversation.id, { title: 'Counted', files: page })
    expect(await service.status()).toEqual({
      state: 'running',
      port: 4010,
      artifactCount: 1,
      storageBytes: 14,
      quotaBytes: 1024 * 1024,
    })
  })
})
