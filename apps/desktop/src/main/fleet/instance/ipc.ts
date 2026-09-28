import { BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../../ipc-registrar'
import { isBotMode } from './config'

/**
 * IPC of a bot's own Maestrly. Its settings window must hide, never close: the renderer's window.close() destroys the
 * window without a preventable `close` event, and the bot's control server stops with its window.
 */
export function registerFleetInstanceIpc(reg: IpcRegistrar): void {
  reg.handle('fleet:instance:hide', (event) => {
    if (!isBotMode()) return
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })
}
