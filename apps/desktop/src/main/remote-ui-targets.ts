import { recordIpcSend } from './performance/metrics'

/**
 * Renderers of other computers, reached through the bridge while this app hosts workspaces on a server (see
 * remote-host/server). Each one stands for a main window or a drawer panel of that computer and receives what the
 * equivalent renderer of this app would. On a desktop the registry stays empty and nothing here runs.
 */
export interface RemoteUiTarget {
  /** Negative: never the id of a real WebContents. */
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export type RemoteUiTargetMeta = { role: 'main' } | { role: 'panel'; convId: string; panel: string }

const targets = new Map<RemoteUiTarget, RemoteUiTargetMeta>()

/** Returns the function that forgets the target. */
export function registerRemoteUiTarget(target: RemoteUiTarget, meta: RemoteUiTargetMeta): () => void {
  targets.set(target, meta)
  return () => void targets.delete(target)
}

export const isRemoteUiTarget = (value: unknown): boolean => targets.has(value as RemoteUiTarget)

export function sendToRemoteUiTargets(
  match: (meta: RemoteUiTargetMeta) => boolean,
  channel: string,
  payload?: unknown
): void {
  for (const [target, meta] of [...targets]) {
    if (!match(meta)) continue
    if (target.isDestroyed()) {
      targets.delete(target)
      continue
    }
    try {
      target.send(channel, payload)
      recordIpcSend()
    } catch {
      targets.delete(target)
    }
  }
}

/** What this app's main window receives about the profile also goes to the main renderer of each connected computer. */
export const sendToRemoteMains = (channel: string, payload?: unknown): void =>
  sendToRemoteUiTargets((meta) => meta.role === 'main', channel, payload)

export const hasRemoteMains = (): boolean => [...targets.values()].some((meta) => meta.role === 'main')
