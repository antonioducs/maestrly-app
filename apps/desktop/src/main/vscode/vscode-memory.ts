import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { excludeFromGitInfo } from '../git-service'
import { MEMORY_SNAPSHOT_FILE, MEMORY_SNAPSHOT_REQUEST_FILE } from './vscode-ext-source'
import type { VSCodeMemorySnapshot } from '../../shared/memory-eviction'
import { PREPARE_EVICTION_TIMEOUT_MS } from '../performance/policy'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const inFlightByCwd = new Map<string, number>()
const idleListeners = new Set<() => void>()

export function onVSCodeBridgeIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => idleListeners.delete(listener)
}

export function hasVSCodeBridgeInFlight(cwd?: string): boolean {
  if (!cwd) return [...inFlightByCwd.values()].some((count) => count > 0)
  return (inFlightByCwd.get(cwd) ?? 0) > 0
}

export function beginVSCodeBridgeOperation(cwd: string): () => void {
  inFlightByCwd.set(cwd, (inFlightByCwd.get(cwd) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = Math.max(0, (inFlightByCwd.get(cwd) ?? 1) - 1)
    if (next === 0) {
      inFlightByCwd.delete(cwd)
      if (!hasVSCodeBridgeInFlight()) for (const listener of idleListeners) listener()
    } else inFlightByCwd.set(cwd, next)
  }
}

function parseSnapshot(value: unknown, requestId: string): VSCodeMemorySnapshot | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (data.requestId !== requestId) return null
  if (typeof data.dirtyDocuments !== 'number' || typeof data.debugActive !== 'boolean') return null
  return {
    dirtyDocuments: data.dirtyDocuments,
    debugActive: data.debugActive,
    operationInFlight: data.operationInFlight === true,
    lastActivityAt: typeof data.lastActivityAt === 'number' ? data.lastActivityAt : Date.now(),
  }
}

export async function requestVSCodeMemorySnapshot(
  cwd: string,
  timeoutMs = PREPARE_EVICTION_TIMEOUT_MS
): Promise<VSCodeMemorySnapshot | null> {
  const dir = path.join(cwd, '.maestrly')
  const requestFile = path.join(dir, MEMORY_SNAPSHOT_REQUEST_FILE)
  const snapshotFile = path.join(dir, MEMORY_SNAPSHOT_FILE)
  const requestId = randomUUID()
  try {
    await fsp.mkdir(dir, { recursive: true })
    await excludeFromGitInfo(cwd, [
      `.maestrly/${MEMORY_SNAPSHOT_FILE}`,
      `.maestrly/${MEMORY_SNAPSHOT_REQUEST_FILE}`,
    ]).catch(() => {})
    await fsp.rm(snapshotFile, { force: true }).catch(() => {})
    await fsp.writeFile(requestFile, JSON.stringify({ id: requestId, ts: Date.now() }))
  } catch {
    return null
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(80)
    try {
      const parsed = parseSnapshot(JSON.parse(await fsp.readFile(snapshotFile, 'utf8')), requestId)
      if (parsed) return parsed
    } catch {
      /* The response has not arrived yet. */
    }
  }
  return null
}
