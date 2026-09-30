import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ArtifactHost, ArtifactHostError, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  }
}
let deps: ReturnType<typeof makeDeps>
let service: ArtifactsService

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
  service = new ArtifactsService({
    host: deps.host,
    settings: () => settings,
    saveSettings: (input) => {
      settings = input as ArtifactSettings
      return settings
    },
    getConversation,
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
    await service.setSettings({ ...settings, hostEnabled: false })
    expect(deps.host.stop).toHaveBeenCalledTimes(1)
    expect(deps.emitStatus).toHaveBeenCalled()
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
