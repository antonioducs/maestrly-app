import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { attachmentPreviewRoot } from '../../chat/attachment-artifacts'
import { EnvironmentRuntime } from '../../fleet/instance/environment'
import { type BridgeUpgrade, createInstanceControlServer } from '../../fleet/instance/server'
import { setProjectsDirectoryFallback } from '../../projects-directory'
import { hostFsRoots } from '../host-fs'
import { noteRemoteEditorActivity } from '../../drawer/vscode'
import { startVSCodeServer, vscodeServerEndpoint } from '../../vscode/vscode-server'
import { parseServerModeConfig } from './config'
import { HostEditor } from './host-editor'
import { HostEnvironment } from './host-environment'
import { HostFiles } from './host-files'
import { setHostModelOptions } from './mobile-api'

/** What server mode needs from the main process. */
export interface ServerHostDeps {
  /** Runs the bridge of each connected computer once the control server has authenticated its upgrade. */
  hub: BridgeUpgrade & { closeAll(): void }
  /** Whether chat turns are running: the gateway delays a scheduled update while they are. */
  busy(): boolean
  /** Stops a conversation's turn and closes its terminals and browser views. */
  closeConversation(conversationId: string): Promise<void>
  /** Deletes a conversation with its messages and files. */
  purgeConversation(conversationId: string): Promise<void>
}

/**
 * Starts server mode: this app hosts workspaces and chats for the owner's computers. It serves the control API the
 * gateway expects from an environment, with no bots, and the bridge those computers drive it through. Returns false
 * outside server mode. The window stays hidden; it only parents the native views of the agent's browser.
 */
export async function startServerHostMode(window: BrowserWindow, deps: ServerHostDeps): Promise<boolean> {
  const config = parseServerModeConfig()
  if (!config) return false
  setProjectsDirectoryFallback(config.workspacesRoot)
  // An environment runtime with no bots and no displays: it provisions accounts, sign-ins, skills and MCP servers.
  const runtime = new EnvironmentRuntime({
    config,
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    displays: null,
    floatBrowser: () => {},
    closeConversation: deps.closeConversation,
    purgeConversation: deps.purgeConversation,
    openSettings: () => {},
    holdScreenFocus: () => () => {},
  })
  try {
    await runtime.start()
    // Phones choose a chat's model from what the host's accounts offer, listed as for bots.
    setHostModelOptions(async () => (await runtime.selections()).options)
    // Computers move files of the host's folders, and read the copies it makes of PDF attachments for them.
    const hostFiles = new HostFiles({
      roots: () => hostFsRoots().map((root) => root.path),
      readRoots: () => [attachmentPreviewRoot()],
      uploadsDir: path.join(app.getPath('userData'), 'host-file-uploads'),
    })
    void hostFiles.sweep().catch(() => undefined)
    // Computers open the host's editor (VS Code's serve-web, started when one asks for it) through this server.
    const editor = new HostEditor({
      ensureServer: async () => {
        await startVSCodeServer()
        return vscodeServerEndpoint()
      },
      onActivity: noteRemoteEditorActivity,
    })
    const server = createInstanceControlServer(config, new HostEnvironment(runtime, deps.busy), {
      bridge: deps.hub,
      hostFiles,
      editor,
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.controlPort, config.controlHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
    window.on('closed', async () => {
      deps.hub.closeAll()
      editor.closeAll()
      server.close()
      await runtime.dispose()
    })
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  return true
}
