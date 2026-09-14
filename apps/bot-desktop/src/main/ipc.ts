import { ipcMain, type BrowserWindow } from 'electron'
import { validSender } from './validation'
/**
 * Electron IPC only carries the error message across the bridge. Structured Host codes are
 * preserved as a `[CODE] message` prefix so the renderer can react (REVISION_CONFLICT, BOT_BUSY…)
 * without parsing free text.
 */
export function ipcError(error: unknown): Error {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) && !message.startsWith(`[${code}]`)) return new Error(`[${code}] ${message}`)
  return error instanceof Error ? error : new Error(message)
}
export function registerIpc(
  win: BrowserWindow,
  expectedUrl: string,
  handlers: Record<string, (arg: unknown) => unknown>
) {
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`bot:${name}`, async (event, arg) => {
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
      try {
        return await handler(arg)
      } catch (error) {
        throw ipcError(error)
      }
    })
}
