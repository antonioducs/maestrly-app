import { appHostApi, makeAppHostApi } from './api-app'
import { botApi, makeBotApi } from './api-bot'
import { chatApi, makeChatApi } from './api-chat'
import { conversationMigrationApi, makeConversationMigrationApi } from './api-conversation-migration'
import { drawerHostApi, makeDrawerHostApi } from './api-drawer'
import { hostFsApi, makeHostFsApi } from './api-host-fs'
import { localDataApi, makeLocalDataApi } from './api-local-data'
import { makeMemoryApi, memoryApi } from './api-memory'
import { makeNotesApi, notesApi } from './api-notes'
import { makePlanApi, planApi } from './api-plan'
import { makeProjectSetupApi, projectSetupApi } from './api-project-setup'
import { makePtyApi, ptyApi } from './api-pty'
import { makeReviewApi, reviewApi } from './api-review'
import { makeRuntimeAssetsApi, runtimeAssetsApi } from './api-runtime-assets'
import { makeSettingsHostApi, settingsHostApi } from './api-settings'
import { makeWorkspaceApi, workspaceApi } from './api-workspace'
import type { IpcTransport } from './ipc-transport'

/** The backend of one Maestrly profile, over a transport; this computer's profile uses Electron's `ipcRenderer`. */
export function makeHostApi(ipcRenderer: IpcTransport) {
  return {
    ...makePtyApi(ipcRenderer),
    ...makeWorkspaceApi(ipcRenderer),
    ...makeConversationMigrationApi(ipcRenderer),
    ...makeProjectSetupApi(ipcRenderer),
    ...makeMemoryApi(ipcRenderer),
    ...makeNotesApi(ipcRenderer),
    ...makeDrawerHostApi(ipcRenderer),
    ...makePlanApi(ipcRenderer),
    ...makeAppHostApi(ipcRenderer),
    ...makeLocalDataApi(ipcRenderer),
    ...makeReviewApi(ipcRenderer),
    ...makeSettingsHostApi(ipcRenderer),
    ...makeRuntimeAssetsApi(ipcRenderer),
    ...makeChatApi(ipcRenderer),
    ...makeBotApi(ipcRenderer),
    ...makeHostFsApi(ipcRenderer),
  }
}
export type HostApi = ReturnType<typeof makeHostApi>

/** This computer's host API, composed of the same slice instances `window.api` exposes. */
export const localHostApi: HostApi = {
  ...ptyApi,
  ...workspaceApi,
  ...conversationMigrationApi,
  ...projectSetupApi,
  ...memoryApi,
  ...notesApi,
  ...drawerHostApi,
  ...planApi,
  ...appHostApi,
  ...localDataApi,
  ...reviewApi,
  ...settingsHostApi,
  ...runtimeAssetsApi,
  ...chatApi,
  ...botApi,
  ...hostFsApi,
}
