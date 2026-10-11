import { PERSONAL_MEMORY_SPACE_ID } from '../../shared/memory'
import { readPersonalMemorySettings, onPersonalMemorySettingsChanged } from './personal-memory-settings'
import { EventEmitter } from 'node:events'
import { getMemoryEnabled, setMemoryEnabled } from '../store/workspaces'

export class MemoryDisabledError extends Error {
  readonly code = 'memory-disabled'

  constructor() {
    super('memory-disabled')
    this.name = 'MemoryDisabledError'
  }
}

const events = new EventEmitter()
events.setMaxListeners(50)

/** Shared access gate for retrieval, tools, runners, Companion, watchers, and jobs. */
export function isWorkspaceMemoryEnabled(workspaceId: string): boolean {
  try {
    return getMemoryEnabled(workspaceId)
  } catch {
    // Retrieval runs in chat preflight paths that can be exercised before the store is ready (notably during
    // startup and in isolated runner tests). Treat an unavailable gate as disabled: no memory may leak into a
    // prompt until the workspace setting can be read authoritatively.
    return false
  }
}

export function requireWorkspaceMemoryEnabled(workspaceId: string): void {
  if (!isWorkspaceMemoryEnabled(workspaceId)) throw new MemoryDisabledError()
}

export function setWorkspaceMemoryEnabled(workspaceId: string, enabled: boolean): void {
  const previous = getMemoryEnabled(workspaceId)
  setMemoryEnabled(workspaceId, enabled)
  if (previous !== enabled) events.emit('changed', { workspaceId, enabled })
}

export function onWorkspaceMemoryEnabledChanged(
  listener: (event: { workspaceId: string; enabled: boolean }) => void
): () => void {
  events.on('changed', listener)
  return () => events.off('changed', listener)
}

export function isMemorySpaceEnabled(spaceId: string): boolean {
  return spaceId === PERSONAL_MEMORY_SPACE_ID ? readPersonalMemorySettings().enabled : isWorkspaceMemoryEnabled(spaceId)
}

export function onMemorySpaceEnabledChanged(
  listener: (event: { workspaceId: string; enabled: boolean }) => void
): () => void {
  const workspace = onWorkspaceMemoryEnabledChanged(listener)
  const personal = onPersonalMemorySettingsChanged((settings) =>
    listener({ workspaceId: PERSONAL_MEMORY_SPACE_ID, enabled: settings.enabled })
  )
  return () => {
    workspace()
    personal()
  }
}
