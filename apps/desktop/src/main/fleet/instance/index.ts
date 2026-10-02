import { app, type BrowserWindow } from 'electron'
import { startBotRuntimes } from '../../runtime-assets/bot-runtimes'
import { broadcast } from '../../window-ipc'
import { holdScreenFocus, setScreenFocusOwner, showWindow } from '../../screen-focus'
import { createInstanceControlServer } from './server'
import { parseBotInstanceConfig } from './config'
import { DisplayManager } from './displays'
import { startBotDesktop } from './desktop/bot-desktop'
import {
  EnvironmentRuntime,
  currentEnvironmentRuntime,
  productionDisplayDeps,
  type BotDesktopTarget,
} from './environment'
import type { BotRuntime } from './runtime'

/** The environment runtime of this process, or null outside bot mode and before it starts. */
export function getEnvironmentRuntime(): EnvironmentRuntime | null {
  return currentEnvironmentRuntime()
}
/** The bot whose conversation this is: every tool, prompt and hook of a conversation resolves its bot here. */
export function botRuntimeForConversation(conversationId: string | undefined): BotRuntime | null {
  return currentEnvironmentRuntime()?.botForConversation(conversationId) ?? null
}
/** Asks the owner for help on behalf of the bot of this conversation. */
export async function requestOwnerHelp(conversationId: string, reason: string): Promise<string> {
  const bot = botRuntimeForConversation(conversationId)
  if (!bot) throw new Error('This conversation does not belong to a bot.')
  return bot.help.requestHelp(reason)
}

/** What bot mode needs from the main process. */
export interface BotInstanceHooks {
  /**
   * Shows a conversation's browser as a pinned floating window (in the bot's area once its screen is registered),
   * without taking the keyboard: the bot's tools drive it through CDP.
   */
  floatBrowser(conversationId: string): void
  /** Stops a conversation's turn and closes its windows, terminals and browser views. */
  closeConversation(conversationId: string): Promise<void>
  /** Deletes a conversation with its messages and files. */
  purgeConversation(conversationId: string): Promise<void>
  /** Places the environment screen (the main window) in its tile of the environment display. */
  placeSettingsWindow(): void
  /** Gives the keyboard to a conversation's browser: its newest popup, otherwise its floating window. */
  focusBrowser(conversationId: string): void
}

function log(message: string): void {
  console.error(JSON.stringify({ component: 'bot-instance', level: 'error', message }))
}

/**
 * Starts bot mode: the environment runtime with its bots' apps displays, then its control server. The main window is
 * the environment screen, shown in tile 0 of the environment display.
 */
export async function startBotInstanceMode(
  window: BrowserWindow,
  hooks: BotInstanceHooks
): Promise<EnvironmentRuntime | null> {
  const config = parseBotInstanceConfig()
  if (!config) return null
  const running = currentEnvironmentRuntime()
  if (running) return running
  const home = app.getPath('home')
  let displays: DisplayManager | null = null
  if (process.platform === 'linux') {
    try {
      displays = new DisplayManager(productionDisplayDeps(home))
    } catch (error) {
      log(`Bots run without their own apps displays: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // The environment screen shares the environment display, and its keyboard focus, with the bots' browsers.
  setScreenFocusOwner(window, { kind: 'environment' })
  const environment = new EnvironmentRuntime({
    config,
    userData: app.getPath('userData'),
    home,
    displays,
    floatBrowser: hooks.floatBrowser,
    // A bot's desktop needs its apps display: outside a container there is none.
    ...(displays ? { desktop: (target: BotDesktopTarget) => startBotDesktop(target) } : {}),
    closeConversation: hooks.closeConversation,
    purgeConversation: hooks.purgeConversation,
    openSettings: (target) => {
      hooks.placeSettingsWindow()
      showWindow(window)
      if (target !== 'main') broadcast('fleet:instance:open-settings', target)
    },
    holdScreenFocus: (owner) =>
      holdScreenFocus(owner, () => {
        if (owner?.kind === 'conversation') hooks.focusBrowser(owner.conversationId)
        else if (owner && !window.isDestroyed() && window.isVisible()) window.focus()
      }),
  })
  let stopRuntimes = () => {}
  try {
    await environment.start()
    stopRuntimes = startBotRuntimes({
      botStatuses: () => environment.botStatuses(),
      onRuntimesChanged: () => environment.runtimesChanged(),
    })
    const server = createInstanceControlServer(config, environment)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.controlPort, config.controlHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
    window.on('closed', async () => {
      stopRuntimes()
      server.close()
      await environment.dispose()
    })
  } catch (error) {
    stopRuntimes()
    await environment.dispose()
    throw error
  }
  return environment
}
