import { ipcRenderer } from 'electron'
import type {
  LocalRoutine,
  LocalRoutineRun,
  RoutineDraft,
  RoutineListRunsInput,
  RoutineListRunsResult,
  RoutineOrigin,
  RoutinePlace,
  RoutineProposal,
  RoutineRunDetails,
  RoutineSavedPermission,
  RoutineSettings,
  RoutineToastPayload,
  RoutineUpdatePatch,
} from '../shared/routines'
import type { IpcTransport } from './ipc-transport'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeRoutinesApi(ipcRenderer: IpcTransport) {
  return {
    routinesList: (): Promise<LocalRoutine[]> => ipcRenderer.invoke('routines:list'),
    routinesGet: (id: string): Promise<LocalRoutine | null> => ipcRenderer.invoke('routines:get', id),
    routinesCreate: (draft: RoutineDraft, origin?: RoutineOrigin | null): Promise<LocalRoutine> =>
      ipcRenderer.invoke('routines:create', draft, origin ?? null),
    routinesUpdate: (id: string, patch: RoutineUpdatePatch): Promise<LocalRoutine> =>
      ipcRenderer.invoke('routines:update', id, patch),
    routinesDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('routines:delete', id),
    routinesDuplicate: (id: string): Promise<LocalRoutine> => ipcRenderer.invoke('routines:duplicate', id),
    routinesSetEnabled: (id: string, enabled: boolean): Promise<LocalRoutine> =>
      ipcRenderer.invoke('routines:setEnabled', id, enabled),
    routinesRunNow: (id: string): Promise<LocalRoutineRun | null> => ipcRenderer.invoke('routines:runNow', id),
    routinesStopRun: (runId: string): Promise<void> => ipcRenderer.invoke('routines:stopRun', runId),
    routinesListRuns: (input: RoutineListRunsInput): Promise<RoutineListRunsResult> =>
      ipcRenderer.invoke('routines:listRuns', input),
    routinesRunsInRange: (from: number, to: number): Promise<LocalRoutineRun[]> =>
      ipcRenderer.invoke('routines:runsInRange', { from, to }),
    routinesGetRun: (runId: string): Promise<RoutineRunDetails | null> =>
      ipcRenderer.invoke('routines:getRun', runId),
    routinesPinRun: (runId: string, pinned: boolean): Promise<LocalRoutineRun | null> =>
      ipcRenderer.invoke('routines:pinRun', runId, pinned),
    routinesDeleteRunConversation: (runId: string): Promise<boolean> =>
      ipcRenderer.invoke('routines:deleteRunConversation', runId),
    routinesMarkRunSeen: (runId: string): Promise<LocalRoutineRun | null> =>
      ipcRenderer.invoke('routines:markRunSeen', runId),
    routinesListSavedPermissions: (routineId: string): Promise<RoutineSavedPermission[]> =>
      ipcRenderer.invoke('routines:listSavedPermissions', routineId),
    routinesRemoveSavedPermission: (routineId: string, permissionId: string): Promise<boolean> =>
      ipcRenderer.invoke('routines:removeSavedPermission', routineId, permissionId),
    routinesOpenFolder: (routineId: string): Promise<string> => ipcRenderer.invoke('routines:openFolder', routineId),
    routinesGetProposal: (proposalId: string): Promise<RoutineProposal | null> =>
      ipcRenderer.invoke('routines:getProposal', proposalId),
    routinesCreateFromProposal: (proposalId: string, draft?: RoutineDraft): Promise<LocalRoutine> =>
      ipcRenderer.invoke('routines:createFromProposal', proposalId, draft),
    routinesMarkProposalCreated: (
      proposalId: string,
      routineId: string,
      place?: RoutinePlace | null
    ): Promise<RoutineProposal | null> =>
      ipcRenderer.invoke('routines:markProposalCreated', proposalId, routineId, place ?? null),
    routinesDiscardProposal: (proposalId: string): Promise<RoutineProposal | null> =>
      ipcRenderer.invoke('routines:discardProposal', proposalId),
    routinesRestoreProposal: (proposalId: string): Promise<RoutineProposal | null> =>
      ipcRenderer.invoke('routines:restoreProposal', proposalId),
    routinesGetSettings: (): Promise<RoutineSettings> => ipcRenderer.invoke('routines:getSettings'),
    routinesSetSettings: (patch: Partial<RoutineSettings>): Promise<RoutineSettings> =>
      ipcRenderer.invoke('routines:setSettings', patch),
    onRoutinesChanged: (cb: () => void): (() => void) => {
      const listener = () => cb()
      ipcRenderer.on('routines:changed', listener)
      return () => {
        ipcRenderer.removeListener('routines:changed', listener)
      }
    },
    onRoutinesToast: (cb: (payload: RoutineToastPayload) => void): (() => void) => {
      const listener = (_event: unknown, payload: RoutineToastPayload) => cb(payload)
      ipcRenderer.on('routines:toast', listener)
      return () => {
        ipcRenderer.removeListener('routines:toast', listener)
      }
    },
  }
}

export const routinesApi = makeRoutinesApi(ipcRenderer)
