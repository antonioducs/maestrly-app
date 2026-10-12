import type { VSCodeMemorySnapshot } from './memory-eviction'

/**
 * The editor of a conversation that runs on a remote host: VS Code's `serve-web` on the host, shown in this computer's
 * drawer. This computer's main process drives it over the host bridge with these channels; the editor itself is
 * reached through the gateway (see main/remote-host/client/editor-proxy and main/remote-host/server/host-editor).
 */

/** Where the host's editor is: being downloaded, starting, serving, or unable to start. */
export type HostEditorPhase = 'downloading' | 'starting' | 'ready' | 'error'

export interface HostEditorOpened {
  /** The conversation's folder on the host, which the editor opens. */
  folder: string
  phase: HostEditorPhase
}

/** What an editor window holds that closing it would lose: unsaved files, a debug session, a call in progress. */
export type HostEditorSnapshot = VSCodeMemorySnapshot

/** Channels this computer's main process invokes on a host; the host serves them only to another computer. */
export const HOST_EDITOR_CHANNELS = {
  /** `(convId)` → HostEditorOpened: prepares the conversation's folder and starts the editor. */
  open: 'editor:open',
  /** `()` → HostEditorPhase. */
  status: 'editor:status',
  /** `()`: restarts the editor and resolves once it serves again. */
  restart: 'editor:restart',
  /** `(convId, 'back' | 'forward')`: moves the conversation's editor through its history. */
  navigate: 'editor:navigate',
  /** `(convId)` → HostEditorSnapshot | null. */
  snapshot: 'editor:snapshot',
} as const

export const isHostEditorPhase = (value: unknown): value is HostEditorPhase =>
  value === 'downloading' || value === 'starting' || value === 'ready' || value === 'error'
