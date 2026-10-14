import { accessSync, constants, existsSync } from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { attachmentPreviewRoot } from '../../chat/attachment-artifacts'
import { startBotDesktop } from '../../fleet/instance/desktop/bot-desktop'
import { DisplayManager } from '../../fleet/instance/displays'
import { EnvironmentRuntime, productionDisplayDeps } from '../../fleet/instance/environment'
import { SCREEN_ENCODER_PROGRAM } from '../../fleet/instance/screen-encoder'
import { type BridgeUpgrade, createInstanceControlServer } from '../../fleet/instance/server'
import { tMain } from '../../i18n'
import { canUseComputer } from '../../mcp/tools/computer'
import { setProjectsDirectoryFallback } from '../../projects-directory'
import { getConversation } from '../../store'
import { hostFsRoots } from '../host-fs'
import { noteRemoteEditorActivity } from '../../drawer/vscode'
import { startVSCodeServer, vscodeServerEndpoint } from '../../vscode/vscode-server'
import { listDisplayWindows } from './computer-windows'
import { type BrowserPlacement, ConversationComputers } from './computers'
import { setServerComputers } from './computers-registry'
import { parseServerModeConfig } from './config'
import { HostEditor } from './host-editor'
import { HostEnvironment } from './host-environment'
import { HostFiles } from './host-files'
import { setHostModelOptions } from './mobile-api'
import { watchChatAttention } from './chat-attention'
import { getChatPermissionBroker, getChatQuestionBroker } from '../../chat/service'
import { getConversation } from '../../store'
import { getPending as getPendingPlan } from '../../plan-broker'

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
  /** Follows the status of the host's conversations; returns how to stop. */
  watchStatuses(listener: (conversationId: string, status: string) => void): () => void
  /** Moves a conversation's browser window where its computer or its Browser tab's video needs it. */
  placeBrowser(conversationId: string, placement: BrowserPlacement): void
}

/** The programs a conversation's computer runs, which the bot image has. */
const COMPUTER_PROGRAMS = ['Xvfb', 'openbox', 'tint2', 'maestrly-browser-presenter', 'xprop']

function onPath(program: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    try {
      accessSync(path.join(directory, program), constants.X_OK)
      return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

/** Whether this host can give its conversations computers: Linux, its X display, and the image's programs. */
function computersAvailable(): boolean {
  return (
    process.platform === 'linux' &&
    canUseComputer() &&
    existsSync(SCREEN_ENCODER_PROGRAM) &&
    COMPUTER_PROGRAMS.every(onPath)
  )
}

function log(message: string): void {
  console.error(JSON.stringify({ component: 'remote-computers', level: 'info', message }))
}

/** The computers of the host's conversations and the display manager they run on. */
function startComputers(deps: ServerHostDeps): { computers: ConversationComputers; displays: DisplayManager } {
  let computers: ConversationComputers | null = null
  const displays = new DisplayManager(
    productionDisplayDeps(
      app.getPath('home'),
      (key) => {
        const name = computers?.titleOfKey(key)
        // A computer has its conversation's name on the neutral tint (null): conversations have no colors of their own.
        return name ? { name, tint: null } : null
      },
      undefined,
      'maestrly-desktops'
    )
  )
  computers = new ConversationComputers({
    displays,
    desktop: (target, hooks) => startBotDesktop(target, hooks),
    listWindows: (display) => listDisplayWindows(display),
    conversation: (id) => {
      const conversation = getConversation(id)
      return conversation ? { title: conversation.name || null, cwd: conversation.cwd || null } : null
    },
    placeBrowser: deps.placeBrowser,
    // Read when needed: the host takes the language of the computer that connected last.
    get untitled() {
      return tMain('main')('remoteComputer.untitled')
    },
    now: Date.now,
    setInterval,
    clearInterval,
    log,
  })
  return { computers, displays }
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
  let started: ReturnType<typeof startComputers> | null = null
  try {
    await runtime.start()
    // Phones choose a chat's model from what the host's accounts offer, listed as for bots.
    setHostModelOptions(async () => (await runtime.selections()).options)
    // What the chats need from the owner goes to the gateway, which notifies the owner's phones.
    const stopAttention = watchChatAttention({
      permissions: getChatPermissionBroker(),
      questions: getChatQuestionBroker(),
      watchStatuses: deps.watchStatuses,
      conversation: (id) => getConversation(id),
      hasPendingPlan: (id) => getPendingPlan(id) !== null,
      publish: (event) => runtime.events.publish({ type: 'chat.attention', botId: null, ...event }),
    })
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
    started = computersAvailable() ? startComputers(deps) : null
    if (!started) log('This host gives its conversations no computers: it lacks an X display or the display programs.')
    setServerComputers(started?.computers ?? null)
    const host = new HostEnvironment(
      runtime,
      deps.busy,
      started && {
        computers: started.computers,
        conversationExists: (id) => getConversation(id) !== undefined,
      }
    )
    const server = createInstanceControlServer(config, host, {
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
      stopAttention()
      deps.hub.closeAll()
      editor.closeAll()
      server.close()
      setServerComputers(null)
      await started?.computers.dispose()
      await started?.displays.dispose()
      await runtime.dispose()
    })
  } catch (error) {
    setServerComputers(null)
    await started?.computers.dispose()
    await started?.displays.dispose()
    await runtime.dispose()
    throw error
  }
  return true
}
