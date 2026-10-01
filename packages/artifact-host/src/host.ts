import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { type ArtifactAdmin, createArtifactAdmin } from './admin.js'
import { createPublicServer } from './http/server.js'
import { MAX_NAME_CHARS } from './limits.js'
import { parseInput } from './schemas.js'
import { createActivityRecorder } from './sharing-admin.js'
import { ArtifactStore } from './store/artifact-store.js'
import { BlobStore } from './store/blobs.js'
import { openDatabase } from './store/db.js'
import { type ArtifactEventKind, SharingStore } from './store/sharing-store.js'

export interface ArtifactHostConfig {
  dataDir: string
  port: number
  host?: '127.0.0.1' | '0.0.0.0'
  anyLoopbackPort?: boolean
  quotaBytes: number
  /** Origins (such as a Tailscale HTTPS address) accepted besides loopback. */
  publicOrigins?: string[]
  /** The owner's display name, shown to the people an artifact is shared with. */
  ownerName?: string
}

export type ArtifactHostEvent =
  | { type: 'changed'; artifactId: string }
  /** Something the owner may want to know right away: a new device, an access request, a comment. */
  | { type: 'activity'; artifactId: string; kind: ArtifactEventKind }

export interface ArtifactHost {
  admin: ArtifactAdmin
  port: number
  close(): Promise<void>
}

const configSchema = z.object({
  dataDir: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  anyLoopbackPort: z.boolean().default(false),
  quotaBytes: z.number().int().positive(),
  publicOrigins: z.array(z.url()).max(8).default([]),
  ownerName: z.string().trim().max(MAX_NAME_CHARS).default(''),
})

/**
 * Opens a host: its data directory (`artifacts.sqlite` and `blobs/`), the admin interface, and the public HTTP server
 * on the configured interface (loopback by default). The host is the only writer of its data directory.
 */
export async function openArtifactHost(
  config: ArtifactHostConfig,
  options: {
    clock?: () => number
    onEvent?: (event: ArtifactHostEvent) => void
    allowConnection?: (remoteAddress: string | undefined) => boolean
  } = {}
): Promise<ArtifactHost> {
  const { dataDir, port, host, anyLoopbackPort, quotaBytes, publicOrigins, ownerName } = parseInput(
    configSchema,
    config
  )
  const clock = options.clock ?? Date.now
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700)

  const store = new ArtifactStore(openDatabase(path.join(dataDir, 'artifacts.sqlite')))
  try {
    const blobs = new BlobStore(path.join(dataDir, 'blobs'))
    // An interrupted write leaves temporary files or blobs no version references; neither is ever served.
    blobs.clearTemp()
    const sharing = new SharingStore(store.db)
    sharing.removeRevokedPrincipals()
    sharing.pruneGuests(clock())
    const referenced = store.referencedBlobs()
    for (const sha of blobs.listAll()) if (!referenced.has(sha)) await blobs.remove(sha)

    const onChange = (artifactId: string) => options.onEvent?.({ type: 'changed', artifactId })
    const onActivity = (artifactId: string, kind: ArtifactEventKind) =>
      options.onEvent?.({ type: 'activity', artifactId, kind })
    const admin = createArtifactAdmin({ store, blobs, clock, quotaBytes, sharing, onChange, onActivity, ownerName })
    const server = createPublicServer({
      store,
      blobs,
      capabilityKey: store.capabilityKey(),
      clock,
      port,
      publicOrigins,
      host,
      anyLoopbackPort,
      allowConnection: options.allowConnection,
      sharing,
      ownerName,
      recordActivity: createActivityRecorder({ sharing, clock, onChange, onActivity }),
      onChange,
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
