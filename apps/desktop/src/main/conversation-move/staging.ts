import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { MOVE_BACKUP_RETENTION_MS } from '../../shared/conversation-move'
import { hostFsRoots } from '../remote-host/host-fs'
import { listActiveMoveEndpoints } from './endpoint-store'
import { listIncompleteMoves } from './store'

/**
 * Each move's files on one host: the exported package (kept by the source as a backup), a package received for
 * import, and what was extracted from it. Another computer reaches a host's files only inside its roots, so the
 * folder lies inside them.
 */
const OPERATION_ID = /^[0-9a-f-]{36}$/i
const STAGING_DIR = 'conversation-moves'
const HOST_ROOT_STAGING_DIR = '.maestrly-conversation-moves'

const within = (target: string, root: string): boolean => target === root || target.startsWith(root + path.sep)

async function real(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target))
}

async function stagingRoot(): Promise<string> {
  const userData = path.join(app.getPath('userData'), STAGING_DIR)
  const roots = await Promise.all(hostFsRoots().map((root) => real(root.path)))
  const parent = await real(app.getPath('userData'))
  if (roots.length === 0 || roots.some((root) => within(parent, root))) return userData
  return path.join(roots[0], HOST_ROOT_STAGING_DIR)
}

/** The move's staging folder on this host, created when missing. */
export async function moveStagingDirectory(operationId: string): Promise<string> {
  if (!OPERATION_ID.test(operationId)) throw new Error('Invalid move operation id.')
  const directory = path.join(await stagingRoot(), operationId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

export async function removeMoveStaging(operationId: string): Promise<void> {
  if (!OPERATION_ID.test(operationId)) return
  await rm(path.join(await stagingRoot(), operationId), { recursive: true, force: true })
}

/** Removes staging folders no move still needs once they are older than the backup retention. */
export async function sweepMoveStaging(now = Date.now()): Promise<void> {
  const root = await stagingRoot()
  const entries = await readdir(root).catch(() => [] as string[])
  const busy = new Set([
    ...listActiveMoveEndpoints().map((endpoint) => endpoint.operationId),
    ...listIncompleteMoves().map((move) => move.id),
  ])
  for (const name of entries) {
    if (!OPERATION_ID.test(name) || busy.has(name)) continue
    const info = await stat(path.join(root, name)).catch(() => null)
    if (info && now - info.mtimeMs > MOVE_BACKUP_RETENTION_MS)
      await rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)
  }
}
