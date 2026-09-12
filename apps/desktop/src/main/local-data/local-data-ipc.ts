import { localDataMessages as messages } from './messages'
import { promises as fsp } from 'node:fs'
import { dialog, type BrowserWindow } from 'electron'
import type { ExportResult, LocalDataResetResult, LocalDataSummary } from '../../shared/local-data'
import type { IpcRegistrar } from '../ipc-registrar'
import { listWorkspaces, listAllConversations } from '../store'
import { unwatchMemory } from '../memory-service'
import { unwatchProject } from '../notes/notes-service'
import { buildExportBundle } from './data-export'
import { resetLocalAppData } from './local-data-reset'

export interface LocalDataIpcDeps {
  getMainWindow: () => BrowserWindow | null
  stopAllLiveWork: () => void | Promise<void>
  stopConversationLive: (id: string) => void | Promise<void>
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(errorMessage).join(' ')}`
  }
  return error instanceof Error ? error.message : String(error)
}

export function registerLocalDataIpc(reg: IpcRegistrar, deps: LocalDataIpcDeps): void {
  let resetting = false
  let exporting = false
  reg.mhandle('data:export', async (): Promise<ExportResult> => {
    if (resetting) return { ok: false, error: messages.resetInProgress }
    if (exporting) return { ok: false, error: messages.exportInProgress }
    const window = deps.getMainWindow()
    if (!window) return { ok: false, error: messages.windowUnavailable }
    exporting = true
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const result = await dialog.showSaveDialog(window, {
        title: messages.exportTitle,
        defaultPath: `maestrly-export-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      if (resetting) return { ok: false, error: messages.resetInProgress }
      const bundle = await buildExportBundle()
      await fsp.writeFile(result.filePath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 })
      return { ok: true, path: result.filePath, incomplete: bundle.omissions.length > 0, omissions: bundle.omissions }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      exporting = false
    }
  })

  reg.handle('data:local-summary', (): LocalDataSummary => {
    return {
      workspaces: listWorkspaces().length,
      conversations: listAllConversations().length,
    }
  })

  reg.mhandle('data:reset', async (): Promise<LocalDataResetResult> => {
    if (resetting) return { ok: false, error: messages.resetAlreadyInProgress }
    if (exporting) return { ok: false, error: messages.exportInProgress }
    const window = deps.getMainWindow()
    if (!window) return { ok: false, error: messages.windowUnavailable }
    resetting = true
    try {
      // Renderer input can never substitute for confirmation in the main process.
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        title: messages.resetTitle,
        message: messages.resetMessage,
        detail: messages.resetDetail,
        buttons: [messages.cancel, messages.resetTitle],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) return { ok: false, error: messages.resetCanceled }
      await deps.stopAllLiveWork()
      await resetLocalAppData({
        stopConversation: deps.stopConversationLive,
        stopWorkspace: async (id) => {
          await unwatchProject(id)
          await unwatchMemory(id)
        },
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      resetting = false
    }
  })
}
