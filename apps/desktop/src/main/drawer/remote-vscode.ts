import { session } from 'electron'
import { type HostId, parseHostKey } from '../../shared/host-key'
import {
  type HostEditorOpened,
  type HostEditorPhase,
  type HostEditorSnapshot,
  isHostEditorPhase,
} from '../../shared/host-editor'
import { isRemoteConversation } from '../drawer-scope'
import { editorFailureReason, remoteEditorPartition } from '../remote-host/client/editor'
import { EDITOR_ACCESS_COOKIE, type EditorUnavailableReason } from '../remote-host/client/editor-proxy'
import { drawers } from './state'
import {
  type RemoteVSCodeHandlers,
  type VSCodeLoadPhase,
  isVSCodePending,
  isVSCodeShowing,
  loadVSCode,
  reloadAllVSCode,
  showVSCodeError,
  showVSCodeLoading,
  showVSCodeLoadingAll,
} from './vscode'

/**
 * The editor of a conversation that runs on a remote host: VS Code's serve-web on the host, opened here in a native
 * view of the drawer, at the origin of this computer's proxy to that host (remote-host/client/editor-proxy). The host
 * is asked over its bridge to open the conversation's folder and start the editor; the view shows the usual loading
 * page meanwhile, and a page that says why when the editor cannot be reached.
 */
export interface RemoteVSCodeDeps {
  editors: {
    proxy(hostId: HostId): Promise<{ origin(): string; readonly access: string }>
    call<T>(hostId: HostId, channel: string, ...args: unknown[]): Promise<T>
  }
  /** This computer's VS Code settings, which the editor takes as it does here. */
  settingsJson(): Promise<string>
  /** How long the host may take to download and start its editor. */
  readyTimeoutMs?: number
  pollMs?: number
  /** Puts the proxy's access cookie in the session of the host's editor views. */
  setAccessCookie?(partition: string, origin: string, value: string): Promise<void>
}

const READY_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 1_200
/** A snapshot the host does not give in time leaves the view open. */
const SNAPSHOT_TIMEOUT_MS = 10_000

const FAILURE_PHASES: Record<EditorUnavailableReason, VSCodeLoadPhase> = {
  'unknown-host': 'remoteOffline',
  offline: 'remoteOffline',
  unauthorized: 'remoteUnauthorized',
  'gateway-update-required': 'remoteGatewayUpdate',
  'host-update-required': 'remoteHostUpdate',
  failed: 'remoteFailed',
}

const waitingPhase = (phase: HostEditorPhase): VSCodeLoadPhase =>
  phase === 'downloading' ? 'remoteDownloading' : 'remoteStarting'

/** The editor's address for a folder of the host, at this computer's origin for that host. */
export function remoteEditorUrl(origin: string, folder: string): string {
  const url = new URL(origin + '/')
  if (folder) url.searchParams.set('folder', folder)
  return url.toString()
}

const setCookie = (partition: string, origin: string, value: string): Promise<void> =>
  session.fromPartition(partition).cookies.set({
    url: origin,
    name: EDITOR_ACCESS_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'strict',
  })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const loading = new Map<string, Promise<void>>()

/** Opens the editor of `convKey`, a remote host's conversation as this computer's drawer knows it (its host key). */
export function loadRemoteVSCode(convKey: string, deps: RemoteVSCodeDeps): Promise<void> {
  const running = loading.get(convKey)
  if (running) return running
  const task = openEditor(convKey, deps).finally(() => loading.delete(convKey))
  loading.set(convKey, task)
  return task
}

async function openEditor(convKey: string, deps: RemoteVSCodeDeps): Promise<void> {
  const { hostId, id } = parseHostKey(convKey)
  try {
    const proxy = await deps.editors.proxy(hostId)
    const origin = proxy.origin()
    await (deps.setAccessCookie ?? setCookie)(remoteEditorPartition(hostId), origin, proxy.access)
    // A first opening shows something at once: asking the host takes a round trip.
    if (!drawers.get(convKey)?.vscodeView) showVSCodeLoading(convKey, '', 'remoteStarting')
    const opened = await deps.editors.call<HostEditorOpened>(hostId, 'editor:open', id)
    const url = remoteEditorUrl(origin, opened.folder)
    const settingsJson = await deps.settingsJson()
    if (isVSCodeShowing(convKey, url) || opened.phase === 'ready') return loadVSCode(convKey, url, settingsJson)
    if (isVSCodePending(convKey, url)) return
    if (opened.phase === 'error') return showVSCodeError(convKey, 'remoteFailed')
    showVSCodeLoading(convKey, url, waitingPhase(opened.phase))
    const phase = await waitUntilReady(convKey, hostId, url, opened.phase, deps)
    if (phase === 'ready') loadVSCode(convKey, url, settingsJson)
    else if (phase !== null) showVSCodeError(convKey, 'remoteFailed')
  } catch (error) {
    showVSCodeError(convKey, FAILURE_PHASES[editorFailureReason(error)])
  }
}

/**
 * Follows the host's editor until it serves; null when the view stopped waiting for this URL (closed, or opened at
 * another address meanwhile).
 */
async function waitUntilReady(
  convKey: string,
  hostId: HostId,
  url: string,
  first: HostEditorPhase,
  deps: RemoteVSCodeDeps
): Promise<HostEditorPhase | null> {
  const deadline = Date.now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
  let shown = first
  for (;;) {
    await sleep(deps.pollMs ?? POLL_MS)
    if (!isVSCodePending(convKey, url)) return null
    const phase = await deps.editors.call<unknown>(hostId, 'editor:status')
    if (!isHostEditorPhase(phase) || phase === 'error') return 'error'
    if (phase === 'ready') return phase
    if (Date.now() > deadline) return 'error'
    if (phase !== shown) {
      shown = phase
      showVSCodeLoading(convKey, url, waitingPhase(phase))
    }
  }
}

/** Restarts a remote host's editor and opens its views there again, as the restart button does for this computer's. */
export async function restartRemoteVSCode(convKey: string, deps: RemoteVSCodeDeps): Promise<void> {
  const { hostId } = parseHostKey(convKey)
  const ofHost = (key: string): boolean => isRemoteConversation(key) && parseHostKey(key).hostId === hostId
  showVSCodeLoadingAll('restarting', ofHost)
  try {
    await deps.editors.call(hostId, 'editor:restart')
    const proxy = await deps.editors.proxy(hostId)
    reloadAllVSCode((folder) => remoteEditorUrl(proxy.origin(), folder), await deps.settingsJson(), ofHost)
  } catch (error) {
    const phase = FAILURE_PHASES[editorFailureReason(error)]
    for (const [key, drawer] of drawers) if (ofHost(key) && drawer.vscodeView) showVSCodeError(key, phase)
  }
}

/** What drawer/vscode asks of a remote host's editor views: history navigation, and what closing one would lose. */
export function remoteVSCodeHandlers(deps: Pick<RemoteVSCodeDeps, 'editors'>): RemoteVSCodeHandlers {
  return {
    navigate: async (convKey, direction) => {
      const { hostId, id } = parseHostKey(convKey)
      await deps.editors.call(hostId, 'editor:navigate', id, direction).catch(() => undefined)
    },
    snapshot: async (convKey) => {
      const { hostId, id } = parseHostKey(convKey)
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS)
      })
      try {
        return await Promise.race([
          deps.editors.call<HostEditorSnapshot | null>(hostId, 'editor:snapshot', id).catch(() => null),
          late,
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
