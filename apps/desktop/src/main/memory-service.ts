import type { BrowserWindow } from 'electron'
import { safeWindowSend } from './window-ipc'
import {
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  onLocalMemoryChange,
  updateLocalMemory,
} from './memory/local-memory-service'
import { migrateAllLegacyMemories, migrateLegacyMemory } from './memory/legacy-memory-migrator'
import { onMemoryIndexStatus } from './memory/index'
import { onWorkspaceMemoryEnabledChanged } from './memory/access'

const LEGACY_MANUAL_PREFIX = 'legacy-manual:'
let win: BrowserWindow | null = null
let disposeChanges: (() => void) | undefined
let disposeIndexStatus: (() => void) | undefined
let disposeEnabled: (() => void) | undefined

export function initMemoryService(window: BrowserWindow): void {
  win = window
  disposeChanges?.()
  disposeIndexStatus?.()
  disposeEnabled?.()
  disposeChanges = onLocalMemoryChange((event) => safeWindowSend(win, 'memory:changed', event))
  disposeIndexStatus = onMemoryIndexStatus((status) => safeWindowSend(win, 'memory:index-status', status))
  disposeEnabled = onWorkspaceMemoryEnabledChanged(({ workspaceId }) =>
    safeWindowSend(win, 'memory:changed', { workspaceId, kind: 'enabled-changed' })
  )
}

export { migrateAllLegacyMemories, migrateLegacyMemory }

/** Deprecated alias: bounded projection of active memories, never the former monolithic document. */
export async function readMemory(workspaceId: string): Promise<string> {
  await migrateLegacyMemory(workspaceId)
  const records = listLocalMemories(workspaceId, { status: 'active', limit: 100 })
  let projection = ''
  for (const memory of records) {
    const block = `## ${memory.title}\n\n${memory.content.trim()}\n\n`
    if (projection.length + block.length > 32 * 1024) break
    projection += block
  }
  return projection.trimEnd()
}

/** Deprecated alias: modifies only the reserved legacy-manual:<workspace> record. */
export async function writeMemory(workspaceId: string, content: string, external = false): Promise<void> {
  await migrateLegacyMemory(workspaceId)
  const id = `${LEGACY_MANUAL_PREFIX}${workspaceId}`
  const existing = getLocalMemory(workspaceId, id)
  if (existing) {
    updateLocalMemory(workspaceId, id, { title: 'Legacy manual memory', content, status: 'active' })
  } else {
    createLocalMemory({
      id,
      workspaceId,
      title: 'Legacy manual memory',
      content,
      type: 'reference',
      tags: ['legacy-manual'],
      source: external ? 'agent' : 'user',
    })
  }
}

/** Deprecated alias: each append creates a separate observable record. */
export async function appendMemory(workspaceId: string, text: string, external = false): Promise<void> {
  await migrateLegacyMemory(workspaceId)
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .find(Boolean)
  createLocalMemory({
    workspaceId,
    title: (firstLine || 'Added memory').slice(0, 240),
    content: text,
    type: 'reference',
    source: external ? 'agent' : 'user',
  })
}

/** One-release compatibility: ensure import only; memory.md is no longer watched. */
export function watchMemory(workspaceId: string): void {
  void migrateLegacyMemory(workspaceId)
}

export function unwatchMemory(_workspaceId: string): void {}

export function disposeMemory(): void {
  disposeChanges?.()
  disposeIndexStatus?.()
  disposeEnabled?.()
  disposeChanges = undefined
  disposeIndexStatus = undefined
  disposeEnabled = undefined
  win = null
}
