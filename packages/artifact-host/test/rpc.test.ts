import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import { createAdminClient, type RpcChannel, serveAdmin } from '../src/rpc.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir, text, utf8 } from './helpers.js'

/** Two connected channels that deliver structured clones asynchronously, like a process boundary. */
function channelPair(): [RpcChannel, RpcChannel] {
  const listeners = [new Set<(message: unknown) => void>(), new Set<(message: unknown) => void>()]
  const end = (self: 0 | 1, other: 0 | 1): RpcChannel => ({
    post: (message) => {
      const copy = structuredClone(message)
      queueMicrotask(() => {
        for (const listener of listeners[other]!) listener(copy)
      })
    },
    onMessage: (listener) => {
      listeners[self]!.add(listener)
      return () => listeners[self]!.delete(listener)
    },
  })
  return [end(0, 1), end(1, 0)]
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

let cleanup: () => void
let store: ArtifactStore
let admin: ArtifactAdmin

beforeEach(() => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  admin = createArtifactAdmin({
    store,
    blobs: new BlobStore(path.join(temp.dir, 'blobs')),
    clock: Date.now,
    quotaBytes: 1024 * 1024,
  })
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('admin RPC', () => {
  it('forwards calls and binary results', async () => {
    const [server, clientSide] = channelPair()
    serveAdmin(server, admin)
    const client = createAdminClient(clientSide)
    const created = await client.create({
      title: 'Remote',
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8('<p>remote</p>') }],
    })
    expect((await client.get(created.id))?.title).toBe('Remote')
    const file = await client.readFile(created.id, 1, 'index.html')
    expect(file?.bytes).toBeInstanceOf(Uint8Array)
    expect(text(file?.bytes)).toBe('<p>remote</p>')
    expect(await client.list()).toHaveLength(1)
    client.dispose()
  })

  it('rebuilds host errors and hides unexpected ones', async () => {
    const [server, clientSide] = channelPair()
    const failing = {
      ...admin,
      update: async () => {
        throw new ArtifactHostError('version_conflict', 'Version 2 is the current version', { currentVersion: 2 })
      },
      get: async () => {
        throw new Error('boom')
      },
    } satisfies ArtifactAdmin
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    serveAdmin(server, failing)
    const client = createAdminClient(clientSide)
    const conflict = await errorOf(
      client.update({ id: 'A'.repeat(22), baseVersion: 1, change: { kind: 'edits', edits: [] } })
    )
    expect(conflict.code).toBe('version_conflict')
    expect(conflict.details).toEqual({ currentVersion: 2 })
    const internal = await errorOf(client.get('A'.repeat(22)))
    expect(internal.code).toBe('internal')
    expect(internal.message).not.toContain('boom')
    quiet.mockRestore()
    client.dispose()
  })

  it('refuses unknown methods and ignores unrelated messages', async () => {
    const [server, clientSide] = channelPair()
    serveAdmin(server, admin)
    const replies: unknown[] = []
    clientSide.onMessage((message) => replies.push(message))
    clientSide.post({ type: 'call', id: 1, method: 'constructor', args: [] })
    clientSide.post({ type: 'hello', id: 2, method: 'status', args: [] })
    clientSide.post({ type: 'call', id: 3, method: 'status', args: 'nope' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(replies).toEqual([
      { type: 'result', id: 1, ok: false, error: expect.objectContaining({ code: 'invalid_input' }) },
      { type: 'result', id: 3, ok: false, error: expect.objectContaining({ code: 'invalid_input' }) },
    ])
  })

  it('rejects when the host does not answer or the client is disposed', async () => {
    const [, clientSide] = channelPair()
    const client = createAdminClient(clientSide, { timeoutMs: 10 })
    expect((await errorOf(client.status())).code).toBe('host_unavailable')

    const slow = createAdminClient(channelPair()[1])
    const pending = errorOf(slow.status())
    slow.dispose()
    expect((await pending).code).toBe('host_unavailable')
    expect((await errorOf(slow.status())).code).toBe('host_unavailable')
  })
})
