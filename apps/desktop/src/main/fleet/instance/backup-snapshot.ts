import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { FleetInstanceBackupSnapshot } from '@maestrly/bot-fleet-protocol'
import { validateDatabaseSnapshot } from '../../store/database-path-migration'

/** The folder of the environment's profile where it writes the database copy a backup reads (gateway: same value). */
export const BACKUP_STAGING_NAME = '.maestrly-backup-staging'

let queue: Promise<unknown> = Promise.resolve()
/** Runs one copy or release at a time: two backups of the same environment never write the same folder at once. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}
/** A path inside `home` as the gateway's helper sees it there: relative, with `/` between its parts. */
function relativeToHome(home: string, target: string): string {
  const relative = path.relative(home, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('The environment profile is not inside its home folder.')
  return relative.split(path.sep).join('/')
}

/**
 * Writes a consistent copy of the environment's database for a backup, replacing any copy from before. SQLite's
 * online backup copies the pages in steps and yields between them, so the control server and the bots go on running
 * while it copies; `VACUUM INTO` would hold the process for the whole copy.
 */
export function prepareBackupSnapshot(paths: {
  db: DatabaseSync
  databasePath: string
  userData: string
  home: string
}): Promise<FleetInstanceBackupSnapshot> {
  return serialized(async () => {
    const staging = path.join(paths.userData, BACKUP_STAGING_NAME)
    const target = path.join(staging, path.basename(paths.databasePath))
    const snapshot = relativeToHome(paths.home, target)
    const database = relativeToHome(paths.home, paths.databasePath)
    const partial = target + '.partial'
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true, mode: 0o700 })
      await backup(paths.db, partial)
      // The copy keeps the WAL mode of the database it came from; a backup wants it whole in one file, and the
      // restored environment turns WAL on again when it opens it.
      const copy = new DatabaseSync(partial)
      try {
        copy.exec('PRAGMA journal_mode=DELETE')
      } finally {
        copy.close()
      }
      validateDatabaseSnapshot(partial)
      await rename(partial, target)
      return { snapshot, database, bytes: (await stat(target)).size }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })
}

/** Removes the copy once the backup read it; a copy already gone is fine. */
export function releaseBackupSnapshot(userData: string): Promise<void> {
  return serialized(() => rm(path.join(userData, BACKUP_STAGING_NAME), { recursive: true, force: true }))
}
