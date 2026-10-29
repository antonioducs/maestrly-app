import { fleetBotIdSchema } from '@maestrly/bot-fleet-protocol'
import { runnerCancelInputSchema, runnerScopeSchema } from '../../../shared/runner'
import type { IpcRegistrar } from '../../ipc-registrar'
import type { RunnerHost } from './runner-host'
import type { FleetIpcRegistrar } from './scoped-ipc'
import type { FleetServers } from './servers'

/** What the settings do that only the app's windows can: pick a folder. */
export interface RunnerIpcDeps {
  /** Asks for a folder with the native picker over the window that asked; null when none was chosen. */
  chooseFolder(event: unknown, defaultPath: string | null): Promise<string | null>
}

/**
 * Serves Settings → Runner (local channels) and the Runners tab of a bot's settings (channels that name their server),
 * and gives each paired server's client the runner host, before the client starts, so that its first stream already
 * asks for jobs when this computer takes them. Only this computer's own person reaches these channels; no bot tool does.
 */
export function registerRunnerIpc(
  reg: IpcRegistrar,
  scoped: FleetIpcRegistrar,
  servers: Pick<FleetServers, 'setupClients'>,
  host: RunnerHost,
  deps: RunnerIpcDeps
): void {
  if (host.available) servers.setupClients((client) => void (client.runnerHost = host.forClient(client)))

  reg.handle('runner:settings:get', () => host.config())
  reg.mhandle('runner:settings:set', (_event, patch: unknown) => host.updateConfig(patch))
  reg.handle('runner:status', (_event, options: unknown) =>
    host.status({ recheckDocker: (options as { recheckDocker?: unknown } | null | undefined)?.recheckDocker === true })
  )
  reg.mhandle('runner:clearCaches', (_event, scope: unknown) =>
    host.clearCaches(scope === undefined || scope === null ? undefined : runnerScopeSchema.parse(scope))
  )
  reg.mhandle('runner:cancelJob', (_event, input: unknown) => {
    const { serverId, jobId } = runnerCancelInputSchema.parse(input)
    return host.cancelJob(serverId, jobId)
  })
  reg.mhandle('runner:chooseStorageDir', (event) => deps.chooseFolder(event, host.config().storageDir))

  scoped.handle('fleet:runnerAccess:get', (client, _event, botId: unknown) =>
    host.access(client, fleetBotIdSchema.parse(botId))
  )
  scoped.mhandle('fleet:runnerAccess:link', (client, _event, botId: unknown, name: unknown) =>
    host.link(client, fleetBotIdSchema.parse(botId), name)
  )
  scoped.mhandle('fleet:runnerAccess:unlink', (client, _event, botId: unknown) =>
    host.unlink(client, fleetBotIdSchema.parse(botId))
  )
  scoped.mhandle('fleet:runnerAccess:removeOther', (client, _event, botId: unknown, runnerId: unknown) =>
    host.removeOther(client, fleetBotIdSchema.parse(botId), runnerId)
  )
}
