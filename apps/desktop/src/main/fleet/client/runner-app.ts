import { createHash } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import type { RunnerDockerView } from '../../../shared/runner'
import { holdAwake } from '../../power-manager'
import { ContainerExecutor, defaultRunnerImage, probeContainerSupport } from '../../runner/container-executor'
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

/** The Docker CLI as the installer finds it, looked up on each use: Docker may be installed while the app runs. */
const dockerCli = (): string | null => new LocalRunner().dockerPath

/**
 * The runner host of this app: its settings in the app database, its files in the app's data folder, and Docker jobs
 * through the CLI the bot server installer finds. Each job's container limits are the host's settings, and its
 * containers carry a key of this app's data folder, so another Maestrly app of the computer never removes them.
 */
export function createAppRunnerHost(overrides: Partial<RunnerHostOptions> = {}): RunnerHost {
  const owner = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  const container = new ContainerExecutor({
    docker: dockerCli,
    limits: () => host.containerLimits(),
    defaultImage: () => defaultRunnerImage(app.getVersion(), { isPackaged: app.isPackaged }),
    owner: () => owner,
  })
  const host: RunnerHost = new RunnerHost({
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
    container: () => container,
    containerSupport: () => probeContainerSupport({ docker: dockerCli() }),
    containerCleanup: container,
    ...overrides,
  })
  return host
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
