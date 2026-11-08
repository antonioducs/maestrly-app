import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, screen } from 'electron'
import { resolvePreload } from '../resolve-preload'
import { settleLoad } from '../web-contents-load'
import { registerPanelTarget } from '../window-ipc'
import { ensureAssistantConversation } from './assistant-conversation'
import { getAssistantSettings, getAssistantWindowBounds, setAssistantWindowBounds } from './assistant-settings'
import { type AssistantBrowserWindow, AssistantWindow } from './assistant-window'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function load(win: AssistantBrowserWindow): Promise<void> {
  const browser = win as unknown as BrowserWindow
  const wc = browser.webContents
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[assistant] ${message} (${sourceId}:${line})`)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    await settleLoad('assistant-window', browser.loadURL(`${process.env.ELECTRON_RENDERER_URL}/assistant.html`))
  } else {
    await settleLoad('assistant-window', browser.loadFile(path.join(__dirname, '../renderer/assistant.html')))
  }
}

/** The assistant window of this computer, built on Electron. */
export function createDesktopAssistantWindow(): AssistantWindow {
  return new AssistantWindow({
    create: (options) => new BrowserWindow(options) as unknown as AssistantBrowserWindow,
    load,
    settings: getAssistantSettings,
    conversationId: async () => (await ensureAssistantConversation()).id,
    registerTarget: registerPanelTarget,
    cursorWorkArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    savedBounds: getAssistantWindowBounds,
    saveBounds: setAssistantWindowBounds,
    platform: process.platform,
    preload: resolvePreload(),
  })
}
