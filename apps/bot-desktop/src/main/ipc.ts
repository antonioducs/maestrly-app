import { ipcMain, type BrowserWindow } from 'electron'
import { validSender } from './validation'
export function registerIpc(
  win: BrowserWindow,
  expectedUrl: string,
  handlers: Record<string, (arg: unknown) => unknown>
) {
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`bot:${name}`, (event, arg) => {
      if (
        !validSender(
          win.webContents.id,
          event.sender.id,
          event.senderFrame?.url ?? '',
          expectedUrl,
          event.senderFrame === win.webContents.mainFrame
        )
      )
        throw new Error('Untrusted IPC sender')
      return handler(arg)
    })
}
