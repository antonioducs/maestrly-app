import { app, BrowserWindow, dialog } from 'electron'
import type { RunnerDockerView } from '../../../shared/runner'
import { holdAwake } from '../../power-manager'
import { getAppFlag, getAppSetting, setAppFlag, setAppSetting } from '../../store'
import { broadcast } from '../../window-ipc'
import { DockerHost } from '../installer/docker-host'
import { LocalRunner } from '../installer/runner'
import { RunnerHost, type RunnerHostOptions } from './runner-host'
import { type RunnerIpcDeps, registerRunnerIpc } from './runner-ipc'
import type { FleetIpcRegistrar } from './scoped-ipc'
import type { FleetServers } from './servers'
import type { IpcRegistrar } from '../../ipc-registrar'

/** A Docker that does not answer in this time counts as not running. */
const DOCKER_ANSWER_MS = 15_000

/** Docker's state on this computer, as the bot server installer asks it. */
async function dockerState(): Promise<RunnerDockerView> {
  let timer: NodeJS.Timeout | undefined
  try {
    const status = await Promise.race([
      new DockerHost(new LocalRunner(), '').status(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DOCKER_ANSWER_MS)
      }),
    ])
    // Jobs need the engine, not Compose.
    return status
      ? {
          state: status.state === 'no-compose' ? 'ready' : status.state,
          engine: status.engine,
          version: status.version,
        }
      : { state: 'stopped', engine: null, version: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The runner host of this app: its settings in the app database and its files in the app's data folder. The Container
 * executor is passed in `overrides.container` once the app has one; until then Docker jobs fail with
 * `executor_unavailable`. Its per-job limits are the host's own settings (`host.config()`).
 */
export function createAppRunnerHost(overrides: Partial<RunnerHostOptions> = {}): RunnerHost {
  return new RunnerHost({
    // A bot's container runs the bot, not other bots' jobs.
    available: process.env.MAESTRLY_BOT_MODE !== '1',
    settings: {
      getFlag: getAppFlag,
      getSetting: getAppSetting,
      setFlag: setAppFlag,
      setSetting: setAppSetting,
    },
    userDataDir: () => app.getPath('userData'),
    notifyChanged: () => broadcast('runner:changed'),
    notifyAccess: (serverId, botId) => broadcast('fleet:runner-access', { serverId, botId }),
    holdAwake,
    docker: dockerState,
    ...overrides,
  })
}

const appRunnerIpc: RunnerIpcDeps = {
  async chooseFolder(event, defaultPath) {
    const window = BrowserWindow.fromWebContents((event as { sender: Electron.WebContents }).sender)
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      ...(defaultPath ? { defaultPath } : {}),
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
}

/**
 * Makes this app a runner: its settings and screens, and the host every paired server's client hands jobs to.
 * Call it before the servers start. The returned host is started when the app has opened its servers and stopped when
 * the app quits.
 */
export function registerAppRunner(reg: IpcRegistrar, scoped: FleetIpcRegistrar, servers: FleetServers): RunnerHost {
  const host = createAppRunnerHost()
  registerRunnerIpc(reg, scoped, servers, host, appRunnerIpc)
  return host
}
