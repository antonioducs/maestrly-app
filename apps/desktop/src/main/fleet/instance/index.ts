import { app, type BrowserWindow } from 'electron'
import {
  FLEET_PROTOCOL_VERSION,
  FLEET_PROVISIONING_FEATURE,
  type FleetInstanceStatus,
  type FleetUiOpenRequest,
} from '@maestrly/bot-fleet-protocol'
import { broadcast } from '../../window-ipc'
import { createInstanceControlServer, InstanceHttpError, type InstanceControl } from './server'
import { parseBotInstanceConfig } from './config'
import { DisplayManager } from './displays'
import { EnvironmentRuntime, currentEnvironmentRuntime, productionDisplayDeps } from './environment'
import type { BotRuntime } from './runtime'

/** The environment runtime of this process, or null outside bot mode and before it starts. */
export function getEnvironmentRuntime(): EnvironmentRuntime | null {
  return currentEnvironmentRuntime()
}
/** The bot whose conversation this is: every tool, prompt and hook of a conversation resolves its bot here. */
export function botRuntimeForConversation(conversationId: string | undefined): BotRuntime | null {
  return currentEnvironmentRuntime()?.botForConversation(conversationId) ?? null
}
/** Asks the owner for help on behalf of the bot of this conversation. */
export async function requestOwnerHelp(conversationId: string, reason: string): Promise<string> {
  const bot = botRuntimeForConversation(conversationId)
  if (!bot) throw new Error('This conversation does not belong to a bot.')
  return bot.help.requestHelp(reason)
}

/** What bot mode needs from the main process. */
export interface BotInstanceHooks {
  /** Shows a conversation's browser as a pinned floating window (in the bot's area once its screen is registered). */
  floatBrowser(conversationId: string): void
  /** Stops a conversation's turn and closes its windows, terminals and browser views. */
  closeConversation(conversationId: string): Promise<void>
  /** Deletes a conversation with its messages and files. */
  purgeConversation(conversationId: string): Promise<void>
  /** Places the environment screen (the main window) in its tile of the environment display. */
  placeSettingsWindow(): void
}

function idleStatus(environment: EnvironmentRuntime): FleetInstanceStatus {
  const health = environment.health()
  return {
    appVersion: health.appVersion,
    capabilities: [FLEET_PROVISIONING_FEATURE],
    protocol: FLEET_PROTOCOL_VERSION,
    ready: health.ready,
    accounts: { connected: false, providers: [] },
    selection: null,
    ceiling: 'ask',
    profile: null,
    conversationId: null,
    turn: { state: 'idle', startedAt: null, inputId: null },
    hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
    queue: [],
    activity: null,
    pending: [],
    usage: null,
    compaction: null,
    lastEventSeq: environment.events.lastSeq,
  }
}

/**
 * Serves the control API of an instance that predates environments until the environment routes arrive: environment
 * routes go to the environment, bot routes to the bot in the lowest slot, and a profile without slot or token installs
 * or updates that bot. It does not advertise the `environments` capability.
 */
function legacyInstanceControl(environment: EnvironmentRuntime): InstanceControl {
  const first = (): BotRuntime | null => environment.bots()[0] ?? null
  const bot = (): BotRuntime => {
    const found = first()
    if (!found) throw new InstanceHttpError(409, 'CONFLICT', 'No bot is installed in this environment.')
    return found
  }
  return {
    startLogin: (request) => environment.startLogin(request),
    login: (loginId) => environment.login(loginId),
    loginCallback: (loginId, request) => environment.loginCallback(loginId, request),
    submitLoginCode: (loginId, code) => environment.submitLoginCode(loginId, code),
    cancelLogin: (loginId) => environment.cancelLogin(loginId),
    accounts: () => environment.accounts(),
    importAccounts: (request) => environment.importAccounts(request),
    removeSubscription: (kind, slot) => environment.removeSubscription(kind, slot),
    skills: () => environment.skills(),
    installSkill: (request) => environment.installSkill(request),
    removeSkill: (name) => environment.removeSkill(name),
    mcpServers: () => environment.mcpServers(),
    importMcpServers: (request) => environment.importMcpServers(request),
    removeMcpServer: (id) => environment.removeMcpServer(id),
    addApiKeyAccount: (value) => environment.addApiKeyAccount(value),
    removeAccount: (providerId) => environment.removeAccount(providerId),
    open: (target: FleetUiOpenRequest['target']) => environment.open(target),
    health: () => environment.health(),
    memories: async (status) => (first() ? bot().memories(status) : { memories: [] }),
    patchMemory: (id, patch) => bot().patchMemory(id, patch),
    deleteMemory: (id) => bot().deleteMemory(id),
    status: () => first()?.status() ?? idleStatus(environment),
    profile: (value) => environment.installProfile(value),
    selections: () => bot().selections(),
    transcript: (before, limit) => first()?.transcript(before, limit) ?? { items: [], before: null },
    image: (imageId) => bot().image(imageId),
    input: (value) => bot().input(value),
    deleteInput: (id) => bot().deleteInput(id),
    cancel: () => bot().cancel(),
    resolve: (id, value) => bot().resolve(id, value),
    hold: (reason) => bot().hold(reason),
    release: (value) => bot().release(value),
    conversationCall: (value) => bot().conversationCall(value),
  }
}

function log(message: string): void {
  console.error(JSON.stringify({ component: 'bot-instance', level: 'error', message }))
}

/**
 * Starts bot mode: the environment runtime with its bots' apps displays, then its control server. The main window is
 * the environment screen, shown in tile 0 of the environment display.
 */
export async function startBotInstanceMode(
  window: BrowserWindow,
  hooks: BotInstanceHooks
): Promise<EnvironmentRuntime | null> {
  const config = parseBotInstanceConfig()
  if (!config) return null
  const running = currentEnvironmentRuntime()
  if (running) return running
  const home = app.getPath('home')
  let displays: DisplayManager | null = null
  if (process.platform === 'linux') {
    try {
      displays = new DisplayManager(productionDisplayDeps(home))
    } catch (error) {
      log(`Bots run without their own apps displays: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const environment = new EnvironmentRuntime({
    config,
    userData: app.getPath('userData'),
    home,
    displays,
    floatBrowser: hooks.floatBrowser,
    closeConversation: hooks.closeConversation,
    purgeConversation: hooks.purgeConversation,
    openSettings: (target) => {
      hooks.placeSettingsWindow()
      window.show()
      window.focus()
      if (target !== 'main') broadcast('fleet:instance:open-settings', target)
    },
  })
  try {
    await environment.start()
    const server = createInstanceControlServer(config, legacyInstanceControl(environment), environment.events)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.controlPort, config.controlHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
    window.on('closed', async () => {
      server.close()
      await environment.dispose()
    })
  } catch (error) {
    await environment.dispose()
    throw error
  }
  return environment
}
