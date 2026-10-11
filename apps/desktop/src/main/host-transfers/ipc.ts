import path from 'node:path'
import { app, type BrowserWindow, dialog, powerMonitor, shell } from 'electron'
import { fleetClientService } from '../fleet/client/service'
import type { IpcRegistrar } from '../ipc-registrar'
import { hostRegistry, onHostsChanged } from '../remote-host/client/ipc'
import { isHeadlessInstance } from '../remote-host/server/config'
import { broadcast } from '../window-ipc'
import { resolveHostFilesEndpoint } from './endpoint'
import { HostTransferEngine } from './engine'

const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid transfer argument')
  return value
}

/** This computer's transfer queue. A host has none: it is what other computers move files to and from. */
export function registerHostTransfersIpc(reg: IpcRegistrar, deps: { getMainWindow: () => BrowserWindow | null }): void {
  if (isHeadlessInstance()) return
  const engine = new HostTransferEngine({
    endpoint: (hostId) => resolveHostFilesEndpoint(hostId, { registry: hostRegistry(), fleet: fleetClientService }),
    downloadsDir: () => app.getPath('downloads'),
    openDir: () => path.join(app.getPath('temp'), 'maestrly-remote-files'),
    openPath: (file) => shell.openPath(file),
    emit: (transfers) => broadcast('transfers:changed', transfers),
  })
  engine.start()
  powerMonitor.on('resume', () => engine.wake())
  onHostsChanged(() => engine.wake())
  app.once('before-quit', () => void engine.stop())

  reg.handle('transfers:list', () => engine.list())
  reg.mhandle('transfers:download', (_event, hostId: unknown, remotePath: unknown) =>
    engine.download(text(hostId), text(remotePath), 'save')
  )
  reg.mhandle('transfers:open', (_event, hostId: unknown, remotePath: unknown) =>
    engine.download(text(hostId), text(remotePath), 'open')
  )
  reg.mhandle('transfers:upload-paths', (_event, hostId: unknown, remoteDirectory: unknown, paths: unknown) =>
    engine.upload(
      text(hostId),
      Array.isArray(paths) ? paths.filter((item): item is string => typeof item === 'string') : [],
      text(remoteDirectory)
    )
  )
  reg.mhandle('transfers:upload-pick', async (_event, hostId: unknown, remoteDirectory: unknown) => {
    const window = deps.getMainWindow()
    if (!window) return { queued: [], skipped: [] }
    const picked = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] })
    return picked.canceled
      ? { queued: [], skipped: [] }
      : engine.upload(text(hostId), picked.filePaths, text(remoteDirectory))
  })
  reg.mhandle('transfers:pause', (_event, id: unknown) => engine.pause(text(id)))
  reg.mhandle('transfers:resume', (_event, id: unknown) => engine.resume(text(id)))
  reg.mhandle('transfers:cancel', (_event, id: unknown) => engine.cancel(text(id)))
  reg.mhandle('transfers:remove', (_event, id: unknown) => engine.remove(text(id)))
  reg.mhandle('transfers:retry', (_event, id: unknown, options: unknown) =>
    engine.retry(text(id), { overwrite: (options as { overwrite?: unknown } | null)?.overwrite === true })
  )
  reg.mhandle('transfers:reveal', (_event, id: unknown) => {
    const file = engine.revealPath(text(id))
    if (file) shell.showItemInFolder(file)
  })
}
