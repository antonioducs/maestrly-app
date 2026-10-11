import type { Conversation, StandaloneConversation } from '../../../shared/conversation'
import type { IpcRegistrar } from '../../ipc-registrar'
import type { HostEditorOpened, HostEditorPhase, HostEditorSnapshot } from '../../../shared/host-editor'

/** What the editor channels use of the host's main process; tests pass their own. */
export interface HostEditorIpcDeps {
  /** Whether a caller is another computer's renderer reached over the bridge of a workspaces host. */
  isRemoteViewer(sender: unknown): boolean
  conversation(convId: string): Conversation | null
  /** The managed folder of a plain chat, after checking it is still the one Maestrly made. */
  standaloneFolder(conversation: StandaloneConversation): Promise<string>
  /** Keeps the editor's sidecar files out of Git in a project's checkout. */
  ignoreSidecars(folder: string): Promise<void>
  /** Sends what the person selects in the editor of `folder` to the conversation's composer. */
  watch(convId: string, folder: string): Promise<void>
  start(): Promise<void>
  running(): boolean
  cliReady(): boolean
  probe(timeoutMs: number): Promise<'ready' | 'downloading' | 'starting'>
  restart(): Promise<void>
  waitReady(): Promise<void>
  navigate(convId: string, direction: 'back' | 'forward'): Promise<void>
  snapshot(folder: string): Promise<HostEditorSnapshot | null>
  bridgeInFlight(folder: string): boolean
}

const remoteOnly = (): Error =>
  Object.assign(new Error('The editor channels serve other computers only.'), { code: 'remote-viewer-only' })

/**
 * The channels another computer's main process drives this host's editor with, over the bridge (HOST_EDITOR_CHANNELS): open a conversation's
 * folder, follow the editor while it downloads and starts, restart it, move through its history and ask what an
 * editor window would lose if it closed. A window of the host itself shows its own editor and is refused.
 */
export function registerHostEditorIpc(reg: IpcRegistrar, deps: HostEditorIpcDeps): void {
  let failed = false
  const start = (): void => {
    failed = false
    void deps.start().catch(() => {
      failed = true
    })
  }
  const status = async (): Promise<HostEditorPhase> => {
    if (failed) return 'error'
    if (!deps.running()) {
      // The editor stopped meanwhile (idle, or it exited): asking for it starts it again.
      start()
      return deps.cliReady() ? 'starting' : 'downloading'
    }
    return deps.probe(800)
  }
  const folderOf = async (convId: unknown): Promise<string> => {
    const conversation = typeof convId === 'string' ? deps.conversation(convId) : null
    if (!conversation) throw new Error('Unknown conversation.')
    return conversation.scope === 'standalone' ? deps.standaloneFolder(conversation) : conversation.cwd
  }
  const guard = (sender: unknown): void => {
    if (!deps.isRemoteViewer(sender)) throw remoteOnly()
  }

  reg.mhandle('editor:open', async (event, convId: unknown): Promise<HostEditorOpened> => {
    guard(event.sender)
    const folder = await folderOf(convId)
    const conversation = deps.conversation(convId as string)!
    if (conversation.scope !== 'standalone') void deps.ignoreSidecars(folder).catch(() => undefined)
    void deps.watch(convId as string, folder).catch(() => undefined)
    if (!deps.running() || failed) start()
    return { folder, phase: await status() }
  })
  reg.mhandle('editor:status', async (event): Promise<HostEditorPhase> => {
    guard(event.sender)
    return status()
  })
  reg.mhandle('editor:restart', async (event) => {
    guard(event.sender)
    failed = false
    try {
      await deps.restart()
    } catch (error) {
      failed = true
      throw error
    }
    await deps.waitReady().catch(() => undefined)
  })
  reg.mhandle('editor:navigate', async (event, convId: unknown, direction: unknown) => {
    guard(event.sender)
    if (typeof convId !== 'string' || (direction !== 'back' && direction !== 'forward')) return
    await deps.navigate(convId, direction)
  })
  reg.mhandle('editor:snapshot', async (event, convId: unknown): Promise<HostEditorSnapshot | null> => {
    guard(event.sender)
    const folder = await folderOf(convId)
    const snapshot = await deps.snapshot(folder)
    if (!snapshot) return null
    // A debug command the agent runs through the editor is in flight on the host, whatever the editor says.
    return deps.bridgeInFlight(folder) ? { ...snapshot, operationInFlight: true } : snapshot
  })
}
