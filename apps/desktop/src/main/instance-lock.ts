import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export const INSTANCE_LOCK_FILE = '.agents-instance.lock'

export interface InstanceLockData {
  pid: number
  instance: string
  startedAt: number
}

export function writeInstanceLock(instance: string): void {
  const lockPath = path.join(app.getPath('userData'), INSTANCE_LOCK_FILE)
  const data: InstanceLockData = { pid: process.pid, instance, startedAt: Date.now() }
  writeFileSync(lockPath, JSON.stringify(data), 'utf8')
}

export function releaseInstanceLock(): void {
  const lockPath = path.join(app.getPath('userData'), INSTANCE_LOCK_FILE)
  if (!existsSync(lockPath)) return
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8')) as InstanceLockData
    if (data.pid === process.pid) unlinkSync(lockPath)
  } catch {
    /* Ignore a corrupt lock during best-effort cleanup. */
  }
}
