import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ArtifactAdmin, type ArtifactHost, ArtifactHostError, openArtifactHost } from '@maestrly/artifact-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyArtifacts } from '../../src/main/artifacts/legacy'
import type { LegacyMoveState } from '../../src/shared/artifacts'

const encode = (text: string) => new TextEncoder().encode(text)

let root: string
let dataDir: string
let local: ArtifactHost | null
let server: ArtifactHost
let states: LegacyMoveState[]
let forgotten: string[]
let changes: number
let host: { ensureStarted: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
let legacy: LegacyArtifacts

async function openLocal(): Promise<ArtifactHost> {
  local ??= await openArtifactHost({ dataDir, port: 0, quotaBytes: 10 * 1024 * 1024 })
  return local
}

async function openServer(quotaBytes = 10 * 1024 * 1024): Promise<ArtifactHost> {
  return openArtifactHost({ dataDir: path.join(root, `server-${quotaBytes}`), port: 0, quotaBytes })
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artifacts-legacy-'))
  dataDir = path.join(root, 'profile', 'artifacts')
  local = null
  server = await openServer()
  states = []
  forgotten = []
  changes = 0
  host = {
    ensureStarted: vi.fn(async () => (await openLocal()).admin),
    stop: vi.fn(async () => {
      await local?.close()
      local = null
    }),
  }
  legacy = new LegacyArtifacts({
    dataDir: () => dataDir,
    host: host as never,
    forgetPeople: (ids) => forgotten.push(...ids),
    onState: (state) => states.push(state),
    onChanged: () => changes++,
    idleStopMs: 5,
  })
})
afterEach(async () => {
  await legacy.dispose()
  await local?.close()
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

/** What an earlier version left here: one artifact shared with a person, and one private with two versions. */
async function earlier(): Promise<{ shared: string; plain: string; principalId: string }> {
  const { admin } = await openLocal()
  const origin = { workspaceId: 'ws', conversationId: 'conv', conversationTitle: 'Chat' }
  const shared = (
    await admin.create({
      title: 'Shared report',
      owner: { kind: 'local', id: 'local' },
      origin,
      files: [{ path: 'index.html', bytes: encode('<h1>Shared</h1>') }],
    })
  ).id
  await admin.setSharing(shared, { visibility: 'people' })
  const { principalId } = await admin.createInvite(shared, { name: 'Maria' })
  await admin.addComment(shared, { author: 'owner', version: 1, body: 'Note' })
  const plain = (
    await admin.create({
      title: 'Plain page',
      owner: { kind: 'local', id: 'local' },
      origin,
      files: [{ path: 'index.html', bytes: encode('<h1>Plain</h1>') }],
    })
  ).id
  await admin.update({
    id: plain,
    baseVersion: 1,
    change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'Plain', newText: 'Plainer' }] },
  })
  return { shared, plain, principalId }
}

async function settled(): Promise<LegacyMoveState> {
  for (let i = 0; i < 200 && legacy.state().phase === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
  return legacy.state()
}

describe('LegacyArtifacts', () => {
  it('starts nothing when nothing was ever published here', async () => {
    expect(legacy.exists()).toBe(false)
    expect(await legacy.list()).toEqual([])
    expect(await legacy.has('A'.repeat(22))).toBe(false)
    expect(await legacy.snapshot(path.join(root, 'copy.sqlite'))).toBe(false)
    await legacy.remove()
    expect(host.ensureStarted).not.toHaveBeenCalled()
  })

  it('lists what is here, moves all of it with the same IDs, and removes the folder', async () => {
    const { shared, plain, principalId } = await earlier()
    const listed = await legacy.list()
    expect(listed).toEqual(
      expect.arrayContaining([
        { id: shared, title: 'Shared report', versionCount: 1, commentCount: 1, storageBytes: 15, shared: true },
        { id: plain, title: 'Plain page', versionCount: 2, commentCount: 0, storageBytes: 30, shared: false },
      ])
    )
    expect(await legacy.has(shared)).toBe(true)

    const started = await legacy.move(() => server.admin)
    expect(started).toMatchObject({ phase: 'running', moved: [], error: null })
    expect(started.items.map((item) => item.id).sort()).toEqual([shared, plain].sort())
    const done = await settled()
    expect(done).toMatchObject({ phase: 'done', current: null, error: null })
    expect(done.moved.sort()).toEqual([shared, plain].sort())
    expect((await server.admin.list()).map((item) => item.id).sort()).toEqual([shared, plain].sort())
    expect((await server.admin.get(shared))?.visibility).toBe('private')
    expect(forgotten).toEqual([principalId])
    expect(existsSync(dataDir)).toBe(false)
    expect(legacy.exists()).toBe(false)
    expect(states.some((state) => state.current?.step === 'verify')).toBe(true)
    expect(changes).toBeGreaterThan(0)
  })

  it('stops after the artifact being moved', async () => {
    await earlier()
    await legacy.move(() => server.admin)
    for (let i = 0; i < 200 && !legacy.state().current; i++) await new Promise((r) => setImmediate(r))
    expect(legacy.state().current).not.toBeNull()
    legacy.stopAfterCurrent()
    const done = await settled()
    expect(done).toMatchObject({ phase: 'done', stopping: false })
    expect(done.moved).toHaveLength(1)
    expect(await legacy.list()).toHaveLength(1)
    expect(existsSync(dataDir)).toBe(true)
  })

  it('reports the space it needs instead of starting when the server is too full', async () => {
    await earlier()
    const small = await openServer(20)
    try {
      await legacy.move(() => small.admin)
      const failed = await settled()
      expect(failed).toMatchObject({
        phase: 'failed',
        moved: [],
        error: { code: 'quota_exceeded', neededBytes: 45, freeBytes: 20 },
      })
      expect(await legacy.list()).toHaveLength(2)
    } finally {
      await small.close()
    }
  })

  it('keeps what is left when the server drops, and continues the same move when tried again', async () => {
    const { shared, plain } = await earlier()
    let imports = 0
    const flaky = new Proxy(server.admin, {
      get: (object, key) =>
        key === 'importArtifact'
          ? async (input: Parameters<ArtifactAdmin['importArtifact']>[0]) => {
              if (imports++ === 1)
                throw new ArtifactHostError('host_unavailable', 'Offline', { reason: 'server_unreachable' })
              return object.importArtifact(input)
            }
          : object[key as keyof ArtifactAdmin],
    })
    await legacy.move(() => flaky)
    const failed = await settled()
    expect(failed).toMatchObject({ phase: 'failed', error: { code: 'host_unavailable', reason: 'server_unreachable' } })
    expect(failed.moved).toHaveLength(1)
    expect(await legacy.list()).toHaveLength(1)

    await legacy.move(() => flaky)
    const done = await settled()
    expect(done.phase).toBe('done')
    expect(done.moved.sort()).toEqual([shared, plain].sort())
    expect(done.items).toHaveLength(2)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('deletes some or all of what is here, and the folder with the last one', async () => {
    const { shared, plain, principalId } = await earlier()
    await legacy.remove([shared])
    expect(forgotten).toEqual([principalId])
    expect((await legacy.list()).map((item) => item.id)).toEqual([plain])
    await legacy.remove()
    expect(existsSync(dataDir)).toBe(false)
    expect(await server.admin.list()).toEqual([])
  })

  it('refuses to delete while moving, and stops the idle host', async () => {
    await earlier()
    await legacy.move(() => server.admin)
    await expect(legacy.remove()).rejects.toMatchObject({ code: 'invalid_input' })
    await settled()
    await earlier()
    await legacy.list()
    await new Promise((r) => setTimeout(r, 30))
    expect(host.stop).toHaveBeenCalled()
  })
})
