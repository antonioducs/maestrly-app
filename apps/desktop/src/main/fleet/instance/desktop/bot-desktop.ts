import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createBrowserTab, onBrowserStateChange } from '../../../drawer-manager'
import { tMain } from '../../../i18n'
import { onPtyExit, onPtyOutput, ptyExists, readPtyOutputSnapshot, resizePty } from '../../../pty-manager'
import { getConversation } from '../../../store'
import { createShellTerminal, isShellOfConv, listShellTerminals, writeShellTerminal } from '../../../terminal-manager'
import type { BotDesktopHandle, BotDesktopTarget } from '../environment'
import { BrowserPresenter } from './browser-presenter'
import { PresentationGate } from './presentation'
import { BotDesktopService, type DesktopTerminals } from './desktop-service'
import { electronPresenterDeps, loadPresenterIcon } from './presenter-surfaces'
import { TerminalViewers, xdotoolActivate, xdotoolRaise, type TerminalViewerProcess } from './terminal-viewers'

/** What a bot's desktop needs from the rest of the main process. */
export interface BotDesktopHooks {
  /** Opens the bot conversation's browser window on the environment display, with its first tab when it has none. */
  floatBrowser?(conversationId: string): void
}
/** How long showing the browser waits for its presenter to connect, for example right after the display started. */
const PRESENTER_WAIT_MS = 5_000

function log(message: string): void {
  console.error(JSON.stringify({ component: 'bot-desktop', level: 'info', message }))
}

/** Starts a program on the bot's display in the background; its window outlives nothing but that display. */
function spawnOnDisplay(command: string, args: string[], env: Record<string, string>): TerminalViewerProcess {
  let child: ChildProcess
  try {
    child = spawnProcess(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' })
  } catch (error) {
    log(`${command} could not start: ${error instanceof Error ? error.message : String(error)}`)
    return { pid: undefined, exited: Promise.resolve(127), kill: () => {} }
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      log(`${command} could not start: ${error.message}`)
      resolve(127)
    })
    child.once('exit', (code) => resolve(code))
  })
  return {
    pid: child.pid,
    exited,
    kill: (signal = 'SIGTERM') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    },
  }
}

/** The bot's terminals, as its desktop sees them: the live shells of its conversation. */
function desktopTerminals(): DesktopTerminals {
  return {
    list: (conversationId) => listShellTerminals(conversationId).map(({ id }) => ({ id })),
    create: (conversationId, cwd) => createShellTerminal(conversationId, cwd),
    belongsTo: (conversationId, id) => isShellOfConv(conversationId, id),
    exists: (id) => ptyExists(id),
    snapshot: (id) => readPtyOutputSnapshot(id),
    write: (id, data) => writeShellTerminal(id, data),
    resize: (id, cols, rows) => resizePty(id, cols, rows),
    onOutput: (id, listener) => onPtyOutput(id, listener),
    onExit: (id, listener) => onPtyExit(id, listener),
    title: (id) => tMain('main')('botDesktop.terminalTitle', { number: /:(\d+)$/.exec(id)?.[1] ?? '' }),
  }
}

/**
 * Starts a bot's desktop services on its apps display: the socket its dock launchers, links and terminal windows use,
 * the terminal windows themselves, and the files window. The returned handle stops them all.
 */
export async function startBotDesktop(
  target: BotDesktopTarget,
  hooks: BotDesktopHooks = {}
): Promise<BotDesktopHandle> {
  const env: Record<string, string> = { ...target.display.env }
  const t = tMain('main')
  const folder = path.dirname(env.MAESTRLY_DESKTOP_SOCKET)
  const surfaces = electronPresenterDeps({
    conversationId: target.conversationId,
    area: target.display.browserArea,
    folder,
    icon: await loadPresenterIcon(path.dirname(folder)),
    log: (message) => log(`${target.botId}: ${message}`),
  })
  const presenter = new BrowserPresenter(surfaces)
  const stopWatchingBrowser = onBrowserStateChange((conversationId) => {
    if (conversationId !== target.conversationId()) return
    presenter.refreshTitle()
    surfaces.applyFocusEmulation()
  })
  /** Shows the bot's Maestrly browser on its desktop, opening its window first when it has none. */
  const showBrowser = async (activate: boolean): Promise<void> => {
    const conversationId = target.conversationId()
    if (!conversationId) throw new Error(t('botDesktop.noConversation'))
    hooks.floatBrowser?.(conversationId)
    presenter.refreshSize()
    if (!(await presenter.whenConnected(PRESENTER_WAIT_MS))) throw new Error(t('botDesktop.presenterUnavailable'))
    presenter.refreshSize()
    presenter.refreshTitle()
    presenter.present({ activate })
  }
  const terminals = desktopTerminals()
  /** Keeps a busy bot's windows from flickering, and its tools from taking the screen during a takeover. */
  const gate = new PresentationGate()
  const viewers = new TerminalViewers({
    env,
    spawn: (command, args, options) => spawnOnDisplay(command, args, options.env),
    activate: xdotoolActivate(env),
    raise: xdotoolRaise(env),
    log,
  })
  const service = new BotDesktopService({
    socketPath: env.MAESTRLY_DESKTOP_SOCKET,
    conversationId: target.conversationId,
    conversationCwd: (conversationId) => getConversation(conversationId)?.cwd ?? null,
    terminals,
    viewers,
    openFiles: async () => {
      spawnOnDisplay('pcmanfm', [os.homedir()], env)
    },
    // The link opener is also the $BROWSER of the bot's own programs: the window comes forward without the keyboard.
    openUrl: async (conversationId, url) => {
      createBrowserTab(conversationId, url)
      // The link is open either way; without a presenter it shows in the bot's browser area.
      await showBrowser(false).catch((error: unknown) =>
        log(
          `${target.botId}: the browser could not be shown: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    },
    presentBrowser: () => showBrowser(true),
    attachPresenter: (link) => {
      void presenter.attach(link)
    },
    messages: {
      presenterUnavailable: t('botDesktop.presenterUnavailable'),
      noConversation: t('botDesktop.noConversation'),
      invalidUrl: t('botDesktop.invalidUrl'),
      terminalFailed: t('botDesktop.terminalFailed'),
      exit: (code) => (code === 0 ? t('botDesktop.exitOk') : t('botDesktop.exitFailed', { code })),
    },
    log: (message) => log(`${target.botId}: ${message}`),
  })
  const stopAll = () => {
    stopWatchingBrowser()
    presenter.dispose()
    viewers.dispose()
  }
  try {
    await service.start()
  } catch (error) {
    stopAll()
    throw error
  }
  log(`Desktop of bot ${target.botId} listens on ${path.basename(env.MAESTRLY_DESKTOP_SOCKET)}`)
  return {
    present: (request) => {
      if (!gate.allow(request, target.hold())) return
      if (request.app === 'browser') {
        void showBrowser(false).catch((error: unknown) =>
          log(
            `${target.botId}: the browser could not be shown: ${error instanceof Error ? error.message : String(error)}`
          )
        )
        return
      }
      const conversationId = target.conversationId()
      if (!conversationId) return
      const id = request.terminalId ?? listShellTerminals(conversationId).at(-1)?.id
      if (!id || !isShellOfConv(conversationId, id) || !ptyExists(id)) return
      void viewers
        .show(id, terminals.title(id), { activate: false })
        .catch((error: unknown) =>
          log(
            `${target.botId}: the terminal could not be shown: ${error instanceof Error ? error.message : String(error)}`
          )
        )
    },
    dispose: async () => {
      stopAll()
      await service.dispose()
    },
  }
}
