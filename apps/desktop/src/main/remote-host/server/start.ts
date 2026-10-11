import { app, type BrowserWindow } from 'electron'
import { EnvironmentRuntime } from '../../fleet/instance/environment'
import { type BridgeUpgrade, createInstanceControlServer } from '../../fleet/instance/server'
import { setProjectsDirectoryFallback } from '../../projects-directory'
import { parseServerModeConfig } from './config'
import { HostEnvironment } from './host-environment'

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
    const server = createInstanceControlServer(config, new HostEnvironment(runtime, deps.busy), { bridge: deps.hub })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.controlPort, config.controlHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
    window.on('closed', async () => {
      deps.hub.closeAll()
      server.close()
      await runtime.dispose()
    })
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  return true
}
