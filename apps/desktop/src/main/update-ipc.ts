import type { IpcRegistrar } from './ipc-registrar'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  openRelease,
  skipVersion,
} from './update-service'

/**
 * Update domain IPC. Reading the state is a plain read channel; everything that starts network work,
 * writes the skipped version or quits the app is a guarded mutation.
 */
export function registerUpdateIpc(reg: IpcRegistrar): void {
  reg.handle('update:state', () => getUpdateState())
  reg.mhandle('update:check', (_event, options: unknown) => {
    const ignoreSkip =
      typeof options === 'object' && options !== null && (options as { ignoreSkip?: unknown }).ignoreSkip === true
    return checkForUpdates({ ignoreSkip })
  })
  reg.mhandle('update:download', () => downloadUpdate())
  reg.mhandle('update:install', () => installUpdate())
  reg.mhandle('update:skip', () => skipVersion())
  reg.mhandle('update:open-release', () => openRelease())
}
