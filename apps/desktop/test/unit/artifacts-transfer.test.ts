import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type ArtifactAdmin,
  type ArtifactHost,
  ArtifactHostError,
  MAX_FILES_PER_VERSION,
  openArtifactHost,
} from '@maestrly/artifact-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batchBlobs, MAX_BLOB_BATCH_BYTES, transferArtifact } from '../../src/main/artifacts/transfer'

const encode = (text: string) => new TextEncoder().encode(text)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let root: string
let source: ArtifactHost
let target: ArtifactHost

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artifacts-transfer-'))
  ;[source, target] = await Promise.all(
    ['source', 'target'].map((name) =>
      openArtifactHost({ dataDir: path.join(root, name), port: 0, quotaBytes: 10 * 1024 * 1024 })
    )
  )
})
afterEach(async () => {
  await Promise.all([source.close(), target.close()])
  rmSync(root, { recursive: true, force: true })
})

async function published(): Promise<string> {
  const { id } = await source.admin.create({
    title: 'Moving',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: 'ws', conversationId: 'conv', conversationTitle: 'Chat' },
    files: [
      { path: 'index.html', bytes: encode('<h1>One</h1>') },
      { path: 'app.css', bytes: encode('h1{}') },
    ],
  })
  await source.admin.update({
    id,
    baseVersion: 1,
    change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'One', newText: 'Two' }] },
  })
  await source.admin.setThumbnail(id, 2, PNG)
  await source.admin.addComment(id, { author: 'owner', version: 1, body: 'Looks good' })
  return id
}

/** The target, with some of its methods replaced. */
function wrap(admin: ArtifactAdmin, overrides: Partial<ArtifactAdmin>): ArtifactAdmin {
  return new Proxy(admin, {
    get: (object, key) =>
      key in overrides ? overrides[key as keyof ArtifactAdmin] : object[key as keyof ArtifactAdmin],
  })
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

describe('transferArtifact', () => {
  it('moves an artifact with its ID, history, comments and preview, then removes it from the source', async () => {
    const id = await published()
    const steps: string[] = []
    await transferArtifact(source.admin, target.admin, id, (step, progress) => steps.push(`${step}:${progress}`))
    expect(await source.admin.get(id)).toBeNull()
    const moved = (await target.admin.get(id))!
    expect(moved).toMatchObject({ id, title: 'Moving', currentVersion: 2, thumbnailVersion: 2, openComments: 1 })
    expect(new TextDecoder().decode((await target.admin.readFile(id, 2, 'index.html'))!.bytes)).toBe('<h1>Two</h1>')
    expect(steps).toEqual(['upload:0', 'upload:1', 'verify:0', 'verify:1', 'remove:0', 'remove:1'])
  })

  it('leaves the source untouched when the import fails', async () => {
    const id = await published()
    const failing = wrap(target.admin, {
      importArtifact: async () => {
        throw new ArtifactHostError('quota_exceeded', 'Full')
      },
    })
    expect((await errorOf(transferArtifact(source.admin, failing, id, () => {}))).code).toBe('quota_exceeded')
    expect(await source.admin.get(id)).not.toBeNull()
    expect(await target.admin.get(id)).toBeNull()
  })

  it('resumes after an interrupted check without duplicating the artifact', async () => {
    const id = await published()
    let checks = 0
    const flaky = wrap(target.admin, {
      exportArtifact: async (value: string) => {
        if (checks++ === 0) throw new ArtifactHostError('host_unavailable', 'Offline', { reason: 'server_unreachable' })
        return target.admin.exportArtifact(value)
      },
    })
    expect((await errorOf(transferArtifact(source.admin, flaky, id, () => {}))).code).toBe('host_unavailable')
    expect(await source.admin.get(id)).not.toBeNull()
    expect(await target.admin.get(id)).not.toBeNull()
    await transferArtifact(source.admin, flaky, id, () => {})
    expect(await source.admin.get(id)).toBeNull()
    expect((await target.admin.list()).map((item) => item.id)).toEqual([id])
  })

  it('keeps the source when the copy does not match', async () => {
    const id = await published()
    const lying = wrap(target.admin, {
      exportArtifact: async (value: string) => ({ ...(await target.admin.exportArtifact(value)), title: 'Changed' }),
    })
    const error = await errorOf(transferArtifact(source.admin, lying, id, () => {}))
    expect(error.details?.reason).toBe('verify_failed')
    expect(await source.admin.get(id)).not.toBeNull()
  })

  it('sends the files again, once, when the server dropped them before the import', async () => {
    const id = await published()
    const put = vi.spyOn(target.admin, 'putBlobs')
    let imports = 0
    const forgetful = wrap(target.admin, {
      importArtifact: async (input) => {
        if (imports++ === 0)
          throw new ArtifactHostError('storage', 'Missing', { reason: 'missing_blob', sha256: 'a'.repeat(64) })
        return target.admin.importArtifact(input)
      },
    })
    await transferArtifact(source.admin, forgetful, id, () => {})
    expect(put).toHaveBeenCalledTimes(2)
    expect(await source.admin.get(id)).toBeNull()

    const again = await published()
    const lost = wrap(target.admin, {
      importArtifact: async () => {
        throw new ArtifactHostError('storage', 'Missing', { reason: 'missing_blob' })
      },
    })
    expect((await errorOf(transferArtifact(source.admin, lost, again, () => {}))).details?.reason).toBe('missing_blob')
    expect(await source.admin.get(again)).not.toBeNull()
  })

  it('stops before deleting when aborted', async () => {
    const id = await published()
    const abort = new AbortController()
    await expect(
      transferArtifact(source.admin, target.admin, id, (step) => step === 'verify' && abort.abort(), abort.signal)
    ).rejects.toThrow()
    expect(await source.admin.get(id)).not.toBeNull()
  })
})

describe('batchBlobs', () => {
  it('keeps every call under the byte and file limits', () => {
    const MiB = 1024 * 1024
    const sizes = [10 * MiB, 10 * MiB, 10 * MiB, 10 * MiB, 1, 10 * MiB]
    const batches = batchBlobs(sizes.map((bytes) => ({ bytes })))
    expect(batches.map((batch) => batch.map((blob) => blob.bytes))).toEqual([
      [10 * MiB, 10 * MiB, 10 * MiB, 10 * MiB],
      [1, 10 * MiB],
    ])
    for (const batch of batches)
      expect(batch.reduce((sum, blob) => sum + blob.bytes, 0)).toBeLessThanOrEqual(MAX_BLOB_BATCH_BYTES)
    const many = batchBlobs(Array.from({ length: MAX_FILES_PER_VERSION + 1 }, () => ({ bytes: 1 })))
    expect(many.map((batch) => batch.length)).toEqual([MAX_FILES_PER_VERSION, 1])
    expect(batchBlobs([])).toEqual([])
  })
})
