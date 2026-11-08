import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BACKUP_STAGING_NAME,
  prepareBackupSnapshot,
  releaseBackupSnapshot,
} from '../../src/main/fleet/instance/backup-snapshot'
import { setAppSetting } from '../../src/main/store'
import { getDb } from '../../src/main/store/db'
import { closeDb, freshDb } from '../helpers/db'

let home: string
let userData: string
beforeEach(async () => {
  freshDb()
  home = await mkdtemp(path.join(os.tmpdir(), 'backup-snapshot-home-'))
  userData = path.join(home, '.config', 'maestrly-app-dev')
})
afterEach(async () => {
  closeDb()
  await rm(home, { recursive: true, force: true })
})
const paths = () => ({ db: getDb(), databasePath: path.join(userData, 'maestrly-agents.db'), userData, home })
function readSetting(file: string, key: string): unknown {
  const copy = new DatabaseSync(file, { readOnly: true })
  try {
    return (copy.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: unknown } | undefined)
      ?.value
  } finally {
    copy.close()
  }
}

describe('database copies for backups', () => {
  it('writes a consistent copy the gateway finds by its path in the home folder', async () => {
    setAppSetting('backup.test', 'one')
    const result = await prepareBackupSnapshot(paths())
    expect(result).toMatchObject({
      snapshot: `.config/maestrly-app-dev/${BACKUP_STAGING_NAME}/maestrly-agents.db`,
      database: '.config/maestrly-app-dev/maestrly-agents.db',
    })
    const file = path.join(home, result.snapshot)
    expect(result.bytes).toBe((await stat(file)).size)
    expect(readSetting(file, 'backup.test')).toBe('one')
  })

  it('replaces the copy from before and leaves nothing half written', async () => {
    setAppSetting('backup.test', 'one')
    await prepareBackupSnapshot(paths())
    setAppSetting('backup.test', 'two')
    const result = await prepareBackupSnapshot(paths())
    expect(await readdir(path.join(userData, BACKUP_STAGING_NAME))).toEqual(['maestrly-agents.db'])
    expect(readSetting(path.join(home, result.snapshot), 'backup.test')).toBe('two')
  })

  it('refuses a profile outside the home folder and leaves no copy behind', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'backup-snapshot-outside-'))
    try {
      await expect(
        prepareBackupSnapshot({ ...paths(), userData: outside, databasePath: path.join(outside, 'maestrly-agents.db') })
      ).rejects.toThrow('not inside its home folder')
      expect(existsSync(path.join(outside, BACKUP_STAGING_NAME))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('removes the copy, and a copy already gone is fine', async () => {
    await prepareBackupSnapshot(paths())
    await releaseBackupSnapshot(userData)
    expect(existsSync(path.join(userData, BACKUP_STAGING_NAME))).toBe(false)
    await expect(releaseBackupSnapshot(userData)).resolves.toBeUndefined()
  })

  it('makes one copy at a time', async () => {
    setAppSetting('backup.test', 'both')
    const [first, second] = await Promise.all([prepareBackupSnapshot(paths()), prepareBackupSnapshot(paths())])
    expect(first.snapshot).toBe(second.snapshot)
    expect(readSetting(path.join(home, second.snapshot), 'backup.test')).toBe('both')
    expect(await readdir(path.join(userData, BACKUP_STAGING_NAME))).toEqual(['maestrly-agents.db'])
  })
})
