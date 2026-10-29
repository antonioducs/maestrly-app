import { ipcRenderer } from 'electron'
import type { RunnerConfig, RunnerConfigPatch, RunnerScopeInput, RunnerStatus } from '../shared/runner'

export type * from '../shared/runner'

function subscribe(channel: string, cb: () => void): () => void {
  const listener = (): void => cb()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** This computer as a runner of bots' jobs (Settings → Runner): never routed to another host. */
export const runnerApi = {
  runnerSettings: (): Promise<RunnerConfig> => ipcRenderer.invoke('runner:settings:get'),
  /** Saves the settings the change names and applies them; resolves with all of them. */
  runnerSetSettings: (patch: RunnerConfigPatch): Promise<RunnerConfig> =>
    ipcRenderer.invoke('runner:settings:set', patch),
  /** The settings, what this computer is, Docker's state for Container, storage usage and the jobs it holds. */
  runnerStatus: (options?: { recheckDocker?: boolean }): Promise<RunnerStatus> =>
    ipcRenderer.invoke('runner:status', options),
  /** Deletes the named caches of one bot, or of every bot. */
  runnerClearCaches: (scope?: RunnerScopeInput): Promise<void> => ipcRenderer.invoke('runner:clearCaches', scope),
  runnerCancelJob: (serverId: string, jobId: string): Promise<void> =>
    ipcRenderer.invoke('runner:cancelJob', { serverId, jobId }),
  /** Asks for the folder the runner keeps its files in; null when none was chosen. */
  runnerChooseStorageDir: (): Promise<string | null> => ipcRenderer.invoke('runner:chooseStorageDir'),
  onRunnerChanged: (cb: () => void): (() => void) => subscribe('runner:changed', cb),
}
