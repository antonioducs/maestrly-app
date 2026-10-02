import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createBrowserTab } from '../../../drawer-manager'
import { tMain } from '../../../i18n'
import { onPtyExit, onPtyOutput, ptyExists, readPtyOutputSnapshot, resizePty } from '../../../pty-manager'
import { getConversation } from '../../../store'
import { createShellTerminal, isShellOfConv, listShellTerminals, writeShellTerminal } from '../../../terminal-manager'
import type { BotDesktopHandle, BotDesktopTarget } from '../environment'
import { BotDesktopService, type DesktopTerminals, type PresenterLink } from './desktop-service'
import { TerminalViewers, xdotoolActivate, type TerminalViewerProcess } from './terminal-viewers'

/** What a bot's desktop needs from the rest of the main process. */
export interface BotDesktopHooks {
  /** Shows the bot's browser window on its desktop; rejects with a message for the owner when it cannot. */
  presentBrowser?(target: BotDesktopTarget): Promise<void>
  /** Takes over the connection of the bot's browser presenter. */
  attachPresenter?(target: BotDesktopTarget, link: PresenterLink): void
}

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
  const viewers = new TerminalViewers({
    env,
    spawn: (command, args, options) => spawnOnDisplay(command, args, options.env),
    activate: xdotoolActivate(env),
    log,
  })
  const service = new BotDesktopService({
    socketPath: env.MAESTRLY_DESKTOP_SOCKET,
    conversationId: target.conversationId,
    conversationCwd: (conversationId) => getConversation(conversationId)?.cwd ?? null,
    terminals: desktopTerminals(),
    viewers,
    openFiles: async () => {
      spawnOnDisplay('pcmanfm', [os.homedir()], env)
    },
    openUrl: async (conversationId, url) => {
      createBrowserTab(conversationId, url)
    },
    presentBrowser: async () => {
      if (!hooks.presentBrowser) throw new Error(t('botDesktop.presenterUnavailable'))
      await hooks.presentBrowser(target)
    },
    ...(hooks.attachPresenter
      ? { attachPresenter: (link: PresenterLink) => hooks.attachPresenter?.(target, link) }
      : {}),
    messages: {
      presenterUnavailable: t('botDesktop.presenterUnavailable'),
      noConversation: t('botDesktop.noConversation'),
      invalidUrl: t('botDesktop.invalidUrl'),
      terminalFailed: t('botDesktop.terminalFailed'),
      exit: (code) => (code === 0 ? t('botDesktop.exitOk') : t('botDesktop.exitFailed', { code })),
    },
    log: (message) => log(`${target.botId}: ${message}`),
  })
  try {
    await service.start()
  } catch (error) {
    viewers.dispose()
    throw error
  }
  log(`Desktop of bot ${target.botId} listens on ${path.basename(env.MAESTRLY_DESKTOP_SOCKET)}`)
  return {
    dispose: async () => {
      viewers.dispose()
      await service.dispose()
    },
  }
}
