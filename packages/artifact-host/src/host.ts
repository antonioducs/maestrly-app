import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { type ArtifactAdmin, createArtifactAdmin } from './admin.js'
import { createPublicServer } from './http/server.js'
import { parseInput } from './schemas.js'
import { ArtifactStore } from './store/artifact-store.js'
import { BlobStore } from './store/blobs.js'
import { openDatabase } from './store/db.js'

export interface ArtifactHostConfig {
  dataDir: string
  port: number
  quotaBytes: number
  /** Origins (such as a Tailscale HTTPS address) accepted besides loopback. */
  publicOrigins?: string[]
}

export type ArtifactHostEvent = { type: 'changed'; artifactId: string }

export interface ArtifactHost {
  admin: ArtifactAdmin
  port: number
  close(): Promise<void>
}

const configSchema = z.object({
  dataDir: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  quotaBytes: z.number().int().positive(),
  publicOrigins: z.array(z.url()).max(8).default([]),
})

/**
 * Opens a host: its data directory (`artifacts.sqlite` and `blobs/`), the admin interface, and the public HTTP server
 * on loopback. The host is the only writer of its data directory.
 */
export async function openArtifactHost(
  config: ArtifactHostConfig,
  options: { clock?: () => number; onEvent?: (event: ArtifactHostEvent) => void } = {}
): Promise<ArtifactHost> {
  const { dataDir, port, quotaBytes, publicOrigins } = parseInput(configSchema, config)
  const clock = options.clock ?? Date.now
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700)

  const store = new ArtifactStore(openDatabase(path.join(dataDir, 'artifacts.sqlite')))
  try {
    const blobs = new BlobStore(path.join(dataDir, 'blobs'))
    // An interrupted write leaves temporary files or blobs no version references; neither is ever served.
    blobs.clearTemp()
    const referenced = store.referencedBlobs()
    for (const sha of blobs.listAll()) if (!referenced.has(sha)) await blobs.remove(sha)

    const admin = createArtifactAdmin({
      store,
      blobs,
      clock,
      quotaBytes,
      onChange: (artifactId) => options.onEvent?.({ type: 'changed', artifactId }),
    })
    const server = createPublicServer({
      store,
      blobs,
      capabilityKey: store.capabilityKey(),
      clock,
      port,
      publicOrigins,
    })
    const boundPort = await server.listen()
    let closed = false
    return {
      admin,
      port: boundPort,
      async close() {
        if (closed) return
        closed = true
        await server.close()
        store.close()
      },
    }
  } catch (error) {
    store.close()
    throw error
  }
}
