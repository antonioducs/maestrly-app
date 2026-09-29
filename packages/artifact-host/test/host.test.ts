import { statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactHostError } from '../src/errors.js'
import { type ArtifactHost, type ArtifactHostEvent, openArtifactHost } from '../src/host.js'
import { DEFAULT_QUOTA_BYTES } from '../src/limits.js'
import { BlobStore } from '../src/store/blobs.js'
import { tempDir, utf8 } from './helpers.js'

let root: string
let cleanup: () => void
let dataDir: string
const hosts: ArtifactHost[] = []

async function open(port = 0, onEvent?: (event: ArtifactHostEvent) => void): Promise<ArtifactHost> {
  const host = await openArtifactHost({ dataDir, port, quotaBytes: DEFAULT_QUOTA_BYTES }, { onEvent })
  hosts.push(host)
  return host
}

const input = {
  title: 'Hosted',
  owner: { kind: 'local' as const, id: 'local' },
  origin: { workspaceId: null, conversationId: null, conversationTitle: null },
  files: [{ path: 'index.html', bytes: utf8('<p>hosted</p>') }],
}

beforeEach(() => {
  ;({ dir: root, cleanup } = tempDir())
  dataDir = path.join(root, 'artifacts')
})
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  cleanup()
})

describe('openArtifactHost', () => {
  it.skipIf(process.platform === 'win32')('creates an owner-only data directory', async () => {
    await open()
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
  })

  it('serves what the admin creates, and keeps it across restarts', async () => {
    const host = await open()
    const { id } = await host.admin.create(input)
    const shell = await fetch(`http://127.0.0.1:${host.port}/a/${id}`)
    expect(shell.status).toBe(200)
    await host.close()
    const reopened = await open()
    expect((await reopened.admin.get(id))?.title).toBe('Hosted')
  })

  it('removes orphaned and temporary blobs when it opens', async () => {
    const host = await open()
    const { id } = await host.admin.create(input)
    await host.close()
    const blobs = new BlobStore(path.join(dataDir, 'blobs'))
    await blobs.put(utf8('orphan'))
    writeFileSync(path.join(dataDir, 'blobs', 'tmp', 'partial'), 'x')
    expect(blobs.listAll()).toHaveLength(2)
    const reopened = await open()
    expect(new BlobStore(path.join(dataDir, 'blobs')).listAll()).toHaveLength(1)
    expect((await reopened.admin.status()).storageBytes).toBe(13)
    expect(await reopened.admin.listFiles(id)).toHaveLength(1)
  })

  it('reports a busy port and releases the database', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busy = (blocker.address() as net.AddressInfo).port
    try {
      const error = await open(busy).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(ArtifactHostError)
      expect((error as ArtifactHostError).code).toBe('port_in_use')
      const host = await open()
      expect((await host.admin.status()).artifactCount).toBe(0)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })

  it('announces changes', async () => {
    const events: ArtifactHostEvent[] = []
    const host = await open(0, (event) => events.push(event))
    const { id } = await host.admin.create(input)
    await host.admin.delete(id)
    expect(events).toEqual([
      { type: 'changed', artifactId: id },
      { type: 'changed', artifactId: id },
    ])
  })

  it('rejects an invalid configuration', async () => {
    const error = await openArtifactHost({ dataDir: '', port: -1, quotaBytes: 0 }).catch((reason: unknown) => reason)
    expect((error as ArtifactHostError).code).toBe('invalid_input')
  })
})
